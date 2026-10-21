# AI Agent 接入实战示例：BLE FTMS 功率对比测试

> 本文以一次完整的硬件测试流程为例，演示 AI Agent 如何通过 MCP 工具控制 LinkAssist，完成 BLE 扫描连接、测试台控制和多源数据采集对比的全流程。

## 场景描述

测试目标：使用 AI Agent 控制测试台电机转动，同时采集测试台传感器功率和 BLE FTMS（Fitness Machine Service）设备的功率数据，对比两者的测量差异。

测试流程：

```
1. 扫描 BLE 设备，筛选 "410_" 前缀的设备
2. 连接目标设备，发现 GATT 服务
3. 初始化测试台（电机 + 扭矩传感器串口）
4. 控制电机转速到 800 RPM，等待稳定
5. 同时采集测试台 10 秒功率 + BLE FTMS 10 秒功率通知
6. 解析两个数据源，计算平均功率并对比
```

## 完整对话过程

### 第 1 步：扫描 BLE 设备并发现串口

**用户指令：**

> 使用MCP工具，扫描并连接"410_"开头的蓝牙设备，然后控制测试台转速到800RPM，稳定后读取10S测试台平均功率，与BLE FTMS 10S平均功率对比

**AI Agent 调用工具：**

```
┌─ 并行调用 ─────────────────────────────────────────────────────┐
│                                                                 │
│  工具 1: ble_start_scan                                         │
│  工具 2: serial_list_ports                                      │
│                                                                 │
│  → 两个独立操作同时发起，节省等待时间                             │
└─────────────────────────────────────────────────────────────────┘
```

**结果：**

| 串口 | 制造商 | 用途推测 |
|------|--------|---------|
| COM3 | FTDI | USB 转串口 |
| COM4 | FTDI | USB 转串口 |
| COM20 | SEGGER | JLink 调试口 |

### 第 2 步：按名称过滤 BLE 设备

**AI Agent 调用工具：**

```
工具: ble_get_devices(nameKeyword: "410_")
```

**结果：**

```
发现设备:
  名称:    410_54374
  地址:    58:E6:C5:DA:D4:66
  RSSI:    -58 dBm
  服务:    0x1826 (FTMS), 0xFC82 (自定义)
  可连接:  是
```

### 第 3 步：连接 BLE 设备 + 初始化测试台

**AI Agent 调用工具：**

```
┌─ 并行调用 ─────────────────────────────────────────────────────┐
│                                                                 │
│  工具 1: ble_connect_device(deviceId: "58:E6:C5:DA:D4:66")    │
│  工具 2: bench_init(motorPort: "COM3", sensorPort: "COM4")    │
│                                                                 │
│  → BLE 连接和测试台初始化同时进行                                │
└─────────────────────────────────────────────────────────────────┘
```

**结果：**

- BLE 连接成功
- 测试台初始化**失败** — COM3 电机 / COM4 传感器的组合无法读取扭矩传感器帧

**AI Agent 自动重试，交换串口：**

```
工具: bench_init(motorPort: "COM4", sensorPort: "COM3")
```

**结果：**

```
✓ 初始化成功
  电机端口:    COM4
  传感器端口:  COM3
  零点校准:    zeroTorqueHz = 10020.56 Hz
```

> **关键点：** AI Agent 在首次初始化失败后，自动推理出串口分配可能有误，主动交换端口重试，无需用户干预。

### 第 4 步：发现 GATT 服务 + 启动电机

**AI Agent 调用工具：**

```
┌─ 并行调用 ─────────────────────────────────────────────────────┐
│                                                                 │
│  工具 1: ble_get_gatt_services(deviceId: "58:E6:C5:DA:D4:66") │
│  工具 2: bench_set_motor_rpm(targetRpm: 800)                   │
│                                                                 │
│  → 服务发现和电机启动同时进行                                    │
└─────────────────────────────────────────────────────────────────┘
```

**GATT 服务发现结果（AI Agent 分析出功率相关的特征）：**

```
FTMS Service (0x1826):
├── Fitness Machine Feature        (0x2ACC)  [read]
├── Indoor Bike Data               (0x2AD2)  [notify] ← 瞬时功率
├── Training Status                (0x2AD5)  [read]
├── Fitness Machine Status         (0x2AD6)  [read]
├── Fitness Machine Control Point  (0x2AD9)  [write, indicate]
└── Fitness Machine Status         (0x2ADA)  [notify]

Cycling Power Service (0x1818):
├── Cycling Power Feature          (0x2A5D)  [read]
├── Cycling Power Measurement      (0x2A63)  [notify] ← 瞬时功率
└── Cycling Power Control Point    (0x2A65)  [read]
```

> **关键点：** AI Agent 自动识别出两个功率相关的 BLE 特征，并决定同时订阅，为后续对比提供数据源。

### 第 5 步：订阅 BLE 功率通知

**AI Agent 调用工具：**

```
┌─ 并行调用 ─────────────────────────────────────────────────────┐
│                                                                 │
│  工具 1: ble_subscribe_notifications(                          │
│           serviceUuid: "00001826-...",  // FTMS               │
│           charUuid: "00002ad2-...")     // Indoor Bike Data    │
│                                                                 │
│  工具 2: ble_subscribe_notifications(                          │
│           serviceUuid: "00001818-...",  // Cycling Power       │
│           charUuid: "00002a63-...")     // Power Measurement   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 第 6 步：等待稳定 + 同时采集数据

电机从 0 RPM 阶梯爬升到 800 RPM（每次 200 RPM，间隔 200ms），AI Agent 等待 5 秒稳定后开始采集。

```
┌─ 并行调用（10 秒同步采集）───────────────────────────────────────┐
│                                                                 │
│  工具 1: bench_read_power(                                     │
│           durationMs: 10000,        // 采样 10 秒              │
│           includeSamples: true,     // 返回逐样本数据           │
│           sampleIntervalMs: 500)    // 每 500ms 采样一次       │
│                                                                 │
│  工具 2: ble_get_notifications_data(seconds: 15)               │
│           // 获取最近 15 秒的 BLE 通知缓冲（覆盖 10 秒窗口）    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 第 7 步：解析数据并计算对比

AI Agent 解析原始 BLE 数据并计算平均功率：

**BLE Cycling Power Measurement (0x2A63) 解析：**

```
数据格式: [flags_lo, flags_hi, power_lo, power_hi]
示例:     [0, 0, 173, 0]
                ↑
          flags = 0x0000 (无扩展字段)
          瞬时功率 = 173W (sint16, little-endian)
```

**BLE FTMS Indoor Bike Data (0x2AD2) 解析：**

```
数据格式: [flags_lo, flags_hi, ...可选字段, power_lo, power_hi, ...]
示例:     [68, 0, 233, 9, 150, 0, 173, 0, ...]
          ↑
          flags = 0x0068
          bit 3: Average Cadence 存在
          bit 5: Resistance Level 存在
          bit 6: Instantaneous Power 存在
          功率字段位于偏移 6: [173, 0] = 173W
```

### 第 8 步：输出对比报告

**AI Agent 生成测试结果：**

| 测量源 | 10 秒平均功率 | 样本数 | 最小值 | 最大值 |
|--------|--------------|--------|--------|--------|
| Bench 扭矩传感器 | **132.23 W** | 20 | 111.78 W | 157.28 W |
| BLE CPM (0x2A63) | **171.62 W** | 34 | 171 W | 174 W |
| BLE FTMS (0x2AD2) | **151.59 W** | 34 | 150 W | 152 W |

**差异分析：**

```
BLE CPM 功率 − Bench 扭矩传感器功率 = +39.39 W (+29.8%)

可能原因:
  1. BLE 报告电气功率，Bench 测量机械输出功率（含电机/逆变器损耗）
  2. 传动系统摩擦损耗
  3. 两套测量系统的校准偏差
  4. 传感器安装位置差异
```

### 第 9 步：清理资源

**AI Agent 调用工具：**

```
┌─ 并行调用 ─────────────────────────────────────────────────────┐
│                                                                 │
│  工具 1: bench_set_motor_rpm(targetRpm: 0)                     │
│  工具 2: ble_disconnect_device(deviceId: "58:E6:C5:DA:D4:66") │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 使用的 MCP 工具一览

| 步骤 | 工具 | 并行 | 说明 |
|------|------|:----:|------|
| 扫描 | `ble_start_scan` | ✓ | 启动 BLE 扫描 |
| 扫描 | `serial_list_ports` | ✓ | 列出系统串口 |
| 过滤 | `ble_get_devices` | | 按名称筛选设备 |
| 连接 | `ble_connect_device` | ✓ | 连接 BLE 设备 |
| 初始化 | `bench_init` | ✓ | 初始化测试台（首次失败后自动交换端口重试） |
| 服务发现 | `ble_get_gatt_services` | ✓ | 发现 BLE GATT 服务和特征 |
| 控制 | `bench_set_motor_rpm` | ✓ | 设置电机目标转速 |
| 订阅 | `ble_subscribe_notifications` | ✓ | 订阅两个功率特征的通知 |
| 采集 | `bench_read_power` | ✓ | 采集 10 秒测试台功率数据 |
| 采集 | `ble_get_notifications_data` | ✓ | 获取 BLE 通知缓冲 |
| 清理 | `bench_set_motor_rpm(0)` | ✓ | 停止电机 |
| 清理 | `ble_disconnect_device` | ✓ | 断开 BLE 连接 |

**共 12 次工具调用，其中 4 组并行执行。**

## 由此示例可以看到的 AI Agent 能力

### 1. 自主决策

AI Agent 根据 GATT 服务发现结果，自动识别出两个功率相关的 BLE 特征（Cycling Power Measurement 和 FTMS Indoor Bike Data），并决定同时订阅它们用于后续对比。

### 2. 错误自愈

首次 `bench_init` 因串口分配错误失败后，AI Agent 推理出可能的原因，主动交换 COM3/COM4 端口重试成功，无需用户介入。

### 3. 并行执行

AI Agent 将互不依赖的操作自动并行化（BLE 连接 + 测试台初始化、服务发现 + 电机启动、两个功率通知订阅等），大幅缩短测试周期。

### 4. 数据解析

AI Agent 理解 BLE 特征值的二进制编码格式（小端序、标志位、字段偏移），直接从原始字节中提取功率值并计算平均值。

### 5. 综合分析

AI Agent 不仅采集数据，还能结合测试场景（电气 vs 机械功率、传感器位置差异等）给出差异分析。

## 快速复现

### 前置条件

1. 安装 LinkAssist
2. 配置 MCP 客户端连接 LinkAssist（参考 [MCP 配置指南](config/mcp/mcp-configuration-guide.md)）
3. 测试台通过 COM3/COM4 连接电脑
4. 蓝牙适配器已开启
5. 目标 BLE 设备已开机且在信号范围内

### MCP 客户端配置

```json
{
  "mcpServers": {
    "linkassist": {
      "command": "LinkAssist 可执行文件的绝对路径",
      "args": ["--mcp-bridge"]
    }
  }
}
```

### 发送给 AI Agent 的指令

用一句话即可驱动整个测试流程：

```
使用MCP工具，扫描并连接"410_"开头的蓝牙设备，
然后控制测试台转速到800RPM，稳定后读取10S测试台平均功率，
与BLE FTMS 10S平均功率对比
```

AI Agent 会自动完成：扫描 → 连接 → 初始化 → 控制 → 采集 → 解析 → 对比 → 清理的全流程。
