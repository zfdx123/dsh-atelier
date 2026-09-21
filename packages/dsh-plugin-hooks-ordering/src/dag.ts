/**
 * JSON rendering of the `before`/`after` constraint graph across controlled
 * hook phases. Pure and dependency-free: the output is a function of the input
 * sections alone. Deliberately NOT a topological sort — a cycle is represented
 * faithfully rather than throwing, because the graph is most useful precisely
 * when the constraints conflict and `topoSort` would fail.
 * @module dsh-plugin-hooks-ordering/dag
 */

import type { Orderable } from './topo-sort.ts'

/** One `(hook, phase)` slice of the constraint graph to render. */
export interface DagSection {
  /** The controlled hook event name. */
  readonly hook: string
  /** The phase within the hook (e.g. `front`/`back`). */
  readonly phase: string
  /** The participants and their `before`/`after` constraints. */
  readonly entries: readonly Orderable[]
}

/** A directed ordering relation: `from` runs before `to`. */
export interface DagEdge {
  /** The participant that runs first. */
  readonly from: string
  /** The participant that runs after `from`. */
  readonly to: string
}

/** The constraint graph of one `(hook, phase)` slice. */
export interface DagSectionGraph {
  /** The controlled hook event name. */
  readonly hook: string
  /** The phase within the hook. */
  readonly phase: string
  /** Every participant name, including ones with no constraint edges. */
  readonly nodes: readonly string[]
  /** The ordering relations; `from` runs before `to`. Deduplicated. */
  readonly edges: readonly DagEdge[]
}

/** The whole constraint graph: one entry per controlled `(hook, phase)`. */
export interface Dag {
  readonly sections: readonly DagSectionGraph[]
}

/**
 * Build the constraint graph of the given sections as a plain object suitable
 * for `JSON.stringify`.
 *
 * Each section becomes a {@link DagSectionGraph}: `nodes` lists every entry
 * name (constraint-free entries included), and `edges` carries the ordering
 * relations. An edge `from -> to` reads "from runs before to": an entry's
 * `before` target yields `{ from: entry, to: target }`, and its `after` source
 * yields `{ from: source, to: entry }`. A reference whose peer is absent from
 * the section imposes no edge — mirroring {@link topoSort}'s unknown-target
 * no-op — and a relation stated from both ends (e.g. `A.before: ['B']` and
 * `B.after: ['A']`) appears once.
 *
 * @param sections - the `(hook, phase)` slices to render, in output order.
 * @returns the graph object; an empty input yields `{ sections: [] }`.
 */
export function buildDag(sections: readonly DagSection[]): Dag {
  return {
    sections: sections.map((section) => {
      const present = new Set(section.entries.map((entry) => entry.name))
      // Collect edges keyed by "from->to" to drop the same relation stated from
      // both ends, preserving first-seen order.
      const seen = new Set<string>()
      const edges: DagEdge[] = []
      const addEdge = (from: string, to: string): void => {
        // Unknown endpoint: the referenced peer is not in this section, so
        // there is no relation to record; a self-reference is likewise a no-op.
        if (!present.has(from) || !present.has(to) || from === to) return
        const key = `${from} -> ${to}`
        if (seen.has(key)) return
        seen.add(key)
        edges.push({ from, to })
      }
      for (const entry of section.entries) {
        for (const target of entry.before ?? []) addEdge(entry.name, target)
        for (const source of entry.after ?? []) addEdge(source, entry.name)
      }
      return {
        hook: section.hook,
        phase: section.phase,
        nodes: section.entries.map((entry) => entry.name),
        edges,
      }
    }),
  }
}
