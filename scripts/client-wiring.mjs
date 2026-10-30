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

const expected = ['conversation.composer.dock', 'plugins.detail.badge', 'plugins.detail.section']
const slots = registered.map(entry => entry.options.name).sort()
if (slots.join(',') !== expected.slice().sort().join(',')) throw new Error(`unexpected slots: ${slots.join(',')}`)
for (const entry of registered) {
  if (typeof entry.component !== 'function') throw new Error(`${entry.options.name} has no component`)
  if (typeof entry.options.id !== 'string') throw new Error(`${entry.options.name} has no id`)
}
const dock = registered.find(entry => entry.options.name === 'conversation.composer.dock')
if (dock.options.id !== 'model-usage') throw new Error(`wrong id: ${dock.options.id}`)
const component = dock.component

const tree = component({ useProjection: () => undefined })
if (tree === null || tree === undefined) throw new Error('entry rendered nothing at all')
// The entry is the boundary element; call the pill inside it directly. With no
// snapshot yet the pill must render nothing rather than an empty shell.
const inner = Array.isArray(tree.children) ? tree.children[0] : undefined
if (typeof inner?.type !== 'function') throw new Error('entry does not wrap the pill')
const pill = inner.type(inner.props)
if (pill !== null) throw new Error('a session without a snapshot must render nothing')

// The plugin-page contributions must ignore somebody else's page.
const foreign = { subject: { kind: 'row', pkg: { name: 'dsh-doc-review' } } }
const badge = registered.find(entry => entry.options.name === 'plugins.detail.badge')
if (badge.component(foreign) !== null) throw new Error('badge rendered for a foreign package')
const section = registered.find(entry => entry.options.name === 'plugins.detail.section')
if (section.component(foreign) !== null) throw new Error('section rendered for a foreign package')

console.log('client wiring ok:', registered.map(entry => `${entry.options.name}#${entry.options.id}`).join(' '))
