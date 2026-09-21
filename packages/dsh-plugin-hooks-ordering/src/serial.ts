/**
 * `SerialHookOrdering` — the serial-dispatch twin of {@link HookOrdering}.
 *
 * Cordis `serial` dispatch awaits listeners in registration order until one
 * *bails* (returns a value that is not `null`/`false`/`undefined`); the bail
 * value becomes the dispatch result and the remaining listeners never run.
 * There is no `next()` continuation, so unlike waterfall there is no onion to
 * wrap. This service instead brackets the hook with TWO coordinator listeners:
 *
 * - a `prepend`ed **front** coordinator that runs its participants ahead of
 *   every native listener; a bail there short-circuits the whole dispatch.
 * - an appended **back** coordinator that runs its participants best-effort
 *   last (see the limits below).
 *
 * Participants register into the coordinator (not the raw hook) with
 * `before`/`after` names and are run in a stable topological order.
 *
 * @module dsh-plugin-hooks-ordering/serial
 */

import { type Context, isBailed } from '@deepseek-ai/cordis'
import { HookOrderingBase, type HookOrderingLogConfig, type Phase } from './service-base.ts'
import { type Orderable, topoSort } from './topo-sort.ts'

/**
 * One ordered participant in a controlled serial hook phase. Unlike the
 * waterfall entry, `run` may RETURN a value: a bail value (anything but
 * `null`/`false`/`undefined`) short-circuits the serial dispatch.
 * @typeParam A - the hook's payload argument tuple.
 */
export interface SerialHookEntry<A extends readonly unknown[] = readonly unknown[]> extends Orderable {
  /** Run this participant with the hook payload. A bail return stops the chain. */
  readonly run: (...args: A) => unknown | Promise<unknown>
}

/** Configuration for the {@link SerialHookOrdering} service. */
export type SerialHookOrderingConfig = HookOrderingLogConfig

declare module '@deepseek-ai/cordis' {
  interface Context {
    serialHooksOrdering: SerialHookOrdering
  }
}

/**
 * Coordinator service registered at `ctx.serialHooksOrdering`. Controls any
 * number of serial hooks; each owns a prepended front coordinator, an appended
 * back coordinator, and two ordered participant lists.
 */
export class SerialHookOrdering extends HookOrderingBase<SerialHookEntry> {
  /**
   * @param ctx - the Cordis context to register the service in.
   * @param config - optional `log` file for the constraint DAG (JSON); `null` means defaults.
   */
  constructor(ctx: Context, config: SerialHookOrderingConfig | null = {}) {
    super(ctx, 'serialHooksOrdering', config)
  }

  /**
   * Install the two coordinator listeners. The front one is prepended so it
   * runs ahead of the native chain; the back one is appended so it runs after
   * the listeners present at control time. Both are effects on this service's
   * fiber; the returned disposer removes both.
   */
  protected install(hook: string, front: SerialHookEntry[], back: SerialHookEntry[]): () => void {
    const frontCoordinator = (...args: unknown[]): Promise<unknown> => runSerialPhase(front, args)
    const backCoordinator = (...args: unknown[]): Promise<unknown> => runSerialPhase(back, args)
    const removeFront = this.ctx.on(hook as never, frontCoordinator as never, { prepend: true })
    const removeBack = this.ctx.on(hook as never, backCoordinator as never, { prepend: false })
    return () => {
      removeFront()
      removeBack()
    }
  }

  /**
   * Register a participant into a controlled hook phase.
   *
   * @param hook - the controlled serial event name.
   * @param phase - `front` to run ahead of the native chain, `back` best-effort last.
   * @param entry - the participant; its `run` may return a bail value to short-circuit.
   * @returns a disposer that unregisters this participant.
   * @throws {HookControlError} when the hook has not been {@link control}led.
   */
  register<A extends readonly unknown[] = readonly unknown[]>(
    hook: string,
    phase: Phase,
    entry: SerialHookEntry<A>,
  ): () => void {
    return this.registerEntry(hook, phase, entry as unknown as SerialHookEntry)
  }
}

/**
 * Run one phase's participants in stable topological order, awaiting each,
 * until one bails.
 * @param entries - the phase's registered participants.
 * @param payload - the hook payload passed to each `run` callback.
 * @returns the first bail value, or `undefined` if no participant bailed (so
 * the serial dispatch continues to the next listener).
 */
async function runSerialPhase(entries: readonly SerialHookEntry[], payload: readonly unknown[]): Promise<unknown> {
  for (const entry of topoSort(entries)) {
    const result = await entry.run(...payload)
    if (isBailed(result)) return result
  }
  return undefined
}
