/**
 * Wiring check for the Client half without a browser.
 *
 * Evaluates client.js against a stubbed `window.__ModuleLoader__` and React, then
 * asserts that the factory returns the slot injection and registers exactly one
 * dock entry. It cannot render (hooks need a renderer), but it catches module
 * scope errors, a mis-shaped factory, and a wrong slot id.
 *
 *   node scripts/client-wiring.mjs
 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let registration = null
const window = {
  __ModuleLoader__: {
    load(next) { registration = next },
  },
}

runInNewContext(source, { window, console, document: undefined, setTimeout, clearTimeout })

if (registration === null) throw new Error('client.js never called __ModuleLoader__.load')
if (registration.id !== 'dsh-model-usage') throw new Error(`unexpected module id: ${registration.id}`)

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol.for('react.fragment'),
  Component: class { constructor(props) { this.props = props } },
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: callback => callback,
}

const ReactDom = { createPortal: node => node }

const plugin = registration.factory(specifier => {
  if (specifier === 'react') return React
  if (specifier === 'react-dom') return ReactDom
  throw new Error(`unexpected require: ${specifier}`)
})

if (typeof plugin?.apply !== 'function') throw new Error('factory did not return apply()')
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots')) throw new Error('missing slots injection')

const registered = []
const ctx = {
  slots: {
    inject(slot, run) { run() },
    register(options, component) { registered.push({ options, component }) },
  },
}
plugin.apply(ctx)

if (registered.length !== 1) throw new Error(`expected one registration, got ${registered.length}`)
const [{ options, component }] = registered
if (options.name !== 'conversation.composer.dock') throw new Error(`wrong slot: ${options.name}`)
if (options.id !== 'model-usage') throw new Error(`wrong id: ${options.id}`)
if (typeof component !== 'function') throw new Error('registration has no component')

const tree = component({ useProjection: () => undefined })
if (tree === null || tree === undefined) throw new Error('entry rendered nothing at all')
// The entry is the boundary element; call the pill inside it directly. With no
// snapshot yet the pill must render nothing rather than an empty shell.
const inner = Array.isArray(tree.children) ? tree.children[0] : undefined
if (typeof inner?.type !== 'function') throw new Error('entry does not wrap the pill')
const pill = inner.type(inner.props)
if (pill !== null) throw new Error('a session without a snapshot must render nothing')

console.log('client wiring ok:', JSON.stringify(options))
