# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-05
**Commit:** 9ce6e37
**Branch:** main

**Architecture review:** 2026-10-19. Maintained feature/architecture docs live in `docs/`; run `npm run docs:generate` after interface or owned-file changes and `npm run check:architecture` to detect drift.

## OVERVIEW

LinkAssist is a Tauri v2 desktop app for BLE, UART/serial, TCP server/client, UDP, protocol parsing, real-time canvases, automation scripts, detachable terminal panes, and MCP-accessible local tooling. Frontend: React 19 + TypeScript + Zustand + Tailwind + uPlot. Backend: Rust/Tauri + Tokio + btleplug + tokio-serial + mlua + Axum core HTTP.

## STRUCTURE

```
LinkAssist/
├── src/                         # React/TS frontend
│   ├── components/              # UI domains; see src/components/AGENTS.md
│   │   ├── layout/              # app shell, terminal panes, event router; see layout/AGENTS.md
│   │   └── display/             # canvas/table/chart/form/script subsystem; see display/AGENTS.md
│   ├── hooks/                   # Tauri invoke wrappers + persistence; see src/hooks/AGENTS.md
│   ├── stores/                  # Zustand domain stores; see src/stores/AGENTS.md
│   ├── types/                   # TS IPC mirrors; see src/types/AGENTS.md
│   └── lib/                     # detachWindow, BLE constants, channel/test-runner helpers
├── src-tauri/                   # Rust/Tauri backend
│   ├── src/                     # managers, commands, MCP/core; see src-tauri/src/AGENTS.md
│   ├── capabilities/            # Tauri capability config
│   └── gen/schemas/             # generated Tauri schemas; reference only
├── config/                      # local config/examples grouped by domain
│   ├── layout/                  # layout presets
│   ├── mcp/                     # MCP docs and Lua tool examples; see config/mcp/mcp-tool-lua-guide.md
│   ├── protocol/                # protocol docs and Lua parser examples
│   └── script/                  # automation script docs/examples; see config/script/script-configuration-guide.md
├── registries/                  # Web Bluetooth registry validator/data; see registries/AGENTS.md
└── bluetooth-numbers-database/  # vendored Nordic BLE assigned-number JSON data
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Frontend boot / detached routing | `index.html`, `src/main.tsx`, `src/App.tsx` | `App.tsx` switches on `?detached=`; `usePersistence()` only runs in main window |
| Add/modify channel type | `src/types/`, `src/stores/`, `src/hooks/`, `src/components/channels/`, `src-tauri/src/commands/`, Rust manager | Mirror TS/Rust types and register commands in `lib.rs` |
| Incoming data flow | `src/components/layout/CenterPanel.tsx` | Main event router: feeds terminal entries, charts, tables, forms, scripts |
| Shared receive contract / cleanup | `src/types/events.ts`, `src/components/layout/eventSubscriptions.ts` | Main/detached routing share payload types and an asynchronous subscription scope |
| Terminal panes / detached windows | `src/components/layout/`, `src/stores/terminalStore.ts`, `src/lib/detachWindow.ts` | Events: `detach-init`, `reattach-tab` |
| Canvas/table/chart/form/script | `src/components/display/`, `src/types/canvas.ts`, `src/stores/canvasStore.ts` | New renderer requires type, store, editor, render switch, barrel export |
| Protocol parsing | `src-tauri/src/protocol/`, `src/types/protocol.ts`, `src/components/display/`, `src/components/parser/GattExplorer.tsx` | Rust and TS protocol types must stay synchronized |
| Tauri command add/change | `src-tauri/src/commands/*.rs` + `src-tauri/src/lib.rs` | `generate_handler![]` is the command registry |
| MCP / headless core | `src-tauri/src/mcp_bridge.rs`, `mcp_tools.rs`, `core_http.rs`, `discovery.rs`, `main.rs` | CLI flags: `--mcp-bridge`, `--core-headless` |
| Persistence schema | `src-tauri/src/persistence.rs`, `src/hooks/usePersistence.ts` | Rust `AppConfig` plus frontend store mapping; use `#[serde(default)]` for migrations |
| Persistence types / validation | `src/types/persistence.ts`, `src/lib/persistenceValidation.ts` | JSON contract and pure restoration checks; hook retains orchestration |
| External tests / portable snapshots | `src-tauri/src/test_runner.rs`, `src-tauri/src/snapshot.rs` | Test UI lives in Script Canvas; snapshot is a CLI entry |
| BLE assigned numbers | `src/lib/bleConstants.ts`, `registries/`, `bluetooth-numbers-database/v1/` | `bleConstants.ts` is generated/curated app lookup table |
| Tests | `src/__tests__/`, `vitest.config.ts`, `src-tauri/src/**` | Vitest covers stores/types/helpers/hooks/components; Rust lib tests cover protocol/Core/config/snapshots; external project cases are ignored by default |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `App` | React function | `src/App.tsx` | Main/detached window switch, theme sync, reattach listener |
| `MainLayout` | React component | `src/components/layout/MainLayout.tsx` | Frameless 3-panel shell |
| `CenterPanel` | React component | `src/components/layout/CenterPanel.tsx` | Tauri event router and channel config area |
| `DisplayPanel` | React component | `src/components/display/DisplayPanel.tsx` | Canvas plane and interaction coordinator |
| `usePersistence` | Hook | `src/hooks/usePersistence.ts` | Debounced config save/load across 10 stores |
| `AppState` | Rust struct | `src-tauri/src/lib.rs` | Shared managers injected into Tauri commands and core HTTP |
| `run_mcp_bridge` | Rust fn | `src-tauri/src/lib.rs` | Starts JSON-RPC stdio bridge |
| `ProtocolManager` | Rust struct | `src-tauri/src/protocol/mod.rs` | Parser dispatch and Lua/template helpers |

## CONVENTIONS

- **ESM-first**: `package.json` has `"type": "module"`; use ES imports/exports.
- **Strict TS**: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`; `npm run build` runs `tsc` then `vite build`.
- **No path aliases**: use relative imports. Barrels are canonical: `../stores`, `../hooks`, `../types`, `../lib`, component folder indexes.
- **Tailwind tokens only**: prefer `surface-*`, `accent-*`, `text-*`, `border-*`, `road`; dark mode via class on `<html>`.
- **Tauri dev port coupling**: Vite port `1420`, HMR `1421`, `tauri.conf.json` `devUrl` must match.
- **Frameless window**: `decorations: false`; draggable zones use `data-tauri-drag-region`; controls must be no-drag.
- **Hooks wrap invokes**: convert `Uint8Array` to `Array.from(data)`, update channel state, catch/log/rethrow.
- **Receive is event-driven**: backend emits Tauri events; frontend routes in `CenterPanel.tsx`. Poll commands are compatibility only.
- **Rust managers**: `AppState` owns per-domain managers, usually `Arc<Mutex<...>>`; commands return `Result<T, AppError>`.
- **Type mirroring**: TS files in `src/types/` must mirror Rust serde output, not Rust field names in isolation.
- **Persistence migrations**: add Rust `#[serde(default)]` for new saved fields and update `usePersistence.ts` load/save mapping.
- **Script Canvas changes are script-first**: when implementing a Script Canvas requirement, limit changes to generating or modifying the script content whenever the capabilities currently exposed to scripts are sufficient. If those capabilities are insufficient, stop before changing application source, explain the missing capability and proposed source-level change, and obtain the user's explicit approval; modify source code only after that approval. Any approved source-level extension must be designed as a reusable, business- and protocol-neutral capability whenever practical; avoid application code tailored only to one script or one specific feature request.

## EVENTS

| Event | Emitters | Main listeners |
|-------|----------|----------------|
| `serial-data-received` | `src-tauri/src/serial/io.rs` | `CenterPanel.tsx`, `DetachedTerminalWindow.tsx`, script runtime ingestion |
| `serial-connection-closed/error` | `serial/io.rs` | `CenterPanel.tsx` |
| `tcp-data-received` | `tcp/client.rs`, `tcp/server.rs` | `CenterPanel.tsx`, detached windows |
| `tcp-client-connected/disconnected` | `tcp/server.rs` | `CenterPanel.tsx` |
| `tcp-connection-closed/error` | `tcp/client.rs`, `tcp/server.rs` | `CenterPanel.tsx` |
| `udp-data-received` | `tcp/udp.rs` | `CenterPanel.tsx`, detached windows |
| `ble-notification-received` | `commands/ble.rs`, `mcp_tools.rs` | `CenterPanel.tsx`, detached windows |
| `ble-connection-closed` | `commands/ble.rs`, `mcp_tools.rs` | `CenterPanel.tsx` |
| `detach-init` | `src/lib/detachWindow.ts` | `DetachedTerminalWindow.tsx` |
| `reattach-tab` | `DetachedTerminalWindow.tsx` | `App.tsx` |

## COMMANDS

```bash
npm run dev                 # Vite dev server on 1420
npm run tauri dev           # Full desktop dev
npm run build               # Type-check + frontend bundle
npm run tauri build         # Native package
npm run test                # Vitest run
npm run test:watch          # Vitest watch
npm run docs:generate       # Refresh generated interface/file reference
npm run check:architecture  # Static IPC/store/doc boundary checks
npm run check               # Architecture check + frontend build + Vitest
cd src-tauri && cargo test  # Rust tests
cd registries && cargo test # Registry validator tests
```

## ANTI-PATTERNS (THIS PROJECT)

- No `as any`, `@ts-ignore`, or unexplained `@ts-expect-error`. Existing `vite.config.ts` exception is documented.
- No store middleware (`persist`, `devtools`, `immer`); persistence is manual via `usePersistence`.
- Do not import one Zustand store from another; compose in hooks/components.
- Do not add event listeners in hooks; event receive belongs in `CenterPanel.tsx` / detached-window routing.
- Do not add Tauri commands without adding them to `src-tauri/src/lib.rs` `generate_handler![]`.
- Do not re-enable Lua `os`, `io`, `require`, `dofile`, `loadfile` globals.
- Do not change `FieldValue` serde shape without updating TS and parser consumers.
- Do not scan/document `node_modules`, `dist`, `src-tauri/target`, `registries/target`, `bluetooth-numbers-database/node_modules`.
- `uart` vs `serial` naming mismatch is intentional legacy friction: UI folder is `channels/uart`; hooks/stores/types/backend use `serial`.

## NOTES

- Root `.gitignore` ignores `node_modules`, `dist`, `target/`, local backups and PDFs. Knowledge generation must still explicitly exclude dependency/build trees and vendored datasets.
- Root `.github/workflows/ci.yml` checks Windows frontend/native integration, dependency audit and secret scanning. Tag releases create Windows preview drafts.
- Vitest has `setupFiles: []`; no global Tauri API mocks. Hook/component tests need explicit mocks.
- MCP bridge uses the compiled binary with `--mcp-bridge`; it spawns/uses a headless core (`--core-headless`) via discovery file + local token-auth HTTP.
- `bluetooth-numbers-database/` and `registries/` are upstream/curated data sources; document update rules, not every data row.
- Lua files use `-- linkassist:type = <kind>` markers (mcp, protocol, script) validated by `script_markers.rs`.
