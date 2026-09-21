// 假 MCP 服务器（HTTPS + 自签名证书）——仅供测试使用。
//
// 用途：验证「内网自签名证书的 streamable-http MCP 服务器」这条链路：
// 不开 tlsInsecure 时 Node 默认校验证书 → 连接必然失败；开了之后由
// lib/tls.js 只对该 origin 分流到带自定义 dispatcher 的 undici fetch → 成功
// 注册工具。证书是 fixtures/tls/localhost-*.pem（一次性生成的自签名测试证书，
// 不是任何真实站点的证书）。
//
// 进程内起服务器（不 spawn 子进程），端口由 OS 分配。
// 协议按 MCP streamable HTTP：GET（SSE）返回 405 表示不支持 standalone SSE。

import { createServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 起一个自签名 HTTPS MCP 服务器。
 * @param {{certDir?: string, toolName?: string, onRequest?: Function}} [options]
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>, requests: string[]}>}
 */
export async function createTlsMcpServer(options = {}) {
  const certDir = options.certDir || join(here, 'tls')
  const toolName = options.toolName || 'echo'
  const key = readFileSync(join(certDir, 'localhost-key.pem'))
  const cert = readFileSync(join(certDir, 'localhost-cert.pem'))
  const requests = []

  const send = (res, payload, status = 200) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }

  const server = createServer({ key, cert }, (req, res) => {
    requests.push(req.method)
    if (options.onRequest) options.onRequest(req)
    if (req.method !== 'POST') {
      // MCP 规范：不支持 GET 的 standalone SSE / DELETE 会话终止时回 405。
      res.writeHead(405).end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let message
      try {
        message = JSON.parse(raw)
      } catch {
        send(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400)
        return
      }
      const id = message.id
      const reply = (result) => send(res, { jsonrpc: '2.0', id, result })
      switch (message.method) {
        case 'initialize':
          reply({
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'tls-fixture', version: '1.0.0' },
          })
          return
        case 'tools/list':
          reply({
            tools: [
              {
                name: toolName,
                description: '回显入参',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
              },
            ],
          })
          return
        case 'tools/call':
          reply({ content: [{ type: 'text', text: JSON.stringify(message.params?.arguments ?? {}) }] })
          return
        default:
          if (id === undefined) {
            // 通知（如 notifications/initialized）：202 + 空体
            res.writeHead(202).end()
            return
          }
          send(res, { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${message.method}` } })
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    url: `https://localhost:${port}/mcp`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
