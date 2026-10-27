/**
 * Pure, dependency-free helpers for dsh-model-usage.
 *
 * The Host half and the unit tests both import this module, so it must not
 * touch Cordis, the filesystem, or the network.
 *
 * @module dsh-model-usage/usage
 */

/** One metered subscription: the route names it answers and where to ask. */
export const METER_FIELDS = ['id', 'label', 'providers', 'baseURL', 'keyRef']

/** Windows the subscription endpoint reports, in display order. */
export const WINDOW_KEYS = ['rolling', 'weekly', 'monthly']

/** A failure with a stable code the Client can translate into one sentence. */
export class UsageFailure extends Error {
  /**
   * @param {string} code - stable machine code (`missing-credential`, `unauthorized`, …).
   * @param {string} message - operator-facing sentence.
   */
  constructor(code, message) {
    super(message)
    this.name = 'UsageFailure'
    this.code = code
  }

  /** @returns {{ code: string, message: string }} wire form. */
  toJSON() {
    return { code: this.code, message: this.message }
  }
}

/**
 * Keep the meters a config actually describes: a row without an id, a base URL,
 * or a credential reference cannot be polled, so it is dropped rather than
 * failing the whole plugin at activation.
 * @param {unknown} raw - the `meters` config value.
 * @returns {Array<{ id: string, label: string, providers: string[], baseURL: string, keyRef: string }>}
 */
export function normalizeMeters(raw) {
  if (!Array.isArray(raw)) return []
  const meters = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const id = text(item.id)
    const baseURL = text(item.baseURL)
    const keyRef = text(item.keyRef)
    if (id === null || baseURL === null || keyRef === null) continue
    const providers = Array.isArray(item.providers)
      ? item.providers.filter(provider => typeof provider === 'string' && provider.trim() !== '').map(provider => provider.trim())
      : []
    meters.push({
      id,
      label: text(item.label) ?? id,
      providers: providers.length > 0 ? providers : [id],
      baseURL,
      keyRef,
    })
  }
  return meters
}

/**
 * Resolve the meter that owns a provider route.
 * @param {readonly { id: string, providers: string[] }[]} meters - normalized meters.
 * @param {string | undefined} provider - the session's current provider route.
 * @returns {{ id: string, providers: string[] } | undefined} the matching meter, or
 * the first meter when the caller names no provider.
 */
export function meterForProvider(meters, provider) {
  if (!Array.isArray(meters) || meters.length === 0) return undefined
  if (typeof provider !== 'string' || provider === '') return meters[0]
  return meters.find(meter => meter.providers.includes(provider))
}

/**
 * Read one reported window, tolerating a missing or malformed entry.
 * @param {unknown} value - the raw window object.
 * @returns {{ percent: number, status: string, resetsAt: string | null } | null}
 * a normalized window, or null when the payload carries no usable percentage.
 */
function readWindow(value) {
  if (value === null || typeof value !== 'object') return null
  const percent = Number(value.percent)
  if (!Number.isFinite(percent)) return null
  const resets = Date.parse(typeof value.resetsAt === 'string' ? value.resetsAt : '')
  return {
    percent: Math.min(100, Math.max(0, percent)),
    status: typeof value.status === 'string' && value.status !== '' ? value.status : 'unknown',
    resetsAt: Number.isFinite(resets) ? new Date(resets).toISOString() : null,
  }
}

/**
 * Validate and normalize the subscription endpoint's body.
 *
 * The endpoint is undocumented, so this is a strict gate: a shape change
 * surfaces as a `payload` failure the Client can show, instead of an
 * undefined percentage in the pill.
 * @param {unknown} payload - parsed JSON body.
 * @returns {Record<'rolling' | 'weekly' | 'monthly', { percent: number, status: string, resetsAt: string | null } | null>}
 * one entry per window, any of which may be null.
 * @throws {UsageFailure} when the body is not a usage document at all.
 */
export function parseUsagePayload(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new UsageFailure('payload', '用量端点返回了无法识别的结构')
  }
  const usage = payload.usage
  if (usage === null || typeof usage !== 'object') {
    throw new UsageFailure('payload', '用量端点返回了无法识别的结构')
  }
  const windows = {}
  let usable = false
  for (const key of WINDOW_KEYS) {
    windows[key] = readWindow(usage[key])
    if (windows[key] !== null) usable = true
  }
  if (!usable) throw new UsageFailure('payload', '用量端点没有返回任何窗口数据')
  return windows
}

/**
 * Trim a config string field.
 * @param {unknown} value - candidate.
 * @returns {string | null} the trimmed non-empty string, else null.
 */
function text(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Build the usage URL for one meter.
 * @param {{ baseURL: string }} meter - normalized meter.
 * @returns {string} `{baseURL}/usage`.
 */
export function usageUrl(meter) {
  return `${meter.baseURL.replace(/\/+$/, '')}/usage`
}
