// dsh-skills-manager — pure logic layer (no I/O, no Cordis).
//
// 这里放的全部是纯函数：一个 SKILL.md 文本进，结构化的字段/诊断出；一个
// 字段补丁进，一段新的 frontmatter 文本出。宿主侧（index.js）与测试都只
// 通过这一层来理解技能文件，因此「怎么算合法」只有一处实现。
//
// ## 为什么自己解析 frontmatter
//
// DSH 官方 provider（@deepseek-ai/dsh-skill-filesystem）用 `yaml` 包解析，
// 但那个包不在 web profile 的解析路径上；而本插件要在**不新增依赖**的前提下
// 工作。更关键的是，管理器的价值有很大一块是「诊断」：官方 provider 遇到坏
// frontmatter 只会 `logger.warn` 然后**静默跳过**这个技能，模型侧完全看不出
// 「技能不存在」和「技能写坏了」的区别。所以这里实现一个**严格对齐官方语法**
// 的读取器，把官方吞掉的信息变成可展示的 issue。
//
// 对齐依据（读自 dsh-skill/lib/index.js 与 dsh-skill-filesystem/lib/index.js）：
//   - 名字语法  SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
//   - 必填      name、description（都必须是长度 > 0 的字符串）
//   - 可选项    whenToUse（字符串）、metadata（对象）
//   - 开关      disable-model-invocation / user-invocable
//   - 布尔语法  boolean | 1 | 0 | "1" | "0" | true/false/yes/no/on/off（大小写不敏感）
//   - 遗留键    disableModelInvocation / modelInvocable / userInvocable → 整条技能被丢弃
//   - 未知键    被忽略（不报错）——所以本插件对未知键只提示、绝不删
//
// ## 保真原则（很重要）
//
// 用户的 SKILL.md 是手写文档，注释和键顺序都是他们的。因此：
//   1. 只改正文时 → frontmatter 块**逐字节保留**，只替换 `---` 之后的部分。
//   2. 改单个字段时 → 只重写那一行（或插入缺失的行），其余行原样不动。
//   3. 只有显式要求「整块重写」时才重新序列化 frontmatter。
// 任何会丢失未知键或注释的写操作都不做。

/** 官方技能名语法（与 dsh-skill 的 SKILL_NAME 完全一致）。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 被官方明确拒绝的遗留开关键：出现即整条技能被丢弃。 */
const LEGACY_INVOCATION_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable']

/** frontmatter 里被本插件识别并结构化展示的键。 */
const KNOWN_KEYS = ['name', 'description', 'whenToUse', 'metadata', 'disable-model-invocation', 'user-invocable']

/** 单个字段值的软上限：超过就截断展示，避免前端被巨型描述拖死。 */
const MAX_DESCRIPTION_CHARS = 800

/** 单个技能文件的硬上限：超过拒绝读取（防呆，不是安全边界）。 */
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024

// ───────────────────────────────────────────────────────────────────────────
// 基础类型判定与规范化
// ───────────────────────────────────────────────────────────────────────────

/**
 * 判断名字是否符合官方 kebab-case 语法。
 * @param {unknown} value 候选名字
 * @returns {boolean} 是否合法
 */
export function isSkillName(value) {
  return typeof value === 'string' && SKILL_NAME.test(value)
}

/**
 * 把任意输入规范化成一个可用的技能名：小写、非字母数字一律折叠成单个 `-`、
 * 去掉首尾 `-`。用于「从描述生成建议名字」这类辅助场景，不用于校验。
 * @param {unknown} value 原始输入
 * @returns {string} 规范化后的名字（可能为空串）
 */
export function slugifySkillName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 按官方语法解析一个 frontmatter 布尔值。
 * @param {unknown} value 原始值（来自 YAML 或字符串）
 * @returns {{ok: true, value: boolean} | {ok: false, value: undefined}} 解析结果
 */
export function parseFrontmatterBoolean(value) {
  if (typeof value === 'boolean') return { ok: true, value }
  if (value === 1 || value === '1') return { ok: true, value: true }
  if (value === 0 || value === '0') return { ok: true, value: false }
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return { ok: true, value: true }
      case 'false':
      case 'no':
      case 'off':
        return { ok: true, value: false }
      default:
        break
    }
  }
  return { ok: false, value: undefined }
}

/**
 * 从原始字段值解析出调用策略，等价于官方 parseInvocationPolicy。
 * @param {Record<string, unknown>} data 已解析的 frontmatter 顶层键值
 * @returns {{modelInvocable: boolean, userInvocable: boolean, legacy: string[], invalid: string[]}}
 *   modelInvocable=false 表示对模型隐藏；userInvocable=false 表示对 `/` 命令隐藏。
 */
export function resolveInvocation(data) {
  const legacy = LEGACY_INVOCATION_KEYS.filter((key) => Object.hasOwn(data, key))
  const invalid = []
  let disableModelInvocation
  let userInvocable
  if (Object.hasOwn(data, 'disable-model-invocation')) {
    const parsed = parseFrontmatterBoolean(data['disable-model-invocation'])
    if (parsed.ok) disableModelInvocation = parsed.value
    else invalid.push('disable-model-invocation')
  }
  if (Object.hasOwn(data, 'user-invocable')) {
    const parsed = parseFrontmatterBoolean(data['user-invocable'])
    if (parsed.ok) userInvocable = parsed.value
    else invalid.push('user-invocable')
  }
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
    legacy,
    invalid,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// frontmatter 切块
// ───────────────────────────────────────────────────────────────────────────

/**
 * 定位文件开头的 `---` frontmatter 块，给出**行号**（1 基），供后续做行级手术。
 * 只认文件第一行就是 `---` 的形式，与官方 findClosingFrontmatter 一致。
 * @param {string} text 整个技能文件文本
 * @returns {{openLine: number, closeLine: number, bodyStartLine: number} | null} 行号定位
 */
export function locateFrontmatter(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  if (lines.length === 0 || lines[0].replace(/\s+$/, '') !== '---') return null
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/\s+$/, '') === '---') {
      return { openLine: 1, closeLine: index + 1, bodyStartLine: index + 2 }
    }
  }
  return null
}

/**
 * 取出 frontmatter 原文（不含两端的 `---`）与正文。
 * @param {string} text 整个技能文件文本
 * @returns {{frontmatter: string | null, body: string, location: object | null}}
 */
export function splitSkillText(text) {
  const source = String(text ?? '')
  const location = locateFrontmatter(source)
  if (location === null) return { frontmatter: null, body: source, location: null }
  const lines = source.split(/\r?\n/)
  const frontmatter = lines.slice(location.openLine, location.closeLine - 1).join('\n')
  const body = lines.slice(location.bodyStartLine - 1).join('\n')
  return { frontmatter, body, location }
}

// ───────────────────────────────────────────────────────────────────────────
// frontmatter 读取器（官方语法子集 + 精确诊断）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 读取一个 YAML 块标量（`key: |` / `key: >` 及其 chomping 变体）的内容。
 *
 * - `|` 字面块：换行原样保留（折叠内部空行为一个换行，与 YAML 语义一致）；
 * - `>` 折叠块：连续的普通行折成一个空格，空行变成换行（段落分隔）。
 *
 * 缩进由第一条非空行决定；结尾按 chomping 处理（默认 clip → 去掉尾部换行，
 * `-` strip 同理，`+` keep 保留）。返回值统一去掉尾部空白——技能描述不需要结尾换行。
 *
 * @param {string[]} lines frontmatter 的所有行
 * @param {number} start 块内容起始下标（0 基），即 key 行的下一行
 * @param {number} end 块结束下标（不含）
 * @param {string} marker 标记本体（如 `|`、`>-`、`|+`）
 * @returns {string} 解析后的多行文本
 */
function readBlockScalar(lines, start, end, marker) {
  const folded = marker.startsWith('>')
  const keep = marker.includes('+')
  const content = lines.slice(start, Math.max(start, end))
  // 缩进 = 第一条非空行的前导空格数
  let indent = null
  for (const line of content) {
    if (line.trim() === '') continue
    indent = line.length - line.trimStart().length
    break
  }
  if (indent === null) return ''
  const stripped = content.map((line) => (line.trim() === '' ? '' : line.slice(indent)))
  // 去掉尾部空行（chomping 的默认 clip 行为）
  let last = stripped.length
  while (last > 0 && stripped[last - 1] === '') last -= 1
  const body = stripped.slice(0, last)
  if (!folded) {
    const text = body.join('\n')
    return keep ? `${text}\n` : text.replace(/\s+$/, '')
  }
  // 折叠：连续非空行用空格连接，空行转成换行。
  let out = ''
  let pendingBlank = 0
  for (const line of body) {
    if (line === '') {
      pendingBlank += 1
      continue
    }
    if (out !== '') {
      out += pendingBlank === 0 ? ' ' : '\n'.repeat(pendingBlank)
    }
    out += line
    pendingBlank = 0
  }
  return out.replace(/\s+$/, '')
}

// ───────────────────────────────────────────────────────────────────────────
// frontmatter 读取器（官方语法子集 + 精确诊断）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 去掉 YAML 双引号/单引号标量外层的引号并反转义。
 * @param {string} raw 引号包裹的原文
 * @returns {string} 反转义后的值
 */
function unquoteScalar(raw) {
  const quote = raw[0]
  const inner = raw.slice(1, -1)
  if (quote === "'") return inner.replace(/''/g, "'")
  return inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

/**
 * 解析 YAML 标量（够用就好：引号串、布尔、null、数字、裸串）。
 * @param {string} raw 冒号右侧原文
 * @returns {{kind: 'string'|'boolean'|'number'|'null', value: unknown}} 解析结果
 */
function parseScalar(raw) {
  const text = raw.trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return { kind: 'string', value: unquoteScalar(text) }
    }
  }
  const lower = text.toLowerCase()
  if (lower === 'true' || lower === 'false') return { kind: 'boolean', value: lower === 'true' }
  if (lower === 'null' || lower === '~' || text === '') return { kind: 'null', value: null }
  const boolish = parseFrontmatterBoolean(text)
  // 'yes'/'on'/'1' 在 YAML 1.1 里是布尔；官方 frontmatterBoolean 也接受它们，
  // 但对非开关字段保守处理：只有 0/1 当成数字，yes/on 保留字面串。
  if (/^-?\d+$/.test(text)) return { kind: 'number', value: Number(text) }
  if (boolish.ok && (text === '1' || text === '0')) return { kind: 'number', value: Number(text) }
  // 注意：`3.0.0` 这类版本号**不能**当数字（Number() 会得到 NaN，把值弄丢）。
  return { kind: 'string', value: text }
}

/**
 * 在 `key:` 行上按引号配对找出顶层冒号的位置，避免被 `description: "a: b"` 骗到。
 * @param {string} text 去掉缩进的一行
 * @returns {{key: string, rest: string} | null} 拆分结果
 */
function splitKeyValue(text) {
  let quote = ''
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    else if (char === ':' && depth === 0) {
      const key = text.slice(0, index).trim()
      const rest = text.slice(index + 1)
      if (key === '') return null
      // 只有 `key:` 后面是空白或行尾才算键值分隔，`http://x` 不算。
      if (rest.length > 0 && !/^\s/.test(rest)) continue
      return { key, rest }
    }
  }
  return null
}

/**
 * 解析一段 frontmatter 文本，产出结构化字段、行号索引与解析诊断。
 *
 * 实现 DSH 技能真正用到的 YAML 子集：顶层标量映射、`metadata:` 下一层映射、
 * **块标量**（`|` `>` 及其 `-`/`+` chomping 变体）与**序列**（`- item`）。
 * 这几样是社区技能里最常见的写法；不支持它们就会把好技能误判成「DSH 会跳过」——
 * 而 DSH 用的是真正的 YAML 解析器，本来完全能读。
 *
 * 其余不认识的语法（锚点、多行流式等）**仍然不猜**：记一条 issue、把该键标为 raw，
 * 写回时逐字节保留。
 *
 * @param {string | null} frontmatter 两个 `---` 之间的原文
 * @returns {{data: Record<string, unknown>, keyLines: Record<string, {start: number, end: number}>, rawKeys: string[], issues: Array<{level: string, key: string, message: string}>}}
 *   keyLines 行号相对 frontmatter 块内（1 基，1 = 第一行 frontmatter 内容）。
 */
export function parseFrontmatter(frontmatter) {
  const data = {}
  const keyLines = {}
  const rawKeys = []
  const issues = []
  if (frontmatter === null || frontmatter === undefined) {
    return { data, keyLines, rawKeys, issues }
  }
  const lines = String(frontmatter).split(/\r?\n/)
  // 注意：如果没有结尾换行，最后一行仍然要在扫描范围内。split 产出的末元素
  // 既是「最后一行内容」又是「块结束位置」——用 lines.length + 1 会让扫描循环
  // 取不到它，导致最后一行被静默丢掉（嵌套映射因此被误判成成功解析）。
  const linesLength = lines.length

  /** 找出 key 行之后所有缩进更深的行，作为它的归属范围。 */
  const blockEnd = (start, indent) => {
    let end = start
    // pending 记录「已看到但还没确认归属」的空行：只有后面真的跟着更深缩进的
    // 行时，它们才算这个键的一部分。否则键的范围必须停在最后一个有内容的行，
    // 不然删除/替换会把文件里原本的空行一起吃掉。
    let pending = 0
    for (let index = start; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() === '') {
        pending += 1
        continue
      }
      const current = line.length - line.trimStart().length
      if (current <= indent) break
      end = index + 1
      pending = 0
    }
    return end
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()
    index += 1
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const pair = splitKeyValue(line.trimStart())
    if (pair === null) {
      if (indent === 0) {
        issues.push({
          level: 'warn',
          key: '',
          message: `无法识别的 frontmatter 行（第 ${index} 行），已原样保留：${trimmed.slice(0, 80)}`,
        })
        rawKeys.push(`#line-${index}`)
      }
      continue
    }
    const { key, rest } = pair
    const value = rest.trim()
    const startLine = index
    const endLine = blockEnd(index, indent)
    if (indent !== 0) continue // 只把顶层键暴露给调用方；嵌套内容由父键负责。

    if (value === '') {
      // 可能是嵌套映射、序列，也可能是空值；按子行内容判断。
      const childLines = lines
        .slice(index, endLine)
        .filter((entry) => entry.trim() !== '' && !entry.trim().startsWith('#'))
      if (childLines.length === 0) {
        data[key] = null
        keyLines[key] = { start: startLine, end: endLine }
        continue
      }
      const childIndent = Math.min(...childLines.map((entry) => entry.length - entry.trimStart().length))
      if (childIndent <= indent) {
        data[key] = null
        keyLines[key] = { start: startLine, end: endLine }
        continue
      }
      // 子行以 `- ` 开头（或就是 `-`）→ 序列。社区技能里 keywords: / tags: 都是这种。
      if (childLines.every((entry) => /^-(?:\s|$)/.test(entry.trim()) || entry.trim() === '')) {
        const list = []
        let listOk = true
        for (const entry of childLines) {
          const item = entry.trim().replace(/^-\s*/, '')
          const itemPair = splitKeyValue(item)
          if (itemPair !== null) {
            listOk = false
            break
          } // `- key: value` 对象序列超出范围
          list.push(parseScalar(item).value)
        }
        if (listOk) {
          data[key] = list
          keyLines[key] = { start: startLine, end: endLine }
          continue
        }
      }
      const object = {}
      let childIndex = index
      let childOk = true
      // 子级的缩进基准 = 第一条非空子行的缩进。比它更深 / 更浅的行都不属于这一层：
      // 更深说明遇到了嵌套子映射（超出读取范围），更浅说明父键的块已经结束。
      // 曾经漏了这条判断，于是 `weird:\n  child:\n    grandchild: 1` 被错读成
      // `{child: null, grandchild: 1}` —— 把孙级当成子级。
      let siblingIndent = null
      while (childIndex < linesLength) {
        const childLine = lines[childIndex]
        if (childLine === undefined) break
        if (childLine.trim() === '' || childLine.trim().startsWith('#')) {
          childIndex += 1
          continue
        }
        const currentIndent = childLine.length - childLine.trimStart().length
        if (currentIndent <= indent) break
        if (siblingIndent === null) siblingIndent = currentIndent
        if (currentIndent !== siblingIndent) {
          childOk = false
          break
        }
        childIndex += 1
        const childPair = splitKeyValue(childLine.trimStart())
        if (childPair === null) {
          childOk = false
          break
        }
        const parsedChild = parseScalar(childPair.rest)
        if (parsedChild.kind === 'null' && childPair.rest.trim() !== '' && !/^(null|~)$/i.test(childPair.rest.trim())) {
          childOk = false
          break
        }
        object[childPair.key] = parsedChild.value
      }
      if (childOk) {
        data[key] = object
      } else {
        rawKeys.push(key)
        issues.push({
          level: 'info',
          key,
          message: `"${key}" 的嵌套结构超出本插件的读取范围，将原样保留（不影响 DSH 加载）`,
        })
      }
      keyLines[key] = { start: startLine, end: endLine }
      continue
    }

    // 块标量：`|` 保留换行、`>` 折叠成空格；`-` 去掉结尾换行、`+` 保留全部。
    // 这是社区技能里最常用的 description 写法（多行说明），必须支持，否则会把
    // 完全正常的技能误报成「description 缺失 → DSH 会跳过」。
    if (/^[|>][+-]?\d*$/.test(value)) {
      data[key] = readBlockScalar(lines, index, endLine, value)
      keyLines[key] = { start: startLine, end: endLine }
      continue
    }

    const parsed = parseScalar(value)
    data[key] = parsed.value
    keyLines[key] = { start: startLine, end: endLine }
  }

  return { data, keyLines, rawKeys, issues }
}

// ───────────────────────────────────────────────────────────────────────────
// frontmatter 序列化 / 行级手术
// ───────────────────────────────────────────────────────────────────────────

/**
 * 把一个值序列化成 YAML 标量文本（需要时加双引号）。
 * @param {unknown} value 任意标量
 * @returns {string} YAML 文本
 */
export function formatScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  const text = String(value)
  // 需要引号的情形：空串、以 YAML 指示符或引号开头、含冒号/井号加空白、首尾空白、
  // 会被 YAML 读成布尔/null/数字，或含换行。少了任何一条，写出去的文件都读不回来。
  // 注意：字符类里的 `/` 必须转义，否则 JS 会在这里提前结束正则字面量，
  // 整条 needsQuote 变成另一个（错的）表达式，且文件本身仍然能解析。
  const needsQuote =
    text === '' ||
    /^[\s>|&*!%@`{}[\],#"'?\-/]/.test(text) ||
    /[:#]\s/.test(text) ||
    /\s$/.test(text) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(text) ||
    /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text) ||
    text.includes('\n')
  if (!needsQuote) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`
}

/**
 * 把结构化字段序列化成完整的 frontmatter 块（含两端 `---`）。
 * 顺序固定为 name → description → whenToUse → 开关 → metadata → 其它键，
 * 这样生成的技能文件与人工书写的习惯一致，diff 也稳定。
 * @param {Record<string, unknown>} fields 顶层字段
 * @returns {string} `---\n...\n---` 文本块
 */
export function serializeFrontmatter(fields) {
  const order = ['name', 'description', 'whenToUse', 'disable-model-invocation', 'user-invocable', 'metadata']
  const keys = [
    ...order.filter((key) => Object.hasOwn(fields, key) && fields[key] !== undefined),
    ...Object.keys(fields).filter((key) => !order.includes(key) && fields[key] !== undefined),
  ]
  const lines = ['---']
  for (const key of keys) {
    const value = fields[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${key}:`)
      for (const [childKey, childValue] of Object.entries(value)) {
        lines.push(`  ${childKey}: ${formatScalar(childValue)}`)
      }
      continue
    }
    if (Array.isArray(value)) {
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${formatScalar(item)}`)
      continue
    }
    lines.push(`${key}: ${formatScalar(value)}`)
  }
  lines.push('---')
  return lines.join('\n')
}

/**
 * 对 frontmatter 文本做**行级**字段补丁：已有键就地改行，缺失键在末尾追加，
 * 值为 `undefined` 表示删除该键。除被改动的行外，其余字节不动——注释、键顺序
 * 和本插件读不懂的结构都能活下来。
 * @param {string} frontmatter 两个 `---` 之间的原文
 * @param {Record<string, unknown>} patch 字段补丁（undefined = 删除）
 * @param {{keyLines: Record<string, {start: number, end: number}>, rawKeys: string[]}} parsed parseFrontmatter 的结果
 * @returns {{text: string, skipped: string[]}} 新 frontmatter 文本与被跳过的键
 */
export function patchFrontmatterLines(frontmatter, patch, parsed) {
  const lines = String(frontmatter ?? '').split(/\r?\n/)
  const skipped = []
  const removed = new Set()
  const replaced = new Map()

  for (const [key, value] of Object.entries(patch)) {
    // 读不懂的结构（多行标量等）一律不碰，原样保留。
    if (parsed.rawKeys.includes(key)) {
      skipped.push(key)
      continue
    }
    const range = parsed.keyLines[key]
    const drop = value === undefined || value === null
    if (range === undefined) {
      if (drop) continue // 没有这个键，无需删除
      continue // 记在 added 里，稍后追加
    }
    if (drop) {
      for (let line = range.start; line <= range.end; line += 1) removed.add(line)
      continue
    }
    replaced.set(range.start, { dropThrough: range.end, lines: renderFieldLines(key, value, 0) })
  }

  // 按原始顺序重建：未被改动的行逐字节保留（注释、顺序、空行都在原地），
  // 命中替换的行整体换成新渲染结果，命中删除的行整段丢弃。不做坐标运算，
  // 所以不存在「行号位移把空行插到中间」这类问题。
  const output = []
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    if (removed.has(lineNumber)) continue
    const replacement = replaced.get(lineNumber)
    if (replacement !== undefined) {
      output.push(...replacement.lines)
      for (let skip = lineNumber; skip < replacement.dropThrough; skip += 1) index += 1
      continue
    }
    output.push(lines[index])
  }
  // 尾部空行在 YAML 里没有语义，但删掉最后一个键后会留下一条——统一清掉，
  // 保证「改一行」不会顺带改变文件的观感。中间的空行一律保留。
  while (output.length > 0 && output[output.length - 1].trim() === '') output.pop()

  const added = []
  for (const [key, value] of Object.entries(patch)) {
    if (parsed.rawKeys.includes(key)) continue
    if (parsed.keyLines[key] !== undefined) continue
    if (value === undefined || value === null) continue
    added.push(...renderFieldLines(key, value, 0))
  }
  return { text: [...output, ...added].join('\n'), skipped }
}

/**
 * 把一个字段渲染成若干行（对象/数组展开成块）。
 * @param {string} key 键名
 * @param {unknown} value 值
 * @param {number} indent 缩进层级
 * @returns {string[]} 行数组
 */
function renderFieldLines(key, value, indent) {
  const pad = '  '.repeat(indent)
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const lines = [`${pad}${key}:`]
    for (const [childKey, childValue] of Object.entries(value)) {
      lines.push(`${pad}  ${childKey}: ${formatScalar(childValue)}`)
    }
    return lines
  }
  if (Array.isArray(value)) {
    const lines = [`${pad}${key}:`]
    for (const item of value) lines.push(`${pad}  - ${formatScalar(item)}`)
    return lines
  }
  return [`${pad}${key}: ${formatScalar(value)}`]
}

/**
 * 用新的 body 拼出完整文件文本：frontmatter 块逐字节保留。
 *
 * 正文两侧的换行要一刀切掉再自己补一个空行 —— 从文件里切出来的 body 天然带着
 * frontmatter 后的那个换行，若直接拼上去就会多出一个空行，于是「每次保存文件都
 * 长高一行」。这是 composeSkillText 必须自己负责的不变量。
 * @param {string | null} frontmatter 原 frontmatter 文本（不含 `---`）
 * @param {string} body 新正文
 * @returns {string} 完整文件文本
 */
export function composeSkillText(frontmatter, body) {
  const normalizedBody = String(body ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '')
  if (frontmatter === null || frontmatter === undefined) {
    return normalizedBody === '' ? '' : `${normalizedBody}\n`
  }
  const normalizedFrontmatter = String(frontmatter).replace(/\r\n/g, '\n').replace(/\s+$/, '')
  const separator = normalizedBody === '' ? '\n' : '\n\n'
  return `---\n${normalizedFrontmatter}\n---${separator}${normalizedBody}\n`
}

/**
 * 为一个技能生成 SKILL.md 全文（新建场景）。
 * @param {{name: string, description: string, whenToUse?: string, modelInvocable?: boolean, userInvocable?: boolean, metadata?: Record<string, unknown>, body?: string}} input 技能定义
 * @returns {string} 完整文件文本
 */
export function buildSkillFile(input) {
  const fields = { name: input.name, description: input.description }
  if (input.whenToUse) fields.whenToUse = input.whenToUse
  if (input.modelInvocable === false) fields['disable-model-invocation'] = true
  if (input.userInvocable === false) fields['user-invocable'] = false
  if (input.metadata && Object.keys(input.metadata).length > 0) fields.metadata = input.metadata
  const body = typeof input.body === 'string' && input.body.trim() !== '' ? input.body : defaultSkillBody(input)
  return composeSkillText(serializeFrontmatter(fields).split('\n').slice(1, -1).join('\n'), body)
}

/**
 * 新技能的默认正文骨架——故意留成可用的结构，而不是空白。
 * @param {{name: string, description: string}} input 技能定义
 * @returns {string} Markdown 正文
 */
export function defaultSkillBody(input) {
  return [
    `# ${input.name}`,
    '',
    input.description,
    '',
    '## 何时使用',
    '',
    '（写下触发条件：用户说了什么、任务长什么样时应当加载本技能。）',
    '',
    '## 步骤',
    '',
    '1. ',
    '',
    '## 细则',
    '',
    '- ',
    '',
  ].join('\n')
}

// ───────────────────────────────────────────────────────────────────────────
// 诊断（lint）：把官方 provider 静默吞掉的东西变成可见 issue
// ───────────────────────────────────────────────────────────────────────────

/**
 * 对一个技能文件做出完整诊断，判断它在 DSH 里到底会不会被加载。
 * @param {{text: string, name?: string, kind?: string}} input 文件文本与位置信息
 * @returns {{status: 'ok'|'warning'|'broken', fields: Record<string, unknown>, keyLines: Record<string, {start: number, end: number}>, rawKeys: string[], issues: Array<{level: 'error'|'warn'|'info', key: string, message: string}>, description: string, whenToUse: string | null, invocation: {modelInvocable: boolean, userInvocable: boolean}}}
 *   诊断结果；status=broken 意味着官方 provider 会跳过这个文件。
 */
export function lintSkillFile(input) {
  const text = String(input?.text ?? '')
  const issues = []
  const { frontmatter, location } = splitSkillText(text)

  if (location === null) {
    issues.push({
      level: 'error',
      key: '',
      message:
        frontmatter === null && text.trim() !== ''
          ? '文件开头没有 `---` frontmatter 块，DSH 会跳过这个技能'
          : '文件为空，DSH 会跳过这个技能',
    })
    return {
      status: 'broken',
      fields: {},
      keyLines: {},
      rawKeys: [],
      issues,
      description: '',
      whenToUse: null,
      invocation: { modelInvocable: true, userInvocable: true },
    }
  }

  const parsed = parseFrontmatter(frontmatter)
  issues.push(...parsed.issues)
  const data = parsed.data

  const name = data.name
  const description = data.description

  if (typeof name !== 'string' || name.length === 0) {
    issues.push({ level: 'error', key: 'name', message: '缺少必填字段 name，DSH 会跳过这个技能' })
  } else if (!isSkillName(name)) {
    issues.push({
      level: 'error',
      key: 'name',
      message: `name "${name}" 不是合法技能名：只能用小写字母、数字和单个连字符分段（例如 my-skill）`,
    })
  }
  if (typeof description !== 'string' || description.length === 0) {
    issues.push({ level: 'error', key: 'description', message: '缺少必填字段 description，DSH 会跳过这个技能' })
  } else if (description.length > MAX_DESCRIPTION_CHARS) {
    issues.push({
      level: 'warn',
      key: 'description',
      message: `description 长达 ${description.length} 字符：它会整条进入会话目录，过长会挤占上下文`,
    })
  }
  if (Object.hasOwn(data, 'whenToUse') && typeof data.whenToUse !== 'string') {
    issues.push({ level: 'warn', key: 'whenToUse', message: 'whenToUse 不是字符串，会被 DSH 忽略' })
  }
  if (
    Object.hasOwn(data, 'metadata') &&
    data.metadata !== null &&
    (typeof data.metadata !== 'object' || Array.isArray(data.metadata))
  ) {
    issues.push({ level: 'warn', key: 'metadata', message: 'metadata 不是键值对象，会被 DSH 忽略' })
  }

  const invocation = resolveInvocation(data)
  for (const key of invocation.legacy) {
    issues.push({
      level: 'error',
      key,
      message:
        `遗留字段 "${key}" 已不受支持，DSH 会整条丢弃本技能；请改用 ` +
        (key === 'userInvocable' ? 'user-invocable' : 'disable-model-invocation'),
    })
  }
  for (const key of invocation.invalid) {
    issues.push({ level: 'error', key, message: `"${key}" 必须是布尔值，DSH 会整条丢弃本技能` })
  }
  if (invocation.modelInvocable === false && invocation.userInvocable === false) {
    issues.push({
      level: 'warn',
      key: '',
      message: '模型与 `/` 命令都不可调用：这个技能没有任何入口，等于被禁用',
    })
  }
  if (location.bodyStartLine > 0) {
    const body = splitSkillText(text).body
    if (body.trim() === '') {
      issues.push({ level: 'warn', key: '', message: '正文为空：技能加载后模型只会看到 frontmatter' })
    }
  }
  for (const key of Object.keys(data)) {
    // rawKeys 里的键已经由 parseFrontmatter 给过更精确的提示，不要重复报。
    if (!KNOWN_KEYS.includes(key) && !parsed.rawKeys.includes(key)) {
      issues.push({ level: 'info', key, message: `未知字段 "${key}" 会被 DSH 忽略（本插件不会删除它）` })
    }
  }

  // 只有 error/warning 影响判决：info 是纯提示（例如「未知字段会被忽略」），
  // 一个完全健康的技能不该因为它被标成 warning。
  const status = issues.some((issue) => issue.level === 'error')
    ? 'broken'
    : issues.some((issue) => issue.level === 'warn')
      ? 'warning'
      : 'ok'

  return {
    status,
    fields: data,
    keyLines: parsed.keyLines,
    rawKeys: parsed.rawKeys,
    issues,
    description: typeof description === 'string' ? description : '',
    whenToUse: typeof data.whenToUse === 'string' ? data.whenToUse : null,
    invocation: { modelInvocable: invocation.modelInvocable, userInvocable: invocation.userInvocable },
  }
}

/**
 * 校验一次「写入意图」，在落盘前把错误挡住。返回空数组表示可以写。
 * @param {{name: string, description: string, whenToUse?: string, modelInvocable?: boolean, userInvocable?: boolean, body?: string, allowEmptyBody?: boolean}} input 待写入的技能
 * @returns {string[]} 人类可读的错误列表
 */
export function validateSkillInput(input) {
  const errors = []
  if (!isSkillName(input?.name)) {
    errors.push('技能名必须是 kebab-case：小写字母/数字，用单个连字符分段（例如 code-review）')
  }
  if (typeof input?.description !== 'string' || input.description.trim() === '') {
    errors.push('description 必填：它是技能在会话目录里唯一的一句话说明')
  }
  if (
    input?.description !== undefined &&
    typeof input.description === 'string' &&
    input.description.length > MAX_DESCRIPTION_CHARS
  ) {
    errors.push(`description 不能超过 ${MAX_DESCRIPTION_CHARS} 字符（当前 ${input.description.length}）`)
  }
  if (input?.whenToUse !== undefined && typeof input.whenToUse !== 'string') {
    errors.push('whenToUse 必须是字符串')
  }
  if (input?.body !== undefined && typeof input.body !== 'string') {
    errors.push('body 必须是字符串')
  }
  if (input?.body !== undefined && String(input.body).length > MAX_SKILL_FILE_BYTES) {
    errors.push('正文过大（超过 2MB）')
  }
  return errors
}

/**
 * 汇总一批技能的诊断，给面板顶部一个总览。
 * @param {Array<{status: string, name?: string}>} skills 技能条目
 * @returns {{total: number, ok: number, warning: number, broken: number, duplicates: number, shadowed: number}}
 */
export function summarize(skills) {
  const list = Array.isArray(skills) ? skills : []
  return {
    total: list.length,
    ok: list.filter((skill) => skill.status === 'ok').length,
    warning: list.filter((skill) => skill.status === 'warning').length,
    broken: list.filter((skill) => skill.status === 'broken').length,
    duplicates: list.filter((skill) => skill.duplicateOf !== undefined && skill.duplicateOf !== null).length,
    shadowed: list.filter((skill) => skill.shadowed === true).length,
  }
}

/**
 * 把「同名的多个副本」按遮蔽关系标注出来：rank 小者获胜（DSH 的就近层优先），
 * 其余副本标记 shadowed，并让每个副本都知道自己输给了谁。
 * @param {Array<{name: string, rank: number, order?: number}>} skills 技能条目（含 name/rank）
 * @returns {Array<object>} 补好 winner/shadowed/duplicateOf 字段的新数组
 */
export function markShadowed(skills) {
  const list = Array.isArray(skills) ? skills : []
  const winners = new Map()
  for (const skill of list) {
    const current = winners.get(skill.name)
    if (
      current === undefined ||
      skill.rank < current.rank ||
      (skill.rank === current.rank && (skill.order ?? 0) < (current.order ?? 0))
    ) {
      winners.set(skill.name, skill)
    }
  }
  return list.map((skill) => {
    const winner = winners.get(skill.name)
    if (winner === undefined || winner.path === skill.path) {
      const copies = list.filter((entry) => entry.name === skill.name)
      return {
        ...skill,
        shadowed: false,
        duplicateOf: copies.length > 1 ? null : null,
        copyCount: copies.length,
      }
    }
    return { ...skill, shadowed: true, duplicateOf: winner.path, winnerPath: winner.path, copyCount: 0 }
  })
}

// ───────────────────────────────────────────────────────────────────────────
// 供模型阅读的 markdown 面板
// ───────────────────────────────────────────────────────────────────────────

/**
 * 渲染技能清单，供 `skill_manager` 工具结果使用：一行一个技能，带上层、状态和
 * 诊断摘要。故意做成紧凑文本——模型不需要看完整正文。
 * @param {Array<object>} skills 技能条目
 * @param {{roots?: Array<object>, projectRoot?: string | null, summary?: object}} meta 上下文
 * @returns {string} Markdown 文本
 */
export function renderSkillPanel(skills, meta = {}) {
  const list = Array.isArray(skills) ? skills : []
  const summary = meta.summary ?? summarize(list)
  const lines = []
  lines.push(
    `技能 ${summary.total} 个（正常 ${summary.ok} / 警告 ${summary.warning} / 会被 DSH 跳过 ${summary.broken}），根目录 ${(meta.roots ?? []).length} 个。`,
  )
  if (meta.projectRoot) lines.push(`当前项目：${meta.projectRoot}`)
  lines.push('')
  if (list.length === 0) {
    lines.push('（没有发现任何技能）')
    return lines.join('\n')
  }
  for (const skill of list) {
    const scope = skill.source ?? '?'
    const flags = []
    if (skill.invocation && skill.invocation.modelInvocable === false) flags.push('模型不可见')
    if (skill.invocation && skill.invocation.userInvocable === false) flags.push('/不可见')
    if (skill.shadowed) flags.push(`被遮蔽(胜者 ${skill.winnerPath ?? '?'})`)
    if (skill.status === 'broken') flags.push('DSH会跳过')
    else if (skill.status === 'warning') flags.push('有警告')
    if (skill.kind === 'flat') flags.push('单文件')
    lines.push(
      `- ${skill.status === 'broken' ? '✖' : skill.status === 'warning' ? '!' : '✓'} ${skill.name}  [${scope} rank=${skill.rank}] ${flags.join(' ') || '正常'}`,
    )
    if (skill.description) lines.push(`    ${String(skill.description).slice(0, 160)}`)
    if (Array.isArray(skill.issues)) {
      for (const issue of skill.issues.filter((entry) => entry.level !== 'info')) {
        lines.push(`    · ${issue.message}`)
      }
    }
    lines.push(`    路径: ${skill.path}`)
  }
  return lines.join('\n')
}
