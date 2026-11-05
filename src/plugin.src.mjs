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
