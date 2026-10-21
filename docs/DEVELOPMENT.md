# 开发与验证

## 环境与构建入口

- Node.js：开发使用 24.x；锁文件引擎范围见 [REFERENCE](REFERENCE.md)。不再沿用旧 README 的 Node >=18。
- Rust：使用 `rust-toolchain.toml` 固定的 1.94.1，Cargo 声明 1.94。更新后的 Tauri 依赖已超过旧 1.89 基线。
- Windows 原生构建需要相应 C++ 工具链、SDK 和 WebView 环境；macOS/Linux 需要平台原生依赖。本次不声明跨平台构建已验证。
- npm 使用根目录 `package-lock.json`，Rust 使用 `src-tauri/Cargo.lock`；btleplug fork 固定到 Cargo.toml 中的精确 commit。

| 文件 | 作用 |
|---|---|
| `package.json` / `package-lock.json` | 前端脚本、依赖范围和锁定版本 |
| `tsconfig.json` / `tsconfig.node.json` | 严格 TS、ESM、构建配置类型 |
| `vite.config.ts` | 前端构建、1420 服务端口、1421 条件 HMR |
| `vitest.config.ts` | jsdom 测试；Tauri mock 由测试自行提供 |
| `tailwind.config.js` / `postcss.config.js` | 主题样式与处理 |
| `src-tauri/Cargo.toml` / `Cargo.lock` | Rust crate、特性和依赖 |
| `src-tauri/tauri.conf.json` | 窗口、devUrl、前端产物与安装包 |
| `src-tauri/capabilities/` | 桌面能力配置 |
| `scripts/project-check.mjs` | 应用契约检查和文档索引生成 |

## 常用命令

```bash
npm ci
npm run dev
npm run tauri dev
npm run typecheck
npm test
npm run build
npm run docs:generate
npm run check:architecture
npm run check
npm run tauri build
```

Rust 命令在 `src-tauri` 目录执行：

```bash
cargo test --lib --locked
cargo check --locked
```

前端 `check` 不包含 Rust 编译/测试或原生安装包构建。上游 registries 验证应在更改该子项目时单独运行，不与应用检查混在一起。

Windows 原生接口回归测试：

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin linkassist
npm run test:integration
```

`scripts/core-smoke.mjs` 使用 `node:test` 启动当前编译的程序，创建空配置的独立快照和随机回环端口，验证 HTTP 鉴权、MCP stdio、TCP/UDP 发包、关闭与立即重绑。测试结束关闭自己创建的进程与套接字，诊断文件保留在忽略的 `logs/core-smoke-*` 中。可用 `LINKASSIST_TEST_BINARY` 指定其他待测 Windows EXE；测试不会自动重编译，因此源码修改后必须先构建。需要允许本机回环通信的执行环境。

测试评估、已修复问题及当前覆盖边界见 [2026-10-19 测试报告](TEST-REPORT-2026-10-19.md)。

## 测试层次

| 层次 | 覆盖内容 | 不覆盖 |
|---|---|---|
| 静态架构检查 | 字面量 invoke 对应注册、命令声明、store import 边界、索引过期、文件链接 | 动态命令名、参数/返回值 schema、外部 URL 和 Markdown 锚点 |
| TypeScript / Vite | 类型、未使用变量、前端编译与打包 | Tauri 实际 API 和硬件 |
| Vitest | store、类型迁移、纯函数、显式 mock 的 hooks/组件、事件生命周期 | 实际 WebView/系统窗口和设备 |
| Rust lib tests | 协议、Lua、配置、Core 工具合同、缓冲、快照、测试运行器内部逻辑 | 被 ignore 的外部工程/进程测试和实际硬件 |
| 自动原生接口回归 | 真实 Core HTTP/MCP、TCP/UDP 发包、断开与端口重绑 | WebView 接收事件与终端显示、硬件、桌面交互、长期负载 |
| 手动原生验收 | 按下表验证桌面窗口、设备和收发链路 | 未明确执行的平台或场景 |

### Windows 沙箱临时目录

受限执行环境可能拒绝工具默认临时目录中的文件 rename。若出现 Vitest transform 缓存 EPERM 或快照测试 Access denied，使用当前工作区内被忽略的临时目录重跑，不修改测试断言或产品路径绕过错误。

在 PowerShell 仓库根目录执行（环境变量仅影响本 shell 与子进程）：

```powershell
$taskTemp = Join-Path (Get-Location) 'node_modules/.cache/task-temp'
New-Item -ItemType Directory -Force -Path $taskTemp | Out-Null
$env:TEMP = $taskTemp
$env:TMP = $taskTemp
npm run check
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
```

若仍失败，保留错误并区分权限故障与代码断言故障。日志存于临时目录，不提交运行产物或用户配置。

## 手动验收矩阵

以下是原生发布前检查清单，本次状态见 AUDIT，未勾选项不能理解为已通过。

| 场景 | 步骤 | 预期证据 |
|---|---|---|
| 启动与恢复 | 配置通道/布局/主题，退出再启动 | 配置一致，旧数据缓冲为空，连接状态真实 |
| BLE | 扫描、连接、GATT、读写、订阅、断开/重连 | 目标 ID 一致，通知无重复，错误明确 |
| 串口 | 正常参数、错误端口、连续收包中发送、关闭 | TX/RX 有序，关闭后无幽灵连接 |
| TCP | 本机 server/client 双向收发，断开多个客户端 | 正确客户端路由，服务器仍可接受新连接 |
| UDP | 绑定、指定目标、收包、重新绑定 | 地址正确，旧读任务不再送包；测试大包行为 |
| 终端 | 分割/合并、重复分离/停靠、主窗口关闭 | 布局可恢复，监听数量稳定，不重复/错路由 |
| 协议与画布 | 原始/解析两种输入，错误 Lua，暂停与恢复 | 字段/图表正确，错误可定位，容量行为符合说明 |
| MCP | 开关工具、stdio 列表/调用、长任务查询和取消 | schema 与调用一致，鉴权/lease/退出正确 |
| 外部测试工程 | catalog、profile、精确用例、目录变化、取消 | 过期选择拒绝，日志/状态完整，子进程退出 |
| 快照 | 打包、资源缺失、已存在输出、换目录启动 | 失败不留不完整输出，独立配置，禁用自动执行 |
| 安装/平台 | 原生安装包、卸载、不同 OS | 明确记录目标系统和结果，不凭单平台推断 |

## 文档更新流程

Rust GTK 兼容补丁的维护规则见 [vendor/README.md](../vendor/README.md)。修改 Cargo 依赖后运行 `npm run check:rust-backports` 与 `npm run audit:rust`；后者还检查本地补丁包的上游安全公告。`npm run test:rust-macros` 可在 Windows 执行宏诊断回归；GLib/GTK 原生测试需在安装 GTK 开发库的 Linux 环境手动执行。仓库不再配置 GitHub Actions 或 Dependabot；检查、依赖审计和发布打包均由维护者手动运行。

1. 功能变化先更新 FEATURES 的入口、结果与限制，API 参数详细教程仍放在 `config/`。
2. 模块责任或边界变化更新 ARCHITECTURE，事实性开发导航同步相关 AGENTS 文件。
3. 运行 `npm run docs:generate`，生成源码接口/文件清单；无需手写重复工具表。
4. 运行 `npm run check` 和适用的 Rust/原生检查。
5. AUDIT 记录执行环境、实际结果、忽略/未执行项；不要将计划写成已验证事实。
