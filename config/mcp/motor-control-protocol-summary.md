# 电机控制协议总结

本文基于 [`config/mcp/mcp-tool-test-bench.lua`](/D:/Workspace/opencode/LinkAssist/config/mcp/mcp-tool-test-bench.lua) 和 [`config/script/script-serial-rpm-example.lua`](/D:/Workspace/opencode/LinkAssist/config/script/script-serial-rpm-example.lua) 整理，描述的是测试台脚本当前实际使用的协议行为。  
其中 `W60A`、`W536`、`W63E`、`W619` 等寄存器的业务语义，本文按脚本用途做了工程化命名；如果后续需要和厂商正式手册逐项对照，建议再做一次寄存器级校验。

## 1. 总体结构

测试台实际上用了两套串口协议：

1. 电机控制协议：ASCII 文本命令，经 `COM4` 发送给电机驱动器。
2. 扭矩传感器协议：二进制轮询命令，经 `COM3` 读取扭矩和转速，再换算功率。

如果只关心“电机怎么控速”，重点看前半部分即可。

## 2. 串口参数

电机和传感器当前默认都使用：

```text
baudRate   = 9600
dataBits   = 8
stopBits   = 1
parity     = none
flowControl= none
```

区别在于接收超时：

- 电机 `receiveTimeoutMs = 50`
- 传感器 `receiveTimeoutMs = 80`

## 3. 电机控制协议

### 3.1 报文形式

电机命令是纯 ASCII 文本，格式可概括为：

```text
W[寄存器/命令字][4位十六进制数据][2位十六进制校验],
```

例如：

```text
W5360000B5,
W60A0001BF,
W6190000B7,
```

特征如下：

- 固定以 `W` 开头。
- 主体使用大写十六进制字符。
- 结尾带一个逗号 `,`。
- 校验字段是对不含校验和逗号的 ASCII 主体逐字符求和，再取低 8 位。

### 3.2 校验算法

脚本中的校验生成逻辑等价于：

```text
checksum = (sum(ASCII(command_body_uppercase)) & 0xFF)
final    = command_body_uppercase + checksum_hex_2 + ","
```

例如：

```text
command_body = "W5360000"
checksum     = 0xB5
final        = "W5360000B5,"
```

说明：

- 校验不是 CRC，不是 LRC。
- 只是简单的 ASCII 字节和低 8 位截断。

### 3.3 初始化序列

测试台每次打开电机串口后，会按固定顺序发送以下命令：

```text
W60A0001BF,
W60B0000BF,
W5360000B5,
W63E0001C6,
W6190001B8,
```

从脚本行为推断，这组命令的作用可以理解为：

| 顺序 | 命令 | 工程化含义 |
|---|---|---|
| 1 | `W60A0001BF,` | 使能或进入可运行状态 |
| 2 | `W60B0000BF,` | 写入某个初始化控制位 |
| 3 | `W5360000B5,` | 先把转速目标置零 |
| 4 | `W63E0001C6,` | 打开某个运行相关控制位 |
| 5 | `W6190001B8,` | 最终允许运行 |

脚本在初始化序列后会额外等待 `100ms`。

### 3.4 停机序列

关闭测试台会按固定顺序发停机命令：

```text
W5360000B5,
W6190000B7,
W63E0000C5,
W5360000B5,
W60A0000BE,
```

可理解为：

| 顺序 | 命令 | 工程化含义 |
|---|---|---|
| 1 | `W5360000B5,` | 先清零目标转速 |
| 2 | `W6190000B7,` | 关闭运行允许位 |
| 3 | `W63E0000C5,` | 关闭运行控制位 |
| 4 | `W5360000B5,` | 再次确认目标转速为零 |
| 5 | `W60A0000BE,` | 解除使能或退出运行状态 |

### 3.5 转速命令编码

转速命令由脚本动态生成，核心格式为：

```text
W536[速度字]
```

其中 `[速度字]` 是一个 16 位带符号量，经补码后转成 4 位十六进制。脚本算法如下：

```text
rpm_signed = targetRpm
if direction == 1 then
  rpm_signed = -targetRpm
end

encoded = int16(-round(rpm_signed * 8.192))
speed_word = HEX16(encoded)
command = "W536" + speed_word
final = append_ascii_sum_checksum(command)
```

也就是说：

```text
速度字 = int16(-round(目标RPM × 8.192))
```

但脚本还额外引入了 `direction` 参数：

- `direction = 0`：按正向 RPM 编码
- `direction = 1`：先把 RPM 取负，再参与编码

这里的“正向/负向”是脚本层约定，不一定等同于设备面板上的“正转/反转”文字定义，实际方向仍取决于驱动器参数和接线。

### 3.6 转速置零

脚本中“停机”和“零点校准”都会直接发送：

```text
W5360000B5,
```

因此这条命令可以明确理解为“将速度给定清零”。

### 3.7 斜坡控制

`bench_set_motor_rpm` 不总是一步跳到目标转速。  
如果本次目标与上次目标的差值大于 `200 RPM`，脚本会自动做斜坡：

- 步长：`200 RPM`
- 步间隔：`200 ms`

这样可以避免驱动器瞬间大幅跳变。

## 4. MCP 工具层面的控制流程

测试台 Lua 对外暴露了 4 个 MCP 工具，本质上就是对上述串口协议的封装：

### 4.1 `bench_init`

作用：

- 打开电机串口和传感器串口
- 发送电机初始化序列
- 把电机目标速度设为 0
- 做一次扭矩零点校准
- 持久化当前 session

如果 session 已经存在，则不会重新开串口，而是直接重做零点校准。

### 4.2 `bench_set_motor_rpm`

输入：

```json
{
  "targetRpm": 1500,
  "direction": 1
}
```

作用：

- 若没有 session，会先自动执行 `bench_init`
- 根据 `targetRpm` 和 `direction` 生成 `W536xxxx??,`
- 必要时自动斜坡
- 更新 session 中记住的上一目标值

### 4.3 `bench_read_power`

这个接口本身不发电机命令，而是：

- 复用当前校准值
- 轮询扭矩传感器
- 把 `torqueHz`、`speedHz` 换算成 `torqueNm`、`rpm`、`power`

默认采样窗口：

- `durationMs = 5000`
- `sampleIntervalMs = 200`

### 4.4 `bench_deinit`

作用：

- 发送电机停机序列
- 关闭传感器串口
- 关闭电机串口
- 清理 session

## 5. 扭矩传感器协议（附录）

虽然它不属于“电机控制命令”，但测试台功率计算依赖它，所以一并列出。

### 5.1 轮询请求

默认请求帧：

```text
01 32 81 F5
```

从脚本处理方式可知：

- `0x01` 是默认设备地址
- `0x32` 是读数命令码
- 后两字节是 `CRC16-Modbus`

### 5.2 响应帧格式

脚本会在接收缓存中寻找长度为 13 字节的有效帧：

```text
[addr][0x32][0x08][torqueHz:4字节LE浮点][speedHz:4字节LE浮点][crc16:2字节]
```

即：

| 字段 | 长度 | 说明 |
|---|---|---|
| 地址 | 1 byte | 必须等于请求地址 |
| 命令码 | 1 byte | 固定 `0x32` |
| 数据长度 | 1 byte | 固定 `0x08` |
| `torqueHz` | 4 byte | 小端 IEEE754 float |
| `speedHz` | 4 byte | 小端 IEEE754 float |
| CRC | 2 byte | CRC16-Modbus |

脚本兼容两种 CRC 字节顺序判断：

- `low byte + high byte`
- `high byte + low byte`

### 5.3 物理量换算

#### 扭矩

```text
torqueNm = torqueRangeNm * ((torqueHz - zeroTorqueHz) / torqueSpanHz)
```

默认参数：

- `torqueRangeNm = 100`
- `torqueSpanHz = 5000`

#### 转速

```text
rpm = speedHz * 60 / speedPulsesPerRev
```

默认参数：

- `speedPulsesPerRev = 1024`

#### 功率

```text
power = torqueNm * rpm * 2 * 3.14 / 60
```

脚本里使用的是 `3.14`，不是更高精度的 `math.pi`。

## 6. 可以直接复用的结论

如果后续你要自己实现上位机、PLC 或 Python 测试程序，最关键的信息是：

1. 电机串口是 `9600 8N1`，命令为带逗号结尾的 ASCII 文本。
2. 命令校验是“ASCII 求和低 8 位”，不是 CRC。
3. 动态控速只需要会生成 `W536[速度字][校验],`。
4. 速度字计算公式是 `int16(-round(rpm_signed * 8.192))`。
5. 上电初始化和停机都依赖固定命令序列，不能只发单条转速命令。
6. 功率测量依赖另一套 32H 传感器协议，不是电机驱动器自己返回功率。

## 7. 建议的后续补充

如果你准备把这份总结升级成正式协议文档，建议再补三项：

1. 对照驱动器厂商手册，确认 `W60A/W60B/W63E/W619/W536` 的正式寄存器定义。
2. 实测 `direction = 0/1` 对应的真实机械转向，避免脚本约定和现场定义相反。
3. 抓一组真实串口收发日志，把“设置 1000RPM / 反向 1000RPM / 停机”的完整报文样例补进去。
