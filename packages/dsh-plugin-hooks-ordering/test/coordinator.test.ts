import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import { HookControlError, HookOrdering, OrderingCycleError } from '../src/index.ts'

/** A hook payload that accumulates a call trace. */
interface Trace {
  trace: string[]
}

const HOOK = 'demo/assemble'

/**
 * Dispatch the demo waterfall the way a host would: the caller supplies the
 * built-in default as the last argument, which Cordis runs as the chain
 * terminus after every listener has delegated through `next()`.
 */
function fire(ctx: Context, payload: Trace): Promise<Trace> {
  // The event is dynamic (not declared in the Events map), so the dispatch is
  // cast — exactly what a real host with a declared hook would call type-safely.
  return (ctx as unknown as { waterfall: (name: string, p: Trace, inner: () => Trace) => Promise<Trace> }).waterfall(
    HOOK,
    payload,
    () => {
      payload.trace.push('native-default')
      return payload
    },
  )
}

/** Register a raw listener directly on the waterfall (a plugin doing it the un-coordinated way). */
function rawOn(ctx: Context, run: (p: Trace) => void, prepend = false): void {
  ;(
    ctx as unknown as {
      on: (name: string, fn: (p: Trace, next: () => unknown) => unknown, opts: { prepend: boolean }) => void
    }
  ).on(
    HOOK,
    (p, next) => {
      run(p)
      return next()
    },
    { prepend },
  )
}

describe('the ordering problem with raw Cordis listeners', () => {
  it('runs raw listeners in registration order, so relative order flips with load order', async () => {
    const build = (bFirst: boolean): Context => {
      const ctx = new Context()
      if (bFirst) {
        rawOn(ctx, (p) => p.trace.push('B'))
        rawOn(ctx, (p) => p.trace.push('A'))
      } else {
        rawOn(ctx, (p) => p.trace.push('A'))
        rawOn(ctx, (p) => p.trace.push('B'))
      }
      return ctx
    }
    const aFirst: Trace = { trace: [] }
    const bFirst: Trace = { trace: [] }
    await fire(build(false), aFirst)
    await fire(build(true), bFirst)
    // Same two plugins, opposite order purely because of when they registered.
    // A vendor plugin cannot pin "run me after that other one" this way.
    expect(aFirst.trace).toEqual(['A', 'B', 'native-default'])
    expect(bFirst.trace).toEqual(['B', 'A', 'native-default'])
    expect(aFirst.trace).not.toEqual(bFirst.trace)
  })
})

describe('HookOrdering fixes cross-plugin ordering', () => {
  let ctx: Context
  let ho: HookOrdering

  beforeEach(async () => {
    ctx = new Context()
    ctx.plugin(HookOrdering)
    // A no-inject Service activates after one microtask; awaiting it makes
    // ctx.hooksOrdering available, matching how a host awaits plugin boot.
    await Promise.resolve()
    ho = ctx.hooksOrdering
    ho.control(HOOK)
  })

  it('enforces `after` regardless of registration order', async () => {
    const run = async (registerBFirst: boolean): Promise<string[]> => {
      const local = new Context()
      local.plugin(HookOrdering)
      await Promise.resolve()
      const registry = local.hooksOrdering
      registry.control(HOOK)
      const A = {
        name: 'vendorA',
        run: (p: Trace) => {
          p.trace.push('A')
        },
      }
      const B = {
        name: 'vendorB',
        after: ['vendorA'],
        run: (p: Trace) => {
          p.trace.push('B')
        },
      }
      if (registerBFirst) {
        registry.register(HOOK, 'front', B)
        registry.register(HOOK, 'front', A)
      } else {
        registry.register(HOOK, 'front', A)
        registry.register(HOOK, 'front', B)
      }
      const payload: Trace = { trace: [] }
      await fire(local, payload)
      return payload.trace
    }
    // A before B in BOTH registration orders — order is declared, not raced.
    expect(await run(false)).toEqual(['A', 'B', 'native-default'])
    expect(await run(true)).toEqual(['A', 'B', 'native-default'])
  })

  it('brackets the whole native chain: front before all, back after the built-in default', async () => {
    rawOn(ctx, (p) => p.trace.push('native'))
    ho.register(HOOK, 'front', {
      name: 'f',
      run: (p: Trace) => {
        p.trace.push('front')
      },
    })
    ho.register(HOOK, 'back', {
      name: 'b',
      run: (p: Trace) => {
        p.trace.push('back')
      },
    })
    const payload: Trace = { trace: [] }
    await fire(ctx, payload)
    expect(payload.trace).toEqual(['front', 'native', 'native-default', 'back'])
  })

  it('orders multiple entries within a phase by before/after', async () => {
    ho.register(HOOK, 'front', {
      name: 'mid',
      run: (p: Trace) => {
        p.trace.push('mid')
      },
    })
    ho.register(HOOK, 'front', {
      name: 'last',
      after: ['mid'],
      run: (p: Trace) => {
        p.trace.push('last')
      },
    })
    ho.register(HOOK, 'front', {
      name: 'first',
      before: ['mid'],
      run: (p: Trace) => {
        p.trace.push('first')
      },
    })
    expect(ho.plan(HOOK, 'front')).toEqual(['first', 'mid', 'last'])
    const payload: Trace = { trace: [] }
    await fire(ctx, payload)
    expect(payload.trace).toEqual(['first', 'mid', 'last', 'native-default'])
  })

  it('awaits async participants in order', async () => {
    const later = (label: string, ms: number) => async (p: Trace) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      p.trace.push(label)
    }
    ho.register(HOOK, 'front', { name: 'slow', run: later('slow', 20) })
    ho.register(HOOK, 'front', { name: 'fast', after: ['slow'], run: later('fast', 1) })
    const payload: Trace = { trace: [] }
    await fire(ctx, payload)
    expect(payload.trace).toEqual(['slow', 'fast', 'native-default'])
  })

  it('unregisters a participant via its disposer', async () => {
    ho.register(HOOK, 'front', {
      name: 'keep',
      run: (p: Trace) => {
        p.trace.push('keep')
      },
    })
    const dispose = ho.register(HOOK, 'front', {
      name: 'drop',
      run: (p: Trace) => {
        p.trace.push('drop')
      },
    })
    dispose()
    const payload: Trace = { trace: [] }
    await fire(ctx, payload)
    expect(payload.trace).toEqual(['keep', 'native-default'])
  })

  it('removes the bracket when the control disposer runs', async () => {
    const release = ho.control('other/hook')
    expect(ho.plan('other/hook', 'front')).toEqual([])
    release()
    expect(() => ho.plan('other/hook', 'front')).toThrow(HookControlError)
  })

  it('rejects controlling the same hook twice', () => {
    expect(() => ho.control(HOOK)).toThrow(HookControlError)
  })

  it('rejects registering into an uncontrolled hook', () => {
    expect(() => ho.register('unknown/hook', 'front', { name: 'x', run: () => {} })).toThrow(HookControlError)
  })

  it('surfaces an ordering cycle at dispatch', async () => {
    ho.register(HOOK, 'front', { name: 'a', after: ['b'], run: () => {} })
    ho.register(HOOK, 'front', { name: 'b', after: ['a'], run: () => {} })
    await expect(fire(ctx, { trace: [] })).rejects.toThrow(OrderingCycleError)
  })
})

describe('a service mounted from a loader row whose config key is empty', () => {
  it('accepts a null config instead of throwing on it', () => {
    const ctx = new Context()
    // YAML `config:` followed only by comments parses as null, and a default
    // parameter covers undefined but not null.
    const service = new HookOrdering(ctx, null)
    expect(service.log).toBeUndefined()
    service.control(HOOK)
    expect(service.plan(HOOK, 'front')).toEqual([])
  })
})

describe('return-value transparency of a controlled waterfall', () => {
  /** Dispatch without awaiting, the way a caller of a streaming hook would. */
  function dispatchRaw(ctx: Context, terminal: () => unknown): unknown {
    return (ctx as unknown as { waterfall: (name: string, inner: () => unknown) => unknown }).waterfall(HOOK, terminal)
  }

  it('keeps a synchronous return synchronous while no participant is registered', () => {
    const ctx = new Context()
    const service = new HookOrdering(ctx)
    service.control(HOOK)
    // Cordis returns the OUTERMOST listener's value synchronously, so the
    // bracket must not wrap it: dsh's `llm/stream` hands back an AsyncIterable
    // and its caller consumes it directly, without awaiting.
    const iterable = {
      [Symbol.asyncIterator]: async function* () {
        yield 1
      },
    }
    const result = dispatchRaw(ctx, () => iterable)
    expect(result).toBe(iterable)
    expect((result as { then?: unknown }).then).toBeUndefined()
  })

  it('hands the chain on unchanged while no participant is registered', () => {
    const ctx = new Context()
    const service = new HookOrdering(ctx)
    service.control(HOOK)
    expect(dispatchRaw(ctx, () => 'native')).toBe('native')
  })

  it('must await once a participant exists, so the return becomes a promise', async () => {
    const ctx = new Context()
    const service = new HookOrdering(ctx)
    service.control(HOOK)
    service.register(HOOK, 'front', { name: 'p', run: () => {} })
    const result = dispatchRaw(ctx, () => 'native')
    expect(typeof (result as Promise<unknown>).then).toBe('function')
    await expect(result).resolves.toBe('native')
  })
})

describe('sync-return admission: hooks whose caller consumes the value without awaiting', () => {
  const SYNC_HOOK = 'demo/sync'
  /** Dispatch without awaiting, the way a caller of a streaming hook would. */
  function dispatchRaw(ctx: Context, terminal: () => unknown): unknown {
    return (ctx as unknown as { waterfall: (name: string, inner: () => unknown) => unknown }).waterfall(
      SYNC_HOOK,
      terminal,
    )
  }
  const participant = { name: 'p', run: () => {} }

  it('refuses a participant on a declared sync-return hook', () => {
    const ctx = new Context()
    const service = new HookOrdering(ctx, { syncReturnHooks: [SYNC_HOOK] })
    service.control(SYNC_HOOK)
    // The whole point of the previous describe block: a participant makes the
    // bracket await, and awaiting is what breaks a caller that never awaits.
    // A hook whose host consumes the value synchronously therefore cannot carry
    // ordered participants at all, and saying so beats corrupting the value.
    expect(() => service.register(SYNC_HOOK, 'front', participant)).toThrow(HookControlError)
  })

  it('names the return-value reason and the override in the refusal', () => {
    const ctx = new Context()
    const service = new HookOrdering(ctx, { syncReturnHooks: [SYNC_HOOK] })
    service.control(SYNC_HOOK)
    expect(() => service.register(SYNC_HOOK, 'front', participant)).toThrow(/Promise/)
    expect(() => service.register(SYNC_HOOK, 'front', participant)).toThrow(/syncReturnHooks/)
  })

  it('still controls the hook, so a sync hook without participants stays a pass-through', () => {
    const ctx = new Context()
    const service = new HookOrdering(ctx, { syncReturnHooks: [SYNC_HOOK] })
    service.control(SYNC_HOOK)
    const iterable = {
      [Symbol.asyncIterator]: async function* () {
        yield 1
      },
    }
    expect(dispatchRaw(ctx, () => iterable)).toBe(iterable)
    expect(service.plan(SYNC_HOOK, 'front')).toEqual([])
  })

  it('guards only the declared hooks', () => {
    const ctx = new Context()
    const service = new HookOrdering(ctx, { syncReturnHooks: [SYNC_HOOK] })
    service.control('demo/awaited')
    expect(() => service.register('demo/awaited', 'front', participant)).not.toThrow()
  })

  it('an empty sync set disables the guard — the opt-in escape hatch', () => {
    const ctx = new Context()
    const service = new HookOrdering(ctx, { syncReturnHooks: [] })
    service.control(SYNC_HOOK)
    expect(() => service.register(SYNC_HOOK, 'front', participant)).not.toThrow()
    expect(service.plan(SYNC_HOOK, 'front')).toEqual(['p'])
  })

  it('defaults to guarding nothing when the option is absent', () => {
    const ctx = new Context()
    const service = new HookOrdering(ctx)
    service.control(SYNC_HOOK)
    expect(() => service.register(SYNC_HOOK, 'front', participant)).not.toThrow()
  })
})
