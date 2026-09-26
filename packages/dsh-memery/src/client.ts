/**
 * dsh-memery — 客户端：设置页「记忆」标签页（settings.section 顶级分区）。
 *
 * 「记忆可管理」的人类侧：列表（层级/状态/搜索筛选）、点开详情、
 * 归档/激活、永久删除。数据走宿主路由 /dsh-memery/*。
 */

import * as React from 'react'

const el = React.createElement
/** 注入的 <style> 的定位属性（值取插件 id），重载时按它找旧元素替换。 */
const STYLE_ATTR = 'data-dsh-memery-css'
const CSS_ID = 'dsh-memery-settings-css'

const CSS = `
.meowmem_set_page{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px;max-width:860px;padding:6px 0;font-size:13px;line-height:1.55}
.meowmem_set_title{font-size:17px;font-weight:650;margin:0;letter-spacing:.2px}
.meowmem_set_subtitle{color:var(--dsw-alias-label-caption);font-size:12px;line-height:1.6;margin:0;max-width:640px}
.meowmem_toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.meowmem_filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* 表单控件：不写死 color-scheme —— 继承 DSH 设在 <html> 上的 colorScheme
   （ui-theme 引导按主题设置 light/dark），原生弹出层/滚动条自动跟随主题。 */
.meowmem_input,.meowmem_select,.meowmem_input_sm,.meowmem_textarea{background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;color:inherit;font-size:13px;padding:6px 10px;transition:border-color .15s}
.meowmem_input,.meowmem_select,.meowmem_input_sm{min-width:120px}
.meowmem_input{min-width:180px}
.meowmem_input_sm{min-width:60px;width:60px}
.meowmem_select{cursor:pointer}
.meowmem_input:focus,.meowmem_select:focus,.meowmem_input_sm:focus,.meowmem_textarea:focus{border-color:var(--dsw-alias-border-l2);outline:none}
.meowmem_input::placeholder,.meowmem_textarea::placeholder{color:var(--dsw-alias-label-caption)}
/* option 配色：别名令牌优先，缺失时退系统色 Canvas/CanvasText —— 系统色本身
   跟随 color-scheme，比写死浅/深两个色值更稳。 */
.meowmem_select option,.meowmem_input_sm option,.meowmem_input option{background:var(--dsw-alias-bg-overlay,Canvas);color:var(--dsw-alias-label-primary,CanvasText)}
.meowmem_count{color:var(--dsw-alias-label-secondary);font-size:12px;flex:none;white-space:nowrap}
.meowmem_list{display:flex;flex-direction:column;gap:8px}
.meowmem_card{background:color-mix(in srgb,currentColor 3%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:12px;padding:12px 14px;transition:border-color .15s}
.meowmem_card:hover{border-color:var(--dsw-alias-border-l2)}
.meowmem_card_head{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.meowmem_card_title{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meowmem_card_meta{color:var(--dsw-alias-label-caption);font-size:11px;flex:none;white-space:nowrap}
.meowmem_card_body{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.7;margin-top:7px;white-space:pre-wrap;word-break:break-word;max-height:110px;overflow:hidden}
.meowmem_card_kw{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.meowmem_kw_chip{color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,currentColor 6%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:999px;font-size:11px;padding:1px 8px}
.meowmem_card_actions{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:6px}
.meowmem_card_actions_right{display:flex;gap:6px}
.meowmem_btn{background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;padding:4px 11px;transition:all .15s}
.meowmem_btn:hover{border-color:var(--dsw-alias-border-l2);color:inherit}
.meowmem_btn:disabled{opacity:.45;cursor:default}
.meowmem_btn_primary{color:var(--dsw-alias-label-primary,inherit);border-color:color-mix(in srgb,currentColor 28%,transparent);background:color-mix(in srgb,currentColor 8%,transparent);font-weight:550}
.meowmem_btn_primary:hover{border-color:currentColor}
.meowmem_btn_text{background:none;border:none;color:var(--dsw-alias-label-secondary);padding:4px 6px}
.meowmem_btn_text:hover{color:inherit;border-color:transparent}
.meowmem_btn_danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent)}
.meowmem_btn_danger:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);color:var(--dsw-alias-state-error-primary)}
/* 组件库的 Button 没有 danger 变体：破坏性操作照外壳自己的写法 —— outline 打底、
   错误色落在文字上（同 dsh-skills-manager / dsh-mcp-manager 的 danger 类）。选择器带
   父级与元素名，特异性高过组件库的 .button，不依赖两份样式表谁先谁后。 */
.meowmem_set_page button.meowmem_btn_danger_text{color:var(--dsw-alias-state-error-primary)}
.meowmem_empty{color:var(--dsw-alias-label-caption);padding:30px 2px;font-size:12.5px;text-align:center}
.meowmem_err{color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:1.5}
.meowmem_saved{color:var(--dsw-alias-state-success-primary);font-size:12px}
/* 全局徽章的天空蓝在 alpha.2 没有语义令牌：保色相、按 color-scheme 取浅/深两支
   （浅色下用 sky-700 才够对比度），边框跟着 currentColor 走。 */
.meowmem_badge_global{color:light-dark(#0369a1,#38bdf8);border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:999px;font-size:10.5px;padding:1px 7px;margin-left:6px;flex:none}
.meowmem_form{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l3);border-radius:12px;padding:14px;background:color-mix(in srgb,currentColor 2%,transparent)}
.meowmem_form_row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.meowmem_form_label{font-size:12px;color:var(--dsw-alias-label-caption);flex:none}
.meowmem_textarea{resize:vertical;box-sizing:border-box;box-flex:1;flex:1 1 100%;min-height:64px}
.meowmem_form_head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.meowmem_form_hint{color:var(--dsw-alias-label-caption);font-size:11.5px;line-height:1.5}
`

const LEVEL_KEYS: Record<string, string> = {
  fact: 'levelFact',
  lesson: 'levelLesson',
  rules: 'levelRules',
  topic: 'levelTopic',
  project: 'levelProject',
}

// ── 文案与语言 ────────────────────────────────────────────────────────────────
//
// 外壳（DSH 0.1.6-alpha.2 起）提供 ctx.locale：字典按命名空间注册，t 由
// ctx.locale.bind(NS) 得到，调用时才读当前语言 —— 于是 settings.section 的 label
// 写成 thunk（() => t('nav')）就能跟着壳的语言走（外壳 resolveSlotLabel 每次渲染
// 现取），不需要重新注册 slot。
//
// 注册有意**不**声明 locale: NS：契约里「声明 locale 但外壳没装 locale face」会让
// 渲染以 SlotAssemblyError 打挂，而本插件的底线是拿不到就降级、绝不白屏。所以这里
// 自己兜底：ctx.locale 不可用（或字典还没注册上）时 t 直接落到中文表，设置页照常
// 注册、照常渲染中文。
const LOCALE_NS = 'dsh-memery'

/** 中文文案：既有界面的原文，逐字节保留。 */
const ZH: Record<string, string> = {
  nav: '记忆',
  heading: '记忆',
  subtitle:
    '记忆按工作区隔离；「全局」为跨工作区共享库。模型在对话中用 memory_remember 主动写入并自动注入，这里可添加、编辑、归档、删除。',
  sourceTitle: '记忆来源：全局库或某个工作区',
  globalOption: '全局（{n}）',
  unresolved: '（未解析）',
  currentOption: ' · 当前对话',
  add: '＋ 添加',
  // 无字形孪生键：外壳 IconPlusOutlineRegular 顶掉「＋」以后用这条（按钮与引用它的空态）。
  addPlain: '添加',
  countGlobal: '全局库 {n} 条',
  count: '{n} 条',
  searchPlaceholder: '搜索关键词…',
  levelAll: '全部层级',
  statusActive: '活跃',
  statusArchived: '已归档',
  statusStale: '过期',
  statusAll: '全部状态',
  refresh: '↻ 刷新',
  refreshTitle: '刷新',
  // 无字形孪生键：外壳 IconRefreshOutlineRegular 顶掉「↻」以后用这条。
  refreshPlain: '刷新',
  emptyGlobal:
    '全局库还没有记忆。「＋ 添加」会直接写进跨工作区共享的全局库；或在某个工作区视图里添加并选项目「全局」。',
  emptyWorkspace:
    '这个工作区还没有记忆。让模型在对话中用 memory_remember 写入，或用上方「＋ 添加」直接添加；记忆会在对话中沉淀。',
  // 上面两句引用了「＋ 添加」这个按钮名：按钮换成图标以后，引用也要跟着无字形。
  emptyGlobalPlain:
    '全局库还没有记忆。「添加」会直接写进跨工作区共享的全局库；或在某个工作区视图里添加并选项目「全局」。',
  emptyWorkspacePlain:
    '这个工作区还没有记忆。让模型在对话中用 memory_remember 写入，或用上方「添加」直接添加；记忆会在对话中沉淀。',
  noTitle: '（无标题）',
  badgeGlobal: '全局',
  edit: '编辑',
  archive: '归档',
  restore: '恢复',
  del: '删除',
  delTitle: '删除记忆',
  delTitleNamed: '删除记忆 · {title}',
  delBody: '将永久删除这条记忆，操作不可恢复：{preview}',
  delAck: '我已了解此操作不可恢复',
  delConfirm: '删除记忆',
  deleting: '删除中…',
  confirmDelete: '确认永久删除这条记忆？此操作不可恢复。',
  cancel: '取消',
  close: '关闭',
  save: '保存',
  saving: '保存中…',
  formAdd: '添加记忆',
  formEdit: '编辑记忆',
  formProjectHint: '项目写「全局」= 跨工作区共享的全局库；否则写进当前工作区记忆库',
  levelLabel: '层级',
  importanceLabel: '重要性',
  statusLabel: '状态',
  projectLabel: '项目',
  titleLabel: '标题',
  keywordsLabel: '关键词',
  subcategoryLabel: '子类',
  goalLabel: '目标',
  projectGlobal: '全局',
  projectGlobalTitle: '全局库视图下项目固定为「全局」',
  projectGlobalHint: '选「全局」= 跨工作区共享',
  customProjectPlaceholder: '输入新项目名…',
  customProject: '自定义项目…',
  choose: '▾ 选择',
  // 无字形孪生键：外壳 IconChevronDownOutlineRegular 顶掉「▾」以后用这条。
  choosePlain: '选择',
  titlePlaceholder: '可选（topic/project 建议给）',
  contentPlaceholder: '记忆正文：fact/lesson 一句话直陈（≤80 字）；project 可写较长的结构/决策说明',
  keywordsPlaceholder: '逗号分隔，5-12 个（命中靠它）',
  subcategoryNone: '（无）',
  goalPlaceholder: 'topic 目标句',
  errContentRequired: '内容必填',
  errProjectRequired: '项目必填（项目名或「全局」）',
  errSave: '保存失败',
  errLoad: '加载失败',
  errAction: '操作失败',
  okDeleted: '已删除',
  okArchived: '已归档',
  okRestored: '已恢复为活跃',
  levelFact: '事实',
  levelLesson: '教训',
  levelRules: '准则',
  levelTopic: '话题',
  levelProject: '项目',
}

/** 英文文案：键集与 {@link ZH} 一致，供 locale 字典的 en 槽使用。 */
const EN: Record<string, string> = {
  nav: 'Memory',
  heading: 'Memory',
  subtitle:
    'Memories are isolated per workspace; “Global” is the shared cross-workspace library. The model writes them with memory_remember during a conversation and they are injected automatically — here you can add, edit, archive, and delete them.',
  sourceTitle: 'Memory source: the global library or one workspace',
  globalOption: 'Global ({n})',
  unresolved: '(unresolved)',
  currentOption: ' · current conversation',
  add: '＋ Add',
  // Icon-less twin of `add`: used once the shell's IconPlusOutlineRegular leads the button.
  addPlain: 'Add',
  countGlobal: 'Global library · {n}',
  count: 'Memories · {n}',
  searchPlaceholder: 'Search keywords…',
  levelAll: 'All levels',
  statusActive: 'Active',
  statusArchived: 'Archived',
  statusStale: 'Stale',
  statusAll: 'All statuses',
  refresh: '↻ Refresh',
  refreshTitle: 'Refresh',
  // Icon-less twin of `refresh`: used once the shell's IconRefreshOutlineRegular leads the button.
  refreshPlain: 'Refresh',
  emptyGlobal:
    'The global library has no memories yet. “＋ Add” writes straight into the shared cross-workspace library, or add from a workspace view and pick the project 全局.',
  emptyWorkspace:
    'This workspace has no memories yet. Let the model write with memory_remember in a conversation, or use “＋ Add” above; memories accumulate as you talk.',
  // The two sentences above quote the “＋ Add” button: once the icon replaces the glyph the
  // quote has to follow, otherwise the copy points at a label that is no longer on screen.
  emptyGlobalPlain:
    'The global library has no memories yet. “Add” writes straight into the shared cross-workspace library, or add from a workspace view and pick the project 全局.',
  emptyWorkspacePlain:
    'This workspace has no memories yet. Let the model write with memory_remember in a conversation, or use “Add” above; memories accumulate as you talk.',
  noTitle: '(untitled)',
  badgeGlobal: 'Global',
  edit: 'Edit',
  archive: 'Archive',
  restore: 'Restore',
  del: 'Delete',
  delTitle: 'Delete memory',
  delTitleNamed: 'Delete memory · {title}',
  delBody: 'This permanently deletes the memory and cannot be undone: {preview}',
  delAck: 'I understand this cannot be undone',
  delConfirm: 'Delete memory',
  deleting: 'Deleting…',
  confirmDelete: 'Permanently delete this memory? This cannot be undone.',
  cancel: 'Cancel',
  close: 'Close',
  save: 'Save',
  saving: 'Saving…',
  formAdd: 'Add memory',
  formEdit: 'Edit memory',
  formProjectHint:
    'Project 全局 = the shared cross-workspace library; any other value goes into this workspace’s memory library',
  levelLabel: 'Level',
  importanceLabel: 'Importance',
  statusLabel: 'Status',
  projectLabel: 'Project',
  titleLabel: 'Title',
  keywordsLabel: 'Keywords',
  subcategoryLabel: 'Subcategory',
  goalLabel: 'Goal',
  projectGlobal: '全局',
  projectGlobalTitle: 'In the global library view the project is always 全局',
  projectGlobalHint: 'Pick 全局 to share across workspaces',
  customProjectPlaceholder: 'Type a new project name…',
  customProject: 'Custom project…',
  choose: '▾ Choose',
  // Icon-less twin of `choose`: used once the shell's IconChevronDownOutlineRegular leads the button.
  choosePlain: 'Choose',
  titlePlaceholder: 'Optional (recommended for topic/project)',
  contentPlaceholder:
    'Memory body: one plain sentence for fact/lesson (≤80 chars); project may carry a longer structure/decision note',
  keywordsPlaceholder: 'Comma-separated, 5-12 (these drive recall)',
  subcategoryNone: '(none)',
  goalPlaceholder: 'topic goal sentence',
  errContentRequired: 'Content is required',
  errProjectRequired: 'Project is required (a project name or 全局)',
  errSave: 'Save failed',
  errLoad: 'Load failed',
  errAction: 'Action failed',
  okDeleted: 'Deleted',
  okArchived: 'Archived',
  okRestored: 'Restored to active',
  levelFact: 'fact',
  levelLesson: 'lesson',
  levelRules: 'rules',
  levelTopic: 'topic',
  levelProject: 'project',
}

/** 中文兜底翻译，语义与外壳的 t 一致（{name} 占位；缺参原样保留）。 */
function fallbackTranslate(key: string, params?: Record<string, unknown>): string {
  const template = ZH[key] === undefined ? key : ZH[key]
  if (params === undefined || params === null) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

/** 当前翻译函数：装配时拿得到外壳 locale 服务就换成它绑定的那份。 */
let t: (key: string, params?: Record<string, unknown>) => string = fallbackTranslate

/** 层级显示名：每次渲染现读当前语言。 */
function levelLabel(level: string): string {
  const key = LEVEL_KEYS[level]
  return key === undefined ? level : t(key)
}

/**
 * 绑定外壳 locale 服务：注册本插件的 zh/en 字典，并把 t 换成它绑定的翻译函数。
 * 拿不到服务（或注册抛错）时保持 {@link fallbackTranslate}：界面继续是中文，插件
 * 照常注册，绝不因此白屏。
 */
function bindLocale(ctx: unknown): void {
  try {
    const locale = (ctx as { locale?: { register?: unknown; bind?: unknown } } | null | undefined)?.locale
    if (locale === undefined || locale === null) return
    if (typeof locale.register !== 'function' || typeof locale.bind !== 'function') return
    const effect = (ctx as { effect?: unknown } | null | undefined)?.effect
    if (typeof effect !== 'function') return
    const runtime = locale as {
      register: (ns: string, dicts: Record<string, Record<string, string>>) => () => void
      bind: (ns: string) => (key: string, params?: Record<string, unknown>) => string
    }
    ;(effect as (factory: () => () => void, label: string) => void)(
      () => runtime.register(LOCALE_NS, { zh: ZH, en: EN }),
      'dsh-memery: dictionaries',
    )
    t = runtime.bind(LOCALE_NS)
  } catch {
    /* 注册失败：保持中文兜底，设置页照常可用 */
  }
}

/**
 * DSH 前端的**平台模块表**（静态表）里的原生 UI 组件库：前端
 * PLATFORM_MODULES 里就写着这个名字，任何客户端 bundle 都能 require 到，
 * 拿到的是宿主同款组件（Modal/RiskConfirmation/Button/…），不是仿制样式。
 */
const UI_KIT_ID = '@deepseek-ai/dsh-client-ui-primitives'

/** 外壳原子的统一形状：Button / Tag / 图标都是「吃 props、吐元素」。 */
type KitAtom = (props: Record<string, unknown>) => React.ReactElement

interface HostUi {
  RiskConfirmation: KitAtom
  /**
   * 下面几个都是可选的：外壳版本旧到没有某个原子时，对应站点退回自带样式/字形，
   * 而不是拿一个 undefined 当组件渲染。
   */
  Button?: KitAtom
  Tag?: KitAtom
  IconPlusOutlineRegular?: KitAtom
  IconRefreshOutlineRegular?: KitAtom
  IconChevronDownOutlineRegular?: KitAtom
}

let hostUiCache: HostUi | null | undefined

/**
 * 这个值能不能当作 React 组件渲染。
 *
 * `typeof x === 'function'` **不够**：外壳的 `Button` 是 `React.forwardRef(...)`
 * 的产物，`typeof` 永远是 `'object'`（实测 `$$typeof = Symbol(react.forward_ref)`、
 * `render` 是函数）。以前每一处守门都写成 `typeof kit.Button === 'function'`，
 * 于是守卫恒假、整套原语被判不可用——界面看着正常（Modal/Input 这些确实是函数），
 * 只有走 Button 的图标位和主按钮悄悄退回字形与自带样式。
 *
 * React 组件一共就这几种可渲染形态，其余一律当作不是组件。
 */
function isRenderable(value: unknown): boolean {
  if (typeof value === 'function') return true
  if (typeof value !== 'object' || value === null) return false
  const marker = (value as { $$typeof?: unknown }).$$typeof
  return marker === Symbol.for('react.forward_ref') || marker === Symbol.for('react.memo')
}

/**
 * 惰性取宿主原生 UI 组件库，取不到返回 null（调用方降级）。
 *
 * - **非字面量 require**：esbuild 不会把它提升到 factory 顶层，所以宿主缺这个
 *   模块时抛错发生在渲染期、被这里吃掉，客户端激活不受影响（踩过
 *   「entry did not activate」的坑：物化期的顶层 require 抛错会直接让插件加载失败）。
 * - 形状不对（没有 RiskConfirmation）同样按不可用处理，缓存 null。
 *
 * 导出供测试断言降级路径的前提：宿主没有这个模块时这里必须是 null，而不是抛错。
 */
export function hostUi(): HostUi | null {
  if (hostUiCache !== undefined) return hostUiCache
  hostUiCache = null
  try {
    const load = typeof require === 'function' ? require : undefined
    const kit = load === undefined ? undefined : (load(UI_KIT_ID) as Partial<HostUi> | null | undefined)
    if (kit !== undefined && kit !== null && isRenderable(kit.RiskConfirmation)) hostUiCache = kit as HostUi
  } catch {
    /* 宿主没有这个模块：保持 null，走降级路径 */
  }
  return hostUiCache
}

/**
 * 取外壳里的一个原子（Button / Tag / 图标）。
 *
 * 组件库缺席、或这个版本里没有这个原子时返回 null —— 调用方据此退回字形与自带
 * 样式。逐原子判类型而不是只判「有没有组件库」：部分可用的组件库同样不该白屏。
 */
function kitAtom(
  name: 'Button' | 'Tag' | 'IconPlusOutlineRegular' | 'IconRefreshOutlineRegular' | 'IconChevronDownOutlineRegular',
): KitAtom | null {
  const kit = hostUi()
  const atom = kit === null ? undefined : kit[name]
  return isRenderable(atom) ? (atom as KitAtom) : null
}

/** 外壳图标元素；拿不到这个图标时返回 null，文案随之退回带字形的那条。 */
function kitIcon(
  name: 'IconPlusOutlineRegular' | 'IconRefreshOutlineRegular' | 'IconChevronDownOutlineRegular',
  size: number,
): React.ReactElement | null {
  const Icon = kitAtom(name)
  return Icon === null ? null : el(Icon, { size })
}

/**
 * 这个站点能不能走原生按钮：Button 与前置图标都得在位。
 * 单独抽出来是因为引用按钮名的文案（空态那句）要跟按钮用同一个判据。
 */
function nativeButtonReady(icon: React.ReactElement | null): boolean {
  return icon !== null && kitAtom('Button') !== null
}

/**
 * 工具条 / 表单按钮。
 *
 * 原生 Button 与前置图标都在位时走外壳按钮（图标走 `icon` 通道，文案换成无字形的
 * 那条）；否则整条退回插件自带的按钮样式 + 字形文案 —— 两条路径都必须能渲染。
 */
function hostButton(props: {
  /** 外壳 Button 的视觉族。 */
  variant: 'primary' | 'ghost'
  /** 前置图标；null = 这个外壳版本没有该图标，整条走降级。 */
  icon: React.ReactElement | null
  /** 有图标时的文案（无字形）。 */
  label: string
  /** 降级文案（保留字形）。 */
  glyphLabel: string
  /** 降级路径用的自带样式 class。 */
  className: string
  title?: string
  disabled: boolean
  onClick: () => void
}): React.ReactElement {
  const Button = kitAtom('Button')
  if (Button !== null && props.icon !== null) {
    return el(
      Button,
      {
        variant: props.variant,
        size: 'sm',
        icon: props.icon,
        title: props.title,
        disabled: props.disabled,
        onClick: props.onClick,
      },
      props.label,
    )
  }
  return el(
    'button',
    { className: props.className, title: props.title, disabled: props.disabled, onClick: props.onClick },
    props.glyphLabel,
  )
}

/**
 * 无图标的按钮（表单「保存/取消」，卡片「编辑/归档/恢复/删除」）。
 *
 * 跟 {@link hostButton} 同一条路子，只是这些站点的文案里没有字形可换，所以只要
 * Button 原子在位就走外壳按钮：两份文案逐字相同，差别只在画法 ——
 * `primary` = 实心主操作，`outline` = 描边次要操作（组件库给对话框 Cancel 的族），
 * `ghost` = 无边框文字按钮。`kitClassName` 只加在原生路径上（组件库没有 danger
 * 变体，删除按钮靠样式表里的 .meowmem_btn_danger_text 把错误色落到文字上）；
 * 降级路径原样用自带 className，跟改动前逐字一致。
 *
 * 导出供测试直接断言降级路径（与 {@link hostUi} 同理）。
 */
export function hostPlainButton(props: {
  /** 外壳 Button 的视觉族。 */
  variant: 'primary' | 'ghost' | 'outline'
  /** 降级路径用的自带样式 class（与改动前逐字一致）。 */
  className: string
  /** 原生路径额外附加的 class（危险操作的红字）；不需要就不传。 */
  kitClassName?: string
  label: string
  disabled: boolean
  onClick: () => void
}): React.ReactElement {
  const Button = kitAtom('Button')
  if (Button !== null) {
    return el(
      Button,
      {
        variant: props.variant,
        size: 'sm',
        className: props.kitClassName,
        disabled: props.disabled,
        onClick: props.onClick,
      },
      props.label,
    )
  }
  return el('button', { className: props.className, disabled: props.disabled, onClick: props.onClick }, props.label)
}

/**
 * 「全局」徽章。
 *
 * 外壳 Tag 的 `info` 色调就是「分类信息、不是健康状态」的语义（天空蓝、只读），
 * 正好对上这个徽章；拿不到 Tag 时还是插件自己那个 chip
 * （样式表里的 .meowmem_badge_global，主题感知的 light-dark 天空蓝）。
 */
function globalBadge(): React.ReactElement {
  const Tag = kitAtom('Tag')
  if (Tag !== null) return el(Tag, { tone: 'info' }, t('badgeGlobal'))
  return el('span', { className: 'meowmem_badge_global' }, t('badgeGlobal'))
}

/** 记忆正文预览：确认框里让人看清删的是哪条（首行 + 截断）。 */
function previewOf(content: string): string {
  const first = String(content).split('\n')[0]?.trim() ?? ''
  return first.length > 60 ? `${first.slice(0, 60)}…` : first
}

interface MemoryItem {
  id: string
  level: string
  title: string | null
  content: string
  importance: number
  keywords: string[]
  status: string
  project: string | null
  subcategory: string | null
  goal: string | null
  corrected: boolean
  scope?: 'workspace' | 'global'
  updated_at: string
  updated_rel: string
}

/** 路径末尾目录名（跨平台：同时处理 / 与 \）。 */
function basename(p: string): string {
  const cleaned = String(p).replace(/[/\\]+$/, '')
  const parts = cleaned.split(/[/\\]/)
  return parts[parts.length - 1] || cleaned || p
}

/** 从 standardProps（useWorkspaces）取「第一个」工作区路径（注册表顺序，仅兜底）。 */
function workspacePathOf(props: Record<string, unknown>): string | undefined {
  try {
    const useWorkspaces = props.useWorkspaces as ((sel: (s: unknown) => unknown) => unknown) | undefined
    if (typeof useWorkspaces !== 'function') return undefined
    const snapshot = useWorkspaces((s) => s)
    const items = (snapshot as { items?: Array<{ path?: string }> })?.items ?? []
    for (const item of items) {
      if (typeof item.path === 'string' && item.path.trim() !== '') return item.path.trim()
    }
  } catch {
    /* 形状变化就退化 */
  }
  return undefined
}

/**
 * 取默认工作区 = 「最近活动过的对话」所在工作区。
 *
 * DSH 0.1.6-alpha.2 的 SessionListState 只有 {ids, byId, phase, subagentsByParent,
 * jobsBySession} —— 没有 `current`：会话选中态是 ui-session 的私有字段，根作用域
 * 的 standardProps 拿不到（ISessions 也只暴露 list）。所以这里用可得的最强信号：
 * byId 里 updatedAt 最大的那条会话的 cwd。取不到时返回 undefined，由调用方退回
 * workspacePathOf（注册表顺序的第一个工作区）。
 */
export function resolveDefaultWorkspace(props: Record<string, unknown>): string | undefined {
  try {
    const useSessions = props.useSessions as ((sel: (s: unknown) => unknown) => unknown) | undefined
    if (typeof useSessions !== 'function') return undefined
    interface SessionLike {
      cwd?: string
      updatedAt?: number
    }
    const byId = useSessions((s: Record<string, unknown> | undefined) => s?.byId) as
      Record<string, SessionLike> | undefined
    let best: SessionLike | undefined
    for (const entry of Object.values(byId ?? {})) {
      if (typeof entry?.cwd !== 'string' || entry.cwd.trim() === '') continue
      if (best === undefined || (entry.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = entry
    }
    if (best?.cwd !== undefined) return best.cwd.trim()
  } catch {
    /* 形状变化就退化 */
  }
  return undefined
}

/** 新建/编辑表单状态。 */
interface FormState {
  mode: 'add' | 'edit'
  item?: MemoryItem
  /** 该工作区出现过的项目名（添加表单下拉数据源；异步加载）。 */
  projects: string[]
}

/** 工作区下拉里的「全局库」哨兵选项。 */
const GLOBAL_VIEW = '__global__'

function MemoryForm(props: {
  workspace: string
  global: boolean
  projectOptions: string[]
  initial: MemoryItem | null
  onDone: () => void
  onCancel: () => void
}): React.ReactElement {
  const { initial, onDone, onCancel } = props
  const [level, setLevel] = React.useState(initial?.level ?? 'fact')
  const [title, setTitle] = React.useState(initial?.title ?? '')
  const [content, setContent] = React.useState(initial?.content ?? '')
  // 项目默认：全局视图 → 「全局」；工作区视图 → 该工作区的当前项目（目录名）
  const [project, setProject] = React.useState(initial?.project ?? (props.global ? '全局' : basename(props.workspace)))
  const [customProject, setCustomProject] = React.useState(false)
  const [importance, setImportance] = React.useState(String(initial?.importance ?? 1))
  const [status, setStatus] = React.useState(initial?.status ?? 'active')
  const [subcategory, setSubcategory] = React.useState(initial?.subcategory ?? '')
  const [goal, setGoal] = React.useState(initial?.goal ?? '')
  const [keywords, setKeywords] = React.useState((initial?.keywords ?? []).join(', '))
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const save = () => {
    if (content.trim() === '') {
      setError(t('errContentRequired'))
      return
    }
    if (project.trim() === '') {
      setError(t('errProjectRequired'))
      return
    }
    setBusy(true)
    setError(null)
    const endpoint = initial ? 'memory-update' : 'memory-add'
    const params = props.workspace !== '' ? `?workspace=${encodeURIComponent(props.workspace)}` : ''
    const kw = keywords
      .split(/[,，、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const body: Record<string, unknown> = {
      level,
      title: title.trim() === '' ? null : title.trim(),
      content: content.trim(),
      project: project.trim(),
      importance: Math.max(1, Math.min(4, Math.floor(Number(importance) || 1))),
      status,
      keywords: kw,
      subcategory: level === 'project' ? subcategory || null : null,
      goal: level === 'topic' ? goal.trim() || null : null,
    }
    if (initial) body.id = initial.id
    fetch(`/dsh-memery/${endpoint}${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((json: { ok?: boolean; error?: string }) => {
        if (json.ok !== true) throw new Error(json.error ?? t('errSave'))
        onDone()
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setBusy(false))
  }

  // 项目下拉选项：全局 + 当前项目（目录名）+ 已有项目 + 当前值（编辑时兜底）
  const projectOptions: string[] = []
  for (const p of [
    props.global ? null : '全局',
    props.global ? null : basename(props.workspace),
    ...props.projectOptions,
    project,
  ]) {
    if (typeof p === 'string' && p.trim() !== '' && !projectOptions.includes(p)) projectOptions.push(p)
  }

  const levelOpts = Object.keys(LEVEL_KEYS).map((k) => el('option', { key: k, value: k }, levelLabel(k)))

  return el(
    'div',
    { className: 'meowmem_form' },
    el(
      'div',
      { className: 'meowmem_form_head' },
      el('strong', null, initial ? t('formEdit') : t('formAdd')),
      el('span', { className: 'meowmem_form_hint' }, t('formProjectHint')),
    ),
    el(
      'div',
      { className: 'meowmem_form_row' },
      el('label', { className: 'meowmem_form_label' }, t('levelLabel')),
      el(
        'select',
        {
          className: 'meowmem_select',
          value: level,
          onChange: (e) => setLevel(e.target.value),
          disabled: initial !== null,
        },
        levelOpts,
      ),
      el('label', { className: 'meowmem_form_label', style: { marginLeft: 10 } }, t('importanceLabel')),
      el(
        'select',
        { className: 'meowmem_input_sm', value: importance, onChange: (e) => setImportance(e.target.value) },
        ['1', '2', '3', '4'].map((n) => el('option', { key: n, value: n }, n)),
      ),
      initial !== null
        ? el(
            React.Fragment,
            null,
            el('label', { className: 'meowmem_form_label', style: { marginLeft: 10 } }, t('statusLabel')),
            el(
              'select',
              { className: 'meowmem_select', value: status, onChange: (e) => setStatus(e.target.value) },
              el('option', { value: 'active' }, t('statusActive')),
              el('option', { value: 'archived' }, t('statusArchived')),
              el('option', { value: 'stale' }, t('statusStale')),
            ),
          )
        : null,
    ),
    el(
      'div',
      { className: 'meowmem_form_row' },
      el('label', { className: 'meowmem_form_label' }, t('projectLabel')),
      props.global
        ? el('input', {
            className: 'meowmem_input',
            value: t('projectGlobal'),
            disabled: true,
            style: { minWidth: 140 },
            title: t('projectGlobalTitle'),
          })
        : customProject
          ? el(
              React.Fragment,
              null,
              el('input', {
                className: 'meowmem_input',
                value: project,
                onChange: (e) => setProject(e.target.value),
                placeholder: t('customProjectPlaceholder'),
                style: { minWidth: 170 },
                autoFocus: true,
              }),
              hostButton({
                variant: 'ghost',
                icon: kitIcon('IconChevronDownOutlineRegular', 14),
                label: t('choosePlain'),
                glyphLabel: t('choose'),
                className: 'meowmem_btn',
                disabled: busy,
                onClick: () => setCustomProject(false),
              }),
            )
          : el(
              React.Fragment,
              null,
              el(
                'select',
                {
                  className: 'meowmem_select',
                  value: project,
                  onChange: (e) => {
                    if (e.target.value === '__custom__') setCustomProject(true)
                    else setProject(e.target.value)
                  },
                  style: { minWidth: 160 },
                },
                projectOptions.map((p) => el('option', { key: p, value: p }, p === '全局' ? t('projectGlobal') : p)),
                el('option', { value: '__custom__' }, t('customProject')),
              ),
              el('span', { className: 'meowmem_form_hint' }, t('projectGlobalHint')),
            ),
      el('label', { className: 'meowmem_form_label', style: { marginLeft: 10 } }, t('titleLabel')),
      el('input', {
        className: 'meowmem_input',
        value: title,
        onChange: (e) => setTitle(e.target.value),
        placeholder: t('titlePlaceholder'),
        style: { flex: '1 1 200px' },
      }),
    ),
    el('textarea', {
      className: 'meowmem_textarea',
      value: content,
      onChange: (e) => setContent(e.target.value),
      placeholder: t('contentPlaceholder'),
    }),
    el(
      'div',
      { className: 'meowmem_form_row' },
      el('label', { className: 'meowmem_form_label' }, t('keywordsLabel')),
      el('input', {
        className: 'meowmem_input',
        value: keywords,
        onChange: (e) => setKeywords(e.target.value),
        placeholder: t('keywordsPlaceholder'),
        style: { flex: '1 1 220px' },
      }),
      level === 'project'
        ? el(
            React.Fragment,
            null,
            el('label', { className: 'meowmem_form_label', style: { marginLeft: 10 } }, t('subcategoryLabel')),
            el(
              'select',
              { className: 'meowmem_select', value: subcategory, onChange: (e) => setSubcategory(e.target.value) },
              el('option', { value: '' }, t('subcategoryNone')),
              ['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo'].map((s) =>
                el('option', { key: s, value: s }, s),
              ),
            ),
          )
        : null,
      level === 'topic'
        ? el(
            React.Fragment,
            null,
            el('label', { className: 'meowmem_form_label', style: { marginLeft: 10 } }, t('goalLabel')),
            el('input', {
              className: 'meowmem_input',
              value: goal,
              onChange: (e) => setGoal(e.target.value),
              placeholder: t('goalPlaceholder'),
              style: { minWidth: 120 },
            }),
          )
        : null,
    ),
    error ? el('div', { className: 'meowmem_err' }, error) : null,
    el(
      'div',
      { className: 'meowmem_form_row' },
      hostPlainButton({
        variant: 'primary',
        className: 'meowmem_btn meowmem_btn_primary',
        label: busy ? t('saving') : t('save'),
        disabled: busy,
        onClick: save,
      }),
      hostPlainButton({
        variant: 'outline',
        className: 'meowmem_btn',
        label: t('cancel'),
        disabled: busy,
        onClick: onCancel,
      }),
    ),
  )
}

function MemorySettingsSection(props: Record<string, unknown>): React.ReactElement {
  // 默认来源 = 最近活动过的对话所在工作区（byId + updatedAt）；
  // 取不到再退到注册表第一个工作区，都没有则留在全局视图。
  const activeWorkspace = resolveDefaultWorkspace(props) ?? workspacePathOf(props)
  const [view, setView] = React.useState<string>(() => activeWorkspace ?? GLOBAL_VIEW)
  const [workspaces, setWorkspaces] = React.useState<Array<{ workspace: string; count: number; current?: boolean }>>([])
  const [globalCount, setGlobalCount] = React.useState(0)
  const [query, setQuery] = React.useState('')
  const [level, setLevel] = React.useState('')
  const [status, setStatus] = React.useState('active')
  const [data, setData] = React.useState<{ memories: MemoryItem[] } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  // 提示条：text + 是否失败（原文案靠「失败/错误」两个汉字判断，英文下判不出来）。
  const [notice, setNotice] = React.useState<{ text: string; error: boolean } | null>(null)
  const [form, setForm] = React.useState<FormState | null>(null)
  /** 待删除确认的记忆（非 null = 原生确认框打开）。 */
  const [pendingDelete, setPendingDelete] = React.useState<MemoryItem | null>(null)
  /** 原生确认框里「我已了解此操作不可恢复」的勾选状态。 */
  const [acknowledged, setAcknowledged] = React.useState(false)

  const isGlobalView = view === GLOBAL_VIEW

  /**
   * 拉取工作区清单 + 全局库计数。挂载时跑一次，「刷新」按钮与增删后复用同一个
   * 函数 —— 否则下拉里的工作区与计数会一直停在「打开设置页那一刻」的快照
   * （新加的工作区要关掉设置页重开才出现）。
   * 依赖为空：视图自动纠正走 setView 的函数式更新，不需要捕获 view。
   */
  const loadWorkspaces = React.useCallback(() => {
    fetch('/dsh-memery/workspaces', { cache: 'no-store' })
      .then((r) => r.json())
      .then(
        (json: {
          ok?: boolean
          workspaces?: Array<{ workspace: string; count: number; current?: boolean }>
          global_count?: number
        }) => {
          if (json.ok !== true) return
          const list = json.workspaces ?? []
          setWorkspaces(list)
          if (typeof json.global_count === 'number') setGlobalCount(json.global_count)
          // 当前选中的工作区不在清单里 → 自动选第一个有记忆的（否则留在全局视图）
          setView((current) => {
            if (current === GLOBAL_VIEW || list.length === 0 || list.some((w) => w.workspace === current))
              return current
            const first = list.find((w) => w.count > 0) ?? list[0]
            return first?.workspace ?? GLOBAL_VIEW
          })
        },
      )
      .catch(() => {
        /* 清单加载失败：保留当前视图 */
      })
  }, [])

  React.useEffect(() => {
    loadWorkspaces()
  }, [loadWorkspaces])

  const load = React.useCallback(() => {
    setBusy(true)
    setError(null)
    const params = new URLSearchParams()
    if (isGlobalView) params.set('scope', 'global')
    else if (view !== '') params.set('workspace', view)
    if (query.trim() !== '') params.set('q', query.trim())
    if (level !== '') params.set('level', level)
    if (status !== 'all') params.set('status', status)
    fetch(`/dsh-memery/memories?${params.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { ok?: boolean; error?: string; memories?: MemoryItem[] }) => {
        if (json.ok !== true) throw new Error(json.error ?? t('errLoad'))
        setData({ memories: json.memories ?? [] })
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [view, isGlobalView, query, level, status])

  React.useEffect(() => {
    load()
  }, [load])

  const act = React.useCallback(
    (id: string, action: 'delete' | 'archive' | 'restore') => {
      setBusy(true)
      setNotice(null)
      const body = action === 'delete' ? { id } : { id, status: action === 'archive' ? 'archived' : 'active' }
      const params = !isGlobalView && view !== '' ? `?workspace=${encodeURIComponent(view)}` : ''
      fetch(`/dsh-memery/${action === 'delete' ? 'memory-delete' : 'memory-update'}${params}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => r.json())
        .then((json: { ok?: boolean; error?: string }) => {
          if (json.ok !== true) throw new Error(json.error ?? t('errAction'))
          setNotice({
            text: action === 'delete' ? t('okDeleted') : action === 'archive' ? t('okArchived') : t('okRestored'),
            error: false,
          })
          load()
          loadWorkspaces() // 下拉里的计数跟着变（删除/新增后不能停在旧数字）
        })
        .catch((e) => setNotice({ text: e instanceof Error ? e.message : String(e), error: true }))
        .finally(() => setBusy(false))
    },
    [view, isGlobalView, load, loadWorkspaces],
  )

  /**
   * 删除前确认：优先弹宿主**原生** RiskConfirmation（警告行 + 「我已了解」勾选，
   * 勾选前不允许确认）。只有宿主没提供该组件时才退回浏览器 window.confirm ——
   * 那是宿主之外的系统弹窗，跟 DSH 的对话框完全两个世界。
   */
  const askDelete = React.useCallback(
    (item: MemoryItem) => {
      if (hostUi() === null) {
        if (typeof window !== 'undefined' && window.confirm(t('confirmDelete'))) act(item.id, 'delete')
        return
      }
      setAcknowledged(false) // 每次打开都从「未勾选」开始，避免沿用上一次的勾选
      setPendingDelete(item)
    },
    [act],
  )

  /** 打开添加/编辑表单；工作区视图顺便拉取该项目下拉的数据源。 */
  const openForm = React.useCallback(
    (mode: 'add' | 'edit', item?: MemoryItem) => {
      setForm({ mode, item, projects: [] })
      if (!isGlobalView && view !== '') {
        fetch(`/dsh-memery/projects?workspace=${encodeURIComponent(view)}`, { cache: 'no-store' })
          .then((r) => r.json())
          .then((json: { ok?: boolean; projects?: string[] }) => {
            if (json.ok !== true) return
            const projects = json.projects ?? []
            setForm((f) => (f === null ? f : { ...f, projects }))
          })
          .catch(() => {
            /* 项目清单失败：表单仍可用（下拉只剩 全局/当前项目/自定义） */
          })
      }
    },
    [view, isGlobalView],
  )

  const memories = data?.memories ?? []
  const kit = hostUi()
  // 「＋ 添加」「↻ 刷新」的前置图标：拿不到就整条退回自带按钮 + 字形文案。
  const addIcon = kitIcon('IconPlusOutlineRegular', 16)
  const refreshIcon = kitIcon('IconRefreshOutlineRegular', 16)

  return el(
    'div',
    { className: 'meowmem_set_page' },
    el('h2', { className: 'meowmem_set_title' }, t('heading')),
    el('p', { className: 'meowmem_set_subtitle' }, t('subtitle')),
    el(
      'div',
      { className: 'meowmem_toolbar' },
      el(
        'select',
        {
          className: 'meowmem_select',
          value: view,
          onChange: (e) => setView(e.target.value),
          style: { maxWidth: 280 },
          title: t('sourceTitle'),
        },
        el('option', { value: GLOBAL_VIEW }, t('globalOption', { n: globalCount })),
        workspaces.length === 0
          ? view === GLOBAL_VIEW
            ? null
            : el('option', { value: view }, view || t('unresolved'))
          : workspaces.map((w) =>
              el(
                'option',
                { key: w.workspace, value: w.workspace },
                `${basename(w.workspace)}（${w.count}）${activeWorkspace !== undefined && w.workspace === activeWorkspace ? t('currentOption') : ''}`,
              ),
            ),
      ),
      hostButton({
        variant: 'primary',
        icon: addIcon,
        label: t('addPlain'),
        glyphLabel: t('add'),
        className: 'meowmem_btn meowmem_btn_primary',
        disabled: busy || form !== null,
        onClick: () => openForm('add'),
      }),
    ),
    el(
      'div',
      { className: 'meowmem_filters' },
      el('span', { className: 'meowmem_count' }, t(isGlobalView ? 'countGlobal' : 'count', { n: memories.length })),
      el('input', {
        className: 'meowmem_input',
        placeholder: t('searchPlaceholder'),
        value: query,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
        style: { flex: '1 1 160px' },
      }),
      el(
        'select',
        { className: 'meowmem_select', value: level, onChange: (e) => setLevel(e.target.value) },
        el('option', { value: '' }, t('levelAll')),
        Object.keys(LEVEL_KEYS).map((k) => el('option', { key: k, value: k }, levelLabel(k))),
      ),
      el(
        'select',
        { className: 'meowmem_select', value: status, onChange: (e) => setStatus(e.target.value) },
        el('option', { value: 'active' }, t('statusActive')),
        el('option', { value: 'archived' }, t('statusArchived')),
        el('option', { value: 'all' }, t('statusAll')),
      ),
      hostButton({
        variant: 'ghost',
        icon: refreshIcon,
        label: t('refreshPlain'),
        glyphLabel: t('refresh'),
        className: 'meowmem_btn meowmem_btn_text',
        title: t('refreshTitle'),
        disabled: busy,
        onClick: () => {
          loadWorkspaces()
          load()
        },
      }),
    ),
    error ? el('div', { className: 'meowmem_err' }, error) : null,
    notice ? el('div', { className: notice.error ? 'meowmem_err' : 'meowmem_saved' }, notice.text) : null,
    form
      ? el(MemoryForm, {
          workspace: isGlobalView ? '' : view,
          global: isGlobalView,
          projectOptions: form.projects,
          initial: form.mode === 'edit' ? (form.item ?? null) : null,
          onDone: () => {
            setForm(null)
            load()
            loadWorkspaces()
          },
          onCancel: () => setForm(null),
        })
      : null,
    memories.length === 0 && !busy
      ? el(
          'div',
          { className: 'meowmem_empty' },
          // 空态里引用了「＋ 添加」这个按钮名：图标顶掉字形以后，引用也跟着换。
          isGlobalView
            ? t(nativeButtonReady(addIcon) ? 'emptyGlobalPlain' : 'emptyGlobal')
            : t(nativeButtonReady(addIcon) ? 'emptyWorkspacePlain' : 'emptyWorkspace'),
        )
      : el(
          'div',
          { className: 'meowmem_list' },
          memories.map((m) =>
            el(
              'div',
              { key: m.id, className: 'meowmem_card' },
              el(
                'div',
                { className: 'meowmem_card_head' },
                el(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, flex: '1 1 auto' } },
                  el('span', { className: 'meowmem_card_title' }, m.title || t('noTitle')),
                  m.scope === 'global' ? globalBadge() : null,
                ),
                el(
                  'span',
                  { className: 'meowmem_card_meta' },
                  [
                    levelLabel(m.level),
                    m.status !== 'active' ? (m.status === 'archived' ? t('statusArchived') : t('statusStale')) : '',
                    m.project ? m.project : '',
                    m.updated_rel,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                ),
              ),
              el('div', { className: 'meowmem_card_body' }, m.content),
              m.keywords.length > 0
                ? el(
                    'div',
                    { className: 'meowmem_card_kw' },
                    m.keywords.slice(0, 8).map((k) => el('span', { key: k, className: 'meowmem_kw_chip' }, k)),
                  )
                : null,
              el(
                'div',
                { className: 'meowmem_card_actions' },
                hostPlainButton({
                  variant: 'ghost',
                  className: 'meowmem_btn meowmem_btn_text',
                  label: t('edit'),
                  disabled: busy || form !== null,
                  onClick: () => openForm('edit', m),
                }),
                el(
                  'div',
                  { className: 'meowmem_card_actions_right' },
                  m.status === 'active'
                    ? hostPlainButton({
                        variant: 'outline',
                        className: 'meowmem_btn',
                        label: t('archive'),
                        disabled: busy,
                        onClick: () => act(m.id, 'archive'),
                      })
                    : hostPlainButton({
                        variant: 'outline',
                        className: 'meowmem_btn',
                        label: t('restore'),
                        disabled: busy,
                        onClick: () => act(m.id, 'restore'),
                      }),
                  hostPlainButton({
                    variant: 'outline',
                    className: 'meowmem_btn meowmem_btn_danger',
                    kitClassName: 'meowmem_btn_danger_text',
                    label: t('del'),
                    disabled: busy,
                    onClick: () => askDelete(m),
                  }),
                ),
              ),
            ),
          ),
        ),
    // 删除确认：宿主原生 RiskConfirmation（Modal + 警告行 + 勾选框），
    // 靠 portal 挂到 body，不受设置页滚动容器/层叠影响。
    pendingDelete !== null && kit !== null
      ? el(kit.RiskConfirmation, {
          open: true,
          title: pendingDelete.title ? t('delTitleNamed', { title: pendingDelete.title }) : t('delTitle'),
          description: t('delBody', { preview: previewOf(pendingDelete.content) }),
          acknowledgeLabel: t('delAck'),
          cancelLabel: t('cancel'),
          closeLabel: t('close'),
          confirmLabel: busy ? t('deleting') : t('delConfirm'),
          acknowledged,
          disabled: busy,
          onAcknowledgedChange: (value: boolean) => setAcknowledged(value === true),
          onCancel: () => {
            setPendingDelete(null)
            setAcknowledged(false)
          },
          onConfirm: () => {
            if (!acknowledged) return // 未勾选不允许删（原生按钮此时也是 disabled，这里是双保险）
            const id = pendingDelete.id
            setPendingDelete(null)
            setAcknowledged(false)
            act(id, 'delete')
          },
        })
      : null,
  )
}

/**
 * 注入（或刷新）本插件的样式表。
 *
 * 客户端半体在 bundle/HMR 重载时会重新物化：旧 <style> 还在文档里，只按「有没有」
 * 跳过的话新 CSS 永远不生效（要整页刷新）。所以先按插件属性摘掉旧元素再挂新的；
 * 判定只看属性在不在 —— 旧版本把值写成 "true"。
 */
function injectStyle(): void {
  if (typeof document === 'undefined') return
  const host = document.head || document.documentElement
  if (host === undefined) return
  for (const stale of document.querySelectorAll(`style[${STYLE_ATTR}]`)) stale.remove()
  const style = document.createElement('style')
  style.setAttribute(STYLE_ATTR, CSS_ID)
  style.textContent = CSS
  host.appendChild(style)
}
injectStyle()

/**
 * 激活器按 exports.inject 注入客户端依赖（参考 dsh-meow-memory 契约）：
 * slots 是设置页注册必需；缺了它激活器注入不到依赖 → 「entry did not activate」。
 * locale 是外壳 0.1.6-alpha.2 起的文案服务：声明它以后，settings.section 的 label 与
 * 设置页文案才会跟着壳的语言；它缺席时（旧外壳 / 直接调用 apply）bindLocale 保持中文
 * 兜底，设置页照常注册、照常可用。
 */
export const inject = ['slots', 'locale']

export function apply(ctx: any): () => void {
  bindLocale(ctx)
  const slots = ctx?.slots
  if (slots !== undefined && typeof slots.inject === 'function' && typeof slots.register === 'function') {
    // 注册契约：settings.section list slot，组件接收 standardProps（useWorkspaces）。
    const unregister = slots.inject('settings.section', () =>
      slots.register(
        {
          name: 'settings.section',
          id: 'dsh-memery',
          order: 28,
          // thunk：外壳 resolveSlotLabel 每次渲染现取，切语言不需要重新注册 slot。
          label: () => t('nav'),
          // 可选：把本插件的注入面传给组件（组件未使用 settingsScope，传 scope 仅为
          // 与参考实现形状一致；缺省时组件仍能从 standardProps 拿 useWorkspaces）。
        },
        MemorySettingsSection,
      ),
    )
    try {
      console.info('[dsh-memery] 设置页「记忆」标签已注册（settings.section）')
    } catch {
      /* console 不可用时静默 */
    }
    return () => {
      try {
        unregister?.()
      } catch {
        /* 清理失败不阻塞 */
      }
    }
  }
  console.warn('[dsh-memery] slots 服务不可用，设置页未注册（工具与注入不受影响）')
  return () => {}
}
