// 纯逻辑层的单元测试：解析、校验、序列化、行级手术、诊断、遮蔽。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSkillFile,
  composeSkillText,
  defaultSkillBody,
  formatScalar,
  isSkillName,
  lintSkillFile,
  locateFrontmatter,
  markShadowed,
  parseFrontmatter,
  parseFrontmatterBoolean,
  patchFrontmatterLines,
  renderSkillPanel,
  resolveInvocation,
  serializeFrontmatter,
  slugifySkillName,
  splitSkillText,
  summarize,
  validateSkillInput,
} from '../lib/logic.js'

test('isSkillName 与官方 SKILL_NAME 语法一致', () => {
  for (const good of ['a', 'ab-cd', 'code-review', 'x1-y2-z3', '0-9']) {
    assert.equal(isSkillName(good), true, good)
  }
  for (const bad of ['Bad', 'bad_name', '-lead', 'trail-', 'a--b', 'has space', '', 'a/b', 'Ünicode']) {
    assert.equal(isSkillName(bad), false, bad)
  }
})

test('slugifySkillName 折叠非法字符', () => {
  assert.equal(slugifySkillName('Code Review!!'), 'code-review')
  assert.equal(slugifySkillName('  --Weird__Name-- '), 'weird-name')
  assert.equal(slugifySkillName(''), '')
  assert.equal(slugifySkillName(null), '')
})

test('parseFrontmatterBoolean 接受官方的全部拼写', () => {
  for (const value of [true, 1, '1', 'true', 'TRUE', 'yes', 'Yes', 'on', 'ON']) {
    assert.deepEqual(parseFrontmatterBoolean(value), { ok: true, value: true }, String(value))
  }
  for (const value of [false, 0, '0', 'false', 'NO', 'off', 'False']) {
    assert.deepEqual(parseFrontmatterBoolean(value), { ok: true, value: false }, String(value))
  }
  for (const value of ['maybe', 2, null, undefined, {}]) {
    assert.equal(parseFrontmatterBoolean(value).ok, false, String(value))
  }
})

test('resolveInvocation 默认两项都可调用', () => {
  assert.deepEqual(resolveInvocation({}), { modelInvocable: true, userInvocable: true, legacy: [], invalid: [] })
})

test('resolveInvocation 识别禁用与不可用拼写', () => {
  assert.equal(resolveInvocation({ 'disable-model-invocation': true }).modelInvocable, false)
  assert.equal(resolveInvocation({ 'disable-model-invocation': 'on' }).modelInvocable, false)
  assert.equal(resolveInvocation({ 'disable-model-invocation': false }).modelInvocable, true)
  assert.equal(resolveInvocation({ 'user-invocable': false }).userInvocable, false)
  assert.equal(resolveInvocation({ 'user-invocable': 'no' }).userInvocable, false)
})

test('resolveInvocation 报出遗留键与非法布尔', () => {
  assert.deepEqual(resolveInvocation({ modelInvocable: true }).legacy, ['modelInvocable'])
  assert.deepEqual(resolveInvocation({ disableModelInvocation: true }).legacy, ['disableModelInvocation'])
  const bad = resolveInvocation({ 'disable-model-invocation': 'sometimes' })
  assert.deepEqual(bad.invalid, ['disable-model-invocation'])
})

test('locateFrontmatter 只认文件开头的块', () => {
  assert.equal(locateFrontmatter('no frontmatter'), null)
  assert.equal(locateFrontmatter(''), null)
  // 没有闭合的 `---` → 不是 frontmatter 块（官方 provider 同样会跳过）。
  assert.equal(locateFrontmatter('---\nunclosed\n'), null)
  const located = locateFrontmatter('---\nname: a\n---\nbody\n')
  assert.deepEqual(located, { openLine: 1, closeLine: 3, bodyStartLine: 4 })
})

test('locateFrontmatter 容忍 CRLF 与尾部空白', () => {
  const located = locateFrontmatter('---\r\nname: a\r\n---  \r\nbody\r\n')
  assert.equal(located.closeLine, 3)
})

test('splitSkillText 分离 frontmatter 与正文', () => {
  const parts = splitSkillText('---\nname: a\n---\n\nhello\nworld\n')
  assert.equal(parts.frontmatter, 'name: a')
  assert.equal(parts.body, '\nhello\nworld\n')
  const none = splitSkillText('just text')
  assert.equal(none.frontmatter, null)
  assert.equal(none.body, 'just text')
})

test('parseFrontmatter 解析标量、引号、布尔与嵌套对象', () => {
  const { data } = parseFrontmatter(
    [
      'name: my-skill',
      'description: "quoted: with colon"',
      'whenToUse: bare text',
      'disable-model-invocation: true',
      'user-invocable: "false"',
      'count: 3',
      'nested:',
      '  owner: platform',
      '  tier: 2',
    ].join('\n'),
  )
  assert.equal(data.name, 'my-skill')
  assert.equal(data.description, 'quoted: with colon')
  assert.equal(data.whenToUse, 'bare text')
  assert.equal(data['disable-model-invocation'], true)
  assert.equal(data['user-invocable'], 'false')
  assert.equal(data.count, 3)
  assert.deepEqual(data.nested, { owner: 'platform', tier: 2 })
})

test('parseFrontmatter 冒号在引号内不会误切键', () => {
  const { data } = parseFrontmatter('description: "see http://x.test/a:b for details"')
  assert.equal(data.description, 'see http://x.test/a:b for details')
})

test('parseFrontmatter 记录行号范围（含嵌套子行）', () => {
  const { keyLines } = parseFrontmatter('a: 1\nnested:\n  x: 1\n  y: 2\nb: 2')
  assert.deepEqual(keyLines.a, { start: 1, end: 1 })
  assert.deepEqual(keyLines.nested, { start: 2, end: 4 })
  assert.deepEqual(keyLines.b, { start: 5, end: 5 })
})

test('parseFrontmatter 跳过注释与空行，不把它们算进键', () => {
  const { data, keyLines } = parseFrontmatter('# a comment\n\nname: x\n')
  assert.deepEqual(Object.keys(data), ['name'])
  assert.deepEqual(keyLines.name, { start: 3, end: 3 })
})

test('parseFrontmatter 对读不懂的结构给出 issue 且不猜值', () => {
  // 嵌套子映射（两层）超出读取范围：不猜值、标为 raw、写回时原样保留。
  const parsed = parseFrontmatter('name: x\nweird:\n  child:\n    grandchild: 1\n')
  assert.equal(parsed.rawKeys.includes('weird'), true)
  assert.equal(parsed.issues.length >= 1, true)
  assert.equal(parsed.issues[0].key, 'weird')
  assert.equal(parsed.data.weird, undefined, '读不懂就不要猜值')
})

test('formatScalar 只在该加引号时加', () => {
  assert.equal(formatScalar('plain text'), 'plain text')
  assert.equal(formatScalar(true), 'true')
  assert.equal(formatScalar(7), '7')
  assert.equal(formatScalar(null), 'null')
  assert.equal(formatScalar('has: colon space'), '"has: colon space"')
  assert.equal(formatScalar('true'), '"true"')
  assert.equal(formatScalar('123'), '"123"')
  assert.equal(formatScalar(''), '""')
  // 内嵌双引号不以引号开头，裸标量里合法且往返一致 → 不加引号。
  assert.equal(formatScalar('say "hi"'), 'say "hi"')
  assert.equal(formatScalar('"starts with quote'), '"\\"starts with quote"')
  assert.equal(formatScalar('line1\nline2'), '"line1\\nline2"')
  // 裸标量里含冒号是合法的 YAML，往返也一致，不该多加引号。
  assert.equal(formatScalar('a:b'), 'a:b')
})

test('parseFrontmatter 支持块标量 | 与 >（社区技能最常用的写法）', () => {
  // 回归：不支持块标量时 `description: >-` 会被读成 null，于是完全正常的技能
  // 被判成「description 缺失 → DSH 会跳过」。实测用户目录里 108/112 个技能都是
  // 这种写法——这个 bug 比「发现范围」本身更严重，因为它谎报技能是坏的。
  const literal = parseFrontmatter(['name: x', 'description: |', '  line one', '  line two'].join('\n'))
  assert.equal(literal.data.description, 'line one\nline two')

  const foldedStrip = parseFrontmatter(['name: x', 'description: >-', '  folded into', '  a single line'].join('\n'))
  assert.equal(foldedStrip.data.description, 'folded into a single line')

  const foldedPlain = parseFrontmatter(
    ['name: x', 'description: >', '  para one line one', '  para one line two', '', '  para two'].join('\n'),
  )
  assert.equal(foldedPlain.data.description, 'para one line one para one line two\npara two')

  // 块标量关键字行本身不该被记成解析失败
  assert.deepEqual(literal.rawKeys, [])
  assert.deepEqual(foldedStrip.rawKeys, [])
})

test('parseFrontmatter 支持序列（keywords / tags）', () => {
  const parsed = parseFrontmatter(['name: x', 'keywords:', '  - 溯源报告', '  - DFIR', '  - APT'].join('\n'))
  assert.deepEqual(parsed.data.keywords, ['溯源报告', 'DFIR', 'APT'])
  assert.deepEqual(parsed.rawKeys, [])
})

test('版本号这类值不能被当成数字（Number 会得到 NaN）', () => {
  const parsed = parseFrontmatter('version: "3.0.0"\nother: 3.0.0\n')
  assert.equal(parsed.data.version, '3.0.0')
  assert.equal(parsed.data.other, '3.0.0')
})

test('块标量的技能能通过完整校验（不再误报 broken）', () => {
  const result = lintSkillFile({
    text: [
      '---',
      'name: clickjacking',
      'description: >-',
      '  Clickjacking playbook. Use when testing whether target pages can be framed.',
      '---',
      '',
      '# body',
      '',
    ].join('\n'),
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.description, 'Clickjacking playbook. Use when testing whether target pages can be framed.')
})

test('formatScalar 写出去的值都能原样读回来', () => {
  for (const value of [
    'plain',
    'has: colon',
    'trailing space ',
    ' leading space',
    'true',
    'null',
    '123',
    '1.5e3',
    'say "quoted"',
    'back\\slash',
    "single 'quote'",
    'a:b',
    '#hash',
    '- dash',
    '[]{}',
    'multi\nline',
    '中文描述',
  ]) {
    const encoded = formatScalar(value)
    const back = parseFrontmatter(`k: ${encoded}`).data.k
    assert.equal(back, value, `往返失败：${JSON.stringify(value)} → ${encoded} → ${JSON.stringify(back)}`)
  }
})

test('serializeFrontmatter 顺序稳定且可往返', () => {
  const text = serializeFrontmatter({
    'user-invocable': false,
    description: 'd',
    name: 'n',
    'disable-model-invocation': true,
    metadata: { owner: 'me' },
  })
  const lines = text.split('\n')
  assert.equal(lines[0], '---')
  assert.equal(lines[1], 'name: n')
  assert.equal(lines[2], 'description: d')
  assert.equal(lines[3], 'disable-model-invocation: true')
  assert.equal(lines[4], 'user-invocable: false')
  assert.equal(lines[5], 'metadata:')
  assert.equal(lines[6], '  owner: me')
  assert.equal(lines[7], '---')
  const round = parseFrontmatter(lines.slice(1, -1).join('\n'))
  assert.equal(round.data.name, 'n')
  assert.equal(round.data['user-invocable'], false)
  assert.deepEqual(round.data.metadata, { owner: 'me' })
})

test('patchFrontmatterLines 就地改行、追加缺失键、删除键', () => {
  const source = 'name: a\n# keep me\ndescription: old\ncustom: keep\n'
  const parsed = parseFrontmatter(source)
  const patched = patchFrontmatterLines(
    source,
    {
      description: 'new',
      'disable-model-invocation': true,
      custom: undefined,
    },
    parsed,
  )
  // 删掉 custom（原第 4 行）后不留空行；新键追加在末尾；注释原地保留。
  assert.deepEqual(patched.text.split('\n'), [
    'name: a',
    '# keep me',
    'description: new',
    'disable-model-invocation: true',
  ])
  assert.deepEqual(patched.skipped, [])
})

test('patchFrontmatterLines 保留中间的空行', () => {
  const source = 'name: a\n\ndescription: d\n'
  const parsed = parseFrontmatter(source)
  const patched = patchFrontmatterLines(source, { description: 'D' }, parsed)
  assert.deepEqual(patched.text.split('\n'), ['name: a', '', 'description: D'])
})

test('patchFrontmatterLines 删除键也不会吃掉后续键', () => {
  const source = 'name: a\ntemp: gone\ndescription: d\n'
  const parsed = parseFrontmatter(source)
  const patched = patchFrontmatterLines(source, { temp: undefined }, parsed)
  assert.deepEqual(patched.text.split('\n'), ['name: a', 'description: d'])
})

test('patchFrontmatterLines 不碰读不懂的键（原样保留）', () => {
  const source = 'name: a\nweird:\n  child:\n    grandchild: 1\n'
  const parsed = parseFrontmatter(source)
  const patched = patchFrontmatterLines(source, { weird: 'replaced' }, parsed)
  assert.equal(patched.skipped.includes('weird'), true)
  assert.equal(patched.text.includes('    grandchild: 1'), true)
  assert.equal(patched.text.includes('replaced'), false)
})

test('块标量字段可被行级替换，且不影响其它行', () => {
  const source = 'name: a\ndescription: >-\n  old text\n  continues\nwhenToUse: keep me\n'
  const parsed = parseFrontmatter(source)
  const patched = patchFrontmatterLines(source, { description: 'new single line' }, parsed)
  assert.deepEqual(patched.text.split('\n'), ['name: a', 'description: new single line', 'whenToUse: keep me'])
  assert.deepEqual(patched.skipped, [])
})

test('composeSkillText 只换正文时 frontmatter 逐字节保留', () => {
  const frontmatter = 'name: a\n# a comment\ndescription: "x: y"'
  const first = composeSkillText(frontmatter, 'body one\n')
  const second = composeSkillText(frontmatter, 'body two\n')
  assert.equal(first.split('---')[1], second.split('---')[1])
  assert.equal(first.endsWith('body one\n'), true)
  assert.equal(second.endsWith('body two\n'), true)
})

test('composeSkillText 反复保存不会让文件长高（回归）', () => {
  // 从文件里切出来的 body 自带 frontmatter 后的那个换行。若拼接时再补一个空行，
  // 「打开 → 保存」每做一次文件就多一个空行。这里钉死这个不变量。
  const original = '---\nname: a\ndescription: d\n---\n\nbody\n'
  let current = original
  for (let round = 0; round < 5; round += 1) {
    const parts = splitSkillText(current)
    current = composeSkillText(parts.frontmatter, parts.body)
  }
  assert.equal(current, original, '空转五轮后文本必须逐字节不变')
})

test('composeSkillText 正文为空时不留多余空行', () => {
  // 空正文 → 分隔符只留一个换行，再加文件结尾换行。
  assert.equal(composeSkillText('name: a', ''), '---\nname: a\n---\n\n')
  assert.equal(composeSkillText('name: a', '\n\n\n'), '---\nname: a\n---\n\n')
  assert.equal(composeSkillText('name: a', '   \n  '), '---\nname: a\n---\n\n')
  // 有正文 → 分隔符是两个换行（frontmatter 与正文之间空一行）。
  assert.equal(composeSkillText('name: a', 'text'), '---\nname: a\n---\n\ntext\n')
})

test('composeSkillText 无 frontmatter 时只写正文', () => {
  assert.equal(composeSkillText(null, 'plain\n'), 'plain\n')
  assert.equal(composeSkillText(null, ''), '')
})

test('buildSkillFile 产出可被解析回来的技能', () => {
  const text = buildSkillFile({ name: 'my-skill', description: 'does a thing', modelInvocable: false })
  const result = lintSkillFile({ text })
  assert.equal(result.status !== 'broken', true)
  assert.equal(result.fields.name, 'my-skill')
  assert.equal(result.invocation.modelInvocable, false)
  assert.equal(result.invocation.userInvocable, true)
})

test('buildSkillFile 省略正文时写入骨架而不是空白', () => {
  const text = buildSkillFile({ name: 'x', description: 'd' })
  assert.equal(text.includes('## 步骤'), true)
  assert.equal(lintSkillFile({ text }).status, 'ok')
})

test('lintSkillFile：正常文件 status=ok', () => {
  const result = lintSkillFile({
    text: '---\nname: good\ndescription: fine\nwhenToUse: when needed\n---\n\n# body\n\ntext\n',
  })
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.issues, [])
  assert.equal(result.whenToUse, 'when needed')
})

test('lintSkillFile：缺 name/description 判为 broken', () => {
  const missing = lintSkillFile({ text: '---\ndescription: only\n---\nbody\n' })
  assert.equal(missing.status, 'broken')
  assert.equal(
    missing.issues.some((issue) => issue.key === 'name' && issue.level === 'error'),
    true,
  )

  const noDescription = lintSkillFile({ text: '---\nname: x\n---\nbody\n' })
  assert.equal(noDescription.status, 'broken')
  assert.equal(
    noDescription.issues.some((issue) => issue.key === 'description'),
    true,
  )
})

test('lintSkillFile：完全没有 frontmatter 判为 broken', () => {
  const result = lintSkillFile({ text: 'just markdown, no frontmatter\n' })
  assert.equal(result.status, 'broken')
  assert.equal(result.issues[0].level, 'error')
})

test('lintSkillFile：非法名字判为 broken', () => {
  const result = lintSkillFile({ text: '---\nname: Bad_Name\ndescription: d\n---\nbody\n' })
  assert.equal(result.status, 'broken')
  assert.equal(
    result.issues.some((issue) => issue.key === 'name' && issue.level === 'error'),
    true,
  )
})

test('lintSkillFile：遗留调用键判为 broken（官方会整条丢弃）', () => {
  for (const key of ['modelInvocable', 'userInvocable', 'disableModelInvocation']) {
    const result = lintSkillFile({ text: `---\nname: x\ndescription: d\n${key}: true\n---\nbody\n` })
    assert.equal(result.status, 'broken', key)
    assert.equal(
      result.issues.some((issue) => issue.key === key),
      true,
      key,
    )
  }
})

test('lintSkillFile：非法布尔值判为 broken', () => {
  const result = lintSkillFile({ text: '---\nname: x\ndescription: d\ndisable-model-invocation: maybe\n---\nbody\n' })
  assert.equal(result.status, 'broken')
  assert.equal(
    result.issues.some((issue) => issue.key === 'disable-model-invocation'),
    true,
  )
})

test('lintSkillFile：两边都不可调用时给警告', () => {
  const result = lintSkillFile({
    text: '---\nname: x\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false\n---\nbody\n',
  })
  assert.equal(result.status, 'warning')
  assert.equal(
    result.issues.some((issue) => issue.message.includes('没有任何入口')),
    true,
  )
})

test('lintSkillFile：空正文与超长描述给警告', () => {
  const emptyBody = lintSkillFile({ text: '---\nname: x\ndescription: d\n---\n' })
  assert.equal(
    emptyBody.issues.some((issue) => issue.message.includes('正文为空')),
    true,
  )

  const long = lintSkillFile({ text: `---\nname: x\ndescription: ${'d'.repeat(900)}\n---\nbody\n` })
  assert.equal(
    long.issues.some((issue) => issue.message.includes('过长')),
    true,
  )
})

test('lintSkillFile：未知字段只提示、不影响判决', () => {
  const result = lintSkillFile({ text: '---\nname: x\ndescription: d\nfutureKey: 1\n---\nbody\n' })
  assert.equal(result.status, 'ok')
  assert.equal(
    result.issues.some((issue) => issue.level === 'info' && issue.key === 'futureKey'),
    true,
  )
})

test('validateSkillInput 拦住非法输入', () => {
  assert.deepEqual(validateSkillInput({ name: 'ok-name', description: 'fine' }), [])
  assert.equal(validateSkillInput({ name: 'Bad', description: 'fine' }).length, 1)
  assert.equal(validateSkillInput({ name: 'ok', description: '   ' }).length, 1)
  assert.equal(validateSkillInput({ name: 'ok', description: 'fine', whenToUse: 42 }).length, 1)
  assert.equal(validateSkillInput({ name: 'ok', description: 'fine', body: {} }).length, 1)
})

test('summarize 计数正确', () => {
  assert.deepEqual(
    summarize([
      { status: 'ok' },
      { status: 'ok' },
      { status: 'warning' },
      { status: 'broken' },
      { status: 'ok', shadowed: true, duplicateOf: 'p' },
    ]),
    { total: 5, ok: 3, warning: 1, broken: 1, duplicates: 1, shadowed: 1 },
  )
})

test('markShadowed：同层内 rank 小者获胜', () => {
  const marked = markShadowed([
    { name: 'a', rank: 400, order: 0, path: '/u/a' },
    { name: 'a', rank: 100, order: 1, path: '/p/a' },
    { name: 'b', rank: 100, order: 2, path: '/p/b' },
  ])
  const loser = marked.find((entry) => entry.path === '/u/a')
  const winner = marked.find((entry) => entry.path === '/p/a')
  assert.equal(loser.shadowed, true)
  assert.equal(loser.winnerPath, '/p/a')
  assert.equal(winner.shadowed, false)
  assert.equal(winner.copyCount, 2)
  assert.equal(marked.find((entry) => entry.path === '/p/b').shadowed, false)
})

test('markShadowed：同 rank 时按扫描顺序定胜负', () => {
  const marked = markShadowed([
    { name: 'a', rank: 100, order: 5, path: 'second' },
    { name: 'a', rank: 100, order: 1, path: 'first' },
  ])
  assert.equal(marked.find((entry) => entry.path === 'first').shadowed, false)
  assert.equal(marked.find((entry) => entry.path === 'second').shadowed, true)
})

test('renderSkillPanel 输出名字、层、状态与路径', () => {
  const panel = renderSkillPanel(
    [
      {
        name: 'good',
        source: 'project-dsh',
        rank: 100,
        status: 'ok',
        path: '/p/good/SKILL.md',
        description: 'a good skill',
        invocation: { modelInvocable: true, userInvocable: true },
        issues: [],
      },
      {
        name: 'bad',
        source: 'user-dsh',
        rank: 400,
        status: 'broken',
        path: '/u/bad.md',
        description: '',
        invocation: { modelInvocable: true, userInvocable: true },
        issues: [{ level: 'error', key: 'description', message: '缺少必填字段 description' }],
      },
    ],
    { roots: [{}, {}], projectRoot: '/p' },
  )
  assert.equal(panel.includes('技能 2 个'), true)
  assert.equal(panel.includes('good'), true)
  assert.equal(panel.includes('DSH会跳过'), true)
  assert.equal(panel.includes('缺少必填字段 description'), true)
})

test('renderSkillPanel 空清单有明确文案', () => {
  const panel = renderSkillPanel([], { roots: [] })
  assert.equal(panel.includes('没有发现任何技能'), true)
})

test('defaultSkillBody 生成可用的骨架', () => {
  const body = defaultSkillBody({ name: 'x', description: 'the description' })
  assert.equal(body.includes('# x'), true)
  assert.equal(body.includes('the description'), true)
  assert.equal(body.includes('## 何时使用'), true)
})
