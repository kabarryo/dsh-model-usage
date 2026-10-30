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
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { compareVersion, describeRelease, meterForProvider, normalizeMeters, parseUsagePayload, usageUrl, UsageFailure } from './usage.js'

export const name = 'dsh-model-usage'

/** `credentials` resolves the row's `keyRef`; `webServer` carries the snapshot route. */
export const inject = ['webServer', 'credentials']

/** Loopback-only snapshot route the Client half polls. */
export const SNAPSHOT_PATH = '/api/dsh-model-usage'

/** Loopback-only release/update route: GET status, POST to pull. */
export const UPDATE_PATH = '/api/dsh-model-usage/update'

const DEFAULT_REPO = 'kabarryo/dsh-model-usage'
const DEFAULT_CHECK_HOURS = 6
const UPDATE_TIMEOUT_MS = 10_000

/** Directory this module was loaded from: the git checkout the updater pulls. */
const ROOT_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Read the installed version without an async hop; a missing or malformed
 * manifest yields 0.0.0 so the updater still reports the remote tag.
 * @param {string} dir - package directory.
 * @returns {string} the version string.
 */
function readVersionSync(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch { return '0.0.0' }
}

const PLUGIN_VERSION = readVersionSync(ROOT_DIR)

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
  repo: z.string().default(DEFAULT_REPO),
  checkIntervalHours: z.number().default(DEFAULT_CHECK_HOURS),
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
 * Release checker plus fast-forward updater for one git checkout.
 *
 * The check is rate-limited by the interval and by a state file, so a restart
 * storm cannot hammer the GitHub API; the update itself is a plain
 * `git pull --ff-only`, never a shell string, so nothing user-supplied reaches
 * the command line.
 * @param {object} options - updater options.
 * @param {string} options.rootDir - the checkout that serves this plugin.
 * @param {string} options.version - installed version at load time.
 * @param {string} options.repo - `owner/name` queried for the latest release.
 * @param {number} options.intervalMs - minimum gap between network checks.
 * @param {string} options.stateFile - JSON file holding the last check.
 * @param {(message: string, error?: unknown) => void} options.log - diagnostics sink.
 * @returns {{ status: () => object, check: (force?: boolean) => Promise<object>, applyUpdate: () => Promise<object> }} the updater face.
 */
function createUpdater({ rootDir, version, repo, intervalMs, stateFile, log }) {
  let state = { checkedAt: 0, latest: null, url: null, notes: null, publishedAt: null, error: null }
  let hydrated = null
  let running = null
  let checking = null

  /** Load the persisted check once. */
  const hydrate = async () => {
    if (hydrated !== null) return hydrated
    hydrated = (async () => {
      try {
        const raw = JSON.parse(await readFile(stateFile, 'utf8'))
        if (raw !== null && typeof raw === 'object') state = { ...state, ...raw, error: null }
      } catch { /* first run, or an unreadable state file: start clean */ }
    })()
    return hydrated
  }

  /** Persist the current check; a failure only costs one extra request later. */
  const persist = async () => {
    try {
      await mkdir(dirname(stateFile), { recursive: true })
      await writeFile(stateFile, JSON.stringify(state))
    } catch (error) { log('[dsh-model-usage] update state not saved', error) }
  }

  /** @returns {object} the Client-facing view of the last check. */
  const status = () => ({
    current: version,
    latest: state.latest,
    available: typeof state.latest === 'string' && compareVersion(state.latest, version) > 0,
    url: state.url,
    notes: state.notes,
    publishedAt: state.publishedAt,
    checkedAt: state.checkedAt === 0 ? null : state.checkedAt,
    error: state.error,
    busy: running !== null,
    repo,
  })

  /**
   * Ask GitHub for the latest release when the cache went stale.
   * @param {boolean} [force] - ignore the interval.
   * @returns {Promise<object>} the resulting status.
   */
  async function check(force = false) {
    await hydrate()
    const age = Date.now() - (state.checkedAt === 0 ? 0 : state.checkedAt)
    if (!force && age < intervalMs) return status()
    // Two pollers can reach the stale window together; one request answers both.
    if (checking !== null) return checking
    checking = (async () => {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `dsh-model-usage/${version}` },
        signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
      })
      if (response.status === 404) {
        state = { ...state, checkedAt: Date.now(), latest: null, url: null, notes: null, publishedAt: null, error: null }
      } else if (!response.ok) {
        throw new UsageFailure('github', `GitHub 返回 ${response.status}`)
      } else {
        const release = describeRelease(version, await response.json())
        state = {
          ...state,
          checkedAt: Date.now(),
          error: null,
          latest: release?.latest ?? null,
          url: release?.url ?? null,
          notes: release?.notes ?? null,
          publishedAt: release?.publishedAt ?? null,
        }
      }
    } catch (error) {
      const failure = error instanceof UsageFailure ? error : new UsageFailure('github', '无法访问 GitHub')
      state = { ...state, checkedAt: Date.now(), error: failure.message }
      log('[dsh-model-usage] release check failed', error)
    }
    await persist()
    return status()
    })()
    try { return await checking } finally { checking = null }
  }

  /**
   * Fast-forward the checkout and report what changed.
   * @returns {Promise<{ from: string, to: string, upToDate: boolean, changed: string[], restartRequired: boolean }>} the outcome.
   */
  async function applyUpdate() {
    if (running !== null) throw new UsageFailure('busy', '已有一次更新在进行')
    running = (async () => {
      const git = args => new Promise((resolve, reject) => {
        execFile('git', ['-C', rootDir, ...args], { timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
          if (error !== null) {
            const detail = String(stderr ?? '').trim() || error.message || 'git 执行失败'
            reject(new UsageFailure('git', detail.slice(0, 400)))
            return
          }
          resolve(String(stdout))
        })
      })
      let inside = 'false'
      try { inside = (await git(['rev-parse', '--is-inside-work-tree'])).trim() } catch { inside = 'false' }
      if (inside !== 'true') throw new UsageFailure('not-git', '插件目录不是 git 仓库，无法自动更新；请手动 git pull')

      const before = (await git(['rev-parse', 'HEAD'])).trim()
      const from = readVersionSync(rootDir)
      try {
        await git(['pull', '--ff-only', '--quiet'])
      } catch (error) {
        throw error instanceof UsageFailure ? error : new UsageFailure('pull', 'git pull 失败')
      }
      const after = (await git(['rev-parse', 'HEAD'])).trim()
      if (before === after) return { from, to: from, upToDate: true, changed: [], restartRequired: false }

      const changed = (await git(['diff', '--name-only', before, after]))
        .split('\n').map(line => line.trim()).filter(line => line !== '')
      // Client-only files take effect on a page refresh; anything else is loaded
      // by the Host process and needs a restart.
      const restartRequired = changed.some(file => !(
        file === 'client.js' || file === 'icon.svg' || file === 'README.md' || file.startsWith('locale/')
      ))
      return { from, to: readVersionSync(rootDir), upToDate: false, changed, restartRequired }
    })()
    try { return await running } finally { running = null }
  }

  return { status, check, applyUpdate }
}

/**
 * Activate the Host half: two routes, one event listener.
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
  const updater = createUpdater({
    rootDir: ROOT_DIR,
    version: PLUGIN_VERSION,
    repo: typeof rawConfig.repo === 'string' && rawConfig.repo.trim() !== '' ? rawConfig.repo.trim() : DEFAULT_REPO,
    intervalMs: Math.max(1, Number.isFinite(rawConfig.checkIntervalHours) ? rawConfig.checkIntervalHours : DEFAULT_CHECK_HOURS) * 3_600_000,
    stateFile: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'model-usage', 'update-check.json'),
    log,
  })

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
        // Interval-guarded: the first poll of a stale window starts one check
        // in the background, every later poll returns before the network.
        void updater.check(false)
        sendJson(res, 200, {
          ok: true,
          now: Date.now(),
          active: { id: meter.id, label: meter.label, providers: meter.providers },
          usage: entry.usage,
          fetchedAt: entry.fetchedAt,
          error: entry.error,
          update: updater.status(),
        })
      } catch (error) {
        log('[dsh-model-usage] snapshot failed', error)
        sendJson(res, 500, { ok: false, code: 'internal', message: '用量快照生成失败' })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: UPDATE_PATH,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, code: 'loopback-only', message: '只接受本机请求' })
        return
      }
      const method = req.method ?? 'GET'
      if (method !== 'GET' && method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: '只支持 GET / POST' })
        return
      }
      try {
        if (method === 'POST') {
          const result = await updater.applyUpdate()
          await updater.check(true)
          sendJson(res, 200, { ok: true, ...result, status: updater.status() })
          return
        }
        const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
        sendJson(res, 200, { ok: true, status: await updater.check(query.get('force') === '1') })
      } catch (error) {
        const failure = error instanceof UsageFailure ? error.toJSON() : { code: 'internal', message: '更新失败' }
        log('[dsh-model-usage] update failed', error)
        sendJson(res, 200, { ok: false, error: failure, status: updater.status() })
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
