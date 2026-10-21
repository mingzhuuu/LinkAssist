# src/components/layout — Shell, Event Router, Terminal Panes

## OVERVIEW

Frameless Tauri app shell with resizable panels, a recursive terminal split tree, detachable terminal windows, saved commands, and the main frontend event router.

## FILES

| File | Role |
|------|------|
| `MainLayout.tsx` | Root shell: `TitleBar`, left/center/right panels, resize handles |
| `TitleBar.tsx` | Frameless window controls, drag region, quick controls |
| `LeftPanel.tsx` | Channel list/sidebar and channel actions |
| `CenterPanel.tsx` | Active channel config panel + bottom terminal panes + all incoming data listeners |
| `RightPanel.tsx` | Protocol config/editor/results panel |
| `TerminalLeafPane.tsx` | Terminal leaf: tabs, RX/TX/system entries, command input, detach/send flows |
| `PaneTreeRenderer.tsx` | Recursive leaf/split renderer |
| `SavedCommandsPanel.tsx` | Per-pane saved command sidebar, groups, drag reorder, import/export |
| `SavedCommandsDialog.tsx` | Save/load/export named command configurations |
| `DetachedTerminalWindow.tsx` | Pop-out terminal window and reattach flow |
| `terminalUtils.ts` | Timestamp/hex/input/BLE UUID helpers |
| `eventSubscriptions.ts` | Per-effect typed receive subscriptions: late registration cleanup, callback guards, rejection reporting, idempotent disposal |
| `ResizeHandle.tsx` | Drag resizer for left/right panels |

## EVENT ROUTER

`CenterPanel.tsx` owns the main Tauri listeners:

Main and detached receive routes use `src/types/events.ts` and `createEventSubscriptions()`. Keep subscription creation in the window routing components; the helper owns cleanup, not store/routing decisions.

- `serial-data-received`, `serial-connection-closed`
- `tcp-data-received`, `tcp-client-connected`, `tcp-client-disconnected`, `tcp-connection-closed`
- `udp-data-received`
- `ble-notification-received`, `ble-connection-closed`
- `serial-connection-error`, `tcp-connection-error`, `channel-activity`, `detached-terminal-entry`

For incoming bytes it may:
1. Push rows to `canvasStore` for table/form canvases.
2. Call `chartRuntime.ingestPacket()` for charts.
3. Call `scriptRuntime.ingestScriptPacket()` for script waits.
4. Append terminal entries when `showReceived` is enabled.

## DETACHED WINDOW FLOW

1. `detachTabToWindow()` opens `index.html?detached=<label>` with `WebviewWindow`.
2. Parent emits `detach-init` to the new label.
3. `App.tsx` detects `?detached=` and renders `DetachedTerminalWindow` instead of `MainLayout`.
4. Detached window listens to incoming data events for its tab and emits `reattach-tab` to `main` when docked.
5. `App.tsx` re-adds the tab to the focused pane and restores its entries.

## TERMINAL MODEL

- `useTerminalStore.root` is a recursive `PaneNode` split/leaf tree.
- Leaf panes own tabs, active tab, shared/current entries, and per-tab `tabEntries`.
- Tab DnD uses MIME `application/x-terminal-tab` plus `text/plain` fallback.
- Drop zones: `left | right | top | bottom | center`; center merges into leaf, directional drops create splits.

## CONVENTIONS

- Panel widths/visibility live in `useUIStore`; pane tree lives in `useTerminalStore`.
- Channel accent colors: BLE=blue, serial=mauve/purple, TCP/UDP=green.
- Interactive controls in drag regions must be no-drag.
- Event listener cleanup must handle both already-cancelled promises and returned `UnlistenFn`s.
- `PanelErrorBoundary`/`ErrorBoundary` wraps high-risk panel content.

## ANTI-PATTERNS

- Do not duplicate incoming data listeners in hooks or random components.
- Do not append terminal entries without respecting active tab/channel routing.
- Do not break detached URL/query-param routing; no React Router is used.
- Do not change event names without updating Rust emitters, `CenterPanel`, and detached windows.
