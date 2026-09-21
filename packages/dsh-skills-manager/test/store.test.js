// I/O 层测试：真实临时目录上的发现、校验、写入保真、搬运、回收站与路径护栏。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import {
  assertSkillPath,
  buildContext,
  copySkill,
  createSkill,
  crossCheck,
  deleteSkill,
  isInside,
  listSkills,
  listTrash,
  moveSkill,
  readSkill,
  renameSkill,
  toggleSkill,
  updateSkill,
} from '../lib/store.js'
import {
  discoverSkillFiles,
  findProjectRoot,
  resolveAgentsHome,
  resolveDshHome,
  resolveRoots,
  scanRoot,
  toPosixPath,
} from '../lib/roots.js'

let sandbox
let project
let projectSkills
let customSkills
let config
let context

/** 写一个技能文件，自动建目录。 */
async function writeSkill(path, text) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text)
}

const GOOD = '---\nname: good-skill\ndescription: A healthy skill.\n---\n\n# good\n\nBody text.\n'

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'skillmgr-test-'))
  project = join(sandbox, 'proj')
  await mkdir(join(project, '.git'), { recursive: true })
  projectSkills = join(project, '.dsh', 'skills')
  customSkills = join(sandbox, 'custom-skills')

  // 正常技能（目录包）
  await writeSkill(join(projectSkills, 'good-skill', 'SKILL.md'), GOOD)
  // 缺 description → 官方 provider 会静默跳过
  await writeSkill(join(projectSkills, 'broken-skill', 'SKILL.md'), '---\nname: broken-skill\n---\nno description\n')
  // 非法名字
  await writeSkill(join(projectSkills, 'BadName', 'SKILL.md'), '---\nname: BadName\ndescription: bad\n---\nbody\n')
  // 同名两份：项目层应赢过自定义层
  await writeSkill(
    join(projectSkills, 'flat-skill', 'SKILL.md'),
    '---\nname: flat-skill\ndescription: project wins\n---\nproject\n',
  )
  await writeSkill(
    join(customSkills, 'flat-skill.md'),
    '---\nname: flat-skill\ndescription: custom loses\n---\ncustom\n',
  )
  // 点开头目录必须被忽略
  await writeSkill(
    join(projectSkills, '.system', 'SKILL.md'),
    '---\nname: system-skill\ndescription: should be skipped\n---\nbody\n',
  )
  // 嵌套目录不是技能（只认一层）
  await writeSkill(
    join(projectSkills, 'nested', 'inner', 'SKILL.md'),
    '---\nname: inner\ndescription: nested\n---\nbody\n',
  )
  // 顶层非 SKILL.md 的 md 不是技能
  await writeSkill(join(projectSkills, 'nested', 'notes.md'), 'just notes\n')

  config = { cwd: project, customSkillDirs: [customSkills], bundledSkillDir: '', projects: [project] }
  context = await buildContext(config)
})

after(async () => {
  if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true })
})

test('resolveDshHome / resolveAgentsHome 遵循环境变量优先级', () => {
  // 注意：路径断言只看结尾，因为 Windows 上 resolve() 会把 '/explicit' 变成 'E:/explicit'。
  assert.equal(
    toPosixPath(resolveDshHome({ dshHome: '/explicit', env: { DSH_HOME: '/env' }, home: '/home/u' })).endsWith(
      '/explicit',
    ),
    true,
  )
  assert.equal(toPosixPath(resolveDshHome({ env: { DSH_HOME: '/env' }, home: '/home/u' })).endsWith('/env'), true)
  assert.equal(toPosixPath(resolveDshHome({ env: {}, home: '/home/u' })).endsWith('/home/u/.dsh'), true)
  assert.equal(toPosixPath(resolveAgentsHome({ env: {}, home: '/home/u' })).endsWith('/home/u/.agents'), true)
  assert.equal(toPosixPath(resolveAgentsHome({ env: { DSH_AGENTS_HOME: '/a' }, home: '/home/u' })).endsWith('/a'), true)
})

test('findProjectRoot 找到最近的 .git 祖先', async () => {
  const nested = join(project, '.dsh', 'skills', 'good-skill')
  assert.equal(await findProjectRoot(nested), project)
})

test('findProjectRoot 没有 .git 时退回起始目录', async () => {
  const orphan = join(sandbox, 'orphan')
  await mkdir(orphan, { recursive: true })
  const found = await findProjectRoot(orphan)
  // 从临时目录往上可能真的存在 .git（取决于机器），所以只要求「不报错且是祖先或自身」。
  assert.equal(found === orphan || orphan.startsWith(found), true)
})

test('resolveRoots 按官方 rank 顺序给出根目录', () => {
  const roots = resolveRoots({
    cwd: project,
    projectRoot: project,
    customSkillDirs: [customSkills],
    dshHome: join(sandbox, 'home'),
    agentsHome: join(sandbox, 'agents'),
    env: {},
    home: sandbox,
  })
  assert.deepEqual(
    roots.map((root) => root.source),
    ['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents'],
  )
  assert.deepEqual(
    roots.map((root) => root.rank),
    [100, 200, 300, 400, 500],
  )
  assert.equal(roots[3].skipSystem, true)
  assert.equal(
    roots.every((root) => root.writable),
    true,
  )
})

test('resolveRoots 配置了 bundledSkillDir 才有第 6 个只读根', () => {
  const roots = resolveRoots({ cwd: project, projectRoot: project, bundledSkillDir: join(sandbox, 'bundled') })
  const bundled = roots.find((root) => root.source === 'bundled')
  assert.equal(bundled.rank, 600)
  assert.equal(bundled.writable, false)
})

test('scanRoot 只认一层、跳过点目录与嵌套', async () => {
  const root = { path: projectSkills, source: 'project-dsh', rank: 100, skipSystem: true }
  const found = await scanRoot(root)
  const names = found.map((entry) => entry.name).sort()
  assert.deepEqual(names, ['BadName', 'broken-skill', 'flat-skill', 'good-skill'])
  assert.equal(
    found.every((entry) => entry.kind === 'bundle'),
    true,
  )
  assert.equal(
    found.some((entry) => entry.name === 'inner'),
    false,
  )
  assert.equal(
    found.some((entry) => entry.name === 'system-skill'),
    false,
  )
  assert.equal(
    found.some((entry) => entry.name === 'notes'),
    false,
  )
})

test('discoverSkillFiles 报告根目录状态与技能数', async () => {
  const roots = resolveRoots({
    cwd: project,
    projectRoot: project,
    customSkillDirs: [customSkills],
    dshHome: join(sandbox, 'home'),
    agentsHome: join(sandbox, 'agents'),
    env: {},
    home: sandbox,
  })
  const discovered = await discoverSkillFiles(roots)
  const projectRoot = discovered.roots.find((root) => root.source === 'project-dsh')
  assert.equal(projectRoot.exists, true)
  assert.equal(projectRoot.skillCount, 4)
  const userRoot = discovered.roots.find((root) => root.source === 'user-dsh')
  assert.equal(userRoot.exists, false)
  assert.equal(userRoot.skillCount, 0)
})

test('listSkills 标出会被 DSH 跳过的技能与遮蔽关系', async () => {
  const { skills, summary } = await listSkills(context)
  const broken = skills.find((skill) => skill.name === 'broken-skill')
  assert.equal(broken.status, 'broken')
  assert.equal(
    broken.issues.some((issue) => issue.key === 'description'),
    true,
  )

  const badName = skills.find((skill) => skill.name === 'BadName')
  assert.equal(badName.status, 'broken')

  const winner = skills.find((skill) => skill.name === 'flat-skill' && skill.source === 'project-dsh')
  const loser = skills.find((skill) => skill.name === 'flat-skill' && skill.source === 'custom')
  assert.equal(winner.shadowed, false)
  assert.equal(winner.copyCount, 2)
  assert.equal(loser.shadowed, true)
  assert.equal(loser.winnerPath, winner.path)
  assert.equal(summary.broken, 2)
  assert.equal(summary.shadowed, 1)
})

test('listSkills 不把点目录里的技能扫进来', async () => {
  const { skills } = await listSkills(context)
  assert.equal(
    skills.some((skill) => skill.name === 'system-skill'),
    false,
  )
})

test('readSkill 返回详情、行号与诊断', async () => {
  const detail = await readSkill(context, join(projectSkills, 'good-skill', 'SKILL.md'))
  assert.equal(detail.name, 'good-skill')
  assert.equal(detail.kind, 'bundle')
  assert.equal(detail.source, 'project-dsh')
  assert.equal(detail.status, 'ok')
  assert.equal(detail.frontmatter, 'name: good-skill\ndescription: A healthy skill.')
  assert.equal(detail.body.trim().startsWith('# good'), true)
})

test('createSkill 建出可解析的技能并拒绝重名', async () => {
  const created = await createSkill(context, {
    name: 'created-skill',
    description: 'made by test',
    rootPath: projectSkills,
    kind: 'bundle',
  })
  assert.equal(toPosixPath(created.path), toPosixPath(join(projectSkills, 'created-skill', 'SKILL.md')))
  const detail = await readSkill(context, created.path)
  assert.equal(detail.status, 'ok')
  assert.equal(detail.description, 'made by test')
  await assert.rejects(
    () => createSkill(context, { name: 'created-skill', description: 'again', rootPath: projectSkills }),
    /已存在同名技能/,
  )
})

test('createSkill 支持单文件形态并校验输入', async () => {
  const created = await createSkill(context, {
    name: 'flat-created',
    description: 'flat one',
    rootPath: projectSkills,
    kind: 'flat',
  })
  assert.equal(created.kind, 'flat')
  assert.equal(toPosixPath(created.path).endsWith('/flat-created.md'), true)
  await assert.rejects(
    () => createSkill(context, { name: 'Bad Name', description: 'x', rootPath: projectSkills }),
    /kebab-case/,
  )
  await assert.rejects(
    () => createSkill(context, { name: 'ok-name', description: '', rootPath: projectSkills }),
    /description/,
  )
  await assert.rejects(
    () => createSkill(context, { name: 'ok-name', description: 'x', rootPath: join(sandbox, 'nope') }),
    /不可写/,
  )
})

test('updateSkill 只改正文时 frontmatter 逐字节保留', async () => {
  const target = join(projectSkills, 'good-skill', 'SKILL.md')
  const before = await readFile(target, 'utf8')
  await updateSkill(context, { path: target, body: 'rewritten body\n' })
  const after = await readFile(target, 'utf8')
  assert.equal(after.split('---')[1], before.split('---')[1])
  assert.equal(after.trimEnd().endsWith('rewritten body'), true)
})

test('updateSkill 改字段是行级手术，注释与未知键活着', async () => {
  const target = join(projectSkills, 'annotated', 'SKILL.md')
  await writeSkill(target, '---\nname: annotated\n# 保留我\ndescription: old\ncustom: keep\n---\nbody\n')
  const fresh = await buildContext(config)
  await updateSkill(fresh, { path: target, fields: { description: 'new' } })
  const text = await readFile(target, 'utf8')
  assert.equal(text.includes('# 保留我'), true)
  assert.equal(text.includes('custom: keep'), true)
  assert.equal(text.includes('description: new'), true)
  assert.equal(text.includes('description: old'), false)
})

test('updateSkill 拒绝把文件改成 DSH 会跳过的样子', async () => {
  const target = join(projectSkills, 'good-skill', 'SKILL.md')
  await assert.rejects(() => updateSkill(context, { path: target, fields: { name: 'Bad Name' } }), /不是合法技能名/)
})

test('updateSkill 用 expectedText 挡住编辑器外的并发修改', async () => {
  const target = join(projectSkills, 'good-skill', 'SKILL.md')
  await assert.rejects(
    () => updateSkill(context, { path: target, body: 'x', expectedText: 'stale content' }),
    /已被其它程序修改/,
  )
})

test('updateSkill 在内容没变时报告 changed=false', async () => {
  // 用一个已经处于规范形态（frontmatter 后有空行、正文以换行结尾）的文件，
  // 这样「原样写回」必须被判为无变化——否则每次打开都会产生一次无谓写盘。
  const target = join(projectSkills, 'canonical', 'SKILL.md')
  await writeSkill(target, '---\nname: canonical\ndescription: c\n---\n\nbody text\n')
  const fresh = await buildContext(config)
  const current = await readFile(target, 'utf8')
  const detail = await readSkill(fresh, target)
  const result = await updateSkill(fresh, {
    path: target,
    body: detail.body,
    expectedText: current,
  })
  assert.equal(result.changed, false)
  assert.equal(await readFile(target, 'utf8'), current)
})

test('toggleSkill 写官方开关字段，恢复默认时删掉该键', async () => {
  const target = join(projectSkills, 'toggle-me', 'SKILL.md')
  await writeSkill(target, '---\nname: toggle-me\ndescription: t\n---\nbody\n')
  const fresh = await buildContext(config)

  await toggleSkill(fresh, { path: target, modelInvocable: false })
  let detail = await readSkill(fresh, target)
  assert.equal(detail.invocation.modelInvocable, false)
  assert.equal(detail.invocation.userInvocable, true)

  await toggleSkill(fresh, { path: target, userInvocable: false })
  detail = await readSkill(fresh, target)
  assert.equal(detail.invocation.userInvocable, false)

  await toggleSkill(fresh, { path: target, modelInvocable: true })
  detail = await readSkill(fresh, target)
  assert.equal(detail.invocation.modelInvocable, true)
  const text = await readFile(target, 'utf8')
  assert.equal(text.includes('disable-model-invocation'), false)
})

test('renameSkill 同步改 frontmatter 的 name', async () => {
  const target = join(projectSkills, 'rename-me', 'SKILL.md')
  await writeSkill(target, '---\nname: rename-me\ndescription: r\n---\nbody\n')
  const fresh = await buildContext(config)
  const renamed = await renameSkill(fresh, { path: target, newName: 'renamed' })
  assert.equal(toPosixPath(renamed.path), toPosixPath(join(projectSkills, 'renamed', 'SKILL.md')))
  const detail = await readSkill(fresh, renamed.path)
  assert.equal(detail.name, 'renamed')
  assert.equal(detail.status, 'ok')
  await assert.rejects(() => renameSkill(fresh, { path: renamed.path, newName: 'Bad Name' }), /kebab-case/)
})

test('copySkill 跨根复制并改写副本的 name', async () => {
  const source = join(projectSkills, 'good-skill', 'SKILL.md')
  const copied = await copySkill(context, { path: source, targetRoot: customSkills, newName: 'good-copy' })
  const detail = await readSkill(await buildContext(config), copied.path)
  assert.equal(detail.name, 'good-copy')
  assert.equal(detail.status, 'ok')
  // 源文件不受影响
  assert.equal((await readFile(source, 'utf8')).includes('name: good-skill'), true)
  await assert.rejects(
    () => copySkill(context, { path: source, targetRoot: customSkills, newName: 'good-copy' }),
    /已存在/,
  )
})

test('moveSkill 跨根搬走并拒绝同根', async () => {
  const target = join(customSkills, 'move-me.md')
  await writeSkill(target, '---\nname: move-me\ndescription: m\n---\nbody\n')
  const fresh = await buildContext(config)
  const moved = await moveSkill(fresh, { path: target, targetRoot: projectSkills })
  assert.equal(toPosixPath(moved.path).endsWith('/move-me.md'), true)
  assert.equal(moved.path.includes(toPosixPath(customSkills)), false)
  await assert.rejects(() => moveSkill(fresh, { path: moved.path, targetRoot: projectSkills }), /同一个根目录/)
})

test('deleteSkill 移入回收站且技能不再被发现', async () => {
  const target = join(projectSkills, 'delete-me', 'SKILL.md')
  await writeSkill(target, '---\nname: delete-me\ndescription: d\n---\nbody\n')
  const fresh = await buildContext(config)
  const deleted = await deleteSkill(fresh, { path: target })
  assert.equal(deleted.name, 'delete-me')
  const { skills } = await listSkills(await buildContext(config))
  assert.equal(
    skills.some((skill) => skill.name === 'delete-me'),
    false,
  )
  // 回收站里能查到，且点开头目录不会被当成技能扫出来
  const trash = await listTrash(fresh, projectSkills)
  assert.equal(
    trash.some((item) => item.name.includes('delete-me')),
    true,
  )
  assert.equal(
    skills.some((skill) => skill.path.includes('/.trash/')),
    false,
  )
})

test('assertSkillPath 挡住越界、点目录与只读根', async () => {
  const roots = context.roots
  assert.throws(
    () => assertSkillPath(roots, join(projectSkills, '..', '..', '..', 'evil', 'x.md')),
    /不在任何可写技能根目录内/,
  )
  assert.throws(() => assertSkillPath(roots, join(sandbox, 'outside', 'x.md')), /不在任何可写技能根目录内/)
  assert.throws(() => assertSkillPath(roots, join(projectSkills, '.git', 'config')), /以点开头/)
  assert.throws(() => assertSkillPath(roots, join(projectSkills, '.trash', 'x', 'SKILL.md')), /以点开头/)
  // 读操作允许只读根，写操作拒绝
  const readonlyRoots = [
    { source: 'bundled', rank: 600, scope: 'bundled', path: join(sandbox, 'bundled'), writable: false },
  ]
  const inside = join(sandbox, 'bundled', 'x', 'SKILL.md')
  assert.doesNotThrow(() => assertSkillPath(readonlyRoots, inside, { requireWritable: false }))
  assert.throws(() => assertSkillPath(readonlyRoots, inside), /只读|不在任何可写/)
})

test('isInside 在跨盘符、盘根与同级目录上都不会误判（回归）', async () => {
  // 真实踩过的坑：Windows 上不同盘符之间 path.relative() 返回的是**绝对路径**
  // （`C:\Windows\x`），它不以 `..` 开头。只做前缀判断会把整块盘判成「在根目录
  // 之内」，于是 readSkill('C:/Windows/win.ini') 会被放行。这里钉死该行为。
  const driveRoot = resolvePath(sep).slice(0, 2) // 'E:'
  const absoluteDriveRoot = resolvePath(sep + sep) // 'E:\'
  assert.equal(
    isInside(process.cwd(), resolvePath(join(driveRoot, 'Windows', 'win.ini'))),
    false,
    '盘内其它位置不能被判成在 cwd 之内',
  )
  // 绝对盘根 `E:\` 在路径语义上**确实**包含盘上的一切；正因为它这么宽，
  // 才必须保证技能根永远不会解析到盘根（下一条测试专门守这件事）。
  assert.equal(isInside(absoluteDriveRoot, process.cwd()), true)
  // `E:` 是「该盘当前目录」这种 drive-relative 形式，不构成稳定的包含关系。
  assert.equal(isInside(driveRoot, process.cwd()), false)

  // 同级/父级/自身
  const base = join(sandbox, 'a')
  assert.equal(isInside(base, base), false, '自身不算在里面')
  assert.equal(isInside(base, dirname(base)), false, '父目录不在里面')
  assert.equal(isInside(base, join(sandbox, 'b', 'x')), false, '同级目录不在里面')
  assert.equal(isInside(base, join(base, 'x', 'y')), true, '子路径在里面')
  assert.equal(isInside(base, join(base, '..', 'a', 'x')), true, '规范化后仍在里面')

  // 空值/非字符串输入一律判 false，绝不因为调用方漏参而放行
  assert.equal(isInside('', base), false)
  assert.equal(isInside(base, ''), false)
  assert.equal(isInside(undefined, base), false)
  assert.equal(isInside(base, undefined), false)
})

test('盘根不会成为技能根：resolveRoots 的结果永远不是驱动器根', () => {
  const roots = resolveRoots({
    cwd: project,
    projectRoot: project,
    customSkillDirs: [customSkills],
    dshHome: join(sandbox, 'home'),
    agentsHome: join(sandbox, 'agents'),
    env: {},
    home: sandbox,
  })
  const driveRoot = resolvePath(sep).slice(0, 2).toLowerCase()
  for (const root of roots) {
    assert.notEqual(resolvePath(root.path).toLowerCase(), driveRoot, `${root.source} 不应指向盘根`)
  }
})

test('crossCheck 报出磁盘与注册表的差异', () => {
  const skills = [
    { name: 'a', status: 'ok' },
    { name: 'broken', status: 'broken' },
  ]
  const diff = crossCheck(skills, [{ name: 'a' }, { name: 'ghost' }])
  assert.deepEqual(diff.missingFromRegistry, [])
  assert.deepEqual(diff.extraInRegistry, ['ghost'])
})
