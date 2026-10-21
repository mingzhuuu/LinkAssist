# 测表坡度模式

测表脚本支持 `power`、`percent`、`grade` 三种 CSV 模式，可在同一 CSV 中混用。
选择 `script-serial-rpm-grade-commands.csv` 可运行坡度示例；运行前按实际需要修改转速和持续时间。

```csv
rpm,delay,mode,value
100,60,grade,1
100,60,grade,2.5
100,60,grade,-1
```

`rpm` 是电机转速，`delay` 单位为秒。`grade` 的 `value` 是坡度百分比：`1` 为 1%，负数为下坡；留空默认 1%。建议显式填写，使现有 CSV 日志的目标值也显示该坡度。编码分辨率为 0.01%，范围 -327.68%～327.67%，设备实际支持范围可能更小。

坡度模式使用 FTMS 控制点指令 `0x11`，固定参数为 `wind_speed=0`、`crr=0.004`、`cw=0.51`。1% 坡度报文为 `11 00 00 64 00 28 33`，成功应答前缀为 `80 11 01`。

`cwb=1.0` 保留为设备侧参考默认值：标准 FTMS 模拟参数没有独立的 `cwb` 字段，脚本不会下发或修改它；设备端需确认该默认值。参数格式参考 [Bluetooth SIG FTMS 测试规范](https://files.bluetooth.com/wp-content/uploads/dlm_uploads/2024/10/FTMS.TS_.p6.pdf)。

脚本仍沿用原有初始化流程，读取阻力范围并订阅骑行数据；设备须支持现有测表流程及 `0x11` 模拟参数控制。
