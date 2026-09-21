// Shared test cases for the host half. `run.js` executes them with plain
// assertions (works where child-process spawning is restricted); `host.test.js`
// wraps the same cases in node:test for `pnpm test`.
//
// Every case is real behaviour against node:fs in a scratch directory — no
// shell, no platform branch, which is exactly why the bundle form is portable.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  apply,
  deleteSession,
  detachAccounting,
  detachLiveEntry,
  inject,
  removeArtifacts,
  removeProjection,
  ROUTE_PATH,
  sessionsRoot,
} from '../lib/index.js'

const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const SIBLING = 'session-99999999-8888-7777-6666-555555555555'
const LEGACY = 'bb8d7ddb-d30b-4d2c-9dc5-007eb5e4f45d'

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsc-'))
  for (const [project, id] of [
    ['--proj-a--', SESSION],
    ['--proj-b--', SIBLING],
    ['--proj-c--', SESSION],
    ['--proj-d--', LEGACY],
  ]) {
    const dir = join(root, project, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'x')
  }
  return root
}

/** A minimal ctx double: only the services the host half actually touches. */
function makeCtx({ liveIds = [], agentStatus, archived = [], workspaces = [], projection = true } = {}) {
  const store = new Map()
  const detached = []
  const warns = []
  const routes = new Map()
  for (const id of liveIds)
    store.set(id, {
      detach: () => {
        detached.push(id)
        store.delete(id)
      },
    })
  const sessions = {
    store,
    get: (id) => (store.has(id) ? store.get(id) : undefined),
  }
  const agents = { get: (id) => (agentStatus === undefined ? undefined : { id, status: agentStatus }) }
  const registry = {
    archivedSessionIds: [...archived],
    unarchiveSession: async (id) => {
      const at = registry.archivedSessionIds.indexOf(id)
      if (at !== -1) registry.archivedSessionIds.splice(at, 1)
    },
    list: () => workspaces,
  }
  const projectionTable = {
    rows: new Map(projection ? [[SESSION, { v: 1 }]] : []),
    get(id) {
      return this.rows.get(id)
    },
    async delete(id) {
      this.rows.delete(id)
    },
  }
  const ctx = {
    agents,
    sessions,
    workspaceRegistry: registry,
    get: (name) =>
      name === 'storageDomain' ? { get: () => (projection ? { table: () => projectionTable } : undefined) } : undefined,
    logger: { warn: (message) => warns.push(String(message)), debug() {} },
    effect: (fn) => fn(),
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler)
      },
    },
  }
  return { ctx, store, detached, registry, projectionTable, warns, routes }
}

/**
 * One request/response pair for a registered route: `req` iterates its body
 * like an IncomingMessage and `res` records what `sendJson` wrote.
 */
function exchange({ method = 'POST', contentType = 'application/json', body = '' } = {}) {
  const headers = contentType === null ? {} : { 'content-type': contentType }
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')]
  const req = {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  const res = {
    status: 0,
    text: '',
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.text = text
    },
  }
  return { req, res, json: () => JSON.parse(res.text) }
}

export const cases = [
  [
    'sessionsRoot defaults to ~/.dsh/sessions and honours DSH_HOME',
    (assert) => {
      const before = process.env.DSH_HOME
      delete process.env.DSH_HOME
      try {
        assert.ok(sessionsRoot().endsWith(join('.dsh', 'sessions')), sessionsRoot())
        process.env.DSH_HOME = join(tmpdir(), 'elsewhere')
        assert.equal(sessionsRoot(), join(tmpdir(), 'elsewhere', 'sessions'))
        process.env.DSH_HOME = '   '
        assert.ok(sessionsRoot().endsWith(join('.dsh', 'sessions')), 'blank override must be ignored')
      } finally {
        if (before === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = before
      }
    },
  ],

  [
    'sessionsRoot expands a tilde and resolves a relative DSH_HOME like the host',
    (assert) => {
      const before = process.env.DSH_HOME
      try {
        process.env.DSH_HOME = '~/x'
        assert.equal(
          sessionsRoot(),
          join(homedir(), 'x', 'sessions'),
          'a tilde override must expand against the OS home',
        )
        process.env.DSH_HOME = '~'
        assert.equal(sessionsRoot(), join(homedir(), 'sessions'), 'a bare tilde is the OS home')
        process.env.DSH_HOME = join('relative-tree', 'home')
        assert.equal(
          sessionsRoot(),
          join(resolve('relative-tree', 'home'), 'sessions'),
          'a relative override resolves against the working directory, as resolveDshHome does',
        )
      } finally {
        if (before === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = before
      }
    },
  ],

  [
    'removeArtifacts deletes only exact-name directories, in every project',
    async (assert) => {
      const root = makeTree()
      try {
        const result = await removeArtifacts(SESSION, root)
        assert.equal(result.removed.length, 2, JSON.stringify(result.removed))
        assert.equal(result.failed.length, 0)
        assert.equal(existsSync(join(root, '--proj-a--', SESSION)), false)
        assert.equal(existsSync(join(root, '--proj-c--', SESSION)), false)
        assert.equal(existsSync(join(root, '--proj-b--', SIBLING)), true, 'sibling must survive')
        assert.equal(existsSync(join(root, '--proj-d--', LEGACY)), true, 'other id must survive')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  ],

  [
    'removeArtifacts tolerates a missing root and a legacy bare-uuid id',
    async (assert) => {
      const missing = await removeArtifacts(SESSION, join(tmpdir(), 'dsc-does-not-exist'))
      assert.deepEqual(missing.removed, [])
      const root = makeTree()
      try {
        const result = await removeArtifacts(LEGACY, root)
        assert.equal(result.removed.length, 1)
        assert.equal(existsSync(join(root, '--proj-d--', LEGACY)), false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  ],

  [
    'detachLiveEntry removes the store entry through its own disposer',
    (assert) => {
      const { ctx, store } = makeCtx({ liveIds: [SESSION] })
      assert.equal(detachLiveEntry(ctx.sessions, SESSION), true)
      assert.equal(store.has(SESSION), false)
      assert.equal(detachLiveEntry(ctx.sessions, SESSION), false, 'second detach is a no-op')
      assert.equal(detachLiveEntry(undefined, SESSION), false, 'absent service is not an error')
    },
  ],

  [
    'detachAccounting unarchives and detaches every owning workspace',
    async (assert) => {
      let detached = 0
      const workspace = {
        id: 'ws-1',
        sessionIds: [SESSION],
        detachSession: async () => {
          detached += 1
        },
      }
      const { ctx, registry } = makeCtx({ archived: [SESSION], workspaces: [workspace] })
      const result = await detachAccounting(ctx, SESSION)
      assert.equal(result.unarchived, true)
      assert.deepEqual(result.detached, ['ws-1'])
      assert.equal(detached, 1)
      assert.deepEqual(registry.archivedSessionIds, [])
    },
  ],

  [
    'deleteSession refuses an invalid id before touching anything',
    async (assert) => {
      const { ctx } = makeCtx({})
      for (const bad of ['../../../etc/passwd', 'session-../../x', '', 'a'.repeat(40), undefined]) {
        let code
        try {
          await deleteSession(ctx, bad)
        } catch (error) {
          code = error.code
        }
        assert.equal(code, 'bad-request', `expected refusal for ${String(bad)}`)
      }
    },
  ],

  [
    'deleteSession refuses a session with an attached agent',
    async (assert) => {
      const { ctx } = makeCtx({ agentStatus: 'idle' })
      let message = ''
      try {
        await deleteSession(ctx, SESSION)
      } catch (error) {
        message = error.message
        assert.equal(error.code, 'refused')
      }
      assert.match(message, /attached|open/i)
    },
  ],

  [
    'deleteSession removes a live entry, accounting, files and the cache row',
    async (assert) => {
      const root = makeTree()
      const workspace = { id: 'ws-1', sessionIds: [SESSION], detachSession: async () => {} }
      const { ctx, store, projectionTable } = makeCtx({
        liveIds: [SESSION],
        archived: [SESSION],
        workspaces: [workspace],
      })
      try {
        const value = await deleteSession(ctx, SESSION, { root })
        assert.equal(value.liveBefore, true, 'the live store entry is detected')
        assert.equal(value.liveDetached, true)
        assert.equal(store.has(SESSION), false)
        assert.equal(value.accounting.unarchived, true)
        assert.deepEqual(value.accounting.detached, ['ws-1'])
        assert.equal(value.projection.ok, true)
        assert.equal(value.projection.deleted, true)
        assert.equal(projectionTable.rows.has(SESSION), false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  ],

  [
    'removeProjection reports a closed domain instead of failing',
    async (assert) => {
      const result = await removeProjection({ get: () => undefined }, SESSION)
      assert.equal(result.ok, false)
      assert.equal(typeof result.reason, 'string')
    },
  ],

  [
    'deleteSession declares the service it reads and logs a kept projection row',
    async (assert) => {
      assert.ok(inject.includes('storageDomain'), 'the host half must declare the storageDomain it reads')
      const root = makeTree()
      const { ctx, warns } = makeCtx({ projection: false })
      try {
        const value = await deleteSession(ctx, SESSION, { root })
        assert.equal(value.projection.ok, false, 'the step result names the failure')
        assert.equal(typeof value.projection.reason, 'string')
        assert.equal(warns.length, 1, 'the skipped step is visible in the log too')
        assert.equal(warns[0].includes(value.projection.reason), true, 'the log names why the row was kept')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  ],

  [
    'the delete route refuses a non-POST method and a non-JSON content type',
    async (assert) => {
      const { ctx, routes } = makeCtx({})
      apply(ctx)
      const handler = routes.get(ROUTE_PATH)
      assert.equal(typeof handler, 'function', 'the delete route must be registered')

      const get = exchange({ method: 'GET' })
      await handler(get.req, get.res)
      assert.equal(get.res.status, 405)
      assert.deepEqual(get.json(), { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })

      for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', null]) {
        const wrong = exchange({ contentType, body: '{"sessionId":"nope"}' })
        await handler(wrong.req, wrong.res)
        assert.equal(wrong.res.status, 415, `content-type ${String(contentType)} must be refused`)
        assert.deepEqual(wrong.json(), {
          ok: false,
          error: { code: 'unsupported-media-type', message: 'content-type must be application/json' },
        })
      }

      // A JSON request gets past both gates: the invalid id is what fails next,
      // which also keeps this case away from the real sessions root.
      const json = exchange({ contentType: 'application/json; charset=utf-8', body: '{"sessionId":"nope"}' })
      await handler(json.req, json.res)
      assert.equal(json.res.status, 400)
      assert.equal(json.json().error.code, 'bad-request')
    },
  ],
]
