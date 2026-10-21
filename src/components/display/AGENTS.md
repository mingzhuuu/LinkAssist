# src/components/display — Canvas, Charts, Forms, Scripts

## OVERVIEW

Canvas subsystem for live tables, uPlot charts, send/display forms, and Lua automation scripts. Data enters mostly through `CenterPanel.tsx`, then routes into `canvasStore`, `chartRuntime`, or `scriptRuntime`.

## STRUCTURE

```
display/
├── DisplayPanel.tsx          # canvas plane: create/move/resize/select/activate
├── Canvas.tsx                # per-canvas chrome, z-index, resize handles, borders
├── CanvasEditDialog.tsx      # large editor for table/chart/form/script configs (~2.2k)
├── CanvasTable.tsx           # row buffer renderer, formulas, frozen header
├── CanvasChart.tsx           # uPlot renderer, tooltips, zoom/selection, toolbar
├── CanvasForm.tsx            # display/send form rows
├── CanvasScript.tsx          # script canvas controls and runtime snapshot UI
├── ContextMenu.tsx           # right-click context menu for canvases
├── useCanvasInteraction.ts   # drag-create/move/resize/snap state machine
├── chartRuntime.ts           # per-canvas chart buffers + subscriptions
├── chartDataUtils.ts         # numeric extraction from raw/parsed data for charts
├── formulaUtils.ts           # formula variable generation and safe JS eval
├── canvasDataUtils.ts        # raw/parsed bytes -> table/form rows
├── scriptRuntime.ts          # Lua-backed automation engine; Tauri invokes + waits + reports
├── scriptLua.ts              # Lua parser bridge for script docs
├── scriptTypes.ts            # script step/report/runtime types
└── adapters/                 # uPlot option builders: line/bar/scatter + theme
```

## DATA FLOW

| Source | Path | Notes |
|--------|------|-------|
| Serial/TCP/UDP/BLE events | `CenterPanel.tsx` → `pushDataToCanvases()` | Always pushes to canvases even when terminal receive display is hidden |
| Table/form rows | `buildCanvasRow()` → `useCanvasStore.pushRow()` | Buffers capped by `MAX_BUFFER_ROWS = 500` in `canvasStore.ts` |
| Charts | `ingestPacket()` → `chartRuntime` → `CanvasChart` | Parsed mode can call `parse_data_with_lua_file` per packet |
| Scripts | `ingestScriptPacket()` → `scriptRuntime` waits | Script canvases can open/send/wait/report using Tauri invokes |

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add renderer type | `src/types/canvas.ts`, `CanvasEditDialog.tsx`, `DisplayPanel.tsx`, `index.ts` | Add config type, editor UI, render branch, barrel export |
| Change drag/snap | `useCanvasInteraction.ts`, `DisplayPanel.tsx` | Commit rects only through `useCanvasStore.setCanvasRect()` |
| Change chart behavior | `CanvasChart.tsx`, `chartRuntime.ts`, `adapters/` | Keep runtime disposal in `canvasStore.removeCanvas()` |
| Change script Lua | `scriptTypes.ts`, `scriptLua.ts`, `scriptRuntime.ts`, `config/script/script-configuration-guide.md` | Update examples when changing schema |
| Change table/form decoding | `canvasDataUtils.ts`, `src/types/canvas.ts` | Raw extractors and parsed-field extractors share config types |
| Change channel readiness | `DisplayPanel.tsx` | Reconnect logic reads serial/tcp/ble store configs |

## CONVENTIONS

- Public display exports go through `display/index.ts`.
- Canvas schema source is `src/types/canvas.ts`; persisted layout stores full `Canvas[]` via `usePersistence.ts`.
- `useCanvasStore.removeCanvas()` must dispose chart and script runtimes. Do not bypass it.
- Formulas execute user-provided expressions; keep formula scope tiny and do not add ambient app objects.
- Script runtime supports `serial`, `tcp-client`, `udp`, and `ble` channel aliases. BLE waits are driven by `ble-notification-received`.
- Use Tailwind tokens (`surface-*`, `accent-*`, `text-*`, `border-*`) and existing button classes.

## ANTI-PATTERNS

- Do not mutate `canvas.config` directly; use `updateCanvasConfig()`.
- Do not add renderer-only fields outside `CanvasConfig`; persistence serializes `Canvas[]` as-is.
- Do not forget parsed-mode paths: tables, forms, and charts may use `protocolFile` links.
- Do not leave timers/subscribers in runtimes without a matching `dispose()` path.
- Do not move incoming-data listeners from `CenterPanel.tsx` into display components.
