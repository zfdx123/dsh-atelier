// node:test wrapper over the shared host cases, for `pnpm test` on a normal
// machine. (Some sandboxes refuse the child-process spawn node:test performs,
// which is why test/run.js carries the same cases with plain assertions.)
//
// Run: node --test test/host.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { cases } from './cases.js'

for (const [name, fn] of cases) {
  test(name, async () => {
    await fn(assert)
  })
}
