/**
 * The DeepSeek-Harness layer: a dsh plugin that mounts the ordering services
 * and takes control of the real dsh hooks that multiple independent packages
 * contribute to, so a profile can opt into deterministic ordering with one row.
 *
 * dsh (deepseek-harness) ships waterfall hooks such as `agent/pre-step`
 * (subscribed by a dozen+ independent packages), `tools/post-execute`,
 * `llm/stream`, and `system-prompt/assemble`, plus the serial hook
 * `agent/turn-stopping`. Their relative listener order is load-bearing yet
 * today decided only by binary `prepend` and registration timing. This plugin
 * controls those hooks up front; controlling an empty hook is a transparent
 * pass-through, so nothing changes until participants register with
 * `before`/`after`.
 *
 * @module dsh-hooks-ordering/dsh
 */

import type { Context } from '@deepseek-ai/cordis'
import HookOrdering from './waterfall.ts'
import { SerialHookOrdering } from './serial.ts'
import { type HooksOrderingSettings, hooksOrderingConfig, readSetting } from './settings.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'hooks-ordering'

/**
 * `settings` is a **hard** dependency, and it has to be declared rather than
 * probed.
 *
 * cordis activates a plugin as soon as the services it declares exist, and
 * `ctx.get('settings')` reads the service store *without* creating that
 * requirement. Without this line the dsh layer loads in the first wave — before
 * the host has provided `settings` — the probe returns `undefined`, and the
 * settings namespace is never registered. Silently: no form, no error.
 *
 * Declaring it makes cordis wait, which also lands this plugin's prepended
 * brackets later in the boot, exactly where the ordering guarantee wants them.
 *
 * This entry targets dsh only — the hook names below are dsh's, and dsh always
 * provides `settings`, so the dependency costs nothing here. `/waterfall` and
 * `/serial` are the entries that carry no host-service requirement.
 */
export const inject = ['settings']

/**
 * The dsh waterfall hooks this plugin controls by default — the ones multiple
 * independent packages contribute to, where relative order matters. Controlling
 * a hook with no registered participants is a no-op pass-through.
 *
 * Every name here was checked against the events dsh actually declares: each is
 * a `@mode waterfall` event in the installed build, and each is dispatched with
 * `await`, so the caller already handles a Promise and the bracket's async
 * phases cannot change the hook's return type. `tools/code-dispatch-log` used
 * to sit in this list and no dsh package declares it at all — controlling a
 * name nothing dispatches "succeeds" and then does nothing forever, which is
 * exactly the dead configuration this list must not carry.
 *
 * The other admission rule is {@link DEFAULT_SYNC_RETURN_HOOKS}: a hook whose
 * value the caller consumes without awaiting cannot carry ordered participants,
 * so controlling it by default would install a bracket nothing may ever
 * register into — the same dead configuration by a different route.
 */
export const DEFAULT_WATERFALL_HOOKS: readonly string[] = [
  'agent/pre-step',
  'agent/request',
  'agent/request-error',
  'system-prompt/assemble',
  'tools/pre-execute',
  'tools/execute',
  'tools/post-execute',
  'fs/write-intent',
  'fs/edit-intent',
  'approval/request',
]

/**
 * dsh hooks whose dispatch return value is consumed by the caller without
 * awaiting, and which therefore cannot carry ordered participants. Verified
 * against the installed build:
 *
 * - `llm/stream` — `dsh-llm` dispatches it as
 *   `return this.ctx.waterfall(this, "llm/stream", options, …)` (no await), and
 *   `dsh-session-title-llm` iterates the result with
 *   `for await (const chunk of ctx.llm.stream(options))`. A Promise there throws
 *   "not async iterable". It is a genuine multi-contributor hook (dsh-agent-loop,
 *   dsh-llm's own invariant, dsh-session-checkpoint-policy, dsh-session-title),
 *   so it is a real loss — but ordering it requires dsh to await the dispatch,
 *   not a plugin-side workaround.
 * - `session-telemetry/record` — `dsh-session-telemetry` returns the record
 *   straight out of the waterfall and hands it to the backend, so a Promise
 *   would be emitted as a record: silent corruption, no error anywhere.
 * - `compaction/summary-error` — `dsh-compaction-basic` dispatches it as
 *   `recover: (…) => this.ctx.waterfall(this, "compaction/summary-error", …, () => false)`
 *   (no await) and consumes the boolean synchronously in
 *   `if (!dependencies.recover(error, agent, prepared.shadowedSeqs, signal)) throw error`.
 *   A Promise is always truthy, so `!recover(…)` is always false and every
 *   summarizer failure is swallowed instead of rethrown — the compaction then
 *   proceeds as if recovery had succeeded.
 *
 * Override per profile with `syncReturnHooks` once the host awaits one of them.
 */
export const DEFAULT_SYNC_RETURN_HOOKS: readonly string[] = [
  'llm/stream',
  'session-telemetry/record',
  'compaction/summary-error',
]

/** The dsh serial hook controlled by default. */
export const DEFAULT_SERIAL_HOOKS: readonly string[] = ['agent/turn-stopping']

/**
 * This plugin's Cordis Config schema.
 *
 * Since DSH 0.1.7 this *is* the Settings page: the fields are `.volatile()`, so
 * the settings service projects exactly them into an editable form and commits
 * an edit into the live reference rather than remounting the plugin. The
 * defaults are the real hook sets below, so an entry whose `config:` key is
 * empty resolves to them.
 */
export const Config = hooksOrderingConfig(DEFAULT_WATERFALL_HOOKS, DEFAULT_SERIAL_HOOKS)

/** The same schema under its pre-0.1.7 name. */
export const HooksOrderingConfig = Config

/**
 * Plugin config as a plain value.
 *
 * A loader-resolved config carries the volatile fields as references instead of
 * plain arrays, so this describes the *plain* shape callers and tests construct.
 */
export interface ConfigShape {
  /**
   * Waterfall hooks to control. Defaults to {@link DEFAULT_WATERFALL_HOOKS}.
   * Pass `[]` to disable the waterfall service entirely.
   */
  hooks?: readonly string[]
  /**
   * Serial hooks to control. Defaults to {@link DEFAULT_SERIAL_HOOKS}.
   * Pass `[]` to disable the serial service entirely.
   */
  serialHooks?: readonly string[]
  /**
   * Hooks whose return value the host consumes without awaiting, and which must
   * therefore refuse participants. Defaults to {@link DEFAULT_SYNC_RETURN_HOOKS}.
   * Pass `[]` — or a set without a given hook — to opt in to ordering it, once
   * the host awaits that dispatch.
   *
   * Composition-only: this describes the HOST's dispatch, not a user
   * preference, so it is intentionally not a field of {@link Config} and never
   * appears on the Settings page.
   */
  syncReturnHooks?: readonly string[]
  /** When set, the constraint DAG (JSON) is logged to this file on every change. */
  log?: string
  /** Overrides the loader entry id; only non-loader harnesses need it. */
  entryId?: string
}

/**
 * Mount {@link HookOrdering} and/or {@link SerialHookOrdering} and control the
 * configured hooks once the services are active.
 *
 * `config` may be `null`, and that is the ordinary case rather than an edge
 * case: a loader row whose `config:` key is followed only by comments parses as
 * YAML null, and a default parameter covers `undefined` but not `null`. This
 * package's own `cordis.patch.yml` is written exactly that way — every option
 * commented out — so a null config must mean "all defaults", not a crash.
 *
 * Since DSH 0.1.7 there is no second "user layer": the row's `config` IS the
 * editable settings, because Cordis validates it against {@link Config} and the
 * settings service projects that schema. A volatile field arrives here as a
 * reference rather than a plain array, which is why every read goes through
 * {@link readSetting} — that also keeps a plain Cordis mount (and an older
 * harness) working, where the fields are plain values.
 *
 * `hooks`/`serialHooks` are read once, at apply time. An edit from the Settings
 * page therefore needs a plugin reload to take effect — the same restart
 * semantics this namespace declared before 0.1.7 (`applies: 'restart'`), since
 * changing the controlled set means adding or removing live hook brackets and
 * the coordinator has no public "release one hook" operation.
 *
 * @param ctx - the Cordis context.
 * @param config - which hooks to control and an optional DAG `log` file; null means all defaults.
 */
export function apply(ctx: Context, config: ConfigShape | null = {}): void {
  const row = config ?? {}
  const settings: HooksOrderingSettings = {
    hooks: readSetting(row, 'hooks', DEFAULT_WATERFALL_HOOKS),
    serialHooks: readSetting(row, 'serialHooks', DEFAULT_SERIAL_HOOKS),
    log: readSetting(row, 'log', ''),
  }
  const { hooks, serialHooks, log } = settings
  const serviceConfig = log === '' ? {} : { log }
  // Not part of the settings form: the sync-return list describes the HOST's
  // dispatch, not a user preference, so it is composition (row) only.
  const syncReturnHooks = row.syncReturnHooks ?? DEFAULT_SYNC_RETURN_HOOKS

  const deps: string[] = []
  if (hooks.length > 0) {
    ctx.plugin(HookOrdering, { ...serviceConfig, syncReturnHooks })
    deps.push('hooksOrdering')
  }
  if (serialHooks.length > 0) {
    ctx.plugin(SerialHookOrdering, serviceConfig)
    deps.push('serialHooksOrdering')
  }
  if (deps.length === 0) return

  // The services activate asynchronously; control the hooks once they exist.
  ctx.inject(deps, (ready) => {
    for (const hook of hooks) ready.hooksOrdering.control(hook)
    for (const hook of serialHooks) ready.serialHooksOrdering.control(hook)
  })
}
