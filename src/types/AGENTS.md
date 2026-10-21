# src/types — Frontend IPC Mirrors

## OVERVIEW

TypeScript type layer for Tauri IPC and canvas configs. Rust serde output is authoritative for backend data; this directory must mirror JSON shapes exactly or provide an explicit mapping layer.

## FILE MAP

| TS file | Rust/source counterpart | Notes |
|---------|-------------------------|-------|
| `protocol.ts` | `src-tauri/src/protocol/types.rs` | Parser modes, `FieldType`, `FieldDefinition`, `ParseResult`, protocol-file summaries |
| `channel.ts` | `src-tauri/src/channel.rs`, frontend `channelStore.ts` | TS uses `type`/`createdAt`; watch Rust `channel_type`/`created_at` serialization |
| `serial.ts` | `src-tauri/src/serial/port.rs` | `PortInfo` uses camelCase; flow-control token set must match UI/backend |
| `ble.ts` | `src-tauri/src/ble/scanner.rs`, `ble/gatt.rs` | `manufacturerData` numeric keys arrive as strings; RSSI may be absent/null |
| `tcp.ts` | `src-tauri/src/tcp/*.rs`, `commands/tcp.rs` | Several connection objects are command-built, not a single Rust DTO |
| `canvas.ts` | `src/components/display/*`, `src/stores/canvasStore.ts` | Frontend-only persisted canvas schema |
| `mcp.ts` | `src-tauri/src/mcp_tools.rs`, `mcp_tool_script.rs` | `McpToolScript`, `McpToolsConfig`, `McpToolMetaPreview`; frontend-only persistence shapes |
| `canvasMigration.ts` | `src/types/canvas.ts` | Legacy chart format migration (endian, extractor shape) |
| `index.ts` | all TS type files | Canonical barrel export |
| `events.ts` | Rust transport emitters, `channel_activity.rs`, frontend detach events | Event-name-to-payload map shared by both receive routers |
| `persistence.ts` | `src-tauri/src/persistence.rs` | Existing persisted JSON names; type-only reuse of store snapshot shapes |

## SYNC RULES

- Rust structs sent over Tauri should use explicit serde naming. Prefer stable JSON keys over Rust field names.
- If Rust uses `#[serde(rename_all = "camelCase")]`, TS must use camelCase. If Rust keeps snake_case, TS must keep snake_case.
- Bytes are `Vec<u8>` in Rust and `number[]` in TS. Convert `Uint8Array` to arrays before invoke.
- Untagged Rust enums (notably `FieldValue`) must stay representable by TS unions.
- Numeric map keys in Rust JSON become string keys in JavaScript (`Record<string, ...>`).
- Every new backend IPC field needs: Rust serde/default decision, TS type update, hook/store mapping update, persistence migration if saved.

## KNOWN GOTCHAS

- `ChannelInfo` vs `Channel`: Rust has `channel_type` and `created_at`; frontend code expects `type` and `createdAt`. If a backend channel-list command is added, add serde renames or a DTO before exposing it.
- Serial `flowControl` tokens must be normalized; avoid mixing backend strings like `hardware/software` with UI tokens like `rts_cts/xon_xoff` without mapping.
- BLE `rssi` can be missing and backend may include `isConnected`; keep TS optional fields permissive when consuming discovered devices.
- Protocol types intentionally mix snake_case (`field_type`, `raw_bytes`) and camelCase protocol-file summaries (`filePath`, `fieldType`). Do not “clean up” one side only.

## CHANGE CHECKLIST

1. Locate Rust source/command that serializes the value.
2. Confirm actual JSON key names and enum strings.
3. Update TS type here and all stores/hooks/components that consume it.
4. Add `#[serde(default)]` for newly persisted Rust fields.
5. Run `npm run build`; run `npm run test` when store/type behavior changes.

## ANTI-PATTERNS

- Do not add `as any` to work around IPC shape drift.
- Do not infer TS field names from Rust field names when serde attributes exist.
- Do not import individual type files from app code when `../types` barrel works.
