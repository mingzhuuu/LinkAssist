# LinkAssist 完整功能说明

核对日期：2026-10-19。范围：当前仓库的桌面应用、后端 Core、配置示例及自动化测试；不是设备兼容性认证。返回 [README](../README.md)，接口详表见 [REFERENCE](REFERENCE.md)。

## 1. 功能与入口总表

| 功能 | 用户入口 | 主要实现 | 输出与边界 |
|---|---|---|---|
| 通道管理 | 左侧通道列表、配置区 | `channelStore`、`LeftPanel`、连接 hooks | 逻辑通道与底层连接分离；配置可恢复，连接不会因恢复配置自动成为已连接 |
| BLE | BLE 通道面板、GATT Explorer | `useBle`、`ble/`、`commands/ble.rs` | 设备、服务、特征值、通知；依赖适配器/权限/设备能力 |
| UART | 串口通道面板 | `useSerial`、`serial/` | 参数配置、端口列表、TX/RX、关闭与错误事件 |
| TCP/UDP | TCP 通道的 client/server/udp 模式 | `useTcp`、`tcp/` | 多 TCP 客户端连接；当前 Core 的服务器和 UDP 管理器各维护一套监听/绑定状态 |
| 终端 | 下方终端、分离窗口 | `terminalStore`、`TerminalLeafPane` | 按通道和汇总显示、发送、命令历史、窗格布局 |
| 协议 | 协议配置、画布通道绑定的 Lua | `protocolStore`、`protocol/` | 解析字段、剩余字节、分组、编码与响应匹配 |
| 画布 | 画布工作区及编辑器 | `DisplayPanel`、`canvasStore`、各 renderer | table/chart/form/script 四类，支持布局与通道绑定 |
| Lua 自动化 | Script Canvas | `scriptRuntime`、`commands/script.rs` | 步骤、变量、CSV、日志、交互 UI、受控 Helper |
| 生命周期 | table/chart/form 的生命周期脚本配置 | `canvasLifecycleRuntime` | 初始化、周期、结束动作；格式见专用指南 |
| 外部测试 | Script Canvas 的测试示例 | `testRunnerApi`、`test_runner.rs` | catalog、profile、精确用例、状态、日志、取消 |
| MCP | 设置中的 MCP 工具、`--mcp-bridge` | `mcp_bridge`、`core_http`、`mcp_tools` | stdio Tools、本机 HTTP 转发、Lua 自定义工具 |
| 持久化 | 自动保存、设置与布局预设 | `usePersistence`、`persistence.rs` | 配置 JSON；不保存实时字节缓冲和实际连接 |
| 便携快照 | CLI `snapshot <output>` | `snapshot.rs` | 配置与资源嵌入 EXE；不包含外部执行环境 |

## 2. 通道与通信

### 逻辑通道

通道类型只有 `ble`、`serial`、`tcp`；TCP 客户端、服务器和 UDP 是 `tcp` 通道配置中的三种模式。不能把界面上建立多个 UDP 通道理解成后端已经支持多个独立 UDP socket。

每个逻辑通道保存名称和配置。底层连接产生独立 connectionId，前端通过 connectionMap 路由事件，并将通道绑定登记到 Rust `ChannelRegistry`，供本地工具解析通道。注册是异步 best-effort，发送前仍需验证连接是否存活。

### BLE

1. 建立 BLE 通道并开始扫描；可按设备信息筛选，查看名称、广播信息、RSSI、服务及外观信息。
2. 连接明确的设备 ID，发现 GATT 服务与特征值；UI 中可查看配对状态及 UUID 名称。
3. 根据特征属性执行读取、写入和通知订阅。MCP 写入支持 `auto`、`withResponse`、`withoutResponse`；省略时保留旧的有响应行为。
4. 实时通知通过 `ble-notification-received` 进入终端与画布。Core 维护近期事件和通知订阅持有者。
5. MCP 可先调用 `event_checkpoint`，再以游标调用 `ble_wait_notification`；溢出、未来游标和断开有明确结果，不能把无数据视为操作成功。

设备名称可能为空，不应以名称代替设备 ID。服务/特征存在不表示对应读写一定被固件接受；真实连接、订阅、重连和吞吐量需要设备验证。

### UART / 串口

选择端口、波特率、数据位、停止位、校验、流控和超时后打开连接。发送字节使用数字数组；终端可输入 HEX 或 ASCII。后端读取任务发出数据、错误和关闭事件；兼容的串口读取接口使用有界接收缓冲，其语义不同于网络空实现接口。

验收关注：错误端口能返回错误；关闭后状态和映射被清理；持续接收不应阻止发送；旧配置的流控值能正常迁移。真实串口需检查驱动、占用和权限。

### TCP 客户端 / 服务器 / UDP

| 模式 | 基本流程 | 限制 |
|---|---|---|
| TCP client | 地址连接 → connectionId → 发送/事件接收 → 断开 | TCP 是字节流，一次读取不等于完整业务帧 |
| TCP server | 监听 → 自动接受客户端 → 按客户端或广播发送 | `tcp_server_accept` 是兼容入口，会提示已自动接受；不是手动 accept API |
| UDP | 绑定本地地址 → 指定目标地址发送 → 携带远端地址接收 → 解绑 | 当前单绑定管理器；接收 buffer 为 4096 字节，大报文需单独评估截断风险 |

`tcp_receive`、`tcp_server_receive`、`udp_receive` 保留兼容签名但返回空数据；实时接收走事件。活动事件没有明确通道 ID 时，网络端点匹配必须同时符合当前模式和非空地址。

## 3. 终端、保存命令与窗口

- 汇总 TERMINAL 显示跨通道来源标签；通道标签页显示本通道内容。关闭通道接收显示不等于停止底层收包、画布更新或汇总日志。
- 支持 ASCII/HEX、时间戳、输入前缀、自动滚动、发送历史、BLE 写入目标、TCP 服务器客户端和 UDP 目标。
- 保存命令支持分组、排序、配置集及导入导出；终端布局和命令快照分别由对应 store 管理。
- 窗格采用递归分割树，支持拖动标签、方向分割、合并、弹出和重新停靠。
- 分离窗口使用 `?detached=` 路由，`detach-ready` / `detach-init` 完成握手，`reattach-tab` 返回主窗口；每个窗口拥有自己的前端状态和监听生命周期。
- TX 在异步发送返回前记录，保证快速响应的 RX 不出现在 TX 前。TX 回显表示尝试发送，不能单独证明设备已收到。

主窗口与分离窗口共用事件类型和监听清理工具。界面侧监听失败会记录错误；还需真实 WebView 验证窗口反复打开/关闭时不重复显示数据。

## 4. 协议解析与事务

解析模式为 `Passthrough`、`FieldDefinition`、`LuaScript`。字段可描述偏移、大小端、数值、布尔、字节数组、UTF-8 字符串及显示格式。Rust `FieldValue` 使用非标记 JSON 值；前端必须保持对应 union。

Lua 协议文件提供字段摘要、解析、字段/事务编码和响应匹配。协议文件可配专用资源根目录，读取辅助文本受路径边界约束；具体合同见[协议指南](../config/protocol/protocol-configuration-guide.md)。

`protocol_execute_transaction_with_lua_file` 的当前自动执行路径面向 BLE：编码 → 订阅 → 游标检查点 → 写入 → 等待匹配响应 → 解析 → 释放订阅。不要据通用工具名推断已经支持所有传输的原子事务。

全局协议面板与画布绑定的 Lua 文件是两条配置路径；画布 parsed 模式通过绑定文件独立解析。解析失败应检查终端诊断、字段 ID、原始字节及所选资源目录。

## 5. 可视化画布

| 类型 | 输入 | 主要行为 |
|---|---|---|
| Table | 通道数据、原始提取或解析字段 | 行缓冲、字段/公式展示、表格布局 |
| Chart | 数值提取、原始/解析字段 | uPlot 折线/柱状/散点、暂停/恢复、视口/缩放、历史数据 |
| Form | 原始或解析字段、用户输入 | 数值展示、占位符、配置的发送操作 |
| Script | Lua 文档、CSV、通道别名、UI 输入 | 自动化状态、交互控件、步骤执行和日志 |

画布支持创建、激活、移动、缩放、吸附和布局恢复。BLE 通道绑定可指定服务/特征过滤。暂停或未激活画布的行为由各 runtime 控制，不能用终端显示开关代替。

当前有界设计：表格/表单行缓冲 500；表格/表单异步解析待处理队列 256；图表实时队列 256、暂停待处理包 5000、历史点 20000、默认渲染点上限 1200。超出队列容量可能丢弃旧样本，因此实时画布不是无损数据记录器。

## 6. Lua 自动化与测试工程

自动化文件使用 `-- linkassist:type = script` 标记。文件可定义 setup/steps/handlers/cleanup、通道别名、变量、CSV 输入输出、条件、循环、等待、重试、断言和 Helper。具体动作列表以[脚本教程](../config/script/script-configuration-guide.md)为准。

声明式 Script Canvas UI 提供工具栏、表单控件、区域布局、日志/数据视图和运行事件绑定。配置中可引用独立脚本或快照内置脚本。生命周期脚本适用于其他画布的初始化、周期操作与结束清理，见[生命周期指南](../config/script/canvas-lifecycle-guide.md)。

测试工程入口是 [script-test-run-example.lua](../config/script/script-test-run-example.lua)。工程需提供 `test_case/linkassist_runner.py`，并提供 Python 路径或工程内 `test_case/.venv`。应用不会自动安装 Python 依赖或退回系统 Python。

测试流程：加载 catalog → 选择 profile/精确 node ID → 填写声明的输入 → 确认必要的写入/破坏性操作 → 运行 → 查看状态/增量日志 → 取消或读取结果。catalogRevision 用于拒绝过期目录选择；输入类型包括文本、密码、文件和目录，业务语义由项目声明。

后端当前最多同时运行 1 个测试，保留 50 次历史、每次 2000 条日志。取消优先通知 Core 协作退出，再在宽限期后处理进程树。外部 bridge 是受信代码，单元测试不代表目标测试工程已经验证。

## 7. MCP 与无界面 Core

`--mcp-bridge` 提供 JSON-RPC stdio；`--core-headless` 运行隐藏 Core。Bridge 通过 discovery 找到本机服务，使用 token 调用 HTTP。Tools 可包含内置工具与配置启用的 Lua 工具；MCP 总开关和脚本 `exposeToMcp` 决定可访问性。

长时间工具可通过 HTTP `/mcp/tools/{name}/start` 启动，并查询 `/mcp/tool-executions/{execution_id}`。桥接 lease、UI 生命周期及正在执行的工具共同影响 Core 的退出时机。普通关闭窗口与退出后台 Core 不是同一个操作。

通道活动包含来源、传输、时间戳、通道/连接、字节和可选 runId/caseId；主窗口和分离窗口据此显示工具执行活动。`test` 来源的非 TX/RX 状态不写进协议帧终端。

Lua 禁用 `os`、`io`、`require`、`dofile`、`loadfile` 等全局能力；通过应用明确提供的 Helper/工具执行操作。不要通过开放 Lua 全局来绕过已有边界。

## 配置保存与快照

自动保存采用 300 ms 防抖，覆盖通道、UI、协议、BLE、串口、TCP、终端、保存命令、画布、MCP 共 10 个 store；toast 不持久化。高频包/扫描/图表运行时状态不应反复触发磁盘保存。

恢复配置时去除重复通道，迁移旧画布格式，校验终端布局及窗口位置，重置实时缓冲和连接状态。终端树的非法比例、重复/悬空节点、错误活动页及过深嵌套会被拒绝，保留默认布局。Rust 对新增可选配置字段使用 serde 默认值。

保存使用同目录唯一临时文件、写入与同步后替换，失败清理自己的临时文件；并发保存保持每份 JSON 完整，但仍是整份配置最后完成写入者生效，不做字段级合并。损坏 JSON 会尝试备份为 `.json.corrupt` 后使用默认值。

`LinkAssist.exe snapshot name` 等待防抖保存后检查配置稳定，生成 `name.exe`，打包当前引用的自动化、生命周期、协议、MCP、Helper 和嵌套 Lua 静态资源。输出已存在、静态资源缺失、无法解析的依赖或超过资源上限会失败。

资源上限：10000 个文件、256 MiB 资源、384 MiB 解压载荷。运行时 CSV 表达式可保留并报告未内嵌警告；日志、输出、Python 环境和测试工程不打包。快照首次启动释放到隔离目录；默认关闭 Script Canvas 自动运行和 MCP 总开关。快照路径迁移、跨机器运行仍需实际复测。

## 8. 功能验收边界

代码索引和自动化检查覆盖契约、状态及算法；本次实际结果见 [AUDIT](AUDIT.md)。设备收发、窗口交互、外部 pytest 工程、安装程序、macOS/Linux 和长时间负载见[手动验收矩阵](DEVELOPMENT.md#手动验收矩阵)，不得在没有实测时宣称全部通过。
