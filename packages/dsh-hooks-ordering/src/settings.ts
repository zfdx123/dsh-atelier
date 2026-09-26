/**
 * This plugin's Cordis Config — and, since DSH 0.1.7, its Settings page.
 *
 * 0.1.7 removed `ctx.settings.register(ns, schema)`. Settings are now *projected
 * from each entry's own Config*: the loader validates the row's `config` against
 * this schema, resolves the defaults, and the settings service renders exactly
 * the nodes marked `.volatile()` as an editable form. Three consequences are
 * load-bearing here:
 *
 * - The defaults below are the *real* defaults, not "off" placeholders. Nothing
 *   supplies a second `base` layer any more, so an entry whose `config:` key is
 *   empty must resolve to the hook set this plugin controls by default.
 * - `.volatile()` belongs on the individual fields, never on the root object:
 *   a volatile root collapses the whole Config into a single reference and
 *   discards every nested default (verified against schemastery 3.18.4), and
 *   schemastery rejects a volatile node nested inside another volatile node.
 * - The schema is built lazily by {@link hooksOrderingConfig}. `dsh.ts` imports
 *   this module and this module needs `dsh.ts`'s default hook lists, so building
 *   the schema eagerly would read those bindings before they are initialized.
 *
 * `syncReturnHooks` is deliberately absent: it describes the HOST's dispatch
 * (which hooks are consumed without awaiting), not a user preference, so it
 * stays composition-only in `apply()`.
 *
 * @module dsh-hooks-ordering/settings
 */

import Schema from '@deepseek-ai/schemastery'

/** The fields this plugin exposes as editable settings. */
export interface HooksOrderingSettings {
  /** Waterfall hooks to control; `[]` disables the waterfall service entirely. */
  readonly hooks: readonly string[]
  /** Serial hooks to control; `[]` disables the serial service entirely. */
  readonly serialHooks: readonly string[]
  /** Constraint-DAG log file; the empty string means "do not log". */
  readonly log: string
}

/**
 * Entry id used by `cordis.patch.yml` and, in 0.1.7, by the settings form.
 *
 * The form is keyed by the **loader entry id**; this constant is the shipped
 * row's id, and it is also the client half's settings-section id.
 */
export const SETTINGS_NS = 'hooks-ordering'

/**
 * Build the Config schema from the caller's default hook lists.
 *
 * Every field is `.volatile()`, so every field is user-editable from the
 * Settings page and an edit is committed into the live reference instead of
 * remounting the plugin. `log` is volatile too, because a non-volatile field
 * would not appear in the form at all.
 *
 * @param defaultWaterfallHooks - waterfall hooks controlled when unconfigured.
 * @param defaultSerialHooks - serial hooks controlled when unconfigured.
 * @returns a callable schemastery schema, which is what Cordis resolves through.
 */
export function hooksOrderingConfig(
  defaultWaterfallHooks: readonly string[],
  defaultSerialHooks: readonly string[],
): Schema {
  return Schema.object({
    hooks: Schema.array(Schema.string()).default([...defaultWaterfallHooks]).volatile(),
    serialHooks: Schema.array(Schema.string()).default([...defaultSerialHooks]).volatile(),
    log: Schema.string().default('').volatile(),
  })
}

/**
 * Read one resolved field, unwrapping a volatile reference when the loader
 * supplied one and falling back to a default when the field is absent.
 *
 * A loader-provided Config carries volatile fields as references (`.get()`);
 * a plain Cordis mount, or an older harness, passes plain values. Both must
 * work, and an absent field must not be confused with an explicit empty one.
 *
 * @param config - the resolved plugin config (possibly `null`).
 * @param field - the field to read.
 * @param fallback - value to use when the field is absent.
 * @returns the field's current value, or `fallback`.
 */
export function readSetting<T>(
  config: object | null | undefined,
  field: string,
  fallback: T,
): T {
  const value = (config as Record<string, unknown> | null | undefined)?.[field]
  if (value === undefined || value === null) return fallback
  if (typeof (value as { get?: unknown }).get === 'function') {
    const current = (value as { get(): unknown }).get()
    return (current ?? fallback) as T
  }
  return value as T
}
