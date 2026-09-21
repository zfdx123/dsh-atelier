// dsh-session-cleaner-local — delete sessions from a running DeepSeek Harness
// web runtime, without restarting it.
//
// The product only archives: `workspace.archiveSession` hides a session by
// adding its id to a registry set, and the session's files stay on disk. There
// is no `session.delete`. This bundle closes that gap.
//
// Deletion is irreversible and does four things:
//   1. detaches the session's live SessionStore entry, when it has one, through
//      the store's own entry disposer rather than around it. Only an agent
//      session ever has an entry: the agent loop is the sole `sessions.enter`
//      caller, and `session.list` reads live entries while summarizing every
//      other session from persistence — it does not prepare cold sessions into
//      the store. Because this route refuses any session with an attached
//      agent, the detach is a defensive guard, kept so a store entry that
//      outlived its agent cannot survive as a row over deleted files;
//   2. drops the id from the global archive set and from every workspace
//      record that accounts for it;
//   3. deletes the on-disk artifact directory `<root>/<project>/<sessionId>`;
//   4. deletes the session's `session_projcache` row (the file search index is
//      derived and prunes itself).
//
// The sidebar row itself is dropped by the CLIENT half: `session/disposed` —
// the event the session controller forwards as `api-session/removed` — only
// fires for an ANNOUNCED live entry, and a deleted session has no live entry
// for the reason above.
//
// Everything is `node:fs` — no shell, no quoting, no platform branch.
//
// One HTTP route, mirroring the host's JSON envelope:
//   POST /api-ext/session.delete   body: { "sessionId": "session-…" }
//   → 200 { "ok": true,  "value": { … } }
//   → 400 { "ok": false, "error": { "code": "bad-request", … } }
//   → 409 { "ok": false, "error": { "code": "refused",     … } }
//   → 415 { "ok": false, "error": { "code": "unsupported-media-type", … } }
//   → 500 { "ok": false, "error": { "code": "internal",    … } }

import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const name = 'dsh-session-cleaner'

// `storageDomain` backs {@link removeProjection}: the provider is already
// present wherever `workspaceRegistry` is (dsh-workspace injects it), so
// declaring it costs nothing and removes the reflective read.
export const inject = ['webServer', 'workspaceRegistry', 'sessions', 'agents', 'storageDomain']

/** Route path, shared with the ecosystem convention for this feature. */
export const ROUTE_PATH = '/api-ext/session.delete'

/**
 * Diagnostic route. The ⋮ menu entry is necessarily a DOM augmentation (the
 * session row menu has no public slot), so the client half reports what it saw
 * and did here, and the same endpoint reads those reports back. Bounded in
 * memory, never persisted.
 */
export const DIAG_PATH = '/api-ext/session.cleaner.diag'

/** How many diagnostic entries to keep. */
const DIAG_LIMIT = 100

/** Ring buffer behind {@link DIAG_PATH}. */
const diagnostics = []

/**
 * Read-only introspection of one session's deletion surface: validity, artifact
 * directories a delete would touch, live entry, attached agent, archive and
 * workspace membership. Deletes nothing — this is the safe way to see what the
 * plugin sees.
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - session to inspect.
 * @returns {Promise<object>} leaf-field report.
 */
export async function inspectSession(ctx, sessionId) {
  const root = sessionsRoot()
  const report = {
    sessionId: String(sessionId),
    valid: typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId),
    root,
    sessionsRootExists: false,
    dirs: [],
    liveEntry: false,
    agentStatus: null,
    archived: false,
    workspaces: [],
  }
  const agent = ctx.agents?.get?.(sessionId)
  report.agentStatus = agent === undefined ? null : String(agent.status ?? 'attached')
  report.liveEntry = ctx.sessions?.get?.(sessionId) !== undefined
  report.archived = (ctx.workspaceRegistry?.archivedSessionIds ?? []).includes(sessionId)
  for (const workspace of ctx.workspaceRegistry?.list?.() ?? []) {
    if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
      report.workspaces.push(String(workspace.id))
    }
  }
  try {
    const projects = await readdir(root, { withFileTypes: true })
    report.sessionsRootExists = true
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const dir = join(root, project.name, sessionId)
      try {
        if ((await stat(dir)).isDirectory()) report.dirs.push(dir)
      } catch {
        /* not under this project */
      }
    }
  } catch {
    /* root absent */
  }
  return report
}

/** Max accepted request body, in bytes. */
const BODY_LIMIT = 1 << 16

/**
 * Session ids DSH mints: current `session-<uuid>`, or the legacy bare `<uuid>`
 * used before the prefix existed. Anything else (a path separator, a dot, a
 * colon) is rejected before it can reach a filesystem path.
 */
const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Default harness home; mirrors the host's `defaultDshHome` (`dsh-home-paths`). */
function defaultDshHome() {
  return join(homedir(), '.dsh')
}

/** Expand `~`, `~/`, or `~\` against the OS home; mirrors the host's `expandHomePath`. */
function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * The sessions root: `$DSH_HOME/sessions`, or `~/.dsh/sessions` when the
 * override is unset or blank. Resolved the way the host's `resolveDshHome`
 * does — tilde expansion first, then a resolve against the working directory —
 * so the plugin and the persistence backend always name the same tree.
 * @returns {string} absolute sessions root.
 */
export function sessionsRoot() {
  const configured = process.env.DSH_HOME
  const home =
    configured === undefined || configured.trim().length === 0 ? defaultDshHome() : expandHomePath(configured)
  return join(resolve(home), 'sessions')
}

/**
 * Delete every `<root>/<project>/<sessionId>` directory. Only an entry whose
 * name is exactly the validated id is touched.
 * @param {string} sessionId - validated session id.
 * @param {string} [root] - sessions root override (tests).
 * @returns {Promise<{root: string, removed: string[], failed: {path: string, reason: string}[]}>}
 */
export async function removeArtifacts(sessionId, root = sessionsRoot()) {
  const removed = []
  const failed = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return { root, removed, failed } // root absent — nothing to remove
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = join(root, project.name, sessionId)
    try {
      const info = await stat(dir)
      if (!info.isDirectory()) continue
    } catch {
      continue // this project does not hold the session
    }
    try {
      await rm(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch (error) {
      failed.push({ path: dir, reason: String(error?.message ?? error) })
    }
  }
  return { root, removed, failed }
}

/**
 * Detach a session from the live store. The entry is the one `SessionStore`
 * itself keeps, and its `detach` is the disposer `enter()` returned, so this is
 * the store's own removal path rather than a shortcut around it.
 * @param {object} sessions - the `sessions` service.
 * @param {string} sessionId - session to detach.
 * @returns {boolean} whether a live entry was detached.
 */
export function detachLiveEntry(sessions, sessionId) {
  const entry = sessions?.store?.get?.(sessionId)
  if (entry === undefined || typeof entry.detach !== 'function') return false
  entry.detach()
  return true
}

/**
 * Remove the session from the archive set and from every accounting workspace.
 * @param {object} ctx - plugin context (needs workspaceRegistry).
 * @param {string} sessionId - session to detach.
 * @returns {Promise<{unarchived: boolean, detached: string[]}>}
 */
export async function detachAccounting(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  const result = { unarchived: false, detached: [] }
  if (registry === undefined) return result
  if ((registry.archivedSessionIds ?? []).includes(sessionId)) {
    await registry.unarchiveSession(sessionId)
    result.unarchived = true
  }
  for (const workspace of registry.list()) {
    const ids = workspace?.sessionIds
    if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
    await workspace.detachSession?.(sessionId)
    result.detached.push(String(workspace.id))
  }
  return result
}

/**
 * Delete the `session_projcache/sessions/<id>` row when that domain is open.
 * The row is a fold shortcut, not an authority, so a closed domain does not
 * fail the delete — the cache self-heals from the log on the next cold read.
 * The provider itself is declared in {@link inject}, so an absent service is a
 * load-time failure rather than a step that quietly does nothing.
 * @param {object} ctx - plugin context (needs storageDomain).
 * @param {string} sessionId - session whose cached projections to drop.
 * @returns {Promise<{ok: boolean, deleted?: boolean, reason?: string}>}
 */
export async function removeProjection(ctx, sessionId) {
  const domain = ctx.get?.('storageDomain')?.get?.('session_projcache')
  if (domain === undefined) return { ok: false, reason: 'session_projcache domain is not open' }
  const table = domain.table('sessions')
  const existed = table.get(sessionId) !== undefined
  if (existed) await table.delete(sessionId)
  return { ok: true, deleted: existed }
}

/** Write one JSON envelope and end the response. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Read and parse a bounded JSON request body. */
async function readJsonBody(req, limit = BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`request body exceeds ${limit} bytes`)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Whether the request declares a JSON body: both routes accept JSON only, so a
 * cross-site form post (which cannot set this header) never reaches the
 * handlers, and a wrong-typed body fails before it is parsed.
 */
function isJsonRequest(req) {
  const header = req.headers?.['content-type']
  return typeof header === 'string' && header.split(';')[0].trim().toLowerCase() === 'application/json'
}

/** The refusal both routes answer for a body that is not JSON. */
function sendUnsupportedMediaType(res) {
  return sendJson(res, 415, {
    ok: false,
    error: { code: 'unsupported-media-type', message: 'content-type must be application/json' },
  })
}

/**
 * The deletion itself, independent of transport.
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - requested session id.
 * @param {{root?: string}} [options] - `root` overrides the sessions root; it
 *   exists so tests can run against a scratch tree instead of real sessions.
 * @returns {Promise<object>} the success envelope's `value`.
 * @throws {Error & {code?: string}} with `code: 'bad-request' | 'refused'`.
 */
export async function deleteSession(ctx, sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    const error = new Error('missing or invalid sessionId')
    error.code = 'bad-request'
    throw error
  }
  // An attached agent — running OR idle — means the session is open in the UI.
  // Tearing an open session down from under its owner is not this plugin's
  // business, so it refuses and lets the user close it first.
  const agent = ctx.agents?.get?.(sessionId)
  if (agent !== undefined) {
    const status = typeof agent.status === 'string' ? agent.status : 'attached'
    const error = new Error(`session "${sessionId}" is open (agent status: ${status}); close it before deleting`)
    error.code = 'refused'
    throw error
  }

  const liveBefore = ctx.sessions?.get?.(sessionId) !== undefined
  const liveDetached = detachLiveEntry(ctx.sessions, sessionId)
  const accounting = await detachAccounting(ctx, sessionId)
  const files = await removeArtifacts(sessionId, options.root)
  const projection = await removeProjection(ctx, sessionId)
  if (projection.ok !== true) {
    // The delete still succeeds; logging is what keeps the skipped step from
    // being invisible to anyone but the caller reading the envelope.
    ctx.logger?.warn?.(`dsh-session-cleaner: ${sessionId}: projection row kept — ${projection.reason}`)
  }

  return {
    sessionId,
    liveBefore, // true when a live store entry existed (only an agent session has one)
    liveDetached,
    accounting,
    files,
    projection,
  }
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            return sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
          }
          if (!isJsonRequest(req)) return sendUnsupportedMediaType(res)
          let payload
          try {
            payload = await readJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, {
              ok: false,
              error: { code: 'bad-request', message: String(error?.message ?? error) },
            })
          }
          try {
            const value = await deleteSession(ctx, payload?.sessionId)
            return sendJson(res, 200, { ok: true, value })
          } catch (error) {
            const code = typeof error?.code === 'string' ? error.code : 'internal'
            const status = code === 'bad-request' ? 400 : code === 'refused' ? 409 : 500
            if (code === 'internal') {
              ctx.logger?.warn?.(
                `dsh-session-cleaner: delete ${String(payload?.sessionId)} failed: ${String(error?.message ?? error)}`,
              )
            }
            return sendJson(res, status, { ok: false, error: { code, message: String(error?.message ?? error) } })
          }
        },
      }),
    'dsh-session-cleaner: delete route',
  )

  // Diagnostic carrier: the client half posts what it observed, and the same
  // route reads the bounded log back (also usable with an `inspect` request to
  // see one session's deletion surface without deleting it).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: DIAG_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            return sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
          }
          if (!isJsonRequest(req)) return sendUnsupportedMediaType(res)
          let payload
          try {
            payload = await readJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, {
              ok: false,
              error: { code: 'bad-request', message: String(error?.message ?? error) },
            })
          }
          try {
            if (typeof payload?.report?.event === 'string') {
              diagnostics.push({
                at: new Date().toISOString(),
                event: String(payload.report.event).slice(0, 200),
                detail: payload.report.detail === undefined ? null : JSON.parse(JSON.stringify(payload.report.detail)),
              })
              while (diagnostics.length > DIAG_LIMIT) diagnostics.shift()
            }
            const value = { entries: diagnostics.slice() }
            if (typeof payload?.inspect === 'string') value.inspect = await inspectSession(ctx, payload.inspect)
            return sendJson(res, 200, { ok: true, value })
          } catch (error) {
            return sendJson(res, 500, {
              ok: false,
              error: { code: 'internal', message: String(error?.message ?? error) },
            })
          }
        },
      }),
    'dsh-session-cleaner: diag route',
  )
}
