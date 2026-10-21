# LinkAssist MCP 配置指南

本文说明如何把 LinkAssist 配置为 MCP（Model Context Protocol）服务器，并列出当前 LinkAssist 通过 MCP 暴露的工具指令。

完整内置工具名称及源码说明由 [源码接口索引](../../docs/REFERENCE.md) 自动生成。下文是配置与常用调用说明；运行时参数、动态 Lua 工具及启用状态以 `tools/list` 为准。整体功能与架构分别见 [功能说明](../../docs/FEATURES.md) 和 [架构说明](../../docs/ARCHITECTURE.md)。

> 适用对象：Claude Desktop、Claude Code、OpenCode、Codex、Gemini CLI 等支持 MCP 的客户端/Host。不同客户端的配置文件位置和字段可能不同；本文优先给出通用 `stdio` 配置模式和 LinkAssist 自身支持的工具清单。

## 1. 当前 MCP 支持范围

LinkAssist 当前实现的是 **stdio MCP Bridge**：

1. MCP 客户端启动 LinkAssist 可执行文件，并传入 `--mcp-bridge`。
2. LinkAssist MCP Bridge 通过 stdin/stdout 与客户端交换 JSON-RPC 消息。
3. 第一次调用工具时，Bridge 会启动或复用 `--core-headless` 后台 Core。
4. Bridge 转发 `tools/call` 到本机 Core HTTP 接口 `/mcp/tools/{name}/call`。
5. 需要跨越普通 HTTP 客户端超时的工具可调用 `/mcp/tools/{name}/start`，再通过
   `/mcp/tool-executions/{executionId}` 查询 `running/completed` 和最终结果；后台执行期间 Core
   不会因 Bridge lease 空闲而退出。

当前 MCP 能力：

| 能力 | 状态 | 说明 |
|---|---|---|
| Tools | 已支持 | `tools/list`、`tools/call` |
| Resources | 未暴露 | 当前没有实现 `resources/list` / `resources/read` |
| Prompts | 未暴露 | 当前没有实现 `prompts/list` / `prompts/get` |

当前 Bridge 支持的 JSON-RPC 方法：

| 方法 | 说明 |
|---|---|
| `initialize` | 返回协议版本、服务器信息和 tools 能力 |
| `notifications/initialized` | 初始化完成通知，无响应内容 |
| `ping` | 健康检查 |
| `tools/list` | 列出 LinkAssist 暴露的 MCP 工具 |
| `tools/call` | 调用指定 LinkAssist MCP 工具 |

## 2. 通用 stdio 配置

MCP 客户端通常通过 `servers` 配置本地 stdio 服务器。LinkAssist 的启动命令必须指向 LinkAssist 可执行文件，并传入 `--mcp-bridge`。

```json
{
  "servers": {
    "linkassist": {
      "command": "ABSOLUTE_PATH_TO_LINKASSIST_EXECUTABLE",
      "args": ["--mcp-bridge"]
    }
  }
}
```

Windows vscode 示例：

```json
{
  "servers": {
    "linkassist": {
      "command": "C:\\Program Files\\LinkAssist\\LinkAssist.exe",
      "args": ["--mcp-bridge"]
    }
  }
}
```

注意事项：

- `command` 建议使用绝对路径。
- MCP stdio 服务器不能向 stdout 输出非 MCP JSON-RPC 内容；LinkAssist 的错误日志会写入 stderr。
- 修改客户端 MCP 配置后，通常需要重启客户端或重新加载 MCP server。
- 如果同时运行桌面 UI，Bridge 会优先复用健康的后台 Core；否则会自动启动 headless Core。

## 3. 常见客户端配置方式

### 3.1 Claude Desktop

Claude Desktop 本地配置文件通常为：

- Windows：`%APPDATA%\\Claude\\claude_desktop_config.json`
- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`

配置示例：

```json
{
  "mcpServers": {
    "linkassist": {
      "command": "C:\\Program Files\\LinkAssist\\LinkAssist.exe",
      "args": ["--mcp-bridge"]
    }
  }
}
```

### 3.2 Claude Code

添加本地 stdio server：

```bash
claude mcp add --scope project --transport stdio linkassist -- "C:\\Program Files\\LinkAssist\\LinkAssist.exe" --mcp-bridge
```

常用管理命令：

```bash
claude mcp list
claude mcp get linkassist
claude mcp remove linkassist
```

在 Claude Code 内查看 MCP 状态：

```text
/mcp
```

项目级 `.mcp.json` 示例：

```json
{
  "mcpServers": {
    "linkassist": {
      "command": "C:\\Program Files\\LinkAssist\\LinkAssist.exe",
      "args": ["--mcp-bridge"]
    }
  }
}
```

### 3.3 其他客户端

不同客户端可能使用不同根键或字段名，例如：

| 客户端 | 常见配置形态 |
|---|---|
| Claude Desktop | `mcpServers` + `command` + `args` |
| Claude Code | `claude mcp add ...` 或项目 `.mcp.json` |
| VS Code Copilot | 可能使用 `.vscode/mcp.json` 和 `servers` 根键 |
| OpenCode | 可能使用 `mcp` 配置块 |
| Codex / Gemini CLI | 通常提供各自的 `mcp add/list/remove` 命令 |

如果客户端文档与本文字段不同，以客户端官方文档为准；LinkAssist 侧只要求最终能以 stdio 启动：

```bash
LinkAssist.exe --mcp-bridge
```

## 4. LinkAssist 支持的 MCP 工具指令

以下工具名来自 `src-tauri/src/mcp_tools.rs`，是 `tools/list` 返回的权威清单。

### 4.1 通用

| 工具 | 参数 | 说明 |
|---|---|---|
| `greet` | `name: string` | 返回 Rust 后端问候消息 |
| `get_recent_events` | 无 | 返回最近 Core 事件缓冲中的原始事件 |

### 4.2 BLE

| 工具 | 参数 | 说明 |
|---|---|---|
| `ble_start_scan` | 无 | 开始 BLE 扫描 |
| `ble_stop_scan` | 无 | 停止 BLE 扫描 |
| `ble_get_devices` | 无 | 列出已发现 BLE 设备 |
| `ble_connect_device` | `deviceId: string` | 连接指定 BLE 设备 |
| `ble_disconnect_device` | `deviceId: string` | 断开指定 BLE 设备 |
| `ble_get_gatt_services` | `deviceId: string` | 发现已连接设备的 GATT 服务 |
| `ble_read_characteristic` | `deviceId`, `serviceUuid`, `charUuid` | 读取 BLE 特征值 |
| `ble_write_characteristic` | `deviceId`, `serviceUuid`, `charUuid`, `data: byte[]` | 写入 BLE 特征值 |
| `ble_subscribe_notifications` | `deviceId`, `serviceUuid`, `charUuid` | 订阅 BLE 通知 |
| `ble_unsubscribe_notifications` | `deviceId`, `serviceUuid`, `charUuid` | 取消订阅 BLE 通知 |
| `ble_get_notifications_data` | `seconds?: number`, `count?: number` | 读取最近缓存的 BLE 通知数据；不传参默认返回最新 1 条，传 `seconds` 返回最近 N 秒，传 `count` 返回最近 N 条 |

示例参数：

```json
{
  "deviceId": "DEVICE_ID",
  "serviceUuid": "0000180f-0000-1000-8000-00805f9b34fb",
  "charUuid": "00002a19-0000-1000-8000-00805f9b34fb",
  "data": [1, 2, 3]
}
```

`ble_get_notifications_data` 示例：

```json
{}
```

```json
{
  "seconds": 10
}
```

```json
{
  "count": 20
}
```

> 注意：`seconds` 和 `count` 不能同时传入；该工具只能读取已经通过 `ble_subscribe_notifications` 缓存在 Core 内的通知数据。

### 4.3 Serial / UART

| 工具 | 参数 | 说明 |
|---|---|---|
| `serial_list_ports` | 无 | 列出可用串口 |
| `serial_open_port` | `config: object`, `channelId: string` | 打开串口并返回 `connectionId` |
| `serial_close_port` | `connectionId: string` | 关闭串口连接 |
| `serial_send_data` | `connectionId: string`, `data: byte[]` | 发送串口数据 |
| `serial_receive_data` | `connectionId: string` | 轮询读取串口数据 |
| `serial_get_connections` | 无 | 列出当前打开的串口连接 |

`serial_open_port` 参数示例：

```json
{
  "channelId": "serial-channel-1",
  "config": {
    "portName": "COM3",
    "baudRate": 115200,
    "dataBits": 8,
    "stopBits": 1,
    "parity": "none",
    "flowControl": "none"
  }
}
```

> 注意：项目内已有说明指出 UART receive 仍是旧式轮询路径；实时接收推荐依赖事件驱动能力，MCP 侧读取能力可能受当前实现限制。

### 4.4 TCP Client

| 工具 | 参数 | 说明 |
|---|---|---|
| `tcp_connect` | `addr: string`, `channelId: string` | 建立 TCP 客户端连接并返回 `connectionId` |
| `tcp_disconnect` | `connectionId: string` | 断开 TCP 客户端连接 |
| `tcp_send` | `connectionId: string`, `data: byte[]` | 发送 TCP 数据 |
| `tcp_receive` | `connectionId: string` | 兼容读取接口；当前事件驱动后端返回空数组 |
| `tcp_list_connections` | 无 | 列出 TCP 客户端连接 |

示例参数：

```json
{
  "addr": "127.0.0.1:9000",
  "channelId": "tcp-client-1"
}
```

### 4.5 TCP Server

| 工具 | 参数 | 说明 |
|---|---|---|
| `tcp_server_start` | `addr: string` | 启动 TCP Server，返回绑定地址 |
| `tcp_server_stop` | 无 | 停止 TCP Server |
| `tcp_server_accept` | 无 | 兼容命令；当前自动接受连接，调用会返回错误说明 |
| `tcp_server_send` | `clientId: string`, `data: byte[]` | 向指定客户端发送数据 |
| `tcp_server_receive` | `clientId: string` | 兼容读取接口；当前返回空数组 |
| `tcp_server_disconnect_client` | `clientId: string` | 断开指定客户端 |
| `tcp_server_list_clients` | 无 | 列出已连接客户端 |

示例参数：

```json
{
  "addr": "127.0.0.1:9000"
}
```

### 4.6 UDP

| 工具 | 参数 | 说明 |
|---|---|---|
| `udp_bind` | `addr: string` | 绑定 UDP socket，返回绑定地址 |
| `udp_unbind` | 无 | 解绑 UDP socket |
| `udp_send` | `addr: string`, `data: byte[]` | 向指定地址发送 UDP 数据 |
| `udp_receive` | 无 | 兼容读取接口；当前返回空数据和空地址 |

示例参数：

```json
{
  "addr": "127.0.0.1:9001",
  "data": [72, 101, 108, 108, 111]
}
```

### 4.7 协议解析

| 工具 | 参数 | 说明 |
|---|---|---|
| `protocol_parse_data` | `data: byte[]` | 使用当前协议解析器解析字节 |
| `protocol_set_parser_mode` | `mode: "Passthrough" / "FieldDefinition" / "LuaScript"` | 设置解析模式 |
| `protocol_get_parser_mode` | 无 | 获取当前解析模式 |
| `protocol_set_field_definitions` | `fields: object[]` | 设置字段定义解析规则 |
| `protocol_get_field_definitions` | 无 | 获取字段定义解析规则 |
| `protocol_load_lua_script` | `script: string` | 加载 Lua 协议脚本 |
| `protocol_validate_lua_script` | `script: string` | 校验 Lua 协议脚本 |
| `protocol_get_templates` | 无 | 列出内置协议模板 |
| `protocol_apply_template` | `templateId: string` | 应用内置协议模板 |
| `protocol_get_lua_file_summary` | `filePath: string`, `resourceRoot?: string` | 汇总外部 Lua 协议文件信息 |
| `protocol_parse_data_with_lua_file` | `filePath: string`, `resourceRoot?: string`, `data: byte[]` | 使用指定 Lua 文件解析字节 |
| `protocol_encode_transaction_with_lua_file` | `filePath`, `resourceRoot?`, `transactionId`, `values?` | 由外部协议编码事务请求并返回路由 |
| `protocol_match_transaction_response_with_lua_file` | `filePath`, `resourceRoot?`, `transactionId`, `data` | 判断通知是否属于指定事务 |
| `protocol_execute_transaction_with_lua_file` | `filePath`, `resourceRoot?`, `deviceId`, `transactionId`, `values?`, `timeoutMs?`, `strict?` | 完成单次订阅、编码、写入、匹配、解析和订阅清理 |

`protocol_execute_transaction_with_lua_file` 是协议中立的一发一答事务工具。端点、写类型和帧均由
协议文件返回；等待期间会跳过 matcher 不命中的同端点通知，断连/超时/游标溢出会失败，成功或
失败后都会释放本次订阅。文件分片、批量 ACK、重启重连等多步流程仍应由项目测试脚本编排。

示例：

```json
{
  "mode": "LuaScript"
}
```

```json
{
  "filePath": "config/protocol/protocol-example.lua",
  "data": [1, 2, 3, 4]
}
```

### 4.8 配置与文件

| 工具 | 参数 | 说明 |
|---|---|---|
| `save_app_config` | `config: object` | 保存应用配置 |
| `load_app_config` | 无 | 读取应用配置 |
| `export_to_file` | `path: string`, `content: string` | 将文本写入指定文件 |
| `import_from_file` | `path: string` | 读取指定文件文本内容 |

示例：

```json
{
  "path": "E:\\Temp\\linkassist-export.txt",
  "content": "hello"
}
```

> 安全提醒：`export_to_file` 会写文件，`import_from_file` 会读文件。让模型调用这类工具前，应确认路径和内容符合预期。

## 5. 数据类型约定

### 5.1 字节数组

所有 `data` 字段均使用整数数组表示字节：

```json
[0, 1, 2, 3, 255]
```

约束：

- 每个元素必须是整数。
- 范围必须是 `0..=255`。

### 5.2 地址

TCP/UDP 地址一般使用：

```text
host:port
```

示例：

```text
127.0.0.1:9000
0.0.0.0:9000
```

### 5.3 UUID

BLE `serviceUuid` 和 `charUuid` 建议使用标准 UUID 字符串：

```text
0000180f-0000-1000-8000-00805f9b34fb
```

## 6. 调用示例

MCP 客户端通常不会让用户手写 JSON-RPC；以下示例用于理解协议层请求。

列出工具：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

调用 `greet`：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "greet",
    "arguments": {
      "name": "LinkAssist"
    }
  }
}
```

调用 `tcp_connect`：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "tcp_connect",
    "arguments": {
      "addr": "127.0.0.1:9000",
      "channelId": "tcp-client-1"
    }
  }
}
```

## 7. 已知限制

- 当前 MCP Bridge 只声明 tools 能力，不声明 resources/prompts。
- `tcp_receive`、`tcp_server_receive`、`udp_receive` 是兼容接口，当前返回空数据。
- `tcp_server_accept` 当前会返回错误说明，因为 TCP Server 已启用自动接受客户端。
- `ble_get_notifications_data` 和 `get_recent_events` 只能读取当前 Core 进程内的最近事件缓冲；过早的历史数据会因缓冲深度限制而不可见。
- BLE 能力依赖系统蓝牙适配器、权限、设备状态和 GATT UUID 是否正确。
- 串口能力依赖端口权限和端口未被其他程序占用。

## 8. 排障 checklist

1. 确认 `command` 是 LinkAssist 可执行文件的绝对路径。
2. 确认 `args` 包含 `--mcp-bridge`。
3. 修改客户端配置后，重启或重新加载 MCP server。
4. 在客户端中查看 MCP server 状态，例如 Claude Code 的 `/mcp` 或 `claude mcp list`。
5. 如果工具调用失败，先调用 `tools/list` 确认 LinkAssist 工具是否被发现。
6. 如果 Core 启动异常，检查 LinkAssist 日志和 `%LOCALAPPDATA%\\LinkAssist\\core-discovery.json` 附近的运行状态。
7. 文件读写工具失败时，确认路径存在、权限允许、路径转义正确。

## 9. 相关源码位置

| 文件 | 用途 |
|---|---|
| `src-tauri/src/main.rs` | 解析 `--mcp-bridge` / `--core-headless` 启动参数 |
| `src-tauri/src/mcp_bridge.rs` | stdio MCP JSON-RPC Bridge |
| `src-tauri/src/mcp_tools.rs` | MCP 工具定义与调用分发 |
| `src-tauri/src/core_http.rs` | Core HTTP 同步调用，以及通用后台提交/状态查询路由 |
| `src-tauri/src/discovery.rs` | Core 发现文件、健康检查和 headless Core 启动 |
