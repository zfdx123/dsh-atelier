// test/pack.test.js — 打包契约：三处 id 必须一致，manifest 必须完整。
//
// 「三处一致」是 DSH 客户端 bundle 的硬性要求（见 dsh-mcp-manager 的 README）：
// package.json 的 name、cordis.patch.yml 的行 name、client.js 里
// __ModuleLoader__.load 的 id，任一不符都会在挂载阶段抛
// `bundle ... loaded without registering "<id>"`，面板永远不出现。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const PKG = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

describe('package manifest', () => {
  it('声明 dsh.bundle.patch 与 dsh.client', () => {
    assert.equal(PKG.name, 'dsh-memery')
    assert.equal(PKG.dsh?.bundle?.patch, './cordis.patch.yml')
    assert.equal(PKG.dsh?.client?.platform, 'web')
    assert.deepEqual(PKG.dsh?.client?.inject, [
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-ui-settings',
    ])
  })

  it('cordis.patch.yml 的行 name 等于包名', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    assert.match(patch, /name:\s*dsh-memery/)
  })

  it('client.js 的 __ModuleLoader__ id 等于包名', async () => {
    const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(client, new RegExp(`id:\\s*'${PKG.name}'`))
  })
})
