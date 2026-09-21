/**
 * `dsh-plugin-hooks-ordering` — deterministic before/after ordering for Cordis
 * hooks whose participants are contributed by independent, mutually-unaware
 * plugins.
 *
 * This is the public barrel: it re-exports the whole surface and nothing else.
 * The implementations live in focused modules:
 *
 * - `./topo-sort` — the pure, zero-dependency stable topological sort.
 * - `./dag` — JSON rendering of the constraint graph.
 * - `./service-base` — coordinator machinery shared by both services.
 * - `./waterfall` — {@link HookOrdering}, for `waterfall` hooks (the default export).
 * - `./serial` — {@link SerialHookOrdering}, for `serial` hooks.
 * - `./dsh` — the DeepSeek-Harness layer (separate entry point).
 *
 * @module dsh-plugin-hooks-ordering
 */

// Pure ordering algebra.
export { DuplicateNameError, type Orderable, OrderingCycleError, topoSort } from './topo-sort.ts'

// Constraint-graph rendering.
export { type Dag, type DagEdge, type DagSection, type DagSectionGraph, buildDag } from './dag.ts'

// Shared service machinery.
export { HookControlError, type HookOrderingLogConfig, type Phase } from './service-base.ts'

// Waterfall service.
export { type HookEntry, type HookOrderingConfig, HookOrdering } from './waterfall.ts'

// Serial service.
export { type SerialHookEntry, type SerialHookOrderingConfig, SerialHookOrdering } from './serial.ts'

// NOTE: the root entry deliberately has NO default export.
//
// dsh's loader normalizes an imported module with `exports.default ?? exports`
// and only then applies it. A default export that is not the plugin therefore
// HIJACKS the row: naming this package in `cordis.patch.yml` mounted the
// default (`HookOrdering`) as the plugin, so the waterfall service showed up
// while `apply` never ran — no serial service, no settings namespace, no
// controlled hook, and no error anywhere.
//
// The root entry IS the dsh plugin; the library surface lives on the subpaths.
// `HookOrdering` is still exported by name here, and `/waterfall` still carries
// it as its default.
export {
  apply,
  type Config,
  DEFAULT_SERIAL_HOOKS,
  DEFAULT_SYNC_RETURN_HOOKS,
  DEFAULT_WATERFALL_HOOKS,
  inject,
  name,
} from './dsh.ts'
