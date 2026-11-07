// Tiled Sessions — Hyprland-style tiling for Hermes Desktop sessions.
//
// GENERATED: desktop/plugin.js is this file with src/engine.mjs inlined at the
// ENGINE marker by scripts/build.mjs. Edit src/, then `npm run build`.
// SDK-only: imports @hermes/plugin-sdk and react/jsx-runtime, nothing else.
// Newer SDK exports (KeybindEditor) are read off the namespace so the plugin
// still loads, with fallbacks, on a Desktop that predates them.

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
import * as SDK from '@hermes/plugin-sdk'
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

// ---------------------------------------------------------------------------
// Layouts: ordered chat zones → a core arrangement spec
// (host.layout.arrangeSessions). Leaves are { pane }, splits are
// { orientation, children, weights? }.
// ---------------------------------------------------------------------------

const LAYOUTS = ['grid', 'master', 'dwindle', 'columns']

/** Every chat zone in the core tree, in tree order: { groupId, pane } where
 *  `pane` is the zone's active pane. A zone counts when all its panes are chats. */
function chatZones(coreRoot, isChat = isSessionPane) {
  const out = []
  const walk = n => {
    if (!n) return
    if (n.type === 'group') {
      // Any chat makes it a chat zone; other tabs (Preview, a plugin workspace)
      // move with it. Name it by its active tab when that is a chat.
      const chats = n.panes.filter(isChat)
      if (chats.length) out.push({ groupId: n.id, pane: chats.includes(n.active) ? n.active : chats[0] })
      return
    }
    n.children.forEach(walk)
  }
  walk(coreRoot)
  return out
}

/** Keep `order` (group ids) for zones still open, append new zones in tree
 *  order. New zones go right after `after` when given (dwindle-style). */
function reconcileOrder(order, zoneIds, after = null) {
  const open = new Set(zoneIds)
  const kept = order.filter(id => open.has(id))
  const fresh = zoneIds.filter(id => !kept.includes(id))
  if (!fresh.length) return kept
  const at = after ? kept.indexOf(after) : -1
  return at === -1 ? [...kept, ...fresh] : [...kept.slice(0, at + 1), ...fresh, ...kept.slice(at + 1)]
}

/** Rows × columns for `n` equal tiles in `area`: tiles as close to square as
 *  possible, few empty cells (the last row's tiles widen to fill). */
function gridDims(n, area) {
  let best = { rows: 1, cols: Math.max(1, n), cost: Infinity }
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const empty = rows * cols - n
    if (empty >= cols) continue
    const aspect = area.w / cols / (area.h / rows)
    const cost = Math.abs(Math.log(aspect)) + 0.35 * empty
    if (cost < best.cost - 1e-9) best = { rows, cols, cost }
  }
  return { rows: best.rows, cols: best.cols }
}

const leafOf = pane => ({ pane })
const row = children => (children.length === 1 ? children[0] : { orientation: 'row', children })
const column = children => (children.length === 1 ? children[0] : { orientation: 'column', children })

/**
 * Arrangement spec for `panes` (in order) filling `area`.
 *  grid     every tile the same height; rows split evenly (Hyprland-ish "grid")
 *  master   first pane on the left at `masterRatio`, the rest stacked evenly
 *  dwindle  Hyprland's default: each tile halves the previous along its long side
 *  columns  side by side, equal widths
 */
function arrangement(layout, panes, area, { masterRatio = 0.55 } = {}) {
  const n = panes.length
  if (n === 0) return null
  if (n === 1) return leafOf(panes[0])
  const leaves = panes.map(leafOf)
  if (layout === 'columns') return row(leaves)
  if (layout === 'master') {
    const r = Math.min(0.85, Math.max(0.15, masterRatio))
    const tall = area.h > area.w
    const stack = tall ? row(leaves.slice(1)) : column(leaves.slice(1))
    return { orientation: tall ? 'column' : 'row', weights: [r, 1 - r], children: [leaves[0], stack] }
  }
  if (layout === 'dwindle') {
    const build = (i, rect) => {
      if (i === n - 1) return leaves[i]
      const wide = rect.w >= rect.h
      const rest = wide ? { w: rect.w / 2, h: rect.h } : { w: rect.w, h: rect.h / 2 }
      return { orientation: wide ? 'row' : 'column', children: [leaves[i], build(i + 1, rest)] }
    }
    return build(0, area)
  }
  // grid
  const { rows, cols } = gridDims(n, area)
  const lines = []
  for (let r = 0; r < rows; r++) lines.push(row(leaves.slice(r * cols, (r + 1) * cols)))
  return column(lines.filter(l => l))
}

/** Next layout in LAYOUTS after `current`. */
const nextLayout = current => LAYOUTS[(LAYOUTS.indexOf(current) + 1) % LAYOUTS.length]

/** Move `id` to the front (master). */
const promote = (order, id) => (order.includes(id) ? [id, ...order.filter(o => o !== id)] : order)

/** Exchange two ids in `order`. */
function swapOrder(order, p, q) {
  const i = order.indexOf(p)
  const j = order.indexOf(q)
  if (i === -1 || j === -1) return order
  const next = [...order]
  next[i] = q
  next[j] = p
  return next
}

/** Leaf rects of an arrangement spec (equal weights unless given). */
function specRects(spec, rect, out = new Map()) {
  if (!spec) return out
  if (spec.pane) {
    out.set(spec.pane, rect)
    return out
  }
  const w = spec.weights ?? spec.children.map(() => 1)
  const total = w.reduce((a, b) => a + b, 0) || 1
  let at = 0
  spec.children.forEach((c, i) => {
    const f = w[i] / total
    const r =
      spec.orientation === 'row'
        ? { x: rect.x + rect.w * at, y: rect.y, w: rect.w * f, h: rect.h }
        : { x: rect.x, y: rect.y + rect.h * at, w: rect.w, h: rect.h * f }
    specRects(c, r, out)
    at += f
  })
  return out
}

/** Id of the core group holding `paneId`, or null. */
function groupIdOfPane(coreRoot, paneId) {
  if (!coreRoot || !paneId) return null
  if (coreRoot.type === 'group') return coreRoot.panes.includes(paneId) ? coreRoot.id : null
  for (const c of coreRoot.children) {
    const hit = groupIdOfPane(c, paneId)
    if (hit) return hit
  }
  return null
}

// ---------------------------------------------------------------------------
// Session rows
// ---------------------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** Same fields core's sidebar shows: comfortable = branch · model · counts;
 *  detailed adds the opening request when the chat has its own title. */
function rowDetails(session) {
  if (!session) return { metadata: '', preview: null }
  const model = session.model?.split('/').pop()?.trim() || null
  const metadata = [
    session.git_branch?.trim() || null,
    model,
    session.message_count > 0 ? plural(session.message_count, 'message', 'messages') : null,
    session.tool_call_count > 0 ? plural(session.tool_call_count, 'tool call', 'tool calls') : null
  ]
    .filter(Boolean)
    .join(' · ')
  const preview = session.preview?.replace(/\s+/g, ' ').trim() || null
  return { metadata, preview: session.title?.trim() ? preview : null }
}
/* ENGINE:END */

const ID = 'tiled-sessions'
const NEEDS = 'a Hermes Desktop with the session-layout SDK (host.state.sessionLayout)'
const DEFAULTS = {
  layout: 'grid',
  master_ratio: 0.55,
  auto_tile: true,
  split_target: 'largest',
  max_tiles: 8,
  click: 'new-tile',
  replace_modifier: 'alt'
}
const LAYOUT_INFO = {
  grid: { label: 'Grid', blurb: 'Every tile the same size.' },
  master: { label: 'Master', blurb: 'One big tile, the rest stacked beside it.' },
  dwindle: { label: 'Dwindle', blurb: 'Each new tile halves the last, like Hyprland.' },
  columns: { label: 'Columns', blurb: 'Side by side, equal widths.' }
}
const LIST_KEY = [ID, 'session.list']
const SIDEBAR_ESTIMATE = 280

/** The upstream hook ships `dock`, `sessionLayout` and `host.layout` together. */
const hasTiling = () => Boolean(host.state?.sessionLayout && typeof host.layout?.closePane === 'function')
/** Layouts need `host.layout.arrangeSessions` (same upstream PR, later revision). */
const canArrange = () => hasTiling() && typeof host.layout?.arrangeSessions === 'function'
const KeybindEditor = SDK.KeybindEditor

const rowId = row => row.id
const rowKeys = row => [row.id, row._lineage_root_id].filter(Boolean)

function createController(ctx) {
  const stored = ctx.storage.get('settings', {}) || {}
  const $settings = atom({ ...DEFAULTS, ...stored, layout: LAYOUTS.includes(stored.layout) ? stored.layout : DEFAULTS.layout })
  const $history = atom(ctx.storage.get('history', []) || [])
  const $order = atom(ctx.storage.get('order', []) || [])
  // Stock Hermes only: what this plugin opened this run (core layout is unreadable there).
  const $openedHere = atom([])
  let lastKey = null
  let insertAfter = null
  let warned = false
  let newTileAt = 0
  let lastZones = []

  const setSettings = patch => {
    const next = { ...$settings.get(), ...patch }
    $settings.set(next)
    ctx.storage.set('settings', next)
  }

  const setOrder = next => {
    $order.set(next)
    ctx.storage.set('order', next)
  }

  const layout = () => (hasTiling() ? host.state.sessionLayout.get() : null)

  /** Pane id showing `storedId`, or null when it is not on screen. */
  function paneOf(storedId) {
    const l = layout()
    if (!l || !storedId) return null
    return openSessions(l.root, l.mainStoredSessionId).find(o => o.storedSessionId === storedId)?.paneId ?? null
  }

  const focusedPane = () => paneOf(host.state.focusedStoredSessionId.get())
  const focusedGroup = () => groupIdOfPane(layout()?.root ?? null, focusedPane())

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
  const zoneKey = zones => zones.map(z => z.groupId).sort().join(',')

  /**
   * Re-tile every chat with the current layout. Auto-tiling runs this whenever
   * the SET of open tiles changes (open, close, ⌘W, drag-out); a drag or sash
   * resize that keeps the set is left alone. `force` re-tiles regardless.
   */
  function retile({ force = false } = {}) {
    if (!canArrange()) return false
    const l = layout()
    const zones = chatZones(l?.root ?? null)
    const key = zoneKey(zones)
    if (!force && key === lastKey) return false
    const order = reconcileOrder($order.get(), zones.map(z => z.groupId), $settings.get().layout === 'dwindle' ? insertAfter : null)
    insertAfter = null
    if (order.join() !== $order.get().join()) setOrder(order)
    lastKey = key
    if (zones.length < 2) return true
    const s = $settings.get()
    const paneOfGroup = new Map(zones.map(z => [z.groupId, z.pane]))
    const spec = arrangement(s.layout, order.map(g => paneOfGroup.get(g)), engineView().area, { masterRatio: s.master_ratio })
    const ok = host.layout.arrangeSessions(spec)
    if (!ok && !warned) {
      warned = true
      host.notify({ kind: 'info', message: 'Tiled Sessions: a non-chat pane sits between your chats, so tiles were left as they are. Move it aside to re-tile.' })
    }
    return ok
  }

  /** Called on every layout change: auto-tile when the set of tiles changed. */
  function onLayout() {
    if (!canArrange()) return
    const key = zoneKey(chatZones(layout()?.root ?? null))
    if (lastKey === null) {
      // First sight after load: adopt what's on screen (keep the user's sizes).
      lastKey = key
      lastZones = chatZones(layout()?.root ?? null)
      setOrder(reconcileOrder($order.get(), lastZones.map(z => z.groupId)))
      return
    }
    if (key === lastKey) return
    const zones = chatZones(layout()?.root ?? null)
    const added = zones.filter(z => !lastZones.some(o => o.groupId === z.groupId))
    lastZones = zones
    const closed = key.split(',').length < lastKey.split(',').length
    // A chat we just asked for (Ctrl+Alt+Enter) gets focus, as a WM does.
    if (added.length === 1 && Date.now() - newTileAt < 8000) {
      newTileAt = 0
      const id = storedIdOfPane(added[0].pane, layout().mainStoredSessionId)
      if (id) ctx.setTimeout(() => host.composer?.focus?.(id), 80)
    }
    if ($settings.get().auto_tile) retile()
    else lastKey = key
    // A tile closed (ours, ⌘W, its ✕): core moves the highlight, but the caret
    // can stay on a different tile. Re-sync so typing and ⌘W follow the highlight.
    if (closed) {
      ctx.setTimeout(() => {
        const id = host.state.focusedStoredSessionId.get()
        if (id) host.composer?.focus?.(id)
      }, 60)
    }
  }

  /** Focus an on-screen session the way a tiling WM does: front its tile AND
   *  move the keyboard into its composer, so typing, ⌘W and the readouts all
   *  agree on which tile is "the" tile. */
  async function focusTile(storedId) {
    await host.openSession(storedId, { intent: 'tab' })
    host.composer?.focus?.(storedId)
  }

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
      await focusTile(storedId) // already on screen → focus it
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
    insertAfter = focusedGroup()
    const res = insert(tree, area, `session-tile:${storedId}`, {
      ...opts(),
      mode: s.split_target,
      focused: focusedPane()
    })
    await host.openSession(storedId, { intent: 'tab', dock: res.target ? { pane: res.target, pos: res.pos } : undefined })
    focusOnceTiled(storedId)
  }

  /** Like a tiling WM, focus the new tile — once core has adopted it (async).
   *  Re-opening an on-screen session only focuses it, so this never stacks. */
  function focusOnceTiled(storedId, tries = 12) {
    if (paneOf(storedId)) {
      void focusTile(storedId)
      return
    }
    if (tries > 0) ctx.setTimeout(() => focusOnceTiled(storedId, tries - 1), 100)
  }

  function newTile() {
    if (typeof host.layout?.newChatTile !== 'function') {
      host.notify({ kind: 'info', message: `Tiled Sessions: new chat tiles need ${NEEDS}.` })
      return
    }
    insertAfter = focusedGroup()
    newTileAt = Date.now()
    host.layout.newChatTile({ pane: focusedPane() ?? 'workspace', pos: 'right' })
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
    const from = focusedPane()
    if (!tree || !from) return null
    const to = neighbor(tree, area, from, dir, opts())
    return to ? { from, to } : null
  }

  function focusDir(dir) {
    const hit = neighbourOfFocused(dir)
    const target = hit && storedIdOfPane(hit.to, layout().mainStoredSessionId)
    if (target) void focusTile(target)
  }

  function swapDir(dir) {
    const hit = neighbourOfFocused(dir)
    if (!hit) return
    if (canArrange() && $settings.get().auto_tile) {
      const root = layout().root
      setOrder(swapOrder($order.get(), groupIdOfPane(root, hit.from), groupIdOfPane(root, hit.to)))
      retile({ force: true })
    } else {
      host.layout.swapPanes(hit.from, hit.to)
    }
    const id = host.state.focusedStoredSessionId.get()
    if (id) ctx.setTimeout(() => void focusTile(id), 50)
  }

  function promoteFocused() {
    const g = focusedGroup()
    if (!g || !canArrange()) return
    setOrder(promote($order.get(), g))
    retile({ force: true })
  }

  function setLayout(next, { announce = false } = {}) {
    if (!LAYOUTS.includes(next)) return
    setSettings({ layout: next })
    if (canArrange()) retile({ force: true })
    // The status-bar chip and the Tiles pane show the layout; a toast per
    // press would pile up while cycling. Announce only without them.
    if (announce && !canArrange()) host.notify({ kind: 'info', message: `Tiles: ${LAYOUT_INFO[next].label}` })
  }

  const cycleLayout = () => setLayout(nextLayout($settings.get().layout), { announce: true })

  function equalizeAll() {
    if (!hasTiling()) return
    if (canArrange()) {
      retile({ force: true })
      return
    }
    for (const [splitId, weights] of equalizePlan(layout().root, isSessionPane)) host.layout.setSplitWeights(splitId, weights)
  }

  function openInPlace() {
    const id = host.state.focusedStoredSessionId.get()
    if (id) void host.openSession(id, { intent: 'main' })
  }

  return {
    $settings,
    $openedHere,
    setSettings,
    setLayout,
    noteFocus,
    onLayout,
    open,
    newTile,
    close,
    focusDir,
    swapDir,
    promoteFocused,
    cycleLayout,
    equalizeAll,
    openInPlace
  }
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

// Session-list density (Settings → Appearance), read-only from core when the
// SDK exposes it; older Desktops get the one-line compact row.
const COMPACT = atom('compact')
const densityAtom = () => host.state?.sessionListDensity ?? COMPACT
const ROW_HEIGHT = { compact: 'h-7', comfortable: 'min-h-[2.75rem] py-1', detailed: 'min-h-[3.875rem] py-1' }

function Row({ storedId, title, session, focused, onOpen, onClose, dim }) {
  const density = useValue(densityAtom())
  const details = density === 'compact' ? null : rowDetails(session)
  return jsxs('div', {
    className: cn(
      'group relative flex cursor-pointer items-center gap-2 rounded-md pl-2.5 pr-1 text-[0.8125rem] transition-colors',
      ROW_HEIGHT[density] ?? ROW_HEIGHT.compact,
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
      jsxs('span', {
        className: 'min-w-0 flex-1',
        children: [
          jsx('span', { className: 'block truncate', children: title }),
          details?.metadata
            ? jsx('span', { className: 'mt-0.5 block truncate text-[0.625rem] text-(--ui-text-tertiary)', children: details.metadata })
            : null,
          density === 'detailed' && details?.preview
            ? jsx('span', { className: 'mt-1 block truncate text-[0.625rem] text-(--ui-text-quaternary)', children: details.preview })
            : null
        ]
      }),
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

/** Above the Open list: a fresh chat in its own tile (plain new chat without tiling). */
function NewSessionRow({ ctl }) {
  const run = () => (typeof host.layout?.newChatTile === 'function' ? ctl.newTile() : host.newChat())
  return jsxs('button', {
    type: 'button',
    className:
      'mb-2 flex h-7 w-full items-center gap-2 rounded-md pl-2.5 pr-1 text-left text-[0.8125rem] text-(--ui-text-secondary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
    onClick: run,
    children: [jsx(Codicon, { name: 'add', className: 'text-[0.875rem]' }), jsx('span', { className: 'min-w-0 flex-1 truncate', children: 'New session' })]
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

/** Mini diagram of a layout with four tiles, drawn from the real engine. */
function LayoutGlyph({ layout, active, w = 34, h = 22 }) {
  const rects = specRects(arrangement(layout, ['a', 'b', 'c', 'd'], { x: 0, y: 0, w, h }), { x: 0, y: 0, w, h })
  const gap = 1.5
  return jsx('span', {
    'aria-hidden': true,
    className: 'relative inline-block shrink-0',
    style: { width: w, height: h },
    children: [...rects.values()].map((r, i) =>
      jsx(
        'span',
        {
          className: 'absolute rounded-[2px]',
          style: {
            left: r.x + gap / 2,
            top: r.y + gap / 2,
            width: Math.max(1, r.w - gap),
            height: Math.max(1, r.h - gap),
            background: active
              ? i === 0
                ? 'var(--ui-accent)'
                : 'color-mix(in srgb, var(--ui-accent) 45%, transparent)'
              : 'color-mix(in srgb, var(--ui-text-secondary) 38%, transparent)'
          }
        },
        i
      )
    )
  })
}

/** Four-way layout switch for the Tiles pane header. */
function LayoutSwitcher({ ctl }) {
  const s = useValue(ctl.$settings)
  return jsx('div', {
    role: 'radiogroup',
    'aria-label': 'Tile layout',
    className: 'mx-1 mb-3 grid grid-cols-4 gap-1 rounded-lg border border-(--ui-stroke-secondary) p-1',
    children: LAYOUTS.map(id =>
      jsxs(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': s.layout === id,
          title: `${LAYOUT_INFO[id].label}: ${LAYOUT_INFO[id].blurb}`,
          className: cn(
            'flex flex-col items-center gap-1 rounded-md px-1 pb-1 pt-1.5 text-[0.6875rem] transition-colors',
            s.layout === id ? 'text-foreground' : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
          ),
          style: s.layout === id ? { background: 'color-mix(in srgb, var(--ui-accent) 14%, transparent)' } : undefined,
          onClick: () => ctl.setLayout(id),
          children: [jsx(LayoutGlyph, { layout: id, active: s.layout === id, w: 28, h: 18 }), LAYOUT_INFO[id].label]
        },
        id
      )
    )
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
        canArrange() ? jsx(LayoutSwitcher, { ctl }) : null,
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
                jsx(Row, { storedId: rowId(r), title: titleOf(rowId(r)), session: r, focused: focused === rowId(r), onOpen }, `p:${rowId(r)}`)
              )
            })
          : null,
        jsx(NewSessionRow, { ctl }),
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
                    session: byKey.get(o.storedSessionId),
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
          children: rest.map(r => jsx(Row, { storedId: rowId(r), title: titleOf(rowId(r)), session: r, focused: false, onOpen }, `s:${rowId(r)}`))
        })
      ]
    })
  }
}

const ACTIONS = [
  // [id, label, defaults, run(ctl)]
  ['focus-left', 'Focus left', ['ctrl+alt+left'], c => c.focusDir('left')],
  ['focus-right', 'Focus right', ['ctrl+alt+right'], c => c.focusDir('right')],
  ['focus-up', 'Focus up', ['ctrl+alt+up'], c => c.focusDir('up')],
  ['focus-down', 'Focus down', ['ctrl+alt+down'], c => c.focusDir('down')],
  ['swap-left', 'Move tile left', ['ctrl+alt+shift+left'], c => c.swapDir('left')],
  ['swap-right', 'Move tile right', ['ctrl+alt+shift+right'], c => c.swapDir('right')],
  ['swap-up', 'Move tile up', ['ctrl+alt+shift+up'], c => c.swapDir('up')],
  ['swap-down', 'Move tile down', ['ctrl+alt+shift+down'], c => c.swapDir('down')],
  ['new-tile', 'New chat in a new tile', ['ctrl+alt+enter'], c => c.newTile()],
  ['close', 'Close focused tile', ['ctrl+alt+w'], c => c.close(host.state.focusedStoredSessionId.get())],
  ['cycle-layout', 'Next layout', ['ctrl+alt+space'], c => c.cycleLayout()],
  ['promote', 'Make focused tile the master', ['ctrl+alt+m'], c => c.promoteFocused()],
  ['equalize', 'Re-tile and reset sizes', ['ctrl+alt+r'], c => c.equalizeAll()],
  ['layout-grid', 'Layout: Grid', [], c => c.setLayout('grid', { announce: true })],
  ['layout-master', 'Layout: Master', [], c => c.setLayout('master', { announce: true })],
  ['layout-dwindle', 'Layout: Dwindle', [], c => c.setLayout('dwindle', { announce: true })],
  ['layout-columns', 'Layout: Columns', [], c => c.setLayout('columns', { announce: true })],
  ['open-in-place', 'Move focused session to main', [], c => c.openInPlace()]
]

function SettingsHeading({ children }) {
  return jsx('h3', {
    className: 'px-2.5 pb-1.5 pt-5 text-[0.6875rem] font-medium uppercase text-(--ui-text-quaternary)',
    style: { letterSpacing: '0.06em' },
    children
  })
}

function LayoutCards({ ctl, value }) {
  return jsx('div', {
    role: 'radiogroup',
    'aria-label': 'Layout',
    className: 'grid grid-cols-2 gap-2 px-1 pb-1 sm:grid-cols-4',
    children: LAYOUTS.map(id =>
      jsxs(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': value === id,
          className: cn(
            'flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors',
            value === id ? 'border-(--ui-accent)' : 'border-(--ui-stroke-secondary) hover:bg-(--chrome-action-hover)'
          ),
          style: value === id ? { background: 'color-mix(in srgb, var(--ui-accent) 10%, transparent)' } : undefined,
          onClick: () => ctl.setLayout(id),
          children: [
            jsx(LayoutGlyph, { layout: id, active: value === id, w: 64, h: 40 }),
            jsx('span', { className: 'text-sm font-medium text-foreground', children: LAYOUT_INFO[id].label }),
            jsx('span', { className: 'text-xs leading-snug text-(--ui-text-tertiary)', children: LAYOUT_INFO[id].blurb })
          ]
        },
        id
      )
    )
  })
}

function Shortcuts({ ctx }) {
  if (KeybindEditor) {
    return jsx('div', {
      className: 'flex flex-col',
      children: ACTIONS.map(([id, label]) => jsx(KeybindEditor, { actionId: `${ID}.${id}`, label }, id))
    })
  }
  return jsxs('div', {
    className: 'flex items-center justify-between gap-3 px-2.5 py-1 text-sm text-(--ui-text-tertiary)',
    children: [
      'Every Tiled Sessions shortcut is rebindable in Keybinds (search “Tiles”).',
      jsx('button', {
        type: 'button',
        className: 'shrink-0 rounded-md border border-(--ui-stroke-secondary) px-2.5 py-1 text-foreground hover:bg-(--chrome-action-hover)',
        onClick: () => ctx.runAction?.('keybinds.openPanel'),
        children: 'Open Keybinds'
      })
    ]
  })
}

function makeSettings(ctl, ctx) {
  return function TiledSessionsSettings() {
    const s = useValue(ctl.$settings)
    const arrange = canArrange()
    return jsxs('div', {
      className: 'flex flex-col',
      children: [
        hasTiling()
          ? null
          : jsx('p', { className: 'pb-3 text-sm text-(--ui-text-tertiary)', children: `Tiling needs ${NEEDS}. These settings apply once it is available.` }),
        jsx(SettingsHeading, { children: 'Layout' }),
        jsx(LayoutCards, { ctl, value: s.layout }),
        s.layout === 'master'
          ? jsx(ListRow, {
              title: 'Master size',
              description: 'Width of the master tile.',
              action: jsx(SegmentedControl, {
                options: ['0.5', '0.55', '0.6', '0.66'].map(n => ({ id: n, label: `${Math.round(Number(n) * 100)}%` })),
                value: String(s.master_ratio),
                onChange: v => {
                  ctl.setSettings({ master_ratio: Number(v) })
                  ctl.setLayout('master')
                }
              })
            })
          : null,
        jsx(ToggleRow, {
          label: 'Auto-tile',
          description: arrange
            ? 'Re-tile whenever a tile opens or closes. Off: new tiles split a tile and stay where you put them.'
            : `Needs ${NEEDS} with arrangeSessions.`,
          checked: s.auto_tile && arrange,
          onChange: on => {
            ctl.setSettings({ auto_tile: on })
            if (on) ctl.equalizeAll()
          }
        }),
        !s.auto_tile || !arrange
          ? jsx(ListRow, {
              title: 'Split target',
              description: 'Largest splits the biggest tile. Focused splits the focused tile.',
              action: jsx(SegmentedControl, {
                options: [
                  { id: 'largest', label: 'Largest' },
                  { id: 'focused', label: 'Focused' }
                ],
                value: s.split_target,
                onChange: v => ctl.setSettings({ split_target: v })
              })
            })
          : null,
        jsx(SettingsHeading, { children: 'Opening sessions' }),
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
        jsx(SettingsHeading, { children: 'Shortcuts' }),
        jsx(Shortcuts, { ctx })
      ]
    })
  }
}

function makeStatusChip(ctl) {
  return function TiledSessionsChip() {
    const s = useValue(ctl.$settings)
    const l = useValue(host.state.sessionLayout)
    const n = chatZones(l?.root ?? null).length
    if (n < 2) return null
    return jsxs('button', {
      type: 'button',
      title: 'Tile layout: click for the next one',
      className: 'flex h-full items-center gap-1.5 px-1.5 text-(--ui-text-tertiary) hover:text-foreground',
      onClick: () => ctl.cycleLayout(),
      children: [jsx(LayoutGlyph, { layout: s.layout, active: false, w: 16, h: 11 }), `${LAYOUT_INFO[s.layout].label} · ${n}`]
    })
  }
}

export default {
  id: ID,
  name: 'Tiled Sessions',
  register(ctx) {
    const ctl = createController(ctx)

    ctx.onDispose(host.state.focusedStoredSessionId.listen(id => ctl.noteFocus(id)))
    if (canArrange()) {
      ctl.onLayout()
      // Re-tile after core finishes its own write (a microtask later), never inside it.
      ctx.onDispose(host.state.sessionLayout.listen(() => queueMicrotask(() => ctl.onLayout())))
    }
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

    if (canArrange()) ctx.register({ id: 'status', area: 'statusBar.right', order: 40, render: makeStatusChip(ctl) })

    ctx.registerSettingsPage({ id: 'settings', title: 'Tiled Sessions', icon: 'layout', render: makeSettings(ctl, ctx) })

    for (const [id, label, defaults, run] of ACTIONS) {
      const data = { id: `${ID}.${id}`, label: `Tiles: ${label}`, category: 'view', defaults, run: () => run(ctl) }
      ctx.register({ id: `key:${id}`, area: KEYBINDS_AREA, data })
      ctx.register({ id: `cmd:${id}`, area: PALETTE_AREA, data: { ...data, action: data.id } })
    }
  }
}
