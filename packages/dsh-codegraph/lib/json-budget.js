// JSON output budgeting.
//
// The model-facing tools forward the CLI's output as a string. Most commands
// print a handful of records, but `codegraph files --json` prints one record
// per indexed file: a large repository easily produces hundreds of kilobytes,
// past the tool's output budget. The old path cut the string at a fixed
// character count, which leaves a HALF-WRITTEN JSON document — the tool
// advertises JSON, and the consumer cannot parse it.
//
// Dropping whole records from the tail instead keeps the document valid and
// says how much was dropped. The budget is a character budget, matching the
// other truncation in the plugin (`truncate`), so the two are comparable.

/**
 * Shrink one JSON payload to `maxChars` without ever emitting invalid JSON.
 *
 * The payload is either an array (the CLI's `files --json` shape) or an object
 * carrying a `files` array. An over-budget OBJECT keeps its shape and gains a
 * `truncated: { dropped, kept, total }` marker. An over-budget ARRAY cannot
 * carry a marker without changing its shape, and silently dropping half a file
 * list is worse than saying so — it is therefore returned as
 * `{ files: [...], truncated: { ... } }`. A payload that already fits is
 * returned byte-for-byte as `JSON.stringify(payload, null, 2)`, matching the
 * CLI's own pretty-printed `--json` output.
 *
 * Binary search over the kept prefix keeps the cost logarithmic in the number
 * of records while preserving order.
 *
 * @param {unknown} payload
 * @param {number} maxChars
 * @returns {string} valid JSON text
 */
export function fitJson(payload, maxChars) {
  const isArray = Array.isArray(payload)
  const list = isArray
    ? payload
    : payload !== null && typeof payload === 'object' && Array.isArray(payload.files)
      ? payload.files
      : null
  if (list === null) throw new TypeError('fitJson: payload must be an array or an object with a files array')
  if (!Number.isFinite(maxChars) || maxChars < 0)
    throw new TypeError('fitJson: maxChars must be a non-negative finite number')

  const render = (items) =>
    isArray ? JSON.stringify(items, null, 2) : JSON.stringify(Object.assign({}, payload, { files: items }), null, 2)

  let text = render(list)
  if (text.length <= maxChars) return text

  // Render the TRUNCATED form itself while searching: the wrapper object and
  // its marker add both a header and one indentation level, so budgeting the
  // inner array alone would overshoot the budget by tens of kilobytes on a
  // long list. The marker's counts are derived per candidate, so the result
  // needs no post-processing.
  const renderTruncated = (items) => {
    const truncated = { dropped: list.length - items.length, kept: items.length, total: list.length }
    return isArray
      ? JSON.stringify({ files: items, truncated }, null, 2)
      : JSON.stringify(Object.assign({}, payload, { files: items, truncated }), null, 2)
  }

  // The largest prefix whose full truncated form fits the budget. `best`
  // starts at the empty list; a payload whose non-`files` fields alone exceed
  // the budget still returns valid JSON (validity is hard, the budget is soft).
  let low = 0
  let high = list.length
  let best = renderTruncated([])
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = renderTruncated(list.slice(0, mid))
    if (candidate.length <= maxChars) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}
