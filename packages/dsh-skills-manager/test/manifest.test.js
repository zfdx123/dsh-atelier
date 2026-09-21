// 依赖清单自检：锁文件必须记录 package.json 的每一个**运行时**依赖。
//
// 回归背景：node_modules 里曾经留着 npm 的隐藏锁文件（`node_modules/.package-lock.json`
// —— npm 自己写的安装缓存，pnpm 既不读也不更新），内容停留在「加 schemastery 之前」的
// 依赖树。它不会让任何断言变红，只会让下一个照它重装的人装出一个
// `import '@deepseek-ai/schemastery'` 直接失败的 node_modules（lib/schema.js 在模块
// 加载期就 import，失败表现为插件整个不加载）。所以把「记录了什么」钉在这里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 读 JSON 文件；不存在时返回 null（缺文件本身是「没记录」的一种状态，交给断言处理）。 */
async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('pnpm-lock.yaml 记录了 package.json 的每一个运行时依赖', async () => {
  const pkg = await readJsonIfPresent(join(ROOT, 'package.json'))
  const lock = await readFile(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
  const importer = lock.slice(lock.indexOf('\n  .:\n'), lock.indexOf('\npackages:'))
  assert.equal(importer.includes('dependencies:'), true, '锁文件的 importer 段必须存在')

  for (const name of Object.keys(pkg.dependencies ?? {})) {
    // importer 段：这个依赖被声明进本包的依赖树（specifier + 解析到的版本）。
    assert.equal(importer.includes(`'${name}':`), true, `pnpm-lock.yaml 的 importer 段缺少运行时依赖 ${name}`)
    // packages / snapshots 段：解析到的具体版本（否则重装时装不出确定版本）。
    assert.match(lock, new RegExp(`^\\s+'${escapeRegExp(name)}@`, 'm'), `pnpm-lock.yaml 没有 ${name} 的解析结果`)
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
