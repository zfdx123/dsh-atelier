// 技能提供者契约测试。
//
// 这层解决的是最隐蔽的一类问题：面板里列出 107 个技能，DSH 却一个都不认识——
// 因为官方 provider 只扫**它自己配置里**的根，管理器面板添加的目录它根本不知道。
// 这些测试钉住提供者的形状，让「看得见」和「模型能用」不再脱节。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_NAME, createSkillProviderFactory } from '../lib/provider.js'

let sandbox
let project
let collection
let config

/** 写一个技能包（可选自定义 frontmatter）。 */
async function writeSkill(dir, name, extra = '') {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: description of ${name}\n${extra}---\n\n# ${name}\n\nbody of ${name}\n`,
  )
}

/** 用当前 config 建一个提供者。 */
function makeProvider(overrides = {}) {
  const factory = createSkillProviderFactory(() => ({ ...config, ...overrides }))
  return factory({ signal: new AbortController().signal, invalidate: () => {} })
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'provider-'))
  project = join(sandbox, 'proj')
  await mkdir(join(project, '.git'), { recursive: true })
  collection = join(sandbox, 'collection')

  await writeSkill(join(collection, 'alpha'), 'alpha')
  await writeSkill(join(collection, 'beta'), 'beta', 'whenToUse: when beta is needed\nmetadata:\n  owner: team\n')
  await writeSkill(join(collection, 'repo', 'skills', 'gamma'), 'gamma')
  // 会被过滤掉的：非法名字、缺 description
  await writeSkill(join(collection, 'BadName'), 'BadName')
  await mkdir(join(collection, 'no-desc'), { recursive: true })
  await writeFile(join(collection, 'no-desc', 'SKILL.md'), '---\nname: no-desc\n---\nbody\n')

  config = {
    cwd: project,
    projects: [project],
    customSkillDirs: [],
    deepSkillDirs: [collection],
    bundledSkillDir: '',
    inventory: true,
  }
})

after(async () => {
  if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true })
})

test('提供者名字不与官方 filesystem / 保留的 runtime 冲突', () => {
  assert.equal(PROVIDER_NAME, 'skills-manager')
  assert.notEqual(PROVIDER_NAME, 'filesystem')
  assert.notEqual(PROVIDER_NAME, 'runtime')
})

test('list() 返回候选，字段满足注册表契约', async () => {
  const provider = makeProvider()
  const candidates = await provider.list({ cwd: project })
  assert.equal(Array.isArray(candidates), true, '扫全时应返回数组（而不是 {candidates}）')

  const alpha = candidates.find((entry) => entry.name === 'alpha')
  assert.ok(alpha, 'alpha 应该在候选里')
  // 注册表要求的必填字段
  assert.equal(typeof alpha.description, 'string')
  assert.equal(alpha.provider, PROVIDER_NAME)
  assert.equal(typeof alpha.source, 'string')
  assert.equal(typeof alpha.rank, 'number')
  assert.equal(typeof alpha.invocation.modelInvocable, 'boolean')
  assert.equal(typeof alpha.invocation.userInvocable, 'boolean')
  // locator 是回传给 get() 的不透明定位信息
  assert.equal(typeof alpha.locator.path, 'string')
  assert.equal(typeof alpha.locator.directory, 'string')
  assert.equal(alpha.resourceBase.kind, 'directory')
  assert.equal(alpha.path, alpha.locator.path)
})

test('list() 排除会让注册表 fail-fast 的候选（非法名字 / 缺 description）', async () => {
  const provider = makeProvider()
  const candidates = await provider.list({ cwd: project })
  const names = candidates.map((entry) => entry.name)
  assert.equal(names.includes('alpha'), true)
  assert.equal(names.includes('BadName'), false, '非法名字不进目录')
  assert.equal(names.includes('no-desc'), false, '缺 description 不进目录')
})

test('list() 递归根里的深层技能也会成为候选', async () => {
  const provider = makeProvider()
  const candidates = await provider.list({ cwd: project })
  const names = candidates.map((entry) => entry.name).sort()
  assert.deepEqual(names, ['alpha', 'beta', 'gamma'])
})

test('inventory=false 时不出任何候选（等价于不登记，但不用拆装 provider）', async () => {
  const provider = makeProvider({ inventory: false })
  const candidates = await provider.list({ cwd: project })
  assert.deepEqual(candidates, [])
})

test('get() 返回完整定义，名字与候选一致', async () => {
  const provider = makeProvider()
  const candidates = await provider.list({ cwd: project })
  const alpha = candidates.find((entry) => entry.name === 'alpha')
  const definition = await provider.get(alpha, {})

  assert.equal(definition.name, alpha.name, '名字必须与候选一致，否则注册表判定选择过期')
  assert.equal(definition.description, alpha.description)
  assert.equal(definition.provider, PROVIDER_NAME)
  assert.equal(definition.source, alpha.source)
  assert.equal(definition.resourceBase.kind, 'directory')
  assert.equal(definition.resourceBase.path, alpha.locator.directory)
  assert.equal(definition.path, alpha.locator.path)
  // content 是正文（不含 frontmatter），与官方 provider 的语义一致
  assert.equal(definition.content.includes('body of alpha'), true)
  assert.equal(definition.content.includes('---'), false, '正文里不该带 frontmatter')
})

test('get() 透传 whenToUse 与 metadata', async () => {
  const provider = makeProvider()
  const candidates = await provider.list({ cwd: project })
  const beta = candidates.find((entry) => entry.name === 'beta')
  assert.equal(beta.whenToUse, 'when beta is needed')
  const definition = await provider.get(beta, {})
  assert.equal(definition.whenToUse, 'when beta is needed')
  assert.deepEqual(definition.metadata, { owner: 'team' })
})

test('get() 每次重读文件：改正文后立刻生效，无需缓存失效', async () => {
  const file = join(collection, 'alpha', 'SKILL.md')
  const original = '---\nname: alpha\ndescription: description of alpha\n---\n\n# alpha\n\nbody of alpha\n'
  await writeFile(file, original)
  try {
    const provider = makeProvider()
    const candidates = await provider.list({ cwd: project })
    const alpha = candidates.find((entry) => entry.name === 'alpha')
    assert.equal((await provider.get(alpha, {})).content.includes('body of alpha'), true)

    await writeFile(file, original.replace('body of alpha', 'REWRITTEN body'))
    assert.equal((await provider.get(alpha, {})).content.includes('REWRITTEN body'), true, '不重读文件就会拿到旧正文')
  } finally {
    await writeFile(file, original)
  }
})

test('get() 在文件消失或不再合法时返回 undefined——注册表只认这个值', async () => {
  const provider = makeProvider()
  // 注册表（dsh-skill lib/index.js:257）只把 `=== undefined` 当成"不可加载"：
  // 返回 null 会漏过那行判空，被送进 validateDefinition(null)，抛
  // TypeError: Cannot read properties of null (reading 'name')。模型侧看到的
  // 就会是内部错误，而不是"技能已不存在"。
  const aborted = new AbortController()
  aborted.abort()
  const cases = [
    await provider.get({ locator: { path: join(collection, 'ghost', 'SKILL.md') }, source: 'custom' }, {}),
    await provider.get(null, {}),
    await provider.get({ locator: null }, {}),
    await provider.get({ locator: { path: 123 } }, {}),
    await provider.get({ locator: { path: join(collection, 'alpha', 'SKILL.md') } }, { signal: aborted.signal }),
  ]
  for (const value of cases) {
    assert.equal(value, undefined)
    assert.notEqual(value, null, 'null 绕过注册表的判空，会变成 TypeError')
  }
})

test('createProvider 把注册表的 control 交给 onControl（管理器写完盘后据此失效目录）', () => {
  const seen = []
  const factory = createSkillProviderFactory(() => config, { onControl: (control) => seen.push(control) })
  const control = { signal: new AbortController().signal, invalidate: () => {} }
  const provider = factory(control)

  assert.equal(seen.length, 1, 'control 必须交出来，否则管理器没有任何办法让 DSH 重扫')
  assert.equal(seen[0], control)
  assert.equal(provider.name, PROVIDER_NAME)
  assert.equal(typeof provider.list, 'function')
  assert.equal(typeof provider.get, 'function')
})

test('没有 control 时（别的宿主 / 老调用方式）不炸，也不调 onControl', () => {
  let called = 0
  const factory = createSkillProviderFactory(() => config, {
    onControl: () => {
      called += 1
    },
  })
  const provider = factory()

  assert.equal(called, 0, '没有 control 就没有失效能力，不该假装有')
  assert.equal(provider.name, PROVIDER_NAME)
})

test('每读写配置：改完根目录下一次 list 就生效', async () => {
  const live = { ...config, deepSkillDirs: [], customSkillDirs: [collection] }
  const factory = createSkillProviderFactory(() => live)
  const provider = factory({ signal: new AbortController().signal, invalidate: () => {} })

  // 一层扫描：只有 alpha / beta（gamma 在第三层）
  const shallow = (await provider.list({ cwd: project })).map((entry) => entry.name).sort()
  assert.deepEqual(shallow, ['alpha', 'beta'])

  // 换成递归根，同一个 provider 实例立刻就应扫到 gamma
  live.customSkillDirs = []
  live.deepSkillDirs = [collection]
  const deep = (await provider.list({ cwd: project })).map((entry) => entry.name).sort()
  assert.deepEqual(deep, ['alpha', 'beta', 'gamma'])
})

test('发现过程抛错时返回不完整观测，而不是把异常抛给注册表', async () => {
  const warnings = []
  const factory = createSkillProviderFactory(
    () => {
      throw new Error('配置读取炸了')
    },
    { onWarn: (message) => warnings.push(message) },
  )
  const provider = factory({ signal: new AbortController().signal, invalidate: () => {} })

  const result = await provider.list({ cwd: project })
  assert.equal(Array.isArray(result), false, '不能返回数组（那会被当成"扫完了，技能没了"）')
  assert.deepEqual(result.candidates, [])
  assert.equal(result.complete, false, '不完整观测让注册表保留上一份好目录')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /发现失败/)
})

test('cwd 由调用方决定项目根，而不是插件进程的 cwd', async () => {
  // 独立的 project 目录，自带 .git 与 .dsh/skills（findProjectRoot 会停在它这里）
  const other = join(sandbox, 'other-proj')
  await mkdir(join(other, '.git'), { recursive: true })
  await writeSkill(join(other, '.dsh', 'skills', 'only-here'), 'only-here')

  const factory = createSkillProviderFactory(() => ({
    cwd: project,
    projects: [],
    customSkillDirs: [],
    deepSkillDirs: [],
    bundledSkillDir: '',
    inventory: true,
  }))
  const provider = factory({ signal: new AbortController().signal, invalidate: () => {} })

  // 插件进程的 cwd 完全没有参与：两次调用给不同的 cwd，各自看到各自的技能。
  const inOther = (await provider.list({ cwd: other })).map((entry) => entry.name)
  assert.equal(inOther.includes('only-here'), true, '项目根要跟着查找方的 cwd 走')

  const inProject = (await provider.list({ cwd: project })).map((entry) => entry.name)
  assert.equal(inProject.includes('only-here'), false, '换一个 cwd 就不该再看到另一个项目的技能')
})
