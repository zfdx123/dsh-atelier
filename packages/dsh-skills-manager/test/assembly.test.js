// 宿主侧装配自检：用一个假的 Cordis 上下文跑 apply()，验证
//   1. 模块能加载、apply 不抛错；
//   2. settings 命名空间被注册；
//   3. HTTP 路由被注册、且回环护栏按预期放行/拒绝；
//   4. skill_manager 工具被注册，且 list / roots / create / 越界拒绝都符合预期。
// 这个脚本不需要真实 DSH 进程，所以可以在改 profile 之前先确认插件是活的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'

/** 搭一个最小可用的假宿主，返回装配结果与辅助调用。 */
async function assemble() {
  const sandbox = await mkdtemp(join(tmpdir(), 'skillsmgr-assembly-'))
  const project = join(sandbox, 'proj')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, '.dsh', 'skills', 'demo-skill'), { recursive: true })
  await writeFile(
    join(project, '.dsh', 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: A demo skill for assembly test.\n---\n\n# demo\n\nbody\n',
  )

  const registered = { settings: [], routes: [], tools: [], providers: [], registryList: [], invalidations: 0 }
  const effects = []
  const warnings = []
  // 忠实一点的状态机：settings 是带 revision 的存储，replace 会校验 expectedRevision。
  // 这样写设置的「读-改-写 + 冲突重试」才是真被测到，而不是走过场。
  let stored = null
  let revision = 0
  let writable = true
  let forceConflicts = 0
  // 冲突错误的两种形态：真实实现两样都给，但调用方只该依赖其中之一而不是猜。
  let conflictStyle = 'both'
  // 忠实复刻 dsh-settings 的 SettingsConflictError：code 是 'SETTINGS_CONFLICT'
  // （那个类里的 `readonly code = "SETTINGS_CONFLICT"`），name 是类名。
  // 这里以前写的是 `code = 'conflict'`——一个错的常量，把「只认错值」的实现
  // 一路放过去了，所以两种形态都要能测。
  const conflictError = (message) => {
    const error = new Error(message)
    error.code = 'SETTINGS_CONFLICT'
    if (conflictStyle === 'both') error.name = 'SettingsConflictError'
    return error
  }
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    settings: {
      get writable() {
        return writable
      },
      // 忠实模拟真实契约：dsh-settings 的 resolve() 会执行 `schema(merged)`，
      // 所以第二个参数必须是**可调用**的。之前这里直接把参数吞掉，导致
      // 「传普通对象」这个致命错误一路逃到生产，让整个 profile 起不来。
      // 现在传进来的不是函数就抛错——复刻真实的 "schema is not a function"。
      register: (ns, schema) => {
        if (typeof schema !== 'function') throw new TypeError('schema is not a function')
        // 真的跑一遍解析：默认值缺失或类型不符会立刻暴露。
        const resolved = schema({})
        stored = resolved
        registered.settings.push({ ns, schema, resolved })
        return { ns }
      },
      get: () => stored,
      describe: () =>
        registered.settings.map((entry) => ({
          ns: entry.ns,
          schema: entry.schema.toJSON(),
          value: stored,
          revision,
        })),
      replace: async (ns, section, expectedRevision) => {
        if (!writable) throw new Error(`settings provider is read-only: "${ns}" cannot be updated in-process`)
        if (forceConflicts > 0) {
          forceConflicts -= 1
          revision += 1
          throw conflictError('conflict')
        }
        if (expectedRevision !== undefined && expectedRevision !== revision) {
          throw conflictError(`settings "${ns}" moved from ${expectedRevision} to ${revision}`)
        }
        stored = registered.settings[0].schema(section)
        revision += 1
      },
    },
    get: (service) =>
      service === 'webServer'
        ? ctx.webServer
        : service === 'tools'
          ? ctx.tools
          : service === 'skills'
            ? ctx.skillsService
            : undefined,
    on: () => {},
    effect: (factory) => {
      const disposer = factory()
      effects.push(typeof disposer === 'function' ? disposer : () => {})
    },
    webServer: {
      register: (route) => {
        registered.routes.push(route)
        return () => {}
      },
    },
    tools: {
      register: (definition) => {
        registered.tools.push(definition)
        return () => {}
      },
    },
    // 技能提供者：真的调用一次工厂（这样 list/get 的形状也能被测到），
    // list() 返回 registered.registryList 供交叉核对测试操纵。
    // invalidate 计数：注册表的目录缓存按 revision 键控，磁盘变化不会自己 bump，
    // 所以「写完盘有没有人让目录失效」是能观察的行为。
    skillsService: {
      registerProvider: (factory) => {
        registered.providers.push(
          factory({
            signal: new AbortController().signal,
            invalidate: () => {
              registered.invalidations += 1
            },
          }),
        )
        return () => {}
      },
      list: async () => registered.registryList,
    },
  }
  plugin.apply(ctx)
  return {
    sandbox,
    project,
    registered,
    effects,
    warnings,
    ctx,
    // 让测试能观察/操纵假 settings 的状态（只读、强制冲突）。
    settingsState: {
      read: () => stored,
      revision: () => revision,
      setWritable: (value) => {
        writable = value
      },
      forceConflicts: (count, style = 'both') => {
        forceConflicts = count
        conflictStyle = style
      },
    },
  }
}

/** 用假 req/res 打一次路由。 */
async function callRoute(route, req) {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
    },
    end(text) {
      res.body = text
    },
  }
  await route.handler(req, res)
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

/** 造一个 POST 请求（带 JSON body 的假流）。 */
function postReq(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return {
    method: 'POST',
    url: plugin.API_PATH,
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') setTimeout(() => handler(Buffer.from(text, 'utf8')), 0)
      if (event === 'end') setTimeout(handler, 1)
      return this
    },
  }
}

/** 打一次 API 并要求成功。 */
async function ok(route, payload) {
  const result = await callRoute(route, postReq(payload))
  assert.equal(result.body.ok, true, `期望成功，实际：${JSON.stringify(result.body)}`)
  return result.body.data
}

/** 打一次 API 并要求失败，返回错误文本。 */
async function fails(route, payload) {
  const result = await callRoute(route, postReq(payload))
  assert.equal(result.body.ok, false, `期望失败，实际：${JSON.stringify(result.body)}`)
  return String(result.body.error)
}

test('自定义技能文件夹：添加后目录被当作 rank 300 的根', async () => {
  const { sandbox, project, registered, settingsState } = await assemble()
  const originalCwd = process.cwd()
  try {
    process.chdir(project)
    const route = registered.routes[0]

    // 起始为空
    const before = await ok(route, { action: 'dirs' })
    assert.deepEqual(before.dirs, [])
    assert.equal(before.writable, true)

    // 不存在的目录默认拒绝
    const missing = join(sandbox, 'nope')
    assert.match(await fails(route, { action: 'addDir', path: missing }), /目录不存在/)
    assert.match(await fails(route, { action: 'addDir', path: 'relative/path' }), /绝对路径/)
    assert.match(await fails(route, { action: 'addDir', path: '' }), /不能为空/)

    // 建好真实目录并放一个技能进去
    const custom = join(sandbox, 'my-skills')
    await mkdir(join(custom, 'custom-skill'), { recursive: true })
    await writeFile(
      join(custom, 'custom-skill', 'SKILL.md'),
      '---\nname: custom-skill\ndescription: lives in a custom root\n---\n\nbody\n',
    )

    const added = await ok(route, { action: 'addDir', path: custom })
    assert.equal(added.created, false)
    assert.equal(added.skillCount, 1, '添加后应立即扫到该目录里的技能')
    assert.deepEqual(settingsState.read().customSkillDirs, [custom])

    // 重复添加被拒
    assert.match(await fails(route, { action: 'addDir', path: custom }), /已经在列表里/)
    // 内置根不能被当成自定义根
    assert.match(await fails(route, { action: 'addDir', path: join(project, '.dsh', 'skills') }), /已经是内置技能根/)

    // 列表反映出来，且技能出现在快照里（source=custom, rank=300）
    const after = await ok(route, { action: 'dirs' })
    assert.equal(after.dirs.length, 1)
    assert.equal(after.dirs[0].skillCount, 1)
    assert.equal(after.dirs[0].exists, true)

    const snapshotData = await ok(route, { action: 'list' })
    const skill = snapshotData.skills.find((entry) => entry.name === 'custom-skill')
    assert.ok(skill, '自定义根里的技能应出现在快照中')
    assert.equal(skill.source, 'custom')
    assert.equal(skill.rank, 300)
    const root = snapshotData.roots.find((entry) => entry.source === 'custom')
    assert.equal(root.writable, true)
  } finally {
    process.chdir(originalCwd)
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('自定义技能文件夹：create 标志可创建不存在的目录', async () => {
  const { sandbox, project, registered } = await assemble()
  const originalCwd = process.cwd()
  try {
    process.chdir(project)
    const route = registered.routes[0]
    const parent = join(sandbox, 'made')
    await mkdir(parent, { recursive: true })
    const target = join(parent, 'new-skills')

    const added = await ok(route, { action: 'addDir', path: target, create: true })
    assert.equal(added.created, true)
    assert.equal(existsSync(target), true)

    // 上级目录不存在时，明确拒绝而不是递归造一整棵目录树
    assert.match(
      await fails(route, { action: 'addDir', path: join(sandbox, 'a', 'b', 'c'), create: true }),
      /上级目录不存在/,
    )
  } finally {
    process.chdir(originalCwd)
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('自定义技能文件夹：移除只解除管理，不动磁盘文件', async () => {
  const { sandbox, project, registered, settingsState } = await assemble()
  const originalCwd = process.cwd()
  try {
    process.chdir(project)
    const route = registered.routes[0]
    const custom = join(sandbox, 'keep-skills')
    await mkdir(join(custom, 'kept'), { recursive: true })
    const skillFile = join(custom, 'kept', 'SKILL.md')
    await writeFile(skillFile, '---\nname: kept\ndescription: kept\n---\nbody\n')

    await ok(route, { action: 'addDir', path: custom })
    const removed = await ok(route, { action: 'removeDir', path: custom })

    assert.deepEqual(settingsState.read().customSkillDirs, [])
    assert.equal(removed.dirs.length, 0)
    assert.match(removed.note, /未被改动|未改动/)
    // 关键：磁盘上的技能文件必须原封不动
    assert.equal(existsSync(skillFile), true)
    assert.match(await readFile(skillFile, 'utf8'), /name: kept/)
    // 再移除一次 → 报「列表里没有」
    assert.match(await fails(route, { action: 'removeDir', path: custom }), /列表里没有/)
  } finally {
    process.chdir(originalCwd)
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('自定义技能文件夹：settings 只读时明确拒绝而不是静默失败', async () => {
  const { sandbox, project, registered, settingsState } = await assemble()
  const originalCwd = process.cwd()
  try {
    process.chdir(project)
    const route = registered.routes[0]
    const custom = join(sandbox, 'ro-skills')
    await mkdir(custom, { recursive: true })

    settingsState.setWritable(false)
    const listing = await ok(route, { action: 'dirs' })
    assert.equal(listing.writable, false, '前端据此禁用添加按钮')
    assert.match(await fails(route, { action: 'addDir', path: custom }), /不可写|只读/)
  } finally {
    process.chdir(originalCwd)
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('自定义技能文件夹：revision 冲突时重试，持续冲突才报错', async () => {
  const { sandbox, project, registered, settingsState } = await assemble()
  const originalCwd = process.cwd()
  try {
    process.chdir(project)
    const route = registered.routes[0]
    const first = join(sandbox, 'c1')
    const second = join(sandbox, 'c2')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })

    // 一次冲突后成功 → 重试生效，且写入的是重读后的列表（不丢已有序项）
    settingsState.forceConflicts(1)
    await ok(route, { action: 'addDir', path: first })
    await ok(route, { action: 'addDir', path: second })
    assert.deepEqual(settingsState.read().customSkillDirs, [first, second])

    // 三次全冲突 → 明确报「并发」而不是假装成功
    const third = join(sandbox, 'c3')
    await mkdir(third, { recursive: true })
    settingsState.forceConflicts(99)
    assert.match(await fails(route, { action: 'addDir', path: third }), /并发/)
  } finally {
    process.chdir(originalCwd)
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('revision 冲突只带真实的 SETTINGS_CONFLICT 码也要被认出来（不能只认 error.name）', async () => {
  const { sandbox, project, registered, settingsState } = await assemble()
  const originalCwd = process.cwd()
  try {
    process.chdir(project)
    const route = registered.routes[0]
    const first = join(sandbox, 'k1')
    await mkdir(first, { recursive: true })

    // code 是 SettingsConflictError 上标着「稳定机器码」的那个字段（文档明确说它给
    // 线上层做分类映射用），所以它才是该认的那个；只认 name 的话，一次本来可重试的
    // 并发冲突会被报成失败。
    settingsState.forceConflicts(1, 'code')
    await ok(route, { action: 'addDir', path: first })
    assert.deepEqual(settingsState.read().customSkillDirs, [first])
  } finally {
    process.chdir(originalCwd)
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('skill_manager 工具支持 dirs / addDir / removeDir', async () => {
  const { sandbox, project, registered, settingsState } = await assemble()
  const originalCwd = process.cwd()
  try {
    process.chdir(project)
    const tool = registered.tools[0]

    const empty = await tool.execute({ action: 'dirs' }, {})
    assert.match(empty.title, /还没有配置/)

    const custom = join(sandbox, 'tool-skills')
    await mkdir(join(custom, 'tool-skill'), { recursive: true })
    await writeFile(join(custom, 'tool-skill', 'SKILL.md'), '---\nname: tool-skill\ndescription: d\n---\nbody\n')

    const added = await tool.execute({ action: 'addDir', path: custom }, {})
    assert.match(added.title, /已添加自定义技能文件夹/)
    assert.deepEqual(settingsState.read().customSkillDirs, [custom])

    // 列表里带上技能数，且 list 能看到它
    const listed = await tool.execute({ action: 'dirs' }, {})
    assert.match(listed.title, /技能 1 个/)
    const panel = await tool.execute({ action: 'list' }, {})
    assert.match(panel.title, /tool-skill/)

    const removed = await tool.execute({ action: 'removeDir', path: custom }, {})
    assert.match(removed.title, /没有被改动/)
    assert.deepEqual(settingsState.read().customSkillDirs, [])

    // 错误路径也要有可读信息
    await assert.rejects(() => tool.execute({ action: 'addDir', path: join(sandbox, 'ghost') }, {}), /目录不存在/)
    await assert.rejects(() => tool.execute({ action: 'removeDir', path: custom }, {}), /列表里没有/)
  } finally {
    process.chdir(originalCwd)
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('HTTP 写操作让技能目录立刻失效，读操作不碰它', async () => {
  const { sandbox, project, registered } = await assemble()
  const originalCwd = process.cwd()
  try {
    process.chdir(project)
    const route = registered.routes[0]
    const custom = join(sandbox, 'live-skills')
    await mkdir(custom, { recursive: true })

    // 读操作不该让 DSH 重扫——每次刷新都失效等于把目录抖动放大到每个按钮上。
    const baseline = registered.invalidations
    await ok(route, { action: 'list' })
    await ok(route, { action: 'lint' })
    assert.equal(registered.invalidations, baseline, '读操作不该失效目录')

    // 写操作：每写完一次都必须让 DSH 重扫。注册表的目录缓存按 revision 键控，
    // 而本 provider 没有 watcher——不主动失效的话，面板里删掉的技能还在目录里
    // 被广告，模型加载它时就会撞上内部 TypeError。
    await ok(route, { action: 'addDir', path: custom })
    assert.equal(registered.invalidations, baseline + 1, 'addDir 之后必须失效')

    const created = await ok(route, { action: 'create', name: 'live-skill', description: 'live', rootPath: custom })
    assert.equal(registered.invalidations, baseline + 2, 'create 之后必须失效')

    await ok(route, { action: 'delete', path: created.path, kind: 'bundle' })
    assert.equal(registered.invalidations, baseline + 3, 'delete 之后必须失效')

    await ok(route, { action: 'removeDir', path: custom })
    assert.equal(registered.invalidations, baseline + 4, 'removeDir 之后必须失效')

    // 失败的写操作不该失效：什么都没改成，重扫只是白费。
    const afterWrites = registered.invalidations
    await fails(route, { action: 'removeDir', path: custom })
    assert.equal(registered.invalidations, afterWrites, '失败的写操作不该失效目录')
  } finally {
    process.chdir(originalCwd)
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('skill_manager 工具的写操作也让技能目录失效', async () => {
  const { sandbox, project, registered } = await assemble()
  const originalCwd = process.cwd()
  try {
    process.chdir(project)
    const tool = registered.tools[0]

    const baseline = registered.invalidations
    await tool.execute({ action: 'list' }, {})
    await tool.execute({ action: 'dirs' }, {})
    assert.equal(registered.invalidations, baseline, '读操作不该失效目录')

    const custom = join(sandbox, 'tool-live')
    await mkdir(custom, { recursive: true })
    await tool.execute({ action: 'addDir', path: custom }, {})
    assert.equal(registered.invalidations, baseline + 1, 'addDir 之后必须失效')

    await tool.execute({ action: 'removeDir', path: custom }, {})
    assert.equal(registered.invalidations, baseline + 2, 'removeDir 之后必须失效')

    // 工具里 addDir 失败是抛错，走的是另一条返回路径——同样不该失效。
    const afterWrites = registered.invalidations
    await assert.rejects(() => tool.execute({ action: 'addDir', path: join(sandbox, 'ghost') }, {}), /目录不存在/)
    assert.equal(registered.invalidations, afterWrites, '失败的写操作不该失效目录')
  } finally {
    process.chdir(originalCwd)
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('apply() 注册 settings 命名空间、HTTP 路由、skill_manager 工具与技能提供者', async () => {
  const { sandbox, registered, warnings } = await assemble()
  try {
    assert.equal(plugin.name, 'dsh-skills-manager')
    assert.deepEqual(plugin.inject, ['settings'])
    assert.deepEqual(
      registered.settings.map((entry) => entry.ns),
      [plugin.SETTINGS_NS],
    )
    assert.deepEqual(
      registered.routes.map((route) => `${route.kind} ${route.path}`),
      [`exact ${plugin.API_PATH}`],
    )
    assert.deepEqual(
      registered.tools.map((tool) => tool.name),
      [plugin.TOOL_NAME],
    )
    // 技能提供者必须注册：否则面板里的技能进不了 DSH 目录（"看得见、用不上"）。
    assert.deepEqual(
      registered.providers.map((provider) => provider.name),
      ['skills-manager'],
    )
    assert.equal(typeof registered.providers[0].list, 'function')
    assert.equal(typeof registered.providers[0].get, 'function')
    assert.deepEqual(warnings, [], '装配过程中不应有警告')
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('settings schema 是可调用的 schemastery 对象且默认值完整', async () => {
  // 回归：dsh-settings 内部执行 `schema(merged)` 解析取值，设置页另读 `schema.toJSON()`。
  // 传普通对象会让插件在装配阶段抛 "schema is not a function"，
  // 并以 "plugin tree failed to load" 的形式让**整个 profile 起不来**。
  const { sandbox, registered } = await assemble()
  try {
    const entry = registered.settings[0]
    assert.equal(typeof entry.schema, 'function', 'schema 必须可调用')
    assert.equal(typeof entry.schema.toJSON, 'function', 'schema 必须能 toJSON（设置页要读）')
    assert.deepEqual(entry.resolved, {
      customSkillDirs: [],
      deepSkillDirs: [],
      bundledSkillDir: '',
      projects: [],
      inventory: true,
    })
    // 部分配置要被补全，而不是原样回传。
    assert.deepEqual(entry.schema({ projects: ['E:/x'] }), {
      customSkillDirs: [],
      deepSkillDirs: [],
      bundledSkillDir: '',
      projects: ['E:/x'],
      inventory: true,
    })
    // 多传的字段无害：readConfig 只读这三个键，类型也由 schema 保证。
    const withExtra = entry.schema({ nope: 1, projects: ['E:/x'] })
    assert.deepEqual(withExtra.projects, ['E:/x'])
    assert.deepEqual(withExtra.customSkillDirs, [])
    assert.equal(typeof withExtra.bundledSkillDir, 'string')
    // toJSON 必须能序列化（设置页据此渲染表单）。
    assert.doesNotThrow(() => JSON.stringify(entry.schema.toJSON()))
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('settings.register 抛错时插件降级而不是拖垮整个 profile', async () => {
  // 一个可选的技能管理器不应该有能力阻止 profile 启动。
  const warnings = []
  const registered = { routes: [], tools: [] }
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    settings: {
      register: () => {
        throw new TypeError('schema is not a function')
      },
      get: () => {
        throw new Error('命名空间未注册，不应被调用')
      },
    },
    get: (name) =>
      name === 'webServer'
        ? {
            register: (route) => {
              registered.routes.push(route)
              return () => {}
            },
          }
        : name === 'tools'
          ? {
              register: (tool) => {
                registered.tools.push(tool)
                return () => {}
              },
            }
          : undefined,
    on: () => {},
    effect: (factory) => {
      factory()
    },
  }
  assert.doesNotThrow(() => plugin.apply(ctx), 'apply 不能因为 settings 注册失败而抛错')
  assert.equal(
    warnings.some((message) => message.includes('设置命名空间注册失败')),
    true,
  )
  // 降级后路由与工具仍然注册。
  assert.equal(registered.routes.length, 1)
  assert.equal(registered.tools.length, 1)
})

test('skill_manager 工具 schema 自洽：action 必填且枚举完整', async () => {
  const { sandbox, registered } = await assemble()
  try {
    const tool = registered.tools[0]
    assert.equal(tool.parameters.required.includes('action'), true)
    assert.deepEqual(tool.parameters.properties.action.enum, [
      'list',
      'roots',
      'read',
      'create',
      'update',
      'toggle',
      'rename',
      'move',
      'copy',
      'delete',
      'lint',
      'dirs',
      'addDir',
      'removeDir',
      'setDirDeep',
    ])
    // deep/create 必须是布尔参数：模型传 "true" 字符串时不能被当成非递归。
    assert.equal(tool.parameters.properties.deep.type, 'boolean')
    assert.equal(tool.parameters.properties.create.type, 'boolean')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    // presentCall 必须给出可渲染的卡片，不能返回 undefined。
    const card = tool.presentCall({ action: 'delete' })
    assert.equal(card.card, 'generic')
    assert.equal(typeof card.title, 'string')
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('skill_manager 在真实目录上 list/roots/read/create/lint 都工作', async () => {
  const { sandbox, project, registered } = await assemble()
  const originalCwd = process.cwd()
  try {
    const tool = registered.tools[0]
    process.chdir(project)

    const listed = await tool.execute({ action: 'list' }, {})
    assert.equal(listed.title.includes('demo-skill'), true)
    assert.equal(listed.title.includes('当前项目'), true)

    const roots = await tool.execute({ action: 'roots' }, {})
    assert.equal(roots.title.includes('project-dsh'), true)
    assert.equal(roots.title.includes('只读'), false, '没有一个根应被标成只读')

    const read = await tool.execute(
      { action: 'read', path: join(project, '.dsh', 'skills', 'demo-skill', 'SKILL.md') },
      {},
    )
    assert.equal(read.title.includes('demo-skill'), true)
    assert.equal(read.title.includes('ok'), true)

    const created = await tool.execute(
      {
        action: 'create',
        name: 'tool-created',
        description: 'created via the model tool',
      },
      {},
    )
    assert.equal(created.title.includes('tool-created'), true)
    assert.equal(created.path.endsWith('SKILL.md'), true)

    const lint = await tool.execute({ action: 'lint' }, {})
    assert.equal(typeof lint.title, 'string')

    // 越界路径必须抛错，而不是静默当成空技能。
    await assert.rejects(
      () => tool.execute({ action: 'read', path: join(sandbox, 'outside.md') }, {}),
      /不在任何技能根目录内/,
    )
    // 未知 action 必须抛错——而且是**参数校验**抛的（defineTool），不是 execute 里的兜底分支。
    const rejected = await tool.execute({ action: 'nope' }, {}).then(
      () => null,
      (error) => error,
    )
    assert.equal(rejected?.name, 'ToolArgsError')
    assert.match(rejected.message, /invalid arguments/)
    assert.match(rejected.message, /"action"/)
  } finally {
    process.chdir(originalCwd)
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('HTTP 路由的回环护栏放行本机、拒绝外部来源与 Host 伪装', async () => {
  const { sandbox, registered } = await assemble()
  try {
    const route = registered.routes[0]

    const loopback = await callRoute(route, {
      method: 'GET',
      url: `${plugin.API_PATH}?action=list`,
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    assert.equal(loopback.status, 200)
    assert.equal(loopback.body.ok, true)

    const ipv6Loopback = await callRoute(route, {
      method: 'GET',
      url: `${plugin.API_PATH}?action=list`,
      headers: { host: '[::1]:3080' },
      socket: { remoteAddress: '::1' },
    })
    assert.equal(ipv6Loopback.status, 200)

    const foreign = await callRoute(route, {
      method: 'GET',
      url: `${plugin.API_PATH}?action=list`,
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '10.0.0.7' },
    })
    assert.equal(foreign.status, 403)
    assert.equal(foreign.body.ok, false)

    const rebind = await callRoute(route, {
      method: 'GET',
      url: `${plugin.API_PATH}?action=list`,
      headers: { host: 'evil.example.com' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    assert.equal(rebind.status, 403)
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('HTTP 路由接受 POST JSON 并返回结构化结果', async () => {
  const { sandbox, registered } = await assemble()
  try {
    const route = registered.routes[0]
    const payload = JSON.stringify({ action: 'list' })
    const req = {
      method: 'POST',
      url: plugin.API_PATH,
      headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, handler) {
        if (event === 'data') setTimeout(() => handler(Buffer.from(payload, 'utf8')), 0)
        if (event === 'end') setTimeout(handler, 1)
        return this
      },
    }
    const result = await callRoute(route, req)
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(Array.isArray(result.body.data.roots), true)
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('HTTP 路由对非法 JSON 与未知 action 返回可读错误', async () => {
  const { sandbox, registered } = await assemble()
  try {
    const route = registered.routes[0]
    const makeReq = (payload) => ({
      method: 'POST',
      url: plugin.API_PATH,
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, handler) {
        if (event === 'data') setTimeout(() => handler(Buffer.from(payload, 'utf8')), 0)
        if (event === 'end') setTimeout(handler, 1)
        return this
      },
    })

    const broken = await callRoute(route, makeReq('{not json'))
    assert.equal(broken.status, 400)
    assert.equal(broken.body.ok, false)
    assert.equal(broken.body.error.includes('JSON'), true)

    const unknown = await callRoute(route, makeReq(JSON.stringify({ action: 'nope' })))
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.error.includes('未知 action'), true)

    // 业务错误（越界路径）也必须是 400 + 可读原因，而不是 500。
    const denied = await callRoute(route, makeReq(JSON.stringify({ action: 'read', path: 'C:/Windows/win.ini' })))
    assert.equal(denied.status, 400, `越界路径应被拒。cwd=${process.cwd()} 实际响应：${JSON.stringify(denied.body)}`)
    assert.equal(denied.body.ok, false)
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('卸载时每个 effect 的 disposer 都能干净执行', async () => {
  const { sandbox, effects, registered } = await assemble()
  try {
    // 每个注册动作都必须是本 fiber 的 effect，否则插件停用后路由/工具/提供者会残留。
    assert.equal(
      effects.length,
      registered.routes.length + registered.tools.length + registered.providers.length,
      '路由、工具、技能提供者各应有一条 effect',
    )
    assert.equal(effects.length >= 3, true)
    for (const dispose of effects) dispose()
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('skill_manager 的声明即校验：类型与枚举不符的模型参数在执行前被拒', async () => {
  // 回归：工具曾经以裸定义注册，registry 的 register() 只看 output.schema，
  // parameters 从不参与校验——模型传 status:'bogus' 会一路走进 execute。
  const { sandbox, registered } = await assemble()
  try {
    const tool = registered.tools[0]
    for (const bad of [
      { action: 'list', status: 'bogus' },
      { action: 'create', name: 42 },
      { action: 'list', deep: 'true' },
      {},
    ]) {
      const rejected = await tool.execute(bad, {}).then(
        () => null,
        (error) => error,
      )
      assert.equal(rejected?.name, 'ToolArgsError', `${JSON.stringify(bad)} 应被参数校验拒绝`)
    }
    // 同一份声明也必须原样落到给模型看的 JSON Schema 上（否则校验与广告的契约漂移）。
    const schema = registered.tools[0].parameters
    assert.equal(schema.type, 'object')
    assert.deepEqual(schema.required, ['action'])
    assert.equal(schema.properties.status.enum.includes('bogus'), false)
    assert.equal(schema.properties.deep.type, 'boolean')
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('没有 webServer / tools 服务时 apply 不抛错（优雅降级）', async () => {
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    settings: { register: () => {}, get: () => ({}) },
    get: () => undefined,
    on: () => {},
    effect: (factory) => {
      factory()
    },
  }
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.equal(
    warnings.some((message) => message.includes('webServer')),
    true,
    '缺少 webServer 应有一条警告',
  )
  assert.equal(
    warnings.some((message) => message.includes('tools')),
    true,
    '缺少 tools 也要点名，不能静默跳过注册',
  )
})
