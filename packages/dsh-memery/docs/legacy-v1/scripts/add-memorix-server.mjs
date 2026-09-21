// scripts/add-memorix-server.mjs — 把 memorix MCP 服务器合并进 $DSH_HOME/settings.yaml。
//
// 用真正的 YAML 解析器改，不用正则：settings.yaml 是 DSH 的权威配置，手写
// 正则很容易在缩进或注解上出错。
//
// 幂等：已存在同名 serverName 时只更新其字段，不重复追加。
// 默认只预览（--dry）；加 --write 才落盘。
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// `yaml` 不是本包的依赖：它是 DSH 自身带的（profile 的 node_modules 里一定有）。
// 从候选路径里逐个解析，避免为一个一次性脚本给插件引入运行时依赖。
function loadYaml() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const candidates = [
    'yaml',
    join(home, 'profiles', 'web', 'node_modules', 'yaml'),
    join(home, 'profiles', 'node_modules', 'yaml'),
  ]
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      // 试下一个
    }
  }
  console.error('✗ 找不到 yaml 模块。请在有 DSH 的机器上运行，或先 npm i -D yaml。')
  process.exit(1)
}

const YAML = loadYaml()

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const target = join(home, 'settings.yaml')
const doWrite = process.argv.includes('--write')

const MEMORIX = {
  serverName: 'memorix',
  enabled: true,
  transport: 'streamable-http',
  command: '',
  args: [],
  env: {},
  cwd: '',
  url: 'http://127.0.0.1:3211/mcp',
  headers: {},
  toolCallTimeoutMs: 60000,
  failOnStartupError: false,
  tlsInsecure: false,
  tlsCaFile: '',
  reconnectEnabled: true,
  reconnectMaxAttempts: 10,
}

const text = await readFile(target, 'utf8')
const doc = YAML.parseDocument(text)

const servers = doc.getIn(['mcp', 'servers'])
if (servers === undefined || servers === null) {
  console.error(`✗ 没找到 mcp.servers 节点，拒绝改写：${target}`)
  process.exit(1)
}
if (!YAML.isSeq(servers)) {
  console.error('✗ mcp.servers 不是列表，拒绝改写')
  process.exit(1)
}

const existingIndex = servers.items.findIndex(
  (item) => YAML.isMap(item) && item.get('serverName') === MEMORIX.serverName,
)

if (existingIndex >= 0) {
  servers.items[existingIndex] = doc.createNode(MEMORIX)
  console.log(`~ 已存在 serverName=memorix，更新其字段（索引 ${existingIndex}）`)
} else {
  servers.add(doc.createNode(MEMORIX))
  console.log('+ 追加 serverName=memorix')
}

const output = doc.toString()
console.log('---- 预览 ----')
console.log(output)

if (doWrite) {
  const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  await copyFile(target, backup)
  await writeFile(target, output, 'utf8')
  console.log(`✓ 已写入 ${target}（备份 ${backup}）`)
} else {
  console.log('（未写入。加 --write 落盘）')
}
