/**
 * Build script: TS source -> deployable package.
 *
 * Two artifacts:
 *  - lib/index.js — host loader entry (exports["."] / main), loaded by the
 *    dsh Node process.
 *  - lib/client.js — browser bundle in ModuleLoader.load format (the web
 *    shell's client module loader; see @deepseek-ai/dsh-client-modules).
 *
 * Everything is bundled (esbuild) so the plugin is self-contained. The
 * @deepseek-ai/* packages are resolved from the DSH profile's node_modules
 * at build time via nodePaths and bundled in; react stays external on the
 * client side (shell singleton, ModuleLoader resolves it).
 */
import { build, context } from 'esbuild'
import { cpSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

// Resolve @deepseek-ai/* from candidate DSH profile installs.
function findNodePaths() {
  const candidates = [
    process.env.DSH_PROFILE_NODE_MODULES,
    join(process.env.HOME ?? '', '.dsh', 'profiles', 'web', 'node_modules'),
    join(process.env.HOME ?? '', '.dsh', 'profiles', 'node_modules'),
    join(here, '..', '..', '..', '..', '..', '..', 'profiles', 'node_modules'), // sibling of the global dsh install
  ].filter(Boolean)
  for (const p of candidates) {
    if (p && existsSync(join(p, '@deepseek-ai', 'dsh-llm'))) return [p]
  }
  // Fall back: plugin-local node_modules (devDeps installed here).
  const local = join(here, 'node_modules')
  return existsSync(join(local, '@deepseek-ai', 'dsh-llm')) ? [local] : []
}

const nodePaths = findNodePaths()
if (nodePaths.length === 0) {
  console.warn('[build] 未找到 @deepseek-ai/dsh-llm 的解析路径；host bundle 将失败。')
}

const hostOptions = {
  entryPoints: [join(here, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  nodePaths,
  // @deepseek-ai/* is the HOST's framework, not ours: leave it to the runtime so
  // the plugin always shares the host's copy. Bundling it in (the old behaviour)
  // froze dsh-llm 0.1.1-rc.2 inside lib/index.js and silently drifted from the
  // installed DSH — see package.json peerDependencies.
  external: ['node:sqlite', '@deepseek-ai/dsh-llm'],
  outfile: join(here, 'lib', 'index.js'),
  sourcemap: true,
  logLevel: 'info',
}

const clientOptions = {
  entryPoints: [join(here, 'src', 'client.ts')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  nodePaths: [], // client 端不 import @deepseek-ai/*，只 import react（external）
  // 原生 UI 组件库来自宿主前端的平台模块表（静态表名字），运行期由
  // ModuleLoader 的 require 解析；这里 external 化保证构建期不去解析它。
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives'],
  outfile: join(here, 'lib', 'client.js'),
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      '  id: "@zfdx123/dsh-memery",',
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: ['    return module.exports;', '  }', '});'].join('\n'),
  },
  sourcemap: true,
  logLevel: 'info',
}

if (watch) {
  await (await context(hostOptions)).watch()
  await (await context(clientOptions)).watch()
  console.log('[build] watching src/ for changes...')
} else {
  await Promise.all([build(hostOptions), build(clientOptions)])
  console.log('[build] done: lib/index.js + lib/client.js')
}
