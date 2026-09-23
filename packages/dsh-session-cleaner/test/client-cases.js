// Client-half cases for `client.js`.
//
// The browser bundle is loaded behind a minimal `window.__ModuleLoader__` shim
// plus a hand-rolled React stand-in. Real React semantics are what make this
// work, so the stand-in copies the parts the bundle relies on: `props.children`,
// function components that expand when they are created, and hook slots that
// survive a re-render and re-render on a setter. The Settings page is driven
// completely headlessly — no browser, no DOM, no test framework.
//
// The regressions these cases exist for:
//   - deleting a session must also remove its row from the CLIENT session store.
//     The host's only removal notification is `session/disposed`, and the host
//     emits it solely for an ANNOUNCED live entry — an open, agent-attached
//     session, which this plugin refuses to delete. A deleted cold session holds
//     no live entry and emits nothing, so the row would linger.
//   - the confirmation must be the app's own dialog, never `window.confirm` /
//     `window.alert`.
//   - the page groups rows by workspace (host order, ungrouped last), folds
//     groups on demand, and expands whatever a search matches.
//   - every glyph (search, fold chevron, row-menu trash) must come from the
//     shell's own icon set when the kit delivers it, and from the plugin's
//     hand-drawn SVG when it does not — a kit that merely lacks one icon
//     member counts as no kit, because that is what the loader's shape check
//     decides.

const SECTION_SLOT = 'settings.section'
const DELETE_PATH = '/api-ext/session.delete'
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'

const A = 'session-11111111-2222-3333-4444-555555555555'
const B = 'session-66666666-7777-8888-9999-aaaaaaaaaaaa'
const C = 'cccccccc-dddd-eeee-ffff-000000000000'

let loadCounter = 0

/** `{key}` substitution over the Chinese dictionary the bundle registers. */
function translator(dictionaries, namespace) {
  return (key, params) => {
    const raw = dictionaries.get(namespace)?.[key] ?? key
    if (params === undefined) return raw
    return raw.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
}

/**
 * The UI primitives the shell hands every client bundle, in the three states a
 * case needs: `full` is the shell's own baseline, `partial` is a kit whose icon
 * members drifted away, and `missing` is a module-table miss the harness
 * answers by throwing. The stubs keep the contract the bundle codes against:
 * `Modal` renders nothing while closed, `Button` carries its label as its
 * child, and every icon is the kit's own `{size, className} -> svg` component.
 * Each icon records its call, so a case can prove which glyph the page used
 * without reading the bundle's internals.
 */
function primitivesStub(kit, calls) {
  const icon = (name) => (props) => {
    calls.push({ kind: 'kit-icon', name, props })
    return { type: 'svg', props: { width: props?.size, height: props?.size, 'data-kit': name } }
  }
  const stub = {
    Modal: (props) => (props.open ? { type: 'Modal', props } : null),
    Button: (props) => ({ type: 'Button', props }),
  }
  if (kit === 'full') {
    stub.IconSearchOutline16 = icon('IconSearchOutline16')
    stub.IconChevronDownOutline14 = icon('IconChevronDownOutline14')
    stub.IconTrashOutline16 = icon('IconTrashOutline16')
  }
  // A partial kit still ships what the dialog needs; only its icons are short.
  if (kit === 'partial') stub.IconSearchOutline16 = icon('IconSearchOutline16')
  return stub
}

/**
 * The miniature DOM the row-⋮-menu cases drive. Nodes carry attributes,
 * children, inline style and listeners, and the selectors the installer really
 * queries are matched (`*`, tag names, `[attr]`, `[attr="v"]`, `[attr*="v"]`).
 * Every node records where it came from: `mark` is `hand` for one the bundle
 * built with `createElement`/`createElementNS`, `react` for one a root
 * rendered — which is how a case tells the kit's glyph from the hand-drawn one.
 */
function createDom(calls) {
  const matches = (node, selector) => {
    const parts = /^(\*|[a-z]+)?(?:\[([\w-]+)(?:([*^$]?=)"([^"]*)")?\])?$/.exec(selector)
    if (parts === null) return false
    const [, tag, name, operator, value] = parts
    if (tag !== undefined && tag !== '*' && node.tagName !== tag) return false
    if (name === undefined) return true
    const actual = node.getAttribute(name)
    if (actual === null) return false
    if (operator === undefined) return true
    return operator === '*' ? actual.includes(value) : actual === value
  }

  class Node extends globalThis.Element {
    constructor(tag, mark = 'hand') {
      super()
      this.nodeType = 1
      this.tagName = String(tag).toLowerCase()
      this.mark = mark
      this.children = []
      this.parentElement = null
      this.attributes = new Map()
      this.listeners = new Map()
      this.style = {}
      this.own = ''
      this.isConnected = true
    }

    get textContent() {
      return this.own + this.children.map((child) => child.textContent).join('')
    }

    set textContent(value) {
      this.own = String(value)
    }

    get firstElementChild() {
      return this.children[0] ?? null
    }

    append(...nodes) {
      for (const node of nodes) this.attach(node)
    }

    appendChild(node) {
      this.attach(node)
      return node
    }

    attach(node) {
      node.parentElement = this
      this.children.push(node)
    }

    after(node) {
      const parent = this.parentElement
      if (parent === null) return
      parent.children.splice(parent.children.indexOf(this) + 1, 0, node)
      node.parentElement = parent
    }

    remove() {
      const parent = this.parentElement
      if (parent !== null) parent.children.splice(parent.children.indexOf(this), 1)
      this.parentElement = null
      this.isConnected = false
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value))
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener)
    }

    fire(type, event) {
      return this.listeners.get(type)?.(event)
    }

    contains(node) {
      return this === node || this.children.some((child) => child.contains(node))
    }

    cloneNode() {
      const copy = new Node(this.tagName, this.mark)
      copy.own = this.own
      copy.style = { ...this.style }
      for (const [name, value] of this.attributes) copy.setAttribute(name, value)
      for (const child of this.children) copy.attach(child.cloneNode())
      return copy
    }

    closest(selector) {
      let node = this
      while (node !== null) {
        if (matches(node, selector)) return node
        node = node.parentElement
      }
      return null
    }

    querySelector(selector) {
      return this.descendants().find((node) => matches(node, selector)) ?? null
    }

    querySelectorAll(selector) {
      return this.descendants().filter((node) => matches(node, selector))
    }

    descendants() {
      const found = []
      const collect = (node) => {
        for (const child of node.children) {
          found.push(child)
          collect(child)
        }
      }
      collect(this)
      return found
    }
  }

  const listeners = []
  const document = {
    body: new Node('body'),
    createElement: (tag) => new Node(tag),
    createElementNS: (namespace, tag) => {
      calls.push({ kind: 'svg-node', tag })
      return new Node(tag)
    },
    addEventListener: (type, listener) => listeners.push({ type, listener }),
    removeEventListener: (type, listener) => {
      const at = listeners.findIndex((entry) => entry.type === type && entry.listener === listener)
      if (at !== -1) listeners.splice(at, 1)
    },
  }
  return {
    document,
    /** A node a case plants, e.g. the menu subtree the shell mounts. */
    node: (tag, mark) => new Node(tag, mark),
    /** Fire a document-level listener: the installer's `pointerdown` capture. */
    fire: (type, event) => {
      for (const entry of listeners) if (entry.type === type) entry.listener(event)
    },
  }
}

/**
 * Load the bundle behind the shim and mount its Settings page.
 * @param {{ deleteFails?: boolean, sessions?: object[], workspaces?: object[], archived?: string[], menu?: boolean, catalogItems?: object[], kit?: 'full'|'partial'|'missing' }} [options] - per-case wiring. `menu` gives the page a non-null `body` plus a `MutationObserver`, which is what makes the row-⋮-menu installer run; `catalogItems` is what `/api/session.list` answers with; `kit` picks which primitives the module table hands over (default `full`).
 * @returns the rendered tree, a `render` handle, the DOM the menu cases drive, and a call log.
 */
async function mount(options = {}) {
  const calls = []
  const dictionaries = new Map()
  const effects = []
  const roots = []
  let factory = null

  // Hook state lives here and survives re-renders, exactly like a real
  // renderer's hook slots; `index` is the per-pass cursor.
  const hooks = { index: 0, slots: [] }
  let tree = null

  const React = {
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props ?? {})
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      // A function component IS its output, so the tree a case inspects is
      // the tree React would have mounted.
      if (typeof type === 'function') {
        const output = type(merged)
        return output === undefined || output === null ? null : output
      }
      return { type, props: merged }
    },
    useState(initial) {
      const slot = hooks.index++
      if (!(slot in hooks.slots)) hooks.slots[slot] = typeof initial === 'function' ? initial() : initial
      return [
        hooks.slots[slot],
        (next) => {
          const value = typeof next === 'function' ? next(hooks.slots[slot]) : next
          if (Object.is(value, hooks.slots[slot])) return
          hooks.slots[slot] = value
          render()
        },
      ]
    },
    useMemo: (factoryFn) => {
      hooks.index++
      return factoryFn()
    },
  }

  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        factory = spec.factory
      },
    },
    confirm: (message) => {
      calls.push({ kind: 'confirm', message })
      return true
    },
    alert: (message) => calls.push({ kind: 'alert', message }),
  }
  // The menu installer only starts when `document.body` exists; the other cases
  // leave it absent so they exercise the Settings page alone (no DOM needed).
  const observers = []
  let dom = null
  if (options.menu === true) {
    globalThis.Element = class {}
    dom = createDom(calls)
    globalThis.MutationObserver = class {
      constructor(callback) {
        observers.push({ fire: (mutations) => callback(mutations, this) })
      }
      observe() {}
      disconnect() {}
    }
    globalThis.document = dom.document
  } else {
    globalThis.document = { body: null, addEventListener() {} }
  }
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    if (url === DELETE_PATH) {
      calls.push({ kind: 'delete-request', sessionId: body.sessionId })
      if (options.deleteFails === true) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            ok: false,
            error: { code: 'refused', message: 'session "…" is running, close it before deleting' },
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { sessionId: body.sessionId } }) }
    }
    if (url === '/api/session.list') {
      calls.push({ kind: 'session-list' })
      return { ok: true, status: 200, json: async () => ({ result: { value: { items: options.catalogItems ?? [] } } }) }
    }
    calls.push({ kind: 'diag', event: body.report?.event, detail: body.report?.detail })
    return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }
  }

  // A fresh URL per case defeats the module cache, so each case observes the
  // bundle's own registration call.
  loadCounter += 1
  await import(`../client.js?case=${loadCounter}`)
  if (factory === null) throw new Error('client.js did not register itself with the ModuleLoader')
  const kit = options.kit ?? 'full'
  const primitives = kit === 'missing' ? null : primitivesStub(kit, calls)
  const require = (name) => {
    if (name === 'react') return React
    if (name === PRIMITIVES) {
      if (primitives === null) throw new Error(`client-modules: require("${name}") missed the module table`)
      return primitives
    }
    if (name === 'react-dom') {
      return {
        /** The door React 18 opens for a caller that must have the DOM now. */
        flushSync: (work) => {
          work()
          for (const root of roots) root.flush()
        },
      }
    }
    if (name === 'react-dom/client') {
      return {
        createRoot: (container) => {
          const root = {
            renders: [],
            pending: null,
            render(element) {
              this.renders.push(element)
              this.pending = element
            },
            // React commits on its own schedule, which is exactly why a caller
            // that reads the container back has to flush.
            flush() {
              const element = this.pending
              this.pending = null
              if (element === null) return
              container.committed = element
              if (element.type === 'svg' && dom !== null) container.append(dom.node('svg', 'react'))
            },
            unmount() {
              calls.push({ kind: 'unmount' })
            },
          }
          queueMicrotask(() => root.flush())
          roots.push(root)
          return root
        },
      }
    }
    throw new Error(`unexpected module request: ${name}`)
  }
  const bundle = factory(require)

  let registration = null
  const ctx = {
    sessions: {
      handleSessionRemoved: (id) => calls.push({ kind: 'handleSessionRemoved', sessionId: id }),
      refresh: async () => calls.push({ kind: 'refresh' }),
    },
    uiWorkspace: {
      unarchiveSession: async (id) => calls.push({ kind: 'unarchiveSession', sessionId: id }),
    },
    locale: {
      register: (namespace, table) => dictionaries.set(namespace, table.zh),
      bind: (namespace) => translator(dictionaries, namespace),
    },
    slots: {
      inject: (name, register) => {
        if (name === SECTION_SLOT) register()
      },
      register: (config, Element) => {
        registration = { config, Element }
      },
    },
    effect: (fn) => {
      effects.push(fn())
    },
    // Recorded so a case can prove the bundle reads no service reflectively.
    get: (name) => {
      calls.push({ kind: 'service-get', name })
      return undefined
    },
  }

  bundle.apply(ctx)
  if (registration === null) throw new Error(`no ${SECTION_SLOT} registration`)

  const summaries = options.sessions ?? [{ id: A, displayTitle: 'Keep me', updatedAt: 1000, running: false }]
  const byId = Object.fromEntries(summaries.map((summary) => [summary.id, summary]))
  const workspaces = options.workspaces ?? [{ workspaceId: 'w1', title: 'E:\\work\\x', sessionIds: [] }]
  // Exactly the props the slot framework composes: the standard hooks plus the
  // registration's own `inject` — nothing else.
  const props = {
    useSessions: (select) => select({ byId, ids: Object.keys(byId), current: undefined, phase: 'ready' }),
    useWorkspaces: (select) => select({ items: workspaces, archivedSessionIds: options.archived ?? [] }),
    ...(typeof registration.config.inject === 'function' ? registration.config.inject() : {}),
  }

  function render() {
    hooks.index = 0
    tree = registration.Element(props)
    return tree
  }
  render()

  return { calls, render, roots, dom, observers, tree: () => tree }
}

/** Let the harness's queued microtasks — React's own commit — settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The box around the search field's glyph, whichever glyph is in it. */
function searchBox(node) {
  return find(node, (element) => element.props?.style?.pointerEvents === 'none')
}

/** The box around a group header's fold glyph. */
function chevronBox(node, key) {
  const header = find(node, (element) => element.props['data-session-group-header'] === key)
  if (header === null) throw new Error(`no group header for ${key}`)
  return header.props.children[0] ?? null
}

/** What a glyph box holds: the kit component's SVG, or the hand-drawn one. */
function glyphOf(box) {
  return box?.props?.children ?? null
}

/**
 * Open a session row ⋮ menu the way the shell does — a `pointerdown` on the row
 * trigger, then the menu subtree arriving — and return the augmented menu.
 */
function openMenu(harness, sessionId = A) {
  const row = harness.dom.node('div')
  row.setAttribute('role', 'treeitem')
  const trigger = harness.dom.node('button')
  trigger.setAttribute('aria-label', '会话“Doomed”的操作')
  const menu = harness.dom.node('div')
  const archiveHolder = harness.dom.node('div')
  const archive = harness.dom.node('button')
  archive.textContent = '归档会话'
  const forkHolder = harness.dom.node('div')
  const fork = harness.dom.node('button')
  fork.textContent = '分叉会话'
  archiveHolder.append(archive)
  forkHolder.append(fork)
  menu.append(archiveHolder, forkHolder)
  row.append(trigger, menu)
  // The row component receives the session node; the id is read from its fiber.
  row['__reactFiber$case'] = { memoizedProps: { node: { id: sessionId } }, return: null }
  harness.dom.document.body.append(row)
  harness.dom.fire('pointerdown', { target: trigger })
  harness.observers[0].fire([{ addedNodes: [menu] }])
  return menu
}

/** The click the item handles; it only has to stop the shell seeing it. */
const clickEvent = () => ({ preventDefault() {}, stopPropagation() {} })

/** Depth-first walk over the element tree. A Modal takes its footer by prop. */
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node === null || typeof node !== 'object') return
  if (typeof node.type !== 'undefined') visit(node)
  const props = node.props ?? {}
  walk(props.children, visit)
  walk(props.footer, visit)
}

/** First element matching `match`. */
function find(node, match) {
  let found = null
  walk(node, (element) => {
    if (found === null && match(element)) found = element
  })
  return found
}

/** Concatenated string children of one element. */
function textOf(element) {
  let text = ''
  const collect = (node) => {
    if (typeof node === 'string' || typeof node === 'number') {
      text += String(node)
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) collect(child)
      return
    }
    if (node === null || typeof node !== 'object') return
    collect(node.props?.children)
  }
  collect(element)
  return text
}

/** The first button matching `(aria-label, text)`. */
function button(node, match) {
  return find(
    node,
    (element) => element.type === 'button' && match(String(element.props['aria-label'] ?? ''), textOf(element)),
  )
}

/** The open confirmation dialog, or null. */
function dialog(node) {
  return find(node, (element) => element.type === 'Modal')
}

/** One of the dialog's footer buttons by label. */
function dialogButton(node, label) {
  return find(node, (element) => element.type === 'Button' && textOf(element) === label)
}

/** Every group in render order: `{key, text, expanded, rows}`. */
function groups(node) {
  const found = []
  walk(node, (element) => {
    const key = element.props['data-session-group']
    if (key === undefined) return
    const header = find(element, (candidate) => candidate.props['data-session-group-header'] !== undefined)
    const rows = []
    walk(element, (candidate) => {
      const id = candidate.props['data-session-row']
      if (id !== undefined) rows.push(id)
    })
    found.push({
      key,
      text: header === null ? '' : textOf(header),
      expanded: header === null ? undefined : header.props['aria-expanded'],
      rows,
    })
  })
  return found
}

/** Type into the one search box. */
function search(harness, value) {
  const input = find(harness.tree(), (element) => element.type === 'input')
  if (input === null) throw new Error('the section must render a search box')
  input.props.onChange({ currentTarget: { value } })
}

/** Click the header of the group with this key. */
function fold(harness, key) {
  const header = find(harness.tree(), (element) => element.props['data-session-group-header'] === key)
  if (header === null) throw new Error(`no group header for ${key}`)
  header.props.onClick()
}

export const clientCases = [
  [
    'client: deleting asks in the app dialog, and confirming deletes the session',
    async (assert) => {
      const harness = await mount({ sessions: [{ id: A, displayTitle: 'Doomed', updatedAt: 1000, running: false }] })
      button(harness.tree(), (label) => label.startsWith('删除会话')).props.onClick()

      const open = dialog(harness.tree())
      assert.ok(open !== null, 'the row action must open the app dialog')
      assert.equal(open.props.title, '删除会话', 'the dialog carries the native title')
      assert.equal(
        String(open.props.description).includes('Doomed'),
        true,
        'the dialog names the session it will delete',
      )
      assert.equal(
        harness.calls.some((call) => call.kind === 'confirm'),
        false,
        'the browser confirm must not be used',
      )

      await dialogButton(open, '删除').props.onClick()
      assert.deepEqual(
        harness.calls.filter((call) => call.kind === 'delete-request'),
        [{ kind: 'delete-request', sessionId: A }],
        'the delete must reach the host route',
      )
      assert.deepEqual(
        harness.calls.filter((call) => call.kind === 'handleSessionRemoved'),
        [{ kind: 'handleSessionRemoved', sessionId: A }],
        'the client session store must be told the session is gone',
      )
      assert.equal(
        harness.calls.some((call) => call.kind === 'refresh'),
        true,
        'the client must re-pull the host baseline',
      )
      assert.equal(dialog(harness.tree()), null, 'a finished delete closes the dialog')
    },
  ],

  [
    'client: cancelling the dialog deletes nothing',
    async (assert) => {
      const harness = await mount()
      button(harness.tree(), (label) => label.startsWith('删除会话')).props.onClick()
      dialogButton(dialog(harness.tree()), '取消').props.onClick()

      assert.equal(
        harness.calls.some((call) => call.kind === 'delete-request'),
        false,
        'cancel must not request a delete',
      )
      assert.equal(
        harness.calls.some((call) => call.kind === 'handleSessionRemoved'),
        false,
        'cancel must not drop the row',
      )
      assert.equal(dialog(harness.tree()), null, 'cancel closes the dialog')
    },
  ],

  [
    'client: a refused delete stays in the dialog as an inline error',
    async (assert) => {
      const harness = await mount({ deleteFails: true })
      button(harness.tree(), (label) => label.startsWith('删除会话')).props.onClick()
      await dialogButton(dialog(harness.tree()), '删除').props.onClick()

      const open = dialog(harness.tree())
      assert.ok(open !== null, 'a refusal must not close the dialog')
      const alert = find(open, (element) => element.props.role === 'alert')
      assert.ok(alert !== null, 'the refusal must be shown inline')
      assert.equal(textOf(alert).includes('正在运行'), true, 'the refusal text names what is in the way')
      assert.equal(
        harness.calls.some((call) => call.kind === 'alert'),
        false,
        'no browser alert',
      )
      assert.equal(
        harness.calls.some((call) => call.kind === 'confirm'),
        false,
        'no browser confirm',
      )
      assert.equal(
        harness.calls.some((call) => call.kind === 'handleSessionRemoved'),
        false,
        'a refused delete must not drop the row',
      )
    },
  ],

  [
    'client: unarchive uses the injected workspace service',
    async (assert) => {
      const harness = await mount({ archived: [A] })
      const unarchive = button(harness.tree(), (label, text) => label.startsWith('取消归档') || text === '取消归档')
      assert.ok(unarchive !== null, 'an archived row must render the unarchive button')
      await unarchive.props.onClick()

      assert.deepEqual(
        harness.calls.filter((call) => call.kind === 'unarchiveSession'),
        [{ kind: 'unarchiveSession', sessionId: A }],
        'unarchive must reach the client workspace service',
      )
    },
  ],

  [
    'client: rows are grouped per workspace in host order, ungrouped last',
    async (assert) => {
      const harness = await mount({
        sessions: [
          { id: A, displayTitle: 'Alpha one', updatedAt: 3000, running: false },
          { id: B, displayTitle: 'Beta one', updatedAt: 2000, running: false },
          { id: C, displayTitle: 'Stray one', updatedAt: 1000, running: false },
        ],
        // Host order: Beta first. Ungrouped strays must follow, not lead.
        workspaces: [
          { workspaceId: 'w2', title: 'Beta', sessionIds: [B] },
          { workspaceId: 'w1', title: 'Alpha', sessionIds: [A] },
        ],
      })
      const found = groups(harness.tree())

      assert.deepEqual(
        found.map((group) => group.key),
        ['w2', 'w1', ''],
        'one group per owning workspace, then the strays',
      )
      assert.deepEqual(
        found.map((group) => group.rows),
        [[B], [A], [C]],
        'each row lands in its own group',
      )
      assert.equal(found[0].text.startsWith('Beta'), true, 'the group shows the workspace title')
      assert.equal(found[0].text.includes('1 个会话'), true, 'the group shows how many sessions it holds')
      assert.equal(found[2].text.startsWith('未分组'), true, 'strays are grouped as ungrouped')
    },
  ],

  [
    'client: an archived session stays inside its workspace group',
    async (assert) => {
      const harness = await mount({
        sessions: [{ id: A, displayTitle: 'Filed', updatedAt: 1000, running: false }],
        workspaces: [{ workspaceId: 'w1', title: 'Alpha', sessionIds: [A] }],
        archived: [A],
      })
      const found = groups(harness.tree())

      assert.deepEqual(
        found.map((group) => group.key),
        ['w1'],
        'archiving must not split a session into a group of its own',
      )
      assert.deepEqual(found[0].rows, [A], 'the archived row stays where it belongs')
      assert.equal(found[0].text.includes('已归档'), false, 'the archive badge rides the row, not the group header')
      const row = find(harness.tree(), (element) => element.props['data-session-row'] === A)
      assert.equal(textOf(row).includes('已归档'), true, 'the archived row carries the badge')
    },
  ],

  [
    'client: a group header folds and unfolds its rows',
    async (assert) => {
      const harness = await mount({
        sessions: [
          { id: A, displayTitle: 'Alpha one', updatedAt: 2000, running: false },
          { id: B, displayTitle: 'Beta one', updatedAt: 1000, running: false },
        ],
        workspaces: [
          { workspaceId: 'w1', title: 'Alpha', sessionIds: [A] },
          { workspaceId: 'w2', title: 'Beta', sessionIds: [B] },
        ],
      })

      fold(harness, 'w1')
      let found = groups(harness.tree())
      assert.deepEqual(found[0].rows, [], 'a folded group hides its rows')
      assert.equal(found[0].expanded, false, 'a folded group reports itself collapsed')
      assert.deepEqual(found[1].rows, [B], 'folding one group leaves the others alone')

      fold(harness, 'w1')
      found = groups(harness.tree())
      assert.deepEqual(found[0].rows, [A], 'clicking the header again brings the rows back')
      assert.equal(found[0].expanded, true)
    },
  ],

  [
    'client: searching expands whatever it matches',
    async (assert) => {
      const harness = await mount({
        sessions: [
          { id: A, displayTitle: 'Alpha one', updatedAt: 2000, running: false },
          { id: B, displayTitle: 'Beta one', updatedAt: 1000, running: false },
        ],
        workspaces: [
          { workspaceId: 'w1', title: 'Alpha', sessionIds: [A] },
          { workspaceId: 'w2', title: 'Beta', sessionIds: [B] },
        ],
      })

      fold(harness, 'w1')
      assert.deepEqual(groups(harness.tree())[0].rows, [], 'the group starts folded')

      // A group-name hit keeps the whole group, folded or not.
      search(harness, 'Alpha')
      let found = groups(harness.tree())
      assert.deepEqual(
        found.map((group) => group.key),
        ['w1'],
        'only the matching group survives a search',
      )
      assert.deepEqual(found[0].rows, [A], 'a matching group is expanded even though it was folded')

      // A row-title hit narrows to the matching rows.
      search(harness, 'Beta one')
      found = groups(harness.tree())
      assert.deepEqual(
        found.map((group) => [group.key, group.rows]),
        [['w2', [B]]],
        'a row hit shows just that row',
      )

      search(harness, 'nothing matches this')
      assert.equal(groups(harness.tree()).length, 0, 'no hit leaves no group')
      assert.equal(
        textOf(find(harness.tree(), (element) => element.type === 'p')).includes('没有匹配的会话'),
        true,
        'and says so',
      )
    },
  ],

  [
    'client: the title catalog comes from /api/session.list, never from a `remote` service',
    async (assert) => {
      const harness = await mount({
        menu: true,
        catalogItems: [
          { sessionId: A, running: true, projections: { values: { title: 'Alpha pipeline' } } },
          { sessionId: B, running: false, title: 'Beta notes' },
          { sessionId: C, blank: true, title: 'Blank draft' },
        ],
      })
      // The installer fetches the catalog without awaiting it.
      await new Promise((resolve) => setTimeout(resolve, 0))

      assert.equal(
        harness.calls.filter((call) => call.kind === 'session-list').length,
        1,
        '/api/session.list is the transport',
      )
      const report = harness.calls.find((call) => call.kind === 'diag' && call.event === 'catalog')
      assert.ok(report !== undefined, 'the catalog result is reported for diagnosis')
      assert.equal(report.detail.ok, true, 'the fetch fed the catalog')
      assert.equal(report.detail.known, 2, 'both non-blank sessions land in the catalog')
      assert.deepEqual(
        harness.calls.filter((call) => call.kind === 'service-get'),
        [],
        'no reflective service read: a browser remote namespace is its own `remote.<namespace>` service',
      )
    },
  ],

  [
    "client: the shell's own icons drive the page and the row menu when the kit ships them",
    async (assert) => {
      const harness = await mount({
        menu: true,
        sessions: [{ id: A, displayTitle: 'Doomed', updatedAt: 1000, running: false }],
        workspaces: [{ workspaceId: 'w1', title: 'Alpha', sessionIds: [A] }],
      })

      const search = glyphOf(searchBox(harness.tree()))
      assert.equal(search?.props?.['data-kit'], 'IconSearchOutline16', 'the search glyph comes from the kit')
      assert.equal(search.props.width, 16, 'at the size it has always had')
      assert.equal(searchBox(harness.tree()).props['aria-hidden'], true, 'and stays decorative')

      const chevron = glyphOf(chevronBox(harness.tree(), 'w1'))
      assert.equal(chevron?.props?.['data-kit'], 'IconChevronDownOutline14', 'the fold glyph comes from the kit')
      assert.equal(chevronBox(harness.tree(), 'w1').props.style.transform, 'none', 'an open group sits unrotated')
      fold(harness, 'w1')
      assert.equal(
        chevronBox(harness.tree(), 'w1').props.style.transform,
        'rotate(-90deg)',
        'a folded group still rotates it',
      )

      const item = openMenu(harness).querySelector('[data-session-cleaner-item]')
      assert.ok(item !== null, 'the delete item joins the row menu')
      assert.equal(item.tagName, 'button', 'as the same button')
      assert.equal(item.title, '删除会话', 'with the same title')
      assert.equal(item.children[1].textContent, '删除会话', 'and the same label')
      assert.equal(item.children[0].mark, 'react', 'the trash glyph is the kit icon React rendered for it')
      assert.equal(item.children[0].tagName, 'svg')
      assert.deepEqual(
        harness.calls.filter((call) => call.kind === 'svg-node'),
        [],
        'nothing hand-draws an SVG when the kit ships every icon',
      )
      const names = harness.calls.filter((call) => call.kind === 'kit-icon').map((call) => call.name)
      assert.deepEqual(
        [...new Set(names)].sort(),
        ['IconChevronDownOutline14', 'IconSearchOutline16', 'IconTrashOutline16'],
        'all three glyphs come from the kit',
      )

      const answered = item.fire('click', clickEvent())
      await settle()
      const open = harness.roots.at(-1).renders[0]
      assert.equal(open.type, 'Modal', 'the item still opens the app dialog')
      await dialogButton(open, '删除').props.onClick()
      assert.deepEqual(
        harness.calls.filter((call) => call.kind === 'delete-request'),
        [{ kind: 'delete-request', sessionId: A }],
        'and still deletes through it',
      )
      await answered
    },
  ],

  [
    'client: a kit missing an icon member degrades to the hand-drawn glyphs',
    async (assert) => {
      const harness = await mount({
        kit: 'partial',
        menu: true,
        sessions: [{ id: A, displayTitle: 'Doomed', updatedAt: 1000, running: false }],
        workspaces: [{ workspaceId: 'w1', title: 'Alpha', sessionIds: [A] }],
      })

      const reported = harness.calls.find((call) => call.kind === 'diag' && call.event === 'primitives')
      assert.ok(reported !== undefined, 'the kit is reported at apply time')
      assert.equal(reported.detail.ok, false, 'a kit short of one icon this plugin renders is no kit at all')
      assert.equal(
        harness.calls.some((call) => call.kind === 'kit-icon'),
        false,
        'so no kit glyph is used anywhere',
      )

      const search = glyphOf(searchBox(harness.tree()))
      assert.equal(search?.type, 'svg', 'the hand-drawn search glyph renders instead')
      assert.equal(search.props.children.length, 2, 'circle plus handle')
      const chevron = glyphOf(chevronBox(harness.tree(), 'w1'))
      assert.equal(chevron?.type, 'svg', 'the hand-drawn fold glyph renders instead')
      assert.equal(chevron.props.children.type, 'path', 'one stroke')
      assert.equal(chevronBox(harness.tree(), 'w1').props.style.transform, 'none', 'in the same box the kit path uses')
      fold(harness, 'w1')
      assert.equal(chevronBox(harness.tree(), 'w1').props.style.transform, 'rotate(-90deg)', 'which still rotates')

      const item = openMenu(harness).querySelector('[data-session-cleaner-item]')
      assert.ok(item !== null, 'the item still joins the menu')
      assert.equal(item.children[0].mark, 'hand', 'with the hand-drawn trash glyph')
      assert.equal(item.children[0].tagName, 'svg')
      assert.equal(item.children[0].children.length, 3, 'lid, handle and body')
      assert.deepEqual(
        harness.calls.filter((call) => call.kind === 'svg-node').map((call) => call.tag),
        ['svg', 'path', 'path', 'path'],
        'drawn here, node by node',
      )

      const answered = item.fire('click', clickEvent())
      assert.equal(
        harness.calls.some((call) => call.kind === 'confirm'),
        true,
        'and the delete asks in the browser dialog a kit-less page has always used',
      )
      await answered
      assert.deepEqual(
        harness.calls.filter((call) => call.kind === 'delete-request'),
        [{ kind: 'delete-request', sessionId: A }],
        'the click handler is unchanged',
      )
    },
  ],

  [
    'client: a module-table miss still renders the hand-drawn glyphs',
    async (assert) => {
      const harness = await mount({
        kit: 'missing',
        menu: true,
        sessions: [{ id: A, displayTitle: 'Doomed', updatedAt: 1000, running: false }],
        workspaces: [{ workspaceId: 'w1', title: 'Alpha', sessionIds: [A] }],
      })

      const missing = harness.calls.find((call) => call.kind === 'diag' && call.event === 'primitives-missing')
      assert.ok(missing !== undefined, 'the miss is reported for diagnosis')
      const reported = harness.calls.find((call) => call.kind === 'diag' && call.event === 'primitives')
      assert.equal(reported.detail.ok, false, 'the kit is treated as absent')
      assert.equal(glyphOf(searchBox(harness.tree()))?.type, 'svg', 'the search glyph is hand-drawn')
      assert.equal(glyphOf(chevronBox(harness.tree(), 'w1'))?.type, 'svg', 'so is the fold glyph')

      const item = openMenu(harness).querySelector('[data-session-cleaner-item]')
      assert.ok(item !== null, 'the row menu still gains its item')
      assert.equal(item.children[0].mark, 'hand', 'trash glyph included')
      assert.equal(
        harness.calls.some((call) => call.kind === 'kit-icon'),
        false,
        'no kit glyph is asked for',
      )
    },
  ],
]
