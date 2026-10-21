# LinkAssist Lua Protocol Script 使用说明

本文档说明 LinkAssist 协议脚本的 Lua 文件格式与使用方法。

## 1. 脚本放置与类型标志

将 `.lua` 文件放在任意本地路径。建议放在项目的 `config/protocol/` 目录下。

文件顶部必须声明：

```lua
-- linkassist:type = protocol
```

示例文件：

- `config/protocol/protocol-example.lua`

---

## 2. 双函数约定

Lua 脚本必须定义以下两个全局函数：

### 2.1 schema()

返回字段元信息，供 UI 字段下拉使用。

```lua
function schema()
  return {
    { id = "temperature", alias = "Temperature", name = "temperature", field_type = "Float32LE", description = "Temperature in Celsius" },
    { id = "humidity", alias = "Humidity", name = "humidity", field_type = "Float32LE", description = "Humidity %" },
  }
end
```

返回数组，每个元素包含：

| 字段 | 必填 | 说明 |
|------|-----|------|
| `id` | 是 | 稳定字段标识 |
| `alias` | 否 | UI 显示名 |
| `name` | 是 | 字段名 |
| `field_type` | 是 | 类型字符串 |
| `description` | 否 | 字段说明 |
| `extra` | 否 | 额外参数（如字符串长度） |

### 2.2 parse(data, len)

解析原始字节数据。

```lua
function parse(data, len)
  local fields = {}
  fields[#fields + 1] = { id = "temperature", value = read_float_le(data, 0) }
  return fields
end
```

参数：

- `data`: 字节数组（table，索引从 1 开始）
- `len`: 有效字节数

返回：字段值数组，每个元素包含 `id` 和 `value`。

也可以返回结构化 table，携带分组与未消费字节（用于粘包/半包的流式重组）：

```lua
function parse(data, len)
  return {
    fields = {
      { id = "temperature", value = read_float_le(data, 0) },
    },
    groups = {},
    -- 可选：报告未消费的尾部字节，等价于 FieldDefinition 解析器的 remainingBytes
    remaining = { data[len - 1], data[len] },
  }
end
```

`remaining`（别名 `remaining_bytes`）是字节数组 table；省略时视为全部消费。

> 性能与状态说明：按文件路径引用的协议脚本会缓存 Lua 虚拟机（文件 mtime/大小变化时自动重建）。因此脚本顶层的 `local` 状态在文件未修改期间**跨数据包保留**——可以配合 `remaining` 实现流式缓冲；如果需要每包全新状态，请在 `parse()` 开头自行重置。

---

## 3. 内置 Helper 函数

引擎预置以下读取函数：

| 函数 | 说明 |
|------|------|
| `read_u8(data, offset)` | 读取 UInt8 |
| `read_u16_le(data, offset)` | 读取 UInt16LE |
| `read_u16_be(data, offset)` | 读取 UInt16BE |
| `read_u32_le(data, offset)` | 读取 UInt32LE |
| `read_u32_be(data, offset)` | 读取 UInt32BE |
| `read_i8(data, offset)` | 读取 Int8 |
| `read_i16_le(data, offset)` | 读取 Int16LE |
| `read_i32_le(data, offset)` | 读取 Int32LE |
| `read_float_le(data, offset)` | 读取 Float32LE |
| `read_float_be(data, offset)` | 读取 Float32BE |
| `read_string(data, offset, maxLen)` | 读取字符串，遇 0 截断 |
| `bytes_to_hex(bytes)` | 字节数组转 hex 字符串 |
| `hex_to_bytes(hex)` | hex 字符串转字节数组 |
| `read_text_file(relativePath)` | 读取协议资源根内的 UTF-8 文件；禁止绝对路径和越界 |
| `file_mtime(relativePath)` | 返回协议资源根内文件的修改时间，缺失时为 `nil` |

文件脚本默认以自身目录作为资源根。适配器与数据包分离时，可在 Canvas 选择 **Resources**，
或在 Tauri/MCP 调用中传 `resourceRoot`。缓存键包含 `filePath + resourceRoot`，同一适配器可安全
加载不同数据包。数据包内部的热重载由适配器负责；推荐使用内容修订号，而不是只依赖秒级
mtime，并在新修订完整加载失败时保留上一个有效目录并报告诊断。
Canvas 的 table/form/chart 解析路径会把 Lua 异常和名为 `Diagnostics*` 的数据组写入对应通道
的 Terminal system log；相同诊断会去重，正常结果会清除去重状态，不再静默显示为空值。

---

## 4. 支持的 field_type

| 类型字符串 | 说明 |
|-----------|------|
| `UInt8` | 无符号 8 位 |
| `UInt16LE` / `UInt16BE` | 无符号 16 位 |
| `UInt32LE` / `UInt32BE` | 无符号 32 位 |
| `Int8` | 有符号 8 位 |
| `Int16LE` / `Int16BE` | 有符号 16 位 |
| `Int32LE` / `Int32BE` | 有符号 32 位 |
| `Float32LE` / `Float32BE` | 32 位浮点 |
| `Bool` | 布尔值 |
| `Utf8String` | 字符串，需配合 `extra` 指定长度 |
| `ByteArray` | 字节数组，需配合 `extra` 指定长度 |

---

## 5. 使用流程

### 5.1 创建画布

1. 在画布设置中选择 **Data Source**: `Parsed`
2. 点击 **Select Protocol File**
3. 选择 `.lua` 脚本文件
4. 若脚本从外部目录读取数据，点击 **Select root** 选择资源根
5. 文件加载成功后，UI 显示字段数量

### 5.2 绑定字段

- **Table**: 新增列 → 选择 `Parsed field`
- **Chart**: Series Extractor 选择解析字段
- **Form**: 行配置选择解析字段

---

## 6. 安全限制

Lua 运行时沙箱禁用以下系统级功能：

- `io`, `os.execute`
- `require`, `loadfile`, `dofile`, `load`
- `debug`
- `package`

只能使用预置的读取 helper 函数。

---

## 7. 示例说明

`config/protocol/protocol-example.lua` 包含：

- `packet_type`: 包类型，UInt8
- `device_status`: 设备状态位，UInt8
- `temperature`: 温度，Float32LE
- `humidity`: 湿度，Float32LE
- `pressure`: 气压，UInt32LE
- `battery_mv`: 电池电压，UInt16LE
- `alarm_active`: 告警状态，Bool
- `label`: 设备标签，Utf8String
- `raw_payload`: 原始数据，ByteArray

---

## 8. 注意事项

1. **偏移计算**: 手动计算，正确累加各字段字节长度
2. **越界检查**: 解析前检查 `len` 是否足够
3. **返回值**: `parse` 必须返回 `{ id, value }` 数组
4. **全局函数**: `schema` 和 `parse` 必须是全局函数（非 local）
5. **索引起始**: `data` 表索引从 1 开始（非 0）
