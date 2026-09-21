// 依赖清单自检：锁文件必须记录 package.json 的每一个**运行时**依赖。
//
// 回归背景：node_modules 里曾经留着 npm 的隐藏锁文件（`node_modules/.package-lock.json`
// —— npm 自己写的安装缓存，pnpm 既不读也不更新），内容停留在「加 schemastery 之前」的
// 依赖树。它不会让任何断言变红，只会让下一个照它重装的人装出一个
// `import '@deepseek-ai/schemastery'` 直接失败的 node_modules（lib/schema.js 在模块
// 加载期就 import，失败表现为插件整个不加载）。所以把「记录了什么」钉在这里。
//
// 这里只断言**语义**——这个运行时依赖到底有没有被锁住——不断言 pnpm 的排版。
// 锁文件版本、段名、缩进、引号风格、行尾在 pnpm 各大版本之间都会变，「锁住了没有」
// 不会变。踩过的坑：`lock.indexOf('\n  .:\n')` 这种按字节切段的写法，在 CRLF 检出
// （Windows 上 core.autocrlf=true 的工作区）下会把整段切成空串，于是报出
// 「importer 段必须存在」——锁文件本身完全正确，红的是解析方式。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath 而不是 URL.pathname：后者是百分号编码的（检出路径里带空格或非 ASCII
// 就读到别的文件上），而且在 Windows 上会多一个前导斜杠（`/E:/...`）。
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 读 JSON 文件；不存在时返回 null（缺文件本身是「没记录」的一种状态，交给断言处理）。 */
async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * 把锁文件读成两张表，而不是读成一段文本：
 *   declared —— 根项目声明进自己依赖树的包名（v9 的 `importers:` → `.` → `dependencies:`，
 *               更老的格式直接是顶层 `dependencies:`）
 *   resolved —— 锁里真的给出了解析结果的包名（`packages:` / `snapshots:` 的 `名字@版本` 键）
 *
 * 只按「行 + 缩进层级」读，不写死段名顺序、缩进宽度或引号风格，所以 pnpm 换排版不影响结论：
 * 行尾先归一成 LF（CRLF 检出照吃），子键取「父键下面第一个更深的层级」而不是固定空格数。
 * @param {string} text 锁文件内容
 * @returns {{declared: Set<string>, resolved: Set<string>}}
 */
function readLockfile(text) {
  // 收集所有「键」行：`foo:` / `'foo':` / `"foo": 1.2.3` 都算，值是什么不关心。
  const rows = []
  for (const [index, line] of text.replace(/\r\n?/g, '\n').split('\n').entries()) {
    const match = /^(\s*)(?:'([^']*)'|"([^"]*)"|([^:#]+?))\s*:(\s.*)?$/.exec(line)
    if (match === null) continue
    const name = (match[2] ?? match[3] ?? match[4] ?? '').trim()
    if (name !== '') rows.push({ index, indent: match[1].length, name })
  }

  /** 某个键（第 index 行）下面、更深一层的直接子键。 */
  const childrenOf = (index) => {
    const parent = rows.find((row) => row.index === index)
    const children = []
    let indent = null
    for (const row of rows) {
      if (row.index <= index) continue
      if (row.indent <= parent.indent) break
      if (indent === null) indent = row.indent
      if (row.indent === indent) children.push(row)
    }
    return children
  }

  // 根 importer：v9 在 `importers:` 下写一条 `.`；v5/6 没有这个段，依赖直接挂顶层。
  const importers = rows.find((row) => row.indent === 0 && row.name === 'importers')
  const rootImporter = importers === undefined ? undefined : childrenOf(importers.index).find((row) => row.name === '.')

  const declared = new Set()
  const blocks = [
    rootImporter === undefined ? undefined : childrenOf(rootImporter.index).find((row) => row.name === 'dependencies'),
    rows.find((row) => row.indent === 0 && row.name === 'dependencies'),
  ]
  for (const block of blocks) {
    if (block === undefined) continue
    for (const child of childrenOf(block.index)) declared.add(child.name)
  }

  // 解析结果的键形如 `name@version` / `/name@version`；带 peer 后缀的 `name@version(...)` 取到名字即可。
  const resolved = new Set()
  for (const row of rows) {
    const match = /^\/?((?:@[^/]+\/)?[^@/]+)@/.exec(row.name)
    if (match !== null) resolved.add(match[1])
  }

  return { declared, resolved }
}

test('pnpm-lock.yaml 记录了 package.json 的每一个运行时依赖', async () => {
  const pkg = await readJsonIfPresent(join(ROOT, 'package.json'))
  const { declared, resolved } = readLockfile(await readFile(join(ROOT, 'pnpm-lock.yaml'), 'utf8'))
  assert.equal(declared.size > 0, true, '锁文件的 importer 段必须存在')

  for (const name of Object.keys(pkg.dependencies ?? {})) {
    // importer 段：这个依赖被声明进本包的依赖树。
    assert.equal(declared.has(name), true, `pnpm-lock.yaml 的 importer 段缺少运行时依赖 ${name}`)
    // packages / snapshots 段：解析到的具体版本（否则重装时装不出确定版本）。
    assert.equal(resolved.has(name), true, `pnpm-lock.yaml 没有 ${name} 的解析结果`)
  }
})

test('node_modules 里的 npm 隐藏锁文件不得与 package.json 矛盾', async () => {
  const hidden = await readJsonIfPresent(join(ROOT, 'node_modules', '.package-lock.json'))
  if (hidden === null) return // 本仓库用 pnpm：这个文件本来就不该存在。
  const pkg = await readJsonIfPresent(join(ROOT, 'package.json'))
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    assert.equal(
      Object.hasOwn(hidden.packages ?? {}, `node_modules/${name}`),
      true,
      `node_modules/.package-lock.json 是 npm 的陈旧安装缓存，漏掉了运行时依赖 ${name}——删掉它并重跑 pnpm install`,
    )
  }
})
