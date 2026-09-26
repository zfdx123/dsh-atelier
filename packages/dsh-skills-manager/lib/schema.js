// dsh-skills-manager — 本插件的 Cordis Config schema。
//
// DSH 0.1.7 起 `ctx.settings.register(ns, schema)` 已移除：settings 由**本插件
// 自己的 Config** 投影而来，且只有标了 `.volatile()` 的节点出现在可编辑表单里。
// 所以这份 schema 同时是两个东西：Loader 校验/补默认值的依据，以及设置页的表单。
//
// 必须是**可调用的 schemastery schema**（Cordis 的 resolveConfig 走
// `schema['~standard'].validate`）。传普通对象会在解析时抛错 —— 而那是在**插件
// 装配阶段**抛的，错误表现为整个 profile 起不来。把 schema 独立出来，测试就能直接
// 断言「它是可调用的、默认值正确」，不必依赖装配路径。
//
// 为什么是这三个数组标 volatile：它们是设置页**唯一可编辑**的东西（技能根目录），
// 且改动应当就地热更新，不重挂插件。bundledSkillDir / inventory 保持普通字段：
// 它们属于部署配置，改它们走正常的重挂生命周期即可。
//
// 注意 volatile 不能标在根对象上（会把整个 Config 压成一个引用、连带吃掉所有
// 字段默认值），也不能在 volatile 节点内部再嵌 volatile（schemastery 会直接拒绝）。

import Schema from '@deepseek-ai/schemastery'

/**
 * 本插件 Config。
 *
 * 字段全部有默认值，用户不配置时也应解析出可用的完整对象——`readConfig`
 * 依赖这一点（它只做类型兜底，不再补默认值）。
 */
export const SkillManagerSchema = Schema.object({
  /** 额外的技能根目录（对应官方 provider 的 customSkillDirs，rank 300）。只扫一层。 */
  customSkillDirs: Schema.array(Schema.string()).default([]).volatile(),
  /**
   * 递归扫描的技能根目录（rank 300，与 customSkillDirs 同层）。
   *
   * 存在的理由：官方语义只认 `<root>/<name>/SKILL.md` 与 `<root>/<name>.md` 一层。
   * 但社区技能库常常是**仓库式分支**——`hack-skills/skills/<name>/SKILL.md`，
   * 真正的技能在第三层。把一个这样的集合加进来，一层扫描只会发现顶层那几个，
   * 表现出来就像「明明有一大堆技能却只认出几个」。加到这里就会递归找出所有 SKILL.md。
   *
   * 递归规则见 lib/roots.js：最多向下 3 层、跳过点目录与 node_modules，
   * 且**不进入本身已含 SKILL.md 的目录**（那里的嵌套 SKILL.md 是资源，不是独立技能）。
   */
  deepSkillDirs: Schema.array(Schema.string()).default([]).volatile(),
  /** 捆绑技能根（rank 600）。空串表示不启用。 */
  bundledSkillDir: Schema.string().default(''),
  /** 除进程 cwd 之外还要管理的项目目录。 */
  projects: Schema.array(Schema.string()).default([]).volatile(),
  /**
   * 是否把管理器管理的技能登记给 DSH（默认开）。
   *
   * 关掉它的唯一理由是「只想看、不想让模型加载到」。默认必须开着：官方 provider
   * 只扫它自己配置里的根，管理器面板里添加的目录它根本不知道，因此不注册本提供者
   * 的话，面板列出的技能就是「看得见、用不上」。
   */
  inventory: Schema.boolean().default(true),
  /**
   * 覆盖「本条目在 profile 里的 loader 条目 id」。
   *
   * 只给非 loader 载体用（单测里手搭的内存 cordis 没有 loader 条目）。
   * 正常组合留空：插件从 `ctx.fiber.entry.id` 现取，始终与 profile 里那一行一致。
   */
  entryId: Schema.string().description('覆盖 loader 条目 id（仅非 loader 载体需要）'),
})

export default SkillManagerSchema
