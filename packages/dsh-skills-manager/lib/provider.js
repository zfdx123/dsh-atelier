// dsh-skills-manager — 技能提供者（把管理器管理的技能真正交给 DSH）。
//
// ## 为什么必须有这一层
//
// DSH 的技能目录由**提供者**（provider）填充。官方提供者
// `@deepseek-ai/dsh-skill-filesystem` 扫的是**它自己**配置里的根：项目里的
// `.dsh/skills`、`.agents/skills`、`<dshHome>/skills`，以及它的 `customSkillDirs`
// ——**那是在组合文件（cordis.yml 里插件行的 config）配的**。
//
// 而管理器面板里「添加技能文件夹」写进的是 `skill-manager` 设置命名空间。两者毫无
// 关系。于是出现最坏的一种情况：面板里明明列出 107 个技能，DSH 却一个都不认识、
// 模型也加载不到——看起来像「watcher 慢」，其实是根本没人扫这个目录。
//
// 这个模块补上那一步：把管理器管理的根（含递归目录）也注册成一个提供者，于是这些
// 技能进入会话目录、模型可以按名加载。
//
// 契约（读自 dsh-skill 与官方 provider 的实现）：
//   - `list(options)` 返回候选数组，或 `{candidates, complete}`；不完整观测表示
//     「这次没扫全」，注册表会保留上一份好目录而不是当成删除；
//   - 候选必须带 name / description / invocation（两个布尔）/ provider / source /
//     rank / locator；`locator` 是回传给 `get()` 的不透明定位信息；
//   - `get(candidate, options)` 重读文件返回完整定义，名字必须与候选一致，否则
//     注册表判定选择过期并让下次快照重新发现；**读不到时只能返回 `undefined`，
//     不能返回 `null`**——注册表只把 `undefined` 当成"不可加载"
//     （dsh-skill 的 `if (definition === void 0) return void 0`），`null` 会漏过去
//     被送进 `validateDefinition(null)` 抛 TypeError，模型侧看到的是内部错误；
//   - 抛错会被注册表记为「该提供者发现失败」并跳过，所以这里把可预期的读取失败
//     收敛成 `complete: false`，不往外抛。

import { MAX_SKILL_FILE_BYTES, isSkillName, lintSkillFile, splitSkillText } from './logic.js'
import { discoverSkillFiles, findProjectRoot, readSkillFileText, resolveRoots } from './roots.js'

/** 注册到 `ctx.skills` 的提供者名（不能与官方 `filesystem` 重名，`runtime` 保留）。 */
export const PROVIDER_NAME = 'skills-manager'

/**
 * 从一段技能文本里解析出「摘要候选」需要的字段。
 * @param {string} text 技能文件全文
 * @returns {{name: string, description: string, whenToUse?: string, invocation: object} | null} 可用字段；不合格返回 null
 */
function summarizeSkillText(text) {
  const diagnosed = lintSkillFile({ text })
  // 与官方 provider 一致：name 必须符合 kebab-case、description 必填，否则该技能
  // 不进入目录（管理器面板仍会把它连同原因列出来，所以信息没丢）。
  if (!isSkillName(diagnosed.fields.name)) return null
  if (typeof diagnosed.fields.description !== 'string' || diagnosed.fields.description === '') return null
  const summary = {
    name: diagnosed.fields.name,
    description: diagnosed.fields.description,
    invocation: diagnosed.invocation,
  }
  if (typeof diagnosed.whenToUse === 'string' && diagnosed.whenToUse !== '') summary.whenToUse = diagnosed.whenToUse
  return summary
}

/**
 * 创建一个技能提供者工厂，交给 `ctx.skills.registerProvider`。
 *
 * `readConfig` 每次发现时重新调用——用户在面板里改完根目录，下一次目录刷新就该
 * 看到效果，所以**不能**捕获注册时刻的配置快照。
 *
 * @param {() => object} readConfig 读取当前插件配置
 * @param {{onWarn?: (message: string) => void, onControl?: (control: object) => void}} hooks 日志与失效钩子
 * @returns {(control?: object) => object} registerProvider 需要的工厂
 */
export function createSkillProviderFactory(readConfig, hooks = {}) {
  const warn = typeof hooks.onWarn === 'function' ? hooks.onWarn : () => {}
  return function createProvider(control) {
    // 注册表会把 `{signal, invalidate}` 交给工厂。`invalidate()` 让已完成的目录
    // 失效并通知消费者；本 provider 没有文件 watcher，而注册表的目录缓存是按
    // revision 键控的、磁盘变化不会自己 bump revision——所以管理器写完盘之后
    // 必须由调用方调它，否则「删掉的技能还在目录里、刚建的技能进不去」。
    // 交给 onControl 而不是自己留着：写盘的是管理器，知道该失效的也是它。
    if (
      typeof hooks.onControl === 'function' &&
      control !== null &&
      typeof control === 'object' &&
      typeof control.invalidate === 'function'
    ) {
      hooks.onControl(control)
    }
    return {
      name: PROVIDER_NAME,

      /**
       * 发现管理器管理的全部技能。
       * @param {{cwd?: string, signal?: AbortSignal}} options 查找选项
       * @returns {Promise<Array<object> | {candidates: Array<object>, complete: boolean}>} 候选集
       */
      async list(options = {}) {
        let config
        let discovered
        try {
          // readConfig 也必须在 try 里：它读设置，设置服务出问题时会抛，
          // 而抛给注册表就会被记成「该提供者发现失败」——宁可降级成不完整观测。
          config = readConfig()
          // inventory 开关是动态的：关掉时不出任何候选，等价于"不登记"，但不需要
          // 拆装 provider（Cordis 的注册是单向的，注册后没有干净的取消途径）。
          if (config.inventory === false) return []
          // 查找方给的 cwd 优先：它决定项目根的解析。
          const cwd = options.cwd ?? config.cwd
          // projectRoot 必须显式解析。注意 resolveRoots 里 `projectRoot: null` 的语义
          // 是「没有项目根」，直接传 null 会**关掉项目根发现**——那样连项目自带的
          // .dsh/skills 都扫不到。这里用 findProjectRoot 显式算出最近的 .git 祖先。
          const projectRoot = await findProjectRoot(cwd)
          discovered = await discoverSkillFiles(
            resolveRoots({
              ...config,
              cwd,
              projectRoot,
            }),
          )
        } catch (error) {
          warn(`技能提供者发现失败，本次保留上一份目录：${String(error?.message ?? error)}`)
          return { candidates: [], complete: false }
        }

        const candidates = []
        let complete = true
        for (const entry of discovered.entries) {
          if (options.signal?.aborted === true) return { candidates, complete: false }
          const read = await readSkillFileText(entry.path, MAX_SKILL_FILE_BYTES)
          if (read.error !== undefined) {
            complete = false
            continue
          }
          const summary = summarizeSkillText(read.text)
          if (summary === null) continue
          candidates.push({
            ...summary,
            provider: PROVIDER_NAME,
            source: entry.source,
            rank: entry.rank,
            locator: { path: entry.path, directory: entry.dir },
            resourceBase: { kind: 'directory', path: entry.dir },
            path: entry.path,
          })
        }
        return complete ? candidates : { candidates, complete }
      },

      /**
       * 加载一个技能的完整正文。每次重读文件，所以改正文不需要任何缓存失效。
       * @param {object} candidate list() 返回的获胜候选
       * @param {{signal?: AbortSignal}} options 查找选项
       * @returns {Promise<object | undefined>} 完整定义；文件消失或不再合法时返回 undefined
       */
      async get(candidate, options = {}) {
        if (candidate === null || typeof candidate !== 'object') return undefined
        const locator = candidate.locator
        if (locator === null || typeof locator !== 'object' || typeof locator.path !== 'string') return undefined
        if (options.signal?.aborted === true) return undefined
        const read = await readSkillFileText(locator.path, MAX_SKILL_FILE_BYTES)
        if (read.error !== undefined) return undefined
        const summary = summarizeSkillText(read.text)
        if (summary === null) return undefined
        const parts = splitSkillText(read.text)
        const diagnosed = lintSkillFile({ text: read.text })
        const definition = {
          name: summary.name,
          description: summary.description,
          invocation: summary.invocation,
          source: typeof candidate.source === 'string' ? candidate.source : 'custom',
          provider: PROVIDER_NAME,
          resourceBase: {
            kind: 'directory',
            // 目录包 → 技能目录；单文件技能 → 文件所在目录。两者都是 entry.dir。
            path: typeof locator.directory === 'string' ? locator.directory : locator.path,
          },
          path: locator.path,
          content: parts.body.trim(),
        }
        if (summary.whenToUse !== undefined) definition.whenToUse = summary.whenToUse
        const metadata = diagnosed.fields.metadata
        if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata))
          definition.metadata = metadata
        return definition
      },
    }
  }
}
