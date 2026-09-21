import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import { HookControlError, OrderingCycleError } from '../src/index.ts'
import { SerialHookOrdering } from '../src/serial.ts'

/** A hook payload that accumulates a call trace. */
interface Trace {
  trace: string[]
}

const HOOK = 'demo/turn-stopping'

/** Dispatch the serial hook the way a host would (no trailing `next`). */
function fire(ctx: Context, payload: Trace): Promise<unknown> {
  return (ctx as unknown as { serial: (name: string, p: Trace) => Promise<unknown> }).serial(HOOK, payload)
}

/**
 * Register a raw serial listener directly (a plugin doing it the un-coordinated
 * way). `bail`, when not null/false/undefined, short-circuits the dispatch.
 */
function rawSerial(ctx: Context, run: (p: Trace) => void, bail?: unknown): void {
  ;(ctx as unknown as { on: (name: string, fn: (p: Trace) => unknown, opts: { prepend: boolean }) => void }).on(
    HOOK,
    (p) => {
      run(p)
      return bail
    },
    { prepend: false },
  )
}

describe('SerialHookOrdering', () => {
  let ctx: Context
  let so: SerialHookOrdering

  beforeEach(async () => {
    ctx = new Context()
    // Register the native listener FIRST so the appended back coordinator lands
    // after it (serial `back` is best-effort last).
    rawSerial(ctx, (p) => p.trace.push('native'))
    ctx.plugin(SerialHookOrdering)
    await Promise.resolve()
    so = ctx.serialHooksOrdering
    so.control(HOOK)
  })

  it('runs front ahead of the native chain and back after it, in declared order', async () => {
    so.register(HOOK, 'front', {
      name: 'b',
      run: (p: Trace) => {
        p.trace.push('b')
      },
    })
    so.register(HOOK, 'front', {
      name: 'a',
      before: ['b'],
      run: (p: Trace) => {
        p.trace.push('a')
      },
    })
    so.register(HOOK, 'back', {
      name: 'metrics',
      run: (p: Trace) => {
        p.trace.push('metrics')
      },
    })
    const payload: Trace = { trace: [] }
    await fire(ctx, payload)
    expect(payload.trace).toEqual(['a', 'b', 'native', 'metrics'])
  })

  it('is deterministic regardless of registration order', async () => {
    const run = async (bFirst: boolean): Promise<string[]> => {
      const local = new Context()
      rawSerial(local, (p) => p.trace.push('native'))
      local.plugin(SerialHookOrdering)
      await Promise.resolve()
      const registry = local.serialHooksOrdering
      registry.control(HOOK)
      const A = {
        name: 'a',
        run: (p: Trace) => {
          p.trace.push('a')
        },
      }
      const B = {
        name: 'b',
        after: ['a'],
        run: (p: Trace) => {
          p.trace.push('b')
        },
      }
      if (bFirst) {
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
    expect(await run(false)).toEqual(['a', 'b', 'native'])
    expect(await run(true)).toEqual(['a', 'b', 'native'])
  })

  it('a front bail short-circuits the native chain and the back phase', async () => {
    so.register(HOOK, 'front', {
      name: 'stop',
      run: (p: Trace) => {
        p.trace.push('stop')
        return 'BAILED'
      },
    })
    so.register(HOOK, 'back', {
      name: 'metrics',
      run: (p: Trace) => {
        p.trace.push('metrics')
      },
    })
    const payload: Trace = { trace: [] }
    const result = await fire(ctx, payload)
    expect(result).toBe('BAILED')
    expect(payload.trace).toEqual(['stop'])
  })

  it('a native bail skips the back phase', async () => {
    const local = new Context()
    rawSerial(local, (p) => p.trace.push('native'), 'NATIVE_BAIL')
    local.plugin(SerialHookOrdering)
    await Promise.resolve()
    const registry = local.serialHooksOrdering
    registry.control(HOOK)
    registry.register(HOOK, 'back', {
      name: 'metrics',
      run: (p: Trace) => {
        p.trace.push('metrics')
      },
    })
    const payload: Trace = { trace: [] }
    const result = await fire(local, payload)
    expect(result).toBe('NATIVE_BAIL')
    expect(payload.trace).toEqual(['native'])
  })

  it('a back bail becomes the dispatch result', async () => {
    so.register(HOOK, 'back', { name: 'veto', run: () => 'BACK_BAIL' })
    const result = await fire(ctx, { trace: [] })
    expect(result).toBe('BACK_BAIL')
  })

  it('null returns do not bail, so the chain continues', async () => {
    so.register(HOOK, 'front', {
      name: 'noop',
      run: (p: Trace) => {
        p.trace.push('noop')
        return null
      },
    })
    const payload: Trace = { trace: [] }
    const result = await fire(ctx, payload)
    expect(result).toBeUndefined()
    expect(payload.trace).toEqual(['noop', 'native'])
  })

  it('plans the topological order without running participants', () => {
    so.register(HOOK, 'front', { name: 'b', run: () => {} })
    so.register(HOOK, 'front', { name: 'a', before: ['b'], run: () => {} })
    expect(so.plan(HOOK, 'front')).toEqual(['a', 'b'])
    expect(so.plan(HOOK, 'back')).toEqual([])
    expect(() => so.plan('unknown/hook', 'front')).toThrow(HookControlError)
  })

  it('removes the coordinators when the control disposer runs', () => {
    const release = so.control('other/hook')
    expect(so.plan('other/hook', 'front')).toEqual([])
    release()
    expect(() => so.plan('other/hook', 'front')).toThrow(HookControlError)
  })

  it('rejects controlling the same hook twice', () => {
    expect(() => so.control(HOOK)).toThrow(HookControlError)
  })

  it('rejects registering into an uncontrolled hook', () => {
    expect(() => so.register('unknown/hook', 'front', { name: 'x', run: () => {} })).toThrow(HookControlError)
  })

  it('surfaces an ordering cycle at dispatch', async () => {
    so.register(HOOK, 'front', { name: 'a', after: ['b'], run: () => {} })
    so.register(HOOK, 'front', { name: 'b', after: ['a'], run: () => {} })
    await expect(fire(ctx, { trace: [] })).rejects.toThrow(OrderingCycleError)
  })
})
