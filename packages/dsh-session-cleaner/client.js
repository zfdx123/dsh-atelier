// dsh-session-cleaner — client half.
//
// Two additive entries:
//   1. a "删除会话" item in the sidebar session row ⋮ menu, inserted directly
//      BELOW "归档会话";
//   2. a "会话清理" Settings page listing every session the store knows —
//      workspace members, ungrouped strays, archived and legacy bare-uuid
//      sessions alike — with per-row Delete (plus Unarchive on archived rows).
//
// The row ⋮ menu has no public slot, so entry 1 augments the opened menu in the
// DOM. Three deliberate choices keep that from being guesswork:
//   - the menu is recognized SEMANTICALLY: a subtree carrying both the archive
//     and the fork/rename labels is the session row menu, and the insertion
//     point is the smallest element containing both;
//   - the row comes from the ⋮ trigger the user just pressed, never from a time
//     window or a rectangle distance;
//   - the SESSION ID comes from the row's React fiber props (the row component
//     receives the session node), so no title matching and no catalog fetch is
//     required; the title catalog remains a fallback and supplies the running
//     flag.
// Every step reports to `/api-ext/session.cleaner.diag`, so a menu item that
// fails to appear can be diagnosed from outside the browser.
//
// Elements are built with React.createElement, and the shell's own UI kit is
// required behind a guard: without it the confirmation falls back to the
// browser's, and every glyph to the hand-drawn SVG beside it.
window.__ModuleLoader__.load({
  id: '@zfdx123/dsh-session-cleaner',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const NS = 'sessionCleaner'
    const zh = {
      nav: '会话清理',
      search: '搜索会话',
      loading: '正在读取会话…',
      empty: '没有匹配的会话。',
      ungrouped: '未分组',
      count: '{n} 个会话',
      countOf: '{n}/{total} 个',
      archived: '已归档',
      running: '运行中',
      legacy: '旧格式',
      del: '删除',
      delNamed: '删除会话 {title}',
      confirm: '确定要永久删除会话「{title}」吗？此操作不可恢复。',
      refused: '该会话正在运行，请等它跑完（或先中止）再删除。',
      failed: '删除失败：{message}',
      unarchive: '取消归档',
      cancel: '取消',
      close: '关闭',
      pending: '正在删除…',
      menuDelete: '删除会话',
      menuDeleteDisabled: '会话正在运行，无法删除',
      now: '刚刚',
      minutes: '{n}分钟',
      hours: '{n}小时',
      days: '{n}天',
      months: '{n}个月',
      years: '{n}年',
    }
    const en = {
      nav: 'Session cleaner',
      search: 'Search sessions',
      loading: 'Reading sessions…',
      empty: 'No matching sessions.',
      ungrouped: 'Ungrouped',
      count: '{n} sessions',
      countOf: '{n}/{total}',
      archived: 'Archived',
      running: 'Running',
      legacy: 'Legacy',
      del: 'Delete',
      delNamed: 'Delete session {title}',
      confirm: 'Permanently delete session “{title}”? This cannot be undone.',
      refused: 'This session is running; wait for it to finish (or stop it) before deleting.',
      failed: 'Delete failed: {message}',
      unarchive: 'Unarchive',
      cancel: 'Cancel',
      close: 'Close',
      pending: 'Deleting…',
      menuDelete: 'Delete session',
      menuDeleteDisabled: 'Session is running and cannot be deleted',
      now: 'now',
      minutes: '{n}min',
      hours: '{n}h',
      days: '{n}d',
      months: '{n}mo',
      years: '{n}y',
    }

    const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']

    const DELETE_PATH = '/api-ext/session.delete'
    const DIAG_PATH = '/api-ext/session.cleaner.diag'
    /** The shell hands every client bundle a fixed module set; all three are in it. */
    const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'
    const REACT_DOM = 'react-dom/client'
    /** `react-dom` proper, for the one export that renders a kit glyph now. */
    const REACT_DOM_SYNC = 'react-dom'

    // ------------------------------------------------------------------ shared

    /** Fire-and-forget diagnostic report to the host's bounded log. */
    function report(event, detail) {
      try {
        fetch(DIAG_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ report: { event, detail: detail === undefined ? null : detail } }),
        }).catch(() => {})
      } catch {
        /* diagnostics must never break the feature */
      }
    }

    /** POST the delete route; throws with the server's message on refusal. */
    async function requestDelete(sessionId) {
      const response = await fetch(DELETE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sessionId }),
      })
      const body = await response.json().catch(() => ({}))
      if (body?.ok !== true) {
        const failure = new Error(body?.error?.message ?? `HTTP ${response.status}`)
        failure.code = body?.error?.code ?? 'internal'
        throw failure
      }
      return body.value
    }

    /**
     * The UI primitives, or null when the shell did not hand them over — the
     * module-table miss this guard exists for, or a kit that only partly
     * arrived: every member this plugin renders has to be there, icons
     * included, because a kit without them would silently change the page's
     * look. Null means the delete still works through the browser's own
     * confirmation, and every glyph falls back to the hand-drawn SVG.
     */
    function loadPrimitives(require) {
      try {
        const primitives = require(PRIMITIVES)
        if (
          typeof primitives?.Modal === 'function' &&
          typeof primitives?.Button === 'function' &&
          typeof primitives?.IconSearchOutline === 'function' &&
          typeof primitives?.IconChevronDownOutline === 'function' &&
          typeof primitives?.IconTrashOutline === 'function'
        )
          return primitives
      } catch (error) {
        report('primitives-missing', { message: String(error?.message ?? error) })
      }
      return null
    }

    /** What to show for a failed delete: a refusal reads differently from a fault. */
    function failureText(error, labels) {
      const message = error?.message ?? String(error)
      const refused = error?.code === 'refused' || /open|attached|running/i.test(message)
      return refused ? labels.refused : labels.failed.replace('{message}', message)
    }

    /** The copy every delete surface shares. */
    function deleteLabels(t) {
      return {
        title: t('menuDelete'),
        description: (name) => t('confirm', { title: name }),
        confirm: t('del'),
        cancel: t('cancel'),
        close: t('close'),
        pending: t('pending'),
        refused: t('refused'),
        failed: t('failed', { message: '{message}' }),
      }
    }

    /**
     * Drop a just-deleted session from the CLIENT session list.
     *
     * The host's only removal notification is `session/disposed`, and the
     * session store emits it solely for an ANNOUNCED live entry — one an agent
     * opened, which is exactly the kind of session this plugin refuses to
     * delete. A deleted cold session holds no live entry at all, so nothing
     * ever reaches this page and the row would sit in the sidebar and in both
     * Settings pages forever. `handleSessionRemoved` is the very method the
     * `api-session/removed` relay calls, so the row leaves on the store's own
     * path (list, grouping, per-session scope and bindings together); the
     * follow-up `refresh()` reconciles with the host baseline, which is built
     * from the persisted logs and therefore no longer lists the session.
     * @param ctx - client plugin context (needs the sessions service).
     * @param sessionId - the session that no longer exists.
     * @returns completion of the baseline reconcile.
     */
    function forgetDeleted(ctx, sessionId) {
      const sessions = ctx?.sessions
      try {
        sessions?.handleSessionRemoved?.(sessionId)
      } catch (error) {
        report('forget-failed', { id: sessionId, message: String(error?.message ?? error) })
      }
      return Promise.resolve(sessions?.refresh?.()).catch(() => {})
    }

    /** Localized compact relative time. */
    function timeLabel(updatedAt, now, t) {
      const minutes = Math.floor((now - updatedAt) / 6e4)
      if (minutes < 1) return t('now')
      const hours = Math.floor(minutes / 60)
      if (hours < 1) return t('minutes', { n: minutes })
      const days = Math.floor(hours / 24)
      if (days < 1) return t('hours', { n: hours })
      const months = Math.floor(days / 30)
      if (months < 1) return t('days', { n: days })
      const years = Math.floor(months / 12)
      if (years < 1) return t('months', { n: months })
      return t('years', { n: years })
    }

    const S = {
      section: {
        width: '100%',
        maxWidth: 760,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
      },
      status: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: 13, lineHeight: '20px' },
      search: { position: 'relative', display: 'flex', alignItems: 'center', width: '100%' },
      /** The box the search glyph rides: a kit icon drops `style`, the box keeps it. */
      searchGlyph: {
        position: 'absolute',
        left: 12,
        display: 'flex',
        pointerEvents: 'none',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      input: {
        width: '100%',
        height: 32,
        boxSizing: 'border-box',
        borderRadius: 8,
        border: '.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '0 12px 0 36px',
        font: 'inherit',
      },
      groups: { display: 'flex', flexDirection: 'column', gap: 10 },
      group: { display: 'flex', flexDirection: 'column', gap: 2 },
      groupHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        margin: 0,
        padding: '2px 8px',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        textAlign: 'left',
        cursor: 'pointer',
      },
      groupTitle: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chevron: { display: 'flex', flexShrink: 0, transform: 'none' },
      chevronFolded: { transform: 'rotate(-90deg)' },
      groupList: {
        listStyle: 'none',
        margin: 0,
        padding: 0,
        paddingLeft: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      },
      row: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', borderRadius: 8 },
      identity: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
      titleRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, lineHeight: '20px' },
      meta: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 12,
        lineHeight: '18px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      badge: {
        flexShrink: 0,
        fontSize: 11,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 4,
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      button: {
        font: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
        borderRadius: 8,
        border: '.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        padding: '2px 12px',
        cursor: 'pointer',
      },
      dialogStatus: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' },
      dialogError: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '18px', margin: 0 },
      danger: {
        color: 'var(--dsw-alias-state-error-primary, #d64545)',
        borderColor: 'var(--dsw-alias-state-error-primary, #d64545)',
      },
    }

    // ------------------------------------------------------------------ glyphs

    /**
     * The shell's own icon component, or null when the kit did not deliver that
     * member. Kit icons are `{size, className} -> svg`: they forward nothing
     * else — no `style`, no `aria-hidden` — so placement belongs to the box a
     * glyph sits in, never to the glyph.
     */
    function kitIcon(primitives, name) {
      const icon = primitives?.[name]
      return typeof icon === 'function' ? icon : null
    }

    /** The search field's leading glyph, hand-drawn: the path a kit-less shell takes. */
    function SearchIcon(props) {
      return React.createElement(
        'svg',
        Object.assign({ width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none' }, props),
        React.createElement('circle', { cx: 6.5, cy: 6.5, r: 4.5, stroke: 'currentColor', strokeWidth: 1.4 }),
        React.createElement('path', {
          d: 'M10 10 L14 14',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      )
    }

    /** The group header's fold glyph, hand-drawn: the path a kit-less shell takes. */
    function ChevronIcon(props) {
      return React.createElement(
        'svg',
        Object.assign({ width: 12, height: 12, viewBox: '0 0 16 16' }, props),
        React.createElement('path', {
          d: 'M4 6.5 L8 10.5 L12 6.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * One glyph inside its placement box: the kit's icon when the loader kept
     * the kit, the hand-drawn SVG otherwise. Both paths ride the same box, so a
     * missing kit cannot move anything on the page.
     * @param props.primitives - the kit, or null.
     * @param props.name - the kit icon export for this spot.
     * @param props.size - the kit glyph's square edge in px.
     * @param props.box - the box's style: placement, colour, transform.
     * @param props.fallback - the hand-drawn SVG for this spot.
     */
    function Glyph(props) {
      const { primitives, name, size, box, fallback } = props
      const Icon = kitIcon(primitives, name)
      const glyph = Icon === null ? React.createElement(fallback) : React.createElement(Icon, { size })
      return React.createElement('span', { 'aria-hidden': true, style: box }, glyph)
    }

    // --------------------------------------------------------- delete dialog

    /**
     * The one delete confirmation: the app's own modal, with progress and
     * failure shown inside it. It owns the whole flow — ask, run, report — so
     * both surfaces that can delete share one behaviour, and nothing here ever
     * opens a browser alert.
     *
     * `title` doubles as the open flag: null means "no target, render nothing".
     * @param props.primitives - `{Modal, Button}` from the shell.
     * @param props.labels - copy from {@link deleteLabels}.
     * @param props.title - the session title to delete, or null.
     * @param props.run - the delete itself; rejecting keeps the dialog open.
     * @param props.onClose - called with whether the delete went through.
     */
    function DeleteDialog(props) {
      const { primitives, labels, title, run, onClose } = props
      const { Modal, Button } = primitives
      const [pending, setPending] = React.useState(false)
      const [error, setError] = React.useState(null)

      /**
       * Leave the dialog and drop the attempt's own state. This component stays
       * MOUNTED while it is closed — `title` is the open flag, and the Settings
       * page never unmounts it — so state kept past a close is handed to the
       * next session's dialog: a `pending` left true by a finished delete would
       * greet the next row already reading 「正在删除…」 with both footer buttons
       * disabled, and `confirm` returns early on `pending`, so that delete can
       * neither start nor fail. One opening owns one attempt's state; leaving is
       * what ends it.
       * @param deleted - whether the session was actually deleted.
       */
      const close = (deleted) => {
        setPending(false)
        setError(null)
        onClose(deleted)
      }

      const confirm = async () => {
        if (pending) return
        setPending(true)
        setError(null)
        try {
          await run()
          close(true)
        } catch (failure) {
          report('delete-failed', { message: String(failure?.message ?? failure) })
          setError(failureText(failure, labels))
          setPending(false)
        }
      }

      return React.createElement(
        Modal,
        {
          open: title !== null,
          onClose: () => close(false),
          closeLabel: labels.close,
          title: labels.title,
          ...(title === null ? {} : { description: labels.description(title) }),
          footer: [
            React.createElement(
              Button,
              {
                key: 'cancel',
                variant: 'outline',
                disabled: pending,
                onClick: () => close(false),
              },
              labels.cancel,
            ),
            React.createElement(
              Button,
              {
                key: 'confirm',
                variant: 'outline',
                disabled: pending,
                // The native destructive action is an outline button with the
                // error colour, but only while it can actually be pressed.
                ...(pending ? {} : { style: { color: 'var(--dsw-alias-state-error-primary)' } }),
                onClick: confirm,
              },
              labels.confirm,
            ),
          ],
        },
        [
          pending
            ? React.createElement('div', { key: 'pending', role: 'status', style: S.dialogStatus }, labels.pending)
            : null,
          error === null
            ? null
            : React.createElement('div', { key: 'error', role: 'alert', style: S.dialogError }, error),
        ],
      )
    }

    /**
     * Run a delete behind the dialog for a caller that has no React tree of its
     * own — the row ⋮ menu is imperative DOM, so the dialog needs its own root.
     * The root and its container are torn down on either answer.
     * @returns whether the session was actually deleted.
     */
    function deleteWithDialog(options) {
      const { require, labels, title, run } = options
      const primitives = loadPrimitives(require)
      if (primitives === null) {
        if (!window.confirm(labels.description(title))) return Promise.resolve(false)
        return Promise.resolve(run()).then(
          () => true,
          (failure) => {
            report('delete-failed', { message: String(failure?.message ?? failure) })
            return false
          },
        )
      }
      const container = document.createElement('div')
      document.body.append(container)
      const root = require(REACT_DOM).createRoot(container)
      return new Promise((resolve) => {
        const close = (deleted) => {
          root.unmount()
          container.remove()
          resolve(deleted)
        }
        root.render(
          React.createElement(DeleteDialog, {
            primitives,
            labels,
            title,
            run,
            onClose: close,
          }),
        )
      })
    }

    // ------------------------------------------------------------ Settings page

    /** Group key of every session no workspace accounts for. */
    const UNGROUPED = ''

    function SessionCleanerSection(props) {
      // `uiWorkspace` and `forget` arrive through the registration's own
      // `inject`: the section slot composes only the standard hooks, so a
      // service read straight off these props would be undefined.
      const { t, useSessions, useWorkspaces, uiWorkspace, forget, primitives } = props
      const sessionsState = useSessions((state) => state)
      const workspaces = useWorkspaces((state) => state.items)
      const archivedIds = useWorkspaces((state) => state.archivedSessionIds)
      const [query, setQuery] = React.useState('')
      const [busy, setBusy] = React.useState('')
      /** Group keys the user folded. A search overrides them. */
      const [folded, setFolded] = React.useState([])
      /** The row awaiting confirmation. */
      const [target, setTarget] = React.useState(null)
      /** Last failure, shown inline when no dialog is available to hold it. */
      const [failure, setFailure] = React.useState(null)

      const summaries = sessionsState.byId
      // One group per owning workspace in HOST order, then the strays — the
      // same order the sidebar uses, so both surfaces agree about where a
      // session lives. Archiving is a property of a row, not a place, so an
      // archived session keeps its workspace group and only carries a badge.
      const groups = React.useMemo(() => {
        const owner = new Map()
        const order = workspaces.map((workspace) => {
          const key = String(workspace.workspaceId)
          for (const id of workspace.sessionIds) owner.set(id, key)
          return { key, title: workspace.title, rows: [] }
        })
        const byKey = new Map(order.map((group) => [group.key, group]))
        const archived = new Set(archivedIds)
        // Every listed session — workspace members AND ungrouped or legacy
        // ones — plus archived ids, which the list may no longer carry.
        const ids = [...new Set([...Object.keys(summaries), ...archived])]
        const strays = []
        for (const id of ids) {
          const summary = summaries[id]
          const row = {
            id,
            title: summary === undefined ? id : summary.displayTitle,
            archived: archived.has(id),
            legacy: id.indexOf('session-') !== 0,
            updatedAt: summary === undefined ? 0 : summary.updatedAt,
            running: summary === undefined ? false : summary.running,
          }
          ;(byKey.get(owner.get(id))?.rows ?? strays).push(row)
        }
        const result = order.filter((group) => group.rows.length > 0)
        if (strays.length > 0) result.push({ key: UNGROUPED, title: t('ungrouped'), rows: strays })
        for (const group of result) group.rows.sort((a, b) => b.updatedAt - a.updatedAt)
        return result
      }, [workspaces, archivedIds, summaries, t])

      if (sessionsState.phase !== undefined && sessionsState.phase !== 'ready') {
        return React.createElement('p', { style: S.status }, t('loading'))
      }
      const now = Date.now()
      const normalized = query.trim().toLowerCase()
      const searching = normalized.length > 0
      // A search both filters and expands: a hit hidden inside a folded group
      // would look exactly like no hit at all.
      const visible = groups.flatMap((group) => {
        const named = group.title.toLowerCase().includes(normalized)
        const rows =
          !searching || named ? group.rows : group.rows.filter((row) => row.title.toLowerCase().includes(normalized))
        if (rows.length === 0) return []
        return [{ key: group.key, title: group.title, total: group.rows.length, rows }]
      })

      const toggle = (key) => {
        setFolded((current) =>
          current.includes(key) ? current.filter((candidate) => candidate !== key) : [...current, key],
        )
      }

      const labels = deleteLabels(t)

      /** The delete itself; rejecting leaves the dialog open on the reason. */
      const runDelete = async (row) => {
        setBusy(row.id)
        try {
          await requestDelete(row.id)
          report('page-delete', { id: row.id, ok: true })
          await forget(row.id)
        } catch (error) {
          report('page-delete', { id: row.id, ok: false, message: String(error?.message ?? error) })
          throw error
        } finally {
          setBusy('')
        }
      }

      /** Ask first — in the app's dialog, or the browser's if it is missing. */
      const ask = (row) => {
        if (busy !== '') return
        setFailure(null)
        if (primitives !== null) {
          setTarget(row)
          return
        }
        if (!window.confirm(labels.description(row.title))) return
        runDelete(row).catch((error) => setFailure(failureText(error, labels)))
      }

      const rowNodes = (rows) =>
        rows.map((row) =>
          React.createElement('li', { key: row.id, 'data-session-row': row.id, style: S.row }, [
            React.createElement('div', { key: 'id', style: S.identity }, [
              React.createElement('div', { key: 'title', style: S.titleRow }, [
                React.createElement('span', { key: 't', style: S.title }, row.title),
                row.archived ? React.createElement('span', { key: 'a', style: S.badge }, t('archived')) : null,
                row.legacy ? React.createElement('span', { key: 'l', style: S.badge }, t('legacy')) : null,
                row.running
                  ? React.createElement(
                      'span',
                      {
                        key: 'r',
                        style: Object.assign({}, S.badge, { color: 'var(--dsw-alias-state-success-primary, #2e7d32)' }),
                      },
                      t('running'),
                    )
                  : null,
              ]),
              React.createElement(
                'span',
                { key: 'm', style: S.meta },
                row.updatedAt > 0 ? timeLabel(row.updatedAt, now, t) : row.id,
              ),
            ]),
            row.archived
              ? React.createElement(
                  'button',
                  {
                    key: 'un',
                    type: 'button',
                    style: Object.assign({}, S.button, { marginRight: 6 }),
                    onClick: () => {
                      uiWorkspace.unarchiveSession(row.id).catch(() => {})
                    },
                  },
                  t('unarchive'),
                )
              : null,
            React.createElement(
              'button',
              {
                key: 'del',
                type: 'button',
                'aria-label': t('delNamed', { title: row.title }),
                disabled: busy === row.id,
                style: Object.assign({}, S.button, row.archived ? S.danger : {}),
                onClick: () => ask(row),
              },
              busy === row.id ? '…' : t('del'),
            ),
          ]),
        )

      const groupNodes = visible.map((group) => {
        const collapsed = searching ? false : folded.includes(group.key)
        return React.createElement('section', { key: group.key, 'data-session-group': group.key, style: S.group }, [
          React.createElement(
            'button',
            {
              key: 'header',
              type: 'button',
              'data-session-group-header': group.key,
              'aria-expanded': !collapsed,
              onClick: () => toggle(group.key),
              style: S.groupHeader,
            },
            [
              React.createElement(Glyph, {
                key: 'chevron',
                primitives,
                name: 'IconChevronDownOutline',
                size: 12,
                box: Object.assign({}, S.chevron, collapsed ? S.chevronFolded : {}),
                fallback: ChevronIcon,
              }),
              React.createElement('span', { key: 't', style: S.groupTitle }, group.title),
              React.createElement(
                'span',
                { key: 'n', style: S.badge },
                searching ? t('countOf', { n: group.rows.length, total: group.total }) : t('count', { n: group.total }),
              ),
            ],
          ),
          collapsed ? null : React.createElement('ul', { key: 'rows', style: S.groupList }, rowNodes(group.rows)),
        ])
      })

      return React.createElement('div', { style: S.section }, [
        React.createElement('div', { key: 'search', style: S.search }, [
          React.createElement(Glyph, {
            key: 'i',
            primitives,
            name: 'IconSearchOutline',
            size: 16,
            box: S.searchGlyph,
            fallback: SearchIcon,
          }),
          React.createElement('input', {
            key: 'q',
            type: 'search',
            value: query,
            placeholder: t('search'),
            'aria-label': t('search'),
            onChange: (event) => setQuery(event.currentTarget.value),
            style: S.input,
          }),
        ]),
        visible.length === 0
          ? React.createElement('p', { key: 'empty', style: S.status }, t('empty'))
          : React.createElement('div', { key: 'groups', style: S.groups }, groupNodes),
        // Only reachable when the shell gave no primitives and the browser
        // asked instead; the dialog carries its own failure text.
        target === null && failure !== null
          ? React.createElement('p', { key: 'failure', role: 'alert', style: S.dialogError }, failure)
          : null,
        primitives === null
          ? null
          : React.createElement(DeleteDialog, {
              key: 'dialog',
              primitives,
              labels,
              title: target === null ? null : target.title,
              run: () => runDelete(target),
              onClose: () => setTarget(null),
            }),
      ])
    }

    // --------------------------------------------------------- row ⋮ menu item

    const ITEM_ATTR = 'data-session-cleaner-item'
    /** The session row menu is the only surface carrying BOTH of these. */
    const ARCHIVE_LABELS = ['归档会话', 'Archive session']
    const OTHER_MENU_LABELS = ['分叉会话', 'Fork session', '重命名', 'Rename']
    /** A ⋮ trigger's accessible name starts like this, in either language. */
    const TRIGGER_PREFIXES = ['会话“', 'Session actions for ']
    const TRIGGER_WINDOW_MS = 3000

    /** Innermost elements whose trimmed text is exactly one of `labels`. */
    function leafByText(root, labels) {
      const hits = []
      const consider = (element) => {
        if (element === null || element === undefined || element.nodeType !== 1) return
        const text = (element.textContent ?? '').trim()
        if (!labels.includes(text)) return
        const nested = [...element.children].some((child) => labels.includes((child.textContent ?? '').trim()))
        if (nested) return
        hits.push(element)
      }
      consider(root)
      if (typeof root.querySelectorAll === 'function')
        for (const element of root.querySelectorAll('*')) consider(element)
      return hits
    }

    /** Smallest element containing both nodes. */
    function commonAncestor(a, b) {
      let node = a
      while (node !== null && !node.contains(b)) node = node.parentElement
      return node
    }

    /**
     * Recognize the session row menu and its insertion anchor. Examines the
     * added subtree and, failing that, climbs from it — so the menu is found
     * whichever order its items mount in.
     */
    function findSessionMenu(added) {
      const archives = leafByText(added, ARCHIVE_LABELS)
      const others = leafByText(added, OTHER_MENU_LABELS)
      if (archives.length > 0 && others.length > 0) {
        return { menu: commonAncestor(archives[0], others[0]), anchor: archives[0] }
      }
      let node = added
      for (let depth = 0; depth < 6 && node !== null; depth++) {
        node = node.parentElement
        if (node === null || node === document.body) break
        const upArchives = leafByText(node, ARCHIVE_LABELS)
        const upOthers = leafByText(node, OTHER_MENU_LABELS)
        if (upArchives.length > 0 && upOthers.length > 0) {
          return { menu: commonAncestor(upArchives[0], upOthers[0]), anchor: upArchives[0] }
        }
      }
      return undefined
    }

    /** The menu's direct child that holds `element`. */
    function itemContainer(element, menu) {
      let node = element
      while (node.parentElement !== null && node.parentElement !== menu) node = node.parentElement
      return node.parentElement === menu ? node : undefined
    }

    /** The row's visible title. */
    function sessionTitle(rowEl) {
      const span = rowEl.querySelector('span[class*="title"]')
      return span?.textContent?.trim() ?? ''
    }

    /**
     * The row's session id, read from React's own bookkeeping: the row
     * component renders with the session node as a prop, and React attaches
     * its fiber to the host element.
     */
    function sessionIdFromReact(rowEl) {
      try {
        const key = Object.keys(rowEl).find(
          (name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'),
        )
        if (key === undefined) return undefined
        let fiber = rowEl[key]
        for (let depth = 0; depth < 10 && fiber !== null && fiber !== undefined; depth++) {
          const props = fiber.memoizedProps
          if (props !== null && typeof props === 'object') {
            const candidate = props.node?.id ?? props.sessionId ?? props.node?.sessionId
            if (typeof candidate === 'string' && candidate.length > 0) return candidate
          }
          fiber = fiber.return
        }
      } catch {
        /* internals changed — fall back to the catalog */
      }
      return undefined
    }

    /** Resolve {id, running, source} for a row, or undefined when unknown. */
    function resolveSession(rowEl, catalog) {
      const fromReact = sessionIdFromReact(rowEl)
      if (fromReact !== undefined) {
        const known = catalog?.byId?.get(fromReact)
        return { id: fromReact, running: known?.running === true, source: 'fiber' }
      }
      if (catalog === null || catalog === undefined) return undefined
      for (const span of rowEl.querySelectorAll('span')) {
        const text = (span.textContent ?? '').trim()
        if (text === '') continue
        const entries = catalog.byTitle.get(text)
        if (entries !== undefined && entries.length === 1) {
          return { id: entries[0].id, running: entries[0].running === true, source: 'title' }
        }
      }
      return undefined
    }

    /**
     * Title -> entries and id -> entry for the visible sessions. A convenience
     * only: id resolution prefers React's props, so a failed fetch costs the
     * running flag, not the feature.
     *
     * `/api/session/list` is the single transport, and every part of that call is
     * load-bearing:
     *   - the endpoint must be exactly two slash-separated segments; the
     *     gateway's `claimsEndpoint` rejects anything else before it looks the
     *     name up, so a dotted `session.list` is never claimed and never
     *     answers an envelope;
     *   - the payload must hold nothing but a plain-object `args`
     *     (`remoteRequest`);
     *   - and `args` must carry exactly the descriptor's parameter names — the
     *     host validates them (`assertExactArguments`). `session/list` takes one
     *     parameter, `_request` (`SessionListRequest`, whose only field is an
     *     optional `cursor`), so an unfiltered call is `{ _request: {} }`.
     * A call that misses any of the three is answered with the gateway's own
     * refusal envelope, which {@link fetchCatalog} reports rather than swallows.
     *
     * The `remote` service is the transport owner, not a namespace holder — a
     * browser remote namespace is its own `remote.<namespace>` service (DSH
     * 0.1.6-alpha.2 api-gateway `client.js`), so `ctx.get('remote').session`
     * never resolves, and reading it reflectively would make the catalog depend
     * on a service this plugin does not inject.
     */
    async function fetchCatalog() {
      const build = (items) => {
        const byTitle = new Map()
        const byId = new Map()
        for (const item of items ?? []) {
          if (item?.blank === true || item?.origin === 'subagent') continue
          const entry = { id: item.sessionId, running: item.running === true }
          if (typeof entry.id !== 'string' || entry.id.length === 0) continue
          byId.set(entry.id, entry)
          const title = item?.projections?.values?.title ?? item?.title
          if (typeof title !== 'string' || title === '') continue
          if (!byTitle.has(title)) byTitle.set(title, [])
          byTitle.get(title).push(entry)
        }
        return { byTitle, byId }
      }
      try {
        const response = await fetch('/api/session/list', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            type: 'client-request',
            rpcId: 'session-cleaner-' + Math.random().toString(36).slice(2),
            method: 'session/list',
            payload: { args: { _request: {} } },
          }),
        })
        const body = await response.json()
        // A refused call still comes back as the gateway's own envelope, so its
        // reason is reported here: a wrong endpoint or a wrong args shape used to
        // leave nothing behind but a null catalog.
        if (body?.result?.ok === false) {
          report('catalog-miss', {
            status: response.status,
            code: body.result.error?.code ?? null,
            message: body.result.error?.message ?? null,
          })
          return null
        }
        if (body?.result === undefined) {
          report('catalog-miss', { status: response.status, code: 'no-envelope', message: null })
          return null
        }
        return build(body.result?.value?.items)
      } catch (error) {
        report('catalog-miss', { status: null, code: 'transport', message: String(error?.message ?? error) })
        return null // no catalog; the caller reports it and the row keeps working
      }
    }

    function trashIcon() {
      const SVG_NS = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(SVG_NS, 'svg')
      for (const [k, v] of Object.entries({ width: '16', height: '16', viewBox: '0 0 16 16', fill: 'none' }))
        svg.setAttribute(k, v)
      for (const [tag, attrs] of [
        ['path', { d: 'M3 5h10', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round' }],
        ['path', { d: 'M6 5V3.6h4V5', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linejoin': 'round' }],
        [
          'path',
          { d: 'M4.6 5l.6 7.4h5.6L11.4 5', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linejoin': 'round' },
        ],
      ]) {
        const node = document.createElementNS(SVG_NS, tag)
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
        svg.appendChild(node)
      }
      return svg
    }

    /**
     * The kit's trash glyph as a DOM node, or null when it cannot be had. The
     * row ⋮ menu is imperative DOM with no React tree of its own, and a kit icon
     * takes only `{size, className}` — there is no markup to copy by hand — so
     * React renders the glyph into a scratch container, the SVG is lifted out of
     * it, and the scratch root is torn down: the item must not leave a React
     * root mounted behind it. Null keeps the hand-drawn SVG above in charge.
     */
    function kitTrashIcon(primitives) {
      const Icon = kitIcon(primitives, 'IconTrashOutline')
      if (Icon === null) return null
      try {
        const scratch = document.createElement('span')
        const root = require(REACT_DOM).createRoot(scratch)
        require(REACT_DOM_SYNC).flushSync(() => root.render(React.createElement(Icon, { size: 16 })))
        const glyph = scratch.firstElementChild
        const node = glyph === null ? null : glyph.cloneNode(true)
        root.unmount()
        return node
      } catch (error) {
        report('icon-fallback', { icon: 'IconTrashOutline', message: String(error?.message ?? error) })
        return null
      }
    }

    /** Insert the delete item directly below the archive item. */
    function augmentMenu(found, rowEl, catalog, ctx, dict) {
      const { menu, anchor } = found
      if (menu.querySelector(`[${ITEM_ATTR}]`) !== null) return true
      const container = itemContainer(anchor, menu)
      if (container === undefined) {
        report('skip', { reason: 'no-item-container' })
        return false
      }
      const session = resolveSession(rowEl, catalog)
      if (session === undefined) {
        report('skip', { reason: 'unresolved-session', title: sessionTitle(rowEl) })
        return false
      }

      const running = session.running === true
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute(ITEM_ATTR, '1')
      item.disabled = running
      item.title = running ? dict.menuDeleteDisabled : dict.menuDelete
      item.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:8px',
        'width:100%',
        'padding:6px 12px',
        'border:none',
        'background:none',
        'color:var(--dsw-alias-state-error-primary, #d64545)',
        'font:inherit',
        'font-size:13px',
        'text-align:left',
        'cursor:' + (running ? 'default' : 'pointer'),
        'opacity:' + (running ? '0.45' : '1'),
      ].join(';')
      const label = document.createElement('span')
      label.textContent = dict.menuDelete
      // The kit's own glyph when the shell handed one over, else the hand-drawn
      // SVG: `loadPrimitives` is the guard the dialog next to it already uses.
      item.append(kitTrashIcon(loadPrimitives(require)) ?? trashIcon(), label)
      item.addEventListener('mouseenter', () => {
        if (!running) item.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))'
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = 'none'
      })
      item.addEventListener('click', async (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (running) return
        const title = sessionTitle(rowEl) || session.id
        const deleted = await deleteWithDialog({
          require,
          labels: dict.labels,
          title,
          run: () => requestDelete(session.id).then(() => forgetDeleted(ctx, session.id)),
        })
        report('menu-delete', { id: session.id, ok: deleted, source: session.source })
      })
      container.after(item)
      report('menu-item-added', { id: session.id, running, source: session.source })
      return true
    }

    /**
     * Watch for the row menu opening and augment it. The row comes from the ⋮
     * trigger the user just pressed; the menu is identified by its labels.
     */
    function installMenuEntry(ctx, dict) {
      let pendingRow = null
      let pendingAt = 0
      let catalog = null

      const onPointerDown = (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        const row = target.closest('[role="treeitem"]')
        if (row === null) return
        const trigger = target.closest('button')
        if (trigger === null) return
        const name = trigger.getAttribute('aria-label') ?? ''
        const isRowTrigger =
          TRIGGER_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
          trigger.closest('[class*="rowActions"]') !== null
        if (!isRowTrigger) {
          report('trigger-ignored', { name: name.slice(0, 60) })
          return
        }
        pendingRow = row
        pendingAt = Date.now()
        report('trigger', { name: name.slice(0, 60) })
      }

      const attempt = (added) => {
        const found = findSessionMenu(added)
        if (found === undefined) return
        report('menu-found', { archive: (found.anchor.textContent ?? '').trim().slice(0, 40) })
        const fresh = pendingRow !== null && pendingRow.isConnected && Date.now() - pendingAt <= TRIGGER_WINDOW_MS
        const row = fresh ? pendingRow : found.menu.closest('[role="treeitem"]')
        if (row === null || row === undefined) {
          report('skip', { reason: 'no-row', fresh })
          return
        }
        if (augmentMenu(found, row, catalog, ctx, dict)) {
          pendingRow = null
          return
        }
        fetchCatalog()
          .then((resolved) => {
            catalog = resolved
            if (found.menu.isConnected) augmentMenu(found, row, catalog, ctx, dict)
          })
          .catch(() => {})
      }

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue
            attempt(node)
          }
        }
      })
      document.addEventListener('pointerdown', onPointerDown, true)
      observer.observe(document.body, { childList: true, subtree: true })
      fetchCatalog()
        .then((resolved) => {
          catalog = resolved
          report('catalog', { ok: resolved !== null, known: resolved === null ? 0 : resolved.byId.size })
        })
        .catch(() => {})
      report('install', { ok: true })

      ctx.effect(
        () => () => {
          observer.disconnect()
          document.removeEventListener('pointerdown', onPointerDown, true)
        },
        'session-cleaner: menu observer',
      )
    }

    // ------------------------------------------------------------------ entry

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-cleaner: dictionaries')
      const t = ctx.locale.bind(NS)
      const primitives = loadPrimitives(require)
      report('primitives', { ok: primitives !== null })
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'session-cleaner',
            order: 30,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({
              t,
              primitives,
              uiWorkspace: ctx.uiWorkspace,
              forget: (sessionId) => forgetDeleted(ctx, sessionId),
            }),
          },
          SessionCleanerSection,
        ),
      )
      report('section-registered', { id: 'session-cleaner' })

      const dict = {
        menuDelete: t('menuDelete'),
        menuDeleteDisabled: t('menuDeleteDisabled'),
        labels: deleteLabels(t),
      }
      const start = () => {
        try {
          installMenuEntry(ctx, dict)
        } catch (error) {
          report('install-failed', { message: String(error?.message ?? error) })
        }
      }
      if (document.body === null) {
        document.addEventListener('DOMContentLoaded', start, { once: true })
      } else {
        start()
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
