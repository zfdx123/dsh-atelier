// dsh-skills-manager — client half (classic script, no build step).
//
// 注册两处界面，共用同一个组件树：
//   1. 设置页 `settings.section` id=skill-manager —— 完整的管理台（列表 / 详情 /
//      新建 / 搬运 / 回收站），宽栏布局。
//   2. 侧栏脚 `sidebar.footer.action` id=skill-manager —— 就地弹出的浮层，
//      compact 模式，方便随手开关或改正文。
//
// 数据全部来自宿主 `/api/skills/manager`（见 index.js）。这里不直接读文件系统：
// 浏览器没有那个能力，而且所有写盘必须过宿主侧的路径护栏。
//
// 注册 id 必须是**包名**：宿主按 __DSH_BOOT__ 图里的 entry id（= 包名）装载
// /plugins/??<包名>/client.js，装载后校验 factories 里存在该 id。写成短名会在
// 挂载阶段直接抛错，界面不会出现。
//
// 主题：外壳把设计令牌定义在 <body>（亮色）与 <body[data-ds-dark-theme]>（暗色）
// 上，所以插件 DOM 里 var(--dsw-alias-*) 能解析；但外壳从不声明 color-scheme，
// 暗色下原生控件（select 弹层、输入框内部、滚动条）仍按亮色渲染，会出现浅色字
// 落在白底上。所以这里注入一小段只属于本插件的样式：绑定 color-scheme、给每个
// --sm-* 变量一份带兜底的值、显式写死原生控件的背景与文字色。
window.__ModuleLoader__.load({
  id: '@zfdx123/dsh-skills-manager',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback
    var useRef = React.useRef
    var e = React.createElement

    var API = '/api/skills/manager'
    var CLASS = 'dsh-skills-manager'
    var STYLE_ID = 'dsh-skills-manager-style'
    // 侧栏入口的 slot key：注册、样式选择器、可见性自检都从这一个常量取，三处不会各写一份。
    var SIDEBAR_SLOT = 'sidebar.footer.action'
    var SLOT_ANCHOR = '[data-slot="' + SIDEBAR_SLOT + '"]'

    // ── 文案与语言 ────────────────────────────────────────────────────────────
    //
    // 外壳（DSH 0.1.6-alpha.2 起）带 ctx.locale：字典按命名空间注册，t 由
    // ctx.locale.bind(NS) 得到，调用时才读当前语言。于是 settings.section 的 label
    // 写成 thunk（() => t('nav')）就能跟着壳的语言走——外壳 resolveSlotLabel 每次渲染
    // 现取，不需要重新注册 slot。
    //
    // 注册有意**不**声明 locale: NS：契约里「声明 locale 但外壳没装 locale face」会以
    // SlotAssemblyError 的形式把渲染打挂，而本插件的底线是「拿不到就降级，绝不白屏」。
    // 因此这里自己兜底：ctx.locale 不可用、或字典还没注册上时，t 直接落到中文表，
    // 插件照常注册、照常渲染中文。
    var LOCALE_NS = 'skill-manager'

    /** 中文文案（既有界面的原文，逐字节保留）。 */
    var ZH = {
      nav: '技能管理',
      sidebar: '技能',
      loading: '加载中…',
      summary: '{total} 个技能 · 正常 {ok} · 警告 {warning} · DSH 会跳过 {broken}',
      summaryShadowed: '{total} 个技能 · 正常 {ok} · 警告 {warning} · DSH 会跳过 {broken} · 遮蔽 {shadowed}',
      cwd: '当前项目：{path}',
      registryError: '注册表读取失败：{message}',
      registryOff: '技能登记已关闭：这 {n} 个技能只在面板可见，DSH 不会加载、模型也用不到。',
      registryPending: '磁盘上有、但还没进入 DSH 目录（提供者刷新延迟）：{names}',
      newSkill: '＋ 新建技能',
      // 同上，但无字形：拿得到外壳 IconPlusOutline16 时用这条（图标自己就是那个「＋」）。
      newSkillPlain: '新建技能',
      refresh: '刷新',
      refreshing: '刷新中…',
      trash: '回收站',
      rootsTitle: '根目录（rank 越小越优先）',
      rootMissing: '（不存在）',
      rootReadonly: ' 只读',
      rootDeep: ' 递归',
      scopeProject: '项目',
      scopeUser: '用户',
      scopeCustom: '自定义',
      scopeBundled: '内置',
      customDirs: '自定义技能文件夹',
      dirSummary: '{path}（技能 {n} 个）',
      compactDirsHint: '增删自定义文件夹请到 设置 → 技能管理。',
      trashHint: '删除的技能被移到这里（不会被 DSH 发现）。需要恢复就把它移回根目录。',
      trashEmpty: '回收站是空的。',
      close: '关闭',
      cancel: '取消',
      confirmBusy: '处理中…',
      emptySkills: '没有发现任何技能。点「新建技能」创建第一个。',
      noWritableRoots: '没有可写且存在的根目录。',
      dialogDeleteTitle: '把「{name}」移入回收站？',
      dialogDeleteBody: '可恢复：文件会移进该根目录的回收站，DSH 将不再加载它。',
      dialogDeleteConfirm: '移入回收站',
      dialogRemoveDirTitle: '从管理器移除这个文件夹？',
      dialogRemoveDirBody: '只解除管理：目录和里面的技能文件都不会被改动。',
      dialogRemove: '移除',
      dialogRenameTitle: '重命名技能',
      dialogRenameBody: '名字会同时写进 frontmatter 的 name，不会留下名字与文件不符的坏状态。',
      dialogRename: '重命名',
      dialogRenameName: '新名字（kebab-case）',
      dialogMoveTitle: '移动到哪个根目录？',
      dialogMoveBody: '只列可写且存在的根目录；搬过去以后 DSH 会按新的层重新加载。',
      dialogMove: '移动',
      dialogCopyTitle: '复制到哪里？',
      dialogCopyBody: '副本的 frontmatter.name 会同步改成新名字。',
      dialogCopy: '复制',
      dialogCopyName: '新副本的名字',
      tagFlat: '单文件',
      tagModelHidden: '模型不可见',
      tagSlashHidden: '/ 不可见',
      tagShadowed: '被遮蔽',
      tagCopies: '共 {n} 份',
      shadowedBy: '被 {path} 遮蔽（DSH 用的是那一份）',
      edit: '编辑',
      modelOn: '对模型开启',
      modelOff: '对模型关闭',
      slashOn: '/ 开启',
      slashOff: '/ 关闭',
      del: '删除',
      save: '保存',
      saving: '保存中…',
      revert: '放弃改动',
      bodyLabel: '正文（Markdown）',
      detailTitle: '编辑 {name}',
      savedNote: '已保存。frontmatter 的注释与未知字段原样保留。',
      detailHint: '只改正文时：frontmatter 逐字节保留，注释与键顺序都不动。改上面两个字段时：只重写对应那一行。',
      dirsHint1: '把任意目录加进来当技能根（rank 300）：同名技能会低于项目层、高于用户层。',
      dirsHint2:
        '扫描方式：「一层」= 只认目录下的 <名称>/SKILL.md 与 <名称>.md（与 DSH 官方一致）；' +
        '「递归」= 继续向下最多 3 层找 SKILL.md，用于仓库式技能库' +
        '（技能在 <集合>/skills/<名称>/SKILL.md 这种更深的层级）。',
      dirsReadonly: '当前 settings 不可写，无法保存自定义文件夹。',
      dirsEmpty: '还没有添加自定义文件夹。',
      dirMissing: '目录不存在（DSH 发现时会跳过）',
      dirSkills: '技能 {n} 个',
      deepToggleTitle: '递归查找更深层级的 SKILL.md（最多 3 层）',
      deepToggleLabel: '递归扫描更深层级的 SKILL.md',
      deep: '递归',
      dirPathPlaceholder: 'E:/work/skills 或 ~/my-skills',
      dirPathLabel: '技能文件夹路径',
      browse: '浏览…',
      add: '添加',
      deepScanLabel: '递归扫描（技能藏在更深的层级时勾上）',
      dirsFooterHint: '目录不存在时会被拒绝——先建好目录，或手动创建后再添加。',
      addedDir: '已添加 {path}（{mode}扫描）',
      scanDeep: '递归',
      scanShallow: '一层',
      dirCreated: '，目录是新建的',
      dirSkillCount: '，扫到 {n} 个技能',
      dirNoSkills: '，其中还没有技能',
      picking: '已请求系统选择框…',
      pickFailed: '无法打开系统选择框（{message}），请手动填入目录路径',
      pickUnsupported: '当前组合没有原生目录选择器，请手动填入目录路径',
      picked: '已选中，点「添加」确认',
      deepChanged: '{path} 已切换为「{mode}」扫描，扫到 {n} 个技能',
      createTitle: '新建技能',
      createNameLabel: '技能名（kebab-case，例：code-review）',
      createNamePlaceholder: 'my-skill',
      createDescriptionLabel: '一句话说明（会进入会话目录，模型据此决定要不要加载）',
      createDescriptionPlaceholder: '什么时候该用这个技能',
      createWhenLabel: '何时使用（可选，写给模型看的补充触发条件）',
      createRootLabel: '写入哪个根目录（rank 越小越优先）',
      createKindLabel: '形态',
      kindBundle: '目录包 <name>/SKILL.md',
      kindFlat: '单文件 <name>.md',
      create: '创建',
      createHint:
        '创建后建议写清「何时使用 / 步骤 / 细则」：技能是按需加载的，说明越具体，模型越容易在对的时候想起来用它。',
      okDeleted: '已移入回收站',
      okRemovedDir: '已移除 {path}（文件未改动）',
      okRenamed: '已重命名为 {name}',
      okMoved: '已移动到 {source}',
      okCopied: '已复制',
      okCreated: '已创建 {name}',
      okToggled: '已切换开关',
      loadFailed: '加载失败：{message}',
      promptRenameName: '新的技能名（kebab-case）：',
      promptMoveRoot: '移动到哪个根目录？输入序号：\n{options}',
      promptCopyRoot: '复制到哪个根目录？输入序号：\n{options}',
      promptCopyName: '新副本的名字（留空 = 同名，会被最近层遮蔽）：',
      confirmDelete: '把 {name} 移入回收站？\n{path}\n\n（可恢复，但 DSH 将不再加载它）',
      confirmRemoveDir: '从管理器移除这个技能文件夹？\n{path}\n\n只解除管理，目录和里面的技能文件都不会被改动。',
    }

    /** 英文文案：与 {@link ZH} 键集一致，供 locale 字典的 en 槽使用。 */
    var EN = {
      nav: 'Skill manager',
      sidebar: 'Skills',
      loading: 'Loading…',
      summary: 'Total {total} · ok {ok} · warning {warning} · skipped by DSH {broken}',
      summaryShadowed: 'Total {total} · ok {ok} · warning {warning} · skipped by DSH {broken} · shadowed {shadowed}',
      cwd: 'Current project: {path}',
      registryError: 'Could not read the registry: {message}',
      registryOff:
        'Skill registration is off — unmanaged skills: {n}. They show in this panel only; DSH does not load them and the model cannot use them.',
      registryPending: 'On disk but not yet in the DSH catalog (provider refresh lag): {names}',
      newSkill: '＋ New skill',
      // Icon-less twin of `newSkill`: used once the shell's IconPlusOutline16 leads the button.
      newSkillPlain: 'New skill',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      trash: 'Trash',
      rootsTitle: 'Roots (lower rank wins)',
      rootMissing: ' (missing)',
      rootReadonly: ' read-only',
      rootDeep: ' recursive',
      scopeProject: 'project',
      scopeUser: 'user',
      scopeCustom: 'custom',
      scopeBundled: 'bundled',
      customDirs: 'Custom skill folders',
      dirSummary: '{path} (skills: {n})',
      compactDirsHint: 'Add or remove custom folders in Settings → Skill manager.',
      trashHint:
        'Deleted skills are moved here (DSH no longer discovers them). Move one back into a root to restore it.',
      trashEmpty: 'The trash is empty.',
      close: 'Close',
      cancel: 'Cancel',
      confirmBusy: 'Working…',
      emptySkills: 'No skills found. Use “New skill” to create the first one.',
      noWritableRoots: 'No writable root exists.',
      dialogDeleteTitle: 'Move “{name}” to the trash?',
      dialogDeleteBody: 'Recoverable: the files move into that root’s trash and DSH stops loading the skill.',
      dialogDeleteConfirm: 'Move to trash',
      dialogRemoveDirTitle: 'Remove this folder from the manager?',
      dialogRemoveDirBody: 'Management only: the folder and the skill files inside it are left untouched.',
      dialogRemove: 'Remove',
      dialogRenameTitle: 'Rename skill',
      dialogRenameBody:
        'The name is written into the frontmatter name as well, so the file and its name never disagree.',
      dialogRename: 'Rename',
      dialogRenameName: 'New name (kebab-case)',
      dialogMoveTitle: 'Move to which root?',
      dialogMoveBody: 'Only writable roots that exist are listed; DSH reloads the skill from its new layer afterwards.',
      dialogMove: 'Move',
      dialogCopyTitle: 'Copy to where?',
      dialogCopyBody: 'The copy’s frontmatter.name is rewritten to the new name.',
      dialogCopy: 'Copy',
      dialogCopyName: 'New copy’s name',
      tagFlat: 'single file',
      tagModelHidden: 'hidden from model',
      tagSlashHidden: 'hidden from /',
      tagShadowed: 'shadowed',
      tagCopies: '{n} copies',
      shadowedBy: 'Shadowed by {path} (that is the copy DSH uses)',
      edit: 'Edit',
      modelOn: 'Enable for model',
      modelOff: 'Disable for model',
      slashOn: 'Enable /',
      slashOff: 'Disable /',
      del: 'Delete',
      save: 'Save',
      saving: 'Saving…',
      revert: 'Discard changes',
      bodyLabel: 'Body (Markdown)',
      detailTitle: 'Edit {name}',
      savedNote: 'Saved. Frontmatter comments and unknown fields were preserved.',
      detailHint:
        'A body-only edit keeps the frontmatter byte for byte — comments and key order untouched. Editing the two fields above rewrites just those lines.',
      dirsHint1:
        'Add any folder as a skill root (rank 300): skills found there lose to the project layer and beat the user layer.',
      dirsHint2:
        'Scan modes: “top level” reads only <name>/SKILL.md and <name>.md directly under the folder (what DSH does); ' +
        '“recursive” descends up to 3 levels for SKILL.md, for repository-style libraries where skills sit deeper ' +
        '(<collection>/skills/<name>/SKILL.md).',
      dirsReadonly: 'Settings are read-only, so custom folders cannot be saved.',
      dirsEmpty: 'No custom folder added yet.',
      dirMissing: 'Folder missing (DSH skips it)',
      dirSkills: 'skills: {n}',
      deepToggleTitle: 'Look for SKILL.md deeper down (up to 3 levels)',
      deepToggleLabel: 'Scan deeper levels for SKILL.md',
      deep: 'recursive',
      dirPathPlaceholder: 'E:/work/skills or ~/my-skills',
      dirPathLabel: 'Skill folder path',
      browse: 'Browse…',
      add: 'Add',
      deepScanLabel: 'Recursive scan (tick when skills sit deeper down)',
      dirsFooterHint: 'A missing folder is refused — create it first, then add it.',
      addedDir: 'Added {path} ({mode} scan)',
      scanDeep: 'recursive',
      scanShallow: 'top level',
      dirCreated: ', folder created',
      dirSkillCount: ', skills found: {n}',
      dirNoSkills: ', no skills yet',
      picking: 'Asking the system picker…',
      pickFailed: 'Could not open the system picker ({message}); type the folder path instead',
      pickUnsupported: 'No native folder picker in this setup; type the folder path instead',
      picked: 'Selected — press “Add” to confirm',
      deepChanged: '{path} now scans {mode} · skills: {n}',
      createTitle: 'New skill',
      createNameLabel: 'Skill name (kebab-case, e.g. code-review)',
      createNamePlaceholder: 'my-skill',
      createDescriptionLabel:
        'One-line description (enters the session catalog; the model uses it to decide whether to load the skill)',
      createDescriptionPlaceholder: 'When should this skill be used',
      createWhenLabel: 'When to use (optional extra trigger conditions written for the model)',
      createRootLabel: 'Root to write into (lower rank wins)',
      createKindLabel: 'Form',
      kindBundle: 'folder package <name>/SKILL.md',
      kindFlat: 'single file <name>.md',
      create: 'Create',
      createHint:
        'After creating, spell out “when to use / steps / rules”: skills load on demand, and the more specific the description, the more reliably the model reaches for it at the right moment.',
      okDeleted: 'Moved to the trash',
      okRemovedDir: 'Removed {path} (files untouched)',
      okRenamed: 'Renamed to {name}',
      okMoved: 'Moved to {source}',
      okCopied: 'Copied',
      okCreated: 'Created {name}',
      okToggled: 'Switches updated',
      loadFailed: 'Load failed: {message}',
      promptRenameName: 'New skill name (kebab-case):',
      promptMoveRoot: 'Move to which root? Enter a number:\n{options}',
      promptCopyRoot: 'Copy to which root? Enter a number:\n{options}',
      promptCopyName: 'New copy’s name (blank = same name, shadowed by the nearest layer):',
      confirmDelete: 'Move {name} to the trash?\n{path}\n\n(Recoverable, but DSH will no longer load it)',
      confirmRemoveDir:
        'Remove this skill folder from the manager?\n{path}\n\nManagement only — the folder and the skill files inside it are left untouched.',
    }

    /** 中文兜底翻译：结构与外壳的 t 一致（{name} 占位，缺参原样保留）。 */
    function fallbackTranslate(key, params) {
      var template = ZH[key] === undefined ? key : ZH[key]
      if (params === undefined || params === null) return template
      return template.replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      })
    }

    /** 当前翻译函数：装配时若外壳提供 locale 服务就换成它绑定的那份。 */
    var t = fallbackTranslate

    /**
     * 绑定外壳的 locale 服务：注册本插件的 zh/en 字典，并把 t 换成它绑定的翻译函数。
     * 拿不到服务（或注册抛错）时保持 {@link fallbackTranslate} —— 界面继续是中文，
     * 但插件照常装配，绝不因此白屏。
     */
    function bindLocale(ctx) {
      try {
        var locale = ctx && ctx.locale
        if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') return
        if (typeof ctx.effect !== 'function') return
        ctx.effect(function () {
          return locale.register(LOCALE_NS, { zh: ZH, en: EN })
        }, 'dsh-skills-manager: dictionaries')
        t = locale.bind(LOCALE_NS)
      } catch (error) {
        t = fallbackTranslate
      }
    }

    // 外壳自己的 UI 原语（Modal / Button / Input / Switch / Tag / StateDot / Toast…）。
    //
    // 外壳就是用这一套画设置页、删除确认、复制提示的，所以插件直接调它，界面自然
    // 「跟原生一样」：暗色、Esc/点遮罩关闭、焦点行为、动效全都自动对齐，也不用抄样式。
    //
    // 拿不到时必须降级而不是白屏：模块表里没有这个包时 require 会抛，而抛在 factory
    // 里等于整个插件装不上。所以这里吞掉异常，退回自带样式 + 浏览器弹窗。
    var UI = loadPrimitives()

    function loadPrimitives() {
      try {
        var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        if (primitives && typeof primitives.Modal === 'function' && typeof primitives.Button === 'function') {
          return primitives
        }
        return null
      } catch (error) {
        return null
      }
    }

    // ── 主题与样式 ────────────────────────────────────────────────────────────
    var CSS = [
      '.' + CLASS + '{',
      'color-scheme:light;',
      '--sm-fg:var(--dsw-alias-label-primary,#0f1115);',
      '--sm-fg-2:var(--dsw-alias-label-secondary,#61666b);',
      '--sm-fg-3:var(--dsw-alias-label-tertiary,#81858c);',
      '--sm-fg-invert:var(--dsw-alias-label-primary-foreground,#fff);',
      '--sm-border:var(--dsw-alias-border-l2,rgba(0,0,0,.1));',
      '--sm-border-3:var(--dsw-alias-border-l3,rgba(0,0,0,.16));',
      '--sm-field:var(--dsw-alias-bg-layer-2,#f9fafb);',
      '--sm-field-3:var(--dsw-alias-bg-layer-3,#f2f3f5);',
      '--sm-error:var(--dsw-alias-state-error-primary,#ef4444);',
      '--sm-warn:#d97706;/* 0.1.6-alpha.2 ships no warning-state alias token */',
      '--sm-ok:var(--dsw-alias-state-success-primary,#22c55e);',
      '--sm-fill:var(--dsw-alias-button-primary-fill,#0f1115);',
      'color:var(--sm-fg);',
      '}',
      'body[data-ds-dark-theme] .' + CLASS + '{',
      'color-scheme:dark;',
      '--sm-fg:var(--dsw-alias-label-primary,#ebeef2);',
      '--sm-fg-2:var(--dsw-alias-label-secondary,#adb2b8);',
      '--sm-fg-3:var(--dsw-alias-label-tertiary,#81858c);',
      '--sm-fg-invert:var(--dsw-alias-label-primary-foreground,#151517);',
      '--sm-border:var(--dsw-alias-border-l2,rgba(255,255,255,.12));',
      '--sm-border-3:var(--dsw-alias-border-l3,rgba(255,255,255,.2));',
      '--sm-field:var(--dsw-alias-bg-layer-3,#232326);',
      '--sm-field-3:var(--dsw-alias-bg-layer-2,#1c1c1f);',
      '--sm-error:var(--dsw-alias-state-error-primary,#f25a5a);',
      '--sm-warn:#f0a848;/* 0.1.6-alpha.2 ships no warning-state alias token */',
      '--sm-ok:var(--dsw-alias-state-success-primary,#22c55e);',
      '--sm-fill:var(--dsw-alias-button-primary-fill,#ebeef2);',
      '}',
      '.' +
        CLASS +
        ' input:not([class]),.' +
        CLASS +
        ' select,.' +
        CLASS +
        ' textarea{background-color:var(--sm-field);color:var(--sm-fg)}',
      '.' + CLASS + ' option{background-color:var(--sm-field);color:var(--sm-fg)}',
      '.' + CLASS + ' ::placeholder{color:var(--sm-fg-3);opacity:1}',
      // 只给降级路径自带的按钮加 hover/disabled：原生 Button 有自己的 hover/active/
      // disabled 样式，再叠一层 brightness 会跟外壳不一致。
      '.dsh-sm-fallback-btn{transition:filter .15s ease}',
      '.dsh-sm-fallback-btn:not(:disabled):hover{filter:brightness(1.08)}',
      '.dsh-sm-fallback-btn:disabled{opacity:.55;cursor:default}',
      // 弹窗与 Toast 是 portal 到 <body> 的，已经不在 .dsh-skills-manager 里面：--sm-*
      // 定义在插件容器上，在弹窗里解析不到，所以下面这几条不加作用域、直接用外壳 token。
      '.dsh-sm-danger{color:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.dsh-sm-field{width:100%}',
      '.dsh-sm-field-grow{flex:1;min-width:0;width:100%}',
      '.dsh-sm-dialog-body{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dsh-sm-dialog-path{font-size:12px;line-height:18px;word-break:break-all;color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.dsh-sm-root-list{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto}',
      '.' + CLASS + ' ::-webkit-scrollbar{width:10px;height:10px}',
      '.' + CLASS + ' ::-webkit-scrollbar-thumb{background:var(--sm-border-3);border-radius:5px}',
      // 侧栏浮层：外壳给 sidebar.footer.action 的位置在左下角，浮层从这里向上弹。
      '.' + CLASS + '.sm-layer{position:relative;display:flex}',
      // 动作行是外壳的 nowrap 横向 flex，邻座（例如 dsh-memery 的 .dm-layer：外层 width:100%、
      // 里面的按钮再向外出血 4px）占满整行，于是本插件的入口被推到侧栏右边缘之外、被外壳
      // 裁掉，只剩一截圆角边框。只有让容器换行才能救回入口（子项自身怎么调都回不到裁剪区内），
      // 但不再用 `[class*="_footerActions"]` 这种全局片段选择器：它同样命中外壳自己的其它
      // 同名行（例如 user-questions 弹窗的按钮行），还绑死了 CSS Module 的局部名——外壳一改
      // 就静默失效。改成从**本插件注册进去的那个 slot 锚点**出发：data-slot 是渲染器给每个
      // slot 出的锚点（外壳自己的插件也用它选址），:has() 再要求本插件确实在座。只有
      // 「直接子节点是 sidebar.footer.action 锚点、且里面有 .dsh-skills-manager」的那一行
      // 会被改；插件没装/卸载后，规则不命中任何元素。
      ':has(> ' + SLOT_ANCHOR + ' > .' + CLASS + '){flex-wrap:wrap}',
      // 浮层必须 fixed：外壳的侧栏列是 `overflow:hidden`（.pI_x6G_sidebarCol），absolute 的
      // 浮层会被切在侧栏边界上——裁切与 z-index 无关，只有 fixed 才逃得出去。位置不在 CSS 里
      // 猜，而是由 flyoutAnchor 量出触发按钮的 rect 后写进内联样式，保证始终落在视口内。
      '.' + CLASS + ' .sm-flyout{position:fixed;box-sizing:border-box;display:flex;flex-direction:column;',
      'overflow:auto;background:var(--sm-field-3);border:1px solid var(--sm-border);border-radius:12px;',
      'box-shadow:0 12px 40px rgba(0,0,0,.24);padding:12px;z-index:40}',
      '.' + CLASS + ' .sm-flyout-wide{width:min(72vw,780px)}',
    ].join('')

    /** 注入插件自有样式（已存在则复用，避免 HMR 重复注入）。 */
    function ensureStyles() {
      var existing = document.getElementById(STYLE_ID)
      if (existing) return existing
      var el = document.createElement('style')
      el.id = STYLE_ID
      el.setAttribute('data-plugin', 'dsh-skills-manager')
      el.textContent = CSS
      document.head.appendChild(el)
      return el
    }

    // 布局与几何走内联样式；颜色一律取上面的 --sm-* 变量。
    var S = {
      section: { maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 12 },
      title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px', color: 'var(--sm-fg)' },
      intro: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--sm-fg-3)' },
      error: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--sm-error)' },
      warn: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--sm-warn)' },
      ok: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--sm-ok)' },
      card: {
        border: '1px solid var(--sm-border)',
        borderRadius: 12,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      list: { display: 'flex', flexDirection: 'column', gap: 6 },
      row: { display: 'flex', alignItems: 'flex-start', gap: 8 },
      grow: { flex: 1, minWidth: 0 },
      rowHead: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      name: { fontSize: 14, fontWeight: 500, lineHeight: '22px', color: 'var(--sm-fg)', wordBreak: 'break-all' },
      desc: { fontSize: 12, lineHeight: '18px', color: 'var(--sm-fg-2)', wordBreak: 'break-word' },
      detail: { fontSize: 11, lineHeight: '16px', color: 'var(--sm-fg-3)', wordBreak: 'break-all' },
      issue: { fontSize: 11, lineHeight: '16px', color: 'var(--sm-warn)', wordBreak: 'break-word' },
      issueError: { fontSize: 11, lineHeight: '16px', color: 'var(--sm-error)', wordBreak: 'break-word' },
      // 诊断行前缀图标：14px 图标对 11px/16px 文字，inline-flex 才不会把行高撑开。
      issueMark: { display: 'inline-flex', verticalAlign: '-2px', marginRight: 4 },
      tag: {
        border: '1px solid var(--sm-border-3)',
        color: 'var(--sm-fg-2)',
        borderRadius: 4,
        padding: '1px 5px',
        fontSize: 10,
        lineHeight: '15px',
        whiteSpace: 'nowrap',
      },
      dot: { width: 7, height: 7, borderRadius: '50%', display: 'inline-block', flex: 'none' },
      actions: { display: 'flex', gap: 6, marginTop: 2, alignItems: 'center', flexWrap: 'wrap' },
      button: {
        height: 28,
        padding: '0 12px',
        borderRadius: 14,
        border: 'none',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: '18px',
        background: 'var(--sm-fill)',
        color: 'var(--sm-fg-invert)',
      },
      buttonGhost: {
        height: 28,
        padding: '0 12px',
        borderRadius: 14,
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: '18px',
        background: 'transparent',
        color: 'var(--sm-fg-2)',
        border: '1px solid var(--sm-border-3)',
      },
      buttonDanger: {
        height: 28,
        padding: '0 12px',
        borderRadius: 14,
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: '18px',
        background: 'transparent',
        color: 'var(--sm-error)',
        border: '1px solid var(--sm-error)',
      },
      buttonSmall: {
        height: 24,
        padding: '0 9px',
        borderRadius: 12,
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: '16px',
        background: 'transparent',
        color: 'var(--sm-fg-2)',
        border: '1px solid var(--sm-border-3)',
      },
      buttonSmallDanger: {
        height: 24,
        padding: '0 9px',
        borderRadius: 12,
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: '16px',
        background: 'transparent',
        color: 'var(--sm-error)',
        border: '1px solid var(--sm-error)',
      },
      label: { fontSize: 12, lineHeight: '18px', color: 'var(--sm-fg-2)', display: 'block', marginBottom: 3 },
      hint: { fontSize: 11, lineHeight: '16px', color: 'var(--sm-fg-3)' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        height: 30,
        borderRadius: 8,
        border: '1px solid var(--sm-border)',
        padding: '0 9px',
        fontSize: 13,
      },
      textarea: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 220,
        borderRadius: 8,
        border: '1px solid var(--sm-border)',
        padding: '8px 9px',
        fontSize: 12.5,
        lineHeight: '19px',
        resize: 'vertical',
        fontFamily: 'var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)',
      },
      field: { display: 'flex', flexDirection: 'column', gap: 2 },
      form: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        borderTop: '1px solid var(--sm-border)',
        paddingTop: 10,
      },
      group: { display: 'flex', flexDirection: 'column', gap: 4 },
      groupTitle: {
        fontSize: 11,
        lineHeight: '16px',
        color: 'var(--sm-fg-3)',
        textTransform: 'uppercase',
        letterSpacing: '.04em',
      },
      toolbar: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--sm-fg-2)' },
    }

    // ── 原生控件（拿不到原语就退回自带样式） ──────────────────────────────────
    //
    // 这里返回的是**元素**而不是组件：调用方写 button({...}, '删除')，树里就是外壳的
    // Button，不额外包一层，测试也就能直接断言「用的确实是原生组件」。
    // 降级分支只在 loadPrimitives() 拿到 null 时走到，样式与改动前一致。

    /**
     * 外壳图标元素（尺寸默认 16）。
     *
     * 图标是原语包的一部分，跟 Button/Modal 同源：能拿到就用它，字形（'＋'、'✓'…）
     * 只留给降级路径。逐图标判类型而不是判 `UI !== null`：外壳版本旧到没有这个图标
     * 时同样返回 null，调用方照旧退回字形，不会因为多一个 undefined 组件而白屏。
     */
    function icon(name, size) {
      if (UI === null || typeof UI[name] !== 'function') return null
      return e(UI[name], { size: size || 16 })
    }

    /** 按钮元素。danger = 外壳的危险操作写法（outline + 红字）；icon = 前置 16px 图标。 */
    function button(props, children) {
      var variant = props.variant || 'outline'
      var size = props.size || 'sm'
      if (UI !== null) {
        return e(
          UI.Button,
          {
            key: props.key,
            variant: variant,
            size: size,
            icon: props.icon,
            className: props.danger ? 'dsh-sm-danger' : undefined,
            style: props.style,
            disabled: props.disabled,
            title: props.title,
            onClick: props.onClick,
            'aria-label': props.label,
          },
          children,
        )
      }
      // icon 只在上面那个分支有意义：icon() 拿不到原语包时返回 null，降级路径不会有图标。
      var base
      if (size === 'sm') base = props.danger ? S.buttonSmallDanger : S.buttonSmall
      else base = props.danger ? S.buttonDanger : variant === 'primary' ? S.button : S.buttonGhost
      return e(
        'button',
        {
          key: props.key,
          type: 'button',
          className: 'dsh-sm-fallback-btn',
          style: props.style ? Object.assign({}, base, props.style) : base,
          disabled: props.disabled,
          title: props.title,
          onClick: props.onClick,
          'aria-label': props.label,
        },
        children,
      )
    }

    /**
     * 弹窗里的根目录候选行。
     *
     * 选中态原来靠文案前缀「✓ 」表示，现在改走 Button 的 icon 通道（外壳
     * IconCheckOutline16）；拿不到图标时文案照旧带字形，行的行为与外观不变。
     */
    function rootChoice(root, selected, onPick) {
      var check = selected ? icon('IconCheckOutline16', 16) : null
      return button(
        {
          key: root.path,
          variant: selected ? 'primary' : 'outline',
          // Button 默认 36px（md）：这里保持弹窗里原有的尺寸，不跟着工具条的 sm 走。
          size: 'md',
          style: { width: '100%', justifyContent: 'flex-start' },
          icon: check,
          onClick: onPick,
        },
        (check === null && selected ? '✓ ' : '') + '[' + root.source + ' r' + root.rank + '] ' + root.path,
      )
    }

    /**
     * 单行输入框元素。
     *
     * 降级分支故意不给 class：插件那条 `input:not([class])` 配色规则靠这个区分自带
     * 输入框与原生 Input（原生 Input 的 <input> 自带 class，颜色由外壳自己管）。
     */
    function textInput(props) {
      if (UI !== null) {
        return e(UI.Input, {
          className: props.grow ? 'dsh-sm-field-grow' : 'dsh-sm-field',
          value: props.value,
          placeholder: props.placeholder,
          disabled: props.disabled,
          autoFocus: props.autoFocus,
          onKeyDown: props.onKeyDown,
          onChange: props.onChange,
          'aria-label': props.label,
        })
      }
      return e('input', {
        style: props.grow ? Object.assign({}, S.input, S.grow) : S.input,
        value: props.value,
        placeholder: props.placeholder,
        disabled: props.disabled,
        autoFocus: props.autoFocus,
        onKeyDown: props.onKeyDown,
        onChange: props.onChange,
        'aria-label': props.label,
      })
    }

    /** 开关元素：原生 Switch 回调直接给下一个布尔值，自带的 checkbox 需要转一下。 */
    function toggle(props) {
      if (UI !== null) {
        return e(UI.Switch, {
          checked: props.checked === true,
          onChange: props.onChange,
          label: props.label,
          title: props.title,
          disabled: props.disabled,
        })
      }
      return e('input', {
        type: 'checkbox',
        checked: props.checked === true,
        disabled: props.disabled,
        title: props.title,
        'aria-label': props.label,
        onChange: function (event) {
          props.onChange(event.target.checked)
        },
      })
    }

    /** 状态点元素：原生 StateDot 只认 done/warning/error/idle，插件状态要翻译一道。 */
    function dot(status) {
      if (UI !== null) {
        return e(
          'span',
          { style: { marginTop: 7, display: 'inline-flex' } },
          e(UI.StateDot, {
            state: status === 'broken' ? 'error' : status === 'warning' ? 'warning' : 'done',
            size: 8,
          }),
        )
      }
      return e('span', { style: Object.assign({}, S.dot, { background: statusColor(status), marginTop: 7 }) })
    }

    /** 标签元素。tone 走外壳的语义色（被遮蔽 = warning，DSH 会跳过 = danger）。 */
    function chip(tone, children, key) {
      if (UI !== null) return e(UI.Tag, { key: key, tone: tone || 'outline' }, children)
      return e('span', { key: key, style: S.tag }, children)
    }

    /** 官方技能名语法（与 lib/logic.js 的 SKILL_NAME 一致）：先在客户端挡一道。 */
    var SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

    function isValidSkillName(value) {
      return typeof value === 'string' && SKILL_NAME_RE.test(value)
    }

    function noop() {}

    // ── 宿主通信 ──────────────────────────────────────────────────────────────
    /** 调用宿主 API；失败时抛出带宿主错误原文的 Error。 */
    function callHost(payload) {
      return fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }).then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok || body.ok !== true) {
            throw new Error(body && body.error ? body.error : 'HTTP ' + response.status)
          }
          return body.data
        })
      })
    }

    /** 状态色：ok 绿 / warning 黄 / broken 红。 */
    function statusColor(status) {
      if (status === 'broken') return 'var(--sm-error)'
      if (status === 'warning') return 'var(--sm-warn)'
      return 'var(--sm-ok)'
    }

    /** 层 -> 文案键；显示名在渲染时现取，跟着外壳语言走。 */
    var SCOPE_KEYS = {
      project: 'scopeProject',
      user: 'scopeUser',
      custom: 'scopeCustom',
      bundled: 'scopeBundled',
    }

    function scopeLabel(scope) {
      return SCOPE_KEYS[scope] === undefined ? '' : t(SCOPE_KEYS[scope])
    }

    /** 把技能按「层 → 根目录」分组，让遮蔽关系一眼可见。 */
    function groupByRoot(skills, roots) {
      var groups = []
      roots.forEach(function (root) {
        var items = skills.filter(function (skill) {
          return skill.source === root.source && skill.path.indexOf(root.path.replace(/\\/g, '/')) === 0
        })
        if (items.length === 0) return
        groups.push({ root: root, skills: items })
      })
      var known = {}
      groups.forEach(function (group) {
        group.skills.forEach(function (skill) {
          known[skill.path] = true
        })
      })
      var rest = skills.filter(function (skill) {
        return !known[skill.path]
      })
      if (rest.length > 0) groups.push({ root: { source: '?', rank: 999, path: '', scope: '' }, skills: rest })
      return groups
    }

    // ── 弹窗（外壳原生 Modal） ────────────────────────────────────────────────
    //
    // 以前这五处用的是 window.confirm / window.prompt：长得像「127.0.0.1:3080 说…」，
    // 跟外壳完全不是一套皮，而且 prompt 还得让用户输序号。现在统一走外壳的 Modal。

    /**
     * 弹窗规格：标题、说明、确认文案，以及要不要填名字 / 选根目录。
     * 纯函数——文案和「哪些操作算危险」都能脱离 React 断言。
     */
    function dialogSpec(dialog) {
      var target = dialog.target || {}
      switch (dialog.kind) {
        case 'delete':
          return {
            title: t('dialogDeleteTitle', { name: target.name }),
            description: t('dialogDeleteBody'),
            path: target.path,
            confirmLabel: t('dialogDeleteConfirm'),
            danger: true,
          }
        case 'removeDir':
          return {
            title: t('dialogRemoveDirTitle'),
            description: t('dialogRemoveDirBody'),
            path: target.path,
            confirmLabel: t('dialogRemove'),
            danger: true,
          }
        case 'rename':
          return {
            title: t('dialogRenameTitle'),
            description: t('dialogRenameBody'),
            path: target.path,
            confirmLabel: t('dialogRename'),
            danger: false,
            nameLabel: t('dialogRenameName'),
            nameValue: target.name || '',
          }
        case 'move':
          return {
            title: t('dialogMoveTitle'),
            description: t('dialogMoveBody'),
            path: target.path,
            confirmLabel: t('dialogMove'),
            danger: false,
            pickRoot: true,
          }
        case 'copy':
          return {
            title: t('dialogCopyTitle'),
            description: t('dialogCopyBody'),
            path: target.path,
            confirmLabel: t('dialogCopy'),
            danger: false,
            pickRoot: true,
            nameLabel: t('dialogCopyName'),
            nameValue: (target.name || '') + '-copy',
          }
        default:
          return null
      }
    }

    /**
     * 弹窗宿主：一次只开一个。
     *
     * 只在拿得到原语时渲染（UI 为 null 时动作层已经退回 window.confirm/prompt）。
     * Modal 自己 portal 到 body，所以侧栏浮层里也不会被 overflow 裁掉。
     */
    function DialogHost(props) {
      var dialog = props.dialog
      var spec = dialog ? dialogSpec(dialog) : null
      if (UI === null || spec === null) return null

      var roots = props.roots || []
      var busy = props.busy === true
      var state = useState(function () {
        return {
          name: spec.nameValue || '',
          rootPath: roots.length > 0 ? roots[0].path : '',
        }
      })
      var draft = state[0]
      var setDraft = state[1]
      var pick = function (next) {
        setDraft(Object.assign({}, draft, next))
      }
      // 写入过程中不许关：点遮罩、Esc、右上角 × 都走 onClose，这里统一挡掉。
      var close = function () {
        if (!busy) props.onClose()
      }
      var nameOk = spec.nameLabel === undefined || isValidSkillName(draft.name)
      var rootOk = spec.pickRoot !== true || draft.rootPath !== ''

      var body = []
      if (spec.path) body.push(e('div', { key: 'path', className: 'dsh-sm-dialog-path' }, spec.path))
      if (spec.nameLabel !== undefined) {
        body.push(
          e(
            'div',
            { key: 'name', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            e('span', { className: 'dsh-sm-dialog-path' }, spec.nameLabel),
            e(UI.Input, {
              className: 'dsh-sm-field',
              value: draft.name,
              autoFocus: true,
              onChange: function (event) {
                pick({ name: event.target.value })
              },
            }),
          ),
        )
      }
      if (spec.pickRoot === true) {
        body.push(
          e(
            'div',
            { key: 'roots', className: 'dsh-sm-root-list' },
            roots.map(function (root) {
              return rootChoice(root, root.path === draft.rootPath, function () {
                pick({ rootPath: root.path })
              })
            }),
          ),
        )
        if (roots.length === 0) {
          body.push(e('div', { key: 'no-roots', className: 'dsh-sm-dialog-path' }, t('noWritableRoots')))
        }
      }

      return e(
        UI.Modal,
        {
          open: true,
          title: spec.title,
          description: spec.description,
          closeLabel: t('close'),
          onClose: close,
          footer: [
            e(UI.Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: close }, t('cancel')),
            e(
              UI.Button,
              {
                key: 'confirm',
                variant: 'outline',
                className: spec.danger ? 'dsh-sm-danger' : undefined,
                disabled: busy || !nameOk || !rootOk,
                onClick: function () {
                  props.onConfirm({ name: draft.name, rootPath: draft.rootPath })
                },
              },
              busy ? t('confirmBusy') : spec.confirmLabel,
            ),
          ],
        },
        e('div', { className: 'dsh-sm-dialog-body' }, body),
      )
    }

    /** 成功提示：外壳顶部那条深色浮条，3 秒后自己淡出（onDone 回来清状态）。 */
    function ToastHost(props) {
      if (UI === null || !props.toast) return null
      return e(UI.Toast, {
        key: props.toast.id,
        text: props.toast.text,
        icon: e(UI.IconCheckOutline16, { size: 14 }),
        anchor: props.anchor || null,
        holdMs: 3000,
        onDone: props.onDone,
      })
    }

    // ── 子组件 ────────────────────────────────────────────────────────────────
    /** 一个技能的摘要卡片：状态点、名字、标签、诊断、动作按钮。 */
    function SkillRow(props) {
      var skill = props.skill
      var busy = props.busy
      // 标签带语义色：被遮蔽 / 不可见是警告，其余是中性的 outline。
      var tags = []
      tags.push({ text: skill.source + ' r' + skill.rank, tone: 'outline' })
      if (skill.kind === 'flat') tags.push({ text: t('tagFlat'), tone: 'outline' })
      if (skill.invocation && skill.invocation.modelInvocable === false)
        tags.push({ text: t('tagModelHidden'), tone: 'warning' })
      if (skill.invocation && skill.invocation.userInvocable === false)
        tags.push({ text: t('tagSlashHidden'), tone: 'warning' })
      if (skill.shadowed) tags.push({ text: t('tagShadowed'), tone: 'warning' })
      if (skill.copyCount > 1) tags.push({ text: t('tagCopies', { n: skill.copyCount }), tone: 'outline' })

      return e(
        'div',
        { style: S.card },
        e(
          'div',
          { style: S.row },
          dot(skill.status),
          e(
            'div',
            { style: S.grow },
            e(
              'div',
              { style: S.rowHead },
              e('span', { style: S.name }, skill.name),
              tags.map(function (tag) {
                return chip(tag.tone, tag.text, tag.text)
              }),
            ),
            skill.description ? e('div', { style: S.desc }, skill.description) : null,
            e('div', { style: S.detail }, skill.path),
            (skill.issues || [])
              .filter(function (issue) {
                return issue.level !== 'info'
              })
              .map(function (issue, index) {
                var mark = icon('IconWarningOutline16', 14)
                return e(
                  'div',
                  { key: index, style: issue.level === 'error' ? S.issueError : S.issue },
                  mark === null
                    ? (issue.level === 'error' ? '✖ ' : '! ') + issue.message
                    : [e('span', { style: S.issueMark }, mark), issue.message],
                )
              }),
            skill.shadowed ? e('div', { style: S.detail }, t('shadowedBy', { path: skill.winnerPath })) : null,
          ),
        ),
        e(
          'div',
          { style: S.actions },
          button(
            {
              disabled: busy,
              onClick: function () {
                props.onRead(skill)
              },
            },
            t('edit'),
          ),
          button(
            {
              disabled: busy || !(skill.kind === 'bundle' || skill.kind === 'flat'),
              onClick: function () {
                props.onToggle(skill, {
                  modelInvocable: !(skill.invocation && skill.invocation.modelInvocable === false),
                })
              },
            },
            skill.invocation && skill.invocation.modelInvocable === false ? t('modelOn') : t('modelOff'),
          ),
          button(
            {
              disabled: busy,
              onClick: function () {
                props.onToggle(skill, {
                  userInvocable: !(skill.invocation && skill.invocation.userInvocable === false),
                })
              },
            },
            skill.invocation && skill.invocation.userInvocable === false ? t('slashOn') : t('slashOff'),
          ),
          button(
            {
              disabled: busy,
              onClick: function () {
                props.onRename(skill)
              },
            },
            t('dialogRename'),
          ),
          button(
            {
              disabled: busy,
              onClick: function () {
                props.onMove(skill)
              },
            },
            t('dialogMove'),
          ),
          button(
            {
              disabled: busy,
              onClick: function () {
                props.onCopy(skill)
              },
            },
            t('dialogCopy'),
          ),
          button(
            {
              danger: true,
              disabled: busy,
              onClick: function () {
                props.onDelete(skill)
              },
            },
            t('del'),
          ),
        ),
      )
    }

    /**
     * 自定义技能文件夹（rank 300）。
     *
     * 这些目录存在宿主的 settings 里，添加/移除是设置写入，不是文件操作——
     * 所以「移除」只解除管理，绝不动目录里的技能文件，界面上也这么写。
     */
    function CustomDirsCard(props) {
      var dirs = props.dirs || []
      var state = useState({ value: '', error: '', hint: '', busy: false, deep: false })
      var form = state[0]
      var setForm = state[1]
      var patch = function (next) {
        setForm(Object.assign({}, form, next))
      }
      // 成功提示统一交给控制器发原生 Toast；拿不到原语时它会自己退回面板内绿字。
      var notify = props.notify || noop

      var add = function () {
        if (form.value.trim() === '') return
        patch({ busy: true, error: '', hint: '' })
        props
          .onAdd(form.value.trim(), form.deep)
          .then(function (result) {
            patch({ busy: false, value: '', hint: '' })
            notify(
              t('addedDir', { path: result.path, mode: result.deep ? t('scanDeep') : t('scanShallow') }) +
                (result.created ? t('dirCreated') : '') +
                (result.skillCount ? t('dirSkillCount', { n: result.skillCount }) : t('dirNoSkills')),
            )
          })
          .catch(function (error) {
            patch({ busy: false, error: String(error.message || error) })
          })
      }

      var browse = function () {
        patch({ busy: true, error: '', hint: t('picking') })
        props
          .onPick()
          .then(function (result) {
            if (result.supported === false) {
              patch({
                busy: false,
                hint: '',
                error: result.error ? t('pickFailed', { message: result.error }) : t('pickUnsupported'),
              })
              return
            }
            if (!result.path) {
              patch({ busy: false, hint: '' })
              return
            }
            patch({ busy: false, value: result.path, hint: t('picked') })
          })
          .catch(function (error) {
            patch({ busy: false, error: String(error.message || error) })
          })
      }

      // 确认与执行都在控制器里：有原生组件时它开 Modal，拿不到时退回 window.confirm。
      var remove = function (dir) {
        props.onRemove(dir)
      }

      var setDeep = function (dir, deep) {
        patch({ busy: true, error: '', hint: '' })
        props
          .onSetDeep(dir.path, deep)
          .then(function (result) {
            patch({ busy: false })
            notify(
              t('deepChanged', { path: dir.path, mode: deep ? t('scanDeep') : t('scanShallow'), n: result.skillCount }),
            )
          })
          .catch(function (error) {
            patch({ busy: false, error: String(error.message || error) })
          })
      }

      return e(
        'div',
        { style: S.form },
        e('div', { style: S.groupTitle }, t('customDirs')),
        e('p', { style: S.hint }, t('dirsHint1')),
        e('p', { style: S.hint }, t('dirsHint2')),
        form.error ? e('p', { role: 'alert', style: S.error }, form.error) : null,
        form.hint ? e('p', { style: S.hint }, form.hint) : null,

        props.writable === false ? e('p', { style: S.warn }, t('dirsReadonly')) : null,

        dirs.length === 0
          ? e('p', { style: S.intro }, t('dirsEmpty'))
          : e(
              'div',
              { style: S.list },
              dirs.map(function (dir) {
                return e(
                  'div',
                  { key: dir.path, style: S.row },
                  e(
                    'div',
                    { style: S.grow },
                    e('div', { style: S.desc }, dir.path),
                    e(
                      'div',
                      { style: S.detail },
                      dir.exists === false ? t('dirMissing') : t('dirSkills', { n: dir.skillCount }),
                    ),
                  ),
                  e(
                    'span',
                    { style: S.checkboxRow, title: t('deepToggleTitle') },
                    toggle({
                      checked: dir.deep === true,
                      disabled: form.busy || props.writable === false,
                      label: t('deepToggleLabel'),
                      onChange: function (next) {
                        setDeep(dir, next)
                      },
                    }),
                    t('deep'),
                  ),
                  button(
                    {
                      danger: true,
                      disabled: form.busy || props.writable === false,
                      onClick: function () {
                        remove(dir)
                      },
                    },
                    t('dialogRemove'),
                  ),
                )
              }),
            ),

        e(
          'div',
          { style: S.row },
          textInput({
            grow: true,
            value: form.value,
            placeholder: t('dirPathPlaceholder'),
            label: t('dirPathLabel'),
            onChange: function (event) {
              patch({ value: event.target.value })
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter') add()
            },
          }),
          button({ disabled: form.busy, onClick: browse }, t('browse')),
          button(
            {
              variant: 'primary',
              disabled: form.busy || props.writable === false || form.value.trim() === '',
              onClick: add,
            },
            t('add'),
          ),
        ),
        e(
          'span',
          { style: S.checkboxRow },
          toggle({
            checked: form.deep === true,
            disabled: form.busy,
            label: t('deepScanLabel'),
            onChange: function (next) {
              patch({ deep: next })
            },
          }),
          t('deepScanLabel'),
        ),
        e('p', { style: S.hint }, t('dirsFooterHint')),
      )
    }

    /** 新建表单：名字 + 一句话说明 + 目标根目录 + 形态。 */
    function CreateForm(props) {
      var roots = props.roots
      var state = useState({
        name: '',
        description: '',
        rootPath: roots[0] ? roots[0].path : '',
        kind: 'bundle',
        whenToUse: '',
      })
      var form = state[0]
      var setForm = state[1]
      var patch = function (next) {
        setForm(Object.assign({}, form, next))
      }

      return e(
        'div',
        { style: S.form },
        e('div', { style: S.groupTitle }, t('createTitle')),
        e(
          'div',
          { style: S.field },
          e('label', { style: S.label }, t('createNameLabel')),
          textInput({
            value: form.name,
            placeholder: t('createNamePlaceholder'),
            label: t('createNameLabel'),
            onChange: function (event) {
              patch({ name: event.target.value })
            },
          }),
        ),
        e(
          'div',
          { style: S.field },
          e('label', { style: S.label }, t('createDescriptionLabel')),
          textInput({
            value: form.description,
            placeholder: t('createDescriptionPlaceholder'),
            label: t('createDescriptionLabel'),
            onChange: function (event) {
              patch({ description: event.target.value })
            },
          }),
        ),
        e(
          'div',
          { style: S.field },
          e('label', { style: S.label }, t('createWhenLabel')),
          textInput({
            value: form.whenToUse,
            label: t('createWhenLabel'),
            onChange: function (event) {
              patch({ whenToUse: event.target.value })
            },
          }),
        ),
        e(
          'div',
          { style: S.row },
          e(
            'div',
            { style: Object.assign({}, S.field, S.grow) },
            e('label', { style: S.label }, t('createRootLabel')),
            e(
              'select',
              {
                style: S.input,
                value: form.rootPath,
                onChange: function (event) {
                  patch({ rootPath: event.target.value })
                },
              },
              roots.map(function (root) {
                return e(
                  'option',
                  { key: root.path, value: root.path },
                  '[' + root.source + ' r' + root.rank + '] ' + root.path,
                )
              }),
            ),
          ),
          e(
            'div',
            { style: S.field },
            e('label', { style: S.label }, t('createKindLabel')),
            e(
              'select',
              {
                style: S.input,
                value: form.kind,
                onChange: function (event) {
                  patch({ kind: event.target.value })
                },
              },
              e('option', { value: 'bundle' }, t('kindBundle')),
              e('option', { value: 'flat' }, t('kindFlat')),
            ),
          ),
        ),
        e(
          'div',
          { style: S.actions },
          button(
            {
              variant: 'primary',
              disabled: props.busy || form.name === '' || form.description === '',
              onClick: function () {
                props.onSubmit(form)
              },
            },
            t('create'),
          ),
          button({ disabled: props.busy, onClick: props.onCancel }, t('cancel')),
        ),
        e('p', { style: S.hint }, t('createHint')),
      )
    }

    /** 详情编辑器：frontmatter 字段（行级手术）+ 正文。 */
    function DetailPanel(props) {
      var skill = props.skill
      var busy = props.busy
      var state = useState({
        description: skill.description || '',
        whenToUse: skill.whenToUse || '',
        body: skill.body || '',
        error: '',
      })
      var form = state[0]
      var setForm = state[1]
      var patch = function (next) {
        setForm(Object.assign({}, form, next))
      }
      var notify = props.notify || noop

      useEffect(
        function () {
          setForm({
            description: skill.description || '',
            whenToUse: skill.whenToUse || '',
            body: skill.body || '',
            error: '',
          })
        },
        [skill.path],
      )

      var save = function () {
        patch({ error: '' })
        props
          .onSave(skill, { description: form.description, whenToUse: form.whenToUse, body: form.body })
          .then(function () {
            notify(t('savedNote'))
          })
          .catch(function (error) {
            patch({ error: String(error.message || error) })
          })
      }

      return e(
        'div',
        { style: S.form },
        e('div', { style: S.groupTitle }, t('detailTitle', { name: skill.name || skill.fileName })),
        e('p', { style: S.detail }, skill.path),
        form.error ? e('p', { role: 'alert', style: S.error }, form.error) : null,
        (skill.issues || [])
          .filter(function (issue) {
            return issue.level !== 'info'
          })
          .map(function (issue, index) {
            return e('p', { key: index, style: issue.level === 'error' ? S.error : S.warn }, issue.message)
          }),
        e(
          'div',
          { style: S.field },
          e('label', { style: S.label }, 'description'),
          textInput({
            value: form.description,
            label: 'description',
            onChange: function (event) {
              patch({ description: event.target.value })
            },
          }),
        ),
        e(
          'div',
          { style: S.field },
          e('label', { style: S.label }, 'whenToUse'),
          textInput({
            value: form.whenToUse,
            label: 'whenToUse',
            onChange: function (event) {
              patch({ whenToUse: event.target.value })
            },
          }),
        ),
        e(
          'div',
          { style: S.field },
          e('label', { style: S.label }, t('bodyLabel')),
          e('textarea', {
            style: S.textarea,
            value: form.body,
            onChange: function (event) {
              patch({ body: event.target.value })
            },
          }),
        ),
        e(
          'div',
          { style: S.actions },
          button({ variant: 'primary', disabled: busy, onClick: save }, busy ? t('saving') : t('save')),
          button(
            {
              disabled: busy,
              onClick: function () {
                props.onReload(skill)
              },
            },
            t('revert'),
          ),
          button({ disabled: busy, onClick: props.onClose }, t('close')),
        ),
        e('p', { style: S.hint }, t('detailHint')),
      )
    }

    /** 主体：概览 + 根目录 + 技能列表 + 可选的面板。 */
    function SkillsView(props) {
      var compact = props.compact === true
      var data = props.data
      var busy = props.busy
      var panel = props.panel
      var ctx = props.ctx
      if (data === null) return e('p', { style: S.intro }, t('loading'))

      var roots = data.roots.filter(function (root) {
        return root.writable
      })
      var groups = groupByRoot(data.skills, data.roots)
      var summary = data.summary
      // 新建按钮的前置图标：拿得到外壳图标就用它，文案换成无字形的那条（见 button 调用）。
      var addIcon = icon('IconPlusOutline16', 16)

      return e(
        'div',
        { style: compact ? { display: 'flex', flexDirection: 'column', gap: 10 } : S.section },
        e(
          'div',
          { style: S.row },
          e(
            'div',
            { style: S.grow },
            e('h2', { style: compact ? S.name : S.title }, t('nav')),
            e(
              'p',
              { style: S.intro },
              summary.shadowed > 0
                ? t('summaryShadowed', {
                    total: summary.total,
                    ok: summary.ok,
                    warning: summary.warning,
                    broken: summary.broken,
                    shadowed: summary.shadowed,
                  })
                : t('summary', {
                    total: summary.total,
                    ok: summary.ok,
                    warning: summary.warning,
                    broken: summary.broken,
                  }),
            ),
          ),
        ),
        e('p', { style: S.hint }, t('cwd', { path: data.cwd })),
        data.registry && data.registry.registryError
          ? e('p', { style: S.warn }, t('registryError', { message: data.registry.registryError }))
          : null,
        data.registry && data.registry.inventory === false && data.registry.unmanagedCount > 0
          ? e('p', { style: S.warn }, t('registryOff', { n: data.registry.unmanagedCount }))
          : null,
        data.registry && data.registry.pendingRegistration && data.registry.pendingRegistration.length > 0
          ? e('p', { style: S.hint }, t('registryPending', { names: data.registry.pendingRegistration.join(', ') }))
          : null,

        e(
          'div',
          { style: S.toolbar },
          button(
            {
              variant: 'primary',
              // 拿得到外壳图标就用图标（文案随之换成无字形的那条），否则原样退回「＋ 」。
              icon: addIcon,
              disabled: busy,
              onClick: function () {
                props.onNew()
              },
            },
            addIcon === null ? t('newSkill') : t('newSkillPlain'),
          ),
          button({ disabled: busy, onClick: props.onReload }, busy ? t('refreshing') : t('refresh')),
          button(
            {
              disabled: busy,
              onClick: function () {
                props.onTrash(roots[0])
              },
            },
            t('trash'),
          ),
        ),

        e(
          'div',
          { style: S.group },
          e('div', { style: S.groupTitle }, t('rootsTitle')),
          data.roots.map(function (root) {
            return e(
              'div',
              { key: root.source + root.path, style: S.detail },
              '[' +
                root.source +
                ' r' +
                root.rank +
                (scopeLabel(root.scope) ? ' ' + scopeLabel(root.scope) : '') +
                '] ' +
                root.path +
                (root.exists ? '' : t('rootMissing')) +
                (root.writable ? '' : t('rootReadonly')) +
                (root.deep ? t('rootDeep') : ''),
            )
          }),
        ),

        // 侧栏浮层太窄，放不下输入框与系统选择框，只做只读提示，引导去设置页。
        compact
          ? props.dirs && props.dirs.length > 0
            ? e(
                'div',
                { style: S.group },
                e('div', { style: S.groupTitle }, t('customDirs')),
                props.dirs.map(function (dir) {
                  return e(
                    'div',
                    { key: dir.path, style: S.detail },
                    t('dirSummary', { path: dir.path, n: dir.skillCount }),
                  )
                }),
                e('p', { style: S.hint }, t('compactDirsHint')),
              )
            : null
          : e(CustomDirsCard, {
              dirs: props.dirs,
              writable: props.dirsWritable,
              onAdd: props.onAddDir,
              onRemove: props.onRemoveDir,
              onPick: props.onPickDir,
              onSetDeep: props.onSetDirDeep,
              notify: props.notify,
            }),

        panel === 'create'
          ? e(CreateForm, {
              roots: roots,
              busy: busy,
              onCancel: function () {
                props.onPanel(null)
              },
              onSubmit: function (form) {
                props.onCreate(form)
              },
            })
          : null,

        panel && panel.kind === 'detail'
          ? e(DetailPanel, {
              skill: panel.skill,
              busy: busy,
              onSave: props.onSave,
              onReload: function (skill) {
                props.onRead(skill)
              },
              onClose: function () {
                props.onPanel(null)
              },
              notify: props.notify,
            })
          : null,

        panel === 'trash'
          ? e(
              'div',
              { style: S.form },
              e('div', { style: S.groupTitle }, t('trash')),
              e('p', { style: S.hint }, t('trashHint')),
              (props.trash || []).length === 0
                ? e('p', { style: S.intro }, t('trashEmpty'))
                : props.trash.map(function (item) {
                    return e('div', { key: item.path, style: S.detail }, (item.mtime || '') + '  ' + item.path)
                  }),
              e(
                'div',
                { style: S.actions },
                button(
                  {
                    onClick: function () {
                      props.onPanel(null)
                    },
                  },
                  t('close'),
                ),
              ),
            )
          : null,

        groups.length === 0
          ? e('p', { style: S.intro }, t('emptySkills'))
          : groups.map(function (group) {
              return e(
                'div',
                { key: group.root.source + group.root.path, style: S.group },
                e(
                  'div',
                  { style: S.groupTitle },
                  '[' + group.root.source + ' r' + group.root.rank + '] ' + group.root.path,
                ),
                e(
                  'div',
                  { style: S.list },
                  group.skills.map(function (skill) {
                    return e(SkillRow, {
                      key: skill.path,
                      skill: skill,
                      busy: busy,
                      onRead: function (item) {
                        props.onRead(item)
                      },
                      onToggle: function (item, change) {
                        props.onToggle(item, change)
                      },
                      onRename: function (item) {
                        props.onRename(item)
                      },
                      onMove: function (item) {
                        props.onMove(item)
                      },
                      onCopy: function (item) {
                        props.onCopy(item)
                      },
                      onDelete: function (item) {
                        props.onDelete(item)
                      },
                    })
                  }),
                ),
              )
            }),
      )
    }

    /**
     * 动作层：把「点一下会发生什么」从组件里抽出来。
     *
     * 这么拆的实打实好处：像「有原生组件时绝不调用 window.confirm」这种事，只有直接
     * 调动作才测得准——渲染出来的树里看不见「没被调用的浏览器弹窗」。
     *
     * deps: { UI, win, patch, view, callHost, alive, reload }
     */
    function createActions(deps) {
      var ui = deps.UI
      var win = deps.win || window
      var patch = deps.patch
      var view = deps.view
      var callHost = deps.callHost
      var alive = deps.alive
      var reload = deps.reload
      var toastSeq = 0

      /** 成功提示：有原生组件就走顶部 Toast，拿不到就退回面板内的绿字。 */
      var notify = function (text) {
        if (text === undefined || text === null || text === '') return
        if (ui === null) {
          patch({ notice: text })
          return
        }
        toastSeq += 1
        patch({ toast: { id: toastSeq, text: text } })
      }

      var run = function (payload, okMessage) {
        patch({ busy: true, error: '' })
        return callHost(payload)
          .then(function (result) {
            if (!alive.current) return result
            patch({ busy: false })
            notify(okMessage)
            return reload().then(function () {
              return result
            })
          })
          .catch(function (error) {
            if (!alive.current) throw error
            patch({ busy: false, error: String(error.message || error) })
            throw error
          })
      }

      /** 可写且存在的根目录——移动/复制只认这些，别让用户选一个注定失败的目标。 */
      var writableRoots = function () {
        var data = view.data
        if (!data || !Array.isArray(data.roots)) return []
        return data.roots.filter(function (root) {
          return root.writable && root.exists
        })
      }

      var rootByPath = function (path) {
        var roots = writableRoots()
        for (var index = 0; index < roots.length; index += 1) {
          if (roots[index].path === path) return roots[index]
        }
        return null
      }

      /**
       * 每种操作对应的宿主请求与成功文案。
       * 弹窗路径与降级路径共用同一份，免得两边各写一遍再慢慢走偏。
       */
      var operation = function (kind, target, payload) {
        var name = (payload && payload.name) || ''
        var rootPath = (payload && payload.rootPath) || ''
        var owner
        switch (kind) {
          case 'delete':
            return { request: { action: 'delete', path: target.path, kind: target.kind }, ok: t('okDeleted') }
          case 'removeDir':
            return { request: { action: 'removeDir', path: target.path }, ok: t('okRemovedDir', { path: target.path }) }
          case 'rename':
            return {
              request: { action: 'rename', path: target.path, kind: target.kind, newName: name },
              ok: t('okRenamed', { name: name }),
            }
          case 'move':
            owner = rootByPath(rootPath)
            return {
              request: { action: 'move', path: target.path, kind: target.kind, targetRoot: rootPath },
              ok: t('okMoved', { source: owner ? owner.source : rootPath }),
            }
          case 'copy':
            return {
              request: {
                action: 'copy',
                path: target.path,
                kind: target.kind,
                targetRoot: rootPath,
                newName: name || undefined,
              },
              ok: t('okCopied'),
            }
          default:
            return null
        }
      }

      /** 执行完（成功或失败）都关掉弹窗：错误由面板顶部的红字承接。 */
      var finish = function (promise) {
        var close = function () {
          patch({ dialog: null })
        }
        return promise.then(
          function (value) {
            close()
            return value
          },
          function (error) {
            close()
            throw error
          },
        )
      }

      var openDialog = function (kind, target) {
        patch({ dialog: { kind: kind, target: target } })
      }

      /** 浏览器弹窗兜底：只有拿不到外壳原语时才会走到这里。 */
      var fallbackConfirm = function (message) {
        return win.confirm(message) === true
      }

      var fallbackRun = function (kind, target, payload) {
        var plan = operation(kind, target, payload)
        if (plan === null) return
        run(plan.request, plan.ok).catch(noop)
      }

      var rootOptions = function (roots) {
        return roots
          .map(function (root, index) {
            return index + 1 + '. [' + root.source + '] ' + root.path
          })
          .join('\n')
      }

      var actions = {
        run: run,
        notify: notify,

        onReload: reload,
        onNew: function () {
          patch({ panel: 'create', error: '' })
        },
        onPanel: function (panel) {
          patch({ panel: panel, error: '' })
        },
        onRead: function (skill) {
          patch({ busy: true, error: '' })
          callHost({ action: 'read', path: skill.path })
            .then(function (data) {
              if (!alive.current) return
              patch({ busy: false, panel: { kind: 'detail', skill: data.skill } })
            })
            .catch(function (error) {
              if (!alive.current) return
              patch({ busy: false, error: String(error.message || error) })
            })
        },
        // 保存成功的提示由详情面板自己发（它那句更具体），所以这里不给 okMessage。
        onSave: function (skill, changes) {
          return run({
            action: 'update',
            path: skill.path,
            fields: { description: changes.description, whenToUse: changes.whenToUse },
            body: changes.body,
          }).then(function () {
            actions.onRead(skill)
          })
        },
        onCreate: function (form) {
          run(
            {
              action: 'create',
              name: form.name,
              description: form.description,
              whenToUse: form.whenToUse || undefined,
              rootPath: form.rootPath,
              kind: form.kind,
            },
            t('okCreated', { name: form.name }),
          )
            .then(function () {
              patch({ panel: null })
            })
            .catch(noop)
        },
        onToggle: function (skill, change) {
          run(
            {
              action: 'toggle',
              path: skill.path,
              modelInvocable: change.modelInvocable,
              userInvocable: change.userInvocable,
            },
            t('okToggled'),
          ).catch(noop)
        },
        onRename: function (skill) {
          if (ui !== null) {
            openDialog('rename', skill)
            return
          }
          var next = win.prompt(t('promptRenameName'), skill.name || skill.fileName)
          if (next === null || next === '') return
          fallbackRun('rename', skill, { name: next })
        },
        onMove: function (skill) {
          if (ui !== null) {
            openDialog('move', skill)
            return
          }
          var roots = writableRoots()
          var answer = win.prompt(t('promptMoveRoot', { options: rootOptions(roots) }), '1')
          if (answer === null) return
          var target = roots[Number(answer) - 1]
          if (!target) return
          fallbackRun('move', skill, { rootPath: target.path })
        },
        onCopy: function (skill) {
          if (ui !== null) {
            openDialog('copy', skill)
            return
          }
          var roots = writableRoots()
          var answer = win.prompt(t('promptCopyRoot', { options: rootOptions(roots) }), '1')
          if (answer === null) return
          var target = roots[Number(answer) - 1]
          if (!target) return
          var newName = win.prompt(t('promptCopyName'), skill.name + '-copy')
          if (newName === null) return
          fallbackRun('copy', skill, { rootPath: target.path, name: newName })
        },
        onDelete: function (skill) {
          if (ui !== null) {
            openDialog('delete', skill)
            return
          }
          if (!fallbackConfirm(t('confirmDelete', { name: skill.name, path: skill.path }))) return
          fallbackRun('delete', skill, null)
        },
        onTrash: function (root) {
          if (!root) return
          patch({ busy: true, error: '' })
          callHost({ action: 'trash', rootPath: root.path })
            .then(function (data) {
              if (!alive.current) return
              patch({ busy: false, panel: 'trash', trash: data.items })
            })
            .catch(function (error) {
              if (!alive.current) return
              patch({ busy: false, error: String(error.message || error) })
            })
        },
        // 自定义技能文件夹：添加/移除后刷新列表，让新目录里的技能立刻出现。
        // 这里把宿主返回的 data 透传给调用方（卡片要显示「扫到几个技能」）。
        onAddDir: function (path, deep) {
          patch({ busy: true, error: '', notice: '' })
          return callHost({ action: 'addDir', path: path, deep: deep === true })
            .then(function (result) {
              if (!alive.current) return result
              patch({ busy: false })
              return reload().then(function () {
                return result
              })
            })
            .catch(function (error) {
              if (!alive.current) throw error
              patch({ busy: false, error: String(error.message || error) })
              throw error
            })
        },
        onSetDirDeep: function (path, deep) {
          patch({ busy: true, error: '', notice: '' })
          return callHost({ action: 'setDirDeep', path: path, deep: deep === true })
            .then(function (result) {
              if (!alive.current) return result
              patch({ busy: false })
              return reload().then(function () {
                return result
              })
            })
            .catch(function (error) {
              if (!alive.current) throw error
              patch({ busy: false, error: String(error.message || error) })
              throw error
            })
        },
        // 移除文件夹只解除管理，不动目录里的技能文件——所以确认框里也这么写。
        onRemoveDir: function (dir) {
          if (ui !== null) {
            openDialog('removeDir', dir)
            return
          }
          if (!fallbackConfirm(t('confirmRemoveDir', { path: dir.path }))) return
          fallbackRun('removeDir', dir, null)
        },
        onPickDir: function () {
          return callHost({ action: 'pickDir' })
        },

        /** 弹窗上点「确认」：按 kind 发对应请求，结束后关窗。 */
        submitDialog: function (payload) {
          var dialog = view.dialog
          if (!dialog) return Promise.resolve()
          var plan = operation(dialog.kind, dialog.target, payload)
          if (plan === null) return Promise.resolve()
          return finish(run(plan.request, plan.ok)).catch(noop)
        },
      }

      return actions
    }

    /**
     * 数据与动作的容器。两个入口（设置页 / 侧栏）共用它，只是 compact 不同。
     */
    function SkillsController(props) {
      var ctx = props.ctx
      var compact = props.compact === true
      var state = useState({
        data: null,
        busy: false,
        error: '',
        notice: '',
        panel: null,
        trash: [],
        dirs: [],
        dirsWritable: true,
        dialog: null,
        toast: null,
      })
      var view = state[0]
      var setView = state[1]
      var patch = function (next) {
        setView(function (current) {
          return Object.assign({}, current, next)
        })
      }
      var alive = useRef(true)
      var rootRef = useRef(null)
      useEffect(function () {
        return function () {
          alive.current = false
        }
      }, [])

      var reload = useCallback(function () {
        patch({ busy: true, error: '' })
        // 自定义文件夹单独取一次：它来自 settings，不在技能快照里。
        var dirsCall = callHost({ action: 'dirs' }).catch(function () {
          return null
        })
        return Promise.all([callHost({ action: 'list' }), dirsCall])
          .then(function (results) {
            if (!alive.current) return
            var data = results[0]
            var dirs = results[1]
            patch({
              data: data,
              busy: false,
              dirs: dirs ? dirs.dirs : [],
              dirsWritable: dirs ? dirs.writable !== false : true,
            })
          })
          .catch(function (error) {
            if (!alive.current) return
            patch({ busy: false, error: t('loadFailed', { message: String(error.message || error) }) })
          })
      }, [])

      useEffect(
        function () {
          reload()
        },
        [reload],
      )

      var actions = createActions({
        UI: UI,
        win: window,
        patch: patch,
        view: view,
        callHost: callHost,
        alive: alive,
        reload: reload,
      })

      var dialog = view.dialog
      // 换目标就重挂弹窗：useState 的初始值（默认名字、默认根目录）才会跟着换。
      var dialogKey = dialog ? dialog.kind + '|' + ((dialog.target && dialog.target.path) || '') : 'none'
      var roots = view.data
        ? view.data.roots.filter(function (root) {
            return root.writable && root.exists
          })
        : []

      return e(
        'div',
        { className: CLASS, ref: rootRef },
        view.error ? e('p', { role: 'alert', style: S.error }, view.error) : null,
        view.notice ? e('p', { style: S.ok }, view.notice) : null,
        e(
          SkillsView,
          Object.assign({}, actions, {
            ctx: ctx,
            data: view.data,
            busy: view.busy,
            panel: view.panel,
            trash: view.trash,
            dirs: view.dirs,
            dirsWritable: view.dirsWritable,
            compact: compact,
          }),
        ),
        e(DialogHost, {
          key: dialogKey,
          dialog: dialog,
          roots: roots,
          busy: view.busy,
          onClose: function () {
            patch({ dialog: null })
          },
          onConfirm: actions.submitDialog,
        }),
        e(ToastHost, {
          toast: view.toast,
          anchor: rootRef.current,
          onDone: function () {
            patch({ toast: null })
          },
        }),
      )
    }

    /**
     * 量出浮层该待的位置：贴着触发按钮向上弹，横向不外溢视口。
     * 纯函数——真实几何由 getBoundingClientRect 喂进来，所以可以脱离浏览器单测。
     * 输入：触发按钮的 rect（left/top 就够）、视口尺寸、期望宽度。
     * 输出：写进浮层内联样式的 left / bottom / width / maxHeight（都是 px 数值）。
     */
    function flyoutAnchor(trigger, viewport, width) {
      var gap = 8 // 浮层与按钮之间的缝
      var margin = 12 // 浮层与视口边缘的最小留白
      var w = Math.round(Math.max(200, Math.min(width || 400, viewport.width - margin * 2)))
      var left = Math.min(Math.max(trigger.left, margin), viewport.width - w - margin)
      return {
        left: Math.round(Math.max(left, margin)),
        bottom: Math.round(viewport.height - trigger.top + gap),
        width: w,
        // 往上能长多高：按钮上方的剩余空间与 70vh 取小；再小也给 160px，免得成一条缝。
        maxHeight: Math.round(Math.max(160, Math.min(viewport.height * 0.7, trigger.top - gap - margin))),
      }
    }

    /**
     * 入口可见性自检：动作行是 nowrap 的横向 flex，邻座占满整行时入口会被推到行外、被侧栏裁掉。
     * 换行规则要是没生效（外壳换了 slot 锚点、浏览器不认 :has()），这件事不能静默发生——
     * 直接量入口与所在行的位置，出界就返回警示文案（量不到几何的环境不判断）。
     * @param {Element|null} node 本插件的侧栏入口根节点
     * @returns {string|null} 警示文案；入口落在行内时 null
     */
    function entryWrapWarning(node) {
      if (node === null || node === undefined || typeof node.closest !== 'function') return null
      var anchor = node.closest(SLOT_ANCHOR)
      if (anchor === null)
        return '找不到 ' + SIDEBAR_SLOT + ' 的 slot 锚点（' + SLOT_ANCHOR + '），入口的换行规则不会命中'
      var row = anchor.parentElement
      if (row === null || row === undefined || typeof node.getBoundingClientRect !== 'function') return null
      var mine = node.getBoundingClientRect()
      var box = row.getBoundingClientRect()
      if (mine.right <= box.right + 0.5 && mine.left >= box.left - 0.5) return null
      return (
        '侧栏入口被挤到动作行外（右边界超出 ' +
        Math.round(mine.right - box.right) +
        'px），' +
        STYLE_ID +
        ' 里的换行规则没生效'
      )
    }

    /** 侧栏脚：一个按钮 + 向上弹出的浮层。 */
    function SidebarEntry(props) {
      var ctx = props.ctx
      // 入口图标：外壳的 skill 字形（文档 + 星点），拿不到才用原来的「◈」。
      var glyph = icon('IconSkillOutline16', 14)
      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var rootRef = useRef(null)
      var buttonRef = useRef(null)
      var anchorState = useState(null)
      var anchor = anchorState[0]
      var setAnchor = anchorState[1]

      // 挂载后核对一次入口有没有被挤出动作行——出界就在控制台点名，而不是让它悄悄消失。
      useEffect(function () {
        var warning = entryWrapWarning(rootRef.current)
        if (warning !== null) console.warn('[dsh-skills-manager] ' + warning)
      }, [])

      // 开着的时候跟着按钮走：视口尺寸或滚动一变就重新量，免得浮层飘走。
      useEffect(
        function () {
          if (!open) return undefined
          var measure = function () {
            var node = buttonRef.current
            if (!node || typeof node.getBoundingClientRect !== 'function') return
            setAnchor(
              flyoutAnchor(node.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, 400),
            )
          }
          measure()
          window.addEventListener('resize', measure)
          window.addEventListener('scroll', measure, true)
          return function () {
            window.removeEventListener('resize', measure)
            window.removeEventListener('scroll', measure, true)
            setAnchor(null)
          }
        },
        [open],
      )

      useEffect(
        function () {
          if (!open) return undefined
          var onPointer = function (event) {
            var node = rootRef.current
            if (node && event.target && node.contains(event.target)) return
            setOpen(false)
          }
          var onKey = function (event) {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('mousedown', onPointer)
          document.addEventListener('keydown', onKey)
          return function () {
            document.removeEventListener('mousedown', onPointer)
            document.removeEventListener('keydown', onKey)
          }
        },
        [open],
      )

      return e(
        'div',
        { ref: rootRef, className: CLASS + ' sm-layer' },
        open
          ? e(
              'section',
              {
                className: 'sm-flyout',
                'aria-label': t('nav'),
                // 第一帧还没量到按钮位置：先渲染但藏起来，避免闪一下错位。
                style:
                  anchor === null
                    ? { visibility: 'hidden' }
                    : {
                        left: anchor.left,
                        bottom: anchor.bottom,
                        width: anchor.width,
                        maxHeight: anchor.maxHeight,
                      },
              },
              e(SkillsController, { ctx: ctx, compact: true }),
            )
          : null,
        e(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            className: 'dsh-sm-fallback-btn',
            'aria-label': t('nav'),
            'aria-expanded': open,
            onClick: function () {
              setOpen(function (value) {
                return !value
              })
            },
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 32,
              padding: '0 10px',
              borderRadius: 16,
              cursor: 'pointer',
              fontSize: 12,
              background: 'transparent',
              color: 'var(--sm-fg-2)',
              border: '1px solid var(--sm-border-3)',
            },
          },
          glyph === null ? e('span', { 'aria-hidden': true, style: { fontSize: 14, lineHeight: 1 } }, '◈') : glyph,
          e('span', null, t('sidebar')),
        ),
      )
    }

    /** 设置页整页。 */
    function SettingsSection(props) {
      return e(SkillsController, { ctx: props.ctx, compact: false })
    }

    // ── 插件 ──────────────────────────────────────────────────────────────────
    // locale 是外壳 0.1.6-alpha.2 起提供的服务：声明它以后本插件等它就绪再装配，
    // 两个入口的文案（含 settings.section 的 label 与侧栏按钮）才会跟着壳的语言。
    // 它缺席时 apply 仍会被直接调用（例如测试或旧外壳），那时 bindLocale 保持中文兜底。
    var inject = ['slots', 'locale']
    function apply(ctx) {
      var style = ensureStyles()
      ctx.effect(function () {
        return function () {
          style.remove()
        }
      })
      bindLocale(ctx)
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'skill-manager',
            order: 29,
            // thunk：外壳 resolveSlotLabel 每次渲染现取，切语言不需要重新注册。
            label: function () {
              return t('nav')
            },
          },
          function Bound(props) {
            return e(SettingsSection, Object.assign({}, props, { ctx: ctx }))
          },
        )
      })
      ctx.slots.inject(SIDEBAR_SLOT, function () {
        return ctx.slots.register(
          {
            name: SIDEBAR_SLOT,
            id: 'skill-manager',
            order: 21,
            label: function () {
              return t('nav')
            },
          },
          function Bound(props) {
            return e(SidebarEntry, Object.assign({}, props, { ctx: ctx }))
          },
        )
      })
    }

    // 浏览器加载器只消费 apply/inject；多出的导出供 node:test 做兼容性测试。
    exports.apply = apply
    exports.inject = inject
    exports.API_PATH = API
    exports.CLASS = CLASS
    exports.CSS = CSS
    exports.STYLES = S
    exports.UI = UI
    exports.callHost = callHost
    exports.statusColor = statusColor
    exports.groupByRoot = groupByRoot
    exports.isValidSkillName = isValidSkillName
    exports.dialogSpec = dialogSpec
    exports.button = button
    exports.icon = icon
    exports.rootChoice = rootChoice
    exports.textInput = textInput
    exports.toggle = toggle
    exports.dot = dot
    exports.chip = chip
    exports.createActions = createActions
    exports.DialogHost = DialogHost
    exports.ToastHost = ToastHost
    exports.SkillsController = SkillsController
    exports.SkillsView = SkillsView
    exports.SkillRow = SkillRow
    exports.CreateForm = CreateForm
    exports.CustomDirsCard = CustomDirsCard
    exports.DetailPanel = DetailPanel
    exports.SidebarEntry = SidebarEntry
    exports.entryWrapWarning = entryWrapWarning
    exports.flyoutAnchor = flyoutAnchor
    exports.SettingsSection = SettingsSection
    return module.exports
  },
})
