# Rust 警告处理与验证

> 后续更新（2026-10-21）：已移除 GitHub Actions 配置。下文 Ubuntu CI 及证据上传描述属于移除前的方案；Linux 验证仍未完成，需手动执行，本地审计脚本与既有证据保留。

日期：2026-10-21。接续[公开准备实施记录](PUBLIC-RELEASE-IMPLEMENTATION-2026-10-20.md)。

## 处理结果

| 原告警 | 处理 |
|---|---|
| glib 0.18.5 / RUSTSEC-2024-0429 | 在兼容 GTK 3 的 0.18 API 上回移上游 `VariantStrIter` 修复：C 输出指针使用可变变量和可变引用；保留真实版本号 |
| proc-macro-error 1.0.4 / RUSTSEC-2024-0370 | 两个调用方 glib-macros、gtk3-macros 改用已有 syn 错误 API，彻底移除旧库及其 attribute 依赖 |

新同步的 RustSec 数据还将 proc-macro-error2 标为停止维护（RUSTSEC-2026-0173），因此没有将它作为替代依赖。独立验证工程的 trybuild2 间接引入 basic-toml 告警（RUSTSEC-2026-0374），也已处理：文件式编译测试使用 trybuild；保留上游 inline clone 用例，通过独立 Cargo 工程检查错误消息及成功编译。

本地保存三个兼容补丁包，共 160 个文件、约 1.92 MiB。保留上游许可证、来源提交、原始清单，并提供差异补丁及逐文件哈希。维护与移除条件见 [vendor/README.md](../vendor/README.md)。应用代码/API 和 Windows 运行依赖不受这些 Linux GTK 补丁影响。

## 审计方式

直接运行 cargo-audit 不会检查本地 path 包。新增 `npm run audit:rust` 先验证补丁完整性，再分别审计应用和验证工程的锁文件，并额外用临时锁文件恢复三个包的原始 crates.io 身份，继续检查它们的上游公告。

仅当 glib 0.18.5 的已修复源码哈希、补丁配置和锁文件全部通过时，接受对应的 RUSTSEC-2024-0429。其他漏洞和警告一律让检查失败。没有添加全局 ignore，没有伪造包版本。原始 JSON 和已修复/未解决项均保存在本机 `logs/rust-audit-*/`，CI 也上传该证据。

## 本地已验证

- 应用 Rust 库：**169 通过，4 忽略，0 失败**；本次编译日志没有 Rust warning。
- 两项宏库：Windows `cargo check --locked --lib` 通过，0 warning。
- 宏输入回归：**28 项通过**，覆盖合法 clone、错误 derive/attribute、捕获声明、Variant 模式及 GTK 模板字段；错误输入产生预期诊断，没有宏 panic。
- 应用和验证工程审计：解析后的锁文件均 **0 漏洞、0 警告**；额外上游身份审计各报告 **1 项经哈希验证已回移的 GLib 修复、0 未解决项**。
- 158 个原始文件与校验过 SHA256 的 crates.io 压缩包逐一比对通过；另有 2 个新增测试文件。
- 完整性检查反向验证：临时修改 GLib 源码后检查确实失败；恢复原始字节后检查通过。测试依赖的新告警也曾使审计失败，替换后才通过。
- 架构文档索引已更新并检查。

关键本机日志：`logs/rust-warning-app-tests.txt`、`rust-warning-macros-check.txt`、`rust-warning-diagnostics.txt`、`rust-warning-final-audit.txt`、`rust-warning-integrity.txt`。

## 尚未执行的验证

本机没有可用的 Linux/WSL 发行版。新增 Ubuntu CI 将执行 release 模式的 GLib 库测试、字符串迭代回归、上游宏集成测试以及 GTK 模板成功展开测试；**工作流尚未推送运行，这些 Linux 测试不能记为通过**。没有据此宣称 Linux 桌面或硬件功能已验收。

本次没有重建 Windows 安装包：变动的 GTK 包不在 Windows 目标运行依赖中。此前生成的安装包仍是 2026-10-20 的产物。本次改动尚未提交或推送，也没有重写 Git 历史。
