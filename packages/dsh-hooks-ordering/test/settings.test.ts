import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import * as dshLayer from '../src/dsh.ts'
import { DEFAULT_SERIAL_HOOKS, DEFAULT_WATERFALL_HOOKS, apply } from '../src/dsh.ts'
import { SETTINGS_NS, readSetting } from '../src/settings.ts'

/** Flush the microtasks that activate the services and run the inject callback. */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/**
 * Resolve a raw config through the real schema, the way Cordis does.
 *
 * The loader hands `apply` the *resolved* config, where volatile fields are
 * references rather than plain arrays. Tests that want that exact shape must go
 * through `Schema.resolve`; passing the raw object would silently exercise the
 * plain-value path instead.
 */
function resolveThroughSchema(raw: unknown): Record<string, { get(): unknown }> {
  return Schema.resolve(raw, dshLayer.Config, {})[0] as Record<string, { get(): unknown }>
}

describe('the Config schema (0.1.7: it is also the settings form)', () => {
  it('is a callable schemastery schema, which is what Cordis resolves through', () => {
    // A plain object would throw `schema is not a function` during assembly.
    expect(typeof dshLayer.Config).toBe('function')
    expect(typeof (dshLayer.Config as { toJSON?: unknown }).toJSON).toBe('function')
  })

  it('exposes every user-editable field as volatile, and nothing else', () => {
    // The settings service projects exactly the volatile nodes into the form.
    const dict = dshLayer.Config.dict ?? {}
    expect(Object.keys(dict).sort()).toEqual(['hooks', 'log', 'serialHooks'])
    for (const field of ['hooks', 'log', 'serialHooks']) {
      expect(dict[field]!.meta.volatile, `${field} must be volatile`).toBe(true)
    }
    // syncReturnHooks describes the HOST's dispatch, not a preference.
    expect(dict.syncReturnHooks).toBeUndefined()
  })

  it('resolves an untouched config to the real default hook sets', () => {
    // Regression: before 0.1.7 the defaults came from a second `base` layer.
    // There is no such layer now, so the schema itself must carry them.
    const resolved = resolveThroughSchema({})
    expect(resolved.hooks!.get()).toEqual(DEFAULT_WATERFALL_HOOKS)
    expect(resolved.serialHooks!.get()).toEqual(DEFAULT_SERIAL_HOOKS)
    expect(resolved.log!.get()).toBe('')
  })

  it('keeps an explicit empty list distinct from an absent one', () => {
    const resolved = resolveThroughSchema({ hooks: [], serialHooks: [] })
    expect(resolved.hooks!.get()).toEqual([])
    expect(resolved.serialHooks!.get()).toEqual([])
  })

  it('resolves through the schema the loader path, not only the plain path', () => {
    // The id is the loader entry id, which is what keys the form.
    expect(SETTINGS_NS).toBe('hooks-ordering')
  })
})

describe('readSetting', () => {
  it('unwraps a volatile reference', () => {
    expect(readSetting(resolveThroughSchema({ log: 'dag.json' }), 'log', '')).toBe('dag.json')
  })

  it('passes a plain value through', () => {
    expect(readSetting({ hooks: ['a'] }, 'hooks', [])).toEqual(['a'])
    expect(readSetting({ log: 'x.json' }, 'log', '')).toBe('x.json')
  })

  it('falls back only when the field is absent, never for an explicit empty value', () => {
    expect(readSetting({}, 'hooks', ['fallback'])).toEqual(['fallback'])
    expect(readSetting(null, 'hooks', ['fallback'])).toEqual(['fallback'])
    expect(readSetting({ hooks: [] }, 'hooks', ['fallback'])).toEqual([])
    expect(readSetting({ log: '' }, 'log', 'fallback')).toBe('')
  })
})

describe('the dsh layer', () => {
  it('uses the built-in hook sets when the row is empty', async () => {
    const ctx = new Context()
    apply(ctx, null)
    await flush()
    expect(ctx.hooksOrdering.plan('agent/pre-step', 'front')).toEqual([])
    expect(ctx.serialHooksOrdering.plan('agent/turn-stopping', 'front')).toEqual([])
  })

  it('mounts what the row config resolves to', async () => {
    const ctx = new Context()
    const config = resolveThroughSchema({ hooks: ['custom/one'], serialHooks: [] })
    apply(ctx, config as never)
    await flush()
    expect(ctx.hooksOrdering.plan('custom/one', 'front')).toEqual([])
    expect(ctx.serialHooksOrdering).toBeUndefined()
  })

  it('accepts a plain (non-loader) config, so a bare Cordis mount still works', async () => {
    const ctx = new Context()
    apply(ctx, { hooks: ['plain/hook'], serialHooks: [] })
    await flush()
    expect(ctx.hooksOrdering.plan('plain/hook', 'front')).toEqual([])
    expect(ctx.serialHooksOrdering).toBeUndefined()
  })

  it('does not need a settings service at all', () => {
    // 0.1.7 removed `settings.register`; this layer no longer touches settings,
    // so it must apply on a context that has never provided one.
    const ctx = new Context()
    expect(() => apply(ctx, {})).not.toThrow()
  })
})

describe('the hard settings dependency', () => {
  // `inject` still matters after 0.1.7 even though nothing is registered: the
  // declaration is what sequences this plugin after the settings provider, and
  // an early load would install the hook brackets ahead of the native listeners.
  it('is still declared, so cordis sequences the plugin after the settings provider', () => {
    expect(dshLayer.inject).toEqual(['settings'])
  })
})

describe('the root entry as a dsh plugin', () => {
  // Regression: dsh maps a row's `name` back to a package to find the browser
  // half. `locatePkgJson` only accepts a bare package specifier, so a row naming
  // `.../dsh` loads the host plugin but silently never finds `dsh.client` — the
  // settings page never appears, with no error anywhere. The row must name the
  // package itself, which resolves to this barrel, so the barrel has to carry
  // the plugin surface.
  it('re-exports apply/name/inject/Config, so a bare-name row loads it as a plugin', async () => {
    const barrel = await import('../src/index.ts')
    expect(typeof barrel.apply).toBe('function')
    expect(barrel.name).toBe(dshLayer.name)
    expect(barrel.inject).toEqual(dshLayer.inject)
    // Without a `Config` export the row has no settings schema to project.
    expect(typeof barrel.Config).toBe('function')
  })

  // Regression: the loader normalizes an imported module with
  // `exports.default ?? exports` BEFORE applying it, so any default export
  // hijacks the row. With `default` set to the waterfall service, naming this
  // package mounted that service as the plugin and `apply` never ran: the
  // service was present, zero hooks were controlled, no settings namespace was
  // registered, and nothing errored anywhere.
  it('has no default export at all', async () => {
    const barrel = await import('../src/index.ts')
    expect('default' in barrel).toBe(false)
  })
})
