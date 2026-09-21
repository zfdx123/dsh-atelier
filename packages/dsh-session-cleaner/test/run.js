// Standalone runner for the shared host cases — plain assertions, no test
// framework, so it also works in environments where spawning child processes is
// restricted. `pnpm test` runs this after the node:test file.
//
// Run: node test/run.js
import assert from 'node:assert/strict'
import { cases as hostCases } from './cases.js'
import { clientCases } from './client-cases.js'

const cases = [...hostCases, ...clientCases]

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn(assert)
    console.log('ok -', name)
  } catch (error) {
    failed += 1
    console.error('FAIL -', name)
    console.error('   ', error?.message ?? error)
  }
}
console.log(failed === 0 ? `\nALL PASSED (${cases.length})` : `\n${failed} FAILED of ${cases.length}`)
process.exitCode = failed === 0 ? 0 : 1
