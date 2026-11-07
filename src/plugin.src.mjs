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
