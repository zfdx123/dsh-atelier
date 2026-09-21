import { describe, expect, it } from 'vitest'
import { DuplicateNameError, type Orderable, OrderingCycleError, topoSort } from '../src/topo-sort.ts'

const names = (entries: Orderable[]): string[] => topoSort(entries).map((e) => e.name)

describe('topoSort', () => {
  it('keeps input order when there are no constraints (stable)', () => {
    expect(names([{ name: 'a' }, { name: 'b' }, { name: 'c' }])).toEqual(['a', 'b', 'c'])
  })

  it('honors after: an entry runs behind its target', () => {
    expect(names([{ name: 'b', after: ['a'] }, { name: 'a' }])).toEqual(['a', 'b'])
  })

  it('honors before: an entry runs ahead of its target', () => {
    expect(names([{ name: 'a' }, { name: 'z', before: ['a'] }])).toEqual(['z', 'a'])
  })

  it('resolves a chain declared out of order', () => {
    const entries: Orderable[] = [{ name: 'c', after: ['b'] }, { name: 'a' }, { name: 'b', after: ['a'] }]
    expect(names(entries)).toEqual(['a', 'b', 'c'])
  })

  it('combines before and after into one total order', () => {
    const entries: Orderable[] = [{ name: 'mid' }, { name: 'last', after: ['mid'] }, { name: 'first', before: ['mid'] }]
    expect(names(entries)).toEqual(['first', 'mid', 'last'])
  })

  it('treats an unknown before/after target as a no-op', () => {
    // vendorB wants to run after an optional vendorA that is not loaded.
    expect(names([{ name: 'vendorB', after: ['vendorA'] }, { name: 'other' }])).toEqual(['vendorB', 'other'])
  })

  it('ignores a self-reference', () => {
    expect(names([{ name: 'a', after: ['a'], before: ['a'] }, { name: 'b' }])).toEqual(['a', 'b'])
  })

  it('breaks ties by input position deterministically', () => {
    const entries: Orderable[] = [{ name: 'x', after: ['root'] }, { name: 'y', after: ['root'] }, { name: 'root' }]
    // root first; x and y are both freed together and emit in input order.
    expect(names(entries)).toEqual(['root', 'x', 'y'])
  })

  it('throws on a duplicate name', () => {
    expect(() => topoSort([{ name: 'a' }, { name: 'a' }])).toThrow(DuplicateNameError)
  })

  it('throws on a direct cycle and names the blocked entries', () => {
    let error: unknown
    try {
      topoSort([
        { name: 'a', after: ['b'] },
        { name: 'b', after: ['a'] },
      ])
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(OrderingCycleError)
    expect(new Set((error as OrderingCycleError).cycle)).toEqual(new Set(['a', 'b']))
  })

  it('throws on a longer cycle', () => {
    const entries: Orderable[] = [
      { name: 'a', before: ['b'] },
      { name: 'b', before: ['c'] },
      { name: 'c', before: ['a'] },
    ]
    expect(() => topoSort(entries)).toThrow(OrderingCycleError)
  })

  it('names only the blocked entries, not acyclic ones that resolved', () => {
    // `free` resolves and is emitted; only the a<->b cycle remains blocked.
    const entries: Orderable[] = [{ name: 'free' }, { name: 'a', after: ['b'] }, { name: 'b', after: ['a'] }]
    let error: unknown
    try {
      topoSort(entries)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(OrderingCycleError)
    expect(new Set((error as OrderingCycleError).cycle)).toEqual(new Set(['a', 'b']))
  })

  it('inserts a freed lower-index node ahead of a queued higher-index node', () => {
    // `root` (index 2) frees both `hi` (index 1) and `lo` (index 0); they must
    // still emit in input order, forcing an insert-before in the ready queue.
    const entries: Orderable[] = [{ name: 'lo', after: ['root'] }, { name: 'hi', after: ['root'] }, { name: 'root' }]
    expect(names(entries)).toEqual(['root', 'lo', 'hi'])
  })

  it('does not mutate its input', () => {
    const entries: Orderable[] = [{ name: 'b', after: ['a'] }, { name: 'a' }]
    const snapshot = [...entries]
    topoSort(entries)
    expect(entries).toEqual(snapshot)
  })
})
