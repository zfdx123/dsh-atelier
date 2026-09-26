// dsh-mcp-manager — 从 `settings.describe()` 里认出**本插件自己的设置条目**。
//
// 0.1.7 的设置 ns 就是 loader 条目 id，但那个 id **不是插件能知道的东西**：它由
// 挂载本插件的那一行决定，而且运行时的 id 与组合树里写的 id 不一定相同。实测本机
// `dsh --profile web --dump-config` 里这一行是 `id: dsh-mcp-manager`，而运行时
// `ctx.fiber.entry.id` 是 `include:dsh-mcp-manager`（`include` 分组会把自己的
// 前缀加到子条目上；宿主 192 个条目里绝大多数都是这种带前缀的形态）。
//
// 于是插件拿 `include:…` 去读设置（读到空），却把值写到那个名字上，宿主直接拒绝：
//
//   No configurable plugin entry "include:dsh-mcp-manager"
//
// 所以改成**按值形状认领**：条目值里的键必须全部落在本插件 Config 声明的字段里，
// 且至少有一个键——然后用描述符自己的 `ns` 去写，无论挂在哪一层都对。
//
// 这个文件刻意与 dsh-skills-manager 的同名文件保持一致：两个包各自独立发布，
// 抽公共依赖会让它们互相绑版本，所以宁可留一份小而可测的重复实现。

/**
 * 本插件 Config 声明的字段名（schemastery 把子 schema 挂在 `dict` 上，取它就是
 * 权威清单，加字段不会忘了同步这里）。
 *
 * @param {object} schema 本插件的 Config schema
 * @returns {Set<string>} 声明的字段名集合
 */
export function declaredKeys(schema) {
  const dict = schema !== null && schema !== undefined ? schema.dict : undefined
  return new Set(dict !== null && dict !== undefined && typeof dict === 'object' ? Object.keys(dict) : [])
}

/**
 * 从条目列表里认出本插件的条目。
 *
 * 判据：值是非空普通对象，键**全部**落在 `declared` 里。
 * 只判「键都在我声明的集合里」不够——一个空对象能匹配任何 schema，所以要求至少
 * 一个键；再靠下面的一致性检查排除「恰好形状相同的别人」。
 *
 * **一致性**：候选必须只有唯一一个。多个候选时返回 undefined——宁可报「认不出」
 * 也不赌一个名字写上去（写错 ns 会被宿主拒绝，而且错得很晚）。
 *
 * @param {Array<{ns: string, value?: unknown}>} list describe() 返回的条目
 * @param {Set<string>} declared 本插件声明的字段名
 * @returns {{ns: string, value: object, revision?: unknown} | undefined} 本插件的条目
 */
export function claimEntry(list, declared) {
  if (!Array.isArray(list) || !(declared instanceof Set) || declared.size === 0) return undefined
  /** @type {Array<{ns: string, value: object, revision?: unknown}>} */
  const candidates = []
  for (const entry of list) {
    if (entry === null || entry === undefined) continue
    const value = entry.value
    if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) continue
    const keys = Object.keys(value)
    if (keys.length === 0) continue
    let foreign = false
    for (const key of keys) {
      if (!declared.has(key)) {
        foreign = true
        break
      }
    }
    if (foreign) continue
    candidates.push(entry)
  }
  return candidates.length === 1 ? candidates[0] : undefined
}
