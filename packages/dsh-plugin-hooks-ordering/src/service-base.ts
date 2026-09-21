/**
 * Shared coordinator machinery for the waterfall and serial hook-ordering
 * services. Both manage, per controlled hook, two ordered participant lists
 * (`front`/`back`) plus the disposer for the installed coordinator(s); they
 * differ only in HOW the coordinator listeners are installed and HOW a phase
 * runs (waterfall wraps the native chain via `next()`; serial runs participants
 * ahead of it with bail short-circuiting). Registration, planning, DAG dumping,
 * and optional file logging are identical, so they live here.
 * @module dsh-plugin-hooks-ordering/service-base
 */

import { writeFileSync } from 'node:fs'
import { type Context, Service } from '@deepseek-ai/cordis'
import { type DagSection, buildDag } from './dag.ts'
import { type Orderable, topoSort } from './topo-sort.ts'

/**
 * Where a participant runs relative to the native hook chain.
 * - `front`: ahead of every native listener (and, for waterfall, the built-in default).
 * - `back`: behind the native chain (waterfall) / best-effort last (serial).
 */
export type Phase = 'front' | 'back'

/** Thrown when registering into, or double-controlling, a hook in an unsupported state. */
export class HookControlError extends Error {
  /**
   * @param message - the specific control-state violation.
   */
  constructor(message: string) {
    super(`hooks-ordering: ${message}`)
    this.name = 'HookControlError'
  }
}

/** Optional file logging shared by both services. */
export interface HookOrderingLogConfig {
  /**
   * When set, the constraint DAG (JSON) is written to this file on every
   * registration change, so it always reflects current state. Write failures
   * are reported via `console.warn` and never thrown back into the fiber.
   */
  readonly log?: string
}

/** Per-hook coordinator state: the two ordered phases and the disposer for the installed coordinator(s). */
export interface ControlledHook<E extends Orderable> {
  readonly front: E[]
  readonly back: E[]
  readonly dispose: () => void
}

/**
 * Common base for the hook-ordering services. Subclasses implement
 * {@link install} (register the coordinator listener(s) for one hook and return
 * their disposer) and expose a typed `register`; everything else is shared.
 * @typeParam E - the participant entry type stored per phase.
 */
export abstract class HookOrderingBase<E extends Orderable> extends Service {
  protected readonly hooks = new Map<string, ControlledHook<E>>()
  /** File the DAG is logged to on every registration change, if configured. */
  readonly log: string | undefined

  /**
   * @param ctx - the Cordis context to register the service in.
   * @param name - the service name exposed on `ctx`.
   * @param config - optional `log` file for the constraint DAG. May be `null`:
   * a loader row whose `config:` key holds only comments parses as YAML null.
   */
  constructor(ctx: Context, name: string, config: HookOrderingLogConfig | null = {}) {
    super(ctx, name)
    this.log = config?.log
  }

  /**
   * Install the coordinator listener(s) for one hook, capturing its `front`/
   * `back` lists, and return a disposer removing them. Subclass-specific.
   */
  protected abstract install(hook: string, front: E[], back: E[]): () => void

  /**
   * Take control of a hook by installing the coordinator listener(s). Called
   * once per hook; participants then register into it. Controlling twice is
   * rejected — a second coordinator would reintroduce the race this removes.
   *
   * @param hook - the event name to control.
   * @returns a disposer that removes the coordinator(s) and forgets the hook.
   * @throws {HookControlError} when the hook is already controlled.
   */
  control(hook: string): () => void {
    if (this.hooks.has(hook)) throw new HookControlError(`hook ${JSON.stringify(hook)} is already controlled`)

    const front: E[] = []
    const back: E[] = []
    const removeListeners = this.install(hook, front, back)

    const dispose = (): void => {
      removeListeners()
      this.hooks.delete(hook)
      this.refreshLog()
    }
    this.hooks.set(hook, { front, back, dispose })
    this.refreshLog()
    return dispose
  }

  /**
   * Shared registration: push the entry into the hook's phase list as a fiber
   * effect, refreshing the DAG log on add and remove.
   *
   * @returns a disposer that unregisters this participant.
   * @throws {HookControlError} when the hook has not been controlled.
   */
  protected registerEntry(hook: string, phase: Phase, entry: E): () => void {
    const controlled = this.hooks.get(hook)
    if (controlled === undefined)
      throw new HookControlError(
        `hook ${JSON.stringify(hook)} is not controlled; call control(${JSON.stringify(hook)}) first`,
      )
    const list = controlled[phase]
    return this.ctx.effect(
      () => {
        list.push(entry)
        this.refreshLog()
        return () => {
          const at = list.indexOf(entry)
          if (at >= 0) list.splice(at, 1)
          this.refreshLog()
        }
      },
      `${this.name}.register(${JSON.stringify(hook)}, ${JSON.stringify(phase)}, ${JSON.stringify(entry.name)})`,
    )
  }

  /**
   * Compute the ordered participant names for one hook phase without running
   * them. Reflects current registrations; useful for tests and diagnostics.
   *
   * @throws {HookControlError} when the hook has not been controlled.
   */
  plan(hook: string, phase: Phase): string[] {
    const controlled = this.hooks.get(hook)
    if (controlled === undefined) throw new HookControlError(`hook ${JSON.stringify(hook)} is not controlled`)
    return topoSort(controlled[phase]).map((entry) => entry.name)
  }

  /**
   * Serialize the constraint DAG of every controlled hook (all phases) as
   * pretty-printed JSON. Pure read: does not write the log file or throw on
   * cycles — the graph is most useful precisely when constraints conflict.
   */
  dumpDag(): string {
    return JSON.stringify(buildDag(this.dagSections()), null, 2)
  }

  /** Flatten every controlled hook into its `front`/`back` DAG sections. */
  protected dagSections(): DagSection[] {
    const sections: DagSection[] = []
    for (const [hook, controlled] of this.hooks) {
      sections.push({ hook, phase: 'front', entries: controlled.front })
      sections.push({ hook, phase: 'back', entries: controlled.back })
    }
    return sections
  }

  /**
   * Best-effort write of the current DAG to the configured `log` file. Never
   * throws: a failure (e.g. unwritable path) is reported via `console.warn`,
   * because this runs inside registration effects and disposers, where an
   * exception would corrupt fiber teardown.
   */
  protected refreshLog(): void {
    if (this.log === undefined) return
    try {
      writeFileSync(this.log, `${this.dumpDag()}\n`)
    } catch (error) {
      console.warn(`hooks-ordering: failed to write DAG log to ${JSON.stringify(this.log)}:`, error)
    }
  }
}
