/**
 * 打包契约测试：**包名三处必须完全一致**，否则宿主装载客户端 bundle 时会报
 * `bundle … loaded without registering "<id>" via __ModuleLoader__.load`。
 *
 * 这三处是：
 *   1. package.json 的 name；
 *   2. cordis.patch.yml 里插入行的 name（宿主按它解析 bundle 包）；
 *   3. lib/client.js 开头 `__ModuleLoader__.load({ id })`（浏览器侧注册 id）。
 *
 * 真实现场（改包名漏改其一）：把包从 dsh-memery 改成 @zfdx123/dsh-memery 时，
 * 只改 package.json 而漏改 build.mjs 的 banner，web 启动即白屏报错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

test('包名：package.json / cordis.patch.yml / client bundle 三者一致', () => {
  const pkg = JSON.parse(read('package.json')) as { name: string; dsh?: { bundle?: { patch?: string } } }

  // 1) 包名必须是 scoped 形式（与同仓其它插件一致），且 patch 已声明
  assert.match(pkg.name, /^@[a-z0-9-]+\/dsh-memery$/, `包名应为 @scope/dsh-memery，实际 ${pkg.name}`)
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch 必须指向 cordis.patch.yml')

  // 2) cordis.patch.yml 的插入行 name
  const patch = read('cordis.patch.yml')
  const patchName = /^\s*name:\s*'?([^'\s]+)'?\s*$/m.exec(patch)?.[1]
  assert.equal(patchName, pkg.name, `cordis.patch.yml 的 name 必须等于包名，实际 ${String(patchName)}`)

  // 3) 构建产物里的注册 id（lib/client.js 由 build.mjs 注入 banner）
  const client = read('lib/client.js')
  const bannerId = /__ModuleLoader__\.load\(\{\s*\n\s*id:\s*"([^"]+)"/.exec(client)?.[1]
  assert.equal(bannerId, pkg.name, `lib/client.js 的注册 id 必须等于包名，实际 ${String(bannerId)}`)

  // 4) 宿主入口的导出 name 与包名解耦：保持短名（同仓其它插件的约定），
  //    改了它没有任何收益，却可能影响日志/诊断里的插件身份。
  const host = read('lib/index.js')
  assert.match(host, /var name = "dsh-memery"/, '宿主入口导出的 name 应保持短名 dsh-memery')
})

/**
 * host bundle 必须自包含。`@deepseek-ai/dsh-llm` 是**宿主的**框架：external 出去由
 * 运行时提供宿主那一份；内联（旧配置）会把 dsh-llm 自己的
 * `createRequire(import.meta.url)("../package.json")` 一起烤进 lib/index.js ——
 * 那是在 lib/ 之外读文件，装到别处就可能不存在，而且把框架版本冻结进了产物
 * （曾经冻在 0.1.1-rc.2，与装着的 DSH 悄悄漂移）。
 */
test('host bundle 不内联 dsh-llm：无 createRequire(../package.json) 残留', () => {
  const host = read('lib/index.js')

  assert.ok(
    /^import .* from "@deepseek-ai\/dsh-llm";$/m.test(host),
    'dsh-llm 必须是 external 的 import（build.mjs 的 host external）',
  )
  assert.equal(host.includes('createRequire'), false, 'host bundle 不该出现 createRequire')
  assert.equal(host.includes('../package.json'), false, 'host bundle 不该读 lib/ 之外的 package.json')
})

/**
 * 原生 UI 组件库的声明契约。客户端 bundle 里 require 的
 * `@deepseek-ai/dsh-client-ui-primitives` 是 DSH 前端的平台模块表（静态表）
 * 名字，三处必须一致，否则要么构建期解析失败、要么运行期 require 抛错：
 *   1. build.mjs 的客户端 external（构建期不解析、原样保留 require）；
 *   2. package.json 的 dsh.client.external（宿主声明该请求，静态表名字不产生图边）；
 *   3. lib/client.js 里实际 require 的 id（运行时按它查表）。
 */
test('原生 UI 组件库：build.mjs / package.json / bundle 三处一致', () => {
  const KIT = '@deepseek-ai/dsh-client-ui-primitives'
  const pkg = JSON.parse(read('package.json')) as { dsh?: { client?: { external?: string[] } } }

  assert.ok((pkg.dsh?.client?.external ?? []).includes(KIT), `package.json 的 dsh.client.external 必须声明 ${KIT}`)
  assert.ok(read('build.mjs').includes(`'${KIT}'`), `build.mjs 客户端 external 必须包含 ${KIT}`)
  assert.ok(read('lib/client.js').includes(KIT), `lib/client.js 必须 require ${KIT}`)
})
