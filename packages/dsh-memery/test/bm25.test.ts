// BM25 检索测试。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, docOf, scoreAll, search, extractKeywords } from '../src/bm25.js'

describe('tokenize', () => {
  it('中文 bigram', () => {
    const t = tokenize('记忆插件')
    assert.ok(t.includes('记忆'))
    assert.ok(t.includes('忆插'))
    assert.ok(t.includes('插件'))
  })

  it('英文词保留、纯数字丢弃', () => {
    const t = tokenize('sqlite database 2026')
    assert.ok(t.includes('sqlite'))
    assert.ok(t.includes('database'))
    assert.ok(!t.includes('2026'))
  })

  it('空字符串返回空', () => {
    assert.deepEqual(tokenize(''), [])
  })
})

function idRow(id: string, content: string, kw: string[] = [], importance = 1, updatedAt = Date.now()) {
  return { id, content, keywords: kw, importance, updated_at: updatedAt, title: null }
}

describe('scoreAll', () => {
  const now = Date.now()
  const docs = [
    { id: 'a', ...docOf(idRow('a', 'sqlite 记忆库文件存储', ['sqlite'])) },
    { id: 'b', ...docOf(idRow('b', '前端样式表注入避免卸载失效', ['css'])) },
    { id: 'c', ...docOf(idRow('c', 'sqlite 数据库锁与并发写入', ['sqlite'])) },
  ]
  const hits = scoreAll(tokenize('sqlite'), docs, undefined, now)

  it('query 命中 sqlite 的两条排前面，未命中排最后', () => {
    assert.equal(hits.length, 2, '只有含 sqlite 的文档得分 > 0')
    assert.ok(hits.every((h) => h.id === 'a' || h.id === 'c'))
  })

  it('空查询返回空', () => {
    assert.deepEqual(scoreAll([], docs), [])
  })
})

describe('search', () => {
  it('按关键词字段精确优先 + BM25 全文', () => {
    const rows = [idRow('1', '一次普通对话'), idRow('2', '配置了日志轮转', ['日志轮转', '日志'])]
    const r = search(rows, '日志')
    assert.ok(r.length >= 1)
    assert.equal(r[0].row.id, '2', 'keywords 精确命中应排最前')
  })

  it('importance 加权：高 importance 的同分文档靠前', () => {
    const rows = [idRow('lo', '数据库锁定策略', ['数据库']), idRow('hi', '数据库锁定策略', ['数据库'], 4)]
    const r = search(rows, '数据库锁定')
    assert.ok(r.length === 2)
    assert.equal(r[0].row.id, 'hi')
  })

  it('topK 截断', () => {
    const rows = [idRow('1', 'aaa bbb'), idRow('2', 'aaa ccc'), idRow('3', 'aaa ddd')]
    const r = search(rows, 'aaa', { topK: 2 })
    assert.equal(r.length, 2)
  })
})

describe('extractKeywords', () => {
  it('bigram 词频提取', () => {
    const kw = extractKeywords('记忆插件记忆插件记忆库', 5)
    assert.ok(kw.includes('记忆'))
    assert.ok(kw.includes('插件'))
  })

  it('n 上限', () => {
    assert.ok(extractKeywords('一二三四五六七八九十', 3).length <= 3)
  })
})
