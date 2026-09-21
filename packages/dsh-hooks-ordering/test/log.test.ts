import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HookOrdering } from '../src/index.ts'
import { SerialHookOrdering } from '../src/serial.ts'

const HOOK = 'demo/assemble'

let dir: string
let logFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-ordering-log-'))
  logFile = join(dir, 'dag.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('DAG file logging', () => {
  it('writes the DAG on control and refreshes it on every registration change', async () => {
    const ctx = new Context()
    ctx.plugin(HookOrdering, { log: logFile })
    await Promise.resolve()
    const ho = ctx.hooksOrdering

    ho.control(HOOK)
    expect(existsSync(logFile)).toBe(true)

    const dispose = ho.register(HOOK, 'front', { name: 'auth', before: ['logging'], run: () => {} })
    ho.register(HOOK, 'front', { name: 'logging', run: () => {} })

    const content = readFileSync(logFile, 'utf8')
    // The file always mirrors the live state.
    expect(content).toBe(`${ho.dumpDag()}\n`)
    const front = JSON.parse(content).sections.find((s: { phase: string }) => s.phase === 'front')
    expect(front.nodes).toEqual(['auth', 'logging'])
    expect(front.edges).toEqual([{ from: 'auth', to: 'logging' }])

    dispose()
    const after = JSON.parse(readFileSync(logFile, 'utf8'))
    expect(after.sections.find((s: { phase: string }) => s.phase === 'front').nodes).toEqual(['logging'])
  })

  it('writes from the serial service too', async () => {
    const ctx = new Context()
    ctx.plugin(SerialHookOrdering, { log: logFile })
    await Promise.resolve()
    const so = ctx.serialHooksOrdering
    so.control(HOOK)
    so.register(HOOK, 'front', { name: 's', run: () => {} })
    const front = JSON.parse(readFileSync(logFile, 'utf8')).sections.find((s: { phase: string }) => s.phase === 'front')
    expect(front.nodes).toEqual(['s'])
  })

  it('writes no file when no log is configured, but dumpDag still works', async () => {
    const ctx = new Context()
    ctx.plugin(HookOrdering)
    await Promise.resolve()
    const ho = ctx.hooksOrdering
    ho.control(HOOK)
    ho.register(HOOK, 'front', { name: 'a', run: () => {} })
    expect(existsSync(logFile)).toBe(false)
    expect(JSON.parse(ho.dumpDag()).sections[0].nodes).toEqual(['a'])
  })

  it('reports write failures via console.warn without throwing', async () => {
    // Point the log at an existing directory so writeFileSync throws EISDIR.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = new Context()
      ctx.plugin(HookOrdering, { log: dir })
      await Promise.resolve()
      const ho = ctx.hooksOrdering
      expect(() => ho.control(HOOK)).not.toThrow()
      expect(warn).toHaveBeenCalled()
      expect(String(warn.mock.calls[0]![0])).toContain('failed to write DAG log')
    } finally {
      warn.mockRestore()
    }
  })
})
