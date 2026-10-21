# 源码接口与文件索引

> 自动生成：`npm run docs:generate`；校验：`npm run check:architecture`。不要手工维护接口名单。

此索引只列应用自有源码、配置示例和维护脚本；不扫描依赖、构建产物和上游数据仓库。

## 构建契约

- 应用版本：0.1.0。Rust 最低版本：1.94（Cargo.toml）。
- vite 锁定版本：7.3.7；Node.js 范围：`^20.19.0 || >=22.12.0`。
- vitest 锁定版本：4.1.12；Node.js 范围：`^20.0.0 || ^22.0.0 || >=24.0.0`。
- jsdom 锁定版本：29.1.1；Node.js 范围：`^20.19.0 || ^22.13.0 || >=24.0.0`。

## Tauri 命令（72）

前端 invoke 名称以此表为准；参数和返回值仍需核对函数签名及 serde 定义。

| 命令 | 实现 |
|---|---|
| `greet` | [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) |
| `get_launch_mode` | [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) |
| `main_window_ready` | [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) |
| `consume_tray_settings_request` | [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) |
| `set_tray_visible` | [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) |
| `set_mcp_tools_enabled` | [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) |
| `start_ble_scan` | [src-tauri/src/commands/ble.rs](../src-tauri/src/commands/ble.rs) |
| `stop_ble_scan` | [src-tauri/src/commands/ble.rs](../src-tauri/src/commands/ble.rs) |
| `get_ble_devices` | [src-tauri/src/commands/ble.rs](../src-tauri/src/commands/ble.rs) |
| `get_ble_pairing_statuses` | [src-tauri/src/commands/ble.rs](../src-tauri/src/commands/ble.rs) |
| `connect_ble_device` | [src-tauri/src/commands/ble.rs](../src-tauri/src/commands/ble.rs) |
| `disconnect_ble_device` | [src-tauri/src/commands/ble.rs](../src-tauri/src/commands/ble.rs) |
| `get_gatt_services` | [src-tauri/src/commands/ble.rs](../src-tauri/src/commands/ble.rs) |
| `read_ble_characteristic` | [src-tauri/src/commands/ble.rs](../src-tauri/src/commands/ble.rs) |
| `write_ble_characteristic` | [src-tauri/src/commands/ble.rs](../src-tauri/src/commands/ble.rs) |
| `subscribe_ble_notifications` | [src-tauri/src/commands/ble.rs](../src-tauri/src/commands/ble.rs) |
| `unsubscribe_ble_notifications` | [src-tauri/src/commands/ble.rs](../src-tauri/src/commands/ble.rs) |
| `list_serial_ports` | [src-tauri/src/commands/serial.rs](../src-tauri/src/commands/serial.rs) |
| `open_serial_port` | [src-tauri/src/commands/serial.rs](../src-tauri/src/commands/serial.rs) |
| `close_serial_port` | [src-tauri/src/commands/serial.rs](../src-tauri/src/commands/serial.rs) |
| `send_serial_data` | [src-tauri/src/commands/serial.rs](../src-tauri/src/commands/serial.rs) |
| `receive_serial_data` | [src-tauri/src/commands/serial.rs](../src-tauri/src/commands/serial.rs) |
| `get_serial_connections` | [src-tauri/src/commands/serial.rs](../src-tauri/src/commands/serial.rs) |
| `tcp_connect` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `tcp_disconnect` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `tcp_send` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `tcp_receive` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `tcp_list_connections` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `tcp_server_start` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `tcp_server_stop` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `tcp_server_accept` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `tcp_server_send` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `tcp_server_receive` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `tcp_server_disconnect_client` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `tcp_server_list_clients` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `udp_bind` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `udp_unbind` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `udp_send` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `udp_receive` | [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs) |
| `parse_data` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `set_parser_mode` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `get_parser_mode` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `set_field_definitions` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `get_field_definitions` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `load_lua_script` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `validate_lua_script` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `get_protocol_templates` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `apply_protocol_template` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `get_lua_protocol_file_summary` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `parse_data_with_lua_file` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `encode_field_with_lua_file` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `encode_transaction_with_lua_file` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `match_transaction_response_with_lua_file` | [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs) |
| `parse_lua_automation_script` | [src-tauri/src/commands/script.rs](../src-tauri/src/commands/script.rs) |
| `parse_lua_automation_file` | [src-tauri/src/commands/script.rs](../src-tauri/src/commands/script.rs) |
| `parse_lua_canvas_lifecycle_file` | [src-tauri/src/commands/script.rs](../src-tauri/src/commands/script.rs) |
| `call_lua_script_helper_file` | [src-tauri/src/commands/script_helper.rs](../src-tauri/src/commands/script_helper.rs) |
| `get_mcp_tool_meta` | [src-tauri/src/commands/mcp.rs](../src-tauri/src/commands/mcp.rs) |
| `run_mcp_tool_script_file` | [src-tauri/src/commands/mcp.rs](../src-tauri/src/commands/mcp.rs) |
| `register_channel_connection` | [src-tauri/src/commands/channel.rs](../src-tauri/src/commands/channel.rs) |
| `unregister_channel_connection` | [src-tauri/src/commands/channel.rs](../src-tauri/src/commands/channel.rs) |
| `save_app_config` | [src-tauri/src/commands/persistence.rs](../src-tauri/src/commands/persistence.rs) |
| `load_app_config` | [src-tauri/src/commands/persistence.rs](../src-tauri/src/commands/persistence.rs) |
| `export_to_file` | [src-tauri/src/commands/persistence.rs](../src-tauri/src/commands/persistence.rs) |
| `append_to_file` | [src-tauri/src/commands/persistence.rs](../src-tauri/src/commands/persistence.rs) |
| `import_from_file` | [src-tauri/src/commands/persistence.rs](../src-tauri/src/commands/persistence.rs) |
| `get_executable_directory` | [src-tauri/src/commands/persistence.rs](../src-tauri/src/commands/persistence.rs) |
| `load_test_runner_catalog` | [src-tauri/src/commands/test_runner.rs](../src-tauri/src/commands/test_runner.rs) |
| `start_test_run` | [src-tauri/src/commands/test_runner.rs](../src-tauri/src/commands/test_runner.rs) |
| `get_test_run` | [src-tauri/src/commands/test_runner.rs](../src-tauri/src/commands/test_runner.rs) |
| `list_test_runs` | [src-tauri/src/commands/test_runner.rs](../src-tauri/src/commands/test_runner.rs) |
| `cancel_test_run` | [src-tauri/src/commands/test_runner.rs](../src-tauri/src/commands/test_runner.rs) |

## MCP 内置工具（56）

以下为静态内置工具，不含按用户配置加载的 Lua 工具。运行时启用状态和参数 schema 以 tools/list 为准。

| 工具 | 源码说明 |
|---|---|
| `greet` | Return a greeting from the Rust backend. |
| `cancel_script_execution` | Request cooperative cancellation of a running Lua MCP script by executionId. |
| `ble_start_scan` | Start BLE scanning. |
| `ble_stop_scan` | Stop BLE scanning. |
| `ble_get_devices` | List discovered BLE devices. exactName plus waitTimeoutMs performs a bounded wait for one specific advertised name. |
| `ble_connect_device` | Connect to a BLE device by explicit deviceId. |
| `ble_disconnect_device` | Disconnect a BLE device by explicit deviceId. |
| `ble_get_gatt_services` | Discover GATT services for a connected BLE device. |
| `ble_read_characteristic` | Read a BLE characteristic by explicit deviceId/serviceUuid/charUuid. |
| `ble_write_characteristic` | Write bytes to a BLE characteristic. Omitted writeType preserves the legacy withResponse behavior; auto selects an advertised mode. |
| `ble_subscribe_notifications` | Subscribe to BLE characteristic notifications and return only after the shared notification pump is ready. |
| `ble_unsubscribe_notifications` | Release a BLE notification subscription by subscriptionId. Legacy endpoint arguments remain supported and release MCP holders for that endpoint. |
| `event_checkpoint` | Return the current monotonic Core event cursor. |
| `ble_wait_notification` | Wait for a BLE notification newer than afterCursor at one endpoint. Returns immediately for cursor overflow, a future cursor, or device disconnect. |
| `ble_get_notifications_data` | Return buffered BLE notification payloads. Without arguments returns the latest notification; with seconds or count returns the recent BLE notifications. |
| `serial_list_ports` | List available serial ports. |
| `serial_open_port` | Open a serial port and return its explicit connectionId. |
| `serial_close_port` | Close a serial connection by connectionId. |
| `serial_send_data` | Send bytes through an open serial connectionId. |
| `serial_receive_data` | Poll bytes from an open serial connectionId. |
| `serial_get_connections` | List open serial connection IDs. |
| `tcp_connect` | Connect TCP client and return connectionId. |
| `tcp_disconnect` | Disconnect TCP client by connectionId. |
| `tcp_send` | Send bytes through a TCP connectionId. |
| `tcp_receive` | Compatibility receive for TCP connectionId; event-driven backend returns an empty array. |
| `tcp_list_connections` | List TCP client connections. |
| `tcp_server_start` | Start TCP server listening at addr and return bound address. |
| `tcp_server_stop` | Stop TCP server listener. |
| `tcp_server_accept` | Compatibility command; server auto-accepts clients. |
| `tcp_server_send` | Send bytes to a TCP server client by clientId. |
| `tcp_server_receive` | Compatibility receive for TCP server clientId; event-driven backend returns an empty array. |
| `tcp_server_disconnect_client` | Disconnect a TCP server client by clientId. |
| `tcp_server_list_clients` | List TCP server clients. |
| `udp_bind` | Bind UDP socket at addr and return bound address. |
| `udp_unbind` | Unbind UDP socket. |
| `udp_send` | Send UDP bytes to addr. |
| `udp_receive` | Compatibility UDP receive; event-driven backend returns empty data and addr. |
| `protocol_parse_data` | Parse bytes with the current protocol parser. |
| `protocol_set_parser_mode` | Set protocol parser mode. |
| `protocol_get_parser_mode` | Get current protocol parser mode. |
| `protocol_set_field_definitions` | Set protocol field definitions. |
| `protocol_get_field_definitions` | Get protocol field definitions. |
| `protocol_load_lua_script` | Load protocol Lua script. |
| `protocol_validate_lua_script` | Validate protocol Lua script. |
| `protocol_get_templates` | List built-in protocol templates. |
| `protocol_apply_template` | Apply a built-in protocol template by templateId. |
| `protocol_get_lua_file_summary` | Summarize a Lua protocol file by filePath. resourceRoot optionally provides the sandboxed data directory used by read_text_file. |
| `protocol_parse_data_with_lua_file` | Parse bytes using a Lua protocol file. resourceRoot optionally provides its external data directory. |
| `protocol_encode_transaction_with_lua_file` | Encode a whole protocol transaction into an outbound frame using a Lua protocol file. Returns frame and route metadata. resourceRoot optionally provides the adapter's external data directory. |
| `protocol_match_transaction_response_with_lua_file` | Match response bytes against a transaction using a Lua protocol file's generic match_transaction_response contract. resourceRoot optionally provides its external data directory. |
| `protocol_execute_transaction_with_lua_file` | Execute one protocol transaction atomically: encode, subscribe, checkpoint, write, wait for the matching response, parse it, and release the subscription. The protocol file owns all route and frame semantics. |
| `save_app_config` | Save application config. |
| `load_app_config` | Load application config. |
| `export_to_file` | Export content to a file path. |
| `import_from_file` | Import content from a file path. The default 'utf8' encoding fails on binary files; pass encoding 'base64' to read any file, including firmware images. |
| `get_recent_events` | Return recent Core events/logs buffered by the headless core. |

## 应用文件（251）

目录职责见 [架构说明](ARCHITECTURE.md)。根目录构建入口另见 [开发与验证](DEVELOPMENT.md)。

- [config/layout/layout-bench.json](../config/layout/layout-bench.json)
- [config/layout/layout-linkassist.json](../config/layout/layout-linkassist.json)
- [config/layout/loopback.json](../config/layout/loopback.json)
- [config/layout/table.json](../config/layout/table.json)
- [config/layout/test.json](../config/layout/test.json)
- [config/mcp/mcp-configuration-guide.md](../config/mcp/mcp-configuration-guide.md)
- [config/mcp/mcp-tool-lua-guide.md](../config/mcp/mcp-tool-lua-guide.md)
- [config/mcp/mcp-tool-protocol-inspector.lua](../config/mcp/mcp-tool-protocol-inspector.lua)
- [config/mcp/mcp-tool-test-bench.lua](../config/mcp/mcp-tool-test-bench.lua)
- [config/mcp/motor-control-protocol-summary.md](../config/mcp/motor-control-protocol-summary.md)
- [config/protocol/protocol-configuration-guide.md](../config/protocol/protocol-configuration-guide.md)
- [config/protocol/protocol-example.lua](../config/protocol/protocol-example.lua)
- [config/protocol/protocol-teco-rpm-command.lua](../config/protocol/protocol-teco-rpm-command.lua)
- [config/protocol/protocol-ut61e-parser.lua](../config/protocol/protocol-ut61e-parser.lua)
- [config/script-helper/script-helper-test-bench.lua](../config/script-helper/script-helper-test-bench.lua)
- [config/script/canvas-lifecycle-chart-torque-init-calibrate.lua](../config/script/canvas-lifecycle-chart-torque-init-calibrate.lua)
- [config/script/canvas-lifecycle-form-motor-init-stop.lua](../config/script/canvas-lifecycle-form-motor-init-stop.lua)
- [config/script/canvas-lifecycle-guide.md](../config/script/canvas-lifecycle-guide.md)
- [config/script/canvas-lifecycle-init-end-example.lua](../config/script/canvas-lifecycle-init-end-example.lua)
- [config/script/canvas-lifecycle-poll-1s-example.lua](../config/script/canvas-lifecycle-poll-1s-example.lua)
- [config/script/canvas-lifecycle-torque-sensor-32h-read.lua](../config/script/canvas-lifecycle-torque-sensor-32h-read.lua)
- [config/script/script-ble-ftms-spin-down.lua](../config/script/script-ble-ftms-spin-down.lua)
- [config/script/script-configuration-guide.md](../config/script/script-configuration-guide.md)
- [config/script/script-serial-rpm-commands.csv](../config/script/script-serial-rpm-commands.csv)
- [config/script/script-serial-rpm-example.lua](../config/script/script-serial-rpm-example.lua)
- [config/script/script-serial-rpm-grade-commands.csv](../config/script/script-serial-rpm-grade-commands.csv)
- [config/script/script-serial-rpm-grade.md](../config/script/script-serial-rpm-grade.md)
- [config/script/script-test-run-example.lua](../config/script/script-test-run-example.lua)
- [scripts/audit-rust.mjs](../scripts/audit-rust.mjs)
- [scripts/check-rust-backports.mjs](../scripts/check-rust-backports.mjs)
- [scripts/core-smoke.mjs](../scripts/core-smoke.mjs)
- [scripts/generate-notices.mjs](../scripts/generate-notices.mjs)
- [scripts/project-check.mjs](../scripts/project-check.mjs)
- [scripts/test-rust-macro-diagnostics.mjs](../scripts/test-rust-macro-diagnostics.mjs)
- [src-tauri/src/AGENTS.md](../src-tauri/src/AGENTS.md)
- [src-tauri/src/ble/connection.rs](../src-tauri/src/ble/connection.rs)
- [src-tauri/src/ble/gatt.rs](../src-tauri/src/ble/gatt.rs)
- [src-tauri/src/ble/mod.rs](../src-tauri/src/ble/mod.rs)
- [src-tauri/src/ble/pairing.rs](../src-tauri/src/ble/pairing.rs)
- [src-tauri/src/ble/scanner.rs](../src-tauri/src/ble/scanner.rs)
- [src-tauri/src/channel_activity.rs](../src-tauri/src/channel_activity.rs)
- [src-tauri/src/channel_registry.rs](../src-tauri/src/channel_registry.rs)
- [src-tauri/src/commands/ble.rs](../src-tauri/src/commands/ble.rs)
- [src-tauri/src/commands/channel.rs](../src-tauri/src/commands/channel.rs)
- [src-tauri/src/commands/mcp.rs](../src-tauri/src/commands/mcp.rs)
- [src-tauri/src/commands/mod.rs](../src-tauri/src/commands/mod.rs)
- [src-tauri/src/commands/persistence.rs](../src-tauri/src/commands/persistence.rs)
- [src-tauri/src/commands/protocol.rs](../src-tauri/src/commands/protocol.rs)
- [src-tauri/src/commands/script.rs](../src-tauri/src/commands/script.rs)
- [src-tauri/src/commands/script_helper.rs](../src-tauri/src/commands/script_helper.rs)
- [src-tauri/src/commands/serial.rs](../src-tauri/src/commands/serial.rs)
- [src-tauri/src/commands/tcp.rs](../src-tauri/src/commands/tcp.rs)
- [src-tauri/src/commands/test_runner.rs](../src-tauri/src/commands/test_runner.rs)
- [src-tauri/src/core_http.rs](../src-tauri/src/core_http.rs)
- [src-tauri/src/discovery.rs](../src-tauri/src/discovery.rs)
- [src-tauri/src/error.rs](../src-tauri/src/error.rs)
- [src-tauri/src/lib.rs](../src-tauri/src/lib.rs)
- [src-tauri/src/main.rs](../src-tauri/src/main.rs)
- [src-tauri/src/mcp_bridge.rs](../src-tauri/src/mcp_bridge.rs)
- [src-tauri/src/mcp_tool_script.rs](../src-tauri/src/mcp_tool_script.rs)
- [src-tauri/src/mcp_tools.rs](../src-tauri/src/mcp_tools.rs)
- [src-tauri/src/persistence.rs](../src-tauri/src/persistence.rs)
- [src-tauri/src/protocol/AGENTS.md](../src-tauri/src/protocol/AGENTS.md)
- [src-tauri/src/protocol/lua_engine.rs](../src-tauri/src/protocol/lua_engine.rs)
- [src-tauri/src/protocol/mod.rs](../src-tauri/src/protocol/mod.rs)
- [src-tauri/src/protocol/parser.rs](../src-tauri/src/protocol/parser.rs)
- [src-tauri/src/protocol/templates.rs](../src-tauri/src/protocol/templates.rs)
- [src-tauri/src/protocol/types.rs](../src-tauri/src/protocol/types.rs)
- [src-tauri/src/recent_events.rs](../src-tauri/src/recent_events.rs)
- [src-tauri/src/script_helper.rs](../src-tauri/src/script_helper.rs)
- [src-tauri/src/script_markers.rs](../src-tauri/src/script_markers.rs)
- [src-tauri/src/serial/io.rs](../src-tauri/src/serial/io.rs)
- [src-tauri/src/serial/mod.rs](../src-tauri/src/serial/mod.rs)
- [src-tauri/src/serial/port.rs](../src-tauri/src/serial/port.rs)
- [src-tauri/src/snapshot.rs](../src-tauri/src/snapshot.rs)
- [src-tauri/src/tcp/client.rs](../src-tauri/src/tcp/client.rs)
- [src-tauri/src/tcp/mod.rs](../src-tauri/src/tcp/mod.rs)
- [src-tauri/src/tcp/server.rs](../src-tauri/src/tcp/server.rs)
- [src-tauri/src/tcp/udp.rs](../src-tauri/src/tcp/udp.rs)
- [src-tauri/src/test_runner.rs](../src-tauri/src/test_runner.rs)
- [src/App.tsx](../src/App.tsx)
- [src/__tests__/CanvasChart.test.tsx](../src/__tests__/CanvasChart.test.tsx)
- [src/__tests__/CanvasContainerCorners.test.tsx](../src/__tests__/CanvasContainerCorners.test.tsx)
- [src/__tests__/CanvasEditDialogBundledLua.test.tsx](../src/__tests__/CanvasEditDialogBundledLua.test.tsx)
- [src/__tests__/CanvasScriptHeader.test.tsx](../src/__tests__/CanvasScriptHeader.test.tsx)
- [src/__tests__/ChannelQuickOpenButton.test.tsx](../src/__tests__/ChannelQuickOpenButton.test.tsx)
- [src/__tests__/DisplayPanelViewportReset.test.tsx](../src/__tests__/DisplayPanelViewportReset.test.tsx)
- [src/__tests__/GattExplorer.test.tsx](../src/__tests__/GattExplorer.test.tsx)
- [src/__tests__/GlobalTooltip.test.tsx](../src/__tests__/GlobalTooltip.test.tsx)
- [src/__tests__/LeftPanelRename.test.tsx](../src/__tests__/LeftPanelRename.test.tsx)
- [src/__tests__/RoundedSelect.test.tsx](../src/__tests__/RoundedSelect.test.tsx)
- [src/__tests__/ScriptCanvasUi.test.tsx](../src/__tests__/ScriptCanvasUi.test.tsx)
- [src/__tests__/ScriptToolbarButton.test.tsx](../src/__tests__/ScriptToolbarButton.test.tsx)
- [src/__tests__/SettingsDialogMcpMeta.test.tsx](../src/__tests__/SettingsDialogMcpMeta.test.tsx)
- [src/__tests__/SimpleMode.test.tsx](../src/__tests__/SimpleMode.test.tsx)
- [src/__tests__/WindowMaximizeResize.test.tsx](../src/__tests__/WindowMaximizeResize.test.tsx)
- [src/__tests__/bleAppearance.test.ts](../src/__tests__/bleAppearance.test.ts)
- [src/__tests__/bleDeviceRowLayout.test.ts](../src/__tests__/bleDeviceRowLayout.test.ts)
- [src/__tests__/bleFilterLayout.test.ts](../src/__tests__/bleFilterLayout.test.ts)
- [src/__tests__/canvasBorderTheme.test.ts](../src/__tests__/canvasBorderTheme.test.ts)
- [src/__tests__/canvasFrameBounds.test.ts](../src/__tests__/canvasFrameBounds.test.ts)
- [src/__tests__/canvasMigration.test.ts](../src/__tests__/canvasMigration.test.ts)
- [src/__tests__/canvasSnapUtils.test.ts](../src/__tests__/canvasSnapUtils.test.ts)
- [src/__tests__/canvasStore.test.ts](../src/__tests__/canvasStore.test.ts)
- [src/__tests__/channelActivity.test.ts](../src/__tests__/channelActivity.test.ts)
- [src/__tests__/eventSubscriptions.test.ts](../src/__tests__/eventSubscriptions.test.ts)
- [src/__tests__/fileDialogPaths.test.ts](../src/__tests__/fileDialogPaths.test.ts)
- [src/__tests__/formPlaceholderUtils.test.ts](../src/__tests__/formPlaceholderUtils.test.ts)
- [src/__tests__/formula-context.test.ts](../src/__tests__/formula-context.test.ts)
- [src/__tests__/mcpConfig.test.ts](../src/__tests__/mcpConfig.test.ts)
- [src/__tests__/numericExpression.test.ts](../src/__tests__/numericExpression.test.ts)
- [src/__tests__/panelWidthInvariance.test.ts](../src/__tests__/panelWidthInvariance.test.ts)
- [src/__tests__/persistenceValidation.test.ts](../src/__tests__/persistenceValidation.test.ts)
- [src/__tests__/protocolParseDiagnostics.test.ts](../src/__tests__/protocolParseDiagnostics.test.ts)
- [src/__tests__/releaseHardening.test.ts](../src/__tests__/releaseHardening.test.ts)
- [src/__tests__/scriptRuntime.test.ts](../src/__tests__/scriptRuntime.test.ts)
- [src/__tests__/scriptRuntimeLuaHelpers.test.ts](../src/__tests__/scriptRuntimeLuaHelpers.test.ts)
- [src/__tests__/scriptUiUtils.test.ts](../src/__tests__/scriptUiUtils.test.ts)
- [src/__tests__/stores.test.ts](../src/__tests__/stores.test.ts)
- [src/__tests__/terminalStore.test.ts](../src/__tests__/terminalStore.test.ts)
- [src/__tests__/terminalUtils.test.ts](../src/__tests__/terminalUtils.test.ts)
- [src/__tests__/testRunnerSelection.test.ts](../src/__tests__/testRunnerSelection.test.ts)
- [src/__tests__/types.test.ts](../src/__tests__/types.test.ts)
- [src/__tests__/useMainWindowReveal.test.tsx](../src/__tests__/useMainWindowReveal.test.tsx)
- [src/__tests__/usePersistenceClose.test.tsx](../src/__tests__/usePersistenceClose.test.tsx)
- [src/__tests__/useTcpRouting.test.ts](../src/__tests__/useTcpRouting.test.ts)
- [src/__tests__/viewportUtils.test.ts](../src/__tests__/viewportUtils.test.ts)
- [src/components/AGENTS.md](../src/components/AGENTS.md)
- [src/components/channels/ble/BlePanel.tsx](../src/components/channels/ble/BlePanel.tsx)
- [src/components/channels/ble/bleDeviceRowLayout.ts](../src/components/channels/ble/bleDeviceRowLayout.ts)
- [src/components/channels/ble/bleFilterLayout.ts](../src/components/channels/ble/bleFilterLayout.ts)
- [src/components/channels/ble/index.ts](../src/components/channels/ble/index.ts)
- [src/components/channels/tcp/TcpPanel.tsx](../src/components/channels/tcp/TcpPanel.tsx)
- [src/components/channels/tcp/index.ts](../src/components/channels/tcp/index.ts)
- [src/components/channels/uart/UartPanel.tsx](../src/components/channels/uart/UartPanel.tsx)
- [src/components/channels/uart/index.ts](../src/components/channels/uart/index.ts)
- [src/components/common/ErrorBoundary.tsx](../src/components/common/ErrorBoundary.tsx)
- [src/components/common/GlobalTooltip.tsx](../src/components/common/GlobalTooltip.tsx)
- [src/components/common/Icons.tsx](../src/components/common/Icons.tsx)
- [src/components/common/RoundedSelect.tsx](../src/components/common/RoundedSelect.tsx)
- [src/components/common/ToastContainer.tsx](../src/components/common/ToastContainer.tsx)
- [src/components/common/index.ts](../src/components/common/index.ts)
- [src/components/display/AGENTS.md](../src/components/display/AGENTS.md)
- [src/components/display/Canvas.tsx](../src/components/display/Canvas.tsx)
- [src/components/display/CanvasChart.tsx](../src/components/display/CanvasChart.tsx)
- [src/components/display/CanvasEditDialog.tsx](../src/components/display/CanvasEditDialog.tsx)
- [src/components/display/CanvasForm.tsx](../src/components/display/CanvasForm.tsx)
- [src/components/display/CanvasIngestStatus.tsx](../src/components/display/CanvasIngestStatus.tsx)
- [src/components/display/CanvasScript.tsx](../src/components/display/CanvasScript.tsx)
- [src/components/display/CanvasTable.tsx](../src/components/display/CanvasTable.tsx)
- [src/components/display/ChartToolbar.tsx](../src/components/display/ChartToolbar.tsx)
- [src/components/display/ContextMenu.tsx](../src/components/display/ContextMenu.tsx)
- [src/components/display/DisplayPanel.tsx](../src/components/display/DisplayPanel.tsx)
- [src/components/display/FormulaInput.tsx](../src/components/display/FormulaInput.tsx)
- [src/components/display/ScriptCanvasUi.tsx](../src/components/display/ScriptCanvasUi.tsx)
- [src/components/display/adapters/barAdapter.ts](../src/components/display/adapters/barAdapter.ts)
- [src/components/display/adapters/index.ts](../src/components/display/adapters/index.ts)
- [src/components/display/adapters/lineAdapter.ts](../src/components/display/adapters/lineAdapter.ts)
- [src/components/display/adapters/scatterAdapter.ts](../src/components/display/adapters/scatterAdapter.ts)
- [src/components/display/adapters/theme.ts](../src/components/display/adapters/theme.ts)
- [src/components/display/canvasDataUtils.ts](../src/components/display/canvasDataUtils.ts)
- [src/components/display/canvasLifecycleRuntime.ts](../src/components/display/canvasLifecycleRuntime.ts)
- [src/components/display/canvasSnapUtils.ts](../src/components/display/canvasSnapUtils.ts)
- [src/components/display/channelRuntimeLease.ts](../src/components/display/channelRuntimeLease.ts)
- [src/components/display/chartDataUtils.ts](../src/components/display/chartDataUtils.ts)
- [src/components/display/chartRuntime.ts](../src/components/display/chartRuntime.ts)
- [src/components/display/formPlaceholderUtils.ts](../src/components/display/formPlaceholderUtils.ts)
- [src/components/display/formulaUtils.ts](../src/components/display/formulaUtils.ts)
- [src/components/display/index.ts](../src/components/display/index.ts)
- [src/components/display/protocolParseDiagnostics.ts](../src/components/display/protocolParseDiagnostics.ts)
- [src/components/display/scriptCsv.ts](../src/components/display/scriptCsv.ts)
- [src/components/display/scriptLua.ts](../src/components/display/scriptLua.ts)
- [src/components/display/scriptRuntime.ts](../src/components/display/scriptRuntime.ts)
- [src/components/display/scriptTypes.ts](../src/components/display/scriptTypes.ts)
- [src/components/display/scriptUiUtils.ts](../src/components/display/scriptUiUtils.ts)
- [src/components/display/scriptUtils.ts](../src/components/display/scriptUtils.ts)
- [src/components/display/useCanvasInteraction.ts](../src/components/display/useCanvasInteraction.ts)
- [src/components/display/viewportUtils.ts](../src/components/display/viewportUtils.ts)
- [src/components/layout/AGENTS.md](../src/components/layout/AGENTS.md)
- [src/components/layout/CenterPanel.tsx](../src/components/layout/CenterPanel.tsx)
- [src/components/layout/DetachedTerminalWindow.tsx](../src/components/layout/DetachedTerminalWindow.tsx)
- [src/components/layout/LeftPanel.tsx](../src/components/layout/LeftPanel.tsx)
- [src/components/layout/MainLayout.tsx](../src/components/layout/MainLayout.tsx)
- [src/components/layout/PaneTreeRenderer.tsx](../src/components/layout/PaneTreeRenderer.tsx)
- [src/components/layout/ResizeHandle.tsx](../src/components/layout/ResizeHandle.tsx)
- [src/components/layout/RightPanel.tsx](../src/components/layout/RightPanel.tsx)
- [src/components/layout/SavedCommandsDialog.tsx](../src/components/layout/SavedCommandsDialog.tsx)
- [src/components/layout/SavedCommandsPanel.tsx](../src/components/layout/SavedCommandsPanel.tsx)
- [src/components/layout/SettingsDialog.tsx](../src/components/layout/SettingsDialog.tsx)
- [src/components/layout/TerminalContextMenu.tsx](../src/components/layout/TerminalContextMenu.tsx)
- [src/components/layout/TerminalLeafPane.tsx](../src/components/layout/TerminalLeafPane.tsx)
- [src/components/layout/TitleBar.tsx](../src/components/layout/TitleBar.tsx)
- [src/components/layout/eventSubscriptions.ts](../src/components/layout/eventSubscriptions.ts)
- [src/components/layout/index.ts](../src/components/layout/index.ts)
- [src/components/layout/layoutImport.ts](../src/components/layout/layoutImport.ts)
- [src/components/layout/terminalUtils.ts](../src/components/layout/terminalUtils.ts)
- [src/components/parser/GattExplorer.tsx](../src/components/parser/GattExplorer.tsx)
- [src/components/parser/index.ts](../src/components/parser/index.ts)
- [src/hooks/AGENTS.md](../src/hooks/AGENTS.md)
- [src/hooks/index.ts](../src/hooks/index.ts)
- [src/hooks/useBle.ts](../src/hooks/useBle.ts)
- [src/hooks/useMainWindowReveal.ts](../src/hooks/useMainWindowReveal.ts)
- [src/hooks/usePersistence.ts](../src/hooks/usePersistence.ts)
- [src/hooks/useSerial.ts](../src/hooks/useSerial.ts)
- [src/hooks/useTcp.ts](../src/hooks/useTcp.ts)
- [src/lib/bleAppearance.ts](../src/lib/bleAppearance.ts)
- [src/lib/bleConstants.ts](../src/lib/bleConstants.ts)
- [src/lib/canvasIngestQueue.ts](../src/lib/canvasIngestQueue.ts)
- [src/lib/channelActivity.ts](../src/lib/channelActivity.ts)
- [src/lib/channelRegistry.ts](../src/lib/channelRegistry.ts)
- [src/lib/detachWindow.ts](../src/lib/detachWindow.ts)
- [src/lib/fileDialogPaths.ts](../src/lib/fileDialogPaths.ts)
- [src/lib/index.ts](../src/lib/index.ts)
- [src/lib/layoutPaths.ts](../src/lib/layoutPaths.ts)
- [src/lib/layoutValidation.ts](../src/lib/layoutValidation.ts)
- [src/lib/numericExpression.ts](../src/lib/numericExpression.ts)
- [src/lib/persistenceValidation.ts](../src/lib/persistenceValidation.ts)
- [src/lib/terminalLayoutChange.ts](../src/lib/terminalLayoutChange.ts)
- [src/lib/terminalSend.ts](../src/lib/terminalSend.ts)
- [src/lib/testRunnerApi.ts](../src/lib/testRunnerApi.ts)
- [src/lib/testRunnerSelection.ts](../src/lib/testRunnerSelection.ts)
- [src/main.tsx](../src/main.tsx)
- [src/stores/AGENTS.md](../src/stores/AGENTS.md)
- [src/stores/bleStore.ts](../src/stores/bleStore.ts)
- [src/stores/canvasStore.ts](../src/stores/canvasStore.ts)
- [src/stores/channelStore.ts](../src/stores/channelStore.ts)
- [src/stores/commandStore.ts](../src/stores/commandStore.ts)
- [src/stores/index.ts](../src/stores/index.ts)
- [src/stores/mcpStore.ts](../src/stores/mcpStore.ts)
- [src/stores/protocolStore.ts](../src/stores/protocolStore.ts)
- [src/stores/serialStore.ts](../src/stores/serialStore.ts)
- [src/stores/tcpStore.ts](../src/stores/tcpStore.ts)
- [src/stores/terminalStore.ts](../src/stores/terminalStore.ts)
- [src/stores/toastStore.ts](../src/stores/toastStore.ts)
- [src/stores/uiStore.ts](../src/stores/uiStore.ts)
- [src/styles/globals.css](../src/styles/globals.css)
- [src/types/AGENTS.md](../src/types/AGENTS.md)
- [src/types/ble.ts](../src/types/ble.ts)
- [src/types/canvas.ts](../src/types/canvas.ts)
- [src/types/canvasMigration.ts](../src/types/canvasMigration.ts)
- [src/types/channel.ts](../src/types/channel.ts)
- [src/types/channelActivity.ts](../src/types/channelActivity.ts)
- [src/types/events.ts](../src/types/events.ts)
- [src/types/index.ts](../src/types/index.ts)
- [src/types/mcp.ts](../src/types/mcp.ts)
- [src/types/persistence.ts](../src/types/persistence.ts)
- [src/types/protocol.ts](../src/types/protocol.ts)
- [src/types/serial.ts](../src/types/serial.ts)
- [src/types/tcp.ts](../src/types/tcp.ts)
- [src/types/testRunner.ts](../src/types/testRunner.ts)
- [src/vite-env.d.ts](../src/vite-env.d.ts)
