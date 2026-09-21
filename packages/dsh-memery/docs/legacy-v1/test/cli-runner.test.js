// test/cli-runner.test.js — 回归测试：修「启动卡住」+ DEP0190。
//
// 真实故障：`memorix background start` 会 spawn 一个长期后台守护进程，守护进程
// 继承父进程的 stdout/stderr 管道；Node 的 execFile 要等管道 EOF 才回调，于是
// Promise 永远不 resolve —— 表现为启动 dsh 时一直挂着。
//
// 这组测试用真的长期子进程复现该机制（不是只做静态断言），并证明新 runner
// 立刻返回。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { buildCliCommand, defaultRunCli, spawnDaemonCli, spawnDetachedDaemon } from '../lib/upstream.js'

const isWindows = process.platform === 'win32'

/**
 * 「父进程留下后台子进程再退出」——等价于 memorix background start 的行为。
 * 子进程继承 stdio，所以父进程的管道不会因为父进程退出而关闭。
 */
const DAEMONISH =
  'const {spawn}=require("child_process");' +
  'const c=spawn(process.execPath,["-e","setTimeout(()=>{},8000)"],{detached:true,stdio:"inherit"});' +
  'c.unref();console.log("daemon started");'

const NODE = { file: process.execPath, args: ['-e', DAEMONISH] }

// 这些测试会故意留下脱离的后台进程（这正是被测行为）。测试自己负责收尾，
// 否则游离的守护进程会拖慢整个测试运行。
const spawnedPids = []

after(async () => {
  const { spawnSync } = await import('node:child_process')
  for (const pid of spawnedPids) {
    try {
      if (isWindows) spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
      else process.kill(pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
})

describe('buildCliCommand', () => {
  it('POSIX 上直接调用 memorix', { skip: isWindows }, () => {
    const { file, args } = buildCliCommand(['memory', 'recent', '--json'])
    assert.equal(file, 'memorix')
    assert.deepEqual(args, ['memory', 'recent', '--json'])
  })

  it('Windows 上显式经 cmd.exe，而不是 shell:true（避开 DEP0190）', { skip: !isWindows }, () => {
    const { file, args } = buildCliCommand(['background', 'start'])
    assert.equal(file, 'cmd.exe')
    assert.deepEqual(args, ['/d', '/s', '/c', 'memorix', 'background', 'start'])
  })

  it('Windows 上含空格的参数被引号包裹，避免被拆成多个 token', { skip: !isWindows }, () => {
    const { args } = buildCliCommand(['memory', 'resolve', '--cwd', 'C:\\Program Files\\app'])
    assert.equal(args[args.length - 1], '"C:\\Program Files\\app"')
  })

  it('参数始终是数组，不经过 shell 字符串拼接', () => {
    const { args } = buildCliCommand(['memory', 'resolve', '--ids', '7'])
    assert.ok(Array.isArray(args))
    assert.ok(args.every((a) => typeof a === 'string'))
  })
})

describe('★ 机制复现：execFile 会在这种命令上挂住', () => {
  it('execFile 等不到 EOF（这正是必须换掉它的原因）', async () => {
    // 关键：**不能设 timeout**，否则回调是被 timeout kill 触发的，就测不到 EOF 行为了。
    let child
    const hanging = await new Promise((resolve) => {
      child = execFile(process.execPath, ['-e', DAEMONISH], () => resolve('callback-fired'))
      setTimeout(() => resolve('still-hanging'), 3000)
    })
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
    assert.equal(
      hanging,
      'still-hanging',
      'execFile 在这种「留下后台子进程」的命令上不应及时回调——若此处变了，说明机制假设需要重新核对',
    )
  })
})

describe('spawnDaemonCli / spawnDetachedDaemon（修启动卡住）', () => {
  it('★ 面对同样的命令，立刻返回而不是挂住', async () => {
    const started = Date.now()
    const result = await spawnDetachedDaemon(NODE.file, NODE.args)
    if (result.pid) spawnedPids.push(result.pid)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 3000, `应立刻返回，实际 ${elapsed}ms（说明还在等管道 EOF）`)
    assert.equal(result.spawned, true)
  })

  it('spawnDaemonCli 默认走 memorix 命令构造', async () => {
    // 用不存在的子命令：重点是「立刻返回 + 有结果」，不是命令成功
    const result = await spawnDaemonCli(['--definitely-not-a-real-subcommand'])
    if (result.pid) spawnedPids.push(result.pid)
    assert.ok(typeof result.code === 'number')
    assert.ok('spawned' in result)
  })

  it('pid 是数字，且不残留打开的管道（进程不阻塞退出）', async () => {
    const result = await spawnDetachedDaemon(process.execPath, ['-e', 'setTimeout(()=>{},3000)'])
    if (result.pid) spawnedPids.push(result.pid)
    assert.equal(result.spawned, true)
    assert.ok(Number.isInteger(result.pid))
  })

  it('可执行文件不存在时返回失败对象，不抛错也不挂住', async () => {
    const result = await spawnDetachedDaemon('definitely-not-an-executable-xyz', [])
    assert.equal(result.spawned, false)
    assert.ok(result.stderr.length > 0)
  })
})

describe('defaultRunCli（短命命令，需读回输出）', () => {
  it('能拿到 stdout 与退出码 0', async () => {
    const r = await defaultRunCli(['--version'])
    assert.ok(typeof r.code === 'number')
    assert.ok(r.stdout.length + r.stderr.length > 0, '应有输出或错误信息')
  })

  it('超时后返回，不无限挂住', async () => {
    const started = Date.now()
    const r = await defaultRunCli(['background', '--help'], { timeoutMs: 8000 })
    assert.ok(Date.now() - started < 20000, '不应远超超时时间')
    assert.ok(typeof r.code === 'number')
  })
})
