# src/hooks — Tauri Invoke Wrappers and Persistence

## OVERVIEW

Hooks wrap `@tauri-apps/api/core` `invoke()` calls and coordinate frontend stores. They are command wrappers, not event listeners; incoming data is event-routed in `CenterPanel.tsx` and detached windows.

## HOOK INVENTORY

| Hook | Domain | Key invokes / behavior |
|------|--------|------------------------|
| `useBle` | BLE scan/connect/GATT | `start_ble_scan`, `get_ble_devices`, `connect_ble_device`, `get_gatt_services`, read/write/subscribe/unsubscribe |
| `useSerial` | Serial/UART lifecycle | `list_serial_ports`, `open_serial_port`, `close_serial_port` |
| `useTcp` | TCP client/server + UDP lifecycle | `tcp_connect`, disconnect, server start/stop/client disconnect, `udp_bind`, `udp_unbind` |
| `usePersistence` | Full app config | `load_app_config`, `save_app_config`; hydrates/saves channels, per-channel settings, UI/window, terminal layout, protocol, commands, canvases, MCP tools |

## PATTERN

```ts
const action = async (payload: Uint8Array, channelId: string) => {
  try {
    updateChannelState(channelId, 'connecting');
    await invoke('command_name', { data: Array.from(payload) });
    updateChannelState(channelId, 'connected');
  } catch (error) {
    console.error('Error ...:', error);
    updateChannelState(channelId, 'error');
    throw error;
  }
};
```

## PERSISTENCE CONTRACT

- Rust source schema: `src-tauri/src/persistence.rs` `AppConfig`.
- Frontend JSON types: `src/types/persistence.ts`; pure restoration checks: `src/lib/persistenceValidation.ts`; `usePersistence.ts` owns load/save effects and store mapping.
- Terminal restoration rejects invalid ratios, duplicate/dangling pane identities, invalid focus/active tabs and excessively deep trees before calling the store restore action.
- Save is debounced 300ms across 10 stores: channel, UI, protocol, BLE, serial, TCP, terminal, command, canvas, MCP.
- Window state rejects invalid Windows minimized positions (`<-10000`) and collapsed sizes.
- Canvas runtime buffers are not persisted; saved `Canvas[]` restores with empty data buffers and chart paused state.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add command wrapper | Matching `useX.ts` + `index.ts` | Keep command name in sync with `lib.rs generate_handler![]` |
| Add saved field | `usePersistence.ts`, `src-tauri/src/persistence.rs` | Add Rust serde defaults and frontend load/save mapping |
| Add binary send | Domain hook | Convert `Uint8Array` with `Array.from(data)` |
| Add receive behavior | `CenterPanel.tsx` / detached window | Do not put Tauri event listeners here |
| Test hooks | Vitest with mocked `@tauri-apps/api/core` | No global mock currently exists |

## ANTI-PATTERNS

- Do not add event listeners in hooks.
- Do not pass `Uint8Array` directly to `invoke`.
- Do not swallow invoke errors after changing channel state; rethrow for UI/toast callers.
- Do not import hook files directly from components; use the `../hooks` barrel.
- Do not change persistence shape on one side only.
