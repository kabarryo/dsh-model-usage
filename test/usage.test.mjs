import test from 'node:test'
import assert from 'node:assert/strict'

import {
  meterForProvider,
  normalizeMeters,
  parseUsagePayload,
  usageUrl,
  UsageFailure,
} from '../usage.js'

const LIVE_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 14, resetsAt: '2026-10-27T04:37:33.000Z' },
    weekly: { status: 'ok', percent: 18, resetsAt: '2026-11-02T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 23, resetsAt: '2026-11-22T03:26:20.000Z' },
  },
}

test('parses the live payload into three normalized windows', () => {
  const windows = parseUsagePayload(LIVE_BODY)
  assert.equal(windows.rolling.percent, 14)
  assert.equal(windows.weekly.percent, 18)
  assert.equal(windows.monthly.percent, 23)
  assert.equal(windows.rolling.resetsAt, '2026-10-27T04:37:33.000Z')
  assert.equal(windows.rolling.status, 'ok')
})

test('keeps a partial payload and nulls the missing window', () => {
  const windows = parseUsagePayload({ usage: { rolling: { status: 'ok', percent: 7 } } })
  assert.equal(windows.rolling.percent, 7)
  assert.equal(windows.rolling.resetsAt, null)
  assert.equal(windows.weekly, null)
  assert.equal(windows.monthly, null)
})

test('clamps out-of-range percentages and drops unparseable resets', () => {
  const windows = parseUsagePayload({
    usage: { rolling: { status: 'ok', percent: 140, resetsAt: 'not-a-date' } },
  })
  assert.equal(windows.rolling.percent, 100)
  assert.equal(windows.rolling.resetsAt, null)
})

test('rejects a body that carries no window at all', () => {
  for (const body of [null, {}, { usage: {} }, { usage: { rolling: {} } }, { objects: [] }]) {
    assert.throws(() => parseUsagePayload(body), UsageFailure, JSON.stringify(body))
  }
})

test('a payload shape change surfaces as a code, not a number', () => {
  try {
    parseUsagePayload({ usage: { rolling: { used: 3 } } })
    assert.fail('expected a throw')
  } catch (error) {
    assert.equal(error.code, 'payload')
    assert.equal(typeof error.toJSON().message, 'string')
  }
})

test('normalizes meters and drops rows that cannot be polled', () => {
  const meters = normalizeMeters([
    { id: 'opencode-go', providers: ['opencode-go'], baseURL: 'https://opencode.ai/zen/go/v1/', keyRef: 'A' },
    { id: 'no-key', baseURL: 'https://x' },
    { id: 'no-base', keyRef: 'B' },
    null,
    { id: 'defaults', baseURL: 'https://y', keyRef: 'C' },
  ])
  assert.equal(meters.length, 2)
  assert.deepEqual(meters[0].providers, ['opencode-go'])
  assert.equal(meters[0].label, 'opencode-go')
  // A row without providers answers to its own id.
  assert.deepEqual(meters[1].providers, ['defaults'])
})

test('non-array meters config yields nothing rather than throwing', () => {
  assert.deepEqual(normalizeMeters(undefined), [])
  assert.deepEqual(normalizeMeters({ id: 'x' }), [])
})

test('routes a provider to its meter, and an unknown route to no meter', () => {
  const meters = normalizeMeters([
    { id: 'go', providers: ['opencode-go'], baseURL: 'https://a', keyRef: 'A' },
    { id: 'go2', providers: ['opencode-go-2'], baseURL: 'https://b', keyRef: 'B' },
  ])
  assert.equal(meterForProvider(meters, 'opencode-go-2').id, 'go2')
  assert.equal(meterForProvider(meters, 'opencode-go').id, 'go')
  assert.equal(meterForProvider(meters, 'deepseek'), undefined)
  // No session selection yet: fall back to the first configured meter.
  assert.equal(meterForProvider(meters, undefined).id, 'go')
})

test('builds the usage URL without doubling the slash', () => {
  assert.equal(usageUrl({ baseURL: 'https://opencode.ai/zen/go/v1/' }), 'https://opencode.ai/zen/go/v1/usage')
  assert.equal(usageUrl({ baseURL: 'https://opencode.ai/zen/go/v1' }), 'https://opencode.ai/zen/go/v1/usage')
})
