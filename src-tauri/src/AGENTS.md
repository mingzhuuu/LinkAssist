# src-tauri/src — Rust Backend, Core HTTP, MCP Bridge

## OVERVIEW

Tauri v2 backend for BLE, serial, TCP/UDP, protocol parsing, persistence, MCP tools, and a local token-auth Core HTTP service. `lib.rs` is the command registry and app-state builder; `main.rs` adds CLI modes.

## STRUCTURE

```
src/
├── main.rs          # binary entry: --mcp-bridge, --core-headless, existing-core signal, run UI
├── lib.rs           # AppState, Tauri builder, plugins, generate_handler![], core HTTP spawn
├── error.rs         # AppError -> string serialization for Tauri IPC
├── channel.rs       # ChannelManager; Rust channel types/states
├── persistence.rs   # AppConfig schema + app_data_dir config.json read/write
├── commands/        # Tauri invoke handlers by domain (ble, serial, tcp, protocol, mcp, persistence, script)
├── ble/             # btleplug scanner, connections, GATT helpers
├── serial/          # tokio-serial manager; emits serial events
├── tcp/             # TCP client/server + UDP managers; emits network events
├── protocol/        # parser engine; see protocol/AGENTS.md
├── mcp_tools.rs     # MCP tool definitions + dispatcher over AppState managers
├── mcp_tool_script.rs  # Lua-backed MCP tool execution, session state, invoke_tool bridge
├── mcp_bridge.rs    # JSON-RPC stdio bridge for MCP clients
├── core_http.rs     # localhost token-auth control/tool HTTP API
├── discovery.rs     # core-discovery file, health checks, headless core spawn
├── recent_events.rs # circular buffer for recent core events (used by core HTTP)
└── script_markers.rs  # Lua file type markers (-- linkassist:type = mcp|protocol|script)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add Tauri command | `commands/<domain>.rs`, `lib.rs` | Add `#[tauri::command]` and register in `generate_handler![]` |
| Add MCP tool | `mcp_tools.rs` | Update `tool_definitions()` and `call_tool()`; covers stdio and HTTP transports |
| Change core HTTP | `core_http.rs`, `discovery.rs` | Endpoints: `/health`, `/ui/show`, `/core/shutdown`, `/mcp/tools/{name}/call` |
| Change CLI modes | `main.rs`, `lib.rs` | `--mcp-bridge`, `--core-headless`, existing core UI signal |
| Change protocol parsing | `protocol/` | Keep Rust/TS types in sync |
| Change persistence | `persistence.rs`, `commands/persistence.rs`, frontend `usePersistence.ts` | Add `#[serde(default)]` for migrations |
| Change events | domain managers and `CenterPanel.tsx` | Event strings are manually coupled |

## COMMAND REGISTRY

`lib.rs` `generate_handler![]` registers BLE, serial, TCP/UDP, protocol, and persistence commands. Frontend hooks and MCP tools use the same command names where possible. Compatibility receive commands exist (`tcp_receive`, `tcp_server_receive`, `udp_receive`, serial `receive_serial_data`), but live data is event-pushed.

## MCP / CORE FLOW

- `LinkAssist.exe --mcp-bridge` runs `mcp_bridge::run_stdio_bridge()`.
- Bridge supports JSON-RPC methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
- First tool call ensures a Core exists via `discovery::ensure_core_running()`; this can spawn current exe with `--core-headless`.
- Headless/UI core starts Tauri hidden or visible, then spawns `core_http::serve_core_http()`.
- Core binds `127.0.0.1:0`, writes `LinkAssist/core-discovery.json` containing PID, port, token, mode, timestamp.
- HTTP calls require `Authorization: Bearer <token>`.
- Tool HTTP endpoint forwards to `mcp_tools::call_tool(state, app_handle, name, arguments)`.

## EVENTS

| Event | Emitter |
|-------|---------|
| `serial-data-received`, `serial-connection-closed`, `serial-connection-error` | `serial/io.rs` |
| `tcp-data-received`, `tcp-connection-closed`, `tcp-connection-error` | `tcp/client.rs`, `tcp/server.rs` |
| `tcp-client-connected`, `tcp-client-disconnected` | `tcp/server.rs` |
| `udp-data-received` | `tcp/udp.rs` |
| `ble-notification-received`, `ble-connection-closed` | `commands/ble.rs`, `mcp_tools.rs` |

Frontend main listeners live in `src/components/layout/CenterPanel.tsx`; detached terminal listeners live in `DetachedTerminalWindow.tsx`.

## CONVENTIONS

- Configuration saves use an exclusively created, unique sibling temporary file and replace the target after flushing. Do not restore a shared `config.json.tmp` path; concurrent UI/MCP writes must not share temporary contents. Full configurations remain last-completed-write-wins.
- `test_runner.rs` owns external pytest bridge execution; `snapshot.rs` owns portable EXE configuration/resource packaging. Neither requires changing the transport managers for project-specific business logic.

- `AppState` owns managers and is cloned into Core HTTP state; keep manager fields cheap/clonable (`Arc<Mutex<...>>` where needed).
- Commands return `Result<T, AppError>` unless Tauri plugin/file helper already returns `Result<T, String>`.
- `AppError` serializes as a string; structured errors require frontend changes.
- IPC structs should have explicit serde naming. TS mirrors JSON output, not Rust spelling.
- Long-running I/O should spawn tasks and emit events, not block command handlers.
- Discovery file/token grants local tool access; treat path and token as sensitive local IPC plumbing.

## ANTI-PATTERNS

- Do not add a command without registering it in `lib.rs`.
- Do not add MCP tool definitions without implementing the matching `call_tool()` branch.
- Do not reintroduce blocking reads in commands where event loops already exist.
- Do not change event names without updating frontend listeners and docs.
- Do not use `unwrap()`/`expect()` in command handlers; return `AppError`.
- Do not expose Core HTTP without bearer-token authorization.
