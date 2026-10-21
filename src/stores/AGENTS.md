# src/stores — Zustand Domain Stores

## OVERVIEW

Zustand stores hold frontend state. Pattern is plain `create<Store>((set) => ({ ... }))`; no `persist`, `devtools`, or cross-store imports. Composition happens in hooks/components.

## FILES

| File | Hook | Role |
|------|------|------|
| `terminalStore.ts` | `useTerminalStore` | Recursive pane tree, tabs, entries, DnD, snapshots for persistence |
| `commandStore.ts` | `useCommandStore` | Saved commands by `tagId`, nested groups, config slots, import/export snapshots |
| `canvasStore.ts` | `useCanvasStore` | Canvas CRUD, z-index/rects, data buffers, chart paused state, runtime disposal |
| `bleStore.ts` | `useBleStore` | Scan state, devices, GATT, channel BLE filters, subscriptions, last device IDs |
| `uiStore.ts` | `useUIStore` | Panel widths, visibility, theme, send format, display flags, quick-open IDs |
| `protocolStore.ts` | `useProtocolStore` | Persisted parser mode, fields, Lua script, linked channel/service/char |
| `tcpStore.ts` | `useTcpStore` | TCP mode, client/server/UDP state, connection-to-channel map, channel configs |
| `channelStore.ts` | `useChannelStore` | Channel CRUD and active channel |
| `serialStore.ts` | `useSerialStore` | Port list, open connections, connection map, per-channel serial configs |
| `toastStore.ts` | `useToastStore` | Toast queue plus external `toast.*` helper |
| `mcpStore.ts` | `useMcpStore` | MCP tool script configs: luaPath, exposeToMcp, CRUD |
## INVARIANTS

- `terminalStore.getLayoutSnapshot()` / `restoreLayoutSnapshot()` are the persistence boundary for panes.
- `commandStore.getSnapshot()` / `restoreSnapshot()` are the persistence boundary for saved commands.
- `canvasStore.removeCanvas()` disposes chart/script runtimes; do not remove canvases by array filtering elsewhere.
- Per-channel configs live in domain stores keyed by channel ID: serial, TCP, BLE filters/last devices.
- `toast` helper uses `useToastStore.getState()` and can be used outside React components.

## TESTING

- Existing Vitest tests live in `src/__tests__/stores.test.ts` and reset stores with `store.setState(...)` in `beforeEach`.
- If adding store methods, update tests with explicit initial state reset; do not depend on previous test state.

## CONVENTIONS

- Export every store from `stores/index.ts`; components should import from `../stores`.
- Store file name: `<domain>Store.ts`; hook name: `use<Domain>Store`.
- Keep stores independent. If one domain needs another domain’s state, read both in a hook/component.
- Prefer actions over direct `setState` outside tests and persistence/runtime rehydration boundaries.

## ANTI-PATTERNS

- Do not add middleware (`persist`, `devtools`, `immer`).
- Do not import stores from each other.
- Do not add side-effectful Tauri invokes inside stores; hooks/components own IPC.
- Do not bypass canvas/runtime disposal or terminal snapshot helpers.
