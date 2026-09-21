import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HookControlError, HookOrdering } from '../src/index.ts'
import { SerialHookOrdering } from '../src/serial.ts'
import { DEFAULT_SERIAL_HOOKS, DEFAULT_SYNC_RETURN_HOOKS, DEFAULT_WATERFALL_HOOKS, apply, name } from '../src/dsh.ts'

/** Flush the microtasks that activate the services and run the inject callback. */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-ordering-dsh-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the dsh layer plugin', () => {
  it('exposes a loader name and non-empty default hook sets', () => {
    expect(name).toBe('hooks-ordering')
    expect(DEFAULT_WATERFALL_HOOKS).toContain('agent/pre-step')
    expect(DEFAULT_SERIAL_HOOKS).toEqual(['agent/turn-stopping'])
  })

  it('mounts both services and controls the default dsh hooks', async () => {
    const ctx = new Context()
    apply(ctx, {})
    await flush()
    // A default waterfall hook is controlled (plan does not throw).
    expect(ctx.hooksOrdering.plan('agent/pre-step', 'front')).toEqual([])
    expect(ctx.hooksOrdering.plan('tools/post-execute', 'front')).toEqual([])
    // The default serial hook is controlled.
    expect(ctx.serialHooksOrdering.plan('agent/turn-stopping', 'front')).toEqual([])
  })

  it('mounts the defaults when the config is null — what an all-commented loader row yields', async () => {
    const ctx = new Context()
    // YAML `config:` followed only by comments parses as null, and a default
    // parameter covers undefined but not null. The shipped cordis.patch.yml is
    // written exactly that way, so this null is the real dsh boot path.
    apply(ctx, null)
    await flush()
    expect(ctx.hooksOrdering.plan('agent/pre-step', 'front')).toEqual([])
    expect(ctx.serialHooksOrdering.plan('agent/turn-stopping', 'front')).toEqual([])
  })

  it('lets a contributor order itself on a real dsh hook', async () => {
    const ctx = new Context()
    apply(ctx, {})
    await flush()
    ctx.hooksOrdering.register('agent/pre-step', 'front', { name: 'b', run: () => {} })
    ctx.hooksOrdering.register('agent/pre-step', 'front', { name: 'a', before: ['b'], run: () => {} })
    expect(ctx.hooksOrdering.plan('agent/pre-step', 'front')).toEqual(['a', 'b'])
  })

  it('honors an explicit hook list and skips defaults not named', async () => {
    const ctx = new Context()
    apply(ctx, { hooks: ['custom/hook'], serialHooks: [] })
    await flush()
    expect(ctx.hooksOrdering.plan('custom/hook', 'front')).toEqual([])
    expect(() => ctx.hooksOrdering.plan('agent/pre-step', 'front')).toThrow(HookControlError)
    // Serial service was never mounted.
    expect(ctx.registry.has(SerialHookOrdering)).toBe(false)
    expect(ctx.serialHooksOrdering).toBeUndefined()
    expect(ctx.registry.has(HookOrdering)).toBe(true)
  })

  it('mounts nothing when both hook lists are empty', async () => {
    const ctx = new Context()
    apply(ctx, { hooks: [], serialHooks: [] })
    await flush()
    expect(ctx.hooksOrdering).toBeUndefined()
    expect(ctx.serialHooksOrdering).toBeUndefined()
  })

  it('forwards the log option so the DAG is written on control', async () => {
    const logFile = join(dir, 'dag.json')
    const ctx = new Context()
    apply(ctx, { hooks: ['custom/hook'], serialHooks: [], log: logFile })
    await flush()
    expect(existsSync(logFile)).toBe(true)
    const dag = JSON.parse(readFileSync(logFile, 'utf8'))
    expect(dag.sections.some((s: { hook: string }) => s.hook === 'custom/hook')).toBe(true)
  })
})

describe('sync-return hooks in the dsh layer', () => {
  it('keeps every sync-return hook out of the default control set', () => {
    // A dsh hook whose caller consumes the return value without awaiting cannot
    // carry ordered participants (see the coordinator's sync-return admission),
    // so controlling it by default would install a bracket nothing may ever
    // register into — dead configuration by this list's own standard.
    expect([...DEFAULT_SYNC_RETURN_HOOKS].toSorted()).toEqual([
      'compaction/summary-error',
      'llm/stream',
      'session-telemetry/record',
    ])
    for (const hook of DEFAULT_SYNC_RETURN_HOOKS) expect(DEFAULT_WATERFALL_HOOKS).not.toContain(hook)
  })

  it('refuses a participant on llm/stream even when a profile controls it explicitly', async () => {
    const ctx = new Context()
    apply(ctx, { hooks: [...DEFAULT_WATERFALL_HOOKS, 'llm/stream'], serialHooks: [] })
    await flush()
    // Controlling it succeeded (the bracket is a transparent pass-through)…
    expect(ctx.hooksOrdering.plan('llm/stream', 'front')).toEqual([])
    // …but registering into it is refused instead of corrupting the stream:
    // dsh-session-title-llm iterates `ctx.llm.stream(...)` without awaiting.
    expect(() => ctx.hooksOrdering.register('llm/stream', 'front', { name: 'x', run: () => {} })).toThrow(
      HookControlError,
    )
  })

  it('treats compaction/summary-error as a sync-return hook too', () => {
    // dsh-compaction-basic dispatches it without awaiting:
    //   recover: (…) => this.ctx.waterfall("compaction/summary-error", {…}, () => false)
    // and consumes the boolean synchronously:
    //   if (!dependencies.recover(error, agent, prepared.shadowedSeqs, signal)) throw error
    // A Promise there is always truthy, so `!recover(…)` is always false and the
    // summarizer failure is silently swallowed instead of rethrown.
    expect([...DEFAULT_SYNC_RETURN_HOOKS]).toContain('compaction/summary-error')
  })

  it('refuses a participant on compaction/summary-error', async () => {
    const ctx = new Context()
    apply(ctx, { hooks: ['compaction/summary-error'], serialHooks: [] })
    await flush()
    expect(() => ctx.hooksOrdering.register('compaction/summary-error', 'front', { name: 'x', run: () => {} })).toThrow(
      HookControlError,
    )
  })

  it('lets a profile override the sync set for a hook the host starts awaiting', async () => {
    const ctx = new Context()
    apply(ctx, { hooks: ['llm/stream'], serialHooks: [], syncReturnHooks: [] })
    await flush()
    expect(() => ctx.hooksOrdering.register('llm/stream', 'front', { name: 'x', run: () => {} })).not.toThrow()
  })

  it('lets a profile replace the sync set with its own names', async () => {
    const ctx = new Context()
    apply(ctx, { hooks: ['llm/stream', 'agent/pre-step'], serialHooks: [], syncReturnHooks: ['agent/pre-step'] })
    await flush()
    expect(() => ctx.hooksOrdering.register('agent/pre-step', 'front', { name: 'x', run: () => {} })).toThrow(
      HookControlError,
    )
    expect(() => ctx.hooksOrdering.register('llm/stream', 'front', { name: 'y', run: () => {} })).not.toThrow()
  })
})
