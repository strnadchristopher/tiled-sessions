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
