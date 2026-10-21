# LinkAssist Lua MCP Tool Script 编写说明

本文档说明如何为 LinkAssist 编写 **Lua MCP 工具脚本**。

适用场景：

- 在 LinkAssist 设置页的 **Advanced > MCP** 中添加自定义 Lua MCP 工具文件
- 通过 MCP 客户端（如 Claude Desktop / Claude Code / OpenCode / Codex 等）调用这些工具
- 在工具脚本内部直接解析数据，或调用其他协议解析脚本

---

## 1. 文件类型标志要求

MCP 工具脚本文件内必须显式声明类型标志：

- 在文件顶部加入一行注释：`-- linkassist:type = mcp`
- 文件扩展名建议使用 `.lua`

例如：

```lua
-- linkassist:type = mcp

function mcp_meta()
  return {
    name = "decode_sensor_packet",
  }
end
```

如果缺少该标志，或误填成其他类型（例如 `protocol` / `script`），LinkAssist 会在加载时直接报错。

> 当前不再按文件名前缀校验。真正的类型来源是文件内的 `linkassist:type` 标志。

---

## 2. 脚本定义方式

Lua MCP 工具脚本支持两种定义方式：

- **旧格式（单工具）**：`mcp_meta()` + `call(args)`
- **新格式（多工具）**：`mcp_tools()` + `call(tool_name, args)`

旧格式保持兼容；新格式允许**一个脚本暴露多个 MCP 工具**。

### 2.1 `mcp_meta()`（旧格式，单工具）

返回单个 MCP 工具元信息。

示例：

```lua
function mcp_meta()
  return {
    name = "decode_sensor_packet",
    description = "Decode sensor packet bytes with the current LinkAssist protocol parser.",
    input_schema = {
      type = "object",
      properties = {
        data = {
          type = "array",
          items = {
            type = "integer",
            minimum = 0,
            maximum = 255,
          },
        },
      },
      required = { "data" },
      additionalProperties = false,
    },
    protocol_file = "config/protocol/protocol-example.lua",
  }
end
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | MCP 工具名。必须唯一，且只能包含 ASCII 字母/数字、`_`、`-`、`.` |
| `description` | 否 | 工具说明，显示在 `tools/list` 中 |
| `input_schema` | 否 | JSON Schema，定义 `call(args)` 参数结构 |
| `protocol_file` | 否 | 给 `parse_configured_protocol_file(data)` 使用的协议脚本文件路径 |

说明：

- 后端目前支持 `input_schema` / `protocol_file`
- 兼容 camelCase 别名：`inputSchema` / `protocolFile`
- 如果没有提供 `input_schema`，默认是空 object schema
- 通用 `protocol_*_with_lua_file` 工具可选传 `resourceRoot`，供协议脚本的
  `read_text_file`/`file_mtime` 在独立数据目录中读取；不传时仍以协议文件目录为根。
- MCP 脚本注册项可同时保存外层 `protocolFile` 与 `protocolResourceRoot`。前者绑定通用协议
  适配器，后者绑定只读数据包；脚本元数据中的 `protocol_file` 仅在显式声明时覆盖外层绑定。

### 2.2 `mcp_tools()`（新格式，多工具）

返回一个数组，每一项都是一个 MCP 工具元信息对象。

示例：

```lua
function mcp_tools()
  return {
    {
      name = "decode_sensor_packet",
      description = "Decode bytes with the current parser.",
      input_schema = {
        type = "object",
        properties = {
          data = {
            type = "array",
            items = {
              type = "integer",
              minimum = 0,
              maximum = 255,
            },
          },
        },
        required = { "data" },
        additionalProperties = false,
      },
    },
    {
      name = "decode_sensor_hex",
      description = "Decode hex string with the current parser.",
      input_schema = {
        type = "object",
        properties = {
          hex = { type = "string" },
        },
        required = { "hex" },
        additionalProperties = false,
      },
    },
  }
end
```

字段说明与 `mcp_meta()` 返回对象一致。

---

### 2.3 `call(args)`（旧格式，单工具）

执行实际工具逻辑，并返回 Lua table。

示例：

```lua
function call(args)
  local data = args.data or {}
  local parsed = parse_current_protocol(data)

  return {
    ok = true,
    parsed = parsed,
  }
end
```

要求：

- 必须是全局函数（不能写成 `local function call(...)`）
- 参数 `args` 是一个 Lua table，对应 MCP 客户端传入的 JSON 参数
- 返回值必须能转换成 JSON（table / string / number / boolean / nil / 数组 / 对象）

---

### 2.4 `call(tool_name, args)`（新格式，多工具）

当脚本定义了 `mcp_tools()` 时，LinkAssist 会调用：

```lua
function call(tool_name, args)
  if tool_name == "decode_sensor_packet" then
    local data = args.data or {}
    return {
      ok = true,
      parsed = parse_current_protocol(data),
    }
  end

  if tool_name == "decode_sensor_hex" then
    local data = hex_to_bytes(args.hex or "")
    return {
      ok = true,
      parsed = parse_current_protocol(data),
    }
  end

  error("Unknown MCP tool: " .. tostring(tool_name))
end
```

要求：

- 必须是全局函数
- 第一个参数 `tool_name` 是当前被调用的 MCP 工具名
- 第二个参数 `args` 是 MCP 客户端传入的 JSON 参数
- 返回值必须能转换成 JSON

---

## 3. 可用 Helper 函数

LinkAssist 在 Lua MCP 工具运行时预置以下 helper：

| 函数 | 说明 |
|---|---|
| `bytes_to_hex(bytes)` | 字节数组转 hex 字符串 |
| `hex_to_bytes(hex)` | hex 字符串转字节数组 |
| `parse_current_protocol(data)` | 使用当前 LinkAssist 协议配置解析数据 |
| `parse_protocol_file(file_path, data)` | 使用指定协议 Lua 文件解析数据 |
| `parse_configured_protocol_file(data)` | 使用当前工具元信息里的 `protocol_file` 指定的协议脚本解析数据 |
| `get_current_channel()` | 返回当前通道信息，形如 `{ channelId = ... }` |
| `invoke_tool(name, args)` | 调用 LinkAssist 内置 MCP tool，并返回 JSON 结果 table |
| `sleep_ms(milliseconds)` | 阻塞当前 Lua MCP tool 指定毫秒数，适合做串口轮询间隔或设备 settle |
| `now_s()` | 返回当前 Unix 时间戳秒值（浮点），适合按真实时间窗口控制采样与超时 |
| `now_ms()` | 返回当前 Unix 时间戳毫秒值，适合按真实时间窗口控制采样与超时 |
| `get_session_state()` | 读取当前 Lua MCP 脚本的会话状态；同一脚本的多次 `tools/call` 可共享 |
| `set_session_state(value)` | 保存当前 Lua MCP 脚本的会话状态；`value` 必须可序列化为 JSON |
| `clear_session_state()` | 清除当前 Lua MCP 脚本的会话状态 |
| `open_current_channel()` | 用当前通道在 UI 中保存的配置建立连接（串口参数 / TCP 地址 / 上次连接的 BLE 设备），返回 `{ channelType, connectionId, alreadyOpen }`；连接已存在时直接复用 |
| `send(data)` / `send(data, opts)` | 向当前通道的活动连接发送字节数组，返回 `{ ok, bytesWritten, ... }`；需要通道已打开（UI 中打开的连接会自动登记，或先调用 `open_current_channel()`） |

其中：

- `data` 是 Lua table，表示字节数组，例如 `{ 1, 2, 3, 4 }`
- `parse_*` 返回解析结果对象（由 LinkAssist 协议解析器输出）
- `invoke_tool` 当前只允许调用 LinkAssist 内置 MCP tools，不允许递归调用当前 Lua MCP tool
- `sleep_ms` 会阻塞当前工具执行线程，适合设备控制脚本，不适合做长时间后台任务
- `now_s` 是新的首选时间 helper；如果脚本需要按秒做调度，优先使用它
- `now_ms` 适合配合 `sleep_ms` 做定时调度；如果单次 I/O 本身已超过采样周期，实际样本数会少于理论值，但总时长会更接近请求时长
- `get_session_state` / `set_session_state` / `clear_session_state` 的作用域是单个 Lua MCP 脚本文件；只要 LinkAssist Core 进程未重启，会话状态就能跨多次 `tools/call` 保持

### 3.1 send / open_current_channel 详解

`send(data, opts)` 按当前通道类型分派：

| 通道类型 | 行为 | 相关 `opts` 字段 |
|---|---|---|
| 串口 | 写入该通道打开的串口 | — |
| TCP 客户端 | 写入该通道的 TCP 连接 | — |
| TCP 服务端 | 默认广播到所有客户端（返回 `clients` 数）| `clientId` 指定单个客户端 |
| UDP | 发往通道配置的目标地址 | `addr` 覆盖目标地址（`"ip:port"`）|
| BLE | 写入指定特征 | `serviceUuid` + `charUuid`（必填），`withoutResponse = true` 可选 |

```lua
function call(args)
  -- 确保通道已打开（幂等：已打开时直接复用）
  local channel = open_current_channel()

  -- 串口 / TCP：直接发
  send({ 0x01, 0x02, 0xFF })

  -- UDP：覆盖目标地址
  send(hex_to_bytes("A1B2"), { addr = "192.168.1.50:9000" })

  -- BLE：必须指定写目标特征
  send({ 0x10 }, {
    serviceUuid = "0000ffe0-0000-1000-8000-00805f9b34fb",
    charUuid = "0000ffe1-0000-1000-8000-00805f9b34fb",
  })

  return { ok = true, channel = channel }
end
```

注意：

- 通道与连接的对应关系由 UI 打开连接时自动登记；headless 场景（Core 未开 UI）用 `open_current_channel()` 依据保存的配置建立连接
- BLE 的 `open_current_channel()` 只重连上次连接的设备，不会自动订阅通知
- 连接已断开时 `send` 会返回明确错误并清除失效登记，重新 `open_current_channel()` 即可

---

## 4. 协议解析的两种常见写法

### 4.1 方式一：直接使用当前协议解析器

适合场景：

- 当前 LinkAssist UI 已经选好了协议
- MCP 工具只是复用当前协议配置

```lua
function call(args)
  local data = args.data or {}
  local parsed = parse_current_protocol(data)

  return {
    ok = true,
    mode = "current-protocol",
    parsed = parsed,
  }
end
```

---

### 4.2 方式二：调用指定协议文件

适合场景：

- MCP 工具要固定绑定某个协议 Lua 文件
- 不依赖 UI 当前选中的协议

```lua
function mcp_meta()
  return {
    name = "decode_with_fixed_protocol",
    description = "Decode packet with a fixed Lua protocol file.",
    protocol_file = "config/protocol/protocol-example.lua",
  }
end

function call(args)
  local data = args.data or {}
  local parsed = parse_configured_protocol_file(data)

  return {
    ok = true,
    mode = "configured-protocol-file",
    parsed = parsed,
  }
end
```

也可以手动指定：

```lua
function call(args)
  local data = args.data or {}
  local parsed = parse_protocol_file(
    "config/protocol/protocol-example.lua",
    data
  )

  return {
    ok = true,
    parsed = parsed,
  }
end
```

---

## 5. 输入参数约定建议

MCP 工具脚本没有强制固定参数结构，但推荐把原始数据定义为：

```json
{
  "data": [1, 2, 3, 4]
}
```

推荐 schema：

```lua
input_schema = {
  type = "object",
  properties = {
    data = {
      type = "array",
      items = {
        type = "integer",
        minimum = 0,
        maximum = 255,
      },
    },
  },
  required = { "data" },
  additionalProperties = false,
}
```

这样更适合协议解析类工具。

如果你使用多工具脚本，可以让不同工具声明不同的 `input_schema`，例如一个收 `data: byte[]`，另一个收 `hex: string`。

---

## 6. 安全限制

Lua MCP 工具运行在沙箱中，以下能力被禁用：

- `io`
- `loadfile`
- `dofile`
- `require`
- `load`
- `debug`
- `package`
- `os.execute`
- `os.remove`
- `os.rename`
- `os.tmpname`
- `os.exit`

因此：

- 不要尝试从 Lua 内部自己读写文件
- 不要尝试 `require()` 其他模块
- 协议解析应通过 LinkAssist 注入的 helper 完成

---

## 7. 返回值建议

建议返回结构化对象，例如：

```lua
return {
  ok = true,
  parsed = parsed,
  raw_hex = bytes_to_hex(data),
}
```

而不是只返回字符串。这样 MCP 客户端更容易消费结果。

---

## 8. 完整示例文件

仓库示例：

- `config/mcp/mcp-tool-protocol-inspector.lua`

该示例展示：

- `mcp_meta()` 的写法
- `call(args)` 的写法
- `parse_current_protocol(data)`
- `parse_configured_protocol_file(data)`
- `bytes_to_hex(data)`
- `get_current_channel()`

---

## 9. 常见错误

### 9.1 文件类型标志不合法

错误示例：

```text
Lua MCP tool file is missing required marker '-- linkassist:type = mcp'
```

解决：

- 在文件顶部增加：`-- linkassist:type = mcp`
- 如果当前文件其实是协议脚本或自动化脚本，请改用对应入口加载它，而不是放到 MCP 设置里

---

### 9.2 缺少 `mcp_meta()`

错误示例：

```text
Lua MCP tool script must define a global 'mcp_meta' function
```

解决：

- 增加全局 `mcp_meta()` 函数

---

### 9.3 缺少 `call(args)`

错误示例：

```text
Lua MCP tool script must define a global 'call' function
```

解决：

- 增加全局 `call(args)` 函数

---

### 9.4 `parse_configured_protocol_file(data)` 失败

错误示例：

```text
No protocolFile is configured for this MCP tool
```

解决：

- 在 `mcp_meta()` 中设置 `protocol_file`
- 或改用 `parse_protocol_file(file_path, data)`

---

## 10. 推荐开发流程

1. 先写好协议脚本（如果需要）
2. 再写 MCP 工具脚本，并在文件顶部加上 `-- linkassist:type = mcp`
3. 在 `mcp_meta()` 里声明：
   - `name`
   - `description`
   - `input_schema`
   - `protocol_file`（可选）
4. 在 LinkAssist 设置页中添加这个 Lua MCP 文件
5. 确认设置页元数据预览加载成功
6. 启用 `Expose to MCP`
7. 在 MCP 客户端中调用该工具
