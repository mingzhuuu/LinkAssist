# Table / Chart / Form Canvas Lifecycle Lua 脚本

Canvas Lifecycle Lua 用于 table、chart、form 画布在激活、反激活以及激活期间持续执行操作，例如激活时发送初始化指令、激活期间每 1 秒轮询一次、反激活时发送结束指令。

## 文件约定

- 文件名必须使用 `canvas-lifecycle-` 前缀，例如 `canvas-lifecycle-init-end.lua`。
- 文件顶部必须声明：

```lua
-- linkassist:type = canvas-lifecycle
```

这两个约定用于和现有 `script-*.lua` 自动化脚本、`protocol-*.lua` 协议脚本区分。

## 基本结构

```lua
-- linkassist:type = canvas-lifecycle

return {
  version = 1,
  name = "Canvas Init / End",

  defaults = {
    stopOnFailure = true,
    timeoutMs = 2000,
    dataFormat = "hex",
  },

  onActivate = {
    {
      action = "send",
      channel = "canvas",
      data = { format = "hex", value = "01 03 00 00" },
    },
  },

  whileActive = {
    intervalMs = 1000,
    steps = {
      {
        action = "send",
        channel = "canvas",
        data = { format = "hex", value = "01 03 00 00 00 02" },
      },
    },
  },

  onDeactivate = {
    {
      action = "send",
      channel = "canvas",
      data = { format = "hex", value = "01 03 FF FF" },
    },
  },
}
```

## 触发时机

| Hook | 触发 |
|---|---|
| `onActivate` | 画布从 inactive 变为 active |
| `whileActive` | `onActivate` 完成后开始循环执行，直到画布反激活；`intervalMs` 为两轮之间的间隔 |
| `onDeactivate` | 画布从 active 变为 inactive，包括通道主动断开导致的自动反激活 |

首次加载已处于 active 的画布不会自动触发 `onActivate`，只有状态发生变化时触发。

## 默认通道别名

Lifecycle runtime 会把当前画布关联的通道预绑定给 Lua：

| Alias | 含义 |
|---|---|
| `canvas` | 第一个关联通道 |
| `ch1` | 第一个关联通道 |
| `ch2` | 第二个关联通道 |
| `ch3` | 第三个关联通道 |

因此单通道画布通常直接写 `channel = "canvas"` 即可。

## 支持的 action

Lifecycle 脚本复用 Script Canvas 的步骤格式，常用 action 包括：

- `send`
- `wait`
- `request`
- `delay`
- `group`
- `set`
- `assert`
- `log`

如果脚本需要额外打开临时通道，也可以使用 `open` / `close`；画布预绑定通道不会被 runtime 自动关闭。

## 示例

- `config/script/canvas-lifecycle-init-end-example.lua`
- `config/script/canvas-lifecycle-poll-1s-example.lua`
- `config/script/canvas-lifecycle-form-motor-init-stop.lua`
- `config/script/canvas-lifecycle-chart-torque-init-calibrate.lua`
- `config/script/canvas-lifecycle-torque-sensor-32h-read.lua`

电机 Form 画布只绑定电机通道时，请使用 `canvas-lifecycle-form-motor-init-stop.lua`。`canvas-lifecycle-chart-torque-init-calibrate.lua` 需要两个通道：`ch1` 为电机，`ch2` 为扭矩传感器。
