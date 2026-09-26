// dsh-skills-manager — host half.
//
// DSH 的技能管理器。技能是磁盘上的目录（`<name>/SKILL.md`）或单文件
// （`<name>.md`），散落在 5 个根目录里，按 rank 遮蔽。官方 provider 只负责
// 「发现并加载」，坏文件会被 `logger.warn` 后**静默跳过**——你在会话目录里看
// 不出「技能不存在」和「技能被写坏了」的区别。本插件补上缺的那一半：
// 把磁盘上的技能看成可管理的对象，能诊断、能改、能开关、能搬、能删。
//
// 三块交付：
//   1. 宿主 HTTP API `/api/skills/manager`（列出/详情/新建/更新/开关/重命名/
//      移动/复制/删除/回收站），带回环来源护栏；
//   2. 模型工具 `skill_manager`，让我能在对话里直接给某类任务造技能；
//   3. 设置页 `技能管理` + 侧栏面板（client.js），给人用。
//
// 数据源：**磁盘扫描**，不是 `ctx.skills` 注册表。注册表已经被 provider 过滤过
// 一遍，用它会漏掉所有被跳过的坏技能——而那正是最需要被看到的东西。注册表只在
// 面板上做交叉核对（「DSH 当前认这些」）。
//
// 写盘全部经过 lib/store.js 的护栏：只能落在可写根目录内、禁止 `..`、禁止点开头
// 目录、临时文件 + rename 原子落盘、删除走 `<root>/.trash/<时间戳>-<名字>` 可恢复。
//
// 保真：只改正文时 frontmatter 逐字节保留；改字段时只重写那一行。注释、键顺序、
// 本插件读不懂的结构都活着。

import { homedir } from 'node:os'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
// 工具定义必须走 defineTool：`parameters` 是给模型看的 JSON Schema，也是执行前的参数校验
// （registry 的 register() 只检查 output.schema，从不看 parameters）。手写裸定义等于把
// 校验留在门外——声明与执行各写一份，早晚漂移。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MAX_SKILL_FILE_BYTES, defaultSkillBody, renderSkillPanel, summarize } from './lib/logic.js'
import { SkillManagerSchema } from './lib/schema.js'
import { createSkillProviderFactory } from './lib/provider.js'
import {
  buildContext,
  copySkill as copySkillFile,
  createSkill as createSkillFile,
  deleteSkill as deleteSkillFile,
  listSkills,
  listTrash,
  moveSkill as moveSkillFile,
  readSkill,
  renameSkill as renameSkillFile,
  toggleSkill as toggleSkillFile,
  updateSkill as updateSkillFile,
} from './lib/store.js'

export const name = 'dsh-skills-manager'
// settings 是硬依赖：没有它就没有可写入的技能根目录。
export const inject = ['settings']

/**
 * 本插件自己的 Config。DSH 0.1.7 的 settings 由它投影而来：技能根目录那几个
 * 数组字段是 volatile 的，因此设置页可以就地改写它们而不重挂插件。
 */
export const Config = SkillManagerSchema

/** HTTP API 路径（客户端按这个常量调用）。 */
export const API_PATH = '/api/skills/manager'
/** 模型工具名。 */
export const TOOL_NAME = 'skill_manager'
/**
 * 本插件在 profile 里的默认条目 id（cordis.patch.yml 里的那一行）。
 *
 * 0.1.7 的表单按 **loader 条目 id** 定位，运行时以 `ctx.fiber.entry.id` 为准；
 * 这个常量只作为无 loader 载体（单测）与文档的兜底名。
 */
export const SETTINGS_NS = 'skill-manager'
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

/**
 * 本插件 Config 声明的字段名，用来按**值形状**认领设置条目。
 *
 * schemastery 把子 schema 挂在 `dict` 上，所以直接从 Config 取就是权威清单——
 * 加字段不会忘了同步这里。
 */
const DECLARED_KEYS = new Set(Object.keys(SkillManagerSchema.dict ?? {}))

/**
 * 「可编辑列表字段」中至少要命中一个，才算认出了自己的条目。
 * 只靠「键都在我声明的集合里」不够：一个空对象能匹配任何 schema。
 */
const EDITABLE_LIST_KEYS = ['customSkillDirs', 'deepSkillDirs', 'projects']

/**
 * 从 `settings.describe()` 的条目列表里认出**本插件自己的条目**。
 *
 * 为什么不能按名字找：0.1.7 的设置 ns 就是 loader 条目 id，而那个 id 由挂载本
 * 插件的那一行决定。同一个包在根下挂是 `dsh-skills-manager`，挂在 `include`
 * 分组下就变成 `include:dsh-skills-manager`。把 id 当标识，换个挂载方式就写到
 * 别的 ns 上，宿主直接回
 * `No configurable plugin entry "include:dsh-skills-manager"`。
 *
 * 改成按形状认领：条目值里的键必须**全部**落在我声明的字段里，且至少带一个
 * 可编辑列表字段。实测（宿主 21 个条目）只有本插件的条目满足，其余 20 个的键
 * 都不同。认领成功后用描述符自己的 `ns` 去写，于是无论挂在哪一层都对。
 *
 * 两档优先，且**同档多个候选时拒绝**——宁可报「认不出」也不赌一个写上去：
 *   1. 键集恰好等于声明键（某些宿主会把默认值也投影进来）
 *   2. 只有列表字段（宿主只投影用户设过的键，这是常见形态）
 *
 * 导出给测试直接断言，不必经过装配路径。
 *
 * @param {Array<{ns: string, value?: unknown}>} list describe() 返回的条目
 * @returns {{ns: string, value: object, revision?: unknown} | undefined} 本插件的条目
 */
export function claimEntry(list) {
  if (!Array.isArray(list)) return undefined
  const candidates = []
  for (const entry of list) {
    if (entry === null || entry === undefined) continue
    const value = entry.value
    if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) continue
    const keys = Object.keys(value)
    if (keys.length === 0) continue
    let foreign = false
    for (const key of keys) {
      if (!DECLARED_KEYS.has(key)) {
        foreign = true
        break
      }
    }
    if (foreign) continue
    if (!EDITABLE_LIST_KEYS.some((key) => keys.includes(key))) continue
    candidates.push({ entry, exact: keys.length === DECLARED_KEYS.size })
  }
  if (candidates.length === 0) return undefined
  const exact = candidates.filter((c) => c.exact)
  if (exact.length === 1) return exact[0].entry
  if (exact.length > 1) return undefined
  return candidates.length === 1 ? candidates[0].entry : undefined
}

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文
 * @param {object} [config] Loader 解析后的本插件 Config（0.1.7 起由 Cordis 传入）
 */
export function apply(ctx, config) {
  /**
   * 认领到的条目名（= 宿主认的设置 ns）。第一次成功认领后缓存。
   *
   * 不预先猜：认领之前谁都不知道自己被挂在哪一层。写入前一定先认领一次。
   */
  let claimedNs = null

  /**
   * `config.entryId` 只在**认领不到**时当兜底（手搭内存 cordis 的测试载体）。
   *
   * 它不是生产路径：真实宿主总能认出条目，因为 describe() 里必然有本插件那一行。
   */
  const fallbackId = () => (typeof config?.entryId === 'string' && config.entryId !== '' ? config.entryId : SETTINGS_NS)

  /**
   * 读一个 volatile 数组字段：Loader 把它包成引用，`.get()` 永远是最新快照。
   * 非 volatile（无引用）时退回普通数组值。
   */
  const readList = (field) => {
    const value = config?.[field]
    const raw = value !== null && value !== undefined && typeof value.get === 'function' ? value.get() : value
    return Array.isArray(raw) ? raw : []
  }

  /**
   * 读取当前设置（缺字段用默认值兜底，避免半截配置把管理器打挂）。
   * @returns {{cwd: string, customSkillDirs: string[], deepSkillDirs: string[], bundledSkillDir: string, projects: string[], inventory: boolean}} 配置
   */
  const readConfig = () => ({
    cwd: process.cwd(),
    customSkillDirs: readList('customSkillDirs'),
    deepSkillDirs: readList('deepSkillDirs'),
    bundledSkillDir: typeof config?.bundledSkillDir === 'string' ? config.bundledSkillDir : '',
    projects: readList('projects'),
    // 缺字段（老配置）按「登记」处理：只有显式 false 才不登记。
    inventory: config?.inventory !== false,
  })

  // ── 把管理的技能登记给 DSH ────────────────────────────────────────────────
  // 官方 provider 只扫**它自己配置里**的根，管理器面板添加的目录它根本不知道。
  // 不注册这个提供者的话，面板列出的技能就是「看得见、用不上」——详见 lib/provider.js。
  //
  // 只在这里注册一次：Cordis 的 effect 是单向的，注册之后没有"取消注册"的干净途径。
  // inventory 开关因此做成**动态**的——由提供者 list() 自己读配置决定要不要出候选，
  // 切开关立刻生效，且不需要拆装 fiber。
  // 注册表在注册时递回 `{signal, invalidate}`；留着它，写完盘后让 DSH 重扫目录。
  // 本 provider 没有文件 watcher，而注册表的目录缓存是按 revision 键控的——磁盘
  // 变化不会自己 bump revision。不主动失效的话，面板里删掉的技能仍在目录里被广告
  // （模型加载它就会撞上注册表的内部 TypeError），刚建好的技能也进不去。
  let skillProviderControl = null
  {
    const skillsService = ctx.get('skills')
    if (skillsService === undefined || typeof skillsService.registerProvider !== 'function') {
      ctx.logger.warn('dsh-skills-manager: skills 服务不可用，管理器里的技能不会进入 DSH 目录（只能在面板查看）')
    } else {
      ctx.effect(
        () =>
          skillsService.registerProvider(
            createSkillProviderFactory(readConfig, {
              onWarn: (message) => ctx.logger.warn(`dsh-skills-manager: ${message}`),
              onControl: (control) => {
                skillProviderControl = control
              },
            }),
          ),
        'dsh-skills-manager: skill provider',
      )
    }
  }

  /**
   * 让 DSH 的技能目录立刻重扫。**只由写操作调用**——读操作失效等于把目录抖动
   * 放大到每次刷新上。
   *
   * 失败只记日志：写盘已经成功了，「目录短暂陈旧」不该把一次成功的写操作变成错误。
   * 服务不可用（没注册上 provider）时静默跳过。
   */
  const notifySkillsChanged = () => {
    const control = skillProviderControl
    if (control === null || typeof control.invalidate !== 'function') return
    try {
      control.invalidate()
    } catch (error) {
      ctx.logger.warn(`dsh-skills-manager: 技能目录失效失败，DSH 会短暂看到旧目录：${String(error?.message ?? error)}`)
    }
  }

  /**
   * 给会改磁盘的写函数套上一层「写完就通知 DSH 重扫」。
   *
   * 放在这里而不是散进 handle() 与模型工具的两套 switch：写盘只有这几个入口，
   * 兜住入口，两条调用路径（HTTP 面板 / 模型工具）就都覆盖到了，以后加动作也不会漏。
   * 抛错时不通知——什么都没改成，重扫只是白费。
   * @param {Function} write lib/store.js 里的写函数
   * @returns {Function} 包好的写函数
   */
  const rescansAfterWrite =
    (write) =>
    async (...args) => {
      const result = await write(...args)
      notifySkillsChanged()
      return result
    }
  const createSkill = rescansAfterWrite(createSkillFile)
  const updateSkill = rescansAfterWrite(updateSkillFile)
  const toggleSkill = rescansAfterWrite(toggleSkillFile)
  const renameSkill = rescansAfterWrite(renameSkillFile)
  const moveSkill = rescansAfterWrite(moveSkillFile)
  const copySkill = rescansAfterWrite(copySkillFile)
  const deleteSkill = rescansAfterWrite(deleteSkillFile)

  /**
   * 一次完整的「拿上下文 + 列技能」，顺带和注册表做交叉核对。
   * @returns {Promise<object>} 面板数据
   */
  const snapshot = async () => {
    const config = readConfig()
    const context = await buildContext(config)
    const { skills, summary } = await listSkills(context)
    // 注册表只做交叉核对：它答「DSH 现在认哪些」，磁盘答「文件在哪、坏没坏」。
    let registry = null
    const skillsService = ctx.get('skills')
    if (skillsService !== undefined && typeof skillsService.list === 'function') {
      try {
        const listed = await skillsService.list({ cwd: config.cwd })
        // 只报「本该被登记、却不在目录里」的。官方 provider 自己的根不在管理器管辖
        // 范围内，拿它们做差集只会产出上百条无意义告警——那正是之前那行提示的问题。
        const registryNames = new Set((Array.isArray(listed) ? listed : []).map((entry) => entry.name))
        const pending = config.inventory
          ? skills
              .filter((skill) => skill.status !== 'broken' && !registryNames.has(skill.name))
              .map((skill) => skill.name)
              .sort()
          : []
        registry = {
          inventory: config.inventory,
          // 未登记时，磁盘上的技能对 DSH 不可见——这个事实必须明确写出来，
          // 而不是让用户看到一句含糊的"watcher 延迟"。
          unmanagedCount: config.inventory ? 0 : skills.filter((skill) => skill.status !== 'broken').length,
          pendingRegistration: pending,
          loadedCount: registryNames.size,
          registryError: null,
        }
      } catch (error) {
        registry = {
          inventory: config.inventory,
          unmanagedCount: 0,
          pendingRegistration: [],
          loadedCount: 0,
          registryError: String(error?.message ?? error),
        }
      }
    }
    return {
      cwd: config.cwd.replace(/\\/g, '/'),
      projectRoots: context.projectRoots.map((value) => value.replace(/\\/g, '/')),
      roots: context.roots,
      skills,
      summary,
      registry,
      home: homedir().replace(/\\/g, '/'),
    }
  }
  // 面板刷新按钮会打这个接口，HTTP 层直接复用同一个函数。
  /** 取一条技能所在的可写根目录列表（移动/复制的目标候选）。 */
  const writableRoots = (data) => data.roots.filter((root) => root.writable && root.exists !== false)

  // ── 自定义技能文件夹 ──────────────────────────────────────────────────────
  // 用户目录（rank 300）的读写。自定义目录存在本插件的 Config 里，所以
  // 「添加/移除」本质是一次 settings 表单写入；写完之后 buildContext 下次就会把
  // 新根扫进来。

  /**
   * 认领本插件的设置条目，并记下宿主认的那个 ns。
   *
   * @returns {{ns: string, value: object|undefined, revision: unknown, claimed: boolean}}
   */
  const resolveEntry = () => {
    if (typeof ctx.settings?.describe !== 'function') {
      return { ns: claimedNs ?? fallbackId(), value: undefined, revision: undefined, claimed: false }
    }
    const descriptor = claimEntry(ctx.settings.describe())
    if (descriptor === undefined) {
      // 认领不到只可能是非 loader 载体（测试的内存 cordis）或宿主还没登记。
      // 此时退回显式 id——**这不是生产路径**，真实宿主的 describe() 里必有本条目。
      return { ns: claimedNs ?? fallbackId(), value: undefined, revision: undefined, claimed: false }
    }
    claimedNs = descriptor.ns
    return { ns: descriptor.ns, value: descriptor.value, revision: descriptor.revision, claimed: true }
  }

  /**
   * 读本条目当前的 {value, revision}；拿不到时两者都是 undefined。
   *
   * 0.1.7 的 `describe()` 返回**当前可编辑的表单值**（已按 schema 归一化），
   * 正好可以拿来重建整个 section。
   */
  const readSettings = () => {
    const entry = resolveEntry()
    return { value: entry.value, revision: entry.revision }
  }

  /** 设置项的写入是否可用（provider 可能是只读的）。 */
  const settingsWritable = () =>
    typeof ctx.settings?.replace === 'function' && ctx.settings.writable !== false

  /**
   * 用 build 的结果整体替换本插件的配置 section，并在 revision 冲突时重试。
   *
   * `SettingsPathOp` 只支持 {op:'set'|'unset', path}，按路径整键替换，**没有
   * 数组追加语义**——多个窗口同时加目录时只能靠 expectedRevision 冲突重试，
   * 以最后一次读到的值重建列表。所以这里必须重读，而不是复用调用方传入的旧列表。
   *
   * @param {(current: object) => object} build 由当前值算出下一个 section
   * @returns {Promise<object>} 写入后的解析值
   * @throws {Error} 表单只读、未登记或多次冲突
   */
  const writeSettings = async (build) => {
    if (!settingsWritable()) {
      throw new Error('设置当前不可写（settings provider 只读），无法保存自定义文件夹')
    }
    let lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // 每次都重新认领：宿主认的 ns 可能因为重挂载而变（根下 ↔ include 分组下），
      // 缓存一个名字去写就是原来的 bug。
      const entry = resolveEntry()
      const value = entry.value
      const current = value !== null && value !== undefined && typeof value === 'object' ? value : {}
      const next = build({ ...current })
      try {
        await ctx.settings.replace(entry.ns, next, entry.revision)
        // 这份 section 装的只有技能根目录（customSkillDirs / deepSkillDirs），改根
        // 就是改技能集合——和写技能文件一样，得让 DSH 重扫。
        notifySkillsChanged()
        const after = resolveEntry()
        return after.value ?? next
      } catch (error) {
        lastError = error
        // 只有 revision 冲突值得重试；其余（只读、校验失败）直接冒泡。
        // code 是 SettingsConflictError 上标着「稳定机器码」的那个字段（文档说它专给
        // 线上层做分类映射），所以它才是该认的那个值；name 只留作兜底。以前这里写的是
        // 'conflict'——一个不存在的值，等于整条重试路径只靠 name 撑着。
        const conflict = error?.code === 'SETTINGS_CONFLICT' || error?.name === 'SettingsConflictError'
        if (!conflict) throw error
      }
    }
    throw new Error(`设置被并发修改，重试 ${3} 次仍未成功：${String(lastError?.message ?? lastError)}`)
  }

  /** 去掉首尾空白与包裹的引号，并展开 `~`。 */
  const normalizeDir = (input) => {
    let value = String(input ?? '').trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value === '~') return homedir()
    if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
    return value
  }

  /** Windows 路径不区分大小写。 */
  const samePath = (left, right) => {
    const normalize = (value) => {
      const resolved = resolvePath(value)
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved
    }
    return normalize(left) === normalize(right)
  }

  /**
   * 校验一个待添加的目录并给出规范路径。
   * @param {string} input 用户输入或选择器返回的路径
   * @param {{create?: boolean}} options create=true 时允许创建不存在的目录
   * @returns {{path: string, created: boolean}} 规范路径与是否新建
   * @throws {Error} 路径非法、不存在且不允许创建、或不是目录
   */
  const resolveNewDir = (input, options = {}) => {
    const raw = normalizeDir(input)
    if (raw === '') throw new Error('目录不能为空')
    if (!isAbsolute(raw)) throw new Error('请填绝对路径（例如 E:/work/skills）')
    const target = resolvePath(raw)
    if (basename(target) === '') throw new Error('不能把盘符根目录当成技能文件夹')
    if (samePath(target, process.cwd()))
      throw new Error('不建议把整个项目目录当成技能文件夹（技能只认一层，会误扫其它文件）')

    if (existsSync(target)) {
      if (!statSync(target).isDirectory()) throw new Error(`不是目录：${target}`)
      return { path: target, created: false }
    }
    if (options.create !== true) {
      throw new Error(`目录不存在：${target}`)
    }
    const parent = dirname(target)
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new Error(`无法创建：上级目录不存在（${parent}）。请先建好上级目录。`)
    }
    mkdirSync(target, { recursive: true })
    return { path: target, created: true }
  }

  /**
   * 把一组技能条目按「来源根目录」计数，供自定义文件夹列表展示。
   * @param {Array<object>} skills 技能条目
   * @param {string} rootPath 根目录
   * @returns {number} 该根下的技能数
   */
  const countUnder = (skills, rootPath) =>
    skills.filter((skill) => {
      const skillPath = String(skill.path ?? '')
      const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
      return skillPath === root || skillPath.startsWith(`${root}/`)
    }).length

  /**
   * 处理一次 API 调用。所有分支都返回可 JSON 化的普通对象。
   * @param {unknown} payload 请求体
   * @returns {Promise<{status: number, body: object}>} 响应
   */
  const handle = async (payload) => {
    const request = payload !== null && typeof payload === 'object' ? payload : {}
    const action = typeof request.action === 'string' ? request.action : 'list'
    try {
      const config = readConfig()
      switch (action) {
        case 'list':
          return { status: 200, body: { ok: true, data: await snapshot() } }

        case 'read': {
          const context = await buildContext(config)
          const detail = await readSkill(context, request.path)
          return { status: 200, body: { ok: true, data: { skill: detail } } }
        }

        case 'lint': {
          const data = await snapshot()
          return {
            status: 200,
            body: {
              ok: true,
              data: {
                summary: summarize(data.skills),
                problems: data.skills
                  .filter((skill) => skill.status !== 'ok')
                  .map((skill) => ({ name: skill.name, path: skill.path, status: skill.status, issues: skill.issues })),
              },
            },
          }
        }

        // 自定义技能文件夹（rank 300）：列表 / 添加 / 移除 / 原生选目录。
        case 'dirs': {
          const data = await snapshot()
          return {
            status: 200,
            body: {
              ok: true,
              data: {
                writable: settingsWritable(),
                dirs: [
                  ...config.customSkillDirs.map((dir) => ({ dir, deep: false })),
                  ...config.deepSkillDirs.map((dir) => ({ dir, deep: true })),
                ].map(({ dir, deep }) => ({
                  path: resolvePath(dir).replace(/\\/g, '/'),
                  exists: existsSync(dir),
                  deep,
                  skillCount: countUnder(data.skills, dir),
                })),
              },
            },
          }
        }

        case 'addDir': {
          const { path: target, created } = resolveNewDir(request.path, { create: request.create === true })
          const deep = request.deep === true
          // 两个列表合起来去重：同一个目录被扫两遍只会让技能重复出现。
          const allDirs = [...readConfig().customSkillDirs, ...readConfig().deepSkillDirs]
          if (allDirs.some((dir) => samePath(dir, target))) throw new Error(`已经在列表里了：${target}`)
          const context = await buildContext(config)
          if (context.roots.some((root) => samePath(root.path, target) && root.source !== 'custom')) {
            throw new Error(`这个目录已经是内置技能根（${target}）`)
          }
          const next = await writeSettings((current) => ({
            ...current,
            // 放进哪个列表由 deep 决定，并把它从另一个列表里摘掉，保证两表互斥。
            customSkillDirs: deep
              ? (Array.isArray(current.customSkillDirs) ? current.customSkillDirs : []).filter(
                  (dir) => !samePath(dir, target),
                )
              : [...(Array.isArray(current.customSkillDirs) ? current.customSkillDirs : []), target],
            deepSkillDirs: deep
              ? [...(Array.isArray(current.deepSkillDirs) ? current.deepSkillDirs : []), target]
              : (Array.isArray(current.deepSkillDirs) ? current.deepSkillDirs : []).filter(
                  (dir) => !samePath(dir, target),
                ),
          }))
          const { skills } = await listSkills(await buildContext(readConfig()))
          return {
            status: 200,
            body: {
              ok: true,
              data: {
                path: target.replace(/\\/g, '/'),
                created,
                deep,
                skillCount: countUnder(skills, target),
                dirs: [...(next.customSkillDirs ?? []), ...(next.deepSkillDirs ?? [])],
              },
            },
          }
        }

        case 'removeDir': {
          const target = normalizeDir(request.path)
          if (target === '') throw new Error('缺少要移除的目录')
          const before = [...readConfig().customSkillDirs, ...readConfig().deepSkillDirs]
          if (!before.some((dir) => samePath(dir, target))) {
            throw new Error(`列表里没有这个目录：${target}`)
          }
          const next = await writeSettings((current) => ({
            ...current,
            customSkillDirs: (Array.isArray(current.customSkillDirs) ? current.customSkillDirs : []).filter(
              (dir) => !samePath(dir, target),
            ),
            deepSkillDirs: (Array.isArray(current.deepSkillDirs) ? current.deepSkillDirs : []).filter(
              (dir) => !samePath(dir, target),
            ),
          }))
          return {
            status: 200,
            body: {
              ok: true,
              data: {
                removed: target.replace(/\\/g, '/'),
                // 只解除管理，**不动磁盘上的任何文件**——移除一个根不应该删技能。
                note: '已从管理器移除；目录与其中的技能文件均未改动。',
                dirs: [...(next.customSkillDirs ?? []), ...(next.deepSkillDirs ?? [])],
              },
            },
          }
        }

        case 'setDirDeep': {
          // 就地切换某个已添加目录的扫描方式；避免用户为了改模式而先删再加。
          const target = normalizeDir(request.path)
          const deep = request.deep === true
          const before = [...readConfig().customSkillDirs, ...readConfig().deepSkillDirs]
          if (!before.some((dir) => samePath(dir, target))) throw new Error(`列表里没有这个目录：${target}`)
          const next = await writeSettings((current) => ({
            ...current,
            customSkillDirs: deep
              ? (Array.isArray(current.customSkillDirs) ? current.customSkillDirs : []).filter(
                  (dir) => !samePath(dir, target),
                )
              : [
                  ...(Array.isArray(current.customSkillDirs) ? current.customSkillDirs : []).filter(
                    (dir) => !samePath(dir, target),
                  ),
                  target,
                ],
            deepSkillDirs: deep
              ? [
                  ...(Array.isArray(current.deepSkillDirs) ? current.deepSkillDirs : []).filter(
                    (dir) => !samePath(dir, target),
                  ),
                  target,
                ]
              : (Array.isArray(current.deepSkillDirs) ? current.deepSkillDirs : []).filter(
                  (dir) => !samePath(dir, target),
                ),
          }))
          const { skills } = await listSkills(await buildContext(readConfig()))
          return {
            status: 200,
            body: {
              ok: true,
              data: {
                path: target.replace(/\\/g, '/'),
                deep,
                skillCount: countUnder(skills, target),
                dirs: [...(next.customSkillDirs ?? []), ...(next.deepSkillDirs ?? [])],
              },
            },
          }
        }

        case 'pickDir': {
          // 原生选择器是宿主侧能力（@Remote 方法本身就是普通方法），但只在
          // capability.kind === 'native' 的组装里可用；否则明确告诉前端改用输入框。
          const picker = ctx.get('directoryPickerController')
          if (picker === undefined || typeof picker.pick !== 'function') {
            return { status: 200, body: { ok: true, data: { supported: false } } }
          }
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000)
          try {
            const picked = await picker.pick(controller.signal)
            return { status: 200, body: { ok: true, data: { supported: true, path: picked ?? null } } }
          } catch (error) {
            return {
              status: 200,
              body: {
                ok: true,
                data: { supported: false, error: String(error?.message ?? error) },
              },
            }
          } finally {
            clearTimeout(timer)
          }
        }

        case 'create': {
          const context = await buildContext(config)
          const created = await createSkill(context, {
            name: request.name,
            description: request.description,
            whenToUse: request.whenToUse,
            modelInvocable: request.modelInvocable,
            userInvocable: request.userInvocable,
            body: request.body,
            rootPath: request.rootPath,
            kind: request.kind,
          })
          return { status: 200, body: { ok: true, data: created } }
        }

        case 'update': {
          const context = await buildContext(config)
          const result = await updateSkill(context, {
            path: request.path,
            fields: request.fields,
            body: request.body,
            frontmatter: request.frontmatter,
            expectedText: request.expectedText,
          })
          return { status: 200, body: { ok: true, data: result } }
        }

        case 'toggle': {
          const context = await buildContext(config)
          const result = await toggleSkill(context, {
            path: request.path,
            modelInvocable: request.modelInvocable,
            userInvocable: request.userInvocable,
          })
          return { status: 200, body: { ok: true, data: result } }
        }

        case 'rename': {
          const context = await buildContext(config)
          const result = await renameSkill(context, {
            path: request.path,
            kind: request.kind,
            newName: request.newName,
          })
          return { status: 200, body: { ok: true, data: result } }
        }

        case 'move': {
          const context = await buildContext(config)
          const result = await moveSkill(context, {
            path: request.path,
            kind: request.kind,
            targetRoot: request.targetRoot,
          })
          return { status: 200, body: { ok: true, data: result } }
        }

        case 'copy': {
          const context = await buildContext(config)
          const result = await copySkill(context, {
            path: request.path,
            kind: request.kind,
            targetRoot: request.targetRoot,
            newName: request.newName,
          })
          return { status: 200, body: { ok: true, data: result } }
        }

        case 'delete': {
          const context = await buildContext(config)
          const result = await deleteSkill(context, { path: request.path, kind: request.kind })
          return { status: 200, body: { ok: true, data: result } }
        }

        case 'trash': {
          const context = await buildContext(config)
          const items = await listTrash(context, request.rootPath)
          return { status: 200, body: { ok: true, data: { items } } }
        }

        case 'template': {
          const body = defaultSkillBody({
            name: typeof request.name === 'string' && request.name !== '' ? request.name : 'my-skill',
            description:
              typeof request.description === 'string' && request.description !== ''
                ? request.description
                : '（一句话说明这个技能做什么、什么时候用）',
          })
          return { status: 200, body: { ok: true, data: { body } } }
        }

        case 'targets': {
          const data = await snapshot()
          return { status: 200, body: { ok: true, data: { roots: writableRoots(data), skills: data.skills } } }
        }

        default:
          return { status: 400, body: { ok: false, error: `未知 action：${action}` } }
      }
    } catch (error) {
      return { status: 400, body: { ok: false, error: String(error?.message ?? error) } }
    }
  }

  registerHttpApi(ctx, handle)

  // ── 模型工具 ──────────────────────────────────────────────────────────────
  // 给模型一条自己造/改技能的通道：某一类任务反复出现时，把做法固化成技能，
  // 下一轮就不用重新解释。删改都走同一套护栏与回收站。
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx.logger.warn('dsh-skills-manager: tools 服务不可用，模型用不到 skill_manager 工具（界面与 HTTP API 照常工作）')
  } else {
    ctx.effect(
      () =>
        tools.register(
          defineTool({
            name: TOOL_NAME,
            description:
              '管理 DSH 技能（可复用的任务指令，DSH 按需加载）。' +
              'action=list 列出磁盘上的全部技能，含诊断（哪些会被 DSH 静默跳过）、层与遮蔽关系；' +
              'action=roots 列出技能根目录；action=read 读一条技能（需 path）；' +
              'action=create 新建（需 name/description，可选 rootPath/kind/whenToUse/body/modelInvocable/userInvocable）；' +
              'action=update 改字段或正文（需 path，可选 fields/body）；' +
              'action=toggle 开关模型可见与 `/` 可见（需 path + modelInvocable/userInvocable）；' +
              'action=rename/move/copy/delete 走同一套护栏，delete 是可恢复的移入回收站；' +
              'action=dirs 列出自定义技能文件夹；action=addDir/removeDir 增删自定义文件夹' +
              '（需 path；目录不存在时 addDir 传 create:true 会创建它；' +
              '技能库是「仓库式」布局、技能藏在更深的层级时，addDir/setDirDeep 传 deep:true 递归查找）。' +
              'path 取 list 结果里的字段。新建前先 list，避免同名遮蔽。',
            // 「隐式参数对象」形态：每个键一个参数节点，必填写在节点上。这一份声明同时编译成
            // 给模型看的 JSON Schema 与 execute 前的参数校验，所以校验不会与声明漂移。
            parameters: {
              action: {
                type: 'string',
                required: true,
                enum: [
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
                ],
              },
              create: { type: 'boolean', description: 'addDir 时目录不存在是否创建' },
              deep: {
                type: 'boolean',
                description: 'addDir/setDirDeep：true = 递归查找任意层级的 SKILL.md（最多 3 层）',
              },
              path: { type: 'string', description: '技能文件绝对路径（list 结果里的 path 字段）' },
              name: { type: 'string', description: '技能名，kebab-case' },
              description: { type: 'string', description: '一句话说明：做什么、什么时候用' },
              whenToUse: { type: 'string' },
              body: { type: 'string', description: '技能正文（Markdown）；create 时省略则写入骨架' },
              rootPath: { type: 'string', description: 'create 的目标根目录（roots 结果里的 path）' },
              kind: { type: 'string', enum: ['bundle', 'flat'], description: 'bundle=<name>/SKILL.md；flat=<name>.md' },
              modelInvocable: { type: 'boolean', description: 'false = 对模型隐藏' },
              userInvocable: { type: 'boolean', description: 'false = 对 `/` 命令隐藏' },
              newName: { type: 'string', description: 'rename/copy 的新名字' },
              targetRoot: { type: 'string', description: 'move/copy 的目标根目录' },
              status: { type: 'string', enum: ['all', 'ok', 'warning', 'broken'], description: 'list 的过滤条件' },
            },
            output: {
              // 值 schema 的开放性必须显式写出来（dsh-tools 不给对象节点默认值）。
              schema: { type: 'object', additionalProperties: true },
              render(_args, value) {
                const text =
                  value !== null && typeof value === 'object' && typeof value.title === 'string'
                    ? value.title
                    : '技能管理器'
                return [{ type: 'text', text }]
              },
            },
            execute: async (args) => {
              const action = typeof args?.action === 'string' ? args.action : 'list'
              if (action === 'list' || action === 'lint' || action === 'roots') {
                const data = await snapshot()
                if (action === 'roots') {
                  const lines = data.roots.map(
                    (root) =>
                      `- [${root.source} rank=${root.rank}] ${root.path}` +
                      `${root.writable ? '' : '（只读）'}${root.exists ? ` 技能 ${root.skillCount} 个` : '（目录不存在）'}`,
                  )
                  return {
                    title: `技能根目录（${data.roots.length}）\n${lines.join('\n')}\n\n当前项目：${data.cwd}`,
                    action,
                  }
                }
                const filtered =
                  action === 'lint'
                    ? data.skills.filter((skill) => skill.status !== 'ok')
                    : args?.status && args.status !== 'all'
                      ? data.skills.filter((skill) => skill.status === args.status)
                      : data.skills
                const panel = renderSkillPanel(filtered, {
                  roots: data.roots,
                  projectRoot: data.cwd,
                  summary: action === 'lint' ? summarize(data.skills) : data.summary,
                })
                const extra = []
                if (action === 'lint' && filtered.length === 0) extra.push('所有技能都能被 DSH 正常加载。')
                if (data.registry?.registryError) extra.push(`注册表读取失败：${data.registry.registryError}`)
                if (data.registry && data.registry.inventory === false && data.registry.unmanagedCount > 0) {
                  extra.push(
                    `注意：技能登记已关闭（inventory=false），这 ${data.registry.unmanagedCount} 个技能只在面板可见，` +
                      'DSH 不会加载它们，模型也用不到。要启用就把设置里的 inventory 打开。',
                  )
                }
                if (data.registry && data.registry.pendingRegistration?.length > 0) {
                  extra.push(
                    `磁盘上有、但还没进入 DSH 目录（提供者刷新延迟）：${data.registry.pendingRegistration.join(', ')}`,
                  )
                }
                return { title: [panel, ...extra].join('\n\n'), action }
              }

              const config = readConfig()
              const context = await buildContext(config)
              switch (action) {
                // 自定义技能文件夹：这几个走 settings 读写，不涉及技能文件本身。
                case 'dirs': {
                  const entries = [
                    ...config.customSkillDirs.map((dir) => ({ dir, deep: false })),
                    ...config.deepSkillDirs.map((dir) => ({ dir, deep: true })),
                  ]
                  const data = await listSkills(context)
                  if (entries.length === 0) {
                    return {
                      title:
                        '还没有配置自定义技能文件夹。\n' +
                        '用 addDir（给 path，必要时 create:true）添加一个目录；它会被当作 rank 300 的技能根。\n' +
                        '若目录是「仓库式技能库」（技能在 <集合>/skills/<名字>/SKILL.md 这种更深的层级），' +
                        '加 addDir 参数 deep:true 递归查找。',
                      action,
                    }
                  }
                  const lines = entries.map(
                    ({ dir, deep }) =>
                      `- [${deep ? '递归' : '一层'}] ${resolvePath(dir).replace(/\\/g, '/')}` +
                      `（${existsSync(dir) ? `技能 ${countUnder(data.skills, dir)} 个` : '目录不存在'}）`,
                  )
                  return { title: `自定义技能文件夹（${entries.length}）\n${lines.join('\n')}`, action }
                }
                case 'addDir': {
                  const { path: target, created } = resolveNewDir(args?.path, { create: args?.create === true })
                  const deep = args?.deep === true
                  const allDirs = [...config.customSkillDirs, ...config.deepSkillDirs]
                  if (allDirs.some((dir) => samePath(dir, target))) throw new Error(`已经在列表里了：${target}`)
                  if (context.roots.some((root) => samePath(root.path, target) && root.source !== 'custom')) {
                    throw new Error(`这个目录已经是内置技能根：${target}`)
                  }
                  await writeSettings((current) => ({
                    ...current,
                    customSkillDirs: deep
                      ? (Array.isArray(current.customSkillDirs) ? current.customSkillDirs : []).filter(
                          (dir) => !samePath(dir, target),
                        )
                      : [...(Array.isArray(current.customSkillDirs) ? current.customSkillDirs : []), target],
                    deepSkillDirs: deep
                      ? [...(Array.isArray(current.deepSkillDirs) ? current.deepSkillDirs : []), target]
                      : (Array.isArray(current.deepSkillDirs) ? current.deepSkillDirs : []).filter(
                          (dir) => !samePath(dir, target),
                        ),
                  }))
                  return {
                    title:
                      `已添加自定义技能文件夹${created ? '（目录是新建的）' : ''}（${deep ? '递归' : '一层'}扫描）：\n` +
                      `${target.replace(/\\/g, '/')}\n` +
                      '下一次 list 就会扫到它。它按 rank 300 参与遮蔽：同名技能低于项目层、高于用户层。',
                    action,
                  }
                }
                case 'removeDir': {
                  const target = normalizeDir(args?.path)
                  if (![...config.customSkillDirs, ...config.deepSkillDirs].some((dir) => samePath(dir, target))) {
                    throw new Error(`列表里没有这个目录：${target}`)
                  }
                  await writeSettings((current) => ({
                    ...current,
                    customSkillDirs: (Array.isArray(current.customSkillDirs) ? current.customSkillDirs : []).filter(
                      (dir) => !samePath(dir, target),
                    ),
                    deepSkillDirs: (Array.isArray(current.deepSkillDirs) ? current.deepSkillDirs : []).filter(
                      (dir) => !samePath(dir, target),
                    ),
                  }))
                  return {
                    title: `已从管理器移除：${target.replace(/\\/g, '/')}\n目录与其中的技能文件都没有被改动。`,
                    action,
                  }
                }
                case 'setDirDeep': {
                  const target = normalizeDir(args?.path)
                  const deep = args?.deep === true
                  if (![...config.customSkillDirs, ...config.deepSkillDirs].some((dir) => samePath(dir, target))) {
                    throw new Error(`列表里没有这个目录：${target}`)
                  }
                  await writeSettings((current) => ({
                    ...current,
                    customSkillDirs: deep
                      ? (Array.isArray(current.customSkillDirs) ? current.customSkillDirs : []).filter(
                          (dir) => !samePath(dir, target),
                        )
                      : [
                          ...(Array.isArray(current.customSkillDirs) ? current.customSkillDirs : []).filter(
                            (dir) => !samePath(dir, target),
                          ),
                          target,
                        ],
                    deepSkillDirs: deep
                      ? [
                          ...(Array.isArray(current.deepSkillDirs) ? current.deepSkillDirs : []).filter(
                            (dir) => !samePath(dir, target),
                          ),
                          target,
                        ]
                      : (Array.isArray(current.deepSkillDirs) ? current.deepSkillDirs : []).filter(
                          (dir) => !samePath(dir, target),
                        ),
                  }))
                  return {
                    title: `${target.replace(/\\/g, '/')} 已切换为「${deep ? '递归（最多 3 层）' : '一层'}」扫描。`,
                    action,
                  }
                }

                case 'read': {
                  const skill = await readSkill(context, args?.path)
                  return {
                    title:
                      `# ${skill.name ?? skill.fileName}  [${skill.source} rank=${skill.rank}]\n` +
                      `状态：${skill.status}\n路径：${skill.path}\n\n` +
                      `描述：${skill.description}\n\n--- 正文 ---\n${skill.body}`,
                    action,
                  }
                }
                case 'create': {
                  const roots = context.roots.filter((root) => root.writable && root.exists !== false)
                  const rootPath =
                    typeof args?.rootPath === 'string' && args.rootPath !== ''
                      ? args.rootPath
                      : (roots.find((root) => root.scope === 'project') ?? roots[0])?.path
                  if (rootPath === undefined) throw new Error('没有可写的技能根目录')
                  const created = await createSkill(context, {
                    name: args?.name,
                    description: args?.description,
                    whenToUse: args?.whenToUse,
                    body: args?.body,
                    modelInvocable: args?.modelInvocable,
                    userInvocable: args?.userInvocable,
                    rootPath,
                    kind: args?.kind,
                  })
                  return { title: `已创建技能 ${args?.name}\n${created.path}`, action, path: created.path }
                }
                case 'update': {
                  const result = await updateSkill(context, {
                    path: args?.path,
                    fields: {
                      ...(typeof args?.description === 'string' ? { description: args.description } : {}),
                      ...(typeof args?.whenToUse === 'string' ? { whenToUse: args.whenToUse } : {}),
                    },
                    body: typeof args?.body === 'string' ? args.body : undefined,
                  })
                  return { title: result.changed ? `已更新 ${result.path}` : `无变化 ${result.path}`, action }
                }
                case 'toggle': {
                  const result = await toggleSkill(context, {
                    path: args?.path,
                    modelInvocable: typeof args?.modelInvocable === 'boolean' ? args.modelInvocable : undefined,
                    userInvocable: typeof args?.userInvocable === 'boolean' ? args.userInvocable : undefined,
                  })
                  return { title: `已切换开关 ${result.path}`, action }
                }
                case 'rename': {
                  const result = await renameSkill(context, { path: args?.path, newName: args?.newName })
                  return { title: `已重命名为 ${args?.newName}\n${result.path}`, action }
                }
                case 'move': {
                  const roots = context.roots.filter((root) => root.writable && root.exists !== false)
                  const targetRoot =
                    typeof args?.targetRoot === 'string' && args.targetRoot !== '' ? args.targetRoot : roots[0]?.path
                  if (targetRoot === undefined) throw new Error('没有可写的技能根目录')
                  const result = await moveSkill(context, { path: args?.path, targetRoot, kind: args?.kind })
                  return { title: `已移动\n${result.path}`, action }
                }
                case 'copy': {
                  const result = await copySkill(context, {
                    path: args?.path,
                    targetRoot: args?.targetRoot,
                    newName: args?.newName,
                  })
                  return { title: `已复制\n${result.path}`, action }
                }
                case 'delete': {
                  const result = await deleteSkill(context, { path: args?.path, kind: args?.kind })
                  return { title: `已移入回收站：${result.trashedTo}\n（可恢复；DSH 不再加载它）`, action }
                }
                default:
                  throw new Error(`未知 action：${action}`)
              }
            },
            presentCall(args) {
              const labels = {
                list: '列出技能',
                roots: '技能根目录',
                read: '读取技能',
                create: '新建技能',
                update: '更新技能',
                toggle: '切换技能开关',
                rename: '重命名技能',
                move: '移动技能',
                copy: '复制技能',
                delete: '删除技能',
                lint: '体检技能',
                dirs: '自定义技能文件夹',
                addDir: '添加技能文件夹',
                removeDir: '移除技能文件夹',
                setDirDeep: '切换扫描方式',
              }
              return {
                card: 'generic',
                title: labels[args?.action] ?? '技能管理器',
                kind: args?.action === 'delete' ? 'delete' : args?.action === 'create' ? 'edit' : 'other',
                rawInput: args,
              }
            },
          }),
        ),
      'dsh-skills-manager: skill_manager tool',
    )
  }
}

/**
 * 注册 `/api/skills/manager`。
 *
 * 载具首选 `connection.fetch.register` 的**精确 Fetch 路由**：宿主负责 Host/Origin
 * 信任栅栏与浏览器鉴权，而且 webserver 的 `match()` 先查 exact 再查 prefix，所以
 * 精确路由能盖过 `/api` 前缀通道。
 *
 * 反过来走裸 `webServer.register` 会**静默失效**：`/api` 是 connection 服务持有的
 * 共享 prefix 通道，它只接受 POST，其余一律回 `404 "not found"`
 * （dsh-client-connection 的 `rpcFetchHandler` 守卫）。插件是 Node 处理器，桥接进去
 * 的是原始 GET，因此裸路由永远收不到请求，管理界面表现为
 * 「加载失败：Unexpected token 'o', "not found" is not valid JSON」。
 * 实测证据：宿主路由表里 exact 有 `/plugins/events`、`/dsh-memery/*`、`/api-ext/*`，
 * prefix 有 `/plugins`、`/api`、`/open-in-app/icon`，其中**没有** `/api/skills/manager`。
 *
 * 没有 `connection` 的组装（旧版 DSH / TUI）才退回裸路由，并自行施加同等护栏。
 *
 * @param {object} ctx Cordis 上下文
 * @param {(payload: unknown) => Promise<{status: number, body: object}>} handle 业务处理
 */
function registerHttpApi(ctx, handle) {
  /** 从标准 Request 里取出载荷：GET 走查询串，POST 走 JSON body。 */
  const payloadOf = async (request) => {
    const method = String(request.method ?? '').toUpperCase()
    if (method !== 'POST') {
      const url = new URL(request.url)
      const payload = { action: url.searchParams.get('action') ?? 'list' }
      for (const [key, value] of url.searchParams) {
        if (key !== 'action') payload[key] = value
      }
      return payload
    }
    const raw = (await request.text()).trim()
    return raw === '' ? null : JSON.parse(raw)
  }

  const respond = (status, body, method) =>
    // HEAD 必须回空体：带了体会让某些客户端认定响应非法。
    new Response(String(method).toUpperCase() === 'HEAD' ? null : body, {
      status,
      headers: JSON_HEADERS,
    })

  const hasFetchRoute = (candidate) =>
    candidate !== undefined &&
    candidate !== null &&
    candidate.fetch !== undefined &&
    typeof candidate.fetch.register === 'function'

  const registerFetchRoute = (connection) =>
    ctx.effect(
      () =>
        connection.fetch.register({
          path: API_PATH,
          methods: ['GET', 'HEAD', 'POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let payload
            try {
              payload = await payloadOf(request)
            } catch (error) {
              return respond(
                400,
                JSON.stringify({ ok: false, error: `请求体不是合法 JSON：${String(error?.message ?? error)}` }),
                request.method,
              )
            }
            const result = await handle(payload)
            return respond(result.status, JSON.stringify(result.body), request.method)
          },
        }),
      'dsh-skills-manager: /api/skills/manager fetch route',
    )

  const connection = ctx.get('connection')
  if (hasFetchRoute(connection)) {
    registerFetchRoute(connection)
    return
  }

  const webServer = ctx.get('webServer')
  let webRoute = null
  if (webServer !== undefined && typeof webServer.register === 'function') {
    webRoute = ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: API_PATH,
          handler: async (req, res) => {
            // 护栏一：有 connection 就用宿主的 Host/Origin + 浏览器鉴权判定。
            const live = ctx.get('connection')
            const rejection =
              live !== undefined && typeof live.requestRejection === 'function'
                ? live.requestRejection(req)
                : guardRequest(req) === null
                  ? undefined
                  : 403
            if (rejection !== undefined) {
              res.writeHead(rejection, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
              return
            }
            const method = String(req.method ?? '').toUpperCase()
            let payload = null
            try {
              if (method === 'POST') {
                const raw = await readNodeBody(req)
                payload = raw.trim() === '' ? null : JSON.parse(raw)
              } else {
                const url = new URL(req.url ?? '/', 'http://localhost')
                payload = { action: url.searchParams.get('action') ?? 'list' }
                for (const [key, value] of url.searchParams) {
                  if (key !== 'action') payload[key] = value
                }
              }
            } catch (error) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: `请求体不是合法 JSON：${String(error?.message ?? error)}` }))
              return
            }
            const result = await handle(payload)
            res.writeHead(result.status, JSON_HEADERS)
            res.end(JSON.stringify(result.body))
          },
        }),
      'dsh-skills-manager: http api',
    )
  } else {
    ctx.logger.warn('dsh-skills-manager: connection.webServer 都不可用，管理界面无法连接宿主 API')
  }

  // 组合时序兜底：apply 阶段 connection 还没就绪时先走裸路由，等它出现再升级为
  // 精确 Fetch 路由并撤掉裸路由——否则两条载具同时应答，实际行为（体积上限、
  // HEAD 语义、缓存头）会因命中哪条而异。用 ctx.inject 而不是把 'connection'
  // 加进顶层 inject 数组：后者会让插件在没有 connection 的组装里直接加载失败。
  ctx.inject(['connection'], (childCtx) => {
    const late = childCtx.get('connection')
    if (!hasFetchRoute(late)) return
    registerFetchRoute(late)
    if (webRoute !== null) {
      webRoute()
      webRoute = null
    }
  })
}

/**
 * 来源护栏：只允许本机回环访问。
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {{status: number, error: string} | null} 拒绝信息；null = 放行
 */
function guardRequest(req) {
  const remote = req.socket?.remoteAddress ?? ''
  const isLoopback =
    remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote.startsWith('127.')
  if (!isLoopback) return { status: 403, error: 'forbidden: 只允许本机访问' }
  // Host 头必须指向回环：挡住 DNS rebinding / 反向代理转发进来的请求。
  const host = String(req.headers?.host ?? '')
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (hostname !== '' && hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
    return { status: 403, error: 'forbidden: Host 头不是本机' }
  }
  return null
}

/**
 * 读取 Node 请求体（带上限，避免被超大 body 打挂）。
 *
 * 防御性处理非流式 req：真实宿主一定会给 IncomingMessage，但如果 `on` 不可用
 * 就返回空串而不是挂住——一个卡死的路由比一个报错的响应难查得多。
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {Promise<string>} 请求体文本
 */
function readNodeBody(req) {
  if (req === null || typeof req !== 'object' || typeof req.on !== 'function') {
    return Promise.resolve('')
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_SKILL_FILE_BYTES) {
        rejectPromise(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => rejectPromise(error))
  })
}
