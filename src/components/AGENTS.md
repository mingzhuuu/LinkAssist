# src/components — Frontend UI Domains

## OVERVIEW

React 19 UI split by feature domain. `layout/` owns the shell/event router/terminal system; `display/` owns canvases, charts, forms, and automation scripts.

## STRUCTURE

```
components/
├── layout/     # frameless shell, event routing, terminals; see layout/AGENTS.md
├── display/    # canvas/table/chart/form/script subsystem; see display/AGENTS.md
├── channels/   # BLE, UART(serial), TCP/UDP config panels
├── parser/     # BLE GATT explorer
└── common/     # ErrorBoundary, icons, selects, toasts
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| App shell / panels | `layout/MainLayout.tsx`, `TitleBar.tsx`, `LeftPanel.tsx`, `CenterPanel.tsx`, `RightPanel.tsx` | Frameless 3-panel layout |
| Incoming data routing | `layout/CenterPanel.tsx` | Tauri listeners, terminal entries, display runtimes |
| Terminal panes | `layout/PaneTreeRenderer.tsx`, `TerminalLeafPane.tsx`, `src/stores/terminalStore.ts` | Recursive split tree and per-tab entries |
| Detached terminal windows | `layout/DetachedTerminalWindow.tsx`, `src/lib/detachWindow.ts`, `App.tsx` | `index.html?detached=...`, `detach-init`, `reattach-tab` |
| Canvas renderers | `display/` | Add type/editor/render/store behavior together |
| Channel config UI | `channels/ble`, `channels/uart`, `channels/tcp` | UI says `uart`; stores/hooks/backend say `serial` |
| Protocol consumers | `display/`, `parser/GattExplorer.tsx` | Canvas/form/chart paths invoke protocol-file parsing directly |
| Shared UI | `common/` | `ErrorBoundary`, `Icons`, `RoundedSelect`, `ToastContainer` |

## CONVENTIONS

- Use component folder barrels where present (`layout/index.ts`, `display/index.ts`, channel subfolder `index.ts`).
- Use Tailwind project tokens and existing component classes; avoid arbitrary color drift.
- UI components consume Zustand stores and hooks; stores do not import components except known runtime-disposal coupling in `canvasStore.ts`.
- Tauri event listeners belong in `CenterPanel.tsx` or detached-window routing, not hooks.
- Interactive controls inside draggable titlebar regions must be no-drag.

## LARGE/HOT FILES

- `display/CanvasEditDialog.tsx` (~2.2k): editor for table/chart/form/script configs.
- `layout/TerminalLeafPane.tsx` (~1k): tabbed terminal leaf with commands, DnD, send paths.
- `layout/SavedCommandsPanel.tsx` (~827): command groups/config slots/import-export.
- `display/scriptRuntime.ts` (~1k): Lua automation engine.
- `layout/SettingsDialog.tsx` (~1k): theme, MCP tools, layout presets, channel management.
- `layout/CenterPanel.tsx`, `display/DisplayPanel.tsx`, `display/CanvasChart.tsx` are also high-risk edit zones.

## ANTI-PATTERNS

- Do not put receive listeners into hooks.
- Do not add a new display renderer without updating `src/types/canvas.ts`, editor UI, render switch, and exports.
- Do not normalize `uart`/`serial` names casually; it is cross-layer legacy friction.
- Do not bypass `ErrorBoundary` patterns around complex panes/renderers.
