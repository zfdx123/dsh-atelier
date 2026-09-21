/**
 * `HookOrdering` — deterministic before/after ordering for Cordis waterfall
 * hooks whose participants are contributed by independent plugins.
 *
 * Cordis runs waterfall listeners in registration order (array position, with
 * `prepend` as the only lever), and registration order is driven by
 * inject-dependency activation — non-deterministic between unrelated plugins.
 * A plugin therefore cannot reliably say "run me after that other plugin",
 * especially across vendors that do not depend on each other.
 *
 * This service brackets a chosen waterfall hook with ONE prepended listener
 * that exploits the onion model: code before its `next()` runs ahead of the
 * whole native chain, code after runs behind it. Participants register into
 * this coordinator instead of the raw hook, declaring `before`/`after` names,
 * and the coordinator runs them in a stable topological order it fully
 * controls. The serial-dispatch twin lives in `./serial.ts`.
 *
 * @module dsh-plugin-hooks-ordering/waterfall
 */

import { type Context } from '@deepseek-ai/cordis'
import { HookControlError, HookOrderingBase, type HookOrderingLogConfig, type Phase } from './service-base.ts'
import { type Orderable, topoSort } from './topo-sort.ts'

/**
 * One ordered participant in a controlled waterfall hook phase.
 * @typeParam A - the hook's payload argument tuple (the dispatched args without Cordis' trailing `next`).
 */
export interface HookEntry<A extends readonly unknown[] = readonly unknown[]> extends Orderable {
  /** Run this participant with the hook payload. Awaited before the phase proceeds. */
  readonly run: (...args: A) => void | Promise<void>
}

/** Configuration for the {@link HookOrdering} service. */
export interface HookOrderingConfig extends HookOrderingLogConfig {
  /**
   * Hook names whose dispatch return value the CALLER consumes without
   * awaiting — dsh's `llm/stream` (an AsyncIterable iterated directly) and
   * `session-telemetry/record` (a record handed straight to a backend) are the
   * two in the shipped build.
   *
   * A participant cannot be ordered on such a hook. The bracket only preserves
   * the native return value while both phases are empty; with a participant it
   * must await, so it returns a Promise where the caller expects a value — a
   * broken stream or a corrupted record, silently. {@link HookOrdering.register}
   * therefore refuses those hooks, and *controlling* them stays allowed: the
   * bracket is a transparent pass-through and may become useful the day the
   * host starts awaiting that hook (then pass `[]` here, or a set without it).
   */
  readonly syncReturnHooks?: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    hooksOrdering: HookOrdering
  }
}

/**
 * Coordinator service registered at `ctx.hooksOrdering`. One instance controls
 * any number of waterfall hooks; each controlled hook owns one bracket listener
 * and two ordered participant lists.
 */
export class HookOrdering extends HookOrderingBase<HookEntry> {
  /**
   * Hooks that must never carry a participant: their return value is consumed
   * synchronously by the host, so the bracket's await would corrupt it.
   * @see HookOrderingConfig.syncReturnHooks
   */
  private readonly syncReturnHooks: ReadonlySet<string>

  /**
   * @param ctx - the Cordis context to register the service in.
   * @param config - optional `log` file for the constraint DAG (JSON) and the
   * `syncReturnHooks` admission list; `null` means defaults.
   */
  constructor(ctx: Context, config: HookOrderingConfig | null = {}) {
    super(ctx, 'hooksOrdering', config)
    this.syncReturnHooks = new Set(config?.syncReturnHooks ?? [])
  }

  /**
   * Install the single bracket listener. `prepend` places it first among
   * current listeners so its `next()` encloses the rest of the native chain;
   * the listener is an effect on this service's fiber and is removed with it or
   * with the disposer {@link control} returns.
   *
   * The bracket is deliberately NOT `async` at its outermost level. Cordis'
   * `waterfall` returns the outermost listener's value *synchronously*, so an
   * `async` bracket would turn the hook's return value into a Promise for every
   * caller — breaking any hook whose result the caller consumes without
   * awaiting (dsh's `llm/stream` returns an AsyncIterable, and wraps with
   * "not async iterable"). While both phases are empty there is nothing to
   * order, so the chain is handed straight through and the hook's return type
   * is exactly what it was before control was taken.
   */
  protected install(hook: string, front: HookEntry[], back: HookEntry[]): () => void {
    const bracket = (...args: unknown[]): unknown => {
      const next = args[args.length - 1] as () => unknown
      // Transparent fast path: no participants, so no await is needed and the
      // native return value (promise or not) passes through unchanged.
      if (front.length === 0 && back.length === 0) return next()
      const payload = args.slice(0, -1)
      // With participants the phases must be awaited, so the bracket can only
      // return a promise from here on — inherent to ordering, not a choice.
      return (async (): Promise<unknown> => {
        await runPhase(front, payload)
        const result = await next()
        await runPhase(back, payload)
        return result
      })()
    }
    return this.ctx.on(hook as never, bracket as never, { prepend: true })
  }

  /**
   * Register a participant into a controlled hook phase.
   *
   * @param hook - the controlled waterfall event name.
   * @param phase - `front` to run ahead of the native chain, `back` to run behind it.
   * @param entry - the participant, with optional `before`/`after` names and its `run` callback.
   * @returns a disposer that unregisters this participant.
   * @throws {HookControlError} when the hook has not been {@link control}led, or
   * when it is declared in `syncReturnHooks` — there the participant would work
   * but the host's return value would change type, which is the worse failure.
   */
  register<A extends readonly unknown[] = readonly unknown[]>(
    hook: string,
    phase: Phase,
    entry: HookEntry<A>,
  ): () => void {
    if (this.syncReturnHooks.has(hook)) {
      throw new HookControlError(
        `hook ${JSON.stringify(hook)} returns to a caller that does not await it, so ordering participants would turn its return value into a Promise and break that caller; ` +
          `remove ${JSON.stringify(hook)} from syncReturnHooks only once the host awaits it`,
      )
    }
    return this.registerEntry(hook, phase, entry as unknown as HookEntry)
  }
}

/**
 * Run one phase's participants in stable topological order, awaiting each.
 * @param entries - the phase's registered participants.
 * @param payload - the hook payload passed to each `run` callback.
 */
async function runPhase(entries: readonly HookEntry[], payload: readonly unknown[]): Promise<void> {
  for (const entry of topoSort(entries)) {
    await entry.run(...payload)
  }
}

export default HookOrdering
