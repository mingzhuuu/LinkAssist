# USBPcap 串口监控

替代原自研 KMDF 方案。LinkAssist 不再构建、安装或分发自研内核驱动，不修改设备 UpperFilters。旧原型及其构建产物已从源码路径移至本地 logs/retired-kmdf 归档；不进入安装包。

## 虚拟串口限制

USBPcap 只采集 USB 总线流量。纯软件虚拟串口对（例如 Electronic Team VSPD 创建的 COM6↔COM9）没有 USB 设备、地址或端点，不能用本模式旁路监控；安装 USBPcap、管理员运行或手动输入 USB 参数都不能补足这一能力。Normal 模式会作为通信端点打开端口，也不能替代两个外部程序之间的旁路监控。

保持外部程序连接方式的直接旁路采集，需要支持该串口驱动的串口监控驱动/SDK；LinkAssist 当前没有此后端。Electronic Team 的 [Serial Port Monitor 官方说明](https://www.virtual-serial-port.org/articles/capture-serial-port-data/)明确列出软件虚拟 COM 端口支持，但实际兼容性及授权需另行验证。端口镜像/转发方案则涉及改动虚拟串口拓扑，不等价于直接订阅现有端口。

本机只读诊断（不打开 COM，不启动采集）：在 `src-tauri` 目录设置 `LINKASSIST_MONITOR_PORTS=COM6,COM9`，运行 `cargo test --lib serial::usb_windows::tests::inspect_local_monitor_ports -- --ignored --nocapture`。

## 安装和使用

1. 在 Settings → Channel → Serial Port 打开 **Supports monitor mode**，下方显示 USBPcap 安装目录（未检测到安装时展示安装引导）。点击 **Open USBPcap website** 打开 https://desowin.org/usbpcap/，安装后重启 Windows。也可以使用 Wireshark 安装的 USBPcap 组件。官方 1.5.4.0 页面列出 Windows 7/8/10；在当前 Windows 版本的驱动策略下是否可加载必须实际验证，不能仅凭签名推断。
2. USBPcap installation directory 留空时自动定位；可输入绝对目录或通过 Browse 选择 USBPcap/Wireshark 目录，Reset 恢复自动。目录自动保存到本机配置，旧配置默认自动；关闭模式开关仅隐藏此区域，保留目录。Check again 检查工具文件及已加载的采集接口；只有工具文件而没有接口时明确提示重启加载驱动。具体设备访问权限及映射仍在 Monitor 检测/启动时验证。远程工作区不提供本机 USBPcap 配置入口。UART 卡片选择 Monitor，再选择已连接的 USB 串口；应用通过 Windows 设备树匹配 COM 的 USB 设备、USBPcap Root Hub、当前地址及数据接口的 Bulk IN/OUT 端点。
3. Monitor 端口列表自动过滤不支持的串口，仅显示 USB 串口。选择端口后点击 Monitor。Windows 权限不足时，此操作会弹出 UAC；批准后由采集进程重新识别 USB 设备并启动监控，取消后可再次点击。卡片不显示红字警告，工具或设备检测失败时禁用启动，可在 Channel 设置检查安装目录。
4. UART 卡片的 USB 参数默认显示 Auto；填写参数后启用手动覆盖，切换 COM 清除覆盖。手动模式仍拒绝没有 USB 设备的 COM，但不验证 COM 与所填采集目标的对应关系；必须通过 USBPcap/Wireshark 核对总线、地址、接口、端点和最大包长。端点输入使用十进制（例如 0x81 填 129）。检测失败时卡片显示原因，不再仅禁用启动按钮。
5. 外部串口程序可保持连接。已有权限时，Monitor 启动 USBPcapCMD；需要 UAC 时，获得权限的采集进程直接读取已安装的 USBPcap 驱动。Stop 停止本会话的采集。监控中重新插拔设备需停止并重新启动，以刷新地址。

指定目录时只查找该目录的 USBPcapCMD.exe 或 extcap/USBPcapCMD.exe，找不到时显示错误。留空时优先从 HKLM 的 32/64 位 USBPcap/Wireshark 安装记录定位，再查找 Program Files 下的常用路径。目录修改后重新检测，检测和监控启动使用同一目录。安装记录仅用于定位。UAC 只在 UART 卡片明确点击 Monitor 后请求，授权范围限于本次 USBPcap 采集。主窗口继续以原权限运行。

自动映射不打开 COM、不改变 USB 配置或重置设备。通过 COM 的 PortName、PnP 父节点及 driver key 匹配物理设备，不以 VID/PID 或端点默认值猜测。复合设备优先匹配 MI 接口，支持 CDC Union 的控制/数据接口关联；缺少接口身份且存在多个 Bulk 接口时拒绝自动选择。解析当前配置的 alternate 0，并核对活动 pipe；其他 alternate 或复杂接口可使用手动配置。

自动解码仅对已识别的标准 usbser/CDC 数据接口使用 Serial passthrough，对 FTDI VID 0403、PID 6001/6010/6011/6014/6015 且串口驱动为 ftser2k 的设备使用 FTDI。其他适配器采用 Raw bulk，并明确提示尚未验证串口载荷解码。FTDI 在每个 USB IN 数据包剥离两个状态字节，包长来自 IN 端点描述符；Raw bulk 不等同于已解码的串口字节。

## 实现边界

- 仅 Windows 的 USB 串口适配器；主板 UART、蓝牙 SPP、纯软件虚拟 COM 不适用。
- 后端读取 USBPcapCMD 或采集进程输出的 classic PCAP（LINKTYPE_USBPCAP=249），支持大小端和微秒/纳秒时间戳。
- --devices 在 USBPcap 侧限定地址，应用再次限定 bus/address/endpoint/transfer。只接受 Bulk，忽略控制与中断流量。
- IN 只显示完成方向，OUT 只显示提交方向，避免重复显示同一 URB。TX 表示提交的 USB 载荷，不证明设备收到或串口已经发出；不追踪 OUT 完成状态。
- 终端时间来自抓包时间戳，显示为毫秒。Raw bulk 明确标为 USB BULK，转换模式标为 USB SERIAL。
- 读取边界和长度严格检查，截断/损坏文件中止并报告，不静默拼成串口数据。单条 PCAP 上限 1 MiB；USBPcap 内部缓冲设为 4 MiB。当前没有驱动丢包计数接口，不能承诺无丢失。
- FTDI 状态字节当前只剥离、不解释调制解调器状态或线路错误；其他厂商特殊封装必须使用 Raw bulk，不能假定通用兼容。
- 当前为本地监控，尚未接入画布协议解析和远程工作区。手动配置和显式覆盖开关持久化；自动识别结果只作预览，每次启动重新查询。

## 构建与测试

```powershell
npm run check
cd src-tauri
cargo test --lib serial:: --locked
cd ..
npm run tauri -- build --config src-tauri/tauri.usbpcap.conf.json --bundles nsis -- --locked
node scripts/serial-monitor-native-smoke.mjs
```

普通 NSIS 构建与上述专用配置均接入安装检测。安装包检查 32/64 位 USBPcap 安装记录、驱动服务记录及常见 USBPcapCMD 路径；已有组件时保留并跳过下载提示，实际可用性在运行时检查。未发现组件时提供可跳过的官方下载页入口，默认选择跳过；静默安装不弹窗、不打开浏览器。卸载 LinkAssist 不卸载共享 USBPcap。不内嵌第三方安装器、不自动升级、不修改驱动或强制重启。

离线测试覆盖 PCAP 记录、方向去重、目标过滤、FTDI 多包状态头剥离和非法记录拒绝；原生 smoke 不打开物理端口。真实芯片、外部软件持续通信、USBPcap 驱动加载及当前 Windows 兼容性仍需实际环境验收。

协议依据：USBPcap 官方 USBPcapDriver/include/USBPcap.h、USBPcapCMD/cmd.c 及 https://desowin.org/usbpcap/captureformat.html 。
