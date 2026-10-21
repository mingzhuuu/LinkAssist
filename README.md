# LinkAssist

[English](README_EN.md) | 中文

LinkAssist 是基于 Tauri 2、React 19 和 Rust 的桌面通信调试工具，集成 BLE、串口、TCP/UDP、协议解析、实时画布、Lua 自动化和 MCP。桌面界面与本地 MCP Core 共用设备管理器。

## 安装与第一次使用

Windows 10/11 x64 预览版需要近期的 Microsoft Edge WebView2 Runtime。请到 [Releases](https://github.com/mingzhuuu/LinkAssist/releases) 查看已发布的安装包；若没有版本，按下方步骤从源码构建。安装包目前未签名，可用同版本的 `SHA256SUMS.txt` 核对下载完整性。macOS/Linux 尚未完成发布验收。

无需硬件即可体验：[五分钟 TCP/UDP 回环教程](docs/QUICKSTART.md)，配套 [`loopback.json`](config/layout/loopback.json)。历史设备示例需要重新选择本机串口、BLE 设备和外部测试工程。

![Windows 实际 TCP 回环：终端、表格与折线图](docs/images/loopback-windows.png)

## 文档导航

| 文档 | 用途 |
|---|---|
| [完整功能说明](docs/FEATURES.md) | 功能入口、操作流程、输入输出、限制和验收要点 |
| [架构与模块边界](docs/ARCHITECTURE.md) | 分层、事件/命令/持久化数据流、扩展规则 |
| [源码接口与文件索引](docs/REFERENCE.md) | 自动生成的 Tauri 命令、MCP 工具和应用文件清单 |
| [开发与验证](docs/DEVELOPMENT.md) | 环境、命令、验证范围和手动联调清单 |
| [本次审查与优化记录](docs/AUDIT.md) | 已修复问题、测试证据、尚未验证的边界 |
| [MCP 配置](config/mcp/mcp-configuration-guide.md) / [Lua 工具](config/mcp/mcp-tool-lua-guide.md) | 外部 Agent 接入及自定义工具 |
| [协议解析](config/protocol/protocol-configuration-guide.md) | 字段、Lua 协议文件及事务 |
| [自动化脚本](config/script/script-configuration-guide.md) / [画布生命周期](config/script/canvas-lifecycle-guide.md) | 脚本格式、动作、UI、启动/结束脚本 |
| [AI Agent 实战示例](AI_AGENT_DEMO.md) | 特定设备与测试台的历史操作示例 |

## 功能概览

| 功能域 | 已实现能力 |
|---|---|
| 通道 | BLE 扫描/GATT/通知；串口配置/收发；TCP 客户端/服务器；UDP 绑定/收发 |
| 终端 | ASCII/HEX、时间戳、通道终端和汇总终端、保存命令、窗格分割、分离与停靠 |
| 协议 | 透传、字段定义、Lua 解析；协议文件摘要、编码、响应匹配及 BLE 事务执行 |
| 画布 | 表格、图表、表单、Script Canvas；移动/缩放/吸附、通道绑定、原始/解析数据 |
| 自动化 | Lua 声明式步骤、CSV、等待/重试/断言、Helper、声明式交互 UI 和报告 |
| 测试运行器 | 从 Script Canvas 加载外部 pytest 工程目录，选择 profile/用例、运行、日志、取消 |
| MCP | stdio Bridge、本机鉴权 HTTP Core、内置工具与自定义 Lua 工具、异步执行查询 |
| 配置 | 自动保存、布局预设、文件目录记忆、配置和脚本资源的单 EXE 快照 |
| 界面 | 深浅主题、简洁模式、可调面板、托盘和主窗口恢复 |

“已实现”表示代码中存在功能入口与处理路径；真实设备兼容性、性能及跨平台结果需单独验证。详见[验证范围](docs/DEVELOPMENT.md)。

## 快速开始

开发环境使用 Node.js **24.x** 和 `rust-toolchain.toml` 固定的 Rust **1.94.1**。Windows 还需 Visual Studio C++ Build Tools、Windows SDK 和 WebView2；各平台前置条件见 [Tauri 官方安装指南](https://v2.tauri.app/start/prerequisites/)。

获取源码并启动：

```bash
git clone --recurse-submodules https://github.com/mingzhuuu/LinkAssist.git
cd LinkAssist
npm ci
npm run tauri dev
```

仅调试前端可运行 `npm run dev`，地址为 `http://127.0.0.1:1420`。普通浏览器没有 Tauri IPC，不能据此验证硬件或窗口功能。

```bash
npm run check          # 架构/文档检查 + TS/前端构建 + Vitest
npm run tauri build    # 原生应用及安装包
```

Rust 验证在 `src-tauri` 目录执行 `cargo test --lib --locked`。标准构建输出在 `dist/` 与 `src-tauri/target/`；安装包在 `src-tauri/target/release/bundle/`。

基本使用顺序：新建通道 → 配置并连接 → 在终端验证收发 → 按需要加载协议 Lua → 建立表格/图表/表单或脚本画布 → 保存布局。BLE 通知需要先发现 GATT 并订阅相应特征值。

## MCP 接入

给支持 stdio MCP 的客户端配置 LinkAssist 可执行文件的绝对路径：

```json
{
  "mcpServers": {
    "linkassist": {
      "command": "D:/Apps/LinkAssist/linkassist.exe",
      "args": ["--mcp-bridge"]
    }
  }
}
```

外层配置键以所用客户端为准。Bridge 会发现或启动 Core；Core 只绑定本机回环地址的动态端口，并验证 Bearer token。当前暴露 Tools，未实现 MCP Resources/Prompts。完整工具名称来自[自动生成索引](docs/REFERENCE.md)，运行时参数以 `tools/list` 返回的 schema 为准。

## 配置与快照

普通配置通过 Tauri `app_data_dir()` 存储，标识符为 `com.linkassist.desktop`；Windows 使用 `%APPDATA%\com.linkassist.desktop\config.json`，macOS 使用 `~/Library/Application Support/com.linkassist.desktop/config.json`。Linux 遵循 XDG data 目录。快照运行时使用独立目录。

```powershell
LinkAssist.exe snapshot my-workbench
```

该命令生成包含当前配置及被引用脚本/静态资源的 `my-workbench.exe`，不会覆盖已有输出。运行时选择的 CSV、日志、Python 环境和外部测试工程不包含在快照中。具体范围与错误条件见[快照功能说明](docs/FEATURES.md#配置保存与快照)。

## 维护规则

- 开发约定以 [AGENTS.md](AGENTS.md) 及各目录说明为准。
- 改动接口或新增文件后运行 `npm run docs:generate`，提交生成的索引。
- 接收事件由主窗口与分离终端负责；store 保持独立，不添加跨 store 运行时依赖。
- Script Canvas 需求优先修改 Lua。现有脚本能力不足时，需先说明通用扩展方案并获得明确批准，再改应用源码。
- 原生设备、第三方测试工程与跨平台联调不由单元测试替代。

项目代码使用 [MIT](LICENSE) 许可。依赖和数据保留各自许可，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。协作入口：[贡献指南](CONTRIBUTING.md)、[安全报告](SECURITY.md)、[变更日志](CHANGELOG.md)。
