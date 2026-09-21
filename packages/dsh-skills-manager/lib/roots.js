// dsh-skills-manager — 技能根目录解析与发现层。
//
// 这一层刻意与官方 provider（@deepseek-ai/dsh-skill-filesystem）的发现规则保持
// 一致，否则管理器给出的「技能在哪」会和 DSH 实际加载的东西对不上：
//
//   rank 100  project-dsh      <projectRoot>/.dsh/skills
//   rank 200  project-agents   <projectRoot>/.agents/skills
//   rank 300  custom           Config.customSkillDirs（本插件里 = 设置里的额外技能目录）
//   rank 400  user-dsh         <dshHome>/skills          （跳过它的 .system 子目录）
//   rank 500  user-agents      <agentsHome>/skills
//   rank 600  bundled          Config.bundledSkillDir
//
// 项目根 = 最近的含 `.git` 的祖先目录；找不到就退回传入的 cwd。
//
// 条目形态只有两种（**只认一层，不递归**）：
//   <root>/<name>/SKILL.md   → kind='bundle'
//   <root>/<name>.md         → kind='flat'
//
// 本文件只做「发现 + 读取文本」，不做任何校验；校验在 lib/logic.js。

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'

/** 官方默认根目录与 rank 表。 */
export const ROOT_DEFINITIONS = [
  { source: 'project-dsh', rank: 100, scope: 'project' },
  { source: 'project-agents', rank: 200, scope: 'project' },
  { source: 'custom', rank: 300, scope: 'custom' },
  { source: 'user-dsh', rank: 400, scope: 'user' },
  { source: 'user-agents', rank: 500, scope: 'user' },
  { source: 'bundled', rank: 600, scope: 'bundled' },
]

const USER_DSH_RANK = ROOT_DEFINITIONS.find((entry) => entry.source === 'user-dsh').rank

/** 技能文件名的两种形态。 */
export const SKILL_FILE_NAME = 'SKILL.md'

/**
 * 递归扫描的最大向下层数。
 *
 * 3 层是为了覆盖真实的社区技能库布局：`<集合>/skills/<技能>/SKILL.md`
 * （例如 `hack-skills/skills/clickjacking/SKILL.md`）。再深就该由用户把更具体的
 * 目录加成自己的根，而不是让管理器遍历一整棵项目树。
 */
export const DEEP_SCAN_MAX_DEPTH = 3

/**
 * 把路径统一成正斜杠形式，便于比较与展示（Windows 上尤其重要）。
 * @param {string} value 任意路径
 * @returns {string} 正斜杠路径
 */
export function toPosixPath(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/**
 * 解析 DSH 配置根目录：优先显式传入，其次 $DSH_HOME，最后 ~/.dsh。
 * @param {{dshHome?: string, env?: Record<string, string | undefined>, home?: string}} options 环境
 * @returns {string} 绝对路径
 */
export function resolveDshHome(options = {}) {
  if (typeof options.dshHome === 'string' && options.dshHome.trim() !== '') return resolvePath(options.dshHome)
  const env = options.env ?? process.env
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolvePath(fromEnv)
  return join(options.home ?? homedir(), '.dsh')
}

/**
 * 解析共享 agent 配置根目录：优先显式传入，其次 $DSH_AGENTS_HOME，最后 ~/.agents。
 * @param {{agentsHome?: string, env?: Record<string, string | undefined>, home?: string}} options 环境
 * @returns {string} 绝对路径
 */
export function resolveAgentsHome(options = {}) {
  if (typeof options.agentsHome === 'string' && options.agentsHome.trim() !== '') return resolvePath(options.agentsHome)
  const env = options.env ?? process.env
  const fromEnv = env.DSH_AGENTS_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolvePath(fromEnv)
  return join(options.home ?? homedir(), '.agents')
}

/**
 * 找出项目根：从 cwd 起向上找最近的含 `.git` 的目录（与官方 provider 同规则）。
 * @param {string} cwd 起始目录
 * @param {{statImpl?: Function, maxDepth?: number}} options 注入点（测试用）
 * @returns {Promise<string>} 项目根绝对路径；没有 `.git` 祖先时返回 cwd
 */
export async function findProjectRoot(cwd, options = {}) {
  const start = resolvePath(cwd ?? process.cwd())
  const statImpl = options.statImpl ?? stat
  const maxDepth = options.maxDepth ?? 64
  let current = start
  for (let depth = 0; depth < maxDepth; depth += 1) {
    try {
      const info = await statImpl(join(current, '.git'))
      if (info !== undefined && info !== null) return current
    } catch {
      // 不存在就继续往上。
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return start
}

/**
 * 解析出所有候选根目录（含 rank/source/是否带 skipSystem 标记）。
 * bundled 只有配置了 bundledSkillDir 才出现；custom 来自设置里的额外目录。
 * @param {{cwd?: string, projectRoot?: string | null, customSkillDirs?: string[], bundledSkillDir?: string, dshHome?: string, agentsHome?: string, env?: Record<string, string | undefined>, home?: string}} options 上下文
 * @returns {Array<{source: string, rank: number, scope: string, path: string, skipSystem: boolean, writable: boolean}>} 根目录列表（已按 rank 排序）
 */
export function resolveRoots(options = {}) {
  const cwd = resolvePath(options.cwd ?? process.cwd())
  const projectRoot =
    options.projectRoot === undefined || options.projectRoot === null ? null : resolvePath(options.projectRoot)
  const dshHome = resolveDshHome(options)
  const agentsHome = resolveAgentsHome(options)
  const roots = []
  const push = (source, rank, scope, path, skipSystem = false, deep = false) => {
    const definition = ROOT_DEFINITIONS.find((entry) => entry.source === source)
    roots.push({
      source,
      rank,
      scope,
      path: resolvePath(path),
      skipSystem,
      // deep=true 的根会递归查找任意层级的 SKILL.md（见 scanRoot）。
      deep,
      // 只有项目内与用户根是我们愿意写的；bundled 属于安装产物，只读。
      writable: scope !== 'bundled',
      label: definition?.label ?? source,
    })
  }
  if (projectRoot !== null) {
    push('project-dsh', 100, 'project', join(projectRoot, '.dsh', 'skills'))
    push('project-agents', 200, 'project', join(projectRoot, '.agents', 'skills'))
  }
  // 一个目录只会出现在一个列表里：递归列表优先，浅层列表跳过它，
  // 否则同一个根会被扫两遍、技能重复出现。
  const deepDirs = (Array.isArray(options.deepSkillDirs) ? options.deepSkillDirs : []).filter(
    (dir) => typeof dir === 'string' && dir.trim() !== '',
  )
  const deepKeys = new Set(deepDirs.map((dir) => toPosixPath(resolvePath(dir)).toLowerCase()))
  for (const dir of Array.isArray(options.customSkillDirs) ? options.customSkillDirs : []) {
    if (typeof dir !== 'string' || dir.trim() === '') continue
    if (deepKeys.has(toPosixPath(resolvePath(dir)).toLowerCase())) continue
    push('custom', 300, 'custom', dir)
  }
  for (const dir of deepDirs) {
    push('custom', 300, 'custom', dir, false, true)
  }
  push('user-dsh', USER_DSH_RANK, 'user', join(dshHome, 'skills'), true)
  push('user-agents', 500, 'user', join(agentsHome, 'skills'))
  if (typeof options.bundledSkillDir === 'string' && options.bundledSkillDir.trim() !== '') {
    push('bundled', 600, 'bundled', options.bundledSkillDir)
  }
  return roots
}

/**
 * 列出一个目录的直接子项（不存在/无权限时返回空数组，而不是抛错）。
 * @param {string} path 目录
 * @returns {Promise<Array<{name: string, isDirectory: boolean, isFile: boolean}>>} 子项
 */
async function listDirectory(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }))
  } catch {
    return []
  }
}

/**
 * 判断一个路径是否指向存在的文件/目录。
 * @param {string} path 路径
 * @returns {Promise<boolean>} 是否存在
 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 扫描一个根目录，产出该根下的技能文件位置（不读内容）。
 *
 * 默认与官方 provider 一致：**只看一层**（`<root>/<name>/SKILL.md` 与
 * `<root>/<name>.md`）。`root.deep === true` 时改为递归查找任意层级的
 * `SKILL.md`，用于仓库式技能库（`<集合>/skills/<技能>/SKILL.md`）。
 *
 * 递归时的三条护栏：
 *   1. 最多向下 {@link DEEP_SCAN_MAX_DEPTH} 层，避免遍历整棵项目树；
 *   2. 跳过点开头目录与 node_modules；
 *   3. 遇到本身已含 SKILL.md 的目录就**停止下探**——它里面的嵌套 SKILL.md
 *      属于该技能的资源（如 `code-audit/references/`），不是独立技能。
 *
 * @param {{path: string, source: string, rank: number, skipSystem?: boolean, deep?: boolean}} root 根目录
 * @returns {Promise<Array<{name: string, kind: 'bundle'|'flat', path: string, dir: string, source: string, rank: number}>>} 位置列表
 */
export async function scanRoot(root) {
  const found = []
  // 去重键：递归扫描会从根目录再走一遍，浅层循环已经记过的技能必须在这里挡掉，
  // 否则同一个技能会出现两份（曾把 5 个顶层技能各扫出两遍）。
  const seen = new Set()
  const record = (name, kind, path, dir) => {
    const key = toPosixPath(resolvePath(path)).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push({ name, kind, path, dir, source: root.source, rank: root.rank })
  }

  for (const entry of await listDirectory(root.path)) {
    if (entry.name.startsWith('.')) {
      // 官方跳过 .system；其余点开头目录（.git 等）同样不可能是技能。
      continue
    }
    if (entry.isFile && entry.name.endsWith('.md')) {
      // 单文件技能只在这一层成立；递归扫描时子目录里的散装 md 一律当资源看。
      record(entry.name.slice(0, -3), 'flat', join(root.path, entry.name), root.path)
      continue
    }
    if (!entry.isDirectory) continue
    const skillFile = join(root.path, entry.name, SKILL_FILE_NAME)
    if (await exists(skillFile)) {
      record(entry.name, 'bundle', skillFile, join(root.path, entry.name))
    }
  }

  if (root.deep === true) {
    await deepScan(root, root.path, 1, found, seen)
  }

  // 同一根内按名字排序，保证展示顺序稳定。
  found.sort((left, right) => left.name.localeCompare(right.name))
  return found
}

/**
 * 递归查找 `SKILL.md`。只在 `root.deep` 时启用。
 * @param {object} root 根定义（含 source/rank）
 * @param {string} dirPath 当前目录
 * @param {number} depth 当前深度（根的直接子项算 1）
 * @param {Array<object>} found 收集数组（原地追加）
 * @returns {Promise<void>} 完成后 resolve
 */
async function deepScan(root, dirPath, depth, found, seen) {
  if (depth > DEEP_SCAN_MAX_DEPTH) return
  for (const entry of await listDirectory(dirPath)) {
    if (!entry.isDirectory) continue
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const child = join(dirPath, entry.name)
    const skillFile = join(child, SKILL_FILE_NAME)
    if (await exists(skillFile)) {
      // 命中一个技能之后不再往下：它内部的嵌套 SKILL.md 是资源而不是技能。
      const key = toPosixPath(resolvePath(skillFile)).toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        found.push({
          name: entry.name,
          kind: 'bundle',
          path: skillFile,
          dir: child,
          source: root.source,
          rank: root.rank,
        })
      }
      continue
    }
    await deepScan(root, child, depth + 1, found, seen)
  }
}

/**
 * 读取一个技能文件的文本；超过上限或读不到时返回 null 并带上原因。
 * @param {string} path 文件路径
 * @param {number} maxBytes 上限
 * @returns {Promise<{text: string} | {error: string}>} 读取结果
 */
export async function readSkillFileText(path, maxBytes) {
  try {
    const info = await stat(path)
    if (info.size > maxBytes) {
      return { error: `文件过大（${info.size} 字节，上限 ${maxBytes}）` }
    }
    return { text: await readFile(path, 'utf8') }
  } catch (error) {
    return { error: `读取失败：${String(error?.message ?? error)}` }
  }
}

/**
 * 汇总所有根目录下的技能位置，并标注重复（同名多副本）。
 * @param {Array<object>} roots 根目录列表
 * @returns {Promise<{entries: Array<object>, roots: Array<object>}>} 位置与根状态
 */
export async function discoverSkillFiles(roots) {
  const entries = []
  const rootStatus = []
  let order = 0
  for (const root of roots) {
    const present = await exists(root.path)
    const scanned = present ? await scanRoot(root) : []
    rootStatus.push({
      source: root.source,
      rank: root.rank,
      scope: root.scope,
      path: toPosixPath(root.path),
      exists: present,
      writable: root.writable,
      // deep 必须带出去：面板要显示「一层 / 递归」，否则用户看不出这个根是怎么扫的。
      deep: root.deep === true,
      skillCount: scanned.length,
    })
    for (const entry of scanned) {
      entries.push({ ...entry, order, path: resolvePath(entry.path), posixPath: toPosixPath(entry.path) })
      order += 1
    }
  }
  return { entries, roots: rootStatus }
}
