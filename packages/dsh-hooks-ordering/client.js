// dsh-hooks-ordering — client half (classic script, no build step).
//
// dsh renders a settings UI from the CLIENT plane: a host-side
// `settings.register(ns, schema)` only creates the namespace, its storage and
// its descriptor. The form itself is a slot contribution, so this file
// registers one settings page for the `hooks-ordering` namespace.
//
// Two conventions are load-bearing and both come from how the harness loads
// this file:
//
//   - `id` must be the PACKAGE NAME. The host fetches /plugins/<package>/client.js
//     from the __DSH_BOOT__ graph and then asserts that the loaded bundle
//     registered that id. A short name throws during mount and nothing renders.
//   - the file is a classic script, so it has no import/export: React arrives
//     through the synchronous `require` handed to the factory.
//
// Writes go through two path-addressed ops rather than a scalar setter: the
// fields are string arrays, and `{op:'set'|'unset', path}` says exactly what is
// meant for both save and reset. They are sent to the settings Remote namespace
// (`ctx.remote.settings.mutate`), which resolves them against the stored section
// rather than against whatever this page last read.
//
// The namespace is `applies: 'restart'`, so the page says so instead of
// pretending a save took effect immediately.
//
// All user-visible copy lives in the plugin's own zh/en dictionaries
// (namespace `hooks-ordering`, matching the settings namespace) and the nav
// label is a thunk through the bound translator, so the settings navigation
// follows the shell's language. `ctx.locale` is injected; a context without it
// falls back to the Chinese copy rather than throwing.
//
// The IIFE keeps the pure helpers in one private scope: a classic script's
// top-level declarations would become page globals, and leaving them inside the
// factory would recreate them per call.
;(function () {
  /** @param value - a settings field; @returns its textarea form, one entry per line. */
  function toLines(value) {
    return Array.isArray(value) ? value.join('\n') : ''
  }

  /** @param text - textarea content; @returns the trimmed, blank-free entries. */
  function fromLines(text) {
    return String(text == null ? '' : text)
      .split('\n')
      .map(function (line) {
        return line.trim()
      })
      .filter(function (line) {
        return line.length > 0
      })
  }

  /** @param value - current value; @param text - draft text; @returns whether they describe the same list. */
  function sameLines(value, text) {
    return toLines(value) === fromLines(text).join('\n')
  }

  /**
   * @param template - a dictionary entry, `{name}` placeholders.
   * @param params - placeholder values, or absent for the raw template.
   * @returns the template with every supplied placeholder replaced, matching
   * the shell LocaleRuntime.translate rules (an unsupplied placeholder stays).
   */
  function interpolate(template, params) {
    if (!params) return template
    return String(template).replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    })
  }

  // eslint-disable-next-line no-underscore-dangle -- the loader's own global; the name is not ours to choose.
  window.__ModuleLoader__.load({
    id: '@zfdx123/dsh-hooks-ordering',
    factory: function (require) {
      var module = { exports: {} }
      var exports = module.exports
      var React = require('react')
      var e = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect
      var useRef = React.useRef

      var NS = 'hooks-ordering'
      var CLASS = 'dsh-hooks-ordering'
      var STYLE_ID = 'dsh-hooks-ordering-style'

      // ── locale ─────────────────────────────────────────────────────────────
      // Every user-visible string in this half lives in the two dictionaries
      // below, registered under the plugin's own namespace (the same one the
      // settings scope uses). The nav label is a thunk: the shell never
      // subscribes locale state, it re-renders the nav on a locale switch and
      // calls label() again, so the thunk always answers in the active
      // language.
      //
      // `ctx.locale` is a required service, but this file still degrades: when
      // the service is absent (a composition without the locale plugin, or the
      // stub context the Node tests hand in) the translator falls back to the
      // plugin's own Chinese copy and the page registers and renders as before.
      var zh = {
        nav: '钩子排序',
        intro: '协调器接管这些钩子，让参与者用 before/after 声明顺序，而不是听天由命于插件加载顺序。',
        loading: '正在读取设置…',
        unavailable: '命名空间 hooks-ordering 未暴露给本客户端：请确认插件已加载，且当前是 web profile。',
        fieldHooks: 'waterfall 钩子（每行一个）',
        fieldSerialHooks: 'serial 钩子（每行一个）',
        fieldLog: '约束 DAG 日志文件（留空即不记录）',
        note: '改动在重启 dsh 后生效（hooks/serialHooks 的变更需要重新挂载钩子）。清空某字段即回到 schema 默认值。',
        saveFailed: '保存失败：{message}',
        saving: '保存中…',
        save: '保存',
        reset: '恢复组合默认',
        readonly: '当前连接的设置存储是只读的。',
      }
      var en = {
        nav: 'Hook ordering',
        intro:
          'The coordinator takes over these hooks so participants declare their order with before/after instead of leaving it to plugin load order.',
        loading: 'Reading settings…',
        unavailable:
          'The hooks-ordering namespace is not exposed to this client: check that the plugin is loaded and that this is the web profile.',
        fieldHooks: 'Waterfall hooks (one per line)',
        fieldSerialHooks: 'Serial hooks (one per line)',
        fieldLog: 'Constraint DAG log file (leave empty to log nothing)',
        note: 'Changes take effect after dsh restarts (editing hooks/serialHooks re-mounts the hook brackets). Clearing a field returns it to the schema default.',
        saveFailed: 'Save failed: {message}',
        saving: 'Saving…',
        save: 'Save',
        reset: 'Restore composition defaults',
        readonly: 'The connected settings store is read-only.',
      }

      /** Fallback translator: the plugin's own Chinese copy (a missing key shows the key, as the shell does). */
      function translateZh(key, params) {
        return interpolate(Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key, params)
      }

      // The active translator: Chinese by default, replaced by the locale
      // service's bound t when it is available. Components read it at render
      // time, so a locale switch shows through on the next render.
      var t = translateZh

      /** Register both dictionaries and bind the translator; stays on Chinese if the service is missing or refuses. */
      function bindLocale(ctx) {
        var locale = ctx && ctx.locale
        if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') {
          // No locale service: answer in the plugin's own Chinese copy (this
          // apply's context decides, even if an earlier one had bound a
          // translator).
          t = translateZh
          return
        }
        try {
          ctx.effect(function () {
            return locale.register(NS, { zh: zh, en: en })
          }, 'hooks-ordering: dictionaries')
          t = locale.bind(NS)
        } catch {
          // e.g. the namespace is already occupied by another instance. That
          // must not take the whole settings page down.
          t = translateZh
        }
      }

      // ── shell primitives ───────────────────────────────────────────────────
      // The shell ships its UI kit in the module-table baseline
      // (@deepseek-ai/dsh-client-ui-primitives), so this plugin asks for it
      // directly instead of hand-rolling buttons and chips: the shell's own
      // settings pages, confirmations and toasts are built from the same atoms,
      // which is what lines up focus rings, disabled states, transitions and
      // accessibility semantics with the shell.
      //
      // The require is guarded. A module-table miss throws, and a throw inside
      // the factory would take the whole plugin down, so the shape is checked and
      // every failure returns null. Each primitive used below then has a
      // plain-element fallback with the same props contract, which renders the
      // pre-kit appearance instead of a blank page.
      var PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'
      // Why the kit could not be taken ('' when it was): kept for diagnostics and
      // so a Node test can prove the guard caught a real error rather than a
      // missing branch.
      var primitivesError = ''
      var UI = loadPrimitives()

      function loadPrimitives() {
        try {
          var primitives = require(PRIMITIVES)
          if (
            primitives &&
            typeof primitives.Button === 'function' &&
            typeof primitives.Input === 'function' &&
            typeof primitives.Tag === 'function' &&
            typeof primitives.StateDot === 'function'
          ) {
            return primitives
          }
          return null
        } catch (error) {
          // No such entry in the module table (or the require was refused): record
          // the reason, then render the plugin's own elements instead.
          primitivesError = String((error && error.message) || error)
          return null
        }
      }

      // ── controls: the kit when it is there, the plugin's own elements when not ─

      /** Button element. `variant` is the shell's primary/outline family. */
      function button(props, children) {
        if (UI !== null) {
          return e(
            UI.Button,
            {
              key: props.key,
              variant: props.variant || 'outline',
              size: 'sm',
              disabled: props.disabled,
              title: props.title,
              onClick: props.onClick,
            },
            children,
          )
        }
        return e(
          'button',
          {
            key: props.key,
            type: 'button',
            className: props.variant === 'primary' ? 'ho-fallback-btn ho-primary' : 'ho-fallback-btn',
            disabled: props.disabled,
            title: props.title,
            onClick: props.onClick,
          },
          children,
        )
      }

      /**
       * Single-line field element. The fallback deliberately carries no class: the
       * stylesheet's `input:not([class])` rule colours the plugin's own fields,
       * while the shell Input's own <input> carries the shell's class.
       */
      function textInput(props) {
        if (UI !== null) {
          return e(UI.Input, {
            className: 'ho-input',
            id: props.id,
            type: 'text',
            value: props.value,
            disabled: props.disabled,
            onChange: props.onChange,
          })
        }
        return e('input', {
          id: props.id,
          type: 'text',
          value: props.value,
          disabled: props.disabled,
          onChange: props.onChange,
        })
      }

      /** Tag element (read-only chip). Keeps its own class on both paths. */
      function tag(tone, children, className) {
        if (UI !== null) return e(UI.Tag, { tone: tone, className: className }, children)
        return e('span', { className: className ? 'ho-tag ' + className : 'ho-tag' }, children)
      }

      /** State dot element; the text it belongs to is always rendered beside it. */
      function dot(state) {
        if (UI !== null) return e(UI.StateDot, { state: state, size: 10 })
        return e('span', { className: 'ho-dot ho-dot-' + state })
      }

      // ── theme ──────────────────────────────────────────────────────────────
      // The shell defines its design tokens on <body> (light) and
      // <body[data-ds-dark-theme]> (dark), so var(--dsw-alias-*) resolves here.
      // The shell never declares color-scheme, so native controls (textarea
      // internals, scrollbars, select popups) would stay light in dark mode:
      // this block pins color-scheme per theme and gives every token a fallback.
      var CSS = [
        '.' + CLASS + '{',
        'color-scheme:light;',
        '--ho-fg:var(--dsw-alias-label-primary,#0f1115);',
        '--ho-fg-2:var(--dsw-alias-label-secondary,#61666b);',
        '--ho-border:var(--dsw-alias-border-l2,rgba(0,0,0,.1));',
        '--ho-field:var(--dsw-alias-bg-layer-2,#f9fafb);',
        '--ho-accent:var(--dsw-alias-button-primary-fill,#0f1115);',
        '--ho-accent-fg:var(--dsw-alias-label-primary-foreground,#fff);',
        'color:var(--ho-fg);',
        '}',
        'body[data-ds-dark-theme] .' + CLASS + '{',
        'color-scheme:dark;',
        '--ho-fg:var(--dsw-alias-label-primary,#ebeef2);',
        '--ho-fg-2:var(--dsw-alias-label-secondary,#adb2b8);',
        '--ho-border:var(--dsw-alias-border-l2,rgba(255,255,255,.14));',
        '--ho-field:var(--dsw-alias-bg-layer-3,#232326);',
        '--ho-accent:var(--dsw-alias-button-primary-fill,#ebeef2);',
        '--ho-accent-fg:var(--dsw-alias-label-primary-foreground,#151517);',
        '}',
        '.' + CLASS + '{display:flex;flex-direction:column;gap:18px;padding:4px 2px;font-size:13px;line-height:1.55}',
        '.' + CLASS + ' h3{margin:0;font-size:14px;font-weight:600}',
        '.' + CLASS + ' p{margin:0;color:var(--ho-fg-2)}',
        '.' + CLASS + ' label{display:block;font-weight:600;margin-bottom:6px}',
        // 只给插件自己的控件上色：原生 Input 的 <input> 自带外壳的 class（配色由外壳
        // 管），所以这条用 input:not([class]) 把两者分开。
        '.' + CLASS + ' textarea,.' + CLASS + ' input:not([class]){',
        'width:100%;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
        'font-size:12px;line-height:1.6;padding:8px 10px;border-radius:8px;',
        'border:1px solid var(--ho-border);background:var(--ho-field);color:var(--ho-fg);resize:vertical}',
        // 原生 Input 的包装层撑满栏宽，内部输入沿用这份等宽字体（路径/命令列一致的观感）。
        '.' + CLASS + ' .ho-input{width:100%}',
        '.' +
          CLASS +
          ' .ho-input input{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
        '.' + CLASS + ' .ho-row{display:flex;gap:8px;align-items:center}',
        // 只给降级路径自带的按钮加样式：外壳的 Button 自带 hover/active/disabled 与
        // 过渡，再叠一层边框和主色反而跟外壳不一致。
        '.' + CLASS + ' .ho-fallback-btn{',
        'font:inherit;font-size:13px;padding:6px 14px;border-radius:8px;cursor:pointer;',
        'border:1px solid var(--ho-border);background:transparent;color:var(--ho-fg)}',
        '.' +
          CLASS +
          ' .ho-fallback-btn.ho-primary{background:var(--ho-accent);color:var(--ho-accent-fg);border-color:transparent}',
        '.' + CLASS + ' .ho-fallback-btn:disabled{opacity:.5;cursor:default}',
        '.' + CLASS + ' .ho-note{font-size:12px;color:var(--ho-fg-2)}',
        // 降级路径的标签与状态点（拿不到外壳 Tag/StateDot 时用插件自己的配色画）。
        '.' +
          CLASS +
          ' .ho-tag{display:inline-flex;align-items:center;padding:1px 8px;border:1px solid var(--ho-border);border-radius:999px;font-size:12px;color:var(--ho-fg-2);white-space:nowrap}',
        '.' + CLASS + ' .ho-status{display:flex;align-items:flex-start;gap:6px}',
        // 失败文案可能很长，外壳 Tag 默认 nowrap，这里放开换行，避免撑破设置栏。
        '.' + CLASS + ' .ho-status-tag{white-space:normal}',
        '.' +
          CLASS +
          ' .ho-dot{display:inline-block;width:10px;height:10px;flex:none;margin-top:5px;border-radius:50%;background:var(--ho-fg-2)}',
        '.' + CLASS + ' .ho-dot-error{background:var(--dsw-alias-state-error-primary,#ef4444)}',
      ].join('')

      function ensureStyles() {
        var existing = document.getElementById(STYLE_ID)
        if (existing) return existing
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return style
      }

      /**
       * The name this plugin's settings entry actually has, resolved at runtime
       * from the descriptors the host returns.
       *
       * It CANNOT be a constant. The settings namespace is the **loader entry
       * id**, which belongs to whoever wrote the row that mounted this plugin,
       * not to the plugin: the aggregator's `cordis.patch.yml` uses
       * `dsh-plugin-hooks-ordering`, while this package's own patch uses
       * `hooks-ordering`. Hardcoding the latter against the former produced
       *
       *   no settings entry is named "hooks-ordering" (describe() returned: …, dsh-plugin-hooks-ordering, …)
       *
       * and the write path was refused outright:
       *
       *   settings/rejected: No configurable plugin entry "hooks-ordering"
       *
       * Matching on the descriptor's own `ns` removes the guesswork: whatever id
       * the mounting row has, this is the entry it produced.
       */
      var resolvedNs = null

      /**
       * Normalise a Remote answer to `{ ok, value }` / `{ ok: false, reason }`.
       *
       * The 0.1.7 Remote protocol answers every call with a `RemoteResult`
       * envelope and the client proxy hands that envelope through as-is, so a
       * caller that reads fields off the answer directly sees `undefined` while
       * the wire traffic is healthy. A plain value is accepted too, so this
       * keeps working if a future runtime unwraps for us.
       *
       * @param answer - whatever the Remote call resolved to.
       * @returns the unwrapped outcome.
       */
      function unwrapRemote(answer) {
        if (answer !== null && typeof answer === 'object' && typeof answer.ok === 'boolean') {
          if (answer.ok === false) {
            var failure = answer.error
            var reason =
              failure && typeof failure === 'object'
                ? String(failure.code || 'remote error') + ': ' + String(failure.message || '')
                : String(failure || 'remote error')
            return { ok: false, reason: reason }
          }
          return { ok: true, value: answer.value }
        }
        return { ok: true, value: answer }
      }

      /**
       * @param list - descriptor list from `describe()`.
       * @returns the descriptor for this plugin, or undefined.
       */
      function pickEntry(list) {
        // Fast path: the row used this package's own documented id.
        var direct = list.find(function (entry) {
          return entry && entry.ns === NS
        })
        if (direct !== undefined) return direct
        // Otherwise take the entry that was mounting this plugin created.
        // `dsh-plugin-hooks-ordering` is the shipped aggregator row; the suffix
        // test also covers a user's own row name.
        var suffixed = list.filter(function (entry) {
          return entry && typeof entry.ns === 'string' && entry.ns.slice(-NS.length) === NS
        })
        return suffixed.length === 1 ? suffixed[0] : undefined
      }

      // ── the settings page ──────────────────────────────────────────────────

      /**
       * Interpret the setting page's view of one entry.
       *
       * Three inputs can describe it: an already-assembled view (`{status,
       * value, ...}`), a raw settings descriptor (`{ns, value, revision}`), or
       * nothing at all.
       *
       * @param raw - one of the shapes above, or null/undefined.
       * @returns a view this page can render, or `null` when there is no entry.
       */
      function normaliseSnapshot(raw) {
        if (raw === null || raw === undefined) return null
        var writable = raw.writable !== false
        if (raw.status === 'unavailable' || raw.available === false) {
          return {
            status: 'unavailable',
            available: false,
            writable: false,
            revision: undefined,
            value: null,
            base: {},
            reason: raw.reason,
          }
        }
        return {
          status: 'ready',
          available: true,
          writable: writable,
          revision: raw.revision,
          value: raw.value || null,
          base: raw.base || {},
        }
      }

      /**
       * Adapt the 0.1.7 `ctx.remote.settings` namespace to the snapshot surface
       * this page renders from.
       *
       * 0.1.6 exposed a `settingsScope` service that answered snapshots
       * synchronously. 0.1.7 removed it: a page now talks to the settings
       * Remote, whose `describe()`/`mutate()` are async and keyed by the
       * profile entry id. This adapter resolves the descriptor once, re-resolves
       * it on the host's `settings/document-updated` notification.
       *
       * @param ctx - the plugin context (provides `remote`).
       */
      function createSettingsSource(ctx) {
        var remote = ctx && ctx.remote && ctx.remote.settings
        /**
         * The name this plugin's settings entry actually has is resolved at
         * runtime by {@link pickEntry} into the module-level `resolvedNs`; see
         * the note there for why it cannot be a constant.
         */

        /**
         * Why the form has no data. Kept as a concrete, user-visible string:
         * "not available" on its own made a wiring fault indistinguishable from
         * a not-yet-mounted host half, and that cost a lot of blind debugging.
         */
        function unavailableBecause(reason) {
          return {
            status: 'unavailable',
            available: false,
            writable: false,
            value: null,
            revision: undefined,
            reason: reason,
          }
        }

        /**
         * @returns a promise of the current descriptor view, or of an
         * `unavailable` view carrying the concrete reason.
         */
        function read() {
          if (!ctx || !ctx.remote) {
            return Promise.resolve(unavailableBecause('ctx.remote is not injected'))
          }
          if (!remote) {
            return Promise.resolve(unavailableBecause('the ctx.remote.settings namespace is absent'))
          }
          if (typeof remote.describe !== 'function') {
            return Promise.resolve(unavailableBecause('ctx.remote.settings.describe is not a function'))
          }
          return Promise.resolve()
            .then(function () {
              return remote.describe()
            })
            .then(function (answer) {
              // A Remote call answers with a `RemoteResult` envelope
              // (`{ok:true, value}` / `{ok:false, error}`) and the client proxy
              // does NOT unwrap it: reading `answer.namespaces` directly got
              // `undefined`, which surfaced as the misleading
              // "describe() returned no namespaces array" while the network
              // exchange was perfectly healthy (ok:true, 20 namespaces).
              var result = unwrapRemote(answer)
              if (result.ok === false) {
                return unavailableBecause('describe() failed: ' + result.reason)
              }
              var value = result.value
              if (value === null || value === undefined) {
                return unavailableBecause('describe() returned no value')
              }
              var list = Array.isArray(value.namespaces) ? value.namespaces : null
              if (list === null) {
                return unavailableBecause(
                  'describe() value has no namespaces array (keys: ' + Object.keys(value).join(', ') + ')',
                )
              }
              var found = pickEntry(list)
              if (found === undefined) {
                var seen = list
                  .map(function (entry) {
                    return entry && entry.ns
                  })
                  .filter(Boolean)
                  .join(', ')
                return unavailableBecause(
                  'no settings entry for this plugin (looked for "' +
                    NS +
                    '"; describe() returned: ' +
                    (seen || 'nothing') +
                    ')',
                )
              }
              resolvedNs = found.ns
              return {
                status: 'ready',
                available: true,
                // The provider's writability gates the whole form; a read-only
                // deployment still shows the effective values.
                writable: answer.writable !== false,
                value: found.value || null,
                revision: found.revision,
                base: {},
              }
            }, function (failure) {
              return unavailableBecause(
                'describe() failed: ' + String((failure && failure.message) || failure),
              )
            })
        }

        return {
          available: remote !== undefined && typeof remote.describe === 'function',
          /**
           * @param ops - `SettingsPathOp` list, e.g. `{op:'set', path, value}`.
           * @returns a promise resolving to the refreshed view.
           */
          mutate: function (ops) {
            if (!remote || typeof remote.mutate !== 'function') {
              return Promise.reject(new Error('settings remote is unavailable in this deployment'))
            }
            // The revision is read fresh immediately before the write so a page
            // left open across another edit reports a conflict instead of
            // silently overwriting it. `read()` also refreshes `resolvedNs`.
            return read().then(function (snap) {
              if (!snap.available) {
                throw new Error(snap.reason || 'this plugin has no settings entry in the active profile')
              }
              if (resolvedNs === null) {
                throw new Error('this plugin did not resolve its settings entry id')
              }
              // The write answers with a RemoteResult envelope as well; unwrap
              // it so a refusal surfaces as a real message instead of looking
              // like a successful save.
              return remote.mutate(resolvedNs, ops, snap.revision).then(function (answer) {
                var result = unwrapRemote(answer)
                if (result.ok === false) throw new Error(result.reason)
                return result.value
              })
            })
          },
          /**
           * @param listener - called after every host-side change to this entry.
           * @returns an unsubscribe function.
           */
          subscribe: function (listener) {
            // The event surface lives on `ctx.remote` itself, not on the
            // namespace: a shipped settings page listens as
            // `ctx.remote.$on('credentials/reference-updated', …)` while
            // declaring `inject: ['remote', 'remote.<ns>']`.
            var events = ctx && ctx.remote
            if (!events || typeof events.$on !== 'function') return function () {}
            try {
              return events.$on('settings/document-updated', function (ns) {
                // Match the resolved entry id, not the package-relative name.
                if (ns === undefined || ns === resolvedNs || ns === NS) listener()
              })
            } catch (error) {
              // A missing gateway listener must not take the page down.
              return function () {}
            }
          },
          read: read,
        }
      }

      /** @param props - the section owner props plus the plugin context. */
      function SettingsSection(props) {
        var ctx = props.ctx
        // A host that can answer synchronously may hand the view over directly;
        // against the real shell this is undefined and the page reads the
        // settings Remote instead.
        var seed = normaliseSnapshot(props.settingsSnapshot)
        var sourceRef = useRef(null)
        if (sourceRef.current === null) sourceRef.current = createSettingsSource(ctx)
        var source = sourceRef.current

        var snapState = useState(seed)
        var snap = snapState[0]
        var setSnap = snapState[1]

        var draftState = useState({ hooks: '', serialHooks: '', log: '' })
        var draft = draftState[0]
        var setDraft = draftState[1]

        var dirtyRef = useRef(false)
        var busyState = useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]
        var errorState = useState('')
        var error = errorState[0]
        var setError = errorState[1]

        useEffect(
          function () {
            var alive = true
            function refresh() {
              source.read().then(
                function (next) {
                  if (alive) setSnap(next)
                },
                function (failure) {
                  if (alive) setError(String((failure && failure.message) || failure))
                },
              )
            }
            // A supplied snapshot is already the current view; only the Remote
            // path needs the initial round trip.
            if (seed === null) refresh()
            var off = source.subscribe(refresh)
            return function () {
              alive = false
              off()
            }
          },
          [source],
        )

        // Re-seed the editor from every accepted snapshot, but never over an
        // unsaved edit: the user's typing outranks a background refresh.
        var revision = snap ? snap.revision : undefined
        useEffect(
          function () {
            if (dirtyRef.current || snap === null) return
            var value = snap.value || {}
            setDraft({ hooks: toLines(value.hooks), serialHooks: toLines(value.serialHooks), log: value.log || '' })
          },
          [revision, snap],
        )

        /** @param fieldName - settings field to edit; @param next - its new textarea content. */
        function edit(fieldName, next) {
          dirtyRef.current = true
          setDraft(function (prev) {
            var updated = { hooks: prev.hooks, serialHooks: prev.serialHooks, log: prev.log }
            updated[fieldName] = next
            return updated
          })
        }

        function settle(pending) {
          setBusy(true)
          setError('')
          pending.then(
            function () {
              dirtyRef.current = false
              setBusy(false)
            },
            function (failure) {
              setBusy(false)
              setError(String((failure && failure.message) || failure))
            },
          )
        }

        function save() {
          var value = (snap && snap.value) || {}
          var ops = []
          if (!sameLines(value.hooks, draft.hooks)) {
            ops.push({ op: 'set', path: ['hooks'], value: fromLines(draft.hooks) })
          }
          if (!sameLines(value.serialHooks, draft.serialHooks)) {
            ops.push({ op: 'set', path: ['serialHooks'], value: fromLines(draft.serialHooks) })
          }
          if ((value.log || '') !== draft.log) {
            ops.push({ op: 'set', path: ['log'], value: draft.log })
          }
          if (ops.length === 0) return
          settle(source.mutate(ops))
        }

        /** Send every field back to the composition default (the schema default). */
        function reset() {
          settle(
            source.mutate([
              { op: 'unset', path: ['hooks'] },
              { op: 'unset', path: ['serialHooks'] },
              { op: 'unset', path: ['log'] },
            ]),
          )
        }

        // Unknown until the descriptor arrives; a read-only provider disables
        // the whole form rather than letting the user type into a dead editor.
        var writable = snap !== null && snap.writable

        /**
         * @param label - field caption.
         * @param key - settings field name.
         * @param text - current draft content.
         * @param rows - textarea height in rows.
         *
         * The hook lists are multi-line, and the kit's Input renders a single-line
         * <input>, so these keep the plugin's own textarea (same rows, same
         * monospace styling); the single-line log path below uses the shell Input.
         */
        function renderListField(label, key, text, rows) {
          return e(
            'div',
            { key: key },
            e('label', { htmlFor: CLASS + '-' + key }, label),
            e('textarea', {
              id: CLASS + '-' + key,
              rows: rows,
              spellCheck: false,
              value: text,
              disabled: !writable,
              onChange: function (event) {
                edit(key, event.target.value)
              },
            }),
          )
        }

        /**
         * @param label - field caption.
         * @param key - settings field name.
         * @param text - current draft content.
         *
         * A one-line field (a file path), so the shell's Input is the honest control.
         */
        function renderLineField(label, key, text) {
          return e(
            'div',
            { key: key },
            e('label', { htmlFor: CLASS + '-' + key }, label),
            textInput({
              id: CLASS + '-' + key,
              value: text,
              disabled: !writable,
              onChange: function (event) {
                edit(key, event.target.value)
              },
            }),
          )
        }

        var current = (snap && snap.value) || {}

        var dirty =
          !sameLines(current.hooks, draft.hooks) ||
          !sameLines(current.serialHooks, draft.serialHooks) ||
          (current.log || '') !== draft.log

        // Three states: the descriptor has not arrived yet, this deployment has
        // no settings entry for the plugin, or the form is ready.
        var body
        if (snap === null) {
          body = e('p', null, t('loading'))
        } else if (!snap.available) {
          // Print the concrete cause next to the headline: the generic sentence
          // alone could not tell a wiring fault from an unmounted host half.
          body = e(
            'div',
            null,
            e('p', null, t('unavailable')),
            snap.reason ? e('p', { className: 'ho-note' }, String(snap.reason)) : null,
          )
        } else {
          body = e(
            'div',
            { className: CLASS },
            renderListField(t('fieldHooks'), 'hooks', draft.hooks, 8),
            renderListField(t('fieldSerialHooks'), 'serialHooks', draft.serialHooks, 3),
            renderLineField(t('fieldLog'), 'log', draft.log),
          )
        }

        return e(
          'div',
          { className: CLASS },
          e('h3', null, t('nav')),
          e('p', null, t('intro')),
          body,
          e('p', { className: 'ho-note' }, t('note')),
          error ? saveFailedStatus(error) : null,
          e(
            'div',
            { className: 'ho-row' },
            button(
              {
                variant: 'primary',
                disabled: busy || !dirty || !writable,
                onClick: save,
              },
              busy ? t('saving') : t('save'),
            ),
            button({ disabled: busy || !writable, onClick: reset }, t('reset')),
          ),
          writable ? null : e('div', { className: 'ho-status' }, tag('warning', t('readonly'))),
        )
      }

      /**
       * @param message - the failure text reported by the settings write.
       * @returns the save-failure status: the shell's StateDot + Tag when the kit is
       * there, the plugin's own chip when it is not.
       */
      function saveFailedStatus(message) {
        return e(
          'div',
          { className: 'ho-status' },
          dot('error'),
          tag('danger', t('saveFailed', { message: message }), 'ho-status-tag'),
        )
      }

      // ── plugin ─────────────────────────────────────────────────────────────
      // 'remote.settings' is a required service: the settings Remote namespace
      // is how a 0.1.7 page reads and writes its entry. Without it the page is
      // not registered at all, rather than rendering an editor that cannot save.
      // 0.1.6 exposed `settingsScope` instead; that service no longer exists, so
      // naming it here would leave this plugin permanently pending.
      var inject = ['slots', 'remote', 'remote.settings', 'locale']

      /** @param ctx - the client plugin context. */
      function apply(ctx) {
        bindLocale(ctx)
        var style = ensureStyles()
        ctx.effect(function () {
          return function () {
            style.remove()
          }
        })
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'hooks-ordering',
              order: 27,
              // A thunk: the shell re-renders the nav and calls it again after a
              // locale switch, so it always answers in the active language.
              label: function () {
                return t('nav')
              },
            },
            function Bound(props) {
              return e(SettingsSection, Object.assign({}, props, { ctx: ctx }))
            },
          )
        })
      }

      // The browser loader consumes only apply/inject; the rest exists so a Node
      // test can load this file with a stub `window` and assert the contract.
      exports.apply = apply
      exports.inject = inject
      exports.NS = NS
      exports.pickEntry = pickEntry
      exports.unwrapRemote = unwrapRemote
      exports.CLASS = CLASS
      exports.CSS = CSS
      exports.ZH = zh
      exports.EN = en
      // The shell kit, or null when the module table did not hand it over; exported
      // so a Node test can assert which path the render took (UI_ERROR carries the
      // reason when the load failed).
      exports.UI = UI
      exports.UI_ERROR = primitivesError
      exports.SettingsSection = SettingsSection
      exports.saveFailedStatus = saveFailedStatus
      exports.fromLines = fromLines
      exports.toLines = toLines
      exports.sameLines = sameLines
      return module.exports
    },
  })
})()
