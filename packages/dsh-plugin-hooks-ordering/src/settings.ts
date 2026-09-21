/**
 * The dsh settings namespace for this plugin: the three fields a user can edit
 * from the Settings page instead of a `cordis.patch.yml` row.
 *
 * Two constraints are load-bearing and easy to get wrong:
 *
 * - The schema handed to `settings.register` must be a **callable** schemastery
 *   schema. dsh resolves a namespace by calling `schema(merged)` and reads
 *   `schema.toJSON()` for the form, so a plain object throws
 *   `schema is not a function` — during plugin assembly, which takes the whole
 *   profile down rather than failing one form.
 * - That is also why registration is wrapped in `try/catch` here: an optional
 *   settings form must never be able to stop the harness from booting.
 *
 * @module dsh-plugin-hooks-ordering/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** The three fields this plugin exposes for configuration. */
export interface HooksOrderingSettings {
  /** Waterfall hooks to control; `[]` disables the waterfall service entirely. */
  readonly hooks: readonly string[]
  /** Serial hooks to control; `[]` disables the serial service entirely. */
  readonly serialHooks: readonly string[]
  /** Constraint-DAG log file; the empty string means "do not log". */
  readonly log: string
}

/** Namespace name — dsh requires a lowercase hyphenated identifier. */
export const SETTINGS_NS = 'hooks-ordering'

/**
 * Schema for {@link SETTINGS_NS}.
 *
 * Every field defaults to its "off" value. The *meaningful* defaults — the
 * hooks this plugin controls when nothing overrides them — are supplied by the
 * caller as the composition `base` layer (see {@link resolveSettings}), so a
 * namespace the user has never touched still resolves to a complete object.
 */
export const HooksOrderingSettingsSchema = Schema.object({
  hooks: Schema.array(Schema.string()).default([]),
  serialHooks: Schema.array(Schema.string()).default([]),
  log: Schema.string().default(''),
})

/**
 * The slice of dsh's `settings` service this plugin uses.
 *
 * Structural rather than imported from `@deepseek-ai/dsh-settings`: it describes
 * exactly the contract this plugin relies on without adding a build-time
 * dependency on a dsh package, whose internals are still 0.1.x-rc.
 */
export interface SettingsServiceLike {
  /**
   * @param ns - the namespace to register; must be a lowercase hyphenated identifier.
   * @param schema - a callable schemastery schema, not a plain object.
   * @param options - `base` is the composition layer, `applies` says whether an
   * edit takes effect live or needs a restart.
   * @returns a scope whose `get()` is the resolved value (schema defaults, then `base`, then the user layer).
   */
  register(
    ns: string,
    schema: unknown,
    options?: { readonly base?: unknown; readonly applies?: 'live' | 'restart' },
  ): { get(): HooksOrderingSettings }
}

/**
 * Register the settings namespace and read its resolved value.
 *
 * `base` is the composition layer — what the row (or the built-in defaults)
 * asks for — so the user layer edits *over* it and a reset returns to it rather
 * than to an empty form.
 *
 * `applies: 'restart'` is deliberate. Changing `hooks`/`serialHooks` means
 * installing or removing bracket listeners on live hooks, and the coordinator
 * has no public "release one hook" operation; a restart applies the change
 * cleanly instead of re-wiring the dispatch chain mid-flight.
 *
 * @param ctx - the Cordis context to look the service up on.
 * @param base - the composition layer to register as the base value.
 * @returns the resolved settings, or `undefined` when the provider is missing
 * (which `inject: ['settings']` rules out in dsh — the guard is defensive) or
 * registration failed — the caller then uses `base`.
 */
export function resolveSettings(ctx: Context, base: HooksOrderingSettings): HooksOrderingSettings | undefined {
  const settings = ctx.get('settings') as SettingsServiceLike | undefined
  if (settings === undefined) return undefined
  try {
    return settings.register(SETTINGS_NS, HooksOrderingSettingsSchema, { base, applies: 'restart' }).get()
  } catch (error) {
    console.warn('hooks-ordering: settings registration failed; falling back to the composition config:', error)
    return undefined
  }
}
