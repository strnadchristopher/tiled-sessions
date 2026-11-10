// Tiled Sessions: Hyprland-style tiling for Hermes Desktop sessions.
//
// GENERATED: desktop/plugin.js is this file with src/engine.mjs inlined at the
// ENGINE marker by scripts/build.mjs. Edit src/, then `npm run build`.
// SDK-only: imports @hermes/plugin-sdk and react/jsx-runtime, nothing else.
// Newer SDK exports (KeybindEditor, SearchField, ContextMenu, Switch, Kbd,
// Dialog) are read off the namespace so the plugin still loads, with
// fallbacks, on a Desktop that predates them.

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
import { useEffect, useRef, useState } from 'react'
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
function arrangement(layout, panes, area, { masterRatio = 0.55, flip = false } = {}) {
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
function transpose(spec) {
  if (!spec || !spec.children) return spec
  return { ...spec, orientation: spec.orientation === 'row' ? 'column' : 'row', children: spec.children.map(transpose) }
}

/** The user's enabled layouts in LAYOUTS order; never empty (all on when
 *  nothing valid is stored). */
function enabledLayouts(list) {
  const on = Array.isArray(list) ? LAYOUTS.filter(id => list.includes(id)) : []
  return on.length ? on : [...LAYOUTS]
}

/** Next enabled layout after `current` in LAYOUTS order. `current` itself
 *  need not be enabled (it was just switched off, or picked from the palette). */
function nextLayout(current, enabled = LAYOUTS) {
  const on = enabledLayouts(enabled)
  const at = LAYOUTS.indexOf(current)
  for (let i = 1; i <= LAYOUTS.length; i++) {
    const id = LAYOUTS[(at + i + LAYOUTS.length) % LAYOUTS.length]
    if (on.includes(id)) return id
  }
  return on[0]
}

/** Switch one layout on or off. The last enabled layout stays on. */
function setLayoutEnabled(enabled, id, on) {
  const now = enabledLayouts(enabled)
  if (!LAYOUTS.includes(id)) return now
  if (on) return enabledLayouts([...now, id])
  return now.length > 1 ? now.filter(l => l !== id) : now
}

/** The layout to show once `enabled` changes: `current` when still enabled,
 *  else the next enabled one. */
const keepEnabled = (current, enabled) => (enabledLayouts(enabled).includes(current) ? current : nextLayout(current, enabled))

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

/** Move `id` next to `target` in `order`: before it, or after it with `after`. */
function moveNextTo(order, id, target, after = false) {
  if (id === target || !order.includes(id) || !order.includes(target)) return order
  const rest = order.filter(o => o !== id)
  const at = rest.indexOf(target) + (after ? 1 : 0)
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** `items` sorted by where `keyOf(item)` sits in `order`; unknown keys keep
 *  their relative order at the end. Stable. */
function sortByOrder(items, order, keyOf) {
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
function fullscreenArrangement(panes, focused, area, { minTileW = 320, peek = 36 } = {}) {
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
function masterRatioFromCore(coreRoot, masterGroupId, isChat = isSessionPane) {
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
const clampRatio = r => Math.round(Math.min(0.85, Math.max(0.15, r)) * 100) / 100

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Every whitespace-separated term of `query` appears (case-insensitive) in
 *  the row's title or preview. An empty query matches everything. */
function matchesQuery(row, query) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const hay = `${row?.title ?? ''} ${row?.preview ?? ''}`.toLowerCase()
  return terms.every(t => hay.includes(t))
}

// ---------------------------------------------------------------------------
// Source sections — mirrors core's sidebar (lib/session-source.ts): local
// sessions form "Sessions", each messaging platform gets its own section
// (newest platform first), cron runs sit in their own section.
// ---------------------------------------------------------------------------

const MESSAGING_SOURCES = [
  'telegram', 'discord', 'slack', 'mattermost', 'matrix', 'signal', 'whatsapp', 'bluebubbles', 'photon',
  'homeassistant', 'email', 'sms', 'webhook', 'api_server', 'weixin', 'wecom', 'qqbot', 'yuanbao', 'dingtalk', 'feishu'
]
const MESSAGING_SET = new Set(MESSAGING_SOURCES)

const SOURCE_LABELS = {
  api_server: 'API', bluebubbles: 'iMessage', dingtalk: 'DingTalk', discord: 'Discord', email: 'Email',
  feishu: 'Feishu', homeassistant: 'Home Assistant', matrix: 'Matrix', mattermost: 'Mattermost', photon: 'Photon',
  qqbot: 'QQ', signal: 'Signal', slack: 'Slack', sms: 'SMS', telegram: 'Telegram', webhook: 'Webhook',
  wecom: 'WeCom', weixin: 'WeChat', whatsapp: 'WhatsApp', yuanbao: 'Yuanbao'
}

const sourceOf = row => String(row?.source ?? '').trim().toLowerCase()
const sourceLabel = id => SOURCE_LABELS[id] ?? id

/** { sessions, platforms: [{ id, label, rows }], cron } — input order kept within each. */
function groupBySource(rows = []) {
  const sessions = []
  const cron = []
  const byPlatform = new Map()
  for (const r of rows) {
    const src = sourceOf(r)
    if (src === 'cron') cron.push(r)
    else if (MESSAGING_SET.has(src)) {
      if (!byPlatform.has(src)) byPlatform.set(src, [])
      byPlatform.get(src).push(r)
    } else sessions.push(r)
  }
  const newest = list => Math.max(...list.map(r => r.last_active ?? r.updated_at ?? r.started_at ?? 0))
  const platforms = [...byPlatform.entries()]
    .map(([id, list]) => ({ id, label: sourceLabel(id), rows: list }))
    .sort((a, b) => newest(b.rows) - newest(a.rows))
  return { sessions, platforms, cron }
}

// ---------------------------------------------------------------------------
// Saved workspaces
// ---------------------------------------------------------------------------

/** A workspace: name, layout and the stored session ids in tile order. */
function makeWorkspace(name, layout, sessionIds, now = Date.now()) {
  const sessions = [...new Set(sessionIds.filter(Boolean))]
  return { id: `ws-${now.toString(36)}`, name: String(name).trim() || 'Workspace', layout: LAYOUTS.includes(layout) ? layout : LAYOUTS[0], sessions }
}

/** Parse stored workspaces, dropping anything malformed. */
function readWorkspaces(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(w => w && typeof w.id === 'string' && typeof w.name === 'string' && Array.isArray(w.sessions))
    .map(w => ({ id: w.id, name: w.name, layout: LAYOUTS.includes(w.layout) ? w.layout : LAYOUTS[0], sessions: w.sessions.filter(s => typeof s === 'string') }))
}

/** `base`, or `base 2`, `base 3`… so it doesn't clash with `names`. */
function uniqueName(base, names) {
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
function planRestore({ sessions, open, mainStoredSessionId = null, exists = () => true, maxTiles = Infinity }) {
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
function liveCombos(overrides, actionId, defaults = []) {
  const own = overrides && Object.prototype.hasOwnProperty.call(overrides, actionId) ? overrides[actionId] : null
  return Array.isArray(own) ? own.filter(c => typeof c === 'string') : defaults
}

const KEY_LABELS = { left: '←', right: '→', up: '↑', down: '↓', enter: '↵', space: 'Space', escape: 'Esc', backspace: '⌫', tab: '⇥' }
const MOD_LABELS = { mac: { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }, other: { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' } }

/** One key-cap label per token: `ctrl+alt+left` → ['Ctrl', 'Alt', '←']. */
function comboKeys(combo, mac = false) {
  const parts = String(combo).split('+')
  const base = parts.pop() ?? ''
  const mods = MOD_LABELS[mac ? 'mac' : 'other']
  const label = KEY_LABELS[base] ?? (/^f\d{1,2}$/.test(base) || base.length === 1 ? base.toUpperCase() : base)
  return [...parts.map(m => mods[m] ?? m), label]
}

/** Four directional combos that differ only in their arrow collapse to one
 *  row of caps: ['Ctrl', 'Alt', '←↑↓→']. Null when they don't line up. */
function arrowKeys(combos, mac = false) {
  const keys = combos.map(c => (c ? comboKeys(c, mac) : null))
  if (keys.some(k => !k)) return null
  const mods = keys.map(k => k.slice(0, -1).join('+'))
  if (new Set(mods).size !== 1) return null
  return [...keys[0].slice(0, -1), keys.map(k => k[k.length - 1]).join('')]
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
const PANE_ID = `${ID}:pane`
const NEEDS = 'a Hermes Desktop with the session-layout SDK (host.state.sessionLayout)'
const MASTER_PRESETS = [0.5, 0.55, 0.6, 0.66]
const DEFAULTS = {
  layout: 'grid',
  layouts_enabled: [...LAYOUTS],
  master_ratio: 0.55,
  master_preset: 0.55,
  auto_tile: true,
  split_target: 'largest',
  max_tiles: 8,
  click: 'new-tile',
  plus_new_tile: true,
  replace_modifier: 'alt',
  hint_dismissed: false,
  flipped: false
}
const LAYOUT_INFO = {
  grid: { label: 'Grid', blurb: 'Every tile the same size.' },
  master: { label: 'Master', blurb: 'One big tile, the rest stacked beside it.' },
  dwindle: { label: 'Dwindle', blurb: 'Each new tile halves the last, like Hyprland.' },
  columns: { label: 'Columns', blurb: 'Side by side, equal widths.' }
}
const LIST_KEY = [ID, 'session.list']
const SIDEBAR_ESTIMATE = 280
// Core keeps the user's keybind overrides here (only the diff from defaults).
// No SDK reader exists for live bindings, so the shortcuts card reads it and
// falls back to our shipped defaults when it is absent or unreadable.

/** The upstream hook ships `dock`, `sessionLayout` and `host.layout` together. */
const hasTiling = () => Boolean(host.state?.sessionLayout && typeof host.layout?.closePane === 'function')
/** Layouts need `host.layout.arrangeSessions` (same upstream PR, later revision). */
/** Newer layout SDK: plugins may take over a chat strip's "+". */
const canRedirectPlus = () => hasTiling() && typeof host.layout?.redirectNewSessionTab === 'function'
const canArrange = () => hasTiling() && typeof host.layout?.arrangeSessions === 'function'
const canPin = () => typeof host.sessions?.pin === 'function'
/** Rename goes through the gateway's session.title RPC, which needs the
 *  session's live runtime id: SDK builds that expose the focused one. */
const canRenameAtAll = () => typeof host.request === 'function' && Boolean(host.state?.focusedSessionId)

const KeybindEditor = SDK.KeybindEditor
const SearchField = SDK.SearchField
const Switch = SDK.Switch
const Kbd = SDK.Kbd
const ContextMenu = SDK.ContextMenu
const ContextMenuTrigger = SDK.ContextMenuTrigger
const ContextMenuContent = SDK.ContextMenuContent
const ContextMenuItem = SDK.ContextMenuItem
const ContextMenuSeparator = SDK.ContextMenuSeparator
const Dialog = SDK.Dialog
const DialogContent = SDK.DialogContent
const DialogHeader = SDK.DialogHeader
const DialogTitle = SDK.DialogTitle
const hasContextMenu = Boolean(ContextMenu && ContextMenuTrigger && ContextMenuContent && ContextMenuItem)
const hasDialog = Boolean(Dialog && DialogContent && DialogHeader && DialogTitle)
const IS_MAC = typeof SDK.formatModifierToken === 'function' && SDK.formatModifierToken('alt') === '⌥'

const rowId = r => r.id
const rowKeys = r => [r.id, r._lineage_root_id].filter(Boolean)
const notifyError = (err, message) =>
  typeof host.notifyError === 'function' ? host.notifyError(err, message) : host.notify({ kind: 'error', message })

async function listRows() {
  // The gateway lists running sessions (default scope) and resumable history
  // (`scope: 'stored'`) separately; an open chat is only in the first.
  const [live, stored] = await Promise.all([
    host.request('session.list', { limit: 200 }).catch(() => ({ sessions: [] })),
    host.request('session.list', { limit: 200, scope: 'stored' }).catch(() => ({ sessions: [] }))
  ])
  return { sessions: mergeSessionRows(live?.sessions, stored?.sessions) }
}

function createController(ctx) {
  const stored = ctx.storage.get('settings', {}) || {}
  const enabled0 = enabledLayouts(stored.layouts_enabled)
  const $settings = atom({
    ...DEFAULTS,
    ...stored,
    layouts_enabled: enabled0,
    layout: LAYOUTS.includes(stored.layout) ? stored.layout : keepEnabled(DEFAULTS.layout, enabled0)
  })
  const $history = atom(ctx.storage.get('history', []) || [])
  const $order = atom(ctx.storage.get('order', []) || [])
  const $workspaces = atom(readWorkspaces(ctx.storage.get('workspaces', [])))
  // Group id of the zone shown fullscreen, or null.
  const $fullscreen = atom(ctx.storage.get('fullscreen', null) || null)
  // Source sections the user expanded (platforms + cron collapse by default, like core).
  const $openSections = atom(ctx.storage.get('open_sections', []) || [])
  const toggleSection = id => {
    const cur = $openSections.get()
    const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]
    $openSections.set(next)
    ctx.storage.set('open_sections', next)
  }
  // The workspace picker (palette / keybind) is open.
  const $picker = atom(false)
  // A workspace just saved by keybind, for the pane to open in rename. Panes mounted: tilesPanes.
  const $renameWs = atom(null)
  let tilesPanes = 0
  // Stock Hermes only: what this plugin opened this run (core layout is unreadable there).
  const $openedHere = atom([])
  let lastKey = null
  let insertAfter = null
  let warned = false
  let newTileAt = 0
  let lastZones = []
  let restoring = false
  let cancelRatioWrite = null

  const setSettings = patch => {
    const next = { ...$settings.get(), ...patch }
    $settings.set(next)
    ctx.storage.set('settings', next)
  }

  const setOrder = next => {
    $order.set(next)
    ctx.storage.set('order', next)
  }

  const setFullscreen = groupId => {
    $fullscreen.set(groupId)
    ctx.storage.set('fullscreen', groupId)
  }

  const setWorkspaces = next => {
    $workspaces.set(next)
    ctx.storage.set('workspaces', next)
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
   * Any re-tile ends fullscreen.
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
    lastZones = zones
    if ($fullscreen.get()) setFullscreen(null)
    if (zones.length < 2) return true
    const s = $settings.get()
    const paneOfGroup = new Map(zones.map(z => [z.groupId, z.pane]))
    const spec = arrangement(s.layout, order.map(g => paneOfGroup.get(g)), engineView().area, { masterRatio: s.master_ratio, flip: Boolean(s.flipped) })
    const ok = host.layout.arrangeSessions(spec)
    if (!ok && !warned) {
      warned = true
      host.notify({ kind: 'info', message: 'Tiled Sessions: a non-chat pane sits between your chats, so tiles were left as they are. Move it aside to re-tile.' })
    }
    return ok
  }

  /** Fill the chat area with zone `groupId`; the rest fold into a strip. */
  function arrangeFullscreen(groupId) {
    const zones = chatZones(layout()?.root ?? null)
    const zone = zones.find(z => z.groupId === groupId)
    if (!zone || zones.length < 2) return false
    const order = reconcileOrder($order.get(), zones.map(z => z.groupId))
    const paneOfGroup = new Map(zones.map(z => [z.groupId, z.pane]))
    const spec = fullscreenArrangement(order.map(g => paneOfGroup.get(g)), zone.pane, engineView().area)
    if (!spec || !host.layout.arrangeSessions(spec)) return false
    setFullscreen(groupId)
    return true
  }

  function toggleFullscreen() {
    if (!canArrange()) {
      host.notify({ kind: 'info', message: `Tiled Sessions: fullscreen needs ${NEEDS} with arrangeSessions.` })
      return
    }
    if ($fullscreen.get()) {
      retile({ force: true })
      return
    }
    const g = focusedGroup()
    if (g) arrangeFullscreen(g)
  }

  /** Master layout: keep the divider where the user dragged it. Debounced so
   *  a live sash drag writes settings once, after it settles. */
  function rememberMasterRatio() {
    const s = $settings.get()
    if (s.layout !== 'master' || !s.auto_tile || $fullscreen.get() || restoring) return
    cancelRatioWrite?.()
    cancelRatioWrite = ctx.setTimeout(() => {
      cancelRatioWrite = null
      const master = $order.get()[0]
      const r = master ? masterRatioFromCore(layout()?.root ?? null, master) : null
      if (r === null) return
      const next = clampRatio(r)
      if (Math.abs(next - $settings.get().master_ratio) >= 0.01) setSettings({ master_ratio: next })
    }, 300)
  }

  /** Called on every layout change: auto-tile when the set of tiles changed. */
  function onLayout() {
    if (!canArrange()) return
    const zones = chatZones(layout()?.root ?? null)
    const key = zoneKey(zones)
    if (lastKey === null) {
      // First sight after load: adopt what's on screen (keep the user's sizes).
      lastKey = key
      lastZones = zones
      setOrder(reconcileOrder($order.get(), zones.map(z => z.groupId)))
      if ($fullscreen.get() && !zones.some(z => z.groupId === $fullscreen.get())) setFullscreen(null)
      return
    }
    if (key === lastKey) {
      rememberMasterRatio()
      return
    }
    if (restoring) {
      lastKey = key
      lastZones = zones
      return
    }
    const added = zones.filter(z => !lastZones.some(o => o.groupId === z.groupId))
    lastZones = zones
    const closed = key.split(',').length < lastKey.split(',').length
    // A chat we just asked for (Ctrl+Alt+Enter) gets focus, as a WM does.
    if (added.length === 1 && Date.now() - newTileAt < 8000) {
      newTileAt = 0
      const id = storedIdOfPane(added[0].pane, layout().mainStoredSessionId)
      if (id) ctx.setTimeout(() => focusComposer(id), 80)
    }
    // Opening or closing a tile ends fullscreen and brings the layout back.
    if ($fullscreen.get()) retile({ force: true })
    else if ($settings.get().auto_tile) retile()
    else lastKey = key
    // A tile closed (ours, ⌘W, its ✕): core moves the highlight, but the caret
    // can stay on a different tile. Re-sync so typing and ⌘W follow the highlight.
    if (closed) {
      ctx.setTimeout(() => {
        const id = host.state.focusedStoredSessionId.get()
        if (id) focusComposer(id)
      }, 60)
    }
  }

  const noteFocus = storedId => {
    const paneId = paneOf(storedId)
    if (!paneId) return
    const next = touch($history.get(), paneId)
    $history.set(next)
    ctx.storage.set('history', next)
    // Fullscreen follows focus: clicking a tile in the strip brings it up.
    const fs = $fullscreen.get()
    const g = focusedGroup()
    if (fs && g && g !== fs && canArrange()) arrangeFullscreen(g)
  }

  /** Focus a session's composer with the caret after any draft. Core's focus
   *  lands at the start of a non-empty contenteditable; once it settles, move
   *  the caret to the end (unless the user has already selected a range). */
  function focusComposer(id) {
    host.composer?.focus?.(id)
    const toEnd = () => {
      const el = document.activeElement
      if (!(el instanceof HTMLElement) || el.dataset.slot !== 'composer-rich-input') return
      const sel = window.getSelection()
      if (!sel || !el.contains(sel.anchorNode) || !sel.isCollapsed) return
      const r = document.createRange()
      r.selectNodeContents(el)
      r.collapse(false)
      sel.removeAllRanges()
      sel.addRange(r)
    }
    for (const ms of [30, 120, 300]) ctx.setTimeout(toEnd, ms)
  }

  /** Focus an on-screen session the way a tiling WM does: front its tile AND
   *  move the keyboard into its composer, so typing, ⌘W and the readouts all
   *  agree on which tile is "the" tile. */
  async function focusTile(storedId) {
    await host.openSession(storedId, { intent: 'tab' })
    focusComposer(storedId)
  }

  async function open(storedId, { replace = false } = {}) {
    if (!storedId) return
    const s = $settings.get()
    if (replace || s.click === 'replace') {
      await host.openSession(storedId, { intent: 'in-place' })
      return
    }
    if (!hasTiling()) {
      // Stock Hermes: core focuses an open tile or stacks a tab, never a duplicate.
      await host.openSession(storedId, { intent: 'tab' })
      if (!$openedHere.get().some(o => o.storedSessionId === storedId)) {
        $openedHere.set([...$openedHere.get(), { paneId: null, storedSessionId: storedId, visible: true }])
      }
      return
    }
    const { l, tree, area } = engineView()
    const onScreen = openSessions(l.root, l.mainStoredSessionId)
    if (onScreen.some(o => o.storedSessionId === storedId)) {
      await focusTile(storedId) // already on screen → focus it
      return
    }
    if (!l.mainStoredSessionId) {
      await host.openSession(storedId, { intent: 'in-place' }) // blank main → spend it
      return
    }
    if (onScreen.length >= s.max_tiles) {
      host.notify({ kind: 'info', message: `Tiled Sessions: ${s.max_tiles} tiles are open, so it opened in place.` })
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

  /** Like a tiling WM, focus the new tile, once core has adopted it (async).
   *  Re-opening an on-screen session only focuses it, so this never stacks. */
  function focusOnceTiled(storedId, tries = 12) {
    if (paneOf(storedId)) {
      void focusTile(storedId)
      return
    }
    if (tries > 0) ctx.setTimeout(() => focusOnceTiled(storedId, tries - 1), 100)
  }

  /** Resolve once `test()` holds, or false after `ms`. */
  const waitFor = (test, ms = 3000, step = 80) =>
    new Promise(resolve => {
      const started = Date.now()
      const tick = () => {
        if (test()) resolve(true)
        else if (Date.now() - started > ms) resolve(false)
        else ctx.setTimeout(tick, step)
      }
      tick()
    })

  function newTile(anchor) {
    if (typeof host.layout?.newChatTile !== 'function') {
      host.notify({ kind: 'info', message: `Tiled Sessions: new chat tiles need ${NEEDS}.` })
      return
    }
    const pane = anchor ?? focusedPane() ?? 'workspace'
    insertAfter = groupIdOfPane(layout()?.root ?? null, pane) ?? focusedGroup()
    newTileAt = Date.now()
    host.layout.newChatTile({ pane, pos: 'right' })
  }

  /** The "+" after a chat zone's tabs (`host.layout.redirectNewSessionTab`):
   *  with plus_new_tile on, the new session opens as a tile beside that zone
   *  instead of stacking a tab. False lets core open its stock tab. */
  function onStripPlus(pane) {
    if (!$settings.get().plus_new_tile) return false
    newTile(pane)
    return true
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

  /** Drag-and-drop in the Open list: put `storedId`'s tile next to `targetId`'s. */
  function moveTile(storedId, targetId, after) {
    if (!canArrange()) return
    const root = layout()?.root ?? null
    const from = groupIdOfPane(root, paneOf(storedId))
    const to = groupIdOfPane(root, paneOf(targetId))
    if (!from || !to || from === to) return
    const order = reconcileOrder($order.get(), chatZones(root).map(z => z.groupId))
    setOrder(moveNextTo(order, from, to, after))
    retile({ force: true })
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

  /** Ctrl+Alt+/: turn the whole layout (rows ↔ columns), like Hyprland's togglesplit. */
  function toggleFlip() {
    const flipped = !$settings.get().flipped
    setSettings({ flipped })
    if (canArrange()) retile({ force: true })
    else host.notify({ kind: 'info', message: `Tiled Sessions: flipping needs ${NEEDS} with arrangeSessions.` })
  }

  const cycleLayout = () => {
    const s = $settings.get()
    setLayout(nextLayout(s.layout, s.layouts_enabled), { announce: true })
  }

  /** Offer a layout (or stop offering it) in the switcher, chip and cycle. */
  function setLayoutOffered(id, on) {
    const s = $settings.get()
    const next = setLayoutEnabled(s.layouts_enabled, id, on)
    setSettings({ layouts_enabled: next })
    const keep = keepEnabled(s.layout, next)
    if (keep !== s.layout) setLayout(keep)
  }

  /** Pick a master size preset; a dragged (custom) size is replaced by it. */
  function setMasterPreset(r) {
    setSettings({ master_ratio: r, master_preset: r })
    setLayout('master')
  }

  /** Ctrl+Alt+R: re-tile, and drop sizes dragged by hand, including a
   *  remembered master size (back to the last preset picked in Settings). */
  function equalizeAll() {
    if (!hasTiling()) return
    const s = $settings.get()
    if (s.master_ratio !== s.master_preset) setSettings({ master_ratio: s.master_preset })
    if (canArrange()) {
      retile({ force: true })
      return
    }
    for (const [splitId, weights] of equalizePlan(layout().root, isSessionPane)) host.layout.setSplitWeights(splitId, weights)
  }

  function openInPlace(storedId = host.state.focusedStoredSessionId.get()) {
    if (storedId) void host.openSession(storedId, { intent: 'main' })
  }

  function setPinned(storedId, pinned) {
    if (canPin()) host.sessions.pin(storedId, pinned)
  }

  /** Rename can only reach a session with a live runtime: one on screen. */
  const canRename = storedId => canRenameAtAll() && (hasTiling() ? Boolean(paneOf(storedId)) : host.state.focusedStoredSessionId.get() === storedId)

  /** Mirrors core's rename: the gateway's session.title RPC on the session's
   *  runtime id (the sidebar's path for live sessions). The runtime id the SDK
   *  exposes is the focused chat's, so focus the tile first when needed. */
  async function rename(storedId, title) {
    const next = String(title ?? '').trim()
    if (!next || !canRename(storedId)) return false
    const focusedRuntime = () => (host.state.focusedStoredSessionId.get() === storedId ? host.state.focusedSessionId.get() : null)
    if (!focusedRuntime()) {
      await focusTile(storedId)
      await waitFor(() => Boolean(focusedRuntime()), 2000)
    }
    const runtimeId = focusedRuntime()
    if (!runtimeId) {
      host.notify({ kind: 'error', message: 'Could not rename: the session is still starting.' })
      return false
    }
    try {
      await host.request('session.title', { session_id: runtimeId, title: next })
      void queryClient.invalidateQueries({ queryKey: LIST_KEY })
      return true
    } catch (err) {
      notifyError(err, 'Could not rename the session')
      return false
    }
  }

  // -- saved workspaces ------------------------------------------------------

  /** Stored ids of the open tiles in tile order. */
  function openInOrder() {
    const l = layout()
    if (!l) return []
    const open = openSessions(l.root, l.mainStoredSessionId)
    const order = $order.get()
    const visible = open.filter(o => o.visible)
    return sortByOrder(visible, order, o => groupIdOfPane(l.root, o.paneId)).map(o => o.storedSessionId)
  }

  /** Save what's on screen as a new workspace; returns it (null when empty). */
  function saveWorkspace(name) {
    const ids = openInOrder()
    if (!ids.length) {
      host.notify({ kind: 'info', message: 'Open a session first, then save it as a workspace.' })
      return null
    }
    const all = $workspaces.get()
    const ws = makeWorkspace(name || uniqueName('Workspace', all.map(w => w.name)), $settings.get().layout, ids)
    setWorkspaces([...all, ws])
    return ws
  }

  function updateWorkspace(id, patch) {
    setWorkspaces($workspaces.get().map(w => (w.id === id ? { ...w, ...patch } : w)))
  }

  /** Replace a workspace's tiles and layout with what's on screen now. */
  function overwriteWorkspace(id) {
    const ids = openInOrder()
    if (ids.length) updateWorkspace(id, { sessions: ids, layout: $settings.get().layout })
  }

  const deleteWorkspace = id => setWorkspaces($workspaces.get().filter(w => w.id !== id))

  async function knownSessionIds() {
    try {
      const data = await queryClient.fetchQuery({ queryKey: [...LIST_KEY, host.state.profile.get()], queryFn: listRows, staleTime: 30_000 })
      const ids = new Set()
      for (const r of data?.sessions ?? []) for (const k of rowKeys(r)) ids.add(k)
      return ids
    } catch {
      return null
    }
  }

  /** Open the workspace's sessions as tiles, in order, and apply its layout.
   *  Sessions that no longer exist are skipped quietly. */
  async function restoreWorkspace(id) {
    const ws = $workspaces.get().find(w => w.id === id)
    if (!ws || restoring) return
    if (!canArrange()) {
      host.notify({ kind: 'info', message: `Tiled Sessions: workspaces need ${NEEDS} with arrangeSessions.` })
      return
    }
    const known = await knownSessionIds()
    const l = layout()
    const plan = planRestore({
      sessions: ws.sessions,
      open: openSessions(l.root, l.mainStoredSessionId),
      mainStoredSessionId: l.mainStoredSessionId,
      exists: storedId => !known || known.has(storedId) || Boolean(paneOf(storedId)),
      maxTiles: $settings.get().max_tiles
    })
    if (!plan.wanted.length) {
      host.notify({ kind: 'info', message: `None of the sessions in ${ws.name} exist any more.` })
      return
    }
    restoring = true
    setFullscreen(null)
    try {
      setSettings({ layout: ws.layout })
      for (const pane of plan.close) host.layout.closePane(pane)
      if (plan.inPlace) await host.openSession(plan.inPlace, { intent: 'in-place' })
      for (const storedId of plan.openTiles) {
        const prev = plan.wanted[plan.wanted.indexOf(storedId) - 1]
        const anchor = (prev && paneOf(prev)) || focusedPane() || 'workspace'
        await host.openSession(storedId, { intent: 'tab', dock: { pane: anchor, pos: 'right' } })
        await waitFor(() => Boolean(paneOf(storedId)), 1500)
      }
      await waitFor(() => plan.wanted.every(s => paneOf(s)), 3000)
    } finally {
      restoring = false
    }
    const root = layout()?.root ?? null
    const groups = plan.wanted.map(s => groupIdOfPane(root, paneOf(s))).filter(Boolean)
    setOrder(reconcileOrder(groups, chatZones(root).map(z => z.groupId)))
    retile({ force: true })
    if (paneOf(plan.wanted[0])) void focusTile(plan.wanted[0])
  }

  function openPicker() {
    const all = $workspaces.get()
    if (!all.length) {
      host.notify({ kind: 'info', message: 'No saved workspaces yet. Save one from the Open list in the Tiles pane.' })
      return
    }
    if (all.length === 1 || !hasDialog) {
      void restoreWorkspace(all[all.length - 1].id)
      return
    }
    $picker.set(true)
  }

  function showShortcuts() {
    setSettings({ hint_dismissed: false })
    host.revealPane?.(PANE_ID)
  }

  return {
    onStripPlus,
    retileAll: () => retile({ force: true }),
    $settings,
    $openedHere,
    $order,
    $workspaces,
    $fullscreen,
    $openSections,
    toggleSection,
    $picker,
    $renameWs,
    paneMounted: () => {
      tilesPanes += 1
      return () => void (tilesPanes -= 1)
    },
    hasPane: () => tilesPanes > 0,
    setSettings,
    setLayout,
    setLayoutOffered,
    setMasterPreset,
    noteFocus,
    onLayout,
    open,
    newTile,
    close,
    focusDir,
    swapDir,
    moveTile,
    promoteFocused,
    cycleLayout,
    toggleFlip,
    equalizeAll,
    toggleFullscreen,
    openInPlace,
    setPinned,
    canRename,
    rename,
    paneOf,
    saveWorkspace,
    updateWorkspace,
    overwriteWorkspace,
    deleteWorkspace,
    restoreWorkspace,
    openPicker,
    showShortcuts
  }
}

function useSessionRows() {
  const profile = useValue(host.state.profile)
  return useQuery({ queryKey: [...LIST_KEY, profile], queryFn: listRows, staleTime: 30_000 })
}

// Session-list density (Settings → Appearance), read-only from core when the
// SDK exposes it; older Desktops get the one-line compact row.
const COMPACT = atom('compact')
const densityAtom = () => host.state?.sessionListDensity ?? COMPACT
const ROW_HEIGHT = { compact: 'h-7', comfortable: 'min-h-[2.75rem] py-1', detailed: 'min-h-[3.875rem] py-1' }
const ACCENT_WASH = { background: 'color-mix(in srgb, var(--ui-accent) 14%, transparent)' }

/** In-place title editor: Enter or blur saves, Escape cancels. */
function InlineName({ value, onDone, label }) {
  const [text, setText] = useState(value)
  const ref = useRef(null)
  const done = useRef(false)
  useEffect(() => {
    // After the context menu has closed and handed focus back.
    const t = setTimeout(() => {
      ref.current?.focus()
      ref.current?.select()
    }, 0)
    return () => clearTimeout(t)
  }, [])
  const finish = save => {
    if (done.current) return
    done.current = true
    onDone(save ? text.trim() : null)
  }
  return jsx('input', {
    ref,
    value: text,
    'aria-label': label,
    spellCheck: false,
    className:
      'block h-6 w-full min-w-0 rounded-[0.3rem] bg-(--ui-bg-elevated) px-1.5 text-[0.8125rem] text-foreground outline-none ring-1 ring-(--ui-accent)',
    onChange: e => setText(e.target.value),
    onClick: e => e.stopPropagation(),
    onKeyDown: e => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    },
    onBlur: () => finish(true)
  })
}

/** Right-click menu for a row: `items` are [icon, label, run] or 'sep'.
 *  Leading/trailing/double separators are dropped. Renders the row alone on
 *  Desktops without the SDK's ContextMenu. */
function WithMenu({ items, label, onCloseAutoFocus, children }) {
  const clean = items.filter(Boolean).filter((it, i, all) => it !== 'sep' || (i > 0 && i < all.length - 1 && all[i - 1] !== 'sep'))
  if (!hasContextMenu || !clean.some(it => it !== 'sep')) return children
  return jsxs(ContextMenu, {
    children: [
      jsx(ContextMenuTrigger, { asChild: true, children }),
      jsx(ContextMenuContent, {
        'aria-label': label,
        className: 'w-44',
        onCloseAutoFocus,
        children: clean.map((it, i) =>
          it === 'sep'
            ? ContextMenuSeparator
              ? jsx(ContextMenuSeparator, {}, `sep${i}`)
              : null
            : jsxs(
                ContextMenuItem,
                {
                  variant: it[3] ? 'destructive' : undefined,
                  onSelect: it[2],
                  children: [jsx(Codicon, { name: it[0], className: 'text-[0.875rem]' }), it[1]]
                },
                it[1]
              )
        )
      })
    ]
  })
}

function Row({ ctl, storedId, title, session, focused, dim, pinned, tile, onOpen, onClose, drag }) {
  const density = useValue(densityAtom())
  const [renaming, setRenaming] = useState(false)
  const keepFocus = useRef(false)
  const details = density === 'compact' ? null : rowDetails(session)
  const renameable = ctl.canRename(storedId)
  const startRename = () => {
    keepFocus.current = true
    setRenaming(true)
  }
  const items = [
    canPin() ? [pinned ? 'pinned' : 'pin', pinned ? 'Unpin' : 'Pin', () => ctl.setPinned(storedId, !pinned)] : null,
    renameable ? ['edit', 'Rename', startRename] : null,
    'sep',
    tile && hasTiling() && tile !== 'workspace' ? ['window', 'Move to main', () => ctl.openInPlace(storedId)] : null,
    onClose || tile ? ['close', 'Close tile', () => (onClose ?? ctl.close)(storedId)] : null
  ]
  const row = jsxs('div', {
    className: cn(
      'group relative flex cursor-pointer items-center gap-2 rounded-md pl-2.5 pr-1 text-[0.8125rem] transition-[background-color,color,opacity]',
      ROW_HEIGHT[density] ?? ROW_HEIGHT.compact,
      focused ? 'text-foreground' : 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground',
      dim && !focused && 'opacity-60',
      drag?.dragging && 'opacity-40'
    ),
    role: 'button',
    tabIndex: 0,
    'aria-current': focused ? 'true' : undefined,
    style: focused ? ACCENT_WASH : undefined,
    title: renaming ? undefined : title,
    draggable: Boolean(drag) && !renaming,
    onDragStart: drag?.onDragStart,
    onDragOver: drag?.onDragOver,
    onDragLeave: drag?.onDragLeave,
    onDrop: drag?.onDrop,
    onDragEnd: drag?.onDragEnd,
    onClick: e => {
      if (!renaming) onOpen(storedId, e)
    },
    onKeyDown: e => {
      if (renaming) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onOpen(storedId, e)
      } else if (e.key === 'F2' && renameable) {
        e.preventDefault()
        startRename()
      }
    },
    children: [
      focused ? jsx('span', { 'aria-hidden': true, className: 'absolute left-0 w-0.5 rounded-full bg-(--ui-accent)', style: { top: 6, bottom: 6 } }) : null,
      drag?.indicator
        ? jsx('span', {
            'aria-hidden': true,
            className: 'pointer-events-none absolute inset-x-1.5 h-0.5 rounded-full bg-(--ui-accent)',
            style: drag.indicator === 'after' ? { bottom: -1.5 } : { top: -1.5 }
          })
        : null,
      jsx(SessionStatusDot, { storedSessionId: storedId }),
      jsxs('span', {
        className: 'min-w-0 flex-1',
        children: [
          renaming
            ? jsx(InlineName, {
                value: title,
                label: 'Session name',
                onDone: next => {
                  setRenaming(false)
                  if (next && next !== title) void ctl.rename(storedId, next)
                }
              })
            : jsx('span', { className: 'block truncate', children: title }),
          details?.metadata
            ? jsx('span', { className: 'mt-0.5 block truncate text-[0.625rem] text-(--ui-text-tertiary)', children: details.metadata })
            : null,
          density === 'detailed' && details?.preview
            ? jsx('span', { className: 'mt-1 block truncate text-[0.625rem] text-(--ui-text-quaternary)', children: details.preview })
            : null
        ]
      }),
      drag && !renaming
        ? jsx('span', {
            'aria-hidden': true,
            className: 'grid size-5 shrink-0 cursor-grab place-items-center text-(--ui-text-quaternary) opacity-0 transition-opacity group-hover:opacity-100',
            children: jsx(Codicon, { name: 'gripper', className: 'text-[0.75rem]' })
          })
        : null,
      onClose && !renaming
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
  return jsx(WithMenu, {
    items,
    label: `${title} actions`,
    // Rename: keep focus off the row so the name field gets it.
    onCloseAutoFocus: e => {
      if (keepFocus.current) {
        keepFocus.current = false
        e.preventDefault()
      }
    },
    children: row
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

// Core shows 3 rows of a collapsed-by-default platform section, then 10 more per click.
const SOURCE_INITIAL_ROWS = 3
const SOURCE_LOAD_STEP = 10

/** A platform / cron section: header toggles open, rows reveal in steps. */
function SourceSection({ ctl, id, label, rows, forceOpen, renderRow }) {
  const openIds = useValue(ctl.$openSections)
  const [shown, setShown] = useState(SOURCE_INITIAL_ROWS)
  const open = forceOpen || openIds.includes(id)
  const visible = forceOpen ? rows : rows.slice(0, shown)
  return jsxs('section', {
    className: 'flex flex-col gap-px pb-3',
    children: [
      jsxs('button', {
        type: 'button',
        'aria-expanded': open,
        onClick: () => ctl.toggleSection(id),
        className:
          'flex h-6 w-full items-center gap-1.5 rounded-md pl-2.5 pr-1 text-left text-[0.6875rem] font-medium uppercase text-(--ui-text-quaternary) transition-colors hover:text-(--ui-text-secondary)',
        style: { letterSpacing: '0.06em' },
        children: [
          jsx('span', { className: 'min-w-0 truncate', children: label }),
          jsx('span', { className: 'tabular-nums', children: rows.length }),
          jsx(Codicon, { name: open ? 'chevron-down' : 'chevron-right', className: 'ml-auto text-[0.75rem]' })
        ]
      }),
      ...(open ? visible.map(renderRow) : []),
      open && !forceOpen && rows.length > shown
        ? jsx(
            'button',
            {
              type: 'button',
              onClick: () => setShown(shown + SOURCE_LOAD_STEP),
              className: 'flex h-6 items-center pl-2.5 text-left text-xs text-(--ui-text-quaternary) transition-colors hover:text-(--ui-text-secondary)',
              children: `Show more (${rows.length - shown})`
            },
            'more'
          )
        : null
    ]
  })
}

function Section({ label, count, action, children }) {
  return jsxs('section', {
    className: 'flex flex-col gap-px pb-3',
    children: [
      jsxs('div', {
        className: 'flex h-6 items-center gap-1.5 pl-2.5 pr-1 text-[0.6875rem] font-medium uppercase text-(--ui-text-quaternary)',
        style: { letterSpacing: '0.06em' },
        children: [label, count ? jsx('span', { className: 'tabular-nums', children: count }) : null, action ? jsx('span', { className: 'ml-auto flex', children: action }) : null]
      }),
      ...children
    ]
  })
}

/** Mini diagram of a layout with four tiles, drawn from the real engine. */
function LayoutGlyph({ layout, active, flip = false, w = 34, h = 22 }) {
  const area = { x: 0, y: 0, w, h }
  const spec =
    layout === 'fullscreen'
      ? fullscreenArrangement(['a', 'b', 'c', 'd'], 'a', area, { minTileW: w / 3, peek: h / 6 })
      : arrangement(layout, ['a', 'b', 'c', 'd'], area, { flip })
  const tiles = specRects(spec, area)
  const gap = 1.5
  return jsx('span', {
    'aria-hidden': true,
    className: 'relative inline-block shrink-0',
    style: { width: w, height: h },
    children: [...tiles.values()].map((r, i) =>
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

/** Layout name as shown: flipped Columns reads as Rows; other flipped layouts get ⇅. */
const layoutName = (id, flipped) => (!flipped ? LAYOUT_INFO[id].label : id === 'columns' ? 'Rows' : `${LAYOUT_INFO[id].label} ⇅`)

/** Content width of the element behind `ref`, tracked live (0 until measured). */
function useWidth() {
  const ref = useRef(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => setW(Math.round(entries[0]?.contentRect.width ?? 0)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

// Below this width per cell the labels go (icons + tooltips); below the
// next the cells wrap onto more rows instead of squashing the glyphs.
const LABEL_CELL = 54
const ICON_CELL = 34

/** Layout switch for the Tiles pane header: the enabled layouts, plus the
 *  flip (rows ↔ columns) toggle. Adapts to the sidebar's width. */
function LayoutSwitcher({ ctl }) {
  const s = useValue(ctl.$settings)
  const fullscreen = useValue(ctl.$fullscreen)
  const flipCombo = useFirstCombo('flip')
  const [ref, width] = useWidth()
  const offered = enabledLayouts(s.layouts_enabled)
  const flipped = Boolean(s.flipped)
  const radios = offered.length >= 2 ? offered : []
  const cells = radios.length + 1
  const per = width ? (width - 8 - 4 * (cells - 1)) / cells : Infinity
  const labels = per >= LABEL_CELL
  const wrap = per < ICON_CELL
  const cellClass = on =>
    cn(
      'flex min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 text-[0.6875rem] transition-colors',
      labels ? 'pb-1 pt-1.5' : 'py-1.5',
      on ? 'text-foreground' : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
    )
  const label = text => (labels ? jsx('span', { className: 'max-w-full truncate', children: text }) : null)
  const flipKeys = flipCombo ? ` (${comboKeys(flipCombo, IS_MAC).join('+')})` : ''
  const flipButton = jsxs(
    'button',
    {
      type: 'button',
      'aria-pressed': flipped,
      'aria-label': 'Flip orientation',
      title: `Flip orientation: ${flipped ? 'rows back to columns' : 'columns become rows'}${flipKeys}`,
      // A toggle, not a layout: pressed shows as an accent icon, not the
      // selected-layout wash, so it never reads as a second active layout.
      className: cellClass(false),
      style: flipped ? { color: 'var(--ui-accent)' } : undefined,
      onClick: () => ctl.toggleFlip(),
      children: [
        jsx('span', {
          'aria-hidden': true,
          className: 'grid place-items-center',
          style: { width: 28, height: 18 },
          children: jsx(Codicon, {
            name: 'arrow-swap',
            className: 'text-[0.875rem]',
            style: { transform: flipped ? 'rotate(90deg)' : 'none', transition: 'transform 150ms ease' }
          })
        }),
        label('Flip')
      ]
    },
    'flip'
  )
  return jsxs('div', {
    ref,
    className: 'mx-1 mb-3 grid gap-1 rounded-lg p-1',
    style: {
      gridTemplateColumns: wrap ? `repeat(auto-fill, minmax(${ICON_CELL}px, 1fr))` : `repeat(${cells}, minmax(0, 1fr))`,
      background: 'color-mix(in srgb, var(--ui-text-secondary) 7%, transparent)'
    },
    children: [
      radios.length
        ? jsx('div', {
            role: 'radiogroup',
            'aria-label': 'Tile layout',
            // Children join the parent grid so the flip button wraps with them.
            style: { display: 'contents' },
            children: radios.map(id => {
              const on = s.layout === id && !fullscreen
              return jsxs(
                'button',
                {
                  type: 'button',
                  role: 'radio',
                  'aria-checked': on,
                  'aria-label': LAYOUT_INFO[id].label,
                  title: `${LAYOUT_INFO[id].label}: ${LAYOUT_INFO[id].blurb}`,
                  className: cellClass(on),
                  style: on ? ACCENT_WASH : undefined,
                  onClick: () => ctl.setLayout(id),
                  children: [jsx(LayoutGlyph, { layout: id, active: on, flip: flipped, w: 28, h: 18 }), label(LAYOUT_INFO[id].label)]
                },
                id
              )
            })
          })
        : null,
      flipButton
    ]
  })
}

// -- shortcuts card -----------------------------------------------------------

const actionDefaults = id => ACTIONS.find(a => a[0] === id)?.[2] ?? []
// Live bindings through the SDK hook; older Desktops show the defaults.
const useCombos = SDK.useKeybindCombos ?? ((_id, fallback) => fallback)
const useFirstCombo = id => useCombos(`${ID}.${id}`, actionDefaults(id))[0] ?? null

function Keys({ keys, wrap = false }) {
  return jsx('span', {
    className: 'inline-flex shrink-0 items-center gap-0.5',
    style: wrap ? { flexWrap: 'wrap', flexShrink: 1, minWidth: 0 } : undefined,
    children: keys.map((k, i) =>
      Kbd
        ? jsx(Kbd, { size: 'sm', variant: 'ghost', children: k }, i)
        : jsx(
            'kbd',
            {
              className: 'inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-[0.2rem] px-1 text-[0.625rem] text-(--ui-text-tertiary)',
              style: { background: 'color-mix(in srgb, var(--ui-text-secondary) 12%, transparent)' },
              children: k
            },
            i
          )
    )
  })
}

const HINT_ACTIONS = ['focus-left', 'focus-right', 'focus-up', 'focus-down', 'new-tile', 'cycle-layout', 'flip', 'fullscreen']

/** First-run card: the four shortcuts worth learning, with the user's live keys. */
function ShortcutsHint({ ctl }) {
  const s = useValue(ctl.$settings)
  const [ref, width] = useWidth()
  // Fixed hook order: one live lookup per action, every render.
  const combos = Object.fromEntries(HINT_ACTIONS.map(id => [id, useFirstCombo(id)]))
  if (s.hint_dismissed) return null
  const arrows = arrowKeys(['focus-left', 'focus-right', 'focus-up', 'focus-down'].map(id => combos[id]), IS_MAC)
  const one = id => (combos[id] ? comboKeys(combos[id], IS_MAC) : null)
  const rows = [
    ['Move focus', arrows ?? one('focus-left')],
    ['New tile', one('new-tile')],
    ['Next layout', one('cycle-layout')],
    ['Flip rows/columns', one('flip')],
    ['Fullscreen', one('fullscreen')]
  ].filter(r => r[1])
  if (!rows.length) return null
  // Narrow sidebar: each label sits above its keys instead of beside them.
  const stacked = width > 0 && width < 200
  return jsxs('div', {
    ref,
    className: 'relative mx-1 mb-3 rounded-lg py-2 pl-2.5 pr-2',
    style: { background: 'color-mix(in srgb, var(--ui-text-secondary) 7%, transparent)' },
    children: [
      jsxs('div', {
        className: 'mb-1.5 flex items-center justify-between',
        children: [
          jsx('span', { className: 'text-xs font-medium text-(--ui-text-secondary)', children: 'Shortcuts' }),
          jsx('button', {
            type: 'button',
            'aria-label': 'Hide shortcuts',
            title: 'Hide shortcuts',
            className: 'grid size-5 place-items-center rounded text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
            onClick: () => ctl.setSettings({ hint_dismissed: true }),
            children: jsx(Codicon, { name: 'close', className: 'text-[0.75rem]' })
          })
        ]
      }),
      jsx('dl', {
        className: 'grid items-center gap-x-3 gap-y-1',
        style: { gridTemplateColumns: stacked ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) auto' },
        children: rows.flatMap(([label, keys]) => [
          jsx('dt', { className: 'truncate text-xs text-(--ui-text-tertiary)', style: stacked ? { marginTop: 4 } : undefined, children: label }, `${label}:t`),
          jsx('dd', { className: 'flex', style: { justifyContent: stacked ? 'flex-start' : 'flex-end', minWidth: 0 }, children: jsx(Keys, { keys, wrap: stacked }) }, `${label}:d`)
        ])
      })
    ]
  })
}

// -- search -------------------------------------------------------------------

function Search({ value, onChange }) {
  const onKeyDown = e => {
    if (e.key !== 'Escape') return
    if (value) {
      e.preventDefault()
      e.stopPropagation()
      onChange('')
    } else {
      e.currentTarget.blur()
    }
  }
  if (SearchField) {
    return jsx(SearchField, {
      placeholder: 'Search sessions',
      value,
      onChange,
      onKeyDown,
      'aria-label': 'Search sessions',
      containerClassName: 'mx-2 mb-2 flex'
    })
  }
  return jsxs('label', {
    className: 'mx-2 mb-2 flex h-7 items-center gap-1.5 text-xs',
    children: [
      jsx(Codicon, { name: 'search', className: 'text-[0.8125rem] text-(--ui-text-quaternary)' }),
      jsx('input', {
        type: 'text',
        value,
        placeholder: 'Search sessions',
        'aria-label': 'Search sessions',
        className: 'h-7 min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-(--ui-text-quaternary)',
        onChange: e => onChange(e.target.value),
        onKeyDown
      })
    ]
  })
}

// -- workspaces ---------------------------------------------------------------

function WorkspaceRow({ ctl, ws, editing, onEdit }) {
  const keepFocus = useRef(false)
  const items = [
    ['folder-opened', 'Restore', () => void ctl.restoreWorkspace(ws.id)],
    ['save', 'Replace with open tiles', () => ctl.overwriteWorkspace(ws.id)],
    [
      'edit',
      'Rename',
      () => {
        keepFocus.current = true
        onEdit(ws.id)
      }
    ],
    'sep',
    ['trash', 'Delete', () => ctl.deleteWorkspace(ws.id), true]
  ]
  const n = ws.sessions.length
  const row = jsxs('div', {
    className:
      'group flex h-7 cursor-pointer items-center gap-2 rounded-md pl-2.5 pr-2 text-[0.8125rem] text-(--ui-text-secondary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
    role: 'button',
    tabIndex: 0,
    title: editing ? undefined : `Restore ${ws.name}: ${n} ${n === 1 ? 'session' : 'sessions'}, ${LAYOUT_INFO[ws.layout].label}`,
    onClick: () => {
      if (!editing) void ctl.restoreWorkspace(ws.id)
    },
    onKeyDown: e => {
      if (editing) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        void ctl.restoreWorkspace(ws.id)
      } else if (e.key === 'F2') {
        e.preventDefault()
        onEdit(ws.id)
      }
    },
    children: [
      jsx(LayoutGlyph, { layout: ws.layout, active: false, w: 14, h: 10 }),
      jsx('span', {
        className: 'min-w-0 flex-1',
        children: editing
          ? jsx(InlineName, {
              value: ws.name,
              label: 'Workspace name',
              onDone: next => {
                onEdit(null)
                if (next) ctl.updateWorkspace(ws.id, { name: next })
              }
            })
          : jsx('span', { className: 'block truncate', children: ws.name })
      }),
      editing ? null : jsx('span', { className: 'shrink-0 text-[0.6875rem] tabular-nums text-(--ui-text-quaternary)', children: n })
    ]
  })
  return jsx(WithMenu, {
    items,
    label: `${ws.name} actions`,
    onCloseAutoFocus: e => {
      if (keepFocus.current) {
        keepFocus.current = false
        e.preventDefault()
      }
    },
    children: row
  })
}

function SaveWorkspaceButton({ ctl, onSaved }) {
  return jsx('button', {
    type: 'button',
    'aria-label': 'Save open tiles as a workspace',
    title: 'Save open tiles as a workspace',
    className: 'grid size-5 place-items-center rounded normal-case text-(--ui-text-quaternary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
    onClick: () => {
      const ws = ctl.saveWorkspace()
      if (ws) onSaved(ws.id)
    },
    children: jsx(Codicon, { name: 'save', className: 'text-[0.8125rem]' })
  })
}

/** Restore picker for the keybind and palette: arrows + Enter, or 1–9. */
function WorkspacePicker({ ctl }) {
  const open = useValue(ctl.$picker)
  const all = useValue(ctl.$workspaces)
  const [at, setAt] = useState(0)
  const items = useRef([])
  useEffect(() => {
    if (open) setAt(Math.max(0, all.length - 1))
  }, [open])
  useEffect(() => {
    if (open) items.current[at]?.focus()
  }, [open, at])
  if (!hasDialog) return null
  const pick = ws => {
    ctl.$picker.set(false)
    void ctl.restoreWorkspace(ws.id)
  }
  return jsx(Dialog, {
    open,
    onOpenChange: next => ctl.$picker.set(next),
    children: jsxs(DialogContent, {
      className: 'max-w-sm',
      children: [
        jsx(DialogHeader, { children: jsx(DialogTitle, { children: 'Restore workspace' }) }),
        jsx('div', {
          role: 'listbox',
          'aria-label': 'Workspaces',
          className: 'flex flex-col gap-px',
          onKeyDown: e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setAt(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length)
            } else if (/^[1-9]$/.test(e.key) && all[Number(e.key) - 1]) {
              e.preventDefault()
              pick(all[Number(e.key) - 1])
            }
          },
          children: all.map((ws, i) =>
            jsxs(
              'button',
              {
                type: 'button',
                role: 'option',
                ref: el => {
                  items.current[i] = el
                },
                'aria-selected': i === at,
                className: cn(
                  'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none transition-colors',
                  i === at ? 'text-foreground' : 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)'
                ),
                style: i === at ? ACCENT_WASH : undefined,
                onFocus: () => setAt(i),
                onClick: () => pick(ws),
                children: [
                  jsx(LayoutGlyph, { layout: ws.layout, active: i === at, w: 18, h: 12 }),
                  jsx('span', { className: 'min-w-0 flex-1 truncate', children: ws.name }),
                  jsx('span', { className: 'text-xs tabular-nums text-(--ui-text-quaternary)', children: ws.sessions.length }),
                  i < 9 ? jsx(Keys, { keys: [String(i + 1)] }) : null
                ]
              },
              ws.id
            )
          )
        })
      ]
    })
  })
}

// -- the Tiles pane -----------------------------------------------------------

function makePane(ctl) {
  const tiling = hasTiling()

  // Two hooks so each render calls a fixed set of hooks.
  function useOpen() {
    const l = useValue(host.state.sessionLayout)
    const order = useValue(ctl.$order)
    const open = openSessions(l.root, l.mainStoredSessionId)
    // Tile order, so the list reads like the screen and a drop lands where it shows.
    return { open: sortByOrder(open, order, o => groupIdOfPane(l.root, o.paneId)), pinnedIds: useValue(host.state.pinnedSessionIds) }
  }

  function useOpenStock() {
    return { open: useValue(ctl.$openedHere), pinnedIds: [] }
  }

  return function TiledSessionsPane() {
    const { data } = useSessionRows()
    const focused = useValue(host.state.focusedStoredSessionId)
    const settings = useValue(ctl.$settings)
    const workspaces = useValue(ctl.$workspaces)
    const { open, pinnedIds } = tiling ? useOpen() : useOpenStock()
    const [query, setQuery] = useState('')
    const [editingWs, setEditingWs] = useState(null)
    const renameWs = useValue(ctl.$renameWs)
    useEffect(() => ctl.paneMounted(), [])
    useEffect(() => {
      if (!renameWs) return
      setEditingWs(renameWs)
      ctl.$renameWs.set(null)
    }, [renameWs])
    const [drag, setDrag] = useState(null) // { id, over, after }
    const rows = data?.sessions ?? []
    const byKey = new Map()
    for (const r of rows) for (const k of rowKeys(r)) if (!byKey.has(k)) byKey.set(k, r)
    const titleOf = id => {
      const r = byKey.get(id)
      return (r && (r.title || r.preview)) || 'Untitled chat'
    }
    const searching = query.trim().length > 0
    const hit = (id, r = byKey.get(id)) => matchesQuery({ title: titleOf(id), preview: r?.preview }, query)

    const onOpen = (id, e) => void ctl.open(id, { replace: Boolean(e?.[`${settings.replace_modifier}Key`]) })
    const openIds = new Set(open.map(o => o.storedSessionId))
    const pinSet = new Set(pinnedIds)
    const isPinned = id => pinSet.has(id) || rowKeys(byKey.get(id) ?? { id }).some(k => pinSet.has(k))
    const pinned = pinnedIds.map(id => byKey.get(id)).filter(Boolean)
    const pinnedIdSet = new Set(pinned.map(rowId))
    const rest = rows.filter(r => !pinnedIdSet.has(rowId(r)) && !openIds.has(rowId(r)))

    const shownPinned = pinned.filter(r => hit(rowId(r), r))
    const shownOpen = open.filter(o => hit(o.storedSessionId))
    const shownRest = rest.filter(r => hit(rowId(r), r))
    // Same sections as the core sidebar: local Sessions, one per platform, Cron jobs.
    const bySource = groupBySource(shownRest)
    const shownWs = workspaces.filter(w => matchesQuery({ title: w.name }, query))
    const nothing = searching && !shownPinned.length && !shownOpen.length && !shownRest.length && !shownWs.length

    const canDrag = canArrange() && !searching && open.length > 1
    const dragFor = id =>
      canDrag
        ? {
            dragging: drag?.id === id,
            indicator: drag && drag.over === id && drag.id !== id ? (drag.after ? 'after' : 'before') : null,
            onDragStart: e => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', id)
              setDrag({ id, over: null, after: false })
            },
            onDragOver: e => {
              if (!drag) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const box = e.currentTarget.getBoundingClientRect()
              const after = e.clientY > box.top + box.height / 2
              if (drag.over !== id || drag.after !== after) setDrag({ ...drag, over: id, after })
            },
            onDragLeave: () => {
              if (drag?.over === id) setDrag({ ...drag, over: null })
            },
            onDrop: e => {
              e.preventDefault()
              if (drag && drag.id !== id) ctl.moveTile(drag.id, id, drag.after)
              setDrag(null)
            },
            onDragEnd: () => setDrag(null)
          }
        : null

    const sessionRow = (prefix, id, r, extra = {}) =>
      jsx(
        Row,
        {
          ctl,
          storedId: id,
          title: titleOf(id),
          session: r,
          focused: focused === id,
          pinned: isPinned(id),
          tile: ctl.paneOf(id),
          onOpen,
          ...extra
        },
        `${prefix}:${id}`
      )

    return jsxs('div', {
      className: 'flex h-full flex-col overflow-y-auto px-1.5 py-2',
      children: [
        canArrange() ? jsx(LayoutSwitcher, { ctl }) : null,
        tiling
          ? null
          : jsx('p', {
              className: 'mx-1 mb-3 rounded-md px-2.5 py-2 text-xs leading-relaxed text-(--ui-text-tertiary)',
              style: { background: 'color-mix(in srgb, var(--ui-text-secondary) 7%, transparent)' },
              children: `Tiling needs ${NEEDS}. Until then, sessions open as tabs.`
            }),
        tiling ? jsx(ShortcutsHint, { ctl }) : null,
        jsx(Search, { value: query, onChange: setQuery }),
        nothing
          ? jsx('p', { className: 'px-2.5 pt-2 text-xs text-(--ui-text-quaternary)', children: `No sessions match ${query.trim()}` })
          : null,
        shownPinned.length
          ? jsx(Section, { label: 'Pinned', children: shownPinned.map(r => sessionRow('p', rowId(r), r)) })
          : null,
        searching ? null : jsx(NewSessionRow, { ctl }),
        !searching || shownOpen.length
          ? jsx(Section, {
              label: tiling ? 'Open' : 'Opened here',
              count: open.length || null,
              action: canArrange() && open.length && !searching ? jsx(SaveWorkspaceButton, { ctl, onSaved: setEditingWs }) : null,
              children: shownOpen.length
                ? shownOpen.map(o =>
                    sessionRow('o', o.storedSessionId, byKey.get(o.storedSessionId), {
                      dim: !o.visible,
                      onClose: ctl.close,
                      drag: dragFor(o.storedSessionId)
                    })
                  )
                : [jsx('p', { className: 'px-2.5 text-xs text-(--ui-text-quaternary)', children: 'Click a session to open it in a new tile.' }, 'empty')]
            })
          : null,
        canArrange() && shownWs.length
          ? jsx(Section, {
              label: 'Workspaces',
              children: shownWs.map(ws =>
                jsx(WorkspaceRow, { ctl, ws, editing: editingWs === ws.id, onEdit: setEditingWs }, ws.id)
              )
            })
          : null,
        bySource.sessions.length
          ? jsx(Section, { label: 'Sessions', children: bySource.sessions.map(r => sessionRow('s', rowId(r), r)) })
          : null,
        ...bySource.platforms.map(g =>
          jsx(
            SourceSection,
            { ctl, id: g.id, label: g.label, rows: g.rows, forceOpen: searching, renderRow: r => sessionRow(g.id, rowId(r), r) },
            `src:${g.id}`
          )
        ),
        bySource.cron.length
          ? jsx(
              SourceSection,
              { ctl, id: 'cron', label: 'Cron jobs', rows: bySource.cron, forceOpen: searching, renderRow: r => sessionRow('c', rowId(r), r) },
              'src:cron'
            )
          : null
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
  ['flip', 'Flip orientation (rows ↔ columns)', ['ctrl+alt+/'], c => c.toggleFlip()],
  ['fullscreen', 'Toggle fullscreen tile', ['ctrl+alt+f'], c => c.toggleFullscreen()],
  ['promote', 'Make focused tile the master', ['ctrl+alt+m'], c => c.promoteFocused()],
  ['equalize', 'Re-tile and reset sizes', ['ctrl+alt+r'], c => c.equalizeAll()],
  ['save-workspace', 'Save open tiles as a workspace', ['ctrl+alt+s'], c => {
    const ws = c.saveWorkspace()
    if (!ws) return
    // With the Tiles pane on screen, open the new row straight into rename.
    if (c.hasPane()) c.$renameWs.set(ws.id)
    else host.notify({ kind: 'success', message: `Saved ${ws.name}. Rename it in the Tiles pane.` })
  }],
  ['restore-workspace', 'Restore workspace…', ['ctrl+alt+o'], c => c.openPicker()],
  ['show-shortcuts', 'Show shortcuts', [], c => c.showShortcuts()],
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

function OfferSwitch({ checked, disabled, label, onChange }) {
  if (Switch) return jsx(Switch, { checked, disabled, 'aria-label': label, onCheckedChange: onChange })
  return jsx('input', { type: 'checkbox', checked, disabled, 'aria-label': label, onChange: e => onChange(e.target.checked) })
}

/** One card per layout: click to use it, switch to offer it in the pane,
 *  status chip and Next layout. The last offered layout can't be switched off. */
function LayoutCards({ ctl, s }) {
  const offered = enabledLayouts(s.layouts_enabled)
  return jsx('div', {
    role: 'radiogroup',
    'aria-label': 'Layout',
    className: 'grid grid-cols-2 gap-2 px-1 pb-1 sm:grid-cols-4',
    children: LAYOUTS.map(id => {
      const on = offered.includes(id)
      const current = s.layout === id
      return jsxs(
        'div',
        {
          className: cn(
            'relative flex flex-col rounded-lg border transition-colors',
            current ? 'border-(--ui-accent)' : 'border-(--ui-stroke-secondary)',
            !on && 'opacity-55'
          ),
          style: current ? { background: 'color-mix(in srgb, var(--ui-accent) 10%, transparent)' } : undefined,
          children: [
            jsxs('button', {
              type: 'button',
              role: 'radio',
              'aria-checked': current,
              disabled: !on,
              className: cn('flex flex-1 flex-col items-start gap-2 rounded-lg p-3 text-left', on && !current && 'hover:bg-(--chrome-action-hover)'),
              onClick: () => ctl.setLayout(id),
              children: [
                jsx(LayoutGlyph, { layout: id, active: current, flip: Boolean(s.flipped), w: 64, h: 40 }),
                jsx('span', { className: 'text-sm font-medium text-foreground', children: LAYOUT_INFO[id].label }),
                jsx('span', { className: 'text-xs leading-snug text-(--ui-text-tertiary)', children: LAYOUT_INFO[id].blurb })
              ]
            }),
            jsx('span', {
              className: 'absolute right-2.5 top-2.5 flex',
              title: on && offered.length === 1 ? 'At least one layout stays on' : on ? `Stop offering ${LAYOUT_INFO[id].label}` : `Offer ${LAYOUT_INFO[id].label}`,
              children: jsx(OfferSwitch, {
                checked: on,
                disabled: on && offered.length === 1,
                label: `Offer ${LAYOUT_INFO[id].label}`,
                onChange: next => ctl.setLayoutOffered(id, next)
              })
            })
          ]
        },
        id
      )
    })
  })
}

function MasterSize({ ctl, s }) {
  const custom = !MASTER_PRESETS.includes(s.master_ratio)
  const options = MASTER_PRESETS.map(n => ({ id: String(n), label: `${Math.round(n * 100)}%` }))
  if (custom) options.push({ id: String(s.master_ratio), label: `${Math.round(s.master_ratio * 100)}%` })
  return jsx(ListRow, {
    title: 'Master size',
    description: custom ? 'Set by dragging the divider. Pick a preset to go back.' : 'Width of the master tile. Drag the divider to set your own.',
    action: jsx(SegmentedControl, {
      options,
      value: String(s.master_ratio),
      onChange: v => {
        if (Number(v) !== s.master_ratio) ctl.setMasterPreset(Number(v))
      }
    })
  })
}

function Workspaces({ ctl }) {
  const all = useValue(ctl.$workspaces)
  const [editing, setEditing] = useState(null)
  if (!all.length) {
    return jsx('p', {
      className: 'px-2.5 py-1 text-sm text-(--ui-text-tertiary)',
      children: 'None yet. Save your open tiles from the Open list in the Tiles pane.'
    })
  }
  return jsx('div', {
    className: 'flex flex-col gap-px px-1',
    children: all.map(ws => jsx(WorkspaceRow, { ctl, ws, editing: editing === ws.id, onEdit: setEditing }, ws.id))
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
      'Every Tiled Sessions shortcut is rebindable in Keybinds. Search for Tiles.',
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
        jsx(LayoutCards, { ctl, s }),
        s.layout === 'master' ? jsx(MasterSize, { ctl, s }) : null,
        jsx(ToggleRow, {
          label: 'Auto-tile',
          description: arrange
            ? 'Re-tile whenever a tile opens or closes. Off: new tiles split a tile and stay where you put them.'
            : `Needs ${NEEDS} with arrangeSessions.`,
          checked: s.auto_tile && arrange,
          onChange: on => {
            ctl.setSettings({ auto_tile: on })
            if (on) ctl.retileAll()
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
          label: 'Tab-strip + opens a new tile',
          description: canRedirectPlus()
            ? 'The + after a chat\u2019s tabs opens a new session as its own tile. Off: it stacks a new tab, like stock Hermes.'
            : `Needs ${NEEDS} with redirectNewSessionTab.`,
          checked: s.plus_new_tile && canRedirectPlus(),
          onChange: on => ctl.setSettings({ plus_new_tile: on })
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
        arrange ? jsx(SettingsHeading, { children: 'Workspaces' }) : null,
        arrange ? jsx(Workspaces, { ctl }) : null,
        jsx(SettingsHeading, { children: 'Shortcuts' }),
        jsx(ToggleRow, {
          label: 'Shortcuts card',
          description: 'Show the key shortcuts at the top of the Tiles pane.',
          checked: !s.hint_dismissed,
          onChange: on => ctl.setSettings({ hint_dismissed: !on })
        }),
        jsx(Shortcuts, { ctx })
      ]
    })
  }
}

function makeStatusChip(ctl) {
  return function TiledSessionsChip() {
    const s = useValue(ctl.$settings)
    const fullscreen = useValue(ctl.$fullscreen)
    const l = useValue(host.state.sessionLayout)
    const n = chatZones(l?.root ?? null).length
    // The picker rides along here: the status bar is always mounted.
    const picker = jsx(WorkspacePicker, { ctl }, 'picker')
    if (n < 2) return picker
    const chip = jsxs(
      'button',
      {
        type: 'button',
        title: fullscreen ? 'Fullscreen tile: click to bring the layout back' : 'Tile layout: click for the next one',
        className: cn('flex h-full items-center gap-1.5 px-1.5 hover:text-foreground', fullscreen ? 'text-(--ui-text-secondary)' : 'text-(--ui-text-tertiary)'),
        onClick: () => (fullscreen ? ctl.toggleFullscreen() : ctl.cycleLayout()),
        children: [
          jsx(LayoutGlyph, { layout: fullscreen ? 'fullscreen' : s.layout, active: false, flip: !fullscreen && Boolean(s.flipped), w: 16, h: 11 }),
          `${fullscreen ? 'Fullscreen' : layoutName(s.layout, s.flipped)} · ${n}`
        ]
      },
      'chip'
    )
    return [chip, picker]
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
    if (canRedirectPlus()) ctx.onDispose(host.layout.redirectNewSessionTab(ctl.onStripPlus))
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

    // One palette entry per saved workspace ("Tiles: Restore Review").
    if (canArrange()) {
      let disposeWs = []
      const syncWorkspaceCommands = all => {
        for (const d of disposeWs) if (typeof d === 'function') d()
        disposeWs = all.map(ws =>
          ctx.register({
            id: `cmd:ws:${ws.id}`,
            area: PALETTE_AREA,
            data: { id: `${ID}.ws.${ws.id}`, label: `Tiles: Restore ${ws.name}`, keywords: ['workspace'], run: () => void ctl.restoreWorkspace(ws.id) }
          })
        )
      }
      syncWorkspaceCommands(ctl.$workspaces.get())
      ctx.onDispose(ctl.$workspaces.listen(syncWorkspaceCommands))
    }
  }
}
