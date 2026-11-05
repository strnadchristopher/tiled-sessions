// Tiled Sessions — Hyprland-style tiling for Hermes Desktop sessions.
//
// GENERATED: desktop/plugin.js is this file with src/engine.mjs inlined at the
// ENGINE marker by scripts/build.mjs. Edit src/, then `npm run build`.
// SDK-only: imports @hermes/plugin-sdk and react/jsx-runtime, nothing else.

import {
  Codicon,
  KEYBINDS_AREA,
  ListRow,
  PALETTE_AREA,
  SegmentedControl,
  SessionStatusDot,
  ToggleRow,
  atom,
  cn,
  host,
  queryClient,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

/* ENGINE:BEGIN */
// tiled-sessions layout engine. Pure functions, no imports, no DOM.
// scripts/build.mjs inlines this file into desktop/plugin.js between the
// ENGINE markers, so keep it free of imports and top-level side effects.

/** @typedef {{ type: 'leaf', id: string }} Leaf */
/** @typedef {{ type: 'split', dir: 'row' | 'column', ratio: number, a: Node, b: Node }} Split */
/** @typedef {Leaf | Split} Node */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

const EPS = 0.5

const leaf = id => ({ type: 'leaf', id })

const split = (dir, a, b, ratio = 0.5) => ({ type: 'split', dir, ratio, a, b })

/** Leaf ids in tile order: left-to-right, top-to-bottom (tree order). */
function leaves(node) {
  if (!node) return []
  return node.type === 'leaf' ? [node.id] : [...leaves(node.a), ...leaves(node.b)]
}

/** Pixel rect of every leaf when `node` fills `rect`. */
function rects(node, rect, out = new Map()) {
  if (!node) return out
  if (node.type === 'leaf') {
    out.set(node.id, rect)
    return out
  }
  const { x, y, w, h } = rect
  if (node.dir === 'row') {
    const wa = w * node.ratio
    rects(node.a, { x, y, w: wa, h }, out)
    rects(node.b, { x: x + wa, y, w: w - wa, h }, out)
  } else {
    const ha = h * node.ratio
    rects(node.a, { x, y, w, h: ha }, out)
    rects(node.b, { x, y: y + ha, w, h: h - ha }, out)
  }
  return out
}

/** Edge to split a rect on: wide (or square) → right, tall → bottom. */
const splitPos = rect => (rect.w >= rect.h ? 'right' : 'bottom')

function recencyRank(history, id) {
  const at = history.indexOf(id)
  return at === -1 ? Number.MAX_SAFE_INTEGER : at
}

/**
 * Which leaf a new tile splits.
 * mode 'largest': biggest area; ties → most recently focused (history[0] is
 * newest); still tied → earliest in tile order.
 * mode 'focused': `focused` when it is a candidate, else falls back to 'largest'.
 * `isCandidate` filters leaves that may be split (session panes only).
 */
function pickTarget(node, rect, { mode = 'largest', history = [], focused = null, isCandidate = () => true } = {}) {
  const ids = leaves(node).filter(isCandidate)
  if (ids.length === 0) return null
  if (mode === 'focused' && focused && ids.includes(focused)) return focused
  const r = rects(node, rect)
  const area = id => r.get(id).w * r.get(id).h
  const order = id => ids.indexOf(id)
  return [...ids].sort((p, q) => {
    const d = area(q) - area(p)
    if (d > EPS) return 1
    if (d < -EPS) return -1
    const rp = recencyRank(history, p)
    const rq = recencyRank(history, q)
    if (rp !== rq) return rp - rq
    return order(p) - order(q)
  })[0]
}

function replaceLeaf(node, id, replacement) {
  if (node.type === 'leaf') return node.id === id ? replacement : node
  return { ...node, a: replaceLeaf(node.a, id, replacement), b: replaceLeaf(node.b, id, replacement) }
}

/**
 * Insert `newId`. Returns the new tree plus the dock gesture core needs:
 * { tree, target, pos } — target null when the tree was empty.
 */
function insert(node, rect, newId, opts = {}) {
  if (!node) return { tree: leaf(newId), target: null, pos: null }
  const target = pickTarget(node, rect, opts)
  if (!target) return { tree: node, target: null, pos: null }
  const pos = splitPos(rects(node, rect).get(target))
  const dir = pos === 'right' ? 'row' : 'column'
  return { tree: replaceLeaf(node, target, split(dir, leaf(target), leaf(newId))), target, pos }
}

/** Remove a leaf; its parent split collapses so the sibling takes the space. */
function remove(node, id) {
  if (!node) return null
  if (node.type === 'leaf') return node.id === id ? null : node
  const a = remove(node.a, id)
  const b = remove(node.b, id)
  if (!a) return b
  if (!b) return a
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/** Parent split of a leaf, or null for the root leaf / missing id. */
function parentSplit(node, id) {
  if (!node || node.type === 'leaf') return null
  if ((node.a.type === 'leaf' && node.a.id === id) || (node.b.type === 'leaf' && node.b.id === id)) return node
  return parentSplit(node.a, id) ?? parentSplit(node.b, id)
}

/** Flip row↔column on the split that directly holds `id`. */
function toggleSplit(node, id) {
  const parent = parentSplit(node, id)
  if (!parent) return node
  const walk = n => {
    if (n === parent) return { ...n, dir: n.dir === 'row' ? 'column' : 'row' }
    if (n.type === 'leaf') return n
    return { ...n, a: walk(n.a), b: walk(n.b) }
  }
  return walk(node)
}

/** Every split back to 50/50. */
function equalize(node) {
  if (!node || node.type === 'leaf') return node
  return { ...node, ratio: 0.5, a: equalize(node.a), b: equalize(node.b) }
}

/** Exchange two leaves' positions. */
function swap(node, p, q) {
  if (!node) return node
  if (node.type === 'leaf') return node.id === p ? leaf(q) : node.id === q ? leaf(p) : node
  return { ...node, a: swap(node.a, p, q), b: swap(node.b, p, q) }
}

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

/**
 * Nearest candidate leaf in direction `dir` ('left'|'right'|'up'|'down') from
 * `from`. Must share an edge span (overlap > EPS); nearest gap wins, then the
 * larger overlap, then recency.
 */
function neighbor(node, rect, from, dir, { history = [], isCandidate = () => true } = {}) {
  const r = rects(node, rect)
  const c = r.get(from)
  if (!c) return null
  let best = null
  for (const id of leaves(node)) {
    if (id === from || !isCandidate(id)) continue
    const o = r.get(id)
    let gap
    let span
    if (dir === 'left') { gap = c.x - (o.x + o.w); span = overlap(c.y, c.y + c.h, o.y, o.y + o.h) }
    else if (dir === 'right') { gap = o.x - (c.x + c.w); span = overlap(c.y, c.y + c.h, o.y, o.y + o.h) }
    else if (dir === 'up') { gap = c.y - (o.y + o.h); span = overlap(c.x, c.x + c.w, o.x, o.x + o.w) }
    else { gap = o.y - (c.y + c.h); span = overlap(c.x, c.x + c.w, o.x, o.x + o.w) }
    if (gap < -EPS || span <= EPS) continue
    const score = [Math.max(0, gap), -span, recencyRank(history, id)]
    if (!best || score[0] < best.score[0] - EPS ||
      (Math.abs(score[0] - best.score[0]) <= EPS && (score[1] < best.score[1] - EPS ||
        (Math.abs(score[1] - best.score[1]) <= EPS && score[2] < best.score[2])))) {
      best = { id, score }
    }
  }
  return best ? best.id : null
}

/**
 * Core layout projection (n-ary splits with weights; groups of stacked panes)
 * → binary engine tree. Each core group becomes ONE leaf keyed by its active
 * pane id. An n-ary split becomes a right-nested chain whose ratios reproduce
 * the weights exactly. `keep` drops leaves (and minimized zones), so the
 * result can be just the chat area: its splits renormalize around them.
 */
function fromCore(node, keep = () => true) {
  if (!node) return null
  if (node.type === 'group') {
    if (node.minimized) return null
    const pane = keep(node.active) ? node.active : node.panes.find(keep)
    return pane ? leaf(pane) : null
  }
  const kids = []
  const weights = []
  node.children.forEach((child, i) => {
    const converted = fromCore(child, keep)
    if (converted) { kids.push(converted); weights.push(node.weights[i] ?? 1) }
  })
  if (kids.length === 0) return null
  const dir = node.orientation === 'row' ? 'row' : 'column'
  const chain = i => {
    if (i === kids.length - 1) return kids[i]
    const rest = weights.slice(i).reduce((s, w) => s + w, 0) || 1
    return split(dir, kids[i], chain(i + 1), weights[i] / rest)
  }
  return chain(0)
}

/** True for the panes that hold a chat: main ('workspace') and session tiles. */
const isSessionPane = id => id === 'workspace' || id.startsWith('session-tile:')

/** Stored session id a pane shows (main needs the projection's mainStoredSessionId). */
function storedIdOfPane(paneId, mainStoredSessionId) {
  if (paneId === 'workspace') return mainStoredSessionId || null
  return paneId.startsWith('session-tile:') ? paneId.slice('session-tile:'.length) : null
}

/** Ordered open sessions (tile order, then stacked tabs) from a core projection. */
function openSessions(coreRoot, mainStoredSessionId) {
  const out = []
  const walk = n => {
    if (!n) return
    if (n.type === 'group') {
      for (const pane of n.panes) {
        const id = storedIdOfPane(pane, mainStoredSessionId)
        if (id && !out.some(o => o.storedSessionId === id)) out.push({ paneId: pane, storedSessionId: id, visible: pane === n.active })
      }
      return
    }
    n.children.forEach(walk)
  }
  walk(coreRoot)
  return out
}

/** The core split that directly holds the group containing `paneId` (for toggle). */
function coreParentSplit(node, paneId) {
  if (!node || node.type === 'group') return null
  for (const child of node.children) {
    if (child.type === 'group' && child.panes.includes(paneId)) return node
    const deeper = coreParentSplit(child, paneId)
    if (deeper) return deeper
  }
  return null
}

/** Every core split as [id, childCount]. */
function coreSplits(node, out = []) {
  if (!node || node.type === 'group') return out
  out.push([node.id, node.children.length])
  node.children.forEach(child => coreSplits(child, out))
  return out
}

const holdsChat = (node, isChat) =>
  node.type === 'group' ? !node.minimized && node.panes.some(isChat) : node.children.some(c => holdsChat(c, isChat))

/**
 * Equalize plan for the chat area: [splitId, weights] for every split with 2+
 * chat-holding children. Those children share their current total equally;
 * every other child (sidebar, tool rails) keeps its weight, so the sidebar
 * never grows.
 */
function equalizePlan(node, isChat, out = []) {
  if (!node || node.type === 'group') return out
  const chat = node.children.map(c => holdsChat(c, isChat))
  const n = chat.filter(Boolean).length
  if (n >= 2) {
    const total = node.weights.reduce((sum, w, i) => sum + (chat[i] ? w : 0), 0)
    const weights = node.weights.map((w, i) => (chat[i] ? total / n : w))
    if (weights.some((w, i) => Math.abs(w - node.weights[i]) > 1e-9)) out.push([node.id, weights])
  }
  node.children.forEach(c => equalizePlan(c, isChat, out))
  return out
}

/** Move `id` to the front of a most-recent-first history, capped. */
function touch(history, id, cap = 32) {
  return [id, ...history.filter(h => h !== id)].slice(0, cap)
}

/** Live + stored session rows → one list, newest first, no duplicates, no empty drafts. */
function mergeSessionRows(live = [], stored = []) {
  const byId = new Map()
  for (const row of [...stored, ...live]) {
    if (!row?.id) continue
    const prev = byId.get(row.id)
    byId.set(row.id, prev ? { ...prev, ...row, title: row.title || prev.title } : row)
  }
  return [...byId.values()]
    .filter(r => (r.message_count ?? 1) > 0 || r.title)
    .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
}
/* ENGINE:END */

const ID = 'tiled-sessions'
const NEEDS = 'a Hermes Desktop with the session-layout SDK (host.state.sessionLayout)'
const DEFAULTS = { split_target: 'largest', max_tiles: 8, click: 'new-tile', replace_modifier: 'alt' }
const LIST_KEY = [ID, 'session.list']
const SIDEBAR_ESTIMATE = 280

/** The upstream hook ships `dock`, `sessionLayout` and `host.layout` together. */
const hasTiling = () => Boolean(host.state?.sessionLayout && typeof host.layout?.closePane === 'function')

const rowId = row => row.id
const rowKeys = row => [row.id, row._lineage_root_id].filter(Boolean)

function createController(ctx) {
  const $settings = atom({ ...DEFAULTS, ...(ctx.storage.get('settings', {}) || {}) })
  const $history = atom(ctx.storage.get('history', []) || [])
  // Stock Hermes only: what this plugin opened this run (core layout is unreadable there).
  const $openedHere = atom([])

  const setSettings = patch => {
    const next = { ...$settings.get(), ...patch }
    $settings.set(next)
    ctx.storage.set('settings', next)
  }

  const layout = () => (hasTiling() ? host.state.sessionLayout.get() : null)

  /** Pane id showing `storedId`, or null when it is not on screen. */
  function paneOf(storedId) {
    const l = layout()
    if (!l || !storedId) return null
    return openSessions(l.root, l.mainStoredSessionId).find(o => o.storedSessionId === storedId)?.paneId ?? null
  }

  const noteFocus = storedId => {
    const paneId = paneOf(storedId)
    if (!paneId) return
    const next = touch($history.get(), paneId)
    $history.set(next)
    ctx.storage.set('history', next)
  }

  /** Engine tree of the chat panes + the area they fill. Only the aspect ratio
   *  matters (wide → side by side, tall → stacked), so window minus sidebar is enough. */
  function engineView() {
    const l = layout()
    const vp = host.state.viewport.get()
    return { l, tree: fromCore(l?.root ?? null, isSessionPane), area: { x: 0, y: 0, w: Math.max(320, (vp.width || 1600) - SIDEBAR_ESTIMATE), h: vp.height || 900 } }
  }

  const opts = () => ({ history: $history.get(), isCandidate: isSessionPane })

  async function open(storedId, { replace = false } = {}) {
    if (!storedId) return
    const s = $settings.get()
    if (replace || s.click === 'replace') {
      await host.openSession(storedId, { intent: 'in-place' })
      return
    }
    if (!hasTiling()) {
      // Stock Hermes: core focuses an open tile or stacks a tab — never a duplicate.
      await host.openSession(storedId, { intent: 'tab' })
      if (!$openedHere.get().some(o => o.storedSessionId === storedId)) {
        $openedHere.set([...$openedHere.get(), { paneId: null, storedSessionId: storedId, visible: true }])
      }
      return
    }
    const { l, tree, area } = engineView()
    const open = openSessions(l.root, l.mainStoredSessionId)
    if (open.some(o => o.storedSessionId === storedId)) {
      await host.openSession(storedId, { intent: 'tab' }) // already on screen → focus it
      return
    }
    if (!l.mainStoredSessionId) {
      await host.openSession(storedId, { intent: 'in-place' }) // blank main → spend it
      return
    }
    if (open.length >= s.max_tiles) {
      host.notify({ kind: 'info', message: `Tiled Sessions: ${s.max_tiles} tiles open — opened in place instead.` })
      await host.openSession(storedId, { intent: 'in-place' })
      return
    }
    const res = insert(tree, area, `session-tile:${storedId}`, {
      ...opts(),
      mode: s.split_target,
      focused: paneOf(host.state.focusedStoredSessionId.get())
    })
    await host.openSession(storedId, { intent: 'tab', dock: res.target ? { pane: res.target, pos: res.pos } : undefined })
    focusOnceTiled(storedId)
  }

  /** Like a tiling WM, focus the new tile — once core has adopted it (async).
   *  Re-opening an on-screen session only focuses it, so this never stacks. */
  function focusOnceTiled(storedId, tries = 12) {
    if (paneOf(storedId)) {
      void host.openSession(storedId, { intent: 'tab' })
      return
    }
    if (tries > 0) ctx.setTimeout(() => focusOnceTiled(storedId, tries - 1), 100)
  }

  function close(storedId) {
    if (!hasTiling()) {
      $openedHere.set($openedHere.get().filter(o => o.storedSessionId !== storedId))
      return
    }
    const pane = paneOf(storedId)
    if (pane) host.layout.closePane(pane)
  }

  function neighbourOfFocused(dir) {
    if (!hasTiling()) return null
    const { tree, area } = engineView()
    const from = paneOf(host.state.focusedStoredSessionId.get())
    if (!tree || !from) return null
    const to = neighbor(tree, area, from, dir, opts())
    return to ? { from, to } : null
  }

  function focusDir(dir) {
    const hit = neighbourOfFocused(dir)
    const target = hit && storedIdOfPane(hit.to, layout().mainStoredSessionId)
    if (target) void host.openSession(target, { intent: 'tab' })
  }

  function swapDir(dir) {
    const hit = neighbourOfFocused(dir)
    if (hit) host.layout.swapPanes(hit.from, hit.to)
  }

  function toggleFocusedSplit() {
    const pane = paneOf(host.state.focusedStoredSessionId.get())
    const parent = pane ? coreParentSplit(layout().root, pane) : null
    if (parent) host.layout.setSplitOrientation(parent.id, parent.orientation === 'row' ? 'column' : 'row')
  }

  function equalizeAll() {
    if (!hasTiling()) return
    for (const [splitId, weights] of equalizePlan(layout().root, isSessionPane)) host.layout.setSplitWeights(splitId, weights)
  }

  function openInPlace() {
    const id = host.state.focusedStoredSessionId.get()
    if (id) void host.openSession(id, { intent: 'main' })
  }

  return { $settings, $openedHere, setSettings, noteFocus, open, close, focusDir, swapDir, toggleFocusedSplit, equalizeAll, openInPlace }
}

function useSessionRows() {
  const profile = useValue(host.state.profile)
  return useQuery({
    queryKey: [...LIST_KEY, profile],
    // The gateway lists running sessions (default scope) and resumable history
    // (`scope: 'stored'`) separately; an open chat is only in the first.
    queryFn: async () => {
      const [live, stored] = await Promise.all([
        host.request('session.list', { limit: 200 }).catch(() => ({ sessions: [] })),
        host.request('session.list', { limit: 200, scope: 'stored' }).catch(() => ({ sessions: [] }))
      ])
      return { sessions: mergeSessionRows(live?.sessions, stored?.sessions) }
    },
    staleTime: 30_000
  })
}

function Row({ storedId, title, focused, onOpen, onClose, dim }) {
  return jsxs('div', {
    className: cn(
      'group relative flex h-7 cursor-pointer items-center gap-2 rounded-md pl-2.5 pr-1 text-[0.8125rem] transition-colors',
      focused ? 'text-foreground' : 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground',
      dim && !focused && 'opacity-60'
    ),
    role: 'button',
    tabIndex: 0,
    'aria-current': focused ? 'true' : undefined,
    style: focused ? { background: 'color-mix(in srgb, var(--ui-accent) 14%, transparent)' } : undefined,
    title,
    onClick: e => onOpen(storedId, e),
    onKeyDown: e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onOpen(storedId, e)
      }
    },
    children: [
      focused ? jsx('span', { 'aria-hidden': true, className: 'absolute left-0 w-0.5 rounded-full bg-(--ui-accent)', style: { top: 6, bottom: 6 } }) : null,
      jsx(SessionStatusDot, { storedSessionId: storedId }),
      jsx('span', { className: 'min-w-0 flex-1 truncate', children: title }),
      onClose
        ? jsx('button', {
            type: 'button',
            'aria-label': `Close ${title}`,
            className:
              'grid size-5 shrink-0 place-items-center rounded text-(--ui-text-tertiary) opacity-0 transition-opacity hover:bg-(--chrome-action-hover) hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100',
            onClick: e => {
              e.stopPropagation()
              onClose(storedId)
            },
            children: jsx(Codicon, { name: 'close', className: 'text-[0.75rem]' })
          })
        : null
    ]
  })
}

function Section({ label, count, children }) {
  return jsxs('section', {
    className: 'flex flex-col gap-px pb-3',
    children: [
      jsxs('div', {
        className: 'flex items-baseline gap-1.5 px-2.5 pb-1 pt-1 text-[0.6875rem] font-medium uppercase text-(--ui-text-quaternary)',
        style: { letterSpacing: '0.06em' },
        children: [label, count ? jsx('span', { className: 'tabular-nums', children: count }) : null]
      }),
      ...children
    ]
  })
}

function makePane(ctl) {
  const tiling = hasTiling()

  // Two components so each calls a fixed set of hooks.
  function useOpen() {
    const l = useValue(host.state.sessionLayout)
    return { open: openSessions(l.root, l.mainStoredSessionId), pinnedIds: useValue(host.state.pinnedSessionIds) }
  }

  function useOpenStock() {
    return { open: useValue(ctl.$openedHere), pinnedIds: [] }
  }

  return function TiledSessionsPane() {
    const { data } = useSessionRows()
    const focused = useValue(host.state.focusedStoredSessionId)
    const settings = useValue(ctl.$settings)
    const { open, pinnedIds } = tiling ? useOpen() : useOpenStock()
    const rows = data?.sessions ?? []
    const byKey = new Map()
    for (const r of rows) for (const k of rowKeys(r)) if (!byKey.has(k)) byKey.set(k, r)
    const titleOf = id => {
      const r = byKey.get(id)
      return (r && (r.title || r.preview)) || 'Untitled chat'
    }

    const onOpen = (id, e) => void ctl.open(id, { replace: Boolean(e?.[`${settings.replace_modifier}Key`]) })
    const openIds = new Set(open.map(o => o.storedSessionId))
    const pinned = pinnedIds.map(id => byKey.get(id)).filter(Boolean)
    const pinnedIdSet = new Set(pinned.map(rowId))
    const rest = rows.filter(r => !pinnedIdSet.has(rowId(r)) && !openIds.has(rowId(r)))

    return jsxs('div', {
      className: 'flex h-full flex-col overflow-y-auto px-1.5 py-2',
      children: [
        tiling
          ? null
          : jsx('p', {
              className: 'mx-1 mb-3 rounded-md border border-(--ui-stroke-secondary) px-2.5 py-2 text-xs leading-relaxed text-(--ui-text-tertiary)',
              children: `Tiling needs ${NEEDS}. Until then, sessions open as tabs.`
            }),
        pinned.length
          ? jsx(Section, {
              label: 'Pinned',
              children: pinned.map(r =>
                jsx(Row, { storedId: rowId(r), title: titleOf(rowId(r)), focused: focused === rowId(r), onOpen }, `p:${rowId(r)}`)
              )
            })
          : null,
        jsx(Section, {
          label: tiling ? 'Open' : 'Opened here',
          count: open.length || null,
          children: open.length
            ? open.map(o =>
                jsx(
                  Row,
                  {
                    storedId: o.storedSessionId,
                    title: titleOf(o.storedSessionId),
                    focused: focused === o.storedSessionId,
                    dim: !o.visible,
                    onOpen,
                    onClose: ctl.close
                  },
                  `o:${o.storedSessionId}`
                )
              )
            : [jsx('p', { className: 'px-2.5 text-xs text-(--ui-text-quaternary)', children: 'Click a session to open it in a new tile.' }, 'empty')]
        }),
        jsx(Section, {
          label: 'Sessions',
          children: rest.map(r => jsx(Row, { storedId: rowId(r), title: titleOf(rowId(r)), focused: false, onOpen }, `s:${rowId(r)}`))
        })
      ]
    })
  }
}

function makeSettings(ctl) {
  return function TiledSessionsSettings() {
    const s = useValue(ctl.$settings)
    return jsxs('div', {
      className: 'flex flex-col',
      children: [
        hasTiling()
          ? null
          : jsx('p', { className: 'pb-3 text-sm text-(--ui-text-tertiary)', children: `Tiling needs ${NEEDS}. These settings apply once it is available.` }),
        jsx(ListRow, {
          title: 'Split target',
          description: 'Largest splits the biggest tile, for even grids. Focused splits the focused tile, for a dwindle spiral.',
          action: jsx(SegmentedControl, {
            options: [
              { id: 'largest', label: 'Largest' },
              { id: 'focused', label: 'Focused' }
            ],
            value: s.split_target,
            onChange: v => ctl.setSettings({ split_target: v })
          })
        }),
        jsx(ListRow, {
          title: 'Max tiles',
          description: 'Past this, a click opens the session in place.',
          action: jsx(SegmentedControl, {
            options: ['4', '6', '8', '12'].map(n => ({ id: n, label: n })),
            value: String(s.max_tiles),
            onChange: v => ctl.setSettings({ max_tiles: Number(v) })
          })
        }),
        jsx(ToggleRow, {
          label: 'Click opens a new tile',
          description: 'Off: a click replaces the focused chat, like stock Hermes.',
          checked: s.click === 'new-tile',
          onChange: on => ctl.setSettings({ click: on ? 'new-tile' : 'replace' })
        }),
        jsx(ListRow, {
          title: 'Replace-in-place modifier',
          description: 'Hold this key while clicking to open in place instead.',
          action: jsx(SegmentedControl, {
            options: [
              { id: 'alt', label: 'Alt' },
              { id: 'shift', label: 'Shift' }
            ],
            value: s.replace_modifier,
            onChange: v => ctl.setSettings({ replace_modifier: v })
          })
        })
      ]
    })
  }
}

export default {
  id: ID,
  name: 'Tiled Sessions',
  register(ctx) {
    const ctl = createController(ctx)

    ctx.onDispose(host.state.focusedStoredSessionId.listen(id => ctl.noteFocus(id)))
    const invalidate = () => void queryClient.invalidateQueries({ queryKey: LIST_KEY })
    ctx.onEvent('sessions.changed', invalidate)
    ctx.onEvent('session.title', invalidate)

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Tiles',
      render: makePane(ctl),
      data: { placement: 'left', dock: { pane: 'sessions', pos: 'center' } }
    })

    ctx.registerSettingsPage({ id: 'settings', title: 'Tiled Sessions', icon: 'layout', render: makeSettings(ctl) })

    const actions = [
      ['focus-left', 'Tiles: focus left', ['mod+alt+left'], () => ctl.focusDir('left')],
      ['focus-right', 'Tiles: focus right', ['mod+alt+right'], () => ctl.focusDir('right')],
      ['focus-up', 'Tiles: focus up', ['mod+alt+up'], () => ctl.focusDir('up')],
      ['focus-down', 'Tiles: focus down', ['mod+alt+down'], () => ctl.focusDir('down')],
      ['swap-left', 'Tiles: swap left', ['mod+alt+shift+left'], () => ctl.swapDir('left')],
      ['swap-right', 'Tiles: swap right', ['mod+alt+shift+right'], () => ctl.swapDir('right')],
      ['swap-up', 'Tiles: swap up', ['mod+alt+shift+up'], () => ctl.swapDir('up')],
      ['swap-down', 'Tiles: swap down', ['mod+alt+shift+down'], () => ctl.swapDir('down')],
      ['close', 'Tiles: close focused tile', ['mod+alt+backspace'], () => ctl.close(host.state.focusedStoredSessionId.get())],
      ['toggle-split', 'Tiles: toggle split direction', ['mod+alt+j'], () => ctl.toggleFocusedSplit()],
      ['equalize', 'Tiles: equalize sizes', ['mod+alt+='], () => ctl.equalizeAll()],
      ['open-in-place', 'Tiles: move focused session to main', [], () => ctl.openInPlace()]
    ]
    for (const [id, label, defaults, run] of actions) {
      ctx.register({ id: `key:${id}`, area: KEYBINDS_AREA, data: { id: `${ID}.${id}`, label, category: 'view', defaults, run } })
      ctx.register({ id: `cmd:${id}`, area: PALETTE_AREA, data: { id: `${ID}.${id}`, label, action: `${ID}.${id}`, run } })
    }
  }
}
