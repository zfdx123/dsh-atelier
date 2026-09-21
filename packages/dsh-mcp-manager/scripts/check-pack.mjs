// 发布前打包校验：`npm pack --json --dry-run` 检查 tarball 内容。
// - 关键文件必须存在（lib/logic.js 等容易漏进 files 白名单）
// - 测试/夹具/CI 等目录不得泄漏进包
// 本地 npm publish 由 prepublishOnly 触发，CI 也在 pack job 里跑一遍。

import { execFileSync } from 'node:child_process'

const REQUIRED = [
  'package.json',
  'index.js',
  'client.js',
  'lib/logic.js',
  'lib/api.js',
  'lib/tls.js',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
]

// 测试证书是本地测试夹具，绝不该随包发布。
const FORBIDDEN_PREFIXES = ['test/', 'fixtures/', '.compat/', 'scripts/', '.github/']

// 调 npm 的方式：Windows 上 `execFileSync('npm', …)` 找不到 npm.cmd（Node 不会
// 隐式补 .cmd，也从不在没有 shell 的情况下执行 .cmd/.bat）。优先用 npm 自己注入的
// npm_execpath（经 `npm run` 调用时必然存在）配当前 Node 直接执行，跨平台且不过 shell。
const npmCli = process.env.npm_execpath
const useNpmCli = typeof npmCli === 'string' && npmCli !== ''
const npmCommand = useNpmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmArgs = [...(useNpmCli ? [npmCli] : []), 'pack', '--json', '--dry-run']

let manifests
try {
  const stdout = execFileSync(npmCommand, npmArgs, {
    encoding: 'utf8',
    shell: !useNpmCli && process.platform === 'win32',
  })
  manifests = JSON.parse(stdout)
} catch (error) {
  console.error('npm pack --dry-run 失败：', String(error))
  process.exit(1)
}
const manifest = manifests[0]
if (!manifest || !Array.isArray(manifest.files)) {
  console.error('npm pack 输出异常：', JSON.stringify(manifest))
  process.exit(1)
}

const paths = manifest.files.map((file) => file.path)
const missing = REQUIRED.filter((path) => !paths.includes(path))
if (missing.length > 0) {
  console.error(`缺少必需文件（检查 package.json 的 files 白名单）：${missing.join(', ')}`)
  process.exit(1)
}

const leaked = paths.filter((path) => FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)))
if (leaked.length > 0) {
  console.error(`不应打包的路径泄漏进包：${leaked.join(', ')}`)
  process.exit(1)
}

console.log(`pack 校验通过：共 ${paths.length} 个文件，必需文件齐全，未泄漏测试/夹具/CI 内容。`)
