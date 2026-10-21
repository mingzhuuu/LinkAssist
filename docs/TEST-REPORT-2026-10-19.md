# LinkAssist 测试与用例评估（2026-10-19）

本次对当前工作区运行静态检查、前端与 Rust 测试、Windows 原生构建和真实回环接口测试，补充测试用例并修复两个端口重绑缺陷。开始时工作区已有未提交修改，本报告针对这些修改叠加后的实际工作区，不代表某个已提交版本。

## 执行结果

| 检查 | 实际结果 | 范围与证据 |
|---|---|---|
| `npm run check` | 通过 | 架构检查、TypeScript、Vite、43 个文件 / 302 个前端用例；`logs/frontend-check-final.log` |
| 架构契约 | 通过 | 72 个命令、56 个内置 MCP 工具、103 个字面量 invoke，0 个动态 invoke；已刷新 REFERENCE |
| 前端随机顺序 | 302 通过 | `--sequence.shuffle --sequence.seed=20261019 --maxWorkers=4`；`logs/vitest-shuffled.log` |
| `cargo test` | 167 通过，4 默认忽略 | 包含协议/Lua、FTMS grade helper、配置并发写入、快照、事件缓冲与 Core 生命周期；`logs/rust-tests-final.log` |
| 显式进程取消测试 | 额外 1 项通过 | 指定 Python 后单独运行默认忽略的取消测试；沙箱外验证自己的测试子进程被终止 |
| `cargo build --bin linkassist` | 通过 | 当前源码的 Windows debug 二进制 |
| `npm run tauri build -- --debug --no-bundle` | 通过 | 内嵌前端的 Windows 调试版 EXE；没有生成或安装 MSI/NSIS；`logs/tauri-build.log` |
| `npm run test:integration` | 7 项通过 | 在上述 Tauri 构建产物上复测；`logs/core-smoke-final.log` |
| `git diff --check` | 通过 | Git 的 CRLF 转换提示不属于空白错误 |
| `registries` 原始工作区 `cargo test` | 4 通过，2 失败 | 两个 blocklist 文件检出为 CRLF，校验器明确拒绝 CRLF |
| 注册表 LF 对照实验 | 6 项通过 | 在 `logs/registries-lf` 中仅转换副本换行后，运行同一个测试二进制；未修改上游数据 |

日志与临时快照位于 Git 忽略的 `logs/`。前端 302 项和随机顺序复测是同一批用例，不叠加计算。Rust 常规测试中的 4 个忽略项，有 1 项已显式验证，其余 3 项仍需要外部测试工程。

环境：Windows、Node.js 24.14.1、npm 11.11.0、rustc/cargo 1.94.1；取消测试使用 Python 3.12.14。

## 已发现并修复的产品问题

| 问题 | 复现与原因 | 修复与回归证据 |
|---|---|---|
| TCP 服务端立即重绑同端口失败 | `tcp_server_start` 再次使用相同地址时出现 Winsock 10048。`abort()` 只请求取消，旧 accept 任务仍可能持有监听套接字 | [server.rs](../src-tauri/src/tcp/server.rs) 在取消后等待任务结束。真实客户端收包、断开后连续 5 次重绑及 stop/start 均通过 |
| UDP 立即重绑同端口失败 | `udp_bind` 再次使用相同地址时出现 Winsock 10048。读任务仍持有旧 socket 的 `Arc` | [udp.rs](../src-tauri/src/tcp/udp.rs) 等待读任务取消完成，再释放 manager 持有的 socket。真实数据报、连续 5 次重绑、解绑后发送失败均通过 |

两项修复均由新增集成测试先复现失败，再在修复后验证通过；没有通过增加重试或休眠掩盖端口释放问题。

## 用例评估与本次优化

新增 **32 个前端用例** 和 **7 个原生集成用例**，保留原有正常路径断言。

| 区域 | 原有薄弱点 | 本次改进 |
|---|---|---|
| 事件订阅 | 单次卸载测试不足以覆盖重新挂载与旧异步注册交错 | [eventSubscriptions.test.ts](../src/__tests__/eventSubscriptions.test.ts) 增加 3 项：新旧 scope 隔离、局部注册失败不影响健康订阅、迟到 cleanup 抛错只报告一次 |
| 配置恢复 | 终端布局已有检查，但通道显示设置和 BLE 重连元数据缺乏直接测试 | [persistenceValidation.test.ts](../src/__tests__/persistenceValidation.test.ts) 增加 26 项：重复 split ID、损坏 tab 字段、空布局 JSON 往返、非法设置、整组拒绝、无别名输出、BLE 历史字段兼容和畸形输入 |
| 关闭与持久化 | 未验证重复关闭、native destroy 失败后的重试、卸载后的待保存任务 | [usePersistenceClose.test.tsx](../src/__tests__/usePersistenceClose.test.tsx) 增加 3 项；清理时先卸载、再恢复真实计时器和 spies |
| MCP 设置组件 | 固定休眠 20 ms 对重渲染时机敏感 | [SettingsDialogMcpMeta.test.tsx](../src/__tests__/SettingsDialogMcpMeta.test.tsx) 改为在失败更新完成后显式重新渲染，再断言没有 IPC 重试 |
| 简洁模式组件 | 原有测试存在 React 更新未包裹 `act(...)` 的警告 | [SimpleMode.test.tsx](../src/__tests__/SimpleMode.test.tsx) 等待异步渲染与用户操作完成，保留可见状态断言；最终完整运行无已观察到的 act 警告 |
| 网络与 MCP | 单元测试没有验证实际套接字资源释放；mock 不能发现端口占用竞态 | 新增 [core-smoke.mjs](../scripts/core-smoke.mjs) 与 `npm run test:integration`，使用真实 EXE、临时独立快照、随机回环端口和真实字节比较 |
| 测试独立性 | Zustand store 和 mock 可能造成顺序依赖 | 对全套前端测试使用固定种子打乱顺序，302 项通过；这是一次确定性顺序检查，不等价于穷尽所有排列 |

原生接口测试覆盖：

1. Core HTTP 缺少 token / 错误 token 拒绝，正确 token 成功。
2. 工具名唯一、必要工具存在、未知工具与缺参拒绝、非法字节在参数校验阶段被拒绝。
3. TCP 客户端向独立本机 peer 发送精确二进制数据，连接列表、主动断开和断开后发送失败。
4. TCP 服务端自动接受连接、发送精确数据、检测 peer 关闭、立即重绑与 stop/start。
5. UDP 数据报内容与源端口、立即重绑、解绑后拒绝发送。
6. 异步工具执行由 running 进入 completed，结果可查询，未知执行 ID 返回 404。
7. MCP stdio initialize、notification 无回复、ping、未知方法错误、tools/list 和 tools/call；调用结果与 HTTP 一致，EOF 后 bridge 正常退出。

测试脚本只使用自身快照对应的 discovery/PID，关闭自身创建的进程和套接字，不连接用户已有 Core 或外部设备。它不自动构建，源码变化后需先重新编译。

## 环境问题与未完成验证

- Windows 沙箱默认临时目录会造成 Vitest 缓存 rename 的 EPERM、Rust 并发写入/快照测试的 Access denied。将 TEMP/TMP 指向项目内 `logs/test-temp` 后通过。没有改动断言来绕过这些失败。
- 沙箱禁止回环连接（EACCES）并限制 Windows 进程树终止。原生回环、显式取消和 Tauri 构建经允许在沙箱外复测后通过。
- 注册表原始工作区仍有 2 项失败。`git -C registries ls-files --eol` 显示索引为 LF、工作区为 CRLF；上游单元测试明确要求拒绝 CRLF，因此不应通过放宽校验器来掩盖问题。建议在该上游仓库的维护流程中固定 blocklist 的 LF 检出规则。
- 3 项外部工程测试（catalog、正常 profile、blocked profile）未执行，因为本次没有指定实现 pytest bridge 的外部工程及 profiles。
- BLE、UART/串口的真实设备通信、FTMS 实机响应未验证；相关单元测试通过仅证明代码逻辑。
- TCP/UDP 本次验证了真实发送、连接生命周期与重绑，**没有验证接收事件从 Tauri 路由到 WebView、终端和画布的完整可视链路**。分离/停靠、系统窗口拖动与关闭恢复也仍需原生交互验收。
- 未执行 MSI/NSIS 安装卸载、release 优化构建、macOS/Linux、长时间高流量/内存增长测试。
- 当前未安装覆盖率 provider，本次没有生成行/分支覆盖率数字，不将通过数量表述为“100% 覆盖”。
- 非阻断提示：Browserslist 数据约 7 个月未更新；Rust 增量缓存硬链接不可用时退回复制。没有为消除提示而升级依赖。

## 后续测试重点

| 优先级 | 建议 | 验收标准 |
|---|---|---|
| 高 | 补原生 RX → 终端/图表/脚本的端到端验收 | 二进制内容、通道 ID、顺序、断开后无旧回调；主窗口与分离窗口均验证 |
| 高 | 固定一套可离线运行的外部 pytest bridge 工程 | 在干净环境执行剩余 3 个默认忽略项，保留真实外部测试结果而非预置通过状态 |
| 高 | BLE/UART 实机矩阵 | 正常连接、错误参数、拔出/断开、重连、订阅清理、连续收发 |
| 中 | 持久化主窗口重启与分离窗恢复 | 使用临时完整配置，重启后状态一致且接收事件只处理一次 |
| 中 | 覆盖率与故障注入 | 先量化协议、持久化、通信生命周期分支；以能检出已知错误为目标，不单纯增加数量 |
| 中 | 长时间负载及跨平台安装验收 | 明确持续时间、流量、内存基线及系统版本，单独记录结果 |

复现命令和 Windows 临时目录设置见 [DEVELOPMENT](DEVELOPMENT.md)。
