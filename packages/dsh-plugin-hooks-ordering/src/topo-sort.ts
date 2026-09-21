/**
 * Deterministic topological sort for named entries carrying `before`/`after`
 * ordering constraints. Zero runtime dependencies: the sort is a pure function
 * of its input, independent of any Cordis context or plugin load order.
 * @module dsh-plugin-hooks-ordering/topo-sort
 */

/** An entry that can be ordered relative to others by name. */
export interface Orderable {
  /** Unique identifier within one hook phase. Referenced by other entries' `before`/`after`. */
  readonly name: string
  /** Names this entry must run before. An unknown name imposes no constraint (see {@link topoSort}). */
  readonly before?: readonly string[]
  /** Names this entry must run after. An unknown name imposes no constraint (see {@link topoSort}). */
  readonly after?: readonly string[]
}

/** Thrown when `before`/`after` constraints form a cycle, so no total order exists. */
export class OrderingCycleError extends Error {
  /** The names still blocked when the sort stalled — the entries on and behind the cycle. */
  readonly cycle: readonly string[]
  /**
   * @param cycle - the names left unresolved by the cycle.
   */
  constructor(cycle: readonly string[]) {
    super(`hooks-ordering: constraints form a cycle among: ${cycle.join(', ')}`)
    this.name = 'OrderingCycleError'
    this.cycle = cycle
  }
}

/** Thrown when two entries in one phase share a `name`, which would make references ambiguous. */
export class DuplicateNameError extends Error {
  /** The duplicated entry name. */
  readonly duplicate: string
  /**
   * @param duplicate - the name registered more than once.
   */
  constructor(duplicate: string) {
    super(`hooks-ordering: duplicate entry name ${JSON.stringify(duplicate)}`)
    this.name = 'DuplicateNameError'
    this.duplicate = duplicate
  }
}

/**
 * Order entries so every `after` target precedes the entry and every `before`
 * target follows it. Ties (entries with no constraint between them) keep their
 * input order, so the result is stable and independent of registration timing.
 *
 * An unknown name in `before`/`after` (no registered entry owns it) imposes no
 * constraint rather than failing: cross-vendor entries reference optional peers
 * that may not be loaded, so a missing target is a legitimate no-op, not a
 * misconfiguration. A cycle among present entries is fatal — it has no valid
 * order — and throws {@link OrderingCycleError}.
 *
 * @param entries - the entries to order; each `name` must be unique.
 * @returns a new array of the same entries in a constraint-respecting order.
 * @throws {DuplicateNameError} when two entries share a `name`.
 * @throws {OrderingCycleError} when present entries form an ordering cycle.
 */
export function topoSort<T extends Orderable>(entries: readonly T[]): T[] {
  const index = new Map<string, number>()
  entries.forEach((entry, position) => {
    if (index.has(entry.name)) throw new DuplicateNameError(entry.name)
    index.set(entry.name, position)
  })

  // successors[i] = entries that must run after entry i. indegree[i] = number
  // of entries that must run before entry i.
  const successors: number[][] = entries.map(() => [])
  const indegree: number[] = entries.map(() => 0)

  const addEdge = (fromName: string, toName: string): void => {
    const from = index.get(fromName)
    const to = index.get(toName)
    // Unknown endpoint: the referenced peer is not loaded, so no ordering
    // relation exists to enforce.
    if (from === undefined || to === undefined || from === to) return
    successors[from]!.push(to)
    indegree[to]!++
  }

  entries.forEach((entry) => {
    for (const target of entry.after ?? []) addEdge(target, entry.name)
    for (const target of entry.before ?? []) addEdge(entry.name, target)
  })

  // Kahn's algorithm. The ready set holds nodes with no unmet predecessor; it
  // is kept in ascending input position so equal candidates emit in input
  // order, giving a deterministic, stable result. Per-phase entry counts are
  // small, so a sort on each insertion is simpler than a hand-rolled heap.
  const ready: number[] = []
  const pushReady = (node: number): void => {
    ready.push(node)
    ready.sort((left, right) => left - right)
  }
  indegree.forEach((count, node) => {
    if (count === 0) pushReady(node)
  })

  const result: T[] = []
  while (ready.length > 0) {
    const node = ready.shift()!
    result.push(entries[node]!)
    for (const successor of successors[node]!) {
      if (--indegree[successor]! === 0) pushReady(successor)
    }
  }

  if (result.length !== entries.length) {
    // The entries still carrying an unmet predecessor are exactly those on or
    // behind the cycle; naming them all is more useful than one arbitrary loop.
    const blocked = entries.filter((_, node) => indegree[node]! > 0).map((entry) => entry.name)
    throw new OrderingCycleError(blocked)
  }
  return result
}
