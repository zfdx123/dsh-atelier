// 递归发现（deep 扫描）的测试。
//
// 背景：用户把 `D:\FreeApp\skill\safe-test` 这类**仓库式技能库**加进来，只认出了顶层
// 5 个技能，而真正的技能在 `hack-skills/skills/<name>/SKILL.md` 这种第三层，共 102 个。
// 官方 provider 的「只认一层」语义没错，但用户自己的技能库常常是分支式的。
// 这里钉死递归扫描的行为边界。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { DEEP_SCAN_MAX_DEPTH, resolveRoots, scanRoot } from '../lib/roots.js'
import { buildContext, listSkills } from '../lib/store.js'

let sandbox
let collection
let project

/** 写一个技能包。 */
async function writeSkill(dir, name) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: skill ${name}\n---\n\nbody of ${name}\n`)
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'deepscan-'))
  project = join(sandbox, 'proj')
  await mkdir(join(project, '.git'), { recursive: true })
  collection = join(sandbox, 'collection')

  // 复刻真实布局：
  //   collection/
  //     top-skill/SKILL.md                    ← 深度 1，一层扫描就能看到
  //     flat.md                                ← 深度 1，单文件技能
  //     repo/skills/deep-a/SKILL.md            ← 深度 3，只有递归能看到
  //     repo/skills/deep-b/SKILL.md            ← 深度 3
  //     repo/README.md                         ← 顶层 md（一层扫描会当成技能，递归后不该再算）
  //     node_modules/pkg/SKILL.md              ← 递归必须跳过
  //     .hidden/SKILL.md                       ← 递归必须跳过
  //     with-resources/SKILL.md                ← 深度 1
  //     with-resources/references/nested/SKILL.md ← 命中父技能后不再下探，不该被发现
  //     too/deep/nested/skill/SKILL.md         ← 深度 4，超过上限
  await writeSkill(join(collection, 'top-skill'), 'top-skill')
  await writeFile(join(collection, 'flat.md'), '---\nname: flat\ndescription: flat one\n---\nbody\n')
  await writeSkill(join(collection, 'repo', 'skills', 'deep-a'), 'deep-a')
  await writeSkill(join(collection, 'repo', 'skills', 'deep-b'), 'deep-b')
  await writeFile(join(collection, 'repo', 'README.md'), 'just a readme\n')
  await writeSkill(join(collection, 'node_modules', 'pkg'), 'pkg')
  await writeSkill(join(collection, '.hidden'), 'hidden')
  await writeSkill(join(collection, 'with-resources'), 'with-resources')
  await writeSkill(join(collection, 'with-resources', 'references', 'nested'), 'nested')
  await writeSkill(join(collection, 'too', 'deep', 'nested', 'skill'), 'too-deep')
})

after(async () => {
  if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true })
})

test('一层扫描（默认）只看根目录的直接子项', async () => {
  const found = await scanRoot({ path: collection, source: 'custom', rank: 300 })
  const names = found.map((entry) => entry.name).sort()
  // 目录包：top-skill、with-resources，以及 node_modules / .hidden 里的（一层扫描
  // 不递归，所以它们作为"目录"被看到，但因为其自身不含 SKILL.md 而被忽略）。
  // 单文件技能：flat.md、repo/README.md → 后者在子目录里，一层扫描看不到。
  assert.deepEqual(names, ['flat', 'top-skill', 'with-resources'])
  assert.equal(
    found.every((entry) => !entry.path.includes('deep-a')),
    true,
  )
})

test('递归扫描能找到深层的 SKILL.md', async () => {
  const found = await scanRoot({ path: collection, source: 'custom', rank: 300, deep: true })
  const names = found.map((entry) => entry.name).sort()
  // deep-a / deep-b 在第三层，必须被找到。
  assert.equal(names.includes('deep-a'), true)
  assert.equal(names.includes('deep-b'), true)
  assert.equal(names.includes('top-skill'), true)
  assert.equal(names.includes('flat'), true)
  assert.equal(names.includes('with-resources'), true)
})

test('递归扫描跳过 node_modules 与点开头目录', async () => {
  const found = await scanRoot({ path: collection, source: 'custom', rank: 300, deep: true })
  const names = found.map((entry) => entry.name)
  assert.equal(names.includes('pkg'), false, 'node_modules 里的技能必须被跳过')
  assert.equal(names.includes('hidden'), false, '点开头目录里的技能必须被跳过')
})

test('命中技能后不再下探：其内部嵌套的 SKILL.md 属于资源', async () => {
  const found = await scanRoot({ path: collection, source: 'custom', rank: 300, deep: true })
  const names = found.map((entry) => entry.name)
  assert.equal(names.includes('with-resources'), true)
  // with-resources/references/nested/SKILL.md 属于 with-resources 的资源，不是独立技能
  assert.equal(names.includes('nested'), false)
})

test('递归深于上限的层级不再扫描', async () => {
  const found = await scanRoot({ path: collection, source: 'custom', rank: 300, deep: true })
  const names = found.map((entry) => entry.name)
  assert.equal(names.includes('too-deep'), false, `超过 ${DEEP_SCAN_MAX_DEPTH} 层的不应被发现`)
  assert.equal(DEEP_SCAN_MAX_DEPTH, 3)
})

test('递归扫描时子目录里的散装 md 不会被当成单文件技能', async () => {
  const found = await scanRoot({ path: collection, source: 'custom', rank: 300, deep: true })
  const paths = found.map((entry) => entry.path.replace(/\\/g, '/'))
  assert.equal(
    paths.some((path) => path.endsWith('/repo/README.md')),
    false,
  )
  // 但根目录里的 flat.md 仍然是技能
  assert.equal(
    found.some((entry) => entry.kind === 'flat' && entry.name === 'flat'),
    true,
  )
})

test('resolveRoots：deep 目录标记 deep，且与浅层列表互斥', () => {
  // 注意用 resolvePath 建 key：resolveRoots 会把 /a/shallow 这类绝对 POSIX 路径
  // 解析成带盘符的形式（Windows 上是 E:/a/shallow）。
  const shallowDir = join(sandbox, 'shallow')
  const bothDir = join(sandbox, 'both')
  const deepOnlyDir = join(sandbox, 'deep-only')
  const roots = resolveRoots({
    cwd: project,
    projectRoot: project,
    customSkillDirs: [shallowDir, bothDir],
    deepSkillDirs: [bothDir, deepOnlyDir],
  })
  const custom = roots.filter((root) => root.source === 'custom')
  const byPath = Object.fromEntries(custom.map((root) => [root.path, root.deep]))

  assert.equal(byPath[resolvePath(shallowDir)], false)
  assert.equal(byPath[resolvePath(deepOnlyDir)], true)
  // bothDir 同时出现在两个列表里 → 只保留 deep 一份，不能被扫两遍
  assert.equal(custom.filter((root) => root.path === resolvePath(bothDir)).length, 1)
  assert.equal(byPath[resolvePath(bothDir)], true)
  assert.equal(custom.length, 3)
  assert.equal(
    custom.every((root) => root.rank === 300),
    true,
  )
})

test('端到端：deep 根不产生重复条目（浅层与深层发现同一个技能只算一次）', async () => {
  // 回归：deep 扫描会从根目录再走一遍，浅层循环已经记过的技能必须去重。
  // 曾经因此把 5 个顶层技能各扫出两遍（112 条里 5 个重复）。
  const found = await scanRoot({ path: collection, source: 'custom', rank: 300, deep: true })
  const paths = found.map((entry) => entry.path.toLowerCase())
  assert.equal(new Set(paths).size, paths.length, '同一个 SKILL.md 只能出现一次')
  const names = found.map((entry) => entry.name)
  assert.equal(new Set(names).size, names.length, '名字也不该重复')
})

test('端到端：deep 根让深层技能进入快照并带上正确的层信息', async () => {
  const shallow = await buildContext({
    cwd: project,
    projects: [project],
    customSkillDirs: [collection],
    deepSkillDirs: [],
  })
  const shallowList = await listSkills(shallow)
  const shallowNames = shallowList.skills.map((skill) => skill.name)
  assert.equal(shallowNames.includes('deep-a'), false, '一层扫描不应看到深层技能')
  assert.equal(shallowNames.includes('top-skill'), true)

  const deep = await buildContext({
    cwd: project,
    projects: [project],
    customSkillDirs: [],
    deepSkillDirs: [collection],
  })
  const deepList = await listSkills(deep)
  const deepNames = deepList.skills.map((skill) => skill.name)
  assert.equal(deepNames.includes('deep-a'), true)
  assert.equal(deepNames.includes('deep-b'), true)
  assert.equal(deepNames.length > shallowNames.length, true, '递归后技能数必须增加')

  // 深层技能也要被判为健康、带上 custom/rank=300
  const deepA = deepList.skills.find((skill) => skill.name === 'deep-a')
  assert.equal(deepA.status, 'ok')
  assert.equal(deepA.source, 'custom')
  assert.equal(deepA.rank, 300)
  assert.equal(deepA.kind, 'bundle')
})
