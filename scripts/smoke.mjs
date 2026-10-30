/**
 * Manual smoke test for the Host half, without a Harness process.
 *
 * Stubs the three Cordis faces `apply()` touches, then drives the loopback
 * route with fake req/res objects against the real usage endpoint. The API key
 * is read from the profile's credential file and never printed.
 *
 *   node scripts/smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { apply, SNAPSHOT_PATH, UPDATE_PATH } from '../index.js'

/**
 * Read one credential the same way the Host's credential seam would.
 * @param {string} ref - environment-style name.
 * @returns {string} the secret value.
 */
function readCredential(ref) {
  const file = join(homedir(), '.dsh', '.credentials.yaml')
  const line = readFileSync(file, 'utf8').split('\n').find(row => row.trimStart().startsWith(`${ref}:`))
  if (line === undefined) throw new Error(`missing credential ${ref}`)
  return line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '')
}

const routes = []
const listeners = []
const ctx = {
  credentials: { resolve: async ref => ({ value: readCredential(ref), source: 'smoke' }) },
  webServer: { register: route => { routes.push(route); return () => {} } },
  effect: setup => setup(),
  on: (name, handler) => { listeners.push({ name, handler }); return () => {} },
}

apply(ctx, {})
if (routes.length !== 2) throw new Error(`expected two routes, got ${routes.length}`)
const route = routes.find(entry => entry.path === SNAPSHOT_PATH)
const updateRoute = routes.find(entry => entry.path === UPDATE_PATH)
if (route === undefined || updateRoute === undefined) throw new Error('missing route')
console.log(`routes: ${route.path}, ${updateRoute.path}`)

/**
 * Invoke the registered handler with fake Node req/res objects.
 * @param {string} query - query string including '?'.
 * @param {{ method?: string, remote?: string }} [options] - request variants.
 * @returns {Promise<{ status: number, body: any }>} captured response.
 */
function call(query, options = {}) {
  return new Promise((resolve) => {
    const req = {
      method: options.method ?? 'GET',
      url: SNAPSHOT_PATH + query,
      socket: { remoteAddress: options.remote ?? '127.0.0.1' },
    }
    const res = {
      status: 0,
      writeHead(status) { this.status = status },
      end(body) { resolve({ status: this.status, body: JSON.parse(body) }) },
    }
    void route.handler(req, res)
  })
}

const first = await call('?provider=opencode-go')
console.log('opencode-go:', first.status, JSON.stringify(first.body))
if (first.status !== 200) throw new Error('unexpected status')
if (first.body.active === null) throw new Error('expected the opencode-go meter to activate')
for (const key of ['rolling', 'weekly', 'monthly']) {
  const window = first.body.usage?.[key]
  if (window === null || window === undefined) throw new Error(`missing ${key} window`)
  if (!Number.isFinite(window.percent)) throw new Error(`${key}.percent is not a number`)
  if (typeof window.resetsAt !== 'string') throw new Error(`${key}.resetsAt is not ISO text`)
}
console.log('cached read ok')

const forced = await call('?provider=opencode-go&force=1')
if (forced.body.fetchedAt <= first.body.fetchedAt) throw new Error('force did not refetch')
console.log('force refresh ok:', new Date(forced.body.fetchedAt).toISOString())

const other = await call('?provider=opencode-go-2')
console.log('opencode-go-2:', other.status, other.body.error?.code ?? 'ok', other.body.active?.id ?? 'no meter')

const unknown = await call('?provider=deepseek')
if (unknown.body.active !== null) throw new Error('unknown provider must not resolve a meter')
console.log('unknown provider -> no meter')

const remote = await call('?provider=opencode-go', { remote: '10.0.0.5' })
if (remote.status !== 403) throw new Error('remote peer must be rejected')
console.log('non-loopback rejected')

const post = await call('?provider=opencode-go', { method: 'POST' })
if (post.status !== 405) throw new Error('POST must be rejected')
console.log('non-GET rejected')

const messageEvent = listeners.find(entry => entry.name === 'session/event')
if (messageEvent === undefined) throw new Error('missing session/event listener')
messageEvent.handler({}, { type: 'assistant/message', data: { message: { source: { provider: 'opencode-go' } } } })
messageEvent.handler({}, { type: 'tool/call', data: {} })
console.log('dirty marking ok')

/**
 * Drive the update route with fake req/res.
 * @param {string} method - HTTP method.
 * @param {string} query - query string including '?'.
 * @returns {Promise<{ status: number, body: any }>} captured response.
 */
function callUpdate(method, query = '') {
  return new Promise((resolve) => {
    const req = { method, url: UPDATE_PATH + query, socket: { remoteAddress: '127.0.0.1' } }
    const res = {
      status: 0,
      writeHead(status) { this.status = status },
      end(body) { resolve({ status: this.status, body: JSON.parse(body) }) },
    }
    void updateRoute.handler(req, res)
  })
}

const status = await callUpdate('GET', '?force=1')
console.log('update status:', status.status, JSON.stringify(status.body.status))
if (status.body.ok !== true) throw new Error('update status failed')
if (typeof status.body.status.current !== 'string') throw new Error('missing current version')
if (status.body.status.available !== false) throw new Error('a published version must not look available from the checkout')
if (typeof status.body.status.repo !== 'string') throw new Error('missing repo')

const pulled = await callUpdate('POST')
console.log('update apply:', pulled.status, JSON.stringify({ ok: pulled.body.ok, upToDate: pulled.body.upToDate, from: pulled.body.from, to: pulled.body.to }))
if (pulled.body.ok !== true) throw new Error(`update apply failed: ${JSON.stringify(pulled.body.error)}`)
if (typeof pulled.body.restartRequired !== 'boolean') throw new Error('missing restartRequired')
