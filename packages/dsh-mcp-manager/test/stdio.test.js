// lib/stdio.js 单测：命令行分词、stdio 配置归一化、启动前置检查。
// 真实故障回归：用户把整条命令行粘进「命令」栏 + 每个参数行里各含两个 token，
// 结果 spawn ENOENT / argparse 退出，而面板只显示 -32000 Connection closed。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { splitCommandLine, normalizeStdioServer, preflightStdioServer, createFsProbe } from '../lib/stdio.js'

/** 可控的文件系统替身：只认识给出的路径与可执行文件。 */
function fakeProbe({ paths = [], executables = [] } = {}) {
  const pathSet = new Set(paths)
  const exeSet = new Set(executables)
  const calls = { isExistingPath: [], isExecutable: [] }
  return {
    calls,
    isExistingPath(token) {
      calls.isExistingPath.push(token)
      return pathSet.has(token)
    },
    isExecutable(token) {
      calls.isExecutable.push(token)
      return exeSet.has(token)
    },
  }
}

const PY = 'E:\\work\\bsm\\mcp-http-inspector\\.venv\\Scripts\\python'
const SCRIPT = 'E:\\work\\bsm\\mcp-http-inspector\\server.py'

describe('splitCommandLine', () => {
  it('按空白切分，压掉多余空格', () => {
    assert.deepEqual(splitCommandLine('a  b\tc\nd'), ['a', 'b', 'c', 'd'])
  })

  it('双引号/单引号分组，引号本身去掉', () => {
    assert.deepEqual(splitCommandLine('a "b c" d'), ['a', 'b c', 'd'])
    assert.deepEqual(splitCommandLine("--flag 'x y'"), ['--flag', 'x y'])
    assert.deepEqual(splitCommandLine('"C:\\Program Files\\node.exe" -v'), ['C:\\Program Files\\node.exe', '-v'])
  })

  it('反斜杠是普通字符（Windows 路径不会被当转义）', () => {
    assert.deepEqual(splitCommandLine('E:\\work\\bsm\\server.py'), ['E:\\work\\bsm\\server.py'])
    assert.deepEqual(splitCommandLine('a\\ b'), ['a\\', 'b'])
  })

  it('空输入 / 纯空白 / 空引号', () => {
    assert.deepEqual(splitCommandLine(''), [])
    assert.deepEqual(splitCommandLine('   '), [])
    assert.deepEqual(splitCommandLine(undefined), [])
    assert.deepEqual(splitCommandLine(null), [])
    assert.deepEqual(splitCommandLine('""'), [''])
  })
})

describe('createFsProbe：真实探针（假探针测不出这类错，必须拿真文件系统验）', () => {
  const probe = createFsProbe()
  const thisFile = fileURLToPath(import.meta.url)

  it('真实可执行文件（process.execPath）判为可执行', () => {
    assert.equal(probe.isExecutable(process.execPath), true)
  })

  it('Windows：不带扩展名的可执行路径也能识别（venv 的 python 就是这种）', () => {
    if (process.platform !== 'win32') return
    assert.match(process.execPath, /\.exe$/i)
    const withoutExtension = process.execPath.replace(/\.exe$/i, '')
    assert.equal(probe.isExistingPath(withoutExtension), false, '原始路径本身不存在')
    assert.equal(probe.isExecutable(withoutExtension), true, '补 .exe 后应判为可执行')
  })

  it('存在的普通文件算可执行候选；目录 / 不存在的绝对路径不算', () => {
    // 这是启发式判断：只用来决定「command 要不要拆成 exe + 参数」，
    // 宁可宽松（多拆一个真实存在的文件路径无害），不可漏拆（会退化成 ENOENT）。
    assert.equal(probe.isExecutable(thisFile), true)
    assert.equal(probe.isExecutable(fileURLToPath(new URL('..', import.meta.url))), false, '目录不算')
    assert.equal(probe.isExecutable('C:\\definitely\\not\\here\\nope'), false)
    assert.equal(probe.isExecutable('/definitely/not/here/nope'), false)
    assert.equal(probe.isExecutable(''), false)
  })

  it('isExistingPath 只认原样存在的路径（带空格路径的保护靠它）', () => {
    assert.equal(probe.isExistingPath(thisFile), true)
    assert.equal(probe.isExistingPath(`${thisFile} 不存在`), false)
  })
})

describe('normalizeStdioServer：把粘进来的命令行还原（真实故障）', () => {
  it('用户的原始配置 → 拆成 exe + args（对照组 C 的形态）', () => {
    const probe = fakeProbe({ executables: [PY] })
    const { server, changes } = normalizeStdioServer(
      {
        serverName: 'http-inspector',
        transport: 'stdio',
        command: `${PY} ${SCRIPT}`,
        args: ['--transport stdio', '--port 9876'],
      },
      probe,
    )
    assert.equal(server.command, PY)
    assert.deepEqual(server.args, [SCRIPT, '--transport', 'stdio', '--port', '9876'])
    assert.equal(changes.length, 3, JSON.stringify(changes))
    assert.match(changes[0], /command 里含多个 token/)
    assert.equal(server.serverName, 'http-inspector')
  })

  it('npx 风格：command 里带包名与参数，一并还原', () => {
    const probe = fakeProbe({ executables: ['npx'] })
    const { server } = normalizeStdioServer(
      {
        transport: 'stdio',
        command: 'npx -y @some/mcp-server',
        args: [],
      },
      probe,
    )
    assert.equal(server.command, 'npx')
    assert.deepEqual(server.args, ['-y', '@some/mcp-server'])
  })

  it('真实存在的带空格路径不被误拆', () => {
    const exe = 'C:\\Program Files\\nodejs\\node.exe'
    const probe = fakeProbe({ paths: [exe] })
    const { server, changes } = normalizeStdioServer({ transport: 'stdio', command: exe, args: [] }, probe)
    assert.equal(server.command, exe)
    assert.deepEqual(changes, [])
  })

  it('引号包裹的带空格路径 → 去引号后保持为一个 token', () => {
    const exe = 'C:\\Program Files\\nodejs\\node.exe'
    const probe = fakeProbe({ executables: ['C:\\Program'] })
    const { server, changes } = normalizeStdioServer({ transport: 'stdio', command: `"${exe}"`, args: [] }, probe)
    assert.equal(server.command, exe)
    assert.match(changes.join(), /引号已去掉/)
    // 关键：没有被当成命令行拆开（第一个 token 是可执行文件也不能拆，因为引号声明了整体）
    assert.deepEqual(server.args, [])
  })

  it('第一个 token 不是可执行文件 → 保持原样（把判断交给前置检查，不乱拆）', () => {
    const probe = fakeProbe()
    const raw = 'C:\\Program Files\\nodejs\\node.exe'
    const { server, changes } = normalizeStdioServer({ transport: 'stdio', command: raw, args: [] }, probe)
    assert.equal(server.command, raw)
    assert.deepEqual(changes, [])
  })

  it('已经是正确形态的配置 → 原样返回（同一引用，无改动）', () => {
    const original = { transport: 'stdio', command: PY, args: [SCRIPT, '--transport', 'stdio'] }
    const probe = fakeProbe({ executables: [PY], paths: [SCRIPT] })
    const { server, changes } = normalizeStdioServer(original, probe)
    assert.equal(server, original)
    assert.deepEqual(changes, [])
  })

  it('真实探针 + 真实存在的可执行文件：command 里的脚本路径被拆到 args（端到端形态）', () => {
    // 用 node 自己当「可执行文件」，脚本用本测试文件（存在即可）
    const script = fileURLToPath(import.meta.url)
    const { server, changes } = normalizeStdioServer(
      {
        transport: 'stdio',
        command: `${process.execPath} ${script}`,
        args: ['--flag value'],
      },
      createFsProbe(),
    )
    assert.equal(server.command, process.execPath)
    assert.deepEqual(server.args, [script, '--flag', 'value'])
    assert.ok(changes.length >= 2, JSON.stringify(changes))
  })

  it('参数里含空格但整体是真实存在的路径 → 不拆', () => {
    const scriptWithSpace = 'C:\\my dir\\a.py'
    const probe = fakeProbe({ executables: ['python'], paths: [scriptWithSpace] })
    const { server } = normalizeStdioServer(
      {
        transport: 'stdio',
        command: 'python',
        args: [scriptWithSpace],
      },
      probe,
    )
    assert.equal(server.command, 'python')
    assert.deepEqual(server.args, [scriptWithSpace])
  })

  it('参数用双引号保护含空格的值 → 去引号后保持一个参数', () => {
    const probe = fakeProbe({ executables: ['tool'] })
    const { server } = normalizeStdioServer(
      {
        transport: 'stdio',
        command: 'tool',
        args: ['--title "hello world"'],
      },
      probe,
    )
    assert.deepEqual(server.args, ['--title', 'hello world'])
  })

  it('非 stdio / 缺字段 → 不处理', () => {
    for (const input of [null, undefined, { transport: 'streamable-http', url: 'https://x' }, { transport: 'stdio' }]) {
      const probe = fakeProbe()
      const { server, changes } = normalizeStdioServer(input, probe)
      assert.equal(changes.length, 0)
      assert.equal(server, input)
    }
  })
})

describe('preflightStdioServer：把「连不上」换成能照改的一句话', () => {
  it('可执行文件找不到 → 指名道姓', () => {
    const probe = fakeProbe()
    const problem = preflightStdioServer({ transport: 'stdio', command: 'nope-binary', args: [] }, probe)
    assert.match(problem, /找不到可执行文件：nope-binary/)
  })

  it('脚本文件不存在 → 指出来（绝对路径的 .py/.js 参数）', () => {
    const probe = fakeProbe({ executables: ['python'] })
    const problem = preflightStdioServer(
      { transport: 'stdio', command: 'python', args: ['C:\\gone\\missing.py'] },
      probe,
    )
    assert.match(problem, /脚本文件不存在：C:\\gone\\missing\.py/)
  })

  it('相对路径的脚本参数不做判断（可能相对 cwd，宁缺勿滥）', () => {
    const probe = fakeProbe({ executables: ['python'] })
    assert.equal(preflightStdioServer({ transport: 'stdio', command: 'python', args: ['server.py'] }, probe), null)
  })

  it('工作目录不存在 → 指出来', () => {
    const probe = fakeProbe({ executables: ['node'] })
    const problem = preflightStdioServer({ transport: 'stdio', command: 'node', args: [], cwd: 'C:\\gone' }, probe)
    assert.match(problem, /工作目录不存在：C:\\gone/)
  })

  it('command 里仍含多个 token（没被归一化）→ 提示参数该填哪一栏', () => {
    const probe = fakeProbe()
    const problem = preflightStdioServer(
      { transport: 'stdio', command: 'C:\\Program Files\\node.exe -v', args: [] },
      probe,
    )
    assert.match(problem, /command 里似乎写了多个 token/)
  })

  it('没问题时返回 null；非 stdio 直接 null', () => {
    const probe = fakeProbe({ executables: ['python'], paths: ['C:\\ok\\server.py', 'C:\\ok'] })
    assert.equal(
      preflightStdioServer(
        { transport: 'stdio', command: 'python', args: ['C:\\ok\\server.py'], cwd: 'C:\\ok' },
        probe,
      ),
      null,
    )
    assert.equal(preflightStdioServer({ transport: 'streamable-http', url: 'https://x' }, probe), null)
    assert.equal(preflightStdioServer(null, probe), null)
  })

  it('多个问题合并成一条', () => {
    const probe = fakeProbe()
    const problem = preflightStdioServer(
      { transport: 'stdio', command: 'ghost', args: ['C:\\a\\b.py'], cwd: 'C:\\nope' },
      probe,
    )
    assert.match(problem, /找不到可执行文件/)
    assert.match(problem, /脚本文件不存在/)
    assert.match(problem, /工作目录不存在/)
  })
})
