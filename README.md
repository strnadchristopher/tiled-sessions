![Tiled Sessions, a community desktop plugin for Hermes](assets/tiled-sessions.jpg)

# Tiled Sessions

**Hyprland for Hermes Desktop.** Click a session and it opens as a new tile beside the ones you already have, instead of replacing the chat you were in. Pick a layout, drive it from the keyboard, and keep a whole team of agents on screen at once.

```sh
hermes plugins install tiled-sessions
```

![Cycling layouts, fullscreen and moving tiles from the keyboard](assets/demo.gif)

| | | |
|---|---|---|
| ![Grid: four sessions in an even 2×2](assets/screenshots/01-grid.jpg) | ![Master: one large tile with the rest stacked beside it](assets/screenshots/02-master.jpg) | ![Dwindle: each tile halves the last](assets/screenshots/03-dwindle.jpg) |
| **Grid** | **Master** | **Dwindle** |
| ![Fullscreen: the focused tile fills the chat area](assets/screenshots/04-fullscreen.jpg) | ![Right-click a session to pin, rename, move or close it](assets/screenshots/05-row-menu.jpg) | ![Settings: layouts to offer, sizes and shortcuts](assets/screenshots/06-settings.jpg) |
| **Fullscreen** | **Right-click any session** | **Every layout and shortcut is yours** |

## What it does

- **Click opens a tile.** A click on a session opens it in a new tile, and the layout re-tiles around it. If that session is already on screen, its tile is focused instead; a session is never open twice.
- **Four layouts**, switchable from the Tiles pane, the status bar chip, `Ctrl+Alt+Space`, or settings. Switch off the ones you never use and the pane, the chip and `Ctrl+Alt+Space` skip them:

  | Layout | Behaviour |
  |---|---|
  | **Grid** (default) | Every tile the same size. 2 side by side, 3 in columns, 4 as a 2×2, 6 as a 3×2. |
  | **Master** | One big tile with the rest stacked evenly beside it. Pick 50–66%, or drag the divider and that size sticks. `Ctrl+Alt+M` makes the focused tile the master. |
  | **Dwindle** | Hyprland's default. Each new tile halves the last along its longer side, making a spiral. |
  | **Columns** | Side by side, equal widths. Made for ultrawides. |

- **Fullscreen.** `Ctrl+Alt+F` fills the chat area with the focused tile; the others fold into a slim strip along the bottom, so a click (or `Ctrl+Alt+↓`) still reaches them and fullscreen follows. Press it again, open or close a tile, or click the status chip to bring the layout back.
- **Auto-tiling.** Whenever a tile opens or closes (by click, `Ctrl+W`, a tab's ✕ or a shortcut), every tile is laid out again. Dragging a sash to resize is left alone until the next open or close, except the Master divider, which is remembered. `Ctrl+Alt+R` re-tiles on demand and drops hand-dragged sizes, including a remembered Master size (back to the preset picked in settings). You can turn auto-tiling off and place tiles yourself.
- **Saved workspaces.** The save button on the *Open* list (or `Ctrl+Alt+S`) keeps the open tiles and the layout under a name. Click it in the *Workspaces* list, pick it with `Ctrl+Alt+O`, or run *Tiles: Restore …* from the palette, and those sessions come back as tiles in that order. Sessions deleted since are skipped. Right-click a workspace to rename, update or delete it; they're also listed in settings.
- **New chat in a new tile.** `Ctrl+Alt+Enter` starts a fresh chat in its own tile and focuses it, the way a tiling WM opens a terminal. The **+** after a chat's tabs does the same, opening the new tile beside that chat instead of stacking another tab. Turn the setting off and the + stacks a tab as usual.
- **The keyboard follows focus.** Moving focus moves the caret too, so typing and `Ctrl+W` land in the focused tile. (Hermes' `Ctrl+W` acts on the tile under the pointer first, when the pointer is over one.)
- **A Tiles pane** in the sidebar: a layout switcher, a shortcuts card on first run (your actual bindings; close it and *Tiles: Show shortcuts* brings it back), search, then *Pinned*, *Open* (tiles in on-screen order, focused one highlighted, drag a row to move its tile), *Workspaces* and *Sessions*.
  - **Search** filters every list by title and opening message as you type. `Escape` clears it.
  - **Right-click any session** to pin or unpin it, rename it (open sessions; `F2` works too), move its tile to main, or close its tile.
- **Every shortcut is editable** right on the plugin's settings page (`Settings → Plugins → Tiled Sessions`), with the same recorder, conflict warnings and reset as `Settings → Keybinds`:

  | Action | Default |
  |---|---|
  | Move focus | `Ctrl+Alt+←/→/↑/↓` |
  | Move the focused tile | `Ctrl+Alt+Shift+←/→/↑/↓` |
  | New chat in a new tile | `Ctrl+Alt+Enter` |
  | Close the focused tile | `Ctrl+Alt+W`, or Hermes' own `Ctrl+W` / `⌘W` |
  | Next layout | `Ctrl+Alt+Space` |
  | Fullscreen the focused tile | `Ctrl+Alt+F` |
  | Make the focused tile the master | `Ctrl+Alt+M` |
  | Re-tile and reset sizes | `Ctrl+Alt+R` |
  | Save open tiles as a workspace | `Ctrl+Alt+S` |
  | Restore a workspace | `Ctrl+Alt+O` |
  | Show the shortcuts card | unbound |
  | Switch to Grid / Master / Dwindle / Columns | unbound |
  | Move the focused session to main | unbound |

  On GNOME, `Ctrl+Alt+←/→` may already switch workspaces; rebind either side if they clash.
- **Old behaviour on demand.** Hold `Alt` (configurable) while clicking to replace the focused chat, as stock Hermes does. You can also switch the default back to replace, and cap the number of tiles.
- **Survives a restart.** Hermes persists the pane tree and the plugin keeps tile order, so tiles, layout and sizes come back as you left them.

## Settings

`Settings → Plugins → Tiled Sessions`:

| Setting | What it does |
|---|---|
| Layout | Click a card to use that layout; its switch offers it (or not) in the pane, the status chip and *Next layout*. One layout always stays on. |
| Master size | 50, 55, 60 or 66%. A size you dragged shows up as an extra, custom value. |
| Auto-tile | Re-tile whenever a tile opens or closes. |
| Split target | With auto-tile off: split the largest or the focused tile. |
| Tab-strip + opens a new tile | On by default. The + after a chat's tabs opens a new session as its own tile. Off: it stacks a new tab, like stock Hermes. |
| Click opens a new tile | Off: a click replaces the focused chat, like stock Hermes. |
| Replace-in-place modifier | `Alt` or `Shift` + click opens in place. |
| Max tiles | 4, 6, 8 or 12; past it, a click opens in place. |
| Workspaces | Your saved workspaces: click to restore, right-click to rename, update or delete. |
| Shortcuts card | Show or hide the card at the top of the Tiles pane. |
| Shortcuts | A recorder for every action above. |

## Requirements

Tiled Sessions uses the session-tiling seam of the desktop plugin SDK: `host.openSession(id, { dock })`, `host.state.sessionLayout`, `host.state.pinnedSessionIds`, `host.layout` (including `arrangeSessions` and `newChatTile`) and `KeybindEditor`. It is proposed upstream in [NousResearch/hermes-agent#149656](https://github.com/NousResearch/hermes-agent/pull/149656). On a Hermes build without it, the Tiles pane says so and sessions open as ordinary tabs.

Renaming uses the gateway's `session.title` RPC, the path core uses for live sessions; it needs the session's runtime id, which the SDK exposes for the focused chat (`host.state.focusedSessionId`), so Rename is offered for sessions open on screen. Pinning uses `host.sessions.pin`. Anything a Desktop lacks is left out of the menu.

It uses only the plugin SDK, React and `react/jsx-runtime`: no DOM queries, no observers, no patching. The one thing it reads outside the SDK is Hermes' saved keybind overrides (`localStorage`), so the shortcuts card shows your bindings rather than the defaults; the SDK has no reader for them. It makes no network calls of its own and sends no telemetry.

## Install

In Hermes Desktop: **Capabilities → Plugins**, find **Tiled Sessions** in the catalog, or use **Install from Git** with `https://github.com/strnadchristopher/tiled-sessions`.

For development, copy `desktop/plugin.js` and `plugin.yaml` into `~/.hermes/desktop-plugins/tiled-sessions/`; the app hot-reloads it.

## Develop

```sh
npm test         # pure tiling engine: node --test
npm run build    # inline src/engine.mjs into desktop/plugin.js
npm run check    # build is current + syntax check
```

`src/engine.mjs` is the whole layout model (layouts, tile order, split targets, neighbours, equalize, fullscreen, the Master ratio read back from core, search, workspace restore plans) as pure functions, tested without a browser. `src/plugin.src.mjs` maps it onto the SDK.

## License

MIT
