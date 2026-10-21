-- linkassist:type = canvas-lifecycle

return {
  version = 1,
  name = "Chart Torque Init / Calibrate",
  description = "Prepare the bench for torque charting by zeroing the motor, settling, and capturing one 32H torque-sensor frame as the zero calibration sample.",

  defaults = {
    stopOnFailure = true,
    timeoutMs = 1200,
    dataFormat = "hex",
    logLimit = 200,
  },

  variables = {
    sensorRequestHex = "01 32 81 F5",
    zeroSettleMs = 1000,
    retryTimes = 4,
    retryGapMs = 40,
  },

  onActivate = {
    {
      id = "chart-torque-calibration-log",
      action = "log",
      message = "Initializing torque sensor and capturing zero calibration sample; expected aliases: ch1=motor, ch2=torque sensor",
    },
    {
      id = "chart-motor-speed-zero",
      action = "send",
      channel = "ch1",
      data = { format = "text", value = "W5360000B5," },
    },
    {
      id = "chart-zero-settle",
      action = "delay",
      durationMs = "${zeroSettleMs}",
    },
    {
      id = "chart-torque-zero-sample",
      action = "request",
      channel = "ch2",
      send = { format = "hex", value = "${sensorRequestHex}" },
      expect = { format = "hex", startsWith = "01 32 08" },
      retry = { times = "${retryTimes}", intervalMs = "${retryGapMs}" },
      saveAs = "zeroSample",
    },
    {
      id = "chart-torque-calibration-done",
      action = "log",
      message = "Torque zero calibration sample captured: ${zeroSample.hex}",
    },
  },
}
