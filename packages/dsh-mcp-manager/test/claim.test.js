// `claimEntry` 的回归：设置条的 ns 是 loader 条目 id，而那个 id 由挂载本插件的
// 那一行决定，还会被 `include` 分组加上前缀。把它当键的后果是宿主拒绝写入：
//
//   No configurable plugin entry "include:dsh-mcp-manager"
//
// 所以改成按值形状认领。这里用**线上宿主真实返回**的条目形状做断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimEntry, declaredKeys } from '../lib/claim.js'
import { ServersSchema } from '../lib/logic.js'

const DECLARED = declaredKeys(ServersSchema)

/** 线上宿主 21 个条目的值形状（节选，含全部与本插件可能混淆的近邻）。 */
const liveShapedList = () => [
  { ns: 'agent-default-model', value: { provider: 'deepseek-official', model: 'f', reasoningEffort: 'max' } },
  { ns: 'llm-pi-ai', value: { providers: {} } },
  { ns: 'pwsh-sandbox', value: { timeoutMs: 1, maxTimeoutMs: 2, maxOutputBytes: 3, maxSpillBytes: 4, graceMs: 5 } },
  { ns: 'subagent', value: { maxDepth: 1, maxActiveSubagents: 2 } },
  { ns: 'ui-theme', value: { preference: 'light', fontSize: 14 } },
  { ns: 'ui-settings', value: { enabled: true } },
  { ns: 'dsh-plugin-hooks-ordering', value: { hooks: [], serialHooks: [], log: '' } },
  { ns: 'dsh-skills-manager', value: { customSkillDirs: [], deepSkillDirs: [], projects: [] } },
  { ns: 'include:dsh-mcp-manager', value: { servers: [] } },
]

test('declaredKeys 取自 Config 的 dict（加字段不会忘同步）', () => {
  assert.deepEqual([...DECLARED].sort(), ['entryId', 'servers'])
})

test('claimEntry 认出 include 前缀挂载的条目', () => {
  assert.equal(claimEntry(liveShapedList(), DECLARED)?.ns, 'include:dsh-mcp-manager')
})

test('claimEntry 认出根下挂载的条目', () => {
  const list = [{ ns: 'ui-theme', value: { preference: 'light' } }, { ns: 'dsh-mcp-manager', value: { servers: [] } }]
  assert.equal(claimEntry(list, DECLARED)?.ns, 'dsh-mcp-manager')
})

test('claimEntry 在有服务器的真实配置下同样认得出', () => {
  const list = [
    { ns: 'ui-theme', value: { preference: 'light' } },
    {
      ns: 'include:dsh-mcp-manager',
      value: { servers: [{ name: 'fs', transport: 'stdio', command: 'node', enabled: true }] },
    },
  ]
  assert.equal(claimEntry(list, DECLARED)?.ns, 'include:dsh-mcp-manager')
})

test('claimEntry 拒绝认不出与有歧义的输入，绝不赌一个名字写上去', () => {
  // 空列表 / 非数组
  assert.equal(claimEntry([], DECLARED), undefined)
  assert.equal(claimEntry(undefined, DECLARED), undefined)
  assert.equal(claimEntry(liveShapedList(), undefined), undefined)
  assert.equal(claimEntry(liveShapedList(), new Set()), undefined)
  // 没有任何条目像自己的
  assert.equal(claimEntry([{ ns: 'ui-theme', value: { preference: 'light' } }], DECLARED), undefined)
  // 空对象不能匹配任何 schema
  assert.equal(claimEntry([{ ns: 'empty', value: {} }], DECLARED), undefined)
  // 键不属于本插件
  assert.equal(claimEntry([{ ns: 'x', value: { notMine: 1 } }], DECLARED), undefined)
  // 非对象值
  assert.equal(claimEntry([{ ns: 'x', value: 'servers' }], DECLARED), undefined)
  assert.equal(claimEntry([{ ns: 'x', value: null }], DECLARED), undefined)
  // 两个候选 = 歧义
  assert.equal(
    claimEntry(
      [
        { ns: 'a', value: { servers: [] } },
        { ns: 'b', value: { servers: [] } },
      ],
      DECLARED,
    ),
    undefined,
  )
})

test('claimEntry 不会把 skills-manager 的条目误当自己的', () => {
  const list = [{ ns: 'include:dsh-skills-manager', value: { customSkillDirs: [] } }]
  assert.equal(claimEntry(list, DECLARED), undefined)
})
