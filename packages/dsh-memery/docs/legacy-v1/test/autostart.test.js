// test/autostart.test.js — 控制面自动拉起：面板不该要求用户先去终端敲命令。
//
// 三条约束：只在确认不可达时启动；并发/重复请求不重复 spawn；启动失败如实报错。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAutoStarter } from '../lib/autostart.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('createAutoStarter', () => {
  it('控制面已可用时不启动', async () => {
    let started = 0
    const starter = createAutoStarter({
      start: async () => {
        started += 1
        return { code: 0 }
      },
    })
    const r = await starter.ensureUp({ isUp: async () => true, host: 'http://x' })
    assert.equal(r.state, 'up')
    assert.equal(started, 0)
  })

  it('不可达时启动一次，然后探活转为 up', async () => {
    let started = 0
    let up = false
    const starter = createAutoStarter({
      start: async () => {
        started += 1
        up = true
        return { code: 0 }
      },
      probeIntervalMs: 1,
      probeTimeoutMs: 40,
    })
    const r = await starter.ensureUp({ isUp: async () => up, host: 'http://x' })
    assert.equal(r.state, 'up')
    assert.equal(started, 1)
  })

  it('同一 host 的并发请求只 spawn 一次', async () => {
    let started = 0
    const starter = createAutoStarter({
      start: async () => {
        started += 1
        await sleep(20)
        return { code: 0 }
      },
      probeIntervalMs: 1,
      probeTimeoutMs: 20,
    })
    await Promise.all([
      starter.ensureUp({ isUp: async () => false, host: 'http://y' }),
      starter.ensureUp({ isUp: async () => false, host: 'http://y' }),
      starter.ensureUp({ isUp: async () => false, host: 'http://y' }),
    ])
    assert.equal(started, 1)
  })

  it('启动后仍探不到 → failed 且带原因，不假装成功', async () => {
    const starter = createAutoStarter({
      start: async () => ({ code: 0 }),
      probeIntervalMs: 1,
      probeTimeoutMs: 15,
    })
    const r = await starter.ensureUp({ isUp: async () => false, host: 'http://z' })
    assert.equal(r.state, 'failed')
    assert.match(r.error, /超时|未就绪/)
  })

  it('CLI 非零退出 → failed 且带 stderr', async () => {
    const starter = createAutoStarter({
      start: async () => ({ code: 1, stderr: 'memorix: command not found' }),
      probeIntervalMs: 1,
      probeTimeoutMs: 10,
    })
    const r = await starter.ensureUp({ isUp: async () => false, host: 'http://w' })
    assert.equal(r.state, 'failed')
    assert.match(r.error, /command not found/)
  })

  it('启动函数抛错被吞成 failed，不冒泡到请求处理', async () => {
    const starter = createAutoStarter({
      start: async () => {
        throw new Error('spawn ENOENT')
      },
      probeIntervalMs: 1,
      probeTimeoutMs: 10,
    })
    const r = await starter.ensureUp({ isUp: async () => false, host: 'http://v' })
    assert.equal(r.state, 'failed')
    assert.match(r.error, /ENOENT/)
  })

  it('冷却期内不重复 spawn', async () => {
    let started = 0
    const starter = createAutoStarter({
      start: async () => {
        started += 1
        return { code: 1, stderr: 'boom' }
      },
      probeIntervalMs: 1,
      probeTimeoutMs: 5,
      cooldownMs: 10000,
    })
    await starter.ensureUp({ isUp: async () => false, host: 'http://c' })
    const second = await starter.ensureUp({ isUp: async () => false, host: 'http://c' })
    assert.equal(started, 1, '第二次不该再 spawn')
    assert.equal(second.state, 'failed')
  })
})
