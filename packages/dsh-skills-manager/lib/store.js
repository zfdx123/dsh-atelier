// dsh-skills-manager — 受护栏保护的读写层。
//
// 这是整个插件唯一会写磁盘的地方。所有写操作都必须先过 assertSkillPath：
//   - 目标必须落在本次解析出的、标记为 writable 的根目录**之内**；
//   - 路径段里不允许出现 `..`；点开头目录一律拒绝（.git / .system /
//     node_modules 这类不该被管理器碰的东西）；
//   - 根目录本身不做符号链接穿透：链接出去的技能目录不写。
//
// 写策略：
//   - 只改正文 → 用 composeSkillText 拼接，frontmatter 块逐字节保留；
//   - 改字段   → patchFrontmatterLines 做行级手术，注释/键顺序/未知结构都活着；
//   - 新建     → 稳定的序列化顺序（name/description/…）。
//   - 落盘     → 先写同目录下的临时文件再 rename，避免半截文件被 provider 读到。
//   - 删除     → 移到 <root>/.trash/<时间戳>-<名字>，可恢复；点开头目录本来
//                就会被 provider 跳过，所以回收站不会被当成技能扫出来。

import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import {
  buildSkillFile,
  composeSkillText,
  isSkillName,
  lintSkillFile,
  markShadowed,
  MAX_SKILL_FILE_BYTES,
  parseFrontmatter,
  patchFrontmatterLines,
  splitSkillText,
  summarize,
  validateSkillInput,
} from './logic.js'
import { discoverSkillFiles, readSkillFileText, resolveRoots, SKILL_FILE_NAME, toPosixPath } from './roots.js'

/** 回收站目录名（点开头 → provider 天然跳过）。 */
export const TRASH_DIR_NAME = '.trash'

/**
 * 构建管理器的一次请求上下文：解析出根目录并扫描磁盘上的技能文件。
 *
 * 注意：**不读注册表**。注册表回答的是「DSH 当前认哪些技能」，而磁盘扫描回答
 * 「文件在哪、写坏了没有」——后者才是管理器的正确数据源，因为官方 provider
 * 会把写坏的文件静默跳过，注册表里根本看不到它们。注册表只用来做交叉核对。
 *
 * @param {{cwd?: string, customSkillDirs?: string[], deepSkillDirs?: string[], bundledSkillDir?: string, projects?: string[]}} config 插件设置
 * @returns {Promise<{roots: Array<object>, entries: Array<object>, projectRoots: string[]}>} 上下文
 */
export async function buildContext(config = {}) {
  const cwd = config.cwd ?? process.cwd()
  const projectRoots = []
  const seen = new Set()
  for (const candidate of [cwd, ...(Array.isArray(config.projects) ? config.projects : [])]) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    const resolved = resolvePath(candidate)
    const key = toPosixPath(resolved).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    projectRoots.push(resolved)
  }
  const roots = []
  const rootSeen = new Set()
  for (const projectRoot of projectRoots) {
    for (const root of resolveRoots({
      cwd: projectRoot,
      projectRoot,
      customSkillDirs: config.customSkillDirs,
      deepSkillDirs: config.deepSkillDirs,
      bundledSkillDir: config.bundledSkillDir,
    })) {
      const key = `${toPosixPath(root.path).toLowerCase()}|${root.source}`
      if (rootSeen.has(key)) continue
      rootSeen.add(key)
      roots.push(root)
    }
  }
  const discovered = await discoverSkillFiles(roots)
  return {
    roots: discovered.roots,
    entries: discovered.entries.map((entry) => ({
      ...entry,
      projectRoot: projectRoots.find((candidate) => isInside(candidate, entry.path)) ?? null,
    })),
    projectRoots,
  }
}

/** Windows 上路径比较不区分大小写；其它平台区分。 */
const CASE_INSENSITIVE = process.platform === 'win32'

/**
 * 判断 child 是否在 parent **之内**。这是所有写护栏的地基，所以按最严格的
 * 语义实现：只有 child 严格更深、且相对路径不以 `..` 开头时才算在内。
 *
 * 注意两个平台陷阱，两个都会把「不在里面」误判成「在里面」：
 *   1. Windows 上 parent 与 child 位于**不同盘符**时，`path.relative()` 返回的是
 *      child 的绝对路径（`C:\Windows\...`），它并不以 `..` 开头——只看前缀会
 *      把整块盘判成「在根目录内」。所以必须显式排除 `isAbsolute(rel)`。
 *   2. Windows 路径大小写不敏感，`c:` 与 `C:` 是同一个盘；用原始字符串比较会
 *      把同一个目录判成两个，从而漏放行或误拒绝。
 *
 * @param {string} parent 父路径
 * @param {string} child 子路径
 * @returns {boolean} 是否在父路径之内
 */
export function isInside(parent, child) {
  if (typeof parent !== 'string' || parent.trim() === '') return false
  if (typeof child !== 'string' || child.trim() === '') return false
  const base = resolvePath(parent)
  const target = resolvePath(child)
  const normalize = (value) => (CASE_INSENSITIVE ? value.toLowerCase() : value)
  // 同一个路径不算「在里面」（技能文件本身不是它的根目录）。
  if (normalize(base) === normalize(target)) return false
  const rel = relative(base, target)
  // 跨盘符：relative 返回绝对路径 → 一定不在里面。
  if (rel === '' || isAbsolute(rel)) return false
  // `..` 开头（含单独的 `..`）→ 在外面。
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * 核心护栏：确认某条技能路径确实落在某个技能根目录**之内**。
 *
 * `requireWritable` 默认 true（写操作）；读操作传 false——安装目录里的
 * bundled 技能是只读的，但必须看得见、读得到。
 * @param {Array<object>} roots 根目录列表（来自 buildContext）
 * @param {string} path 目标路径（技能文件或技能目录）
 * @param {{requireWritable?: boolean}} options 选项
 * @returns {{root: object, filePath: string, dir: string}} 归属信息
 * @throws {Error} 越界或路径非法时抛出
 */
export function assertSkillPath(roots, path, options = {}) {
  const requireWritable = options.requireWritable !== false
  const target = resolvePath(path)
  const segments = toPosixPath(target).split('/')
  if (segments.includes('..')) throw new Error('拒绝写入：路径里出现 ".."')
  const owner = roots.find((root) => (requireWritable ? root.writable : true) && isInside(root.path, target))
  if (owner === undefined) {
    throw new Error(requireWritable ? '拒绝写入：目标不在任何可写技能根目录内' : '目标不在任何技能根目录内')
  }
  if (requireWritable && !owner.writable) {
    throw new Error(`拒绝写入：${owner.source} 根目录是只读的（安装产物）`)
  }
  // 点开头的中间目录一律拒绝（.git / .system / 回收站内的进一步嵌套等）。
  const relativeSegments = toPosixPath(relative(owner.path, target)).split('/')
  for (const segment of relativeSegments) {
    if (segment === '') continue
    if (segment.startsWith('.')) {
      throw new Error(`拒绝写入：路径段 "${segment}" 以点开头`)
    }
  }
  const lowerBase = basename(target).toLowerCase()
  if (lowerBase === 'node_modules' || lowerBase === 'package.json') {
    throw new Error('拒绝写入：保留文件名')
  }
  return {
    root: owner,
    filePath: target,
    dir: lowerBase.toLowerCase() === SKILL_FILE_NAME.toLowerCase() ? dirname(target) : target,
  }
}

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖。
 * @param {string} filePath 目标文件
 * @param {string} text 内容
 * @returns {Promise<void>} 完成后 resolve
 */
async function atomicWrite(filePath, text) {
  await mkdir(dirname(filePath), { recursive: true })
  const temp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  await writeFile(temp, text, 'utf8')
  try {
    await rename(temp, filePath)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * 移动文件或目录。
 *
 * 优先 `rename`（同卷原子操作）。Windows 上目录 rename 会偶发 EPERM（杀软/索引器
 * 短暂持有句柄），跨卷则是 EXDEV；这两种情况退回 `cp` + `rm`，语义等价，只是
 * 多一次拷贝。回收站与改名都走这里，所以用户不会看到「重命名偶尔失败」。
 * @param {string} source 源路径
 * @param {string} destination 目标路径
 * @returns {Promise<void>} 完成后 resolve
 */
async function movePath(source, destination) {
  // rename 在 Windows 上覆盖已存在的目录会直接 EPERM/ENOTEMPTY；先把残留清掉，
  // 让两种路径的语义一致（调用方都已确认目标不存在，这里只是清理失败残留）。
  if (existsSync(destination)) await rm(destination, { recursive: true, force: true })
  try {
    await rename(source, destination)
    return
  } catch (error) {
    const code = error?.code
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EXDEV' && code !== 'EBUSY') throw error
  }
  try {
    await cp(source, destination, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  } catch (error) {
    // 拷贝失败就把目的地清干净，别留下半个技能——下次重试还会撞上它。
    await rm(destination, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * 把一次磁盘发现的结果汇总成完整的技能条目（读文件 + lint + 遮蔽标注）。
 * @param {{entries: Array<object>, roots: Array<object>}} context buildContext 的结果
 * @returns {Promise<{skills: Array<object>, summary: object}>} 技能条目与统计
 */ export async function listSkills(context) {
  const scopeOf = (source) => context.roots.find((root) => root.source === source)?.scope ?? null
  const skills = []
  for (const entry of context.entries) {
    const read = await readSkillFileText(entry.path, MAX_SKILL_FILE_BYTES)
    if (read.error !== undefined) {
      skills.push({
        name: entry.name,
        kind: entry.kind,
        source: entry.source,
        rank: entry.rank,
        scope: scopeOf(entry.source),
        order: entry.order,
        path: entry.posixPath,
        dir: toPosixPath(entry.dir),
        projectRoot: entry.projectRoot === null ? null : toPosixPath(entry.projectRoot),
        status: 'broken',
        description: '',
        whenToUse: null,
        invocation: { modelInvocable: true, userInvocable: true },
        issues: [{ level: 'error', key: '', message: read.error }],
        bytes: 0,
      })
      continue
    }
    const diagnosed = lintSkillFile({ text: read.text, name: entry.name, kind: entry.kind })
    const declaredName = typeof diagnosed.fields.name === 'string' ? diagnosed.fields.name : null
    const issues = [...diagnosed.issues]
    if (declaredName !== null && declaredName !== entry.name) {
      issues.push({
        level: 'warn',
        key: 'name',
        message:
          `frontmatter 里的 name 是 "${declaredName}"，但文件/目录名是 "${entry.name}"：` +
          'DSH 用 frontmatter 的名字注册，两者不一致时按前者生效（改名请用「重命名」而不要只手改 name）',
      })
    }
    skills.push({
      name: declaredName ?? entry.name,
      fileName: entry.name,
      kind: entry.kind,
      source: entry.source,
      rank: entry.rank,
      scope: scopeOf(entry.source),
      order: entry.order,
      path: entry.posixPath,
      dir: toPosixPath(entry.dir),
      projectRoot: entry.projectRoot === null ? null : toPosixPath(entry.projectRoot),
      status: issues.some((issue) => issue.level === 'error')
        ? 'broken'
        : issues.some((issue) => issue.level === 'warn')
          ? 'warning'
          : 'ok',
      description: diagnosed.description,
      whenToUse: diagnosed.whenToUse,
      invocation: diagnosed.invocation,
      issues,
      bytes: Buffer.byteLength(read.text, 'utf8'),
    })
  }
  const marked = markShadowed(skills)
  return { skills: marked, summary: summarize(marked) }
}

/** 找到某条技能在上下文里的位置条目。 */
function findEntry(context, path) {
  const target = toPosixPath(resolvePath(path)).toLowerCase()
  return context.entries.find((entry) => toPosixPath(entry.path).toLowerCase() === target) ?? null
}

/**
 * 读取一条技能的完整内容与诊断（编辑器用）。
 * @param {object} context buildContext 的结果
 * @param {string} path 技能文件绝对路径
 * @returns {Promise<object>} 详情
 * @throws {Error} 找不到时报错
 */
export async function readSkill(context, path) {
  const asserted = assertSkillPath(context.roots, path, { requireWritable: false })
  const entry = findEntry(context, asserted.filePath)
  const read = await readSkillFileText(asserted.filePath, MAX_SKILL_FILE_BYTES)
  if (read.error !== undefined) throw new Error(read.error)
  const diagnosed = lintSkillFile({ text: read.text })
  const parts = splitSkillText(read.text)
  return {
    path: toPosixPath(asserted.filePath),
    dir: toPosixPath(asserted.dir),
    kind:
      entry?.kind ?? (basename(asserted.filePath).toLowerCase() === SKILL_FILE_NAME.toLowerCase() ? 'bundle' : 'flat'),
    source: entry?.source ?? asserted.root.source,
    rank: entry?.rank ?? asserted.root.rank,
    name: typeof diagnosed.fields.name === 'string' ? diagnosed.fields.name : null,
    fileName: entry?.name ?? basename(asserted.dir),
    status: diagnosed.status,
    fields: diagnosed.fields,
    rawKeys: diagnosed.rawKeys,
    issues: diagnosed.issues,
    invocation: diagnosed.invocation,
    description: diagnosed.description,
    whenToUse: diagnosed.whenToUse,
    frontmatter: parts.frontmatter,
    body: parts.body,
    text: read.text,
    bytes: Buffer.byteLength(read.text, 'utf8'),
  }
}

/**
 * 新建一个技能。
 * @param {object} context buildContext 的结果
 * @param {{name: string, description: string, whenToUse?: string, modelInvocable?: boolean, userInvocable?: boolean, metadata?: object, body?: string, rootPath: string, kind?: 'bundle'|'flat', overwrite?: boolean}} input 新建参数
 * @returns {Promise<object>} {path, dir, kind, created}
 * @throws {Error} 校验失败或目标已存在
 */
export async function createSkill(context, input) {
  const errors = validateSkillInput(input)
  if (errors.length > 0) throw new Error(errors.join('；'))
  if (!isSkillName(input.name)) throw new Error('技能名不合法')
  const owner = context.roots.find(
    (root) =>
      root.writable && toPosixPath(root.path).toLowerCase() === toPosixPath(resolvePath(input.rootPath)).toLowerCase(),
  )
  if (owner === undefined) throw new Error('目标根目录不可写或不存在，请重新加载根目录列表')

  const kind = input.kind === 'flat' ? 'flat' : 'bundle'
  const dir = resolvePath(owner.path)
  const filePath = kind === 'flat' ? join(dir, `${input.name}.md`) : join(dir, input.name, SKILL_FILE_NAME)
  assertSkillPath(context.roots, join(dir, input.name))
  if (existsSync(filePath)) throw new Error(`已存在同名技能，未覆盖：${toPosixPath(filePath)}`)
  const text = buildSkillFile(input)
  await atomicWrite(filePath, text)
  return {
    path: toPosixPath(filePath),
    dir: toPosixPath(kind === 'flat' ? dir : join(dir, input.name)),
    kind,
    created: true,
  }
}

/**
 * 更新一个技能：只改正文时保留 frontmatter 原文；改字段时做行级手术。
 * @param {object} context buildContext 的结果
 * @param {{path: string, fields?: Record<string, unknown>, body?: string, frontmatter?: string, rawWholeText?: boolean, expectedText?: string}} input 更新参数
 * @returns {Promise<{path: string, changed: boolean, skipped: string[]}>} 结果
 * @throws {Error} 校验失败或文件在编辑器外被改过
 */
export async function updateSkill(context, input) {
  const asserted = assertSkillPath(context.roots, input.path)
  const read = await readSkillFileText(asserted.filePath, MAX_SKILL_FILE_BYTES)
  if (read.error !== undefined) throw new Error(read.error)
  if (typeof input.expectedText === 'string' && input.expectedText !== read.text) {
    throw new Error('文件已被其它程序修改（编辑器里的内容是旧的）。已拒绝覆盖，请重新加载后再改。')
  }
  const parts = splitSkillText(read.text)
  let frontmatter = parts.frontmatter
  let skipped = []

  if (typeof input.frontmatter === 'string') {
    frontmatter = input.frontmatter.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  } else if (input.fields !== undefined && input.fields !== null) {
    const parsed = parseFrontmatter(frontmatter)
    const patch = {}
    for (const [key, value] of Object.entries(input.fields)) {
      patch[key] = value === '' ? undefined : value
    }
    const patched = patchFrontmatterLines(frontmatter ?? '', patch, parsed)
    frontmatter = patched.text
    skipped = patched.skipped
  }

  const body = typeof input.body === 'string' ? input.body : parts.body
  const text = composeSkillText(frontmatter, body)

  // 写完必须是「能用的」——校验不通过就不落盘，避免把好文件改坏。
  const diagnosed = lintSkillFile({ text })
  const fatal = diagnosed.issues.filter((issue) => issue.level === 'error' && issue.key !== 'name')
  if (fatal.length > 0) {
    throw new Error(`拒绝写入（会让 DSH 跳过这个技能）：${fatal.map((issue) => issue.message).join('；')}`)
  }
  if (diagnosed.fields.name !== undefined && !isSkillName(diagnosed.fields.name)) {
    throw new Error(`拒绝写入：name "${String(diagnosed.fields.name)}" 不是合法技能名`)
  }
  // 「没有实质变化」= 规范化之后逐字节相同。注意这比 text === read.text 宽松：
  // 磁盘上的写法（例如文件结尾缺一个换行）即使和规范化结果不同，只要内容没变
  // 就不落盘——否则每次打开再保存都会顺手改掉用户文件的尾换行。
  if (text === read.text || text === read.text.replace(/\s+$/, '')) {
    return { path: toPosixPath(asserted.filePath), changed: false, skipped }
  }
  await atomicWrite(asserted.filePath, text)
  return { path: toPosixPath(asserted.filePath), changed: true, skipped }
}

/**
 * 一键切换模型可见 / `/` 命令可见。写的是官方支持的开关字段。
 * @param {object} context buildContext 的结果
 * @param {{path: string, modelInvocable?: boolean, userInvocable?: boolean}} input 开关
 * @returns {Promise<{path: string, changed: boolean}>} 结果
 */
export async function toggleSkill(context, input) {
  const fields = {}
  if (typeof input.modelInvocable === 'boolean') {
    // disable-model-invocation=true 时才需要有这个键；恢复默认就删掉它。
    fields['disable-model-invocation'] = input.modelInvocable ? undefined : true
  }
  if (typeof input.userInvocable === 'boolean') {
    fields['user-invocable'] = input.userInvocable ? undefined : false
  }
  if (Object.keys(fields).length === 0) throw new Error('没有需要改动的开关')
  return await updateSkill(context, { path: input.path, fields })
}

/**
 * 生成一个不会撞车的回收站路径。
 * @param {string} rootPath 根目录
 * @param {string} name 原技能名
 * @returns {Promise<string>} 回收站目标路径
 */
async function trashTarget(rootPath, name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = `${stamp}-${name}`
  const trashRoot = join(rootPath, TRASH_DIR_NAME)
  await mkdir(trashRoot, { recursive: true })
  let candidate = join(trashRoot, base)
  let counter = 1
  while (existsSync(candidate)) {
    candidate = join(trashRoot, `${base}-${counter}`)
    counter += 1
  }
  return candidate
}

/**
 * 删除一个技能（移动到回收站，可恢复）。
 * @param {object} context buildContext 的结果
 * @param {{path: string, kind?: 'bundle'|'flat'}} input 删除目标
 * @returns {Promise<{trashedTo: string, name: string}>} 回收站位置
 */
export async function deleteSkill(context, input) {
  const asserted = assertSkillPath(context.roots, input.path)
  const entry = findEntry(context, asserted.filePath)
  const kind =
    input.kind ??
    entry?.kind ??
    (basename(asserted.filePath).toLowerCase() === SKILL_FILE_NAME.toLowerCase() ? 'bundle' : 'flat')
  const name = entry?.name ?? basename(asserted.dir)
  const source = kind === 'bundle' ? asserted.dir : asserted.filePath
  const target = await trashTarget(asserted.root.path, name)
  await movePath(source, target)
  return { trashedTo: toPosixPath(target), name, kind }
}

/**
 * 列出一个根目录回收站里的条目。
 * @param {object} context buildContext 的结果
 * @param {string} rootPath 根目录
 * @returns {Promise<Array<{name: string, path: string, mtime: string | null}>>} 回收站条目
 */
export async function listTrash(context, rootPath) {
  const owner = context.roots.find(
    (root) =>
      root.writable && toPosixPath(root.path).toLowerCase() === toPosixPath(resolvePath(rootPath)).toLowerCase(),
  )
  if (owner === undefined) throw new Error('该根目录不可写或不存在')
  const trashRoot = join(owner.path, TRASH_DIR_NAME)
  let entries = []
  try {
    entries = await readdir(trashRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const items = []
  for (const entry of entries) {
    const full = join(trashRoot, entry.name)
    let mtime = null
    try {
      const info = await stat(full)
      mtime = info.mtime.toISOString()
    } catch {
      // 拿不到时间就算了。
    }
    items.push({ name: entry.name, path: toPosixPath(full), mtime })
  }
  items.sort((left, right) => String(right.mtime).localeCompare(String(left.mtime)))
  return items
}

/**
 * 把一个技能移动到另一个（可写的）根目录。
 * @param {object} context buildContext 的结果
 * @param {{path: string, kind?: 'bundle'|'flat', targetRoot: string}} input 移动参数
 * @returns {Promise<{path: string, moved: boolean, blocked?: string}>} 结果
 */
export async function moveSkill(context, input) {
  const asserted = assertSkillPath(context.roots, input.path)
  const entry = findEntry(context, asserted.filePath)
  const kind =
    input.kind ??
    entry?.kind ??
    (basename(asserted.filePath).toLowerCase() === SKILL_FILE_NAME.toLowerCase() ? 'bundle' : 'flat')
  const name = entry?.name ?? basename(asserted.dir)
  const targetOwner = context.roots.find(
    (root) =>
      root.writable &&
      toPosixPath(root.path).toLowerCase() === toPosixPath(resolvePath(input.targetRoot)).toLowerCase(),
  )
  if (targetOwner === undefined) throw new Error('目标根目录不可写或不存在')
  if (toPosixPath(targetOwner.path).toLowerCase() === toPosixPath(asserted.root.path).toLowerCase()) {
    throw new Error('源与目标在同一个根目录')
  }
  const source = kind === 'bundle' ? asserted.dir : asserted.filePath
  const destination =
    kind === 'bundle' ? join(targetOwner.path, name, SKILL_FILE_NAME) : join(targetOwner.path, `${name}.md`)
  assertSkillPath(context.roots, kind === 'bundle' ? join(targetOwner.path, name) : destination)
  if (existsSync(destination)) throw new Error(`目标位置已存在同名技能：${toPosixPath(destination)}`)
  await mkdir(dirname(destination), { recursive: true })
  await movePath(source, kind === 'bundle' ? dirname(destination) : destination)
  return { path: toPosixPath(destination), moved: true }
}

/**
 * 复制一个技能到另一个根目录（或复制成新名字）。
 * @param {object} context buildContext 的结果
 * @param {{path: string, kind?: 'bundle'|'flat', targetRoot: string, newName?: string}} input 复制参数
 * @returns {Promise<{path: string, copied: boolean}>} 结果
 */
export async function copySkill(context, input) {
  const asserted = assertSkillPath(context.roots, input.path)
  const entry = findEntry(context, asserted.filePath)
  const kind =
    input.kind ??
    entry?.kind ??
    (basename(asserted.filePath).toLowerCase() === SKILL_FILE_NAME.toLowerCase() ? 'bundle' : 'flat')
  const name = entry?.name ?? basename(asserted.dir)
  const targetOwner = context.roots.find(
    (root) =>
      root.writable &&
      toPosixPath(root.path).toLowerCase() === toPosixPath(resolvePath(input.targetRoot)).toLowerCase(),
  )
  if (targetOwner === undefined) throw new Error('目标根目录不可写或不存在')
  const destinationName = typeof input.newName === 'string' && input.newName.trim() !== '' ? input.newName.trim() : name
  if (!isSkillName(destinationName)) throw new Error('新名字必须是 kebab-case 技能名')
  const destination =
    kind === 'bundle'
      ? join(targetOwner.path, destinationName, SKILL_FILE_NAME)
      : join(targetOwner.path, `${destinationName}.md`)
  assertSkillPath(context.roots, kind === 'bundle' ? join(targetOwner.path, destinationName) : destination)
  if (existsSync(destination)) throw new Error(`目标位置已存在：${toPosixPath(destination)}`)
  const read = await readSkillFileText(asserted.filePath, MAX_SKILL_FILE_BYTES)
  if (read.error !== undefined) throw new Error(read.error)
  let text = read.text
  if (destinationName !== name) {
    // 名字变了就同步 frontmatter 里的 name，否则 DSH 仍按旧名注册。
    const parts = splitSkillText(text)
    const parsed = parseFrontmatter(parts.frontmatter)
    const patched = patchFrontmatterLines(parts.frontmatter ?? '', { name: destinationName }, parsed)
    text = composeSkillText(patched.text, parts.body)
  }
  // 包目录里的附件（references/ scripts/ assets/）一并复制。
  if (kind === 'bundle') {
    await mkdir(dirname(destination), { recursive: true })
    await cp(asserted.dir, dirname(destination), { recursive: true, errorOnExist: false, force: true })
  }
  await atomicWrite(destination, text)
  return { path: toPosixPath(destination), copied: true }
}

/**
 * 把一条技能「改名」：移动文件/目录并把 frontmatter 的 name 同步过去。
 * @param {object} context buildContext 的结果
 * @param {{path: string, kind?: 'bundle'|'flat', newName: string}} input 参数
 * @returns {Promise<{path: string, renamed: boolean}>} 结果
 */
export async function renameSkill(context, input) {
  const asserted = assertSkillPath(context.roots, input.path)
  const entry = findEntry(context, asserted.filePath)
  const kind =
    input.kind ??
    entry?.kind ??
    (basename(asserted.filePath).toLowerCase() === SKILL_FILE_NAME.toLowerCase() ? 'bundle' : 'flat')
  const name = entry?.name ?? basename(asserted.dir)
  if (!isSkillName(input.newName)) throw new Error('新名字必须是 kebab-case 技能名')
  if (input.newName === name) return { path: toPosixPath(asserted.filePath), renamed: false }
  const destination =
    kind === 'bundle'
      ? join(asserted.root.path, input.newName, SKILL_FILE_NAME)
      : join(asserted.root.path, `${input.newName}.md`)
  assertSkillPath(context.roots, kind === 'bundle' ? join(asserted.root.path, input.newName) : destination)
  if (existsSync(destination)) throw new Error(`已存在同名技能：${toPosixPath(destination)}`)
  await mkdir(dirname(destination), { recursive: true })
  await movePath(
    kind === 'bundle' ? asserted.dir : asserted.filePath,
    kind === 'bundle' ? dirname(destination) : destination,
  )
  const read = await readSkillFileText(destination, MAX_SKILL_FILE_BYTES)
  if (read.error === undefined) {
    const parts = splitSkillText(read.text)
    const parsed = parseFrontmatter(parts.frontmatter)
    const patched = patchFrontmatterLines(parts.frontmatter ?? '', { name: input.newName }, parsed)
    const text = composeSkillText(patched.text, parts.body)
    if (text !== read.text) await atomicWrite(destination, text)
  }
  return { path: toPosixPath(destination), renamed: true }
}

/**
 * 交叉核对：磁盘上发现的技能名 vs DSH 注册表（`ctx.skills`）当前认的技能名。
 * 差异说明 provider 还没重新发现（watcher 延迟）或正被别的层遮蔽。
 * @param {Array<{name: string}>} skills 磁盘条目
 * @param {Array<{name: string}>} registrySkills 注册表中的技能
 * @returns {{missingFromRegistry: string[], extraInRegistry: string[], registryError: string | null}} 差异
 */
export function crossCheck(skills, registrySkills) {
  const diskNames = new Set(skills.filter((skill) => skill.status !== 'broken').map((skill) => skill.name))
  const registryNames = new Set(registrySkills.map((skill) => skill.name))
  return {
    missingFromRegistry: [...diskNames].filter((name) => !registryNames.has(name)).sort(),
    extraInRegistry: [...registryNames].filter((name) => !diskNames.has(name)).sort(),
    registryError: null,
  }
}
