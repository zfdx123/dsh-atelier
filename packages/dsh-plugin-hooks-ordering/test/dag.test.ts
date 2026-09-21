import { describe, expect, it } from 'vitest'
import { type DagSection, buildDag } from '../src/dag.ts'

/** Build one section from bare orderable entries (no `run` needed for the graph). */
function section(hook: string, phase: string, entries: DagSection['entries']): DagSection {
  return { hook, phase, entries }
}

describe('buildDag', () => {
  it('returns an empty graph for no sections', () => {
    expect(buildDag([])).toEqual({ sections: [] })
  })

  it('draws a `before` constraint as from -> to', () => {
    const dag = buildDag([section('h', 'front', [{ name: 'auth', before: ['logging'] }, { name: 'logging' }])])
    expect(dag.sections).toEqual([
      {
        hook: 'h',
        phase: 'front',
        nodes: ['auth', 'logging'],
        edges: [{ from: 'auth', to: 'logging' }],
      },
    ])
  })

  it('draws an `after` constraint reversed (source -> entry)', () => {
    const dag = buildDag([section('h', 'back', [{ name: 'metrics', after: ['auth'] }, { name: 'auth' }])])
    expect(dag.sections[0]!.edges).toEqual([{ from: 'auth', to: 'metrics' }])
  })

  it('keeps constraint-free entries as isolated nodes', () => {
    const dag = buildDag([section('h', 'front', [{ name: 'solo' }])])
    expect(dag.sections[0]).toEqual({ hook: 'h', phase: 'front', nodes: ['solo'], edges: [] })
  })

  it('ignores references to peers absent from the section', () => {
    const dag = buildDag([section('h', 'front', [{ name: 'a', before: ['ghost'], after: ['phantom'] }])])
    expect(dag.sections[0]!.edges).toEqual([])
    expect(dag.sections[0]!.nodes).toEqual(['a'])
  })

  it('ignores self-references', () => {
    const dag = buildDag([section('h', 'front', [{ name: 'a', before: ['a'] }])])
    expect(dag.sections[0]!.edges).toEqual([])
  })

  it('dedupes a relation stated from both ends', () => {
    const dag = buildDag([
      section('h', 'front', [
        { name: 'a', before: ['b'] },
        { name: 'b', after: ['a'] },
      ]),
    ])
    expect(dag.sections[0]!.edges).toEqual([{ from: 'a', to: 'b' }])
  })

  it('renders a cycle faithfully instead of throwing', () => {
    const dag = buildDag([
      section('h', 'front', [
        { name: 'a', before: ['b'] },
        { name: 'b', before: ['a'] },
      ]),
    ])
    expect(dag.sections[0]!.edges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ])
  })

  it('renders one subgraph per (hook, phase) with independent namespaces', () => {
    const dag = buildDag([
      section('hook/one', 'front', [{ name: 'x', before: ['y'] }, { name: 'y' }]),
      section('hook/one', 'back', [{ name: 'x' }]),
      section('hook/two', 'front', [{ name: 'z' }]),
    ])
    expect(dag.sections.map((s) => `${s.hook} ${s.phase}`)).toEqual([
      'hook/one front',
      'hook/one back',
      'hook/two front',
    ])
    // Same name `x` in two sections stays distinct (no cross-section edges).
    expect(dag.sections[1]!.edges).toEqual([])
  })

  it('produces JSON-serializable output', () => {
    const dag = buildDag([section('h', 'front', [{ name: 'a', before: ['b'] }, { name: 'b' }])])
    expect(() => JSON.stringify(dag)).not.toThrow()
    expect(JSON.parse(JSON.stringify(dag))).toEqual(dag)
  })
})
