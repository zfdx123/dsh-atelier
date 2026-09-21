/**
 * dsh-memery — BM25 关键词检索。
 *
 * 中文没有空格分词，用 bigram（相邻两字）打底；英文按词切分。
 * 条目关键词（keywords 列，写入时自动 bigram 提取或 LLM 提供）与全文
 * 一起参与打分——关键词是命中锚点，全文补召回。
 *
 * 打分 = 词频 × idf × 覆盖率 × 近期权重 × importance 权重。
 */

export interface Tokenizable {
  keywords?: string[]
  content?: string
  title?: string | null
  importance?: number
  updated_at?: number
}

/** bigram 分词：中文相邻两字 + 英文单词；去纯数字与单个占位符。 */
export function tokenize(text: string): string[] {
  const cleaned = String(text ?? '').toLowerCase()
  const out = new Set<string>()
  // 英文/数字词
  for (const m of cleaned.matchAll(/[a-z0-9_]+/g)) {
    const w = m[0]
    if (/^[0-9]+$/.test(w)) continue
    out.add(w)
  }
  // 中文 bigram
  const cjk = cleaned.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) {
    out.add(cjk.slice(i, i + 2))
  }
  return [...out]
}

export interface RankedHit {
  id: string
  score: number
}

interface DocIndex {
  tokens: string[]
  content: string
  keywords: string[]
  importance: number
  updatedAt: number
}

function normalize(seen: Set<string>): string[] {
  return [...seen].sort()
}

/** 把一条记忆建成检索文档。 */
export function docOf(row: Tokenizable): DocIndex {
  const tokens = new Set<string>()
  const kw = (row.keywords ?? []).map((k) => String(k).toLowerCase())
  const title = row.title ? String(row.title).toLowerCase() : ''
  const content = String(row.content ?? '').toLowerCase()
  for (const t of tokenize(title)) tokens.add(t)
  for (const t of tokenize(content)) tokens.add(t)
  for (const k of kw) tokens.add(k)
  return {
    tokens: normalize(tokens),
    content,
    keywords: kw,
    importance: row.importance ?? 1,
    updatedAt: row.updated_at ?? 0,
  }
}

const K1 = 1.5
const B = 0.75
const IMPORTANCE_WEIGHT = 0.25
const RECENCY_HALF_LIFE_MS = 30 * 86_400_000 // 30 天半衰

/**
 * 对给定查询排序文档。纯函数便于测试。
 * @param queryTokens 查询分词
 * @param docs 待排文档（docOf 产物）
 * @param avgLen 平均长度，0 时用当前集合
 */
export function scoreAll(
  queryTokens: string[],
  docs: Array<DocIndex & { id: string }>,
  avgLen?: number,
  now = Date.now(),
): RankedHit[] {
  const q = [...new Set(queryTokens)]
  if (q.length === 0) return []
  const count = docs.length
  if (count === 0) return []
  const avg = avgLen !== undefined && avgLen > 0 ? avgLen : docs.reduce((s, d) => s + d.tokens.length, 0) / count

  const df = (term: string): number => docs.reduce((n, d) => (d.tokens.includes(term) ? n + 1 : n), 0)
  const idf = (term: string): number => {
    const f = df(term)
    return Math.log(1 + (count - f + 0.5) / (f + 0.5))
  }

  const out: RankedHit[] = docs.map((doc) => {
    let score = 0
    let termHits = 0
    for (const term of q) {
      if (!doc.tokens.includes(term)) continue
      let tf = 0
      for (const t of doc.tokens) if (t === term) tf++
      const contentHits = (doc.content.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
      const kwHits = doc.keywords.filter((k) => k === term).length
      tf += contentHits + kwHits * 2
      score += idf(term) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.tokens.length / avg))))
      termHits++
    }
    if (termHits === 0) return { id: doc.id as string, score: 0 }
    // 覆盖率：命中的查询词占比
    const coverage = termHits / q.length
    // 近期权重
    const age = Math.max(0, now - doc.updatedAt)
    const recency = Math.pow(0.5, age / RECENCY_HALF_LIFE_MS)
    // importance 加成
    const imp = 1 + (doc.importance - 1) * IMPORTANCE_WEIGHT
    const final = score * (0.5 + 0.5 * coverage) * recency * imp
    return { id: doc.id as string, score: final }
  })

  return out.filter((h) => h.score > 0).sort((a, b) => b.score - a.score)
}

/** 便捷入口：对 MemoryRow[] 排序。 */
export function search<T extends Tokenizable & { id: string }>(
  rows: T[],
  query: string,
  opts: { topK?: number } = {},
): Array<{ row: T; score: number }> {
  const docs = rows.map((r) => ({ id: r.id, ...docOf(r) }))
  const q = tokenize(query)
  const hits = scoreAll(q, docs, undefined)
  const top = opts.topK !== undefined ? hits.slice(0, opts.topK) : hits
  const byId = new Map(rows.map((r) => [r.id, r]))
  return top.map((h) => ({ row: byId.get(h.id)!, score: h.score })).filter((x) => x.row !== undefined)
}

/** 默认关键词提取：bigram 词频 top N。 */
export function extractKeywords(content: string, n = 10): string[] {
  const freq = new Map<string, number>()
  for (const t of tokenize(content)) {
    freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t)
}
