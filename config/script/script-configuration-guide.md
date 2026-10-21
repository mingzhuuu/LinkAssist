# Script Canvas Lua 自动化脚本使用教程

Script Canvas 是 LinkAssist 的自动化测试画布。它通过 Lua table 描述测试流程，通过 CSV 动态加载测试数据，运行时自动创建 UI Channel，并复用现有 Serial / TCP Client / UDP 通信能力。

## 1. 创建 Script Canvas

1. 在右侧画布区域右键，选择 **Add Canvas**。
2. 打开画布配置窗口。
3. 将 **Canvas Type** 设置为 **Script**。
4. 选择 Lua 来源：
   - **Inline Lua**：直接在画布中编辑脚本。
   - **Lua File Path**：从磁盘选择 `.lua` 文件。
5. 点击 **Save**。
6. 在 Script Canvas 中点击 **Run** 执行。

## 2. Lua 基本结构

```lua
-- linkassist:type = script

return {
  version = 1,
  name = "My Automation Test",
  description = "Optional description",

  defaults = {
    stopOnFailure = true,
    timeoutMs = 2000,
    dataFormat = "hex",
  },

  variables = {
    port = "COM3",
    baudRate = 115200,
  },

  csv = {
    commands = {
      path = "config/script/script-serial-rpm-commands.csv",
      encoding = "utf-8",
      header = true,
    },
  },

  setup = {
    {
      id = "open-uart",
      action = "open",
      channel = "uart1",
      channelType = "serial",
      name = "RPM UART",
      params = {
        path = "${port}",
        baudRate = "${baudRate}",
        dataBits = 8,
        stopBits = 1,
        parity = "none",
        flowControl = "none",
      },
    },
  },

  steps = {
    {
      id = "run-csv",
      action = "forEachCsv",
      source = "commands",
      rowAs = "row",
      steps = {
        {
          id = "send-${row.name}",
          action = "send",
          channel = "uart1",
          data = {
            format = "hex",
            value = "${row.sendHex}",
          },
        },
        {
          id = "delay-${row.name}",
          action = "delay",
          durationMs = "${row.delayMs}",
        },
      },
    },
  },

  teardown = {
    {
      id = "close-uart",
      action = "close",
      channel = "uart1",
    },
  },
}
```

## 3. 顶层字段说明

| 字段 | 必填 | 说明 |
|---|---:|---|
| `version` | 是 | 当前建议固定为 `1`。 |
| `name` | 是 | 脚本名称，会显示在运行状态和报告中。 |
| `description` | 否 | 脚本说明。 |
| `defaults` | 否 | 默认超时、失败策略、数据格式等。 |
| `variables` | 否 | 变量表，可通过 `${name}` 引用。 |
| `helpers` | 否 | 命名的纯 Lua Helper；可内嵌在当前 Script，或引用外部 Helper 文件。设备协议、校验与换算不写进 Runtime。 |
| `csv` | 否 | CSV 数据源声明。运行时按路径动态读取文件。 |
| `csvLog` | 否 | 业务 CSV 日志输出声明。 |
| `setup` | 否 | 主测试前执行，通常用于打开通道。 |
| `steps` | 否 | 主测试步骤。 |
| `onStop` | 否 | 手动停止后执行。 |
| `teardown` | 否 | 收尾步骤。即使测试失败，也会尝试执行。 |

> 如果脚本来源是文件，文件顶部必须加上：`-- linkassist:type = script`。

## 4. 变量与 CSV 引用

### 4.1 普通变量

```lua
return {
  variables = {
    port = "COM3",
    baudRate = 115200,
  },
  setup = {
    {
      action = "open",
      channel = "uart1",
      channelType = "serial",
      params = {
        path = "${port}",
        baudRate = "${baudRate}",
      },
    },
  },
}
```

### 4.2 CSV 数据源

```lua
return {
  csv = {
    commands = {
      path = "E:/test-data/commands.csv",
      encoding = "utf-8",
      header = true,
    },
  },
}
```

当前实现会使用 Tauri `import_from_file` 动态读取 CSV 文件。CSV 内容不会保存到 Canvas 配置中。

### 4.3 遍历 CSV

```lua
return {
  steps = {
    {
      action = "forEachCsv",
      source = "commands",
      rowAs = "row",
      steps = {
        {
          action = "send",
          channel = "uart1",
          data = {
            format = "hex",
            value = "${row.sendHex}",
          },
        },
        {
          action = "delay",
          durationMs = "${row.delayMs}",
        },
      },
    },
  },
}
```

交互脚本可增加 `loop = { ["$ref"] = "form.loop" }`；绑定值为 `true` 时会完整循环该 CSV，直到用户点击 Stop。

### 4.4 自动输出到 exe 目录

```lua
csvLog = {
  result = {
    path = "${runTimestamp()}.csv",
    baseDir = "executable",
    bom = true,
    header = false,
    columns = { "time", "rpm", "mode", "value" },
  },
}
```

`baseDir = "executable"` 会把单个安全文件名解析到当前 LinkAssist 可执行文件所在目录；`runTimestamp()` 在一次运行内保持不变，格式为 `yyyyMMdd_HHmmss_SSS`。每次运行创建新文件；默认先写表头，设置 `header = false` 后第一行直接写业务数据。中文内容建议增加 `bom = true`，让 Excel 按 UTF-8 正确打开文件。

## 5. 支持的通道类型

| `channelType` | 说明 | 底层能力 |
|---|---|---|
| `serial` | 串口 / UART | `open_serial_port`、`send_serial_data`、`serial-data-received` |
| `tcp-client` | TCP Client | `tcp_connect`、`tcp_send`、`tcp-data-received` |
| `udp` | UDP Socket | `udp_bind`、`udp_send`、`udp-data-received` |
| `ble` | BLE GATT | `connect_ble_device`、`write_ble_characteristic`、`subscribe_ble_notifications`、`ble-notification-received` |

Script Runtime 会在 `open` 时自动创建 UI Channel，并在脚本结束或停止时关闭并清理脚本创建的 Channel。

### 5.1 BLE `open` 参数

BLE 脚本步骤仍然使用 `action = "open"`，但 `params` 需要至少提供目标特征：

```lua
{
  action = "open",
  channel = "ftmsControl",
  channelType = "ble",
  name = "FTMS BLE",
  params = {
    deviceId = "AA:BB:CC:DD:EE:FF", -- 可选；为空时会尝试复用同名 BLE Channel 或该 Channel 的上次设备
    useActiveChannel = true, -- 可选；为 true 时优先复用当前选中的 BLE Channel
    channelId = "${form.bleChannelId}", -- 可选；按持久化 Channel ID 精确复用，断线时按保存配置重连
    serviceUuid = "00001826-0000-1000-8000-00805f9b34fb",
    charUuid = "00002ad9-0000-1000-8000-00805f9b34fb",
    subscribe = true, -- 默认 true
  },
}
```

- `serviceUuid` / `charUuid`：必填。
- `deviceId`：推荐填写。若留空，脚本会优先复用已有 BLE Channel 的当前连接或上次连接设备。
- `useActiveChannel`：可选。设为 `true` 时，脚本会直接使用当前选中的 BLE Channel；若当前选中项不是 BLE，则脚本报错。
- `channelId`：可选，Serial/BLE 等通道都可使用。脚本按 ID 精确复用现有 Channel；若软件重开后该 Channel 尚未连接，Serial 使用保存的端口配置重开，BLE 使用保存的上次设备重连。
- `subscribe`：默认 `true`。需要等待控制点应答或状态通知时保持默认即可。

## 6. 常用 Action

- `open`：打开通道
- `close`：关闭通道
- `read`：读取当前通道的一次数据
- `send`：只发送，不等待回复
- `wait`：等待指定响应
- `request`：发送并等待回复
- `delay`：延时
- `repeat`：重复执行子步骤
- `group`：组合步骤
- `forEachCsv`：遍历 CSV 数据源
- `set`：设置运行时变量
- `assert`：断言
- `log`：记录日志
- `logCsv`：写入业务 CSV 日志
- `luaHelper`：调用受限沙箱中的纯 Lua Helper，保存结构化结果
- `takeLatestPacket`：通用地获取某通道的最新数据包，可限制包龄并只消费一次
- `luaTool`：调用外部 Lua MCP 工具脚本中的结构化工具
- `testRun`：按项目测试目录提供的 catalog/profile/node ID 执行 pytest

所有 Action 都可设置 `when = { ["$ref"] = "form.channelId" }`。引用值为空、`false`、`0`、`no` 或 `off` 时跳过该步骤，适合按用户是否选择通道决定是否执行可选设备的 `open`、采集和 `close`。

`repeat.intervalMs` 是每轮执行完成后的间隔；需要不累加步骤耗时的固定采样节拍时，使用 `periodMs`。相邻 `repeat` 设置相同的 `schedule` 名称后会共享下一次目标时间，适合跨 CSV 控制行保持连续 1 秒采样。第一轮会在一个 `periodMs` 后执行。

串口响应可能分包时，可在 `wait` / `request` 的 `expect` 中同时设置 `accumulate = true`、固定 `length` 和 `startsWith`。Runtime 会累积数据、定位帧头并截取完整帧，再按到达顺序异步执行 `luaHelper` 校验；候选帧返回 `false` 时会继续检查后续数据。

### 6.1 `read`

当前 `read` 主要用于 BLE 读特征：

```lua
{
  id = "read-ftms-feature",
  action = "read",
  channel = "ftmsFeature",
  saveAs = "ftmsFeature",
}
```

- 执行前需要先用 `open` 打开对应 BLE 特征通道。
- `saveAs` 可选；设置后会保存为 `{ bytes, hex, text, length }`，便于后续 `log` / `assert` / helper 使用。
- 对于需要通知/指示的 BLE 特征，仍然应在 `open.params.subscribe = true` 时自动建立订阅；`read` 适用于显式可读的特征，例如 `Fitness Machine Feature (0x2ACC)`。

### 6.2 `luaHelper` 与 `takeLatestPacket`

设备私有协议、CRC、标定和字段解码使用纯 Helper。只供当前 Script 使用时，推荐直接内嵌：

```lua
-- 当前 Script 文件内定义；helpers() 和 call() 由 Helper 沙箱调用
local implementations = {
  torqueFrameValid = function(args)
    return { valid = validate_torque_frame(args.bytes) }
  end,
  torqueMeasurement = function(args)
    return decode_torque_measurement(args.sampleBytes, args.zeroBytes, args.toothCount)
  end,
}

function helpers()
  return { "torqueFrameValid", "torqueMeasurement" }
end

function call(name, args)
  local implementation = implementations[name]
  if implementation == nil then error("unknown helper: " .. tostring(name)) end
  return implementation(args or {})
end

return {
  version = 1,
  name = "Meter example",
  helpers = {
    bench = { embedded = true },
  },
  steps = {
    {
      action = "luaHelper",
      helper = "bench",
      func = "torqueMeasurement",
      args = {
        sampleBytes = { ["$ref"] = "torqueSample.bytes" },
        zeroBytes = { ["$ref"] = "zeroSample.bytes" },
        toothCount = { ["$ref"] = "form.torqueTeeth" },
      },
      saveAs = "measurement",
    },
    {
      action = "wait",
      channel = "torque",
      expect = {
        startsWith = "01 32 08",
        length = 13,
        accumulate = true,
        luaHelper = {
          helper = "bench",
          func = "torqueFrameValid",
          args = { bytes = { ["$ref"] = "packet.bytes" } },
          resultPath = "valid",
          equals = true,
        },
      },
    },
  },
}
```

内嵌 Helper 只能用于文件型 Script，并且只允许执行当前 Script 文件本身。需要被多个 Script
共享时，可以改用外部声明 `bench = { luaPath = "../script-helper/bench.lua" }`；外部 Helper 文件
必须以 `-- linkassist:type = script-helper` 开头。

两种形式都要定义 `helpers()` 与 `call(name, args)`，只能接收 JSON 参数并返回 JSON 可序列化
结果；沙箱不提供文件、进程、通道、MCP 或 session API。外部 Helper 的相对路径以主 Script
文件所在目录为基准；Inline Lua 没有来源文件，不能使用 `embedded = true`，应使用外部 Helper
绝对路径。

持续通知数据先由 Runtime 做通用的新鲜度和单次消费判断，再交给 Helper 解码：

```lua
{
  action = "takeLatestPacket",
  channel = "ftmsBikeData",
  maxAgeMs = 1500,
  consume = true,
  required = false,
  saveAs = "ftmsPacket",
}
```

结果包含 `available`、`reason`、`bytes`、`hex`、`text`、`length`，可用时还包含
`timestamp` 和 `sequence`。`required = true` 会在不可用、过期或已消费时直接使步骤失败。

`luaTool` 与 `luaHelper` 用途不同：`luaTool` 面向需要调用 LinkAssist 工具或通道的完整 MCP
操作；`luaHelper` 只做高频、无副作用的编码、校验、解析和换算。

### 6.3 `testRun`

`testRun` 通过 LinkAssist 的受控 Test Runner 调用项目中的 pytest bridge。它不是 shell
步骤：脚本不能提供任意命令行，只能选择项目、profile、pytest node ID 和运行时输入。

```lua
{
  id = "pytest-smoke",
  action = "testRun",
  projectRoot = "D:/Workspace/my-project",
  pythonPath = "D:/Workspace/my-project/test_case/.venv/Scripts/python.exe", -- 可选
  profile = "quick",
  nodeIds = { "tests/test_cases.py::test_project_case[example]" }, -- 可选，以 catalog 返回值为准
  inputs = { DEVICE_ID = "device-1" }, -- 可选，由 profile 定义
  catalogSource = "catalog", -- 交互画布可据 catalog 自动识别危险级别
  catalogRevision = { ["$ref"] = "catalog.catalogRevision" }, -- 推荐：固定 Load 的目录
  saveAs = "pytestResult",
}
```

- `projectRoot`：必填，项目根目录；项目必须提供 `test_case/linkassist_runner.py`。
- `pythonPath`：可选；省略时后端只查找项目自己的 `test_case/.venv`，不会自动安装依赖或退回系统 Python。
- `profile`：可选，catalog 中定义的分类。未给 `nodeIds` 时运行整个 profile。
- `nodeIds`：可选，catalog 返回的精确 pytest node ID。`selectionMode = "exact-or-profile"`
  时，当前 profile 内的勾选项作为精确子集；没有有效勾选时运行整个 profile。项目 bridge 可在
  profile 上返回显式 `nodeIds` 成员集合，LinkAssist 据此过滤，不解析 pytest marker 表达式。
- `inputs`：可选，只传给 catalog 的 profile/测试声明的运行时输入，不写入 LinkAssist 配置。
  catalog 可选返回 `inputDefinitions`，按输入名声明通用 `text/password/file/directory` 类型、
  标签、提示、说明和文件扩展名。`testInputs` 会据此显示文件/目录选择器并把选中的绝对路径
  原样传给 bridge；LinkAssist 不根据项目输入名猜测业务含义。没有定义时回退文本框。
- `allowDestructive`：为 `true` 只表示请求本次写入/破坏性运行；每次执行仍弹出确认，
  确认不会持久化。只有 `destructive` flow 会进一步获得协议包要求的 `confirm`。
- `catalogSource`：可选，指向已经加载的 catalog。交互画布按当前 profile/精确用例计算危险级别；
  `write`/`destructive` 在点击 Run 时弹出一次确认并自动传递本次授权，不需要额外授权复选框。
- `catalogRevision`：推荐原样传回前一个 `testCatalog` 的值。若 Load 后测试源码或外部协议包
  已变化，bridge 拒绝旧选择并要求 Reload，避免 node ID 和危险级别漂移。
- `saveAs`：保存最终 run snapshot，可通过 `${pytestResult.status}` 等路径读取。
- Canvas 的 Stop 会调用 `cancel_test_run`。对于带 executionId 的 Core Lua flow，后端先发出
  协作取消，让流程进入 cleanup；超过宽限期后才兜底结束 pytest 进程树。
- 项目 bridge 是会执行代码的受信边界；只加载你信任的工程根目录。LinkAssist 会固定调用
  `test_case/linkassist_runner.py` 且不接受 shell/argv 注入，但不会替你审计该文件内容。
- 测试选择和执行界面只存在于 Script Canvas，不再提供标题栏 Test Runner。推荐直接加载
  `config/script/script-test-run-example.lua`，catalog/profile/用例均由画布动态读取。

### 6.4 声明式 Script Canvas UI

交互脚本可以增加 `ui` 和 `handlers`。`ui` 只定义显示和输入控件，按钮通过 `action`
调用同名 handler；协议、测试收集与执行语义仍属于外部协议包和项目 `test_case`。

当前只支持两种双区域布局：

- `left-right`：左侧选择/配置，右侧进度/结果，支持拖动分隔线。
- `top-bottom`：上方操作，下方输出，支持拖动分隔线。

不支持 `top-middle-bottom` 和 `left-center-right`。布局的 `regions` 必须恰好引用两个区域。

常用输入控件包括 `text`、`search`、`number`、`file`、`directory`、`checkbox`、
`select`、`multiSelect` 和 `button`；pytest 专用展示控件包括 `testCases`、`testInputs`、
`runSummary`、`testResults`、`stepList`、`logViewer`、`historyList`。
`testCases.profileBind` 可绑定当前 profile；当 catalog profile 提供 `nodeIds` 时，用例列表和
`All/Clear/Invert` 仅作用于该分类。切换分类后遗留的隐藏勾选不会覆盖新的 profile。

`persist = true` 只保存该控件绑定的数据，并由 `ui.stateVersion` 控制兼容性。普通 pytest
运行时输入可按字段保存；`password`、catalog 中显式设置 `persist = false` 的字段、日志及
一次性写入/破坏性授权不会持久化。数组或对象参数使用
`{ ["$ref"] = "form.nodeIds" }` 形式传给 action，避免字符串插值破坏类型。

`ui.restore = { action = "loadCatalog", whenBind = "form.projectRoot" }` 可在应用恢复了持久化
值后执行一次声明的 handler，用于重新生成 catalog 等派生状态。`whenBind` 为空时不执行；
恢复动作不会自动运行测试、打开通道或继承一次性授权，脚本应只在这里声明可信的读取动作。

`ui.toolbar` 接受紧凑的 `button`、`select` 和 `checkbox`，并按声明顺序显示在画布右上角。通道下拉框可把 `options.source` 设为 `app.channels.serial` 或 `app.channels.ble`，列出左侧通道列表中的全部同类型 Channel（包括尚未打开或已断开的通道）；`app.openChannels.serial` / `app.openChannels.ble` 仍可用于只显示已连接通道。配合 `persist = true` 会把所选 Channel ID 保存到当前 Script 画布；运行时 Serial 使用该 Channel 保存的端口配置打开，BLE 使用该 Channel 上次连接的设备自动重连。可编辑的 Serial 选择框也可直接输入 `29` 或 `COM29`；运行时会统一按 `COM29` 查找并复用已有配置通道，仅在没有匹配通道时新建通道。

`ui.showHeaderInfo = false` 会隐藏工具栏前的脚本名称、活动 handler 和运行状态，让第一个 toolbar 控件从标题原位置开始排列。

区域内多个控件需要保持在同一行时，可设置 `controlsLayout = "row"`；控件按声明顺序排列，空间不足时横向滚动。

- `loadedSource` + `loadedLabel`：指定变量存在后切换名称，例如 `Load → Reload`。
- `runningHandler` + `runningLabel` + `runningAction`：指定 handler 运行时切换动作，例如
  `Run → Stop/$stop`。
- `reloadDocument = true`：点击时先重新解析当前 Lua 文件，再执行按钮 handler。
- `directoryPicker = true` + `bind`：按钮执行前打开目录选择器，把结果写入绑定变量；与
  `persist = true` 组合后可把 Project root 完全集成到 `Load/Reload` 按钮并记住上次目录。
- `align = "end"`：把该 toolbar 控件推到工具栏最右侧，适用于 `button`、`select` 和
  `checkbox`，例如让「运行」按钮与前面的通道选择控件分开、贴右排列。
- `allowEmpty = false`：select 下拉框不显示第一行的空选项 `Select…`，toolbar 与区域内的
  下拉框均适用；可编辑下拉框仍可通过清空输入框清除所选值。

区域控件的 `inlineLabel = true` 会把标签和输入框放在同一行；`compact = true` 让控件在 `row` 布局中按内容宽度排列；`grow = true` 会占用剩余
高度，适合下方日志框。`historyList` 可用 `collapsed = true` 默认折叠，并用
`refreshAction` 在展开时刷新；刷新会保留现有 Live Log。`logViewer` 使用主界面的主题色变量，
不会固定为深色背景。`logViewer` 设置 `errorOnly = true` 时只显示失败和错误日志；再设置
`hideWhenEmpty = true`，没有异常时整个日志控件保持隐藏。
标准 pytest 模板不显示独立的步骤/结果面板，步骤状态和结构化 pytest 结果统一进入日志。
模板不显示 Project root 或 `pythonPath` 输入框：`Load/Reload` 点击后选择 Project root，
Python 固定使用所选项目自己的 `test_case/.venv`。模板左栏依次显示行内 Profile、
框内 Test cases 标题与运行时输入，不显示授权复选框；写入/破坏性选择在点击 Run 时做一次确认。
标准模板不提供用例过滤框。右栏在主题化日志框上方使用
同样的主题边框展示实时测试进度、通过/失败/阻塞/跳过/错误计数和当前用例，不显示 History
或下拉箭头。

pytest 交互 handler 可使用：

- `testCatalog`：加载项目固定 bridge 暴露的 catalog；支持的 bridge 应返回内容派生的
  `catalogRevision`。
- `testRun`：执行 profile 或精确 node ID；`selectionMode = "exact-or-profile"` 表示勾选
  用例时忽略 profile，否则运行 profile。
- `testHistory`：加载当前 LinkAssist 进程保存的运行历史。
- `$stop`：按钮内置动作，取消当前 Script Runtime 和活动 pytest run。

## 7. 示例文件

- Lua：`config/script/script-serial-rpm-example.lua`
- Lua：`config/script/script-ble-ftms-spin-down.lua`
- Lua：`config/script/script-test-run-example.lua`
