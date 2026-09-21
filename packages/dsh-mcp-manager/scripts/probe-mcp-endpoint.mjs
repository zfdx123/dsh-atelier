// MCP 端点诊断工具（开发用，不随包发布）。
//
// 排查「设置页一直显示连不上」时先跑这个：它把 TLS 握手、证书内容、以及
// 一次真实 MCP initialize 的结果分开打印，用来区分下面三种情况：
//   1. 网络不通（DNS/路由/端口）
//   2. 证书不受信任（自签名 / CA 不对）→ 需要在设置里配 tlsCaFile 或 tlsInsecure
//   3. 证书没问题但服务端拒绝（401/403/协议不匹配）
//
// 用法：
//   node scripts/probe-mcp-endpoint.mjs https://10.170.17.55:8091/mcp [API_TOKEN]
//
// 注意：--insecure 那一轮只用于诊断；真实连接请用插件里的 tlsCaFile（严格校验）
// 或 tlsInsecure（只对该服务器放宽）。

import tls from 'node:tls'
import https from 'node:https'

const target = process.argv[2]
const token = process.argv[3]
if (!target) {
  console.error('用法：node scripts/probe-mcp-endpoint.mjs <https://host:port/path> [api-token]')
  process.exit(2)
}
const url = new URL(target)
const port = url.port ? Number(url.port) : 443

function tlsProbe() {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: url.hostname, port, servername: url.hostname, rejectUnauthorized: false, timeout: 8000 },
      () => {
        const cert = socket.getPeerCertificate()
        resolve({
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
          protocol: socket.getProtocol(),
          subject: cert?.subject,
          issuer: cert?.issuer,
          validTo: cert?.valid_to,
          san: cert?.subjectaltname,
        })
        socket.end()
      },
    )
    socket.on('error', (error) => resolve({ error: `${error.code || ''} ${error.message}`.trim() }))
    socket.on('timeout', () => {
      socket.destroy()
      resolve({ error: 'TLS 连接超时' })
    })
  })
}

function initialize({ insecure = false } = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1.0.0' } },
    })
    const request = https.request(
      {
        host: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        timeout: 10000,
        rejectUnauthorized: !insecure,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(payload),
          ...(token ? { 'x-api-token': token, authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        let body = ''
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            contentType: response.headers['content-type'],
            body: body.slice(0, 400),
          }),
        )
      },
    )
    request.on('error', (error) => resolve({ error: `${error.code || ''} ${error.message}`.trim() }))
    request.on('timeout', () => {
      request.destroy()
      resolve({ error: 'HTTPS 请求超时' })
    })
    request.end(payload)
  })
}

console.log('=== 1) TLS 握手（不校验证书，仅看证书本身）===')
console.log(JSON.stringify(await tlsProbe(), null, 2))
console.log('\n=== 2) MCP initialize（默认校验证书 = 插件的默认行为）===')
console.log(JSON.stringify(await initialize(), null, 2))
console.log('\n=== 3) MCP initialize（跳过证书校验 = tlsInsecure: true 的效果）===')
console.log(JSON.stringify(await initialize({ insecure: true }), null, 2))
