/**
 * dsh-model-usage — Host half.
 *
 * Shows a subscription's remaining allowance in the composer dock. The numbers
 * come from the provider's own usage endpoint (opencode Go:
 * `GET {baseURL}/usage`), authenticated with the same API key the model route
 * uses. The key never leaves this process: the Client half only ever sees the
 * snapshot this plugin serves on a loopback-only route.
 *
 *   GET /api/dsh-model-usage?provider=<route>[&force=1]
 *
 * Design notes:
 *  - Stale-while-revalidate: a cached snapshot is served immediately while a
 *    background refresh runs, so the pill never blocks on the network. Only the
 *    very first read (no cache at all) waits for the request.
 *  - Refresh is driven by three signals: the TTL, a `force` query (manual
 *    refresh), and `assistant/message` (a finished turn usually moved the
 *    number), which marks the meter dirty.
 *  - A route maps to exactly one meter, and one meter owns exactly one key, so
 *    switching to a model served by another route switches credentials too.
 *
 * @module dsh-model-usage
 */
import z from '@deepseek-ai/schemastery'
import { meterForProvider, normalizeMeters, parseUsagePayload, usageUrl, UsageFailure } from './usage.js'

export const name = 'dsh-model-usage'

/** `credentials` resolves the row's `keyRef`; `webServer` carries the snapshot route. */
export const inject = ['webServer', 'credentials']

/** Loopback-only snapshot route the Client half polls. */
export const SNAPSHOT_PATH = '/api/dsh-model-usage'

const DEFAULT_REFRESH_SECONDS = 60
const DEFAULT_TIMEOUT_MS = 8000
const MIN_REFRESH_SECONDS = 15

/** The subscription this plugin is built around; overridable per profile. */
const DEFAULT_METERS = [
  {
    id: 'opencode-go',
    label: 'opencode-go',
    providers: ['opencode-go'],
    baseURL: 'https://opencode.ai/zen/go/v1',
    keyRef: 'OPENCODE_GO_API_KEY',
  },
  {
    id: 'opencode-go-2',
    label: 'opencode-go 备用',
    providers: ['opencode-go-2'],
    baseURL: 'https://opencode.ai/zen/go/v1',
    keyRef: 'OPENCODE_GO_2_API_KEY',
  },
]

const MeterConfig = z.object({
  id: z.string().required(),
  label: z.string(),
  providers: z.array(z.string()),
  baseURL: z.string().required(),
  keyRef: z.string().required(),
})

export const Config = z.object({
  meters: z.array(MeterConfig),
  refreshSeconds: z.number().default(DEFAULT_REFRESH_SECONDS),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
})

/**
 * Serve one JSON body.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - status code.
 * @param {unknown} body - JSON payload.
 * @returns {void}
 */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/**
 * Whether a request reached us over the loopback interface.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {boolean} true for 127.0.0.1 / ::1 peers.
 */
function isLoopback(req) {
  const address = req?.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Build the per-meter cache and its refresh logic.
 * @param {object} options - hub options.
 * @param {readonly object[]} options.meters - normalized meters.
 * @param {{ resolve: (ref: string) => Promise<{ value: string } | undefined> }} options.credentials - credential seam.
 * @param {number} options.refreshMs - cache TTL.
 * @param {number} options.timeoutMs - per-request timeout.
 * @param {(message: string, error?: unknown) => void} options.log - diagnostics sink.
 * @returns {{ read: Function, markDirty: Function, entry: Function }} the hub face.
 */
function createHub({ meters, credentials, refreshMs, timeoutMs, log }) {
  /** @type {Map<string, { usage: object | null, fetchedAt: number | null, error: object | null, failedAt: number | null }>} */
  const entries = new Map()
  /** @type {Map<string, Promise<void>>} */
  const inflight = new Map()
  /** @type {Set<string>} */
  const dirty = new Set()

  /**
   * Enter one record; a failed request keeps the last good numbers.
   * @param {string} id - meter id.
   * @param {object} next - next entry.
   * @returns {void}
   */
  const put = (id, next) => { entries.set(id, next) }

  /**
   * Ask the endpoint for one meter, mapping transport and auth failures onto
   * stable codes the Client can explain.
   * @param {object} meter - normalized meter.
   * @returns {Promise<object>} normalized windows.
   */
  async function load(meter) {
    // Credentials resolve to the environment value the model route uses, so the
    // secret stays inside this process — the browser receives only percentages.
    const credential = await credentials.resolve(meter.keyRef)
    if (credential === undefined || typeof credential.value !== 'string' || credential.value === '') {
      throw new UsageFailure('missing-credential', `未配置 ${meter.keyRef}`)
    }
    let response
    try {
      response = await fetch(usageUrl(meter), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${credential.value}`,
          accept: 'application/json',
          'user-agent': 'dsh-model-usage/0.1',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new UsageFailure('network', error?.name === 'TimeoutError' ? '用量端点请求超时' : '用量端点无法连接')
    }
    if (response.status === 401 || response.status === 403) {
      throw new UsageFailure('unauthorized', `${meter.keyRef} 无效或无权查询用量`)
    }
    if (response.status === 404) throw new UsageFailure('endpoint-missing', '用量端点不存在（可能已下线）')
    if (!response.ok) throw new UsageFailure('http', `用量端点返回 ${response.status}`)
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new UsageFailure('payload', '用量端点返回的不是 JSON')
    }
    return parseUsagePayload(payload)
  }

  /**
   * Start (or join) one refresh.
   * @param {object} meter - normalized meter.
   * @returns {Promise<void>} settles when this refresh finished.
   */
  function refresh(meter) {
    const running = inflight.get(meter.id)
    if (running !== undefined) return running
    const task = load(meter)
      .then((usage) => {
        put(meter.id, { usage, fetchedAt: Date.now(), error: null, failedAt: null })
        dirty.delete(meter.id)
      })
      .catch((error) => {
        const failure = error instanceof UsageFailure ? error : new UsageFailure('unknown', '用量刷新失败')
        const previous = entries.get(meter.id)
        put(meter.id, {
          usage: previous?.usage ?? null,
          fetchedAt: previous?.fetchedAt ?? null,
          error: failure.toJSON(),
          failedAt: Date.now(),
        })
        dirty.delete(meter.id)
        log(`[dsh-model-usage] ${meter.id}: ${failure.code} ${failure.message}`, error)
      })
      .finally(() => { inflight.delete(meter.id) })
    inflight.set(meter.id, task)
    return task
  }

  /**
   * Read one meter, refreshing according to the cache state.
   * @param {object} meter - normalized meter.
   * @param {{ force?: boolean }} [options] - `force` waits for a fresh fetch.
   * @returns {Promise<object>} the current entry.
   */
  async function read(meter, options = {}) {
    const entry = entries.get(meter.id)
    const age = typeof entry?.fetchedAt === 'number' ? Date.now() - entry.fetchedAt : Infinity
    const stale = options.force === true || dirty.has(meter.id) || age >= refreshMs
    if (entry === undefined || entry.usage === null) {
      // Nothing worth showing yet: the first paint has to wait.
      await refresh(meter)
    } else if (stale) {
      if (options.force === true) await refresh(meter)
      else void refresh(meter)
    }
    return entries.get(meter.id) ?? { usage: null, fetchedAt: null, error: null, failedAt: null }
  }

  /**
   * Mark meters whose numbers a finished turn probably changed.
   * @param {string | undefined} provider - the route that just ran.
   * @returns {void}
   */
  function markDirty(provider) {
    for (const meter of meters) {
      if (typeof provider === 'string' && !meter.providers.includes(provider)) continue
      dirty.add(meter.id)
    }
  }

  return {
    read,
    markDirty,
    entry: id => entries.get(id),
  }
}

/**
 * Activate the Host half: one route, one event listener.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ meters?: unknown, refreshSeconds?: number, timeoutMs?: number }} [rawConfig] - validated config.
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const meters = normalizeMeters(Array.isArray(rawConfig.meters) && rawConfig.meters.length > 0 ? rawConfig.meters : DEFAULT_METERS)
  if (meters.length === 0) return

  const refreshSeconds = Math.max(MIN_REFRESH_SECONDS, Number.isFinite(rawConfig.refreshSeconds) ? rawConfig.refreshSeconds : DEFAULT_REFRESH_SECONDS)
  const timeoutMs = Math.max(1000, Number.isFinite(rawConfig.timeoutMs) ? rawConfig.timeoutMs : DEFAULT_TIMEOUT_MS)
  const log = (message, error) => {
    try {
      // eslint-disable-next-line no-console
      console.warn(message, error instanceof Error ? error.message : '')
    } catch { /* diagnostics must never break the plugin */ }
  }

  const hub = createHub({ meters, credentials: ctx.credentials, refreshMs: refreshSeconds * 1000, timeoutMs, log })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SNAPSHOT_PATH,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, code: 'loopback-only', message: '只接受本机请求' })
        return
      }
      if ((req.method ?? 'GET') !== 'GET') {
        sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: '只支持 GET' })
        return
      }
      try {
        const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
        const provider = query.get('provider') ?? undefined
        const meter = meterForProvider(meters, provider)
        if (meter === undefined) {
          // No subscription backs this route: the Client hides its pill.
          sendJson(res, 200, { ok: true, now: Date.now(), active: null })
          return
        }
        const entry = await hub.read(meter, { force: query.get('force') === '1' })
        sendJson(res, 200, {
          ok: true,
          now: Date.now(),
          active: { id: meter.id, label: meter.label, providers: meter.providers },
          usage: entry.usage,
          fetchedAt: entry.fetchedAt,
          error: entry.error,
        })
      } catch (error) {
        log('[dsh-model-usage] snapshot failed', error)
        sendJson(res, 500, { ok: false, code: 'internal', message: '用量快照生成失败' })
      }
    },
  }))

  // A finished turn almost always moved the counter; refresh lazily on the next
  // poll instead of pushing a request for every step.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    hub.markDirty(event.data?.message?.source?.provider)
  })
}
