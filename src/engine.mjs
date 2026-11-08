// tiled-sessions layout engine. Pure functions, no imports, no DOM.
// scripts/build.mjs inlines this file into desktop/plugin.js between the
// ENGINE markers, so keep it free of imports and top-level side effects.

/** @typedef {{ type: 'leaf', id: string }} Leaf */
/** @typedef {{ type: 'split', dir: 'row' | 'column', ratio: number, a: Node, b: Node }} Split */
/** @typedef {Leaf | Split} Node */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

const EPS = 0.5

export const leaf = id => ({ type: 'leaf', id })

export const split = (dir, a, b, ratio = 0.5) => ({ type: 'split', dir, ratio, a, b })

/** Leaf ids in tile order: left-to-right, top-to-bottom (tree order). */
export function leaves(node) {
  if (!node) return []
  return node.type === 'leaf' ? [node.id] : [...leaves(node.a), ...leaves(node.b)]
}

/** Pixel rect of every leaf when `node` fills `rect`. */
export function rects(node, rect, out = new Map()) {
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
export const splitPos = rect => (rect.w >= rect.h ? 'right' : 'bottom')

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
export function pickTarget(node, rect, { mode = 'largest', history = [], focused = null, isCandidate = () => true } = {}) {
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
export function insert(node, rect, newId, opts = {}) {
  if (!node) return { tree: leaf(newId), target: null, pos: null }
  const target = pickTarget(node, rect, opts)
  if (!target) return { tree: node, target: null, pos: null }
  const pos = splitPos(rects(node, rect).get(target))
  const dir = pos === 'right' ? 'row' : 'column'
  return { tree: replaceLeaf(node, target, split(dir, leaf(target), leaf(newId))), target, pos }
}

/** Remove a leaf; its parent split collapses so the sibling takes the space. */
export function remove(node, id) {
  if (!node) return null
  if (node.type === 'leaf') return node.id === id ? null : node
  const a = remove(node.a, id)
  const b = remove(node.b, id)
  if (!a) return b
  if (!b) return a
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/** Parent split of a leaf, or null for the root leaf / missing id. */
export function parentSplit(node, id) {
  if (!node || node.type === 'leaf') return null
  if ((node.a.type === 'leaf' && node.a.id === id) || (node.b.type === 'leaf' && node.b.id === id)) return node
  return parentSplit(node.a, id) ?? parentSplit(node.b, id)
}

/** Flip row↔column on the split that directly holds `id`. */
export function toggleSplit(node, id) {
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
export function equalize(node) {
  if (!node || node.type === 'leaf') return node
  return { ...node, ratio: 0.5, a: equalize(node.a), b: equalize(node.b) }
}

/** Exchange two leaves' positions. */
export function swap(node, p, q) {
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
export function neighbor(node, rect, from, dir, { history = [], isCandidate = () => true } = {}) {
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
export function fromCore(node, keep = () => true) {
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
export const isSessionPane = id => id === 'workspace' || id.startsWith('session-tile:')

/** Stored session id a pane shows (main needs the projection's mainStoredSessionId). */
export function storedIdOfPane(paneId, mainStoredSessionId) {
  if (paneId === 'workspace') return mainStoredSessionId || null
  return paneId.startsWith('session-tile:') ? paneId.slice('session-tile:'.length) : null
}

/** Ordered open sessions (tile order, then stacked tabs) from a core projection. */
export function openSessions(coreRoot, mainStoredSessionId) {
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
export function coreParentSplit(node, paneId) {
  if (!node || node.type === 'group') return null
  for (const child of node.children) {
    if (child.type === 'group' && child.panes.includes(paneId)) return node
    const deeper = coreParentSplit(child, paneId)
    if (deeper) return deeper
  }
  return null
}

/** Every core split as [id, childCount]. */
export function coreSplits(node, out = []) {
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
export function equalizePlan(node, isChat, out = []) {
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
export function touch(history, id, cap = 32) {
  return [id, ...history.filter(h => h !== id)].slice(0, cap)
}

/** Live + stored session rows → one list, newest first, no duplicates, no empty drafts. */
export function mergeSessionRows(live = [], stored = []) {
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

export const LAYOUTS = ['grid', 'master', 'dwindle', 'columns']

/** Every chat zone in the core tree, in tree order: { groupId, pane } where
 *  `pane` is the zone's active pane. A zone counts when all its panes are chats. */
export function chatZones(coreRoot, isChat = isSessionPane) {
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
export function reconcileOrder(order, zoneIds, after = null) {
  const open = new Set(zoneIds)
  const kept = order.filter(id => open.has(id))
  const fresh = zoneIds.filter(id => !kept.includes(id))
  if (!fresh.length) return kept
  const at = after ? kept.indexOf(after) : -1
  return at === -1 ? [...kept, ...fresh] : [...kept.slice(0, at + 1), ...fresh, ...kept.slice(at + 1)]
}

/** Rows × columns for `n` equal tiles in `area`: tiles as close to square as
 *  possible, few empty cells (the last row's tiles widen to fill). */
export function gridDims(n, area) {
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
export function arrangement(layout, panes, area, { masterRatio = 0.55, flip = false } = {}) {
  // Flipped: the normal layout with every split turned, so columns become
  // rows, master-left becomes master-top, a 2×3 grid 3×2 (Hyprland's
  // togglesplit, applied to the whole layout).
  if (flip) return transpose(arrangement(layout, panes, area, { masterRatio }))
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

/** `spec` with every split's orientation turned (row ↔ column); weights kept. */
export function transpose(spec) {
  if (!spec || !spec.children) return spec
  return { ...spec, orientation: spec.orientation === 'row' ? 'column' : 'row', children: spec.children.map(transpose) }
}

/** The user's enabled layouts in LAYOUTS order; never empty (all on when
 *  nothing valid is stored). */
export function enabledLayouts(list) {
  const on = Array.isArray(list) ? LAYOUTS.filter(id => list.includes(id)) : []
  return on.length ? on : [...LAYOUTS]
}

/** Next enabled layout after `current` in LAYOUTS order. `current` itself
 *  need not be enabled (it was just switched off, or picked from the palette). */
export function nextLayout(current, enabled = LAYOUTS) {
  const on = enabledLayouts(enabled)
  const at = LAYOUTS.indexOf(current)
  for (let i = 1; i <= LAYOUTS.length; i++) {
    const id = LAYOUTS[(at + i + LAYOUTS.length) % LAYOUTS.length]
    if (on.includes(id)) return id
  }
  return on[0]
}

/** Switch one layout on or off. The last enabled layout stays on. */
export function setLayoutEnabled(enabled, id, on) {
  const now = enabledLayouts(enabled)
  if (!LAYOUTS.includes(id)) return now
  if (on) return enabledLayouts([...now, id])
  return now.length > 1 ? now.filter(l => l !== id) : now
}

/** The layout to show once `enabled` changes: `current` when still enabled,
 *  else the next enabled one. */
export const keepEnabled = (current, enabled) => (enabledLayouts(enabled).includes(current) ? current : nextLayout(current, enabled))

/** Move `id` to the front (master). */
export const promote = (order, id) => (order.includes(id) ? [id, ...order.filter(o => o !== id)] : order)

/** Exchange two ids in `order`. */
export function swapOrder(order, p, q) {
  const i = order.indexOf(p)
  const j = order.indexOf(q)
  if (i === -1 || j === -1) return order
  const next = [...order]
  next[i] = q
  next[j] = p
  return next
}

/** Move `id` next to `target` in `order`: before it, or after it with `after`. */
export function moveNextTo(order, id, target, after = false) {
  if (id === target || !order.includes(id) || !order.includes(target)) return order
  const rest = order.filter(o => o !== id)
  const at = rest.indexOf(target) + (after ? 1 : 0)
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** `items` sorted by where `keyOf(item)` sits in `order`; unknown keys keep
 *  their relative order at the end. Stable. */
export function sortByOrder(items, order, keyOf) {
  const rank = item => {
    const at = order.indexOf(keyOf(item))
    return at === -1 ? Number.MAX_SAFE_INTEGER : at
  }
  return items.map((item, i) => [item, i]).sort((p, q) => rank(p[0]) - rank(q[0]) || p[1] - q[1]).map(([item]) => item)
}

/**
 * Fullscreen: `focused` fills the chat area and every other tile folds into a
 * thin strip along the bottom (`peek` px per strip row, as many tiles per row
 * as fit at `minTileW`). Core can't minimize a zone for a plugin, and a tile
 * may not leave the arrangement, so the strip keeps them all on screen.
 */
export function fullscreenArrangement(panes, focused, area, { minTileW = 320, peek = 36 } = {}) {
  if (!panes.includes(focused)) return null
  const others = panes.filter(p => p !== focused).map(leafOf)
  if (!others.length) return leafOf(focused)
  const cols = Math.max(1, Math.min(others.length, Math.floor(area.w / minTileW)))
  const lines = []
  for (let i = 0; i < others.length; i += cols) lines.push(row(others.slice(i, i + cols)))
  const strip = Math.min(area.h * 0.4, peek * lines.length)
  return { orientation: 'column', weights: [area.h - strip, strip], children: [leafOf(focused), column(lines)] }
}

/**
 * Master share of the chat area as the user left it (sash drag), read from
 * core's weights: the split that directly holds the master zone, master's
 * weight over every chat-holding child of that split. Null when the tree
 * isn't master-shaped (one tile, or master stacked inside another zone).
 */
export function masterRatioFromCore(coreRoot, masterGroupId, isChat = isSessionPane) {
  const find = n => {
    if (!n || n.type === 'group') return null
    if (n.children.some(c => c.type === 'group' && c.id === masterGroupId)) return n
    for (const c of n.children) {
      const hit = find(c)
      if (hit) return hit
    }
    return null
  }
  const parent = find(coreRoot)
  if (!parent) return null
  let master = 0
  let chat = 0
  parent.children.forEach((c, i) => {
    if (!holdsChat(c, isChat)) return
    chat += parent.weights[i] ?? 0
    if (c.type === 'group' && c.id === masterGroupId) master = parent.weights[i] ?? 0
  })
  if (!(chat > 0) || master === chat) return null
  return master / chat
}

/** Ratio kept within the range the master layout honours, to 2 decimals. */
export const clampRatio = r => Math.round(Math.min(0.85, Math.max(0.15, r)) * 100) / 100

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Every whitespace-separated term of `query` appears (case-insensitive) in
 *  the row's title or preview. An empty query matches everything. */
export function matchesQuery(row, query) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const hay = `${row?.title ?? ''} ${row?.preview ?? ''}`.toLowerCase()
  return terms.every(t => hay.includes(t))
}

// ---------------------------------------------------------------------------
// Saved workspaces
// ---------------------------------------------------------------------------

/** A workspace: name, layout and the stored session ids in tile order. */
export function makeWorkspace(name, layout, sessionIds, now = Date.now()) {
  const sessions = [...new Set(sessionIds.filter(Boolean))]
  return { id: `ws-${now.toString(36)}`, name: String(name).trim() || 'Workspace', layout: LAYOUTS.includes(layout) ? layout : LAYOUTS[0], sessions }
}

/** Parse stored workspaces, dropping anything malformed. */
export function readWorkspaces(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(w => w && typeof w.id === 'string' && typeof w.name === 'string' && Array.isArray(w.sessions))
    .map(w => ({ id: w.id, name: w.name, layout: LAYOUTS.includes(w.layout) ? w.layout : LAYOUTS[0], sessions: w.sessions.filter(s => typeof s === 'string') }))
}

/** `base`, or `base 2`, `base 3`… so it doesn't clash with `names`. */
export function uniqueName(base, names) {
  const taken = new Set(names.map(n => n.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`
}

/**
 * What restoring a workspace has to do, given what's on screen now.
 *  wanted     the workspace's sessions that still exist, capped at maxTiles
 *  close      tile panes showing something the workspace doesn't hold
 *  inPlace    a session to load into main when main shows something else
 *             (main can't close; it is reused instead)
 *  openTiles  sessions to open as new tiles, in order
 * `open` is openSessions() output; `exists` filters deleted sessions.
 */
export function planRestore({ sessions, open, mainStoredSessionId = null, exists = () => true, maxTiles = Infinity }) {
  const wanted = sessions.filter(exists).slice(0, Math.max(1, maxTiles))
  const want = new Set(wanted)
  const close = open.filter(o => o.paneId !== 'workspace' && !want.has(o.storedSessionId)).map(o => o.paneId)
  const onScreen = new Set(open.filter(o => o.paneId === 'workspace' || want.has(o.storedSessionId)).map(o => o.storedSessionId))
  let inPlace = null
  if (!mainStoredSessionId || !want.has(mainStoredSessionId)) {
    inPlace = wanted.find(id => !onScreen.has(id)) ?? null
    // Nothing new to load into main: close it like its tab's ✕ (core
    // promotes a neighbour tile), so only the workspace stays open.
    if (!inPlace && mainStoredSessionId && wanted.length) close.push('workspace')
  }
  const openTiles = wanted.filter(id => id !== inPlace && !onScreen.has(id))
  return { wanted, close, inPlace, openTiles }
}

// ---------------------------------------------------------------------------
// Keybind display
// ---------------------------------------------------------------------------

/** The user's live combos for `actionId`: their stored override (core keeps
 *  only the diff from defaults; [] = unbound), else the shipped defaults. */
export function liveCombos(overrides, actionId, defaults = []) {
  const own = overrides && Object.prototype.hasOwnProperty.call(overrides, actionId) ? overrides[actionId] : null
  return Array.isArray(own) ? own.filter(c => typeof c === 'string') : defaults
}

const KEY_LABELS = { left: '←', right: '→', up: '↑', down: '↓', enter: '↵', space: 'Space', escape: 'Esc', backspace: '⌫', tab: '⇥' }
const MOD_LABELS = { mac: { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }, other: { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' } }

/** One key-cap label per token: `ctrl+alt+left` → ['Ctrl', 'Alt', '←']. */
export function comboKeys(combo, mac = false) {
  const parts = String(combo).split('+')
  const base = parts.pop() ?? ''
  const mods = MOD_LABELS[mac ? 'mac' : 'other']
  const label = KEY_LABELS[base] ?? (/^f\d{1,2}$/.test(base) || base.length === 1 ? base.toUpperCase() : base)
  return [...parts.map(m => mods[m] ?? m), label]
}

/** Four directional combos that differ only in their arrow collapse to one
 *  row of caps: ['Ctrl', 'Alt', '←↑↓→']. Null when they don't line up. */
export function arrowKeys(combos, mac = false) {
  const keys = combos.map(c => (c ? comboKeys(c, mac) : null))
  if (keys.some(k => !k)) return null
  const mods = keys.map(k => k.slice(0, -1).join('+'))
  if (new Set(mods).size !== 1) return null
  return [...keys[0].slice(0, -1), keys.map(k => k[k.length - 1]).join('')]
}

/** Leaf rects of an arrangement spec (equal weights unless given). */
export function specRects(spec, rect, out = new Map()) {
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
export function groupIdOfPane(coreRoot, paneId) {
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
export function rowDetails(session) {
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
