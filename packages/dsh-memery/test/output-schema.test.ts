// output schema 契约测试：execute 的每条返回路径（成功 + 错误）都必须被
// output.schema 接受 —— DSH 在 output 校验层用 additionalProperties:false
// 严格拒收未声明字段，schema 漏键会让工具「返回了但结果被拒」（真实踩坑：
// memory_project 漏声明 count 导致调用报 invalid output）。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAllDbs } from '../src/db.js'
import { rememberTool, searchTool, readTool, updateTool, deleteTool, projectTool } from '../src/tools.js'

const DIR = 'mem'
let dir: string
let ws: string

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'memery-schema-'))
  ws = join(dir, 'ws')
  // 全局库指向临时主目录，绝不碰真实用户 ~/.dsh-memery
  process.env.DSH_MEMERY_HOME = join(dir, 'home')
})
after(() => {
  closeAllDbs()
  delete process.env.DSH_MEMERY_HOME
  rmSync(dir, { recursive: true, force: true })
})

const exec = (cwd: string) => ({ agent: { session: { header: { cwd } } } })

/** 极简 JSON Schema 校验：对象属性白名单 + 类型。 */
function schemaAccepts(schema: Record<string, any>, value: unknown, path = ''): string[] {
  const errors: string[] = []
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>
    const keys = Object.keys(v)
    if (schema.additionalProperties === false) {
      for (const k of keys) {
        if (!(k in (schema.properties ?? {}))) errors.push(`${path}.${k} 未在 schema 声明`)
      }
    }
    for (const [k, subschema] of Object.entries((schema.properties ?? {}) as Record<string, any>)) {
      if (k in v) {
        const sub = subschema as Record<string, any>
        if (sub.type === 'array') {
          if (!Array.isArray(v[k])) errors.push(`${path}.${k} 应为 array`)
        } else if (sub.type === 'object') {
          errors.push(...schemaAccepts(sub, v[k], `${path}.${k}`))
        }
      }
    }
    return errors
  }
  return errors
}

describe('工具 output schema 覆盖全部返回路径', () => {
  it('memory_remember 的错误分支（缺 content/project）与成功分支都通过', async () => {
    const t = rememberTool({ dir: DIR })
    const bad1 = await t.execute({ content: 'x', project: '' }, exec(ws) as never)
    const bad2 = await t.execute({ content: '', project: 'p' }, exec(ws) as never)
    const good = await t.execute({ content: 'schema 测试记忆', project: 'p', keywords: ['schema'] }, exec(ws) as never)
    for (const [label, value] of [
      ['bad1', bad1],
      ['bad2', bad2],
      ['good', good],
    ] as const) {
      const schema = (t as unknown as { output: { schema: Record<string, any> } }).output.schema
      const errs = schemaAccepts(schema, value)
      assert.deepEqual(errs, [], `${label} 返回值不满足 output schema：${errs.join('; ')}`)
    }
  })

  it('memory_search 成功分支通过（含 error+results 的错误形态）', async () => {
    const t = searchTool({ dir: DIR })
    const good = await t.execute({ query: 'schema' }, exec(ws) as never)
    const schema = (t as unknown as { output: { schema: Record<string, any> } }).output.schema
    assert.deepEqual(schemaAccepts(schema, good), [])
  })

  it('memory_read：未找到 → error 分支通过', async () => {
    const t = readTool({ dir: DIR })
    const missing = await t.execute({ id: 'nope' }, exec(ws) as never)
    const schema = (t as unknown as { output: { schema: Record<string, any> } }).output.schema
    assert.deepEqual(schemaAccepts(schema, missing), [], 'error 分支必须被 schema 接受')
  })

  it('memory_delete：删除成功与未找到分支都通过', async () => {
    const created = await rememberTool({ dir: DIR }).execute(
      { content: '待删', project: 'p', keywords: ['x'] },
      exec(ws) as never,
    )
    const t = deleteTool({ dir: DIR })
    const schema = (t as unknown as { output: { schema: Record<string, any> } }).output.schema
    const ok = await t.execute({ id: (created as { id: string }).id }, exec(ws) as never)
    assert.deepEqual(schemaAccepts(schema, ok), [])
    const missing = await t.execute({ id: (created as { id: string }).id }, exec(ws) as never)
    assert.deepEqual(schemaAccepts(schema, missing), [], '未找到分支返回 error 必须通过')
  })

  it('★ memory_project 成功分支含 count 必须通过（复现真实故障）', async () => {
    await rememberTool({ dir: DIR }).execute(
      {
        content: 'esbuild 双产物',
        project: 'd',
        keywords: ['esbuild'],
        level: 'project' as never,
        subcategory: 'decisions' as never,
      },
      exec(ws) as never,
    )
    const t = projectTool({ dir: DIR })
    const good = await t.execute({ project: 'd' }, exec(ws) as never)
    const schema = (t as unknown as { output: { schema: Record<string, any> } }).output.schema
    assert.ok('count' in (good as Record<string, unknown>), 'execute 返回了 count')
    assert.deepEqual(schemaAccepts(schema, good), [], 'count 未声明 → 真实故障复现')
    // 错误分支
    const missing = await t.execute({ project: 'zzz-not-exist' }, exec(ws) as never)
    assert.deepEqual(schemaAccepts(schema, missing), [])
  })
})
