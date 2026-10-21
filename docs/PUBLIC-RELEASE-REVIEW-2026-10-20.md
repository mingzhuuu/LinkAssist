# GitHub 公开发布准备检查

> 2026-10-21 更新：当前已移除 GitHub Actions 和 Dependabot 配置；下文 CI 与自动发布建议保留为历史审查记录，不代表当前安排。

> 此报告保留修改前的问题与证据。已实施的修复、测试结果和剩余发布限制请查看[实施与验证记录](PUBLIC-RELEASE-IMPLEMENTATION-2026-10-20.md)。

检查日期：2026-10-20（Asia/Shanghai）。基线：`d77b3ec`，检查开始时工作区干净。本次检查源码、Git 跟踪内容与本地历史、发布文档和依赖，并运行现有测试；未修改应用行为、选择项目许可证、删除历史或执行公开发布。

结论：项目已有较完整的功能文档、架构检查和自动化测试基础。建议完成仓库内容整理、许可证选择、输入执行边界加固、依赖整改和干净环境发布验证，再发布首个 Windows 预览版。

## 本次验证结果

| 检查 | 结果 | 范围 |
|---|---|---|
| `npm run check` | 通过 | 架构检查、TypeScript、Vite、43 个文件 / 302 项测试 |
| 架构契约 | 通过 | 72 个 Tauri 命令、56 个内置 MCP 工具、103 处字面量 invoke |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked` | 167 通过、0 失败、4 忽略 | 临时目录放在工作区；忽略项不算通过 |
| `npm audit --json` | 17 个受影响依赖项 | 11 high、4 moderate、2 low、0 critical；数量包含依赖链传播，不是 17 个互不相关的漏洞 |
| `npm audit --omit=dev --json` | 0 个已报告漏洞 | 仅 npm 生产依赖；不覆盖 Rust、WebView 或应用自身代码 |
| 公式执行探针 | 确认能修改 JS 全局变量 | 对实际 TypeScript 函数转译后在独立 Node 进程执行无害探针；未调用设备或 Tauri IPC |
| 快照静态读取 | 确认包含工作台配置和 5 个资源文件 | 只解析 EXE 尾部压缩载荷，未运行 EXE |
| 凭据初筛 | 未发现所扫描格式的真实凭据 | 当前文本扫描；另扫描所有本地 refs 的历史新增文本，覆盖私钥头、GitHub/AWS/OpenAI token 特征 |

本地共有 131 个可达提交。历史扫描不覆盖所有凭据格式、所有二进制载荷、未获取的远端 refs 或上游仓库历史，不能等同于完整保密审查。没有安装 Gitleaks/TruffleHog；`cargo audit` 也未安装，因此 Rust 漏洞审计仍待完成。

环境为 Windows、Node.js 24.14.1、npm 11.11.0。本次未执行全新机器安装、Windows 安装包验收、实机 BLE/串口、长期负载、macOS/Linux 或原生回环集成复测。旧报告中的原生测试结果不计作本次通过。

完整 npm 结果保存在本地忽略目录：`logs/public-release-npm-audit.json` 和 `logs/public-release-npm-audit-prod.json`。

## 公开源码前优先处理

### 1. 明确项目许可证和第三方声明

根目录没有 LICENSE，README 已准确说明此事实。公开源码与授予开源使用许可是两件事；按作者期望选择许可证，再统一 README、Cargo 和安装包的许可信息。选择规则参见 [GitHub 官方许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。

本地 `registries/LICENSE` 为 Apache-2.0；`bluetooth-numbers-database/LICENSE` 是包含署名、二进制分发声明和禁止背书条件的 BSD 三条款文本。建议补充第三方声明清单，说明 BLE 数据及生成常量的来源、版本和许可证，核对 npm、Rust 和图标来源。仅增加本项目 LICENSE 不能替代第三方义务核对。

### 2. 整理已被 Git 跟踪的开发资料

| 当前内容 | 已确认事实 | 建议 |
|---|---|---|
| `snapshot-layout.exe` | 6,362,695 字节；内含通道、画布、保存命令、MCP 配置、5 个资源文件及本机绝对路径 | 从公开源码交付范围移出；可分发示例应重新生成并单独审阅 |
| `.codex-icon-scale/` | 160 个已跟踪文件，合计 5,555,505 字节 | 保留正式图标与必要生成源，移出多轮候选产物 |
| `.sisyphus/run-continuation/` | 4 个会话状态 JSON 已跟踪 | 移出开发工具运行状态 |
| `src-tauri/rpmLoopLog.csv`、本地布局及调试 JSON | 测试记录与配置已跟踪 | 判断是否为有意公开示例；保留项应脱敏、命名并说明用途 |
| `install_omo.ps1` | 下载开发辅助工具，与应用安装流程无关 | 从产品根目录移出或明确标为开发者辅助资料 |

快照中未发现非空的 password/secret/token/api-key 命名字段，但仍需人工核对业务数据、设备标识和内嵌脚本。不要把未命中关键字理解为内容可自动公开。

补充针对开发临时资料、私有环境文件和签名材料的 `.gitignore` 规则，保留有意公开的 `.env.example` 等模板。已跟踪文件不会因添加忽略规则而消失；普通删除提交也不会从历史中移除它们。若历史中有确实不应公开的内容，应先确定历史处理方案再公开仓库。本次没有重写历史。

### 3. 修复第三方目录的获取方式

`git ls-tree HEAD` 显示：

- `bluetooth-numbers-database` 是 `160000` gitlink，指向 `f775114b057960b5f62d15c594c9335d112cb101`。
- `registries` 是 `160000` gitlink，指向 `228b62c31c177c9b770b79896aec9ef660f62216`。

仓库没有 `.gitmodules`，本地历史也未找到该文件。标准子模块初始化缺少 URL 映射。应补齐正式子模块配置，或改为具有来源/许可说明的显式数据更新流程。主应用使用已生成的常量，本问题不等价于当前主应用构建必然失败。

Rust 的 btleplug fork 已固定精确 commit，是已有优点；还需在无私人凭据、无 Cargo 缓存的环境验证其可获取性。本次未确认该远端的匿名可访问性。子模块语义参见 [Git 官方文档](https://git-scm.com/docs/gitmodules)。

## 发布可执行版本前优先修复

### 4. 画布公式可以执行任意 JavaScript 表达式

证据：[formulaUtils.ts](../src/components/display/formulaUtils.ts) 的 `evaluateNumericFormula` 将公式拼接给 `new Function`。只检查变量名与返回值，没有限制公式表达式访问全局对象。表格和图表的实际数据转换使用此函数；布局导入会接收画布配置。

无害复现：对 `x = 2` 输入 `(globalThis.__linkassist_audit_marker = 42, x + 1)`，函数返回 3，同时全局变量变为 42。这证明“计算结果是数字”不构成沙箱。导入第三方布局后，在公式被计算时会执行其代码；本次没有在实际 WebView 中尝试调用原生能力。

建议用允许数字、受控变量、算术运算和白名单数学函数的表达式解析器替换动态 JS；迁移已有公式并提供不支持语法提示。同步检查 [CanvasTable.tsx](../src/components/display/CanvasTable.tsx) 中另一个同类求值函数，避免修复遗漏。

[tauri.conf.json](../src-tauri/tauri.conf.json) 当前 `csp: null`。替换动态求值后配置符合实际 IPC、资源和样式需求的 CSP，并验收图表、主题及分离窗口；不要仅为保留动态求值而放开 `unsafe-eval`。参见 [Tauri CSP 官方说明](https://v2.tauri.app/security/csp/)。

### 5. 自动化 Lua 加载入口缺少资源限制

证据：[commands/script.rs](../src-tauri/src/commands/script.rs) 的 `parse_lua_table` 创建 Lua 后直接执行传入文本。该路径供自动化脚本与画布生命周期解析使用，没有调用 `apply_memory_limit` 或 `arm_execution_limit`。

对比之下，协议引擎、MCP Lua 和 Helper 已使用这些限制。静态路径表明，加载包含无限循环或无限分配的脚本可占用执行线程或耗尽内存；本次未在用户应用中运行此类脚本。

建议复用现有通用资源限制，必要时把执行移到阻塞任务，增加“加载阶段无限循环 / 超量分配被拒绝”的回归检查。修改 Script Canvas 相关源代码需遵循本仓库的授权约定；本报告仅提出修改方案。

### 6. 布局导入应先完整校验，再统一应用

证据：[SettingsDialog.tsx](../src/components/layout/SettingsDialog.tsx) 的导入流程 `JSON.parse` 后通过 TS 类型断言取值，先删除现有通道，再逐项恢复；画布只验证是数组，直接写入 store。失败仅 `console.warn`，没有回滚。

例如包含 `{"canvases":[null]}` 的 JSON 在静态执行路径中会先移除现有通道和画布，然后在读取 `zIndex` 时抛错，可能留下部分更新状态。此结论来自源码检查，未对用户工作台进行破坏性复现。

建议共用加载/导入 schema 与迁移逻辑，在内存中验证全部字段、关联 ID 和公式，成功后再提交；失败保留原状态并显示可定位的错误。对缺失字段究竟表示“保留”还是“清空”应明确约定。

### 7. 更新开发工具链并补齐 Rust 安全审计

本次 npm 报告涉及 Vite、Vitest、PostCSS、Tailwind 及其间接依赖。`--omit=dev` 为 0，说明本次 npm 已报告问题集中在开发依赖，不应描述成已证明发布 EXE 有 11 个高危漏洞。Vite 的相关路径问题可对照 [维护者公告](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff)。

先更新兼容版本，再逐项评估仍未解决的依赖链。报告对 Tailwind 链给出跨主版本的自动修复方案，因此不应直接运行 `npm audit fix --force`。升级后重跑前端、Rust 及相关集成验证。补充 RustSec/cargo-audit、依赖许可证检查及定期更新流程。

## 发布工程和对外使用体验

| 项目 | 当前缺口 | 建议验收标准 |
|---|---|---|
| GitHub CI | 没有已跟踪的根工作流；`.gitignore` 中 `.github/*` 会隐藏新增配置 | 放行 `.github`；PR 跑前端检查和 Windows Rust 测试，构建当前二进制后运行现有 Core 集成测试 |
| Release | 未形成仓库内可复用的自动发布流水线 | tag 构建 Windows 安装包，提供校验和、版本说明、依赖声明；发布权限与 PR 测试分离 |
| 安装验证 | 本次没有安装/卸载验证 | 干净 Windows 用户环境验收安装、升级、卸载、配置保留和首次启动；签名状态明确 |
| 新用户入口 | README 侧重开发，缺少截图、下载入口、可直接运行的通用示例 | 展示核心界面；提供安装说明、系统条件、5 分钟 TCP/UDP 回环教程和故障排查 |
| 示例可迁移性 | 多份布局和 MCP 示例含 `E:/Workspace/...` 等本机路径 | 清理本机绑定，使用当前能力支持的可迁移路径或提供文件重选步骤；在另一目录验证 |
| 社区协作 | 缺少 CONTRIBUTING、SECURITY、Issue/PR 模板及变更日志 | 明确支持范围、提交检查、漏洞报告入口和版本变更；联系方式由维护者提供 |
| 元数据 | Cargo `authors = ["you"]`，安装包 `Copyright 2025` 为不完整信息 | 替换为真实维护者信息，补充 repository/license；不必为公开 GitHub 删除 npm `private: true` |
| 平台承诺 | 有多平台配置，但不等于多平台验证通过 | 首版标明 Windows 已验收范围；macOS/Linux 通过各自构建与实机测试后再列为已支持 |
| 工具版本 | README 建议 Node 24，缺少机器可检查的 Node 版本约束 | 增加合适的 engines/版本文件及 CI 约束；验证宣称的 Rust 最低版本 |

GitHub 远端的实际可见性、已有 Releases、分支保护、secret scanning/push protection 和其他仓库设置未通过已登录 API 检查；这里的“缺少”指本地仓库可确认的交付内容。

## 可随后推进的性能和维护优化

1. **减少高频持久化计算。** [usePersistence.ts](../src/hooks/usePersistence.ts) 每次 terminal store 通知都会序列化布局比较。收包也更新该 store。先测量高吞吐场景，再改为稳定 selector 或布局 revision，避免每包做布局序列化。
2. **完善画布异步任务生命周期。** [CenterPanel.tsx](../src/components/layout/CenterPanel.tsx) 的模块级队列 map 没有删除清理；等待解析时删除画布后仍可能调用 `pushRow`，而 store 会重建对应 buffer。应按画布生命周期取消或丢弃迟到结果并清理队列。
3. **显示拥塞与丢样。** 当前解析队列上限 256，超过后丢弃旧任务。文档已有说明，建议 UI 显示丢弃计数、队列深度或处理延迟；如要求无损采集，另设记录链路与背压，避免与绘图缓冲混用。
4. **按功能拆分大模块。** CanvasEditDialog、scriptRuntime、mcp_tools 均超过 2,000 个非空行。优先按编辑器类型、执行步骤和工具域拆分，沿用已有测试；无需为公开发布先做全量重写。
5. **按需加载重型界面。** 本次 Vite 主 JS 为 778.01 kB，gzip 228.31 kB。先测首屏启动和 WebView 内存，再评估延迟加载设置、编辑器和图表相关模块。
6. **明确本地 Core 的信任边界。** 现有回环绑定、Bearer token、工具访问控制是优点。公开支持多用户 Unix 环境前，应验证 discovery token 文件权限；当前写入函数没有显式设置仅当前用户可读权限，实际权限取决于目录和 umask。

## 建议执行顺序

1. 选定许可、整理公开内容和历史范围、修复第三方目录获取方式。
2. 修复公式执行、Lua 加载限制、导入校验；更新依赖并记录无法立即消除的风险与范围。
3. 建立 CI 与 Windows Release，完成无缓存构建和干净机器安装验收。
4. 补截图、下载说明、通用回环示例和社区文件，再发布预览版本。
5. 用性能数据决定高频状态、队列和拆包优化；扩大平台与硬件支持矩阵。

发布准备完成的证据应包括：可复现的干净构建、通过的自动检查、已评估的依赖审计、经审阅的公开内容，以及实际安装和基本收发结果。

