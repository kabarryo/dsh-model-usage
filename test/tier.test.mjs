/**
 * Band thresholds for the usage bar.
 *
 * The Client half lives inside `window.__ModuleLoader__.factory`, so its pure
 * helpers are not importable. This test lifts those function bodies out of the
 * source and evaluates them, which is enough to pin the thresholds: a silent
 * edit to a number here is what would otherwise ship unnoticed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * Extract one top-level function declaration body from client.js.
 * @param {string} name - function name.
 * @returns {string} the declaration text.
 */
function grab(name) {
  const start = source.indexOf(`    function ${name}(`)
  assert.notEqual(start, -1, `client.js has no function ${name}`)
  const end = source.indexOf('\n    }\n', start)
  assert.notEqual(end, -1, `function ${name} has no closing brace`)
  return source.slice(start, end + 7)
}

const helpers = new Function(`${grab('tierOf')}\n${grab('toneClass')}\n${grab('fillClass')}\n${grab('isExhausted')}\nreturn { tierOf, toneClass, fillClass, isExhausted }`)()

test('five bands: green / yellow / orange / red / spent', () => {
  const cases = [
    [0, 'ok'], [26, 'ok'], [69, 'ok'],
    [70, 'warm'], [79, 'warm'],
    [80, 'hot'], [89, 'hot'],
    [90, 'danger'], [99, 'danger'], [100, 'danger'],
  ]
  for (const [percent, tier] of cases) {
    assert.equal(helpers.tierOf(percent), tier, `${percent}% should be ${tier}`)
  }
})

test('an unknown percentage carries no band', () => {
  assert.equal(helpers.tierOf(Number.NaN), '')
})

test('green stays neutral in text, the loud bands colour the number', () => {
  assert.equal(helpers.toneClass('ok'), '')
  assert.equal(helpers.toneClass(''), '')
  assert.equal(helpers.toneClass('warm'), 'mu-t-warm')
  assert.equal(helpers.toneClass('hot'), 'mu-t-hot')
  assert.equal(helpers.toneClass('danger'), 'mu-t-danger')
})

test('the bar always gets a fill class', () => {
  assert.equal(helpers.fillClass('ok'), 'mu-fill mu-t-ok')
  assert.equal(helpers.fillClass('danger'), 'mu-fill mu-t-danger')
})

test('a window is spent at the cap or on a non-ok status', () => {
  assert.equal(helpers.isExhausted(null), false)
  assert.equal(helpers.isExhausted(undefined), false)
  assert.equal(helpers.isExhausted({ percent: 99, status: 'ok' }), false)
  assert.equal(helpers.isExhausted({ percent: 100, status: 'ok' }), true)
  assert.equal(helpers.isExhausted({ percent: 42, status: 'limited' }), true)
  assert.equal(helpers.isExhausted({ percent: 42, status: 'blocked' }), true)
  // An absent status parses as 'unknown': not evidence of a spent window.
  assert.equal(helpers.isExhausted({ percent: 42, status: 'unknown' }), false)
})
