// 宿主侧纯逻辑单测：settings schema、HTTP 校验、mcp-client 配置构造、配置指纹。
// 不依赖 Cordis 运行时，只依赖 lib/logic.js。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Schema from '@deepseek-ai/schemastery'
import {
  SERVER_NAME_PATTERN,
  ServersSchema,
  validateServers,
  buildClientConfig,
  serverKey,
  mcpClientLogToStatus,
  mergeMountStatus,
  substituteSecretRefs,
  SECRET_REF_PATTERN,
} from '../lib/logic.js'

/**
 * 按 Loader 的方式解析本插件的 Config，返回归一化后的服务器列表。
 *
 * 不能直接调 `ServersSchema(raw)`：`servers` 是 volatile 节点，Loader（与
 * cordis 的 resolveConfig）走的是 `Schema.resolve`，它才会把该节点换成一个
 * 携带 schema 默认值的可变引用。这里复刻那条路径。
 * @param {object} raw 原始 config
 * @returns {Array<object>} 归一化后的服务器列表
 */
function resolveServers(raw) {
  const ref = Schema.resolve(raw, ServersSchema, {})[0].servers
  return ref.get()
}

describe('SERVER_NAME_PATTERN', () => {
  const valid = ['github', 'my_db', 'a-b', 'a1B_-', '0', 'x'.repeat(32)]
  const invalid = ['', 'a b', '中文', 'a.b', 'x'.repeat(33), 'a#b']

  for (const name of valid) {
    it(`接受 ${JSON.stringify(name)}`, () => {
      assert.match(name, SERVER_NAME_PATTERN)
    })
  }
  for (const name of invalid) {
    it(`拒绝 ${JSON.stringify(name)}`, () => {
      assert.doesNotMatch(name, SERVER_NAME_PATTERN)
    })
  }
})

describe('ServersSchema（插件 Config 契约）', () => {
  it('空对象归一化为空列表', () => {
    assert.deepEqual(resolveServers({}), [])
  })

  it('保留用户的 enabled: false（开关状态持久化契约）', () => {
    const value = resolveServers({
      servers: [{ serverName: 'srv', transport: 'stdio', command: 'echo hi', enabled: false }],
    })
    assert.equal(value[0].enabled, false)
  })

  it('缺失字段按默认值补齐', () => {
    const value = resolveServers({
      servers: [{ serverName: 'srv', transport: 'stdio', command: 'echo hi' }],
    })
    const server = value[0]
    assert.equal(server.enabled, true)
    assert.deepEqual(server.args, [])
    assert.deepEqual(server.env, {})
    assert.equal(server.cwd, '')
    assert.deepEqual(server.headers, {})
    assert.equal(server.url, '')
    assert.equal(server.toolCallTimeoutMs, 60000)
    assert.equal(server.failOnStartupError, false)
    // TLS / 重连默认值与 mcp-client 契约默认一致（不校验证书、重连开启 10 次）
    assert.equal(server.tlsInsecure, false)
    assert.equal(server.tlsCaFile, '')
    assert.equal(server.reconnectEnabled, true)
    assert.equal(server.reconnectMaxAttempts, 10)
  })

  it('可配置项（超时/启动失败即报错）随 schema 归一化', () => {
    const value = resolveServers({
      servers: [
        {
          serverName: 'srv',
          transport: 'stdio',
          command: 'echo hi',
          toolCallTimeoutMs: 5000,
          failOnStartupError: true,
        },
      ],
    })
    assert.equal(value[0].toolCallTimeoutMs, 5000)
    assert.equal(value[0].failOnStartupError, true)
  })

  it('TLS / 重连字段随 schema 归一化', () => {
    const value = resolveServers({
      servers: [
        {
          serverName: 'srv',
          transport: 'streamable-http',
          url: 'https://10.0.0.1:8091/mcp',
          tlsInsecure: true,
          tlsCaFile: 'C:\\certs\\ca.pem',
          reconnectEnabled: false,
          reconnectMaxAttempts: 3,
        },
      ],
    })
    const server = value[0]
    assert.equal(server.tlsInsecure, true)
    assert.equal(server.tlsCaFile, 'C:\\certs\\ca.pem')
    assert.equal(server.reconnectEnabled, false)
    assert.equal(server.reconnectMaxAttempts, 3)
  })
})

describe('validateServers（HTTP 接口校验）', () => {
  it('非数组被拒绝', () => {
    assert.match(validateServers({}), /必须是数组/)
  })

  it('非对象条目被拒绝', () => {
    assert.match(validateServers([null]), /必须是一个对象/)
  })

  it('serverName 非法/重复被拒绝', () => {
    assert.match(validateServers([{ serverName: 'a b', transport: 'stdio', command: 'x' }]), /serverName 无效/)
    const one = () => ({ serverName: 'a', transport: 'stdio', command: 'x' })
    assert.match(validateServers([one(), one()]), /重复/)
  })

  it('enabled 非布尔被拒绝', () => {
    assert.match(
      validateServers([{ serverName: 'a', transport: 'stdio', command: 'x', enabled: 'yes' }]),
      /enabled 必须是布尔值/,
    )
  })

  it('toolCallTimeoutMs 非正数/非数字被拒绝', () => {
    for (const bad of [0, -1, '5000', NaN, Infinity]) {
      assert.match(
        validateServers([{ serverName: 'a', transport: 'stdio', command: 'x', toolCallTimeoutMs: bad }]),
        /toolCallTimeoutMs 必须是 >= 1 的数字/,
        String(bad),
      )
    }
  })

  it('failOnStartupError 非布尔被拒绝', () => {
    assert.match(
      validateServers([{ serverName: 'a', transport: 'stdio', command: 'x', failOnStartupError: 'yes' }]),
      /failOnStartupError 必须是布尔值/,
    )
  })

  it('新字段缺省（undefined/null）时容忍', () => {
    assert.equal(
      validateServers([
        { serverName: 'a', transport: 'stdio', command: 'x', toolCallTimeoutMs: null, failOnStartupError: null },
      ]),
      null,
    )
  })

  it('TLS 字段类型错误被拒绝', () => {
    assert.match(
      validateServers([{ serverName: 'a', transport: 'streamable-http', url: 'https://x/mcp', tlsInsecure: 'yes' }]),
      /tlsInsecure 必须是布尔值/,
    )
    assert.match(
      validateServers([{ serverName: 'a', transport: 'streamable-http', url: 'https://x/mcp', tlsCaFile: 42 }]),
      /tlsCaFile 必须是字符串/,
    )
  })

  it('reconnect 字段类型错误被拒绝', () => {
    assert.match(
      validateServers([{ serverName: 'a', transport: 'stdio', command: 'x', reconnectEnabled: 'no' }]),
      /reconnectEnabled 必须是布尔值/,
    )
    for (const bad of [0, -1, 1.5, '3', NaN]) {
      assert.match(
        validateServers([{ serverName: 'a', transport: 'stdio', command: 'x', reconnectMaxAttempts: bad }]),
        /reconnectMaxAttempts 必须是 >= 1 的整数/,
        String(bad),
      )
    }
  })

  it('stdio 缺 command 被拒绝', () => {
    assert.match(validateServers([{ serverName: 'a', transport: 'stdio', command: '  ' }]), /必须提供 command/)
  })

  it('streamable-http 缺 url 被拒绝', () => {
    assert.match(validateServers([{ serverName: 'a', transport: 'streamable-http', url: '' }]), /必须提供 url/)
  })

  it('未知 transport 被拒绝', () => {
    assert.match(validateServers([{ serverName: 'a', transport: 'ssh' }]), /transport 无效/)
  })

  it('合法的 stdio 与 http 均通过', () => {
    assert.equal(
      validateServers([
        { serverName: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'x'] },
        { serverName: 'remote', transport: 'streamable-http', url: 'http://localhost:3000/mcp' },
      ]),
      null,
    )
  })

  it('enabled 为 null 时容忍（等价于默认 true）', () => {
    assert.equal(validateServers([{ serverName: 'a', transport: 'stdio', command: 'x', enabled: null }]), null)
  })
})

describe('buildClientConfig（mcp-client 实例配置契约）', () => {
  it('stdio：只输出契约内的键', () => {
    const config = buildClientConfig({
      serverName: 'local',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { A: '1' },
      cwd: '/tmp',
      url: '',
      headers: {},
    })
    assert.deepEqual(Object.keys(config).sort(), [
      'args',
      'command',
      'cwd',
      'env',
      'failOnStartupError',
      'serverName',
      'toolCallTimeoutMs',
      'transport',
    ])
    assert.equal(config.command, 'npx')
    assert.deepEqual(config.args, ['-y', 'pkg'])
    assert.deepEqual(config.env, { A: '1' })
    assert.equal(config.cwd, '/tmp')
    assert.equal(config.toolCallTimeoutMs, 60000)
    assert.equal(config.failOnStartupError, false)
  })

  it('stdio：可选字段缺省时省略/取默认，cwd 为空时省略', () => {
    const config = buildClientConfig({ serverName: 'local', transport: 'stdio', command: 'echo hi' })
    assert.equal(config.cwd, undefined)
    assert.deepEqual(config.args, [])
    assert.deepEqual(config.env, {})
  })

  it('stdio：env/args 非对象输入被清洗为默认值', () => {
    const config = buildClientConfig({
      serverName: 'local',
      transport: 'stdio',
      command: 'x',
      env: 'oops',
      args: 'oops',
    })
    assert.deepEqual(config.env, {})
    assert.deepEqual(config.args, [])
  })

  it('自定义 toolCallTimeoutMs / failOnStartupError 透传；非法时回落默认', () => {
    const config = buildClientConfig({
      serverName: 'local',
      transport: 'stdio',
      command: 'x',
      toolCallTimeoutMs: 3000,
      failOnStartupError: true,
    })
    assert.equal(config.toolCallTimeoutMs, 3000)
    assert.equal(config.failOnStartupError, true)

    assert.equal(
      buildClientConfig({ serverName: 'local', transport: 'stdio', command: 'x', toolCallTimeoutMs: NaN })
        .toolCallTimeoutMs,
      60000,
    )
    assert.equal(
      buildClientConfig({ serverName: 'local', transport: 'stdio', command: 'x', toolCallTimeoutMs: 0 })
        .toolCallTimeoutMs,
      60000,
    )
    assert.equal(
      buildClientConfig({ serverName: 'local', transport: 'stdio', command: 'x', failOnStartupError: 'yes' })
        .failOnStartupError,
      false,
    )
  })

  it('streamable-http：只输出契约内的键', () => {
    const config = buildClientConfig({
      serverName: 'remote',
      enabled: true,
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer t' },
      command: '',
      args: [],
      env: {},
      cwd: '',
    })
    assert.deepEqual(Object.keys(config).sort(), [
      'failOnStartupError',
      'headers',
      'serverName',
      'toolCallTimeoutMs',
      'transport',
      'url',
    ])
    assert.equal(config.url, 'http://localhost:3000/mcp')
    assert.deepEqual(config.headers, { Authorization: 'Bearer t' })
  })

  it('streamable-http：headers 非对象输入被清洗为 {}', () => {
    const config = buildClientConfig({ serverName: 'remote', transport: 'streamable-http', url: 'u', headers: null })
    assert.deepEqual(config.headers, {})
  })

  it('reconnect：仅在非默认时输出，且只含契约内的子键', () => {
    // 全默认（settings 归一化后的形态）→ 仍然显式带上 maxAttempts（等于契约默认 10）
    const normalized = buildClientConfig({
      serverName: 'local',
      transport: 'stdio',
      command: 'x',
      reconnectEnabled: true,
      reconnectMaxAttempts: 10,
    })
    assert.deepEqual(normalized.reconnect, { maxAttempts: 10 })
    assert.deepEqual(Object.keys(normalized.reconnect), ['maxAttempts'])

    const custom = buildClientConfig({
      serverName: 'local',
      transport: 'stdio',
      command: 'x',
      reconnectEnabled: false,
      reconnectMaxAttempts: 3,
    })
    assert.deepEqual(custom.reconnect, { enabled: false, maxAttempts: 3 })

    // 关闭重连 + 非法次数（NaN）→ 只输出 enabled: false
    const off = buildClientConfig({
      serverName: 'local',
      transport: 'stdio',
      command: 'x',
      reconnectEnabled: false,
      reconnectMaxAttempts: NaN,
    })
    assert.deepEqual(off.reconnect, { enabled: false })

    // 老形态（完全没有这两个字段）→ 不输出 reconnect，交给 mcp-client 默认值
    const legacy = buildClientConfig({ serverName: 'local', transport: 'stdio', command: 'x' })
    assert.equal(legacy.reconnect, undefined)
    assert.deepEqual(Object.keys(legacy).sort(), [
      'args',
      'command',
      'env',
      'failOnStartupError',
      'serverName',
      'toolCallTimeoutMs',
      'transport',
    ])
  })

  it('streamable-http 同样支持 reconnect', () => {
    const config = buildClientConfig({
      serverName: 'remote',
      transport: 'streamable-http',
      url: 'https://x/mcp',
      reconnectEnabled: false,
      reconnectMaxAttempts: 2,
    })
    assert.deepEqual(config.reconnect, { enabled: false, maxAttempts: 2 })
  })
})

describe('serverKey（配置指纹）', () => {
  const base = {
    serverName: 's',
    enabled: true,
    transport: 'stdio',
    command: 'x',
    args: [],
    env: {},
    cwd: '',
    url: '',
    headers: {},
  }

  it('相同配置指纹相同（忽略键顺序）', () => {
    assert.equal(serverKey(base), serverKey({ ...base, dummy: 1 }))
  })

  it('enabled 翻转改变指纹（开关切换可被识别）', () => {
    assert.notEqual(serverKey(base), serverKey({ ...base, enabled: false }))
  })

  it('任意业务字段变化改变指纹', () => {
    for (const field of ['command', 'transport', 'url', 'cwd']) {
      assert.notEqual(serverKey(base), serverKey({ ...base, [field]: 'changed' }), field)
    }
  })

  it('新增可配置项参与指纹（改超时/报错开关会触发重建）', () => {
    assert.notEqual(serverKey(base), serverKey({ ...base, toolCallTimeoutMs: 3000 }))
    assert.notEqual(serverKey(base), serverKey({ ...base, failOnStartupError: true }))
  })

  it('TLS / 重连字段参与指纹（改这些会触发重建）', () => {
    assert.notEqual(serverKey(base), serverKey({ ...base, tlsInsecure: true }))
    assert.notEqual(serverKey(base), serverKey({ ...base, tlsCaFile: 'C:\\ca.pem' }))
    assert.notEqual(serverKey(base), serverKey({ ...base, reconnectEnabled: false }))
    assert.notEqual(serverKey(base), serverKey({ ...base, reconnectMaxAttempts: 3 }))
  })
})

describe('mcpClientLogToStatus（mcp-client 日志 → 挂载状态）', () => {
  // type 与 level 必须一致（cordis：error=0 / info=1 / warn=2 / debug=3），
  // 因为「未识别文案」的兜底策略按级别区分：error/warn 透传，info/debug 忽略。
  const log = (args, name = 'mcp-client', type = 'warn') => ({
    name,
    type,
    level: { error: 0, info: 1, warn: 2, debug: 3 }[type],
    args,
  })

  it('连接尝试失败 → error（带原因，标记 detail）', () => {
    const update = mcpClientLogToStatus(log(['mcp-client(github): connection attempt failed: spawn /nope ENOENT']))
    assert.deepEqual(update, {
      serverName: 'github',
      state: 'error',
      message: '连接失败：spawn /nope ENOENT',
      detail: true,
    })
  })

  it('重试中 / 重连中 → error（固定文案，detail=false）', () => {
    assert.deepEqual(
      mcpClientLogToStatus(log(['mcp-client(a): connection failed; retrying in 500ms (attempt 1/10)'])),
      { serverName: 'a', state: 'error', message: '连接失败，重试中…', detail: false },
    )
    assert.deepEqual(
      mcpClientLogToStatus(log(['mcp-client(a): connection lost; reconnecting in 1000ms (attempt 2/10)'])),
      { serverName: 'a', state: 'error', message: '连接中断，重连中…', detail: false },
    )
  })

  it('重连成功 → ok', () => {
    assert.deepEqual(mcpClientLogToStatus(log(['mcp-client(a): reconnected and re-synced tools (attempt 3/10)'])), {
      serverName: 'a',
      state: 'ok',
      message: '',
      detail: false,
    })
  })

  it('放弃重连 / 重连被禁用 / 工具注册失败 → error', () => {
    assert.equal(
      mcpClientLogToStatus(
        log(['mcp-client(a): giving up after 10 consecutive failed reconnect attempts — tools unregistered']),
      ).state,
      'error',
    )
    assert.equal(
      mcpClientLogToStatus(
        log(['mcp-client(a): connection failed and reconnect is disabled — no tools were registered']),
      ).state,
      'error',
    )
    assert.equal(
      mcpClientLogToStatus(
        log(['mcp-client(a): connection lost and reconnect is disabled — registered tools will fail']),
      ).state,
      'error',
    )
    const reg = mcpClientLogToStatus(log(['mcp-client(a): tool registration failed, no tools registered: boom']))
    assert.equal(reg.state, 'error')
    assert.match(reg.message, /工具注册失败：boom/)
    assert.equal(reg.detail, true)
  })

  it('无法确认关闭：新旧两种上游措辞都要识别（0.1.6-alpha.1 改写过的文案）', () => {
    // 旧措辞 0.1.0-rc.8 lib/index.js:655；新措辞 0.1.6-alpha.1 lib/index.js:539。
    // 两者都是终态（不再重连），必须在设置页上呈现为 error。
    for (const text of [
      'failed generation did not close within 5000ms — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry',
      'failed generation could not confirm transport closure — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry',
    ]) {
      const update = mcpClientLogToStatus(log([`mcp-client(a): ${text}`]))
      assert.equal(update.state, 'error', text)
      assert.match(update.message, /停止重连/, text)
    }
  })

  it('拆卸期关闭未确认 → 也给出可读错误（两种上游措辞都要认）', () => {
    for (const text of [
      // rc.8 lib/index.js:692
      'generation did not close within 5000ms during disposal — server shutdown may be incomplete',
      // 0.1.6-alpha.1 lib/index.js:483（同一事件被改写）
      'transport closure could not be confirmed during disposal — server shutdown may be incomplete',
    ]) {
      const update = mcpClientLogToStatus(log([`mcp-client(a): ${text}`], 'mcp-client', 'error'))
      assert.equal(update.state, 'error', text)
      assert.equal(update.detail, true, text)
      assert.ok(
        !update.message.startsWith('未识别的 mcp-client 日志'),
        `应被规则翻译而不是落到透传兜底：${update.message}`,
      )
    }
  })

  it('未识别的 error/warn 透传原文，绝不静默丢弃（上游再改词也不会变成「已挂载」）', () => {
    const update = mcpClientLogToStatus(
      log(['mcp-client(a): brand new failure mode introduced by a future upstream version'], 'mcp-client', 'error'),
    )
    assert.equal(update.state, 'error')
    assert.equal(update.detail, true)
    assert.match(update.message, /brand new failure mode/)

    const warn = mcpClientLogToStatus(log(['mcp-client(a): yet another unrecognized warning'], 'mcp-client', 'warn'))
    assert.equal(warn.state, 'error')
    assert.match(warn.message, /unrecognized warning/)
  })

  it('info/debug 级未识别文案不产生状态（正常日志不该把服务器标红）', () => {
    assert.equal(
      mcpClientLogToStatus(log(['mcp-client(a): tool list changed, re-syncing'], 'mcp-client', 'info')),
      null,
    )
    assert.equal(mcpClientLogToStatus(log(['mcp-client(a): 未来的某条 debug 日志'], 'mcp-client', 'debug')), null)
  })

  it('无关日志 / 其他 logger 名 → null', () => {
    // 上游把这条打在 info 级（rc.8 :628 / 0.1.6-alpha.1 :634），夹具按真实级别给
    assert.equal(
      mcpClientLogToStatus(log(['mcp-client(a): tool list changed, re-syncing'], 'mcp-client', 'info')),
      null,
    )
    assert.equal(mcpClientLogToStatus(log(['dsh-mcp-manager: 随便一条日志'])), null)
    assert.equal(mcpClientLogToStatus(log(['其他内容'])), null)
    assert.equal(mcpClientLogToStatus(null), null)
    assert.equal(mcpClientLogToStatus({ name: 'mcp-client', type: 'info', level: 1, args: [] }), null)
  })
})

describe('mergeMountStatus（重试类固定文案不冲掉具体原因）', () => {
  const attempt = (message) => ({ state: 'error', message, detail: true })
  const retrying = { state: 'error', message: '连接失败，重试中…', detail: false }
  const ok = { state: 'ok', message: '', detail: false }

  it('先有具体原因再收到「重试中」→ 保留原因（用户实际遇到的场景）', () => {
    const merged = mergeMountStatus(
      attempt('连接失败：fetch failed ← DEPTH_ZERO_SELF_SIGNED_CERT self-signed certificate'),
      retrying,
    )
    assert.equal(merged.state, 'error')
    assert.match(merged.message, /DEPTH_ZERO_SELF_SIGNED_CERT/)
    assert.equal(merged.detail, true)
  })

  it('新的具体原因覆盖旧原因', () => {
    const merged = mergeMountStatus(attempt('连接失败：旧原因'), attempt('连接失败：新原因'))
    assert.equal(merged.message, '连接失败：新原因')
  })

  it('恢复成功清空消息（不保留历史原因）', () => {
    assert.deepEqual(mergeMountStatus(attempt('连接失败：证书'), ok), ok)
  })

  it('没有历史状态时直接用新状态；update 为 null 时保持原样', () => {
    assert.deepEqual(mergeMountStatus(undefined, retrying), retrying)
    const previous = attempt('连接失败：证书')
    assert.equal(mergeMountStatus(previous, null), previous)
  })

  it('ok 状态不被后续固定文案覆盖成 error 之外的怪状态', () => {
    const merged = mergeMountStatus(ok, { state: 'error', message: '连接中断，重连中…', detail: false })
    assert.equal(merged.state, 'error')
    assert.equal(merged.message, '连接中断，重连中…')
  })
})

// 前置检查的判定必须**持久**：它写下的主文案不能被后续的异步失败顶掉（否则设置页
// 退回「连接失败：SdkError: Connection closed」，正是前置检查要替换掉的那句话）。
// 端到端的行为断言在 test/e2e.test.js；这里把合并规则本身钉死，含「谁能清掉它」。
describe('mergeMountStatus：启动前置检查的判定不被异步失败顶掉（回归：瞬时的可照改的一句话）', () => {
  const PROBLEM = '找不到可执行文件：C:\\gone\\python.exe（路径是否正确？或它在 PATH 里吗？）'
  const preflight = { state: 'error', message: `启动前置检查未通过：${PROBLEM}`, detail: true, preflight: PROBLEM }
  const attempt = (message) => ({ state: 'error', message, detail: true })
  const retrying = { state: 'error', message: '连接失败，重试中…', detail: false }
  const ok = { state: 'ok', message: '', detail: false }

  it('真实异步失败并入 failure，主文案仍是前置检查那句', () => {
    const merged = mergeMountStatus(preflight, attempt('连接失败：SdkError: Connection closed'))
    assert.equal(merged.state, 'error')
    assert.equal(merged.message, `启动前置检查未通过：${PROBLEM}`)
    assert.equal(merged.preflight, PROBLEM)
    assert.equal(merged.failure, '连接失败：SdkError: Connection closed')
    assert.equal(merged.detail, true)
  })

  it('重试类固定文案不冲掉已并入的具体失败', () => {
    const once = mergeMountStatus(preflight, attempt('连接失败：SdkError: Connection closed'))
    const twice = mergeMountStatus(once, retrying)
    assert.equal(twice.message, `启动前置检查未通过：${PROBLEM}`)
    assert.equal(twice.failure, '连接失败：SdkError: Connection closed')
  })

  it('细节取最近一条带具体原因的失败（新原因比旧原因有用）', () => {
    const once = mergeMountStatus(preflight, attempt('启动失败：spawn ENOENT'))
    const twice = mergeMountStatus(once, attempt('启动失败：EACCES'))
    assert.equal(twice.failure, '启动失败：EACCES')
  })

  it('连接成功清掉前置检查的判定（启发式这次判断错了，不该继续喊狼来了）', () => {
    assert.deepEqual(mergeMountStatus(preflight, ok), ok)
  })

  it('没有前置检查时行为不变，也不凭空多出 preflight/failure 键', () => {
    assert.deepEqual(mergeMountStatus(attempt('连接失败：旧原因'), attempt('连接失败：新原因')), {
      state: 'error',
      message: '连接失败：新原因',
      detail: true,
    })
  })
})

describe('substituteSecretRefs（密钥引用解析，不入盘）', () => {
  it('env:/cred: 引用被替换，非引用值原样保留', async () => {
    const config = {
      serverName: 's',
      transport: 'stdio',
      command: 'x',
      env: { A: 'env:TOKEN', B: 'cred:API_KEY', C: 'plain', D: 'cred:bad name' },
      headers: { Authorization: 'cred:API_KEY', X: 'env:TOKEN' },
    }
    const resolved = await substituteSecretRefs(config, async (name, kind) => {
      if (name === 'TOKEN') return 'secret-env'
      if (name === 'API_KEY' && kind === 'cred') return 'secret-cred'
      return undefined
    })
    assert.deepEqual(resolved.env, { A: 'secret-env', B: 'secret-cred', C: 'plain', D: 'cred:bad name' })
    assert.deepEqual(resolved.headers, { Authorization: 'secret-cred', X: 'secret-env' })
    // 入参不被修改
    assert.equal(config.env.A, 'env:TOKEN')
  })

  it('解析失败（未配置）保留字面值', async () => {
    const config = { serverName: 's', transport: 'stdio', command: 'x', env: { A: 'env:MISSING' } }
    const resolved = await substituteSecretRefs(config, async () => undefined)
    assert.equal(resolved.env.A, 'env:MISSING')
  })

  it('解析器可以是同步函数', async () => {
    const resolved = await substituteSecretRefs(
      { serverName: 's', transport: 'stdio', command: 'x', env: { A: 'env:TOKEN' } },
      (name) => `v:${name}`,
    )
    assert.equal(resolved.env.A, 'v:TOKEN')
  })

  it('SECRET_REF_PATTERN 只接受合法引用名', () => {
    assert.match('env:TOKEN', SECRET_REF_PATTERN)
    assert.match('cred:MY_KEY_2', SECRET_REF_PATTERN)
    assert.doesNotMatch('env:1BAD', SECRET_REF_PATTERN)
    assert.doesNotMatch('env:BAD-NAME', SECRET_REF_PATTERN)
    assert.doesNotMatch('plain', SECRET_REF_PATTERN)
  })
})
