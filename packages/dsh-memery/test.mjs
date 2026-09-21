/**
 * Test build: esbuild-compile test/*.test.ts into test-built/, then run.
 * src 源码保持 .js 后缀说明符（esbuild 可解析），测试编译后与 lib 一致。
 */
import { build } from 'esbuild'
import { rmSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'test-built')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const files = readdirSync(join(here, 'test')).filter((f) => f.endsWith('.test.ts'))
await Promise.all(
  files.map((f) =>
    build({
      entryPoints: [join(here, 'test', f)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: false,
      outdir: out,
      logLevel: 'error',
      // 测试从 src/ 相对导入：让 esbuild 解析 ./x.js -> ./x.ts
      resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
      external: ['node:sqlite'],
    }),
  ),
)

const compiled = readdirSync(out)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(out, f))
const r = spawnSync(process.execPath, ['--test', ...compiled], { stdio: 'inherit', cwd: here })
process.exit(r.status ?? 1)
