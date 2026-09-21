// dsh-mcp-manager — stdio 服务器配置的容错与前置检查。
//
// 背景（真实故障）：用户在「命令（command）」栏粘了整条命令行——
//   command: E:\...\.venv\Scripts\python E:\...\server.py
//   args:    ["--transport stdio", "--port 9876"]
// 于是 spawn 的 executable 变成「带空格的一整串」→ Windows 上 ENOENT；即便
// 只把 command 修对，args 里每个元素仍各含两个 token → argparse 直接
// `unrecognized arguments` 退出。两种情况在 mcp-client 侧都只表现为
// `McpError: MCP error -32000: Connection closed`，用户完全看不出原因。
//
// 「把整条命令行粘进来」是这类表单最常见的误用（MCP 生态里到处是
// `npx -y @scope/pkg` 这种一行配置），所以这里做两件事：
//
//   1. normalizeStdioServer：把「粘进来的命令行」还原成 command + args[]。
//      - command：先按引号规则分词；只有当它**整体不是已存在的路径**、
//        且第一个 token **确实是可执行文件**（含 PATHEXT / PATH 查找）时
//        才拆分。这样 `C:\Program Files\nodejs\node.exe`（真实存在的带空格
//        路径）不会被误拆，而 `npx -y pkg` / `...\python script.py` 会被还原。
//      - args：每个元素整体不是已存在路径时按引号规则拆开；含空格的单个
//        参数请用双引号括起来（`"a b"` → 一个参数）。
//      - 分词**不解释反斜杠转义**（Windows 路径里全是反斜杠），只认引号。
//   2. preflightStdioServer：挂载前检查可执行文件/脚本/工作目录是否存在，
//      把「-32000 Connection closed」换成能直接照着改的一句话。

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Windows 上 CreateProcess 会补的扩展名（不补的话 `...\Scripts\python` 会误判为不存在）。 */
const WINDOWS_EXEC_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com']

/** 像脚本文件的参数（用于前置检查里判断「这个参数指向的文件在不在」）。 */
const SCRIPT_FILE_PATTERN = /\.(py|pyw|js|mjs|cjs|ts|rb|jar|ps1|sh)$/i

/**
 * 按 shell 的引号规则把一个字符串切成 token。
 * 支持 `"..."` 与 `'...'` 分组（引号本身去掉）；**反斜杠是普通字符**，
 * 因为 Windows 路径里到处是反斜杠。空 token 会被丢弃。
 * @param {string} text
 * @returns {string[]}
 */
export function splitCommandLine(text) {
  const out = []
  let current = ''
  let started = false
  let quote = null
  for (const ch of String(text === undefined || text === null ? '' : text)) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      if (started) {
        out.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) out.push(current)
  return out
}

/**
 * 默认探测实现（真实文件系统 + PATH/PATHEXT）。测试可注入替身。
 *
 * `isExecutable` 是**启发式**：它只用来判断「第一个 token 像不像可执行文件，
 * 从而决定要不要把 command 拆成 exe + 参数」。所以存在的非目录文件一律算候选
 * （Windows 还会补 .exe/.cmd/.bat/.com），宁可宽松——多拆一个真实存在的路径
 * 无害，漏拆则退化成 spawn ENOENT（正是这次故障的形态）。
 * @returns {{isExistingPath: (token: string) => boolean, isExecutable: (token: string) => boolean}}
 */
export function createFsProbe() {
  const exists = (candidate) => {
    try {
      return candidate !== '' && existsSync(candidate)
    } catch {
      return false
    }
  }
  const isDirectory = (candidate) => {
    try {
      return statSync(candidate).isDirectory()
    } catch {
      return false
    }
  }
  // Windows 的 CreateProcess 会自动补 .exe/.cmd/.bat/.com——所以
  // `...\.venv\Scripts\python`（真实文件是 python.exe）也要判为可执行，
  // 否则会漏掉「venv 里的 python 不带扩展名」这种最常见的写法。
  const candidatesFor = (name) =>
    process.platform === 'win32' ? [name, ...WINDOWS_EXEC_EXTENSIONS.map((ext) => name + ext)] : [name]
  return {
    isExistingPath: (token) => exists(token),
    isExecutable: (token) => {
      const name = String(token || '')
      if (name === '') return false
      // 直接路径（绝对路径或含分隔符）：按原样与补扩展名各试一次
      for (const candidate of candidatesFor(name)) {
        if (exists(candidate)) return !isDirectory(candidate)
      }
      if (name.includes('/') || name.includes('\\')) return false
      // 裸名字：按 PATH（Windows 同样补扩展名）查找，覆盖 npx / python / uvx 等
      const pathValue = process.env.PATH || process.env.Path || ''
      const separator = pathValue.includes(';') ? ';' : ':'
      for (const dir of pathValue.split(separator).filter(Boolean)) {
        for (const candidate of candidatesFor(name)) {
          const full = join(dir, candidate)
          if (exists(full) && !isDirectory(full)) return true
        }
      }
      return false
    },
  }
}

/**
 * 把一台 stdio 服务器配置归一化：command 里混进来的参数、args 里混进来的
 * 多个 token 都会被拆开。
 * @param {object} server settings 里的服务器对象
 * @param {{isExistingPath: Function, isExecutable: Function}} [probe]
 * @returns {{server: object, changes: string[]}} 未做改动时 server 原样返回（同一引用）
 */
export function normalizeStdioServer(server, probe) {
  if (!server || typeof server !== 'object' || server.transport !== 'stdio') {
    return { server, changes: [] }
  }
  const p = probe || createFsProbe()
  const rawCommand = typeof server.command === 'string' ? server.command.trim() : ''
  const rawArgs = Array.isArray(server.args) ? server.args : []
  const changes = []
  let command = rawCommand
  let args = rawArgs.slice()

  const commandTokens = splitCommandLine(rawCommand)
  if (commandTokens.length > 1 && !p.isExistingPath(rawCommand) && p.isExecutable(commandTokens[0])) {
    command = commandTokens[0]
    args = commandTokens.slice(1).concat(args)
    changes.push(
      `command 里含多个 token，已拆成可执行文件 ${JSON.stringify(commandTokens[0])} + ${commandTokens.length - 1} 个参数`,
    )
  } else if (commandTokens.length === 1 && commandTokens[0] !== rawCommand) {
    // 引号是「这一整串是一个整体」的显式声明（带空格的路径靠它保护），
    // 去引号后原样保留；否则 spawn 会去找一个名字里带引号的文件。
    command = commandTokens[0]
    changes.push(`command 的引号已去掉：${JSON.stringify(command)}`)
  }

  const nextArgs = []
  for (const entry of args) {
    const text = typeof entry === 'string' ? entry : String(entry === undefined || entry === null ? '' : entry)
    const tokens = splitCommandLine(text)
    if (tokens.length > 1 && !p.isExistingPath(text.trim())) {
      nextArgs.push(...tokens)
      changes.push(`参数里含多个 token，已拆分：${JSON.stringify(text)} → ${JSON.stringify(tokens)}`)
      continue
    }
    // 引号包裹的单个 token（含空格的路径/参数）去引号后原样保留
    nextArgs.push(tokens.length === 1 ? tokens[0] : text)
  }

  if (changes.length === 0) return { server, changes }
  return { server: { ...server, command, args: nextArgs }, changes }
}

/**
 * 挂载 stdio 服务器前的前置检查：把「连不上」换成能直接照着改的话。
 * 只覆盖能静态判断、且几乎必然导致启动失败的情况，宁缺勿滥。
 * @param {object} server 已归一化的服务器对象
 * @param {{isExistingPath: Function, isExecutable: Function}} [probe]
 * @returns {string|null} 问题描述；没发现问题时 null
 */
export function preflightStdioServer(server, probe) {
  if (!server || typeof server !== 'object' || server.transport !== 'stdio') return null
  const p = probe || createFsProbe()
  const problems = []

  const command = typeof server.command === 'string' ? server.command.trim() : ''
  if (command === '') {
    problems.push('未填写 command')
  } else if (splitCommandLine(command).length <= 1 && !p.isExecutable(command)) {
    // 仍含空格且没被归一化（说明第一个 token 不是可执行文件）时，也在这里点出来
    problems.push(`找不到可执行文件：${command}（路径是否正确？或它在 PATH 里吗？）`)
  } else if (splitCommandLine(command).length > 1) {
    problems.push(
      `command 里似乎写了多个 token：${JSON.stringify(command)}——参数请填到「参数」栏（或给带空格的路径加双引号）`,
    )
  }

  for (const arg of Array.isArray(server.args) ? server.args : []) {
    const text = String(arg === undefined || arg === null ? '' : arg)
    const trimmed = text.trim()
    if (!SCRIPT_FILE_PATTERN.test(trimmed)) continue
    if (isAbsolute(trimmed) && !p.isExistingPath(trimmed)) problems.push(`脚本文件不存在：${trimmed}`)
  }

  if (typeof server.cwd === 'string' && server.cwd.trim() !== '' && !p.isExistingPath(server.cwd.trim())) {
    problems.push(`工作目录不存在：${server.cwd.trim()}`)
  }

  return problems.length === 0 ? null : problems.join('；')
}
