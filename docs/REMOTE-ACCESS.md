# Remote access

## 中文快速开始

两台电脑均运行新版 LinkAssist。在被控端打开设置 **Advanced → Remote**，开启 **Allow remote**。配对码会自动生成，旁边显示剩余时间。可使用配对码下一行的复制、刷新图标，再下一行的 **Persistent** 按钮生成跨重启保留的配对码。

在控制端的 **Connect** 栏粘贴配对码并点击输入框后的 **Connect**。当前连接、最近设备和已授权设备均显示在此栏。默认由被控端点击 **Allow and pair** 批准新设备。被控端开启 **Connect without local approval** 后，新设备凭有效配对码直接建立连接。请只把有效配对码提供给允许控制设备的人。

控制端在主窗口显示被控端的工作区。新建通道、通道配置卡片、终端命令与画布均沿用本地的界面和操作入口。通道配置、保存命令、画布新建/编辑/分组/删除，以及面板和终端布局的改动会同步并保存在被控端。脚本与协议文件的 Browse 浏览被控电脑的目录。断开后恢复控制端自己的工作区。被控端每次启动后需重新允许远程连接。需要继续接受连接时，关闭窗口可选择 **Keep in background**。

## Overview

LinkAssist embeds iroh in its Rust backend. Run LinkAssist on both computers; no separate tunnel executable, account service, or self-hosted server is required. Connections use iroh's official discovery/relay infrastructure and upgrade to direct QUIC where possible. Public relays are shared, rate-limited infrastructure without an uptime guarantee.

## Pair and connect

1. On the device computer, open **Settings → Advanced → Remote** below MCP and enable **Allow remote**.
2. Copy the automatically generated 68-character pairing code. It expires in five minutes and is single-use by default. **Persistent** generates a reusable code that survives application restarts. **Refresh** replaces the current code.
3. In the other LinkAssist, paste the invitation into **Connect** and connect.
4. By default, the host asks the user to approve the requesting device. **Allow and pair** trusts its key for future connections. With **Connect without local approval** enabled, a valid code pairs a new device immediately.
5. The controller’s main window displays the host workspace. Disconnecting restores the controller’s previous workspace.

Use **Reconnect** for a trusted host. **Take back control** disables incoming access. **Revoke** disconnects and forgets the selected controller and invalidates the current code. Each host accepts one controller at a time. A controller must disconnect its local channels and turn off incoming remote control before switching to another host.

Incoming access starts off after each application restart. The first main-window close asks whether to exit or hide in the system tray and remembers the choice. If the saved choice is exit and incoming remote access is enabled, closing asks again whether to keep LinkAssist running in the tray. This choice applies only to that close.

## Supported workspace operations

| Area | Remote capabilities |
|---|---|
| Channels | Create UART/BLE/TCP channels; edit UART and TCP/UDP parameters; rename/remove disconnected channels; connect/disconnect |
| UART | Enumerate host ports; configure serial parameters; send HEX/text; view receive and transmit history |
| TCP/UDP | Connect/listen/bind on the host; select an owned server client or UDP destination; send and receive |
| BLE | Scan on the host; select/connect a device; select a characteristic; read/write/subscribe/unsubscribe |
| Workspace layout | Change panel widths and visibility, theme, terminal splits and tabs, canvas geometry, and channel-card preview/pinning. The host saves accepted edits. |
| Canvases | Create/edit/delete/group using the normal canvas menu and editor; move/resize/maximize; activate/deactivate; use the shared table, plot, form and script controls |
| Form canvases | View values; edit send fields and execute the existing encoding/send path on the host |
| Script canvases | Render the configured controls, state and results; run/stop/reload; invoke configured handlers on the host |

The controller reuses the local channel panels, terminal, canvas editor and renderers. Configuration changes auto-save through a revision-checked workspace transaction; connect waits for pending edits. Saved command sets and configurations are synchronized. Script/form controls need their canvas mounted in the host UI. Browse uses a remote directory picker; Lua previews are parsed on the host. These paths always refer to the **host**, not the controller. Remote script startup acknowledges that the host accepted the operation; watch its state/results for completion. Disconnecting does not stop an already-started script.

The remote workspace is a bounded live view, not a lossless data recorder: snapshots are coalesced at up to 5 Hz, with deduplicated terminal entries and per-tab membership. Full byte packets are preserved; a newest-entry budget of 800 KB bounds terminal history, and a shared 600 KB budget bounds table/chart frames by dropping older rows or plotted samples when needed. A tab cleared on the host stays cleared on the controller. Host receive-display settings affect the terminal history. Larger datasets and long-running records should use the host's normal recording facilities. A full snapshot is sent after reconnection; stale layout and channel configuration edits are rejected. The controller preserves in-flight drafts across ordinary snapshots, refreshes after a conflicting edit, and never automatically replays an action with an uncertain result. Object-key order on the Rust JSON boundary does not affect revision comparisons. Detached remote terminals remain restricted to the main window. Both peers should run this version to use the shared editing bridge.

Unchanged workspaces send a heartbeat every five seconds. If the host UI stops publishing for 20 seconds, the session closes and controls become unavailable instead of silently operating from a frozen view.

## Protocol and authorization

- ALPN `linkassist/remote/1`; iroh authenticates endpoint public keys and encrypts peer traffic end to end.
- Admission is disabled by default. Unknown keys require a valid code and, unless the host enabled no-approval mode, local approval. The compact code encodes an endpoint public key and a random secret.
- Each incoming action is checked against a fixed Rust allowlist and validated again at the host UI boundary. Native command names, arbitrary file read/write, shell execution and Core HTTP management are not exposed as a general remote API. Named actions allow directory listing and protocol/script metadata parsing for the shared editors.
- Channels and their owned connection/device/client IDs are resolved on the host. Configuration edits carry a revision check. Already connected channels must be disconnected before changing connection parameters or removing them.
- Requests use unique IDs; the host caches the last 128 responses per connection to suppress repeated request IDs. No automatic action retry is performed. A timeout/disconnect may leave an action's outcome unknown; inspect the host before sending it again.
- Frames use a four-byte big-endian compressed length followed by zlib JSON, reusing the existing flate2 dependency. Decoded frames are limited to 2 MiB, ordinary action arguments to 64 KiB, workspace-edit arguments to 1 MiB, device sends to 8192 bytes. Decompression is bounded independently of compressed length. Snapshot backpressure retains the latest state instead of growing a queue.
- Main-window-only commands publish snapshots, answer/claim host requests, approve/revoke devices and enable incoming control. A second check before frontend execution rejects expired or revoked queued requests. Operations already executing can finish; disabling access does not forcibly stop existing hardware or script work.
- Core HTTP retains its loopback-only address and bearer-token contract. Its token is never used as a remote credential.

Remote identity and public peer records live under `remote-access/` in the application's data directory (or the portable snapshot's isolated runtime configuration directory). Windows protects the identity key and persistent pairing code using current-user DPAPI. Unix stores them with mode `0600`. These credentials are kept outside configuration exports and portable snapshot payloads. Do not copy the key between devices.

## Dependencies and validation

`iroh` is pinned to 1.4.1 with default features disabled and only `tls-ring` enabled. No relay server, file-sync stack, metrics exporter, additional GUI runtime or tunnel sidecar is bundled. Existing release LTO, size optimization and symbol stripping remain enabled.

The application shares `reqwest` 0.13 with iroh instead of linking a second HTTP client, and uses the same SHA-2 0.11 implementation at runtime. Tauri's build-time SHA-2 0.10 dependency may still appear in the lockfile; it is not an additional application runtime dependency. Release builds compile both `tracing` and its `log` forwarding path at warning/error level, removing verbose transport instrumentation and formatting code. Debug builds retain detailed diagnostics. This does not remove channel history, script logs or remote session status; those are application data/events. To diagnose low-level transport details, use a development build: setting `RUST_LOG=debug` cannot restore code removed from a release binary.

Relay hostnames use the OS resolver first to respect VPN/local DNS proxies, with iroh's resolver as a fallback. Peer discovery retains the official DNS and HTTPS Pkarr paths. No system DNS or proxy settings are changed.

Useful checks:

```text
npm run check
cargo test --manifest-path src-tauri/Cargo.toml --lib remote::
cargo test --manifest-path src-tauri/Cargo.toml --lib public_relay_roundtrip_without_ip_transport -- --ignored --nocapture
npm run tauri build -- --no-bundle
node scripts/remote-ui-smoke.mjs
node scripts/remote-native-smoke.mjs
```

The public-relay test is opt-in because it needs external network access. It disables both endpoints' direct IP transports, so a successful round trip proves encrypted relay transport was used. It does not prove reliability across every ISP/firewall, physical UART/BLE device, or an unattended/locked desktop. GUI simulation and loopback tests also do not substitute for a real two-computer trial.

Official references: [iroh connection and identity model](https://docs.rs/iroh/1.4.1/iroh/), [public relay hosting](https://www.iroh.computer/services/hosting).
