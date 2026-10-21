# 五分钟回环入门 / Five-minute loopback demo

本示例只使用本机 TCP，不需要 BLE、串口或外部设备。导入前可先导出自己的布局；示例会替换通道和画布。

1. 打开设置中的布局导入，选择 [`config/layout/loopback.json`](../config/layout/loopback.json)。
2. 选择 **TCP Server**，确认模式为 Server、地址为 `127.0.0.1:17890`，启动监听。
3. 选择 **TCP Client**，连接 `127.0.0.1:17890`。
4. 客户端终端选择 HEX 发送，依次发送 `01`、`10`、`20`、`40`。服务端终端应收到相同字节；画布若未自动激活，手动启用它。
5. 表格两列应依次显示 `1 / 2`、`16 / 32`、`32 / 64`、`64 / 128`；折线图显示首字节数值。发送间隔留出约一秒以便观察。
6. 断开客户端并停止服务端监听。

If you prefer English: import the sample layout, start **TCP Server**, connect **TCP Client**, then send `01`, `10`, `20`, `40` in HEX mode. The server should receive the same bytes; the table shows each first byte and its value multiplied by two. Enable the canvases if necessary. Disconnect and stop listening when finished.

**端口已占用：** 将两侧地址同时改成另一个空闲的本机端口。**没有收到：** 检查先启动服务端、后连接客户端，以及发送终端所属通道。**表格空白：** 检查画布是否启用、绑定的是服务端通道。**乱码：** 使用 HEX 接收查看原始字节。

UDP 可用两个 TCP/IP 通道切换到 UDP：A 绑定 `127.0.0.1:17891`、目标 `127.0.0.1:17892`，B 反向配置，双方绑定后发送。UDP 没有连接握手、送达保证或自动重传。

开发者还可以自动验证回环、Core 鉴权和 MCP：

```sh
npm run tauri build -- --debug --no-bundle
npm run test:integration
```

集成测试使用独立快照、空配置和临时端口，不读取工作台的设备连接。

## 布局、公式与脚本

- 相对资源路径以**导入的 JSON 所在目录**为基准。保留 `config/` 的目录结构即可移动示例；旧的设备示例仍需重选本机串口、BLE 设备和外部测试工程。
- 导入布局关闭脚本自动运行、生命周期脚本和 MCP 暴露。审阅脚本、资源路径与设备后再手动启用。
- 缺失的顶层配置段保留现有设置，显式空数组清空相应段；格式错误会在修改工作台前提示。
- 数值公式支持 `x * 2`、`Math.max(x, 0)`、比较、位运算和条件表达式。不能访问 JavaScript 全局对象、执行赋值、创建对象或调用任意函数。旧的不支持公式会保留供编辑，但不执行代码，计算回退为原始值。
- 表格/表单解析队列上限为 256，画布显示等待、丢弃、错误数。过载会丢弃旧任务，因此显示链路不应被用作无损采集记录器。
