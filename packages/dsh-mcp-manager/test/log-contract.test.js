// 日志契约快照测试：mcp-client 的每条 error/warn 日志文案都必须被 lib/logic.js
// 的规则表**翻译**（而不是落到"未识别透传"兜底）。
//
// 为什么需要它：mcpClientLogToStatus 的规则以**上游英文文案**为键，而文案属于
// 上游"给人看的散文"、随版本演进。0.1.6-alpha.1 就把
//   failed generation did not close within <ms>ms — reconnect stopped …
// 改写成了
//   failed generation could not confirm transport closure — reconnect stopped …
// 规则没跟上 → 状态不再更新 → 设置页在服务器已停止重连时仍显示「已挂载」。
// 本测试从**实际安装的** mcp-client 源码里抽出全部日志文案逐个过一遍状态翻译，
// 上游一改词就变红（而不是等用户发现状态不对）。
//
// 默认取本包解析到的副本；宿主实际加载的副本可以用环境变量指定：
//   DSH_MCP_CLIENT_SRC="C:/Users/<you>/.dsh/profiles/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js" node --test
// 打印逐条结果：
//   MCP_LOG_CONTRACT_PRINT=1 node test/log-contract.test.js

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MCP_UNRECOGNIZED_PREFIX, mcpClientLogToStatus } from '../lib/logic.js'

const LEVEL_NUMBERS = { error: 0, info: 1, warn: 2, debug: 3 }

/** 解析 mcp-client 的入口文件：env 覆盖优先，否则用本包解析到的那份。 */
function resolveMcpClientSource() {
  if (process.env.DSH_MCP_CLIENT_SRC) return process.env.DSH_MCP_CLIENT_SRC
  return createRequire(import.meta.url).resolve('@deepseek-ai/dsh-mcp-client')
}

/**
 * 从源码里抽出 `ctx.logger.<级别>(`...`)` 的文案，并做三件事：
 *   1. 去掉开头的 `${label}: ` / `${opts.serverName}: ` 这类标签插值——真实
 *      运行时标签本身就长成 `mcp-client(<名>)`，留着会让文案与规则对不上；
 *   2. 其余 `${...}` 插值替换成占位符 `X`，补齐 `mcp-client(<名>): ` 消息头，
 *      使其与真实日志同形；
 *   3. 插值之外的字母数低于阀值的丢弃：这类是纯"转发"文案
 *      （`${label}: ${message}`、`${label}: ${action} in ${delay}ms`），真正内容
 *      由源码里的其它变量承载，不该按固定文案要求规则覆盖。
 * @param {string} source
 * @returns {Array<{level: string, text: string, line: number}>}
 */
export function extractLogLiterals(source) {
  const out = []
  const pattern = /ctx\.logger\.(error|warn|info|debug)\(\s*([`'"])([\s\S]*?)\2\s*\)/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    const [, level, , raw] = match
    const line = source.slice(0, match.index).split('\n').length
    const body = raw.replace(/^\$\{[^}]*\}:\s*/, '') // 去掉开头的标签插值
    const letters = body.replace(/\$\{[^}]*\}/g, '').replace(/[^A-Za-z]/g, '').length
    if (letters < 12) continue
    const interpolated = body.replace(/\$\{[^}]*\}/g, 'X')
    const text = interpolated.startsWith('mcp-client(') ? interpolated : `mcp-client(_probe_): ${interpolated}`
    out.push({ level, text, line })
  }
  return out
}

const SOURCE_PATH = resolveMcpClientSource()
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')
const LITERALS = extractLogLiterals(SOURCE)
const FAILURE_LITERALS = LITERALS.filter((literal) => literal.level === 'error' || literal.level === 'warn')

const statusOf = (literal) =>
  mcpClientLogToStatus({
    name: 'mcp-client',
    type: literal.level,
    level: LEVEL_NUMBERS[literal.level],
    args: [literal.text],
  })

/** 落到"未识别透传"兜底的文案（= 规则表缺翻译），返回可直接断言的字符串数组。 */
const untranslated = () =>
  FAILURE_LITERALS.map((literal) => ({ literal, status: statusOf(literal) }))
    .filter(({ status }) => status === null || status.message.startsWith(MCP_UNRECOGNIZED_PREFIX))
    .map(
      ({ literal, status }) =>
        `  - [${literal.level}] ${SOURCE_PATH}:${literal.line} ${JSON.stringify(literal.text)} -> ${status === null ? 'null（完全不识别）' : status.message}`,
    )

describe(`日志文案契约：${SOURCE_PATH}`, () => {
  it('抽取器确实扫到了文案（否则本测试会变成空转）', () => {
    assert.ok(
      LITERALS.length >= 4,
      `只抽到 ${LITERALS.length} 条，检查抽取器与源码形态：\n${JSON.stringify(LITERALS, null, 2)}`,
    )
    assert.ok(FAILURE_LITERALS.length >= 3, '至少要抽到几条 error/warn 文案')
  })

  it('每条 error/warn 文案都由规则表翻译（上游改词 → 这条先红）', () => {
    const gaps = untranslated()
    assert.deepEqual(gaps, [], `以下文案没有规则覆盖，上游一改词用户就会继续看到「已挂载」：\n${gaps.join('\n')}`)
  })

  it('未覆盖的文案在运行期仍会被透传（规则表漏了也不静默）', () => {
    const update = mcpClientLogToStatus({
      name: 'mcp-client',
      type: 'error',
      level: 0,
      args: ['mcp-client(_probe_): some future message'],
    })
    assert.equal(update.state, 'error')
    assert.equal(update.detail, true)
    assert.match(update.message, /some future message/)
  })
})

describe('抽取器自身（防止测试空转）', () => {
  it('去掉开头的标签插值、替换其余插值，保留完整消息头', () => {
    const [first] = extractLogLiterals('ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}`);')
    assert.equal(first.text, 'mcp-client(_probe_): connection attempt failed: X')
  })

  it('serverName 内联在消息头里时不再重复加前缀', () => {
    const [first] = extractLogLiterals(
      'ctx.logger.error(`mcp-client(${opts.serverName}): tool registration failed, no tools registered: ${String(error)}`);',
    )
    assert.equal(first.text, 'mcp-client(X): tool registration failed, no tools registered: X')
  })

  it('纯转发文案（插值外字母太少）被丢弃', () => {
    assert.deepEqual(extractLogLiterals('ctx.logger.error(`${label}: ${message}`);'), [])
    assert.deepEqual(
      extractLogLiterals('ctx.logger.warn(`${label}: ${action} in ${delayMs}ms (attempt ${a}/${b})`);'),
      [],
    )
  })
})

if (process.env.MCP_LOG_CONTRACT_PRINT === '1') {
  for (const literal of LITERALS) {
    const status = statusOf(literal)
    console.log(
      `${literal.level.padEnd(5)} ${String(literal.line).padStart(4)} ${status === null ? '(忽略)' : status.message.slice(0, 56)} :: ${literal.text.slice(0, 72)}`,
    )
  }
}
