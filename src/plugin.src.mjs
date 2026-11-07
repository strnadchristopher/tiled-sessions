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
  replace_modifier: 'alt',
  hint_dismissed: false
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
    const spec = arrangement(s.layout, order.map(g => paneOfGroup.get(g)), engineView().area, { masterRatio: s.master_ratio })
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
      if (id) ctx.setTimeout(() => host.composer?.focus?.(id), 80)
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
        if (id) host.composer?.focus?.(id)
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
    retileAll: () => retile({ force: true }),
    $settings,
    $openedHere,
    $order,
    $workspaces,
    $fullscreen,
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
function LayoutGlyph({ layout, active, w = 34, h = 22 }) {
  const area = { x: 0, y: 0, w, h }
  const spec =
    layout === 'fullscreen'
      ? fullscreenArrangement(['a', 'b', 'c', 'd'], 'a', area, { minTileW: w / 3, peek: h / 6 })
      : arrangement(layout, ['a', 'b', 'c', 'd'], area)
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

/** Layout switch for the Tiles pane header: the enabled layouts only. */
function LayoutSwitcher({ ctl }) {
  const s = useValue(ctl.$settings)
  const fullscreen = useValue(ctl.$fullscreen)
  const offered = enabledLayouts(s.layouts_enabled)
  if (offered.length < 2) return null
  return jsx('div', {
    role: 'radiogroup',
    'aria-label': 'Tile layout',
    className: 'mx-1 mb-3 grid gap-1 rounded-lg p-1',
    style: { gridTemplateColumns: `repeat(${offered.length}, minmax(0, 1fr))`, background: 'color-mix(in srgb, var(--ui-text-secondary) 7%, transparent)' },
    children: offered.map(id => {
      const on = s.layout === id && !fullscreen
      return jsxs(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': on,
          title: `${LAYOUT_INFO[id].label}: ${LAYOUT_INFO[id].blurb}`,
          className: cn(
            'flex flex-col items-center gap-1 rounded-md px-1 pb-1 pt-1.5 text-[0.6875rem] transition-colors',
            on ? 'text-foreground' : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
          ),
          style: on ? ACCENT_WASH : undefined,
          onClick: () => ctl.setLayout(id),
          children: [jsx(LayoutGlyph, { layout: id, active: on, w: 28, h: 18 }), LAYOUT_INFO[id].label]
        },
        id
      )
    })
  })
}

// -- shortcuts card -----------------------------------------------------------

const actionDefaults = id => ACTIONS.find(a => a[0] === id)?.[2] ?? []
// Live bindings through the SDK hook; older Desktops show the defaults.
const useCombos = SDK.useKeybindCombos ?? ((_id, fallback) => fallback)
const useFirstCombo = id => useCombos(`${ID}.${id}`, actionDefaults(id))[0] ?? null

function Keys({ keys }) {
  return jsx('span', {
    className: 'inline-flex shrink-0 items-center gap-0.5',
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

const HINT_ACTIONS = ['focus-left', 'focus-right', 'focus-up', 'focus-down', 'new-tile', 'cycle-layout', 'fullscreen']

/** First-run card: the four shortcuts worth learning, with the user's live keys. */
function ShortcutsHint({ ctl }) {
  const s = useValue(ctl.$settings)
  // Fixed hook order: one live lookup per action, every render.
  const combos = Object.fromEntries(HINT_ACTIONS.map(id => [id, useFirstCombo(id)]))
  if (s.hint_dismissed) return null
  const arrows = arrowKeys(['focus-left', 'focus-right', 'focus-up', 'focus-down'].map(id => combos[id]), IS_MAC)
  const one = id => (combos[id] ? comboKeys(combos[id], IS_MAC) : null)
  const rows = [
    ['Move focus', arrows ?? one('focus-left')],
    ['New tile', one('new-tile')],
    ['Next layout', one('cycle-layout')],
    ['Fullscreen', one('fullscreen')]
  ].filter(r => r[1])
  if (!rows.length) return null
  return jsxs('div', {
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
        style: { gridTemplateColumns: 'minmax(0, 1fr) auto' },
        children: rows.flatMap(([label, keys]) => [
          jsx('dt', { className: 'truncate text-xs text-(--ui-text-tertiary)', children: label }, `${label}:t`),
          jsx('dd', { className: 'flex justify-end', children: jsx(Keys, { keys }) }, `${label}:d`)
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
        shownRest.length
          ? jsx(Section, { label: 'Sessions', children: shownRest.map(r => sessionRow('s', rowId(r), r)) })
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
                jsx(LayoutGlyph, { layout: id, active: current, w: 64, h: 40 }),
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
          jsx(LayoutGlyph, { layout: fullscreen ? 'fullscreen' : s.layout, active: false, w: 16, h: 11 }),
          `${fullscreen ? 'Fullscreen' : LAYOUT_INFO[s.layout].label} · ${n}`
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
