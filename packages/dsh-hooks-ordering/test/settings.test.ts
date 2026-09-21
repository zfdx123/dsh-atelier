import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as dshLayer from '../src/dsh.ts'
import { DEFAULT_SERIAL_HOOKS, DEFAULT_WATERFALL_HOOKS, apply } from '../src/dsh.ts'
import { HooksOrderingSettingsSchema, SETTINGS_NS, resolveSettings } from '../src/settings.ts'

/** Flush the microtasks that activate the services and run the inject callback. */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** Install a stand-in `settings` service the way a dsh host provides one. */
function provideSettings(ctx: Context, service: unknown): void {
  ;(ctx as unknown as { provide: (name: string, value: unknown) => void }).provide('settings', service)
}

/** A settings stand-in that records what the plugin registers and resolves to `value`. */
function capturing(value: unknown): {
  calls: { ns: string; schema: unknown; options: unknown }[]
  service: { register: (ns: string, schema: unknown, options: unknown) => { get: () => unknown } }
} {
  const calls: { ns: string; schema: unknown; options: unknown }[] = []
  return {
    calls,
    service: {
      register(ns: string, schema: unknown, options: unknown) {
        calls.push({ ns, schema, options })
        return { get: () => value }
      },
    },
  }
}

const OFF = { hooks: [], serialHooks: [], log: '' }

describe('the settings namespace schema', () => {
  it('is a callable schemastery schema, which is what dsh resolves through', () => {
    // A plain object would throw `schema is not a function` during assembly.
    expect(typeof HooksOrderingSettingsSchema).toBe('function')
    expect(typeof (HooksOrderingSettingsSchema as { toJSON?: unknown }).toJSON).toBe('function')
  })

  it('resolves an untouched namespace to a complete object', () => {
    expect(HooksOrderingSettingsSchema({})).toEqual(OFF)
  })
})

describe('resolving settings into the plugin config', () => {
  it('registers namespace hooks-ordering as restart-applied, over the composition layer', () => {
    const ctx = new Context()
    const cap = capturing(OFF)
    provideSettings(ctx, cap.service)
    resolveSettings(ctx, { hooks: DEFAULT_WATERFALL_HOOKS, serialHooks: DEFAULT_SERIAL_HOOKS, log: '' })
    expect(cap.calls).toHaveLength(1)
    expect(cap.calls[0]!.ns).toBe(SETTINGS_NS)
    expect(typeof cap.calls[0]!.schema).toBe('function')
    expect(cap.calls[0]!.options).toEqual({
      base: { hooks: DEFAULT_WATERFALL_HOOKS, serialHooks: DEFAULT_SERIAL_HOOKS, log: '' },
      applies: 'restart',
    })
  })

  it('is undefined when no settings provider is mounted', () => {
    expect(resolveSettings(new Context(), OFF)).toBeUndefined()
  })

  it('falls back to the composition config when registration throws', () => {
    const ctx = new Context()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    provideSettings(ctx, {
      register() {
        throw new Error('boom')
      },
    })
    expect(resolveSettings(ctx, OFF)).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('the dsh layer with a settings provider', () => {
  it('uses the built-in hook sets as the base layer when the row is empty', async () => {
    const ctx = new Context()
    const cap = capturing({ hooks: DEFAULT_WATERFALL_HOOKS, serialHooks: DEFAULT_SERIAL_HOOKS, log: '' })
    provideSettings(ctx, cap.service)
    apply(ctx, null)
    await flush()
    expect(cap.calls[0]!.options).toMatchObject({
      base: { hooks: DEFAULT_WATERFALL_HOOKS, serialHooks: DEFAULT_SERIAL_HOOKS },
      applies: 'restart',
    })
    expect(ctx.hooksOrdering.plan('agent/pre-step', 'front')).toEqual([])
    expect(ctx.serialHooksOrdering.plan('agent/turn-stopping', 'front')).toEqual([])
  })

  it('mounts what the user layer resolves, not what the row asked for', async () => {
    const ctx = new Context()
    // The user layer drops the row's hook and disables the serial service.
    provideSettings(ctx, capturing({ hooks: ['custom/one'], serialHooks: [], log: '' }).service)
    apply(ctx, { hooks: ['row/hook'], serialHooks: DEFAULT_SERIAL_HOOKS })
    await flush()
    expect(ctx.hooksOrdering.plan('custom/one', 'front')).toEqual([])
    expect(() => ctx.hooksOrdering.plan('row/hook', 'front')).toThrow()
    expect(ctx.serialHooksOrdering).toBeUndefined()
  })

  it('keeps the composition config when registration fails', async () => {
    const ctx = new Context()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    provideSettings(ctx, {
      register() {
        throw new Error('boom')
      },
    })
    apply(ctx, { hooks: ['row/hook'], serialHooks: [] })
    await flush()
    expect(ctx.hooksOrdering.plan('row/hook', 'front')).toEqual([])
    expect(ctx.serialHooksOrdering).toBeUndefined()
    warn.mockRestore()
  })
})

describe('the hard settings dependency', () => {
  // Regression: the dsh layer used to probe the service with `ctx.get`, which
  // reads the store WITHOUT creating a dependency. A bundle with no declared
  // dependency activates in the first wave, before the host provides
  // `settings`, so the probe returned undefined and the namespace was never
  // registered — silently, with no form and no error. Declaring `inject` is
  // what makes cordis wait.
  it('is declared, so cordis sequences the plugin after the settings provider', () => {
    expect(dshLayer.inject).toEqual(['settings'])
  })

  it('stays inactive until a provider exists, then registers the namespace', async () => {
    const ctx = new Context()
    const cap = capturing(OFF)
    ctx.plugin(dshLayer)
    await flush()
    expect(cap.calls).toHaveLength(0) // hard dependency unmet: not loaded yet
    provideSettings(ctx, cap.service)
    await flush()
    expect(cap.calls).toHaveLength(1) // loaded, and registered on the way in
    expect(cap.calls[0]!.ns).toBe(SETTINGS_NS)
  })
})

describe('the root entry as a dsh plugin', () => {
  // Regression: dsh maps a row's `name` back to a package to find the browser
  // half. `locatePkgJson` only accepts a bare package specifier, so a row naming
  // `.../dsh` loads the host plugin but silently never finds `dsh.client` — the
  // settings page never appears, with no error anywhere. The row must name the
  // package itself, which resolves to this barrel, so the barrel has to carry
  // the plugin surface.
  it('re-exports apply/name/inject, so a bare-name row loads it as a plugin', async () => {
    const barrel = await import('../src/index.ts')
    expect(typeof barrel.apply).toBe('function')
    expect(barrel.name).toBe(dshLayer.name)
    expect(barrel.inject).toEqual(dshLayer.inject)
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
