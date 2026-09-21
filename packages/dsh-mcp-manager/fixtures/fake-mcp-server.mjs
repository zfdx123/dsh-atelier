// 极简 MCP stdio 服务器（E2E 冒烟测试专用夹具）。
//
// 用 node:readline 逐行解析标准输入上的 JSON-RPC（MCP stdio 传输的
// 线格式），回应 mcp-client SDK 需要的几个方法：
//   initialize / notifications/initialized（通知，忽略）/ tools/list /
//   tools/call / ping
// 不依赖任何 MCP SDK，纯手写，保证测试环境零额外依赖。
//
// 行为开关（通过环境变量，供 E2E 断言服务端行为）：
//   FAKE_MCP_NAME   tools 里的工具名（默认 echo）
//   FAKE_MCP_DELAY_MS   tools/list 应答前延迟（毫秒，默认 0）
//
// tools/call 会把**收到的 argv** 一起回给调用方（第二条 text 内容），
// 这样 E2E 能验证「参数是否被正确拆分并原样传给了子进程」。

import { createInterface } from 'node:readline'

const TOOL_NAME = process.env.FAKE_MCP_NAME || 'echo'
const LIST_DELAY_MS = Number(process.env.FAKE_MCP_DELAY_MS) || 0
const ARGV = process.argv.slice(2)

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', async (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === undefined) return // 通知类消息：忽略

  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result })
  const fail = (error) =>
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: String(error) },
    })

  switch (message.method) {
    case 'initialize':
      reply({
        protocolVersion: (message.params && message.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-server', version: '1.0.0' },
      })
      break
    case 'tools/list':
      if (LIST_DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, LIST_DELAY_MS))
      reply({
        tools: [
          {
            name: TOOL_NAME,
            description: '回声',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
            },
          },
        ],
      })
      break
    case 'tools/call':
      reply({
        content: [
          { type: 'text', text: 'pong' },
          // 把子进程实际收到的参数与脚本路径回传，供 E2E 断言拆参结果
          { type: 'text', text: `argv=${JSON.stringify(ARGV)}` },
          { type: 'text', text: `script=${process.argv[1]}` },
        ],
      })
      break
    case 'ping':
      reply({})
      break
    default:
      fail(new Error(`unsupported method: ${message.method}`))
  }
})
