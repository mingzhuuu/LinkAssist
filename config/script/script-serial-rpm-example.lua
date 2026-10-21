-- linkassist:type = script

-- Meter-bench protocol helpers are embedded so this script remains self-contained. LinkAssist
-- evaluates the returned document normally, and invokes helpers()/call() in its pure Helper
-- sandbox only when a luaHelper step or matcher runs.
local function meter_byte_array(value)
  if type(value) ~= "table" then return nil end
  local result = {}
  for index = 1, #value do
    local byte = tonumber(value[index])
    if byte == nil or byte % 1 ~= 0 or byte < 0 or byte > 255 then return nil end
    result[index] = byte
  end
  return result
end

local function meter_round(value, digits)
  local factor = 10 ^ (digits or 0)
  return math.floor(value * factor + 0.5) / factor
end

local function meter_uint16_le(bytes, offset)
  local low = bytes[offset + 1]
  local high = bytes[offset + 2]
  if low == nil or high == nil then return nil end
  return low | (high << 8)
end

local function meter_int16_le(bytes, offset)
  local value = meter_uint16_le(bytes, offset)
  if value == nil then return nil end
  if value >= 0x8000 then return value - 0x10000 end
  return value
end

local function meter_float32_le(bytes, offset)
  local a, b, c, d = bytes[offset + 1], bytes[offset + 2], bytes[offset + 3], bytes[offset + 4]
  if a == nil or b == nil or c == nil or d == nil then return nil end
  local value = string.unpack("<f", string.char(a, b, c, d))
  if value ~= value or value == math.huge or value == -math.huge then return nil end
  return value
end

local function meter_crc16_modbus(bytes, count)
  local crc = 0xFFFF
  for index = 1, math.min(#bytes, count) do
    crc = crc ~ bytes[index]
    for _ = 1, 8 do
      if (crc & 1) ~= 0 then
        crc = (crc >> 1) ~ 0xA001
      else
        crc = crc >> 1
      end
    end
  end
  return crc & 0xFFFF
end

local function meter_torque_frame_valid(value)
  local bytes = meter_byte_array(value)
  if bytes == nil or #bytes ~= 13 or bytes[1] ~= 0x01 or bytes[2] ~= 0x32 or bytes[3] ~= 0x08 then
    return false
  end
  local crc = meter_crc16_modbus(bytes, 11)
  local low, high = crc & 0xFF, (crc >> 8) & 0xFF
  return (bytes[12] == low and bytes[13] == high)
    or (bytes[12] == high and bytes[13] == low)
end

local function meter_infrared_frame_valid(value)
  local bytes = meter_byte_array(value)
  if bytes == nil or #bytes ~= 7 or bytes[1] ~= 0x01 or bytes[2] ~= 0x03 or bytes[3] ~= 0x02 then
    return false
  end
  local crc = meter_crc16_modbus(bytes, 5)
  return bytes[6] == (crc & 0xFF) and bytes[7] == ((crc >> 8) & 0xFF)
end

local function meter_hex(bytes)
  local parts = {}
  for index = 1, #bytes do parts[index] = string.format("%02X", bytes[index] & 0xFF) end
  return table.concat(parts, " ")
end

local function meter_teco_ascii(command)
  command = string.upper(command)
  local checksum = 0
  for index = 1, #command do checksum = checksum + string.byte(command, index) end
  return command .. string.format("%02X,", checksum & 0xFF)
end

local function meter_teco_speed_command(rpm_value, direction_value)
  local rpm = tonumber(rpm_value) or 0
  if (tonumber(direction_value) or 0) == 1 then rpm = -rpm end
  local encoded = -math.floor(rpm * 8.192 + 0.5)
  return meter_teco_ascii(string.format("W536%04X", encoded & 0xFFFF))
end

local function meter_resistance_range(value)
  local bytes = meter_byte_array(value)
  if bytes == nil then return nil end
  if #bytes >= 6 then
    local minimum = meter_int16_le(bytes, 0)
    local maximum = meter_int16_le(bytes, 2)
    local increment = meter_uint16_le(bytes, 4)
    if minimum == nil or maximum == nil or increment == nil or maximum < minimum then return nil end
    return { minimum = minimum, maximum = maximum, increment = increment, width = 2 }
  end
  if #bytes >= 3 and bytes[2] >= bytes[1] then
    return { minimum = bytes[1], maximum = bytes[2], increment = bytes[3], width = 1 }
  end
  return nil
end

local function meter_ftms_target(mode_value, target_value, range_value)
  local mode = string.lower(string.match(tostring(mode_value or ""), "^%s*(.-)%s*$"))
  -- CSV grade values are percentages; an empty value uses the 1% default.
  if mode == "grade" then
    if target_value == nil or tostring(target_value):match("^%s*$") then target_value = 1 end
    local grade = tonumber(target_value)
    if grade == nil or grade ~= grade or grade < -327.68 or grade > 327.67 then
      error("FTMS grade must be between -327.68 and 327.67 percent")
    end
    local encoded = math.floor(grade * 100 + 0.5) & 0xFFFF
    -- FTMS 0x11: wind_speed=0 m/s, grade in 0.01%, crr=0.004, cw=0.51.
    -- cwb=1.0 is the reference default; FTMS has no separate cwb field.
    return meter_hex({ 0x11, 0x00, 0x00, encoded & 0xFF, (encoded >> 8) & 0xFF, 40, 51 }), "80 11 01"
  end

  local target = tonumber(target_value)
  if target == nil then error("FTMS " .. (mode ~= "" and mode or "target") .. " value must be numeric") end

  if mode == "power" then
    local watts = math.floor(target + 0.5)
    if watts < -32768 or watts > 32767 then error("FTMS power is outside SINT16 range") end
    local encoded = watts & 0xFFFF
    return meter_hex({ 0x05, encoded & 0xFF, (encoded >> 8) & 0xFF }), "80 05 01"
  end

  if mode ~= "percent" then error("FTMS mode must be percent, power or grade") end
  if target < 0 or target > 100 then error("FTMS resistance percentage must be between 0 and 100") end
  local range = meter_resistance_range(range_value)
  if range == nil then error("FTMS Supported Resistance Level Range must contain 3 or 6 bytes") end
  local requested = range.minimum + ((range.maximum - range.minimum) * target / 100)
  local increment = math.max(1, range.increment)
  local raw = range.minimum + math.floor(((requested - range.minimum) / increment) + 0.5) * increment
  raw = math.min(range.maximum, math.max(range.minimum, raw))
  if range.width == 1 then return meter_hex({ 0x04, raw & 0xFF }), "80 04 01" end
  local encoded = raw & 0xFFFF
  return meter_hex({ 0x04, encoded & 0xFF, (encoded >> 8) & 0xFF }), "80 04 01"
end

local function meter_prepare_control(args)
  local delay_seconds = tonumber(args.delay)
  if delay_seconds == nil or delay_seconds < 0 then error("CSV delay must be a non-negative number") end
  local delay_ms = math.floor(delay_seconds * 1000 + 0.5)
  local ftms_command, response_prefix = meter_ftms_target(args.mode, args.value, args.resistanceRangeBytes)
  return {
    motorCommand = meter_teco_speed_command(args.rpm, args.direction),
    ftmsCommandHex = ftms_command,
    ftmsResponsePrefix = response_prefix,
    sampleCount = math.floor(delay_ms / 1000),
    sampleRemainderMs = delay_ms % 1000,
  }
end

local function meter_torque_measurement(args)
  local sample = meter_byte_array(args.sampleBytes)
  local zero = meter_byte_array(args.zeroBytes)
  if sample == nil or not meter_torque_frame_valid(sample) then error("Torque sample is not a valid 32H frame") end
  if zero == nil or not meter_torque_frame_valid(zero) then error("Torque zero sample is not a valid 32H frame") end
  local torque_hz = meter_float32_le(sample, 3)
  local speed_hz = meter_float32_le(sample, 7)
  local zero_torque_hz = meter_float32_le(zero, 3)
  if torque_hz == nil or speed_hz == nil or zero_torque_hz == nil then
    error("Torque 32H frame contains an invalid float value")
  end
  local teeth = tonumber(args.toothCount)
  if args.toothCount == nil or args.toothCount == "" then teeth = 1024 end
  if teeth == nil or teeth <= 0 then error("Torque tooth count must be a number greater than zero") end
  local torque_nm = 100 * ((torque_hz - zero_torque_hz) / 5000)
  local rpm = speed_hz * 60 / teeth
  local power_w = torque_nm * rpm * 2 * math.pi / 60
  return {
    torqueHz = meter_round(torque_hz, 3),
    speedHz = meter_round(speed_hz, 3),
    torqueNm = meter_round(torque_nm, 3),
    rpm = meter_round(rpm, 3),
    powerW = meter_round(power_w, 3),
  }
end

local function meter_infrared_temperature(args)
  local bytes = meter_byte_array(args.bytes)
  if bytes == nil or not meter_infrared_frame_valid(bytes) then
    error("Infrared temperature response is not a valid Modbus frame")
  end
  local raw = (bytes[4] << 8) | bytes[5]
  if (raw & 0x8000) ~= 0 then raw = raw - 0x10000 end
  return { temperatureC = meter_round(raw / 10, 1) }
end

local function meter_empty_ftms(reason)
  return {
    valid = false,
    reason = reason,
    instantaneousPowerW = "",
    rearWheelSpeedRpm = "",
    adcCurrent = "",
    coilCurrentMa = "",
    siliconTemperatureC = "",
    pwmTicks = "",
    wheelTemperatureC = "",
    rawPower = "",
  }
end

local function meter_ftms_custom_data(args)
  local packet = args.packet
  if type(packet) ~= "table" or packet.available ~= true then
    return meter_empty_ftms(type(packet) == "table" and tostring(packet.reason or "no new packet") or "no new packet")
  end
  local bytes = meter_byte_array(packet.bytes)
  if bytes == nil or #bytes < 2 then return meter_empty_ftms("packet does not contain FTMS Indoor Bike Data") end
  local flags = meter_uint16_le(bytes, 0)
  local offset = 2
  local instantaneous_power = ""
  if (flags & (1 << 0)) == 0 then offset = offset + 2 end
  if (flags & (1 << 1)) ~= 0 then offset = offset + 2 end
  if (flags & (1 << 2)) ~= 0 then offset = offset + 2 end
  if (flags & (1 << 3)) ~= 0 then offset = offset + 2 end
  if (flags & (1 << 4)) ~= 0 then offset = offset + 3 end
  if (flags & (1 << 5)) ~= 0 then offset = offset + 2 end
  if (flags & (1 << 6)) ~= 0 then
    instantaneous_power = meter_int16_le(bytes, offset)
    if instantaneous_power == nil then return meter_empty_ftms("truncated FTMS instantaneous power") end
    offset = offset + 2
  end
  if (flags & (1 << 7)) ~= 0 then offset = offset + 2 end
  if (flags & (1 << 8)) ~= 0 then offset = offset + 5 end
  if (flags & (1 << 9)) ~= 0 then offset = offset + 1 end
  if (flags & (1 << 10)) ~= 0 then offset = offset + 1 end
  if (flags & (1 << 11)) ~= 0 then offset = offset + 2 end
  if (flags & (1 << 12)) ~= 0 then offset = offset + 2 end
  local custom_length = #bytes - offset
  if custom_length ~= 10 and custom_length < 12 then
    return meter_empty_ftms("Indoor Bike Data does not contain a valid 10-byte or extended custom suffix")
  end
  local wheel_temperature = custom_length >= 12 and meter_int16_le(bytes, offset + 10) or ""
  local raw_power = custom_length >= 14 and meter_int16_le(bytes, offset + 12) or ""
  local result = {
    valid = true,
    reason = "",
    instantaneousPowerW = instantaneous_power,
    rearWheelSpeedRpm = meter_uint16_le(bytes, offset),
    adcCurrent = meter_int16_le(bytes, offset + 2),
    coilCurrentMa = meter_int16_le(bytes, offset + 4),
    siliconTemperatureC = meter_round(meter_int16_le(bytes, offset + 6) / 10, 1),
    pwmTicks = meter_int16_le(bytes, offset + 8),
    wheelTemperatureC = wheel_temperature == "" and "" or meter_round(wheel_temperature / 10, 1),
    rawPower = raw_power,
  }
  if result.rearWheelSpeedRpm == nil or result.adcCurrent == nil or result.coilCurrentMa == nil
    or result.siliconTemperatureC == nil or result.pwmTicks == nil then
    return meter_empty_ftms("truncated FTMS custom suffix")
  end
  return result
end

local meter_helper_implementations = {
  prepareControl = meter_prepare_control,
  torqueFrameValid = function(args) return { valid = meter_torque_frame_valid(args.bytes) } end,
  torqueMeasurement = meter_torque_measurement,
  infraredFrameValid = function(args) return { valid = meter_infrared_frame_valid(args.bytes) } end,
  infraredTemperature = meter_infrared_temperature,
  ftmsCustomData = meter_ftms_custom_data,
}

function helpers()
  local result = {}
  for name, _ in pairs(meter_helper_implementations) do result[#result + 1] = { name = name } end
  return result
end

function call(name, args)
  local implementation = meter_helper_implementations[name]
  if implementation == nil then error("unknown meter-bench helper: " .. tostring(name)) end
  return implementation(args or {})
end

return {
  version = 1,
  name = "测表",
  description = "Drive the motor and FTMS target from a selected CSV while keeping the selected bench channels reconnectable across LinkAssist restarts.",
  helpers = {
    bench = { embedded = true },
  },
  defaults = {
    stopOnFailure = true,
    timeoutMs = 5000,
    dataFormat = "hex",
    logLimit = 1000,
  },
  variables = {
    form = {
      motorChannelId = "",
      torqueChannelId = "",
      infrared1ChannelId = "",
      infrared2ChannelId = "",
      bleChannelId = "",
      csvPath = "",
      loop = false,
      torqueTeeth = "1024",
    },
    direction = 1,
    ftmsServiceUuid = "00001826-0000-1000-8000-00805f9b34fb",
    ftmsControlPointCharUuid = "00002ad9-0000-1000-8000-00805f9b34fb",
    ftmsResistanceRangeCharUuid = "00002ad6-0000-1000-8000-00805f9b34fb",
    ftmsIndoorBikeDataCharUuid = "00002ad2-0000-1000-8000-00805f9b34fb",
    ftmsDataMaxAgeMs = 1500,
    torqueRequestHex = "01 32 81 F5",
    torqueZeroSettleMs = 1000,
    torqueSampleTimeoutMs = 700,
    infraredRequestHex = "01 03 00 00 00 01 84 0A",
    infraredSampleTimeoutMs = 700,
    infrared1Temperature = "",
    infrared2Temperature = "",
  },
  ui = {
    schemaVersion = 1,
    stateVersion = "motor-torque-ftms-csv-v1",
    showHeaderInfo = false,
    toolbar = {
      {
        id = "loop",
        type = "checkbox",
        label = "循环测试",
        bind = "form.loop",
        persist = true,
      },
      {
        id = "motor-channel",
        type = "select",
        label = "电机",
        bind = "form.motorChannelId",
        persist = true,
        editable = true,
        allowEmpty = false,
        placeholder = "COM",
        options = { source = "app.channels.serial", valuePath = "id", labelPath = "name" },
      },
      {
        id = "torque-channel",
        type = "select",
        label = "扭力计",
        bind = "form.torqueChannelId",
        persist = true,
        editable = true,
        allowEmpty = false,
        placeholder = "COM",
        options = { source = "app.channels.serial", valuePath = "id", labelPath = "name" },
      },
      {
        id = "infrared-1-channel",
        type = "select",
        label = "红外1",
        bind = "form.infrared1ChannelId",
        persist = true,
        editable = true,
        allowEmpty = true,
        placeholder = "COM",
        options = { source = "app.channels.serial", valuePath = "id", labelPath = "name" },
      },
      {
        id = "infrared-2-channel",
        type = "select",
        label = "红外2",
        bind = "form.infrared2ChannelId",
        persist = true,
        editable = true,
        allowEmpty = true,
        placeholder = "COM",
        options = { source = "app.channels.serial", valuePath = "id", labelPath = "name" },
      },
      {
        id = "ble-channel",
        type = "select",
        label = "蓝牙",
        bind = "form.bleChannelId",
        persist = true,
        editable = true,
        allowEmpty = false,
        placeholder = "蓝牙",
        options = { source = "app.channels.ble", valuePath = "id", labelPath = "name" },
      },
      {
        id = "run",
        type = "button",
        label = "运行",
        action = "runCsv",
        variant = "primary",
        align = "end",
        runningHandler = "runCsv",
        runningLabel = "停止",
        runningAction = "$stop",
      },
    },
    layout = {
      preset = "top-bottom",
      regions = { "source", "result" },
      primarySize = 24,
      minPrimaryPx = 48,
      minSecondaryPx = 140,
      resizable = true,
    },
    regions = {
      source = {
        controlsLayout = "row",
        controls = {
          {
            id = "torque-teeth",
            type = "select",
            label = "齿数",
            bind = "form.torqueTeeth",
            persist = true,
            allowEmpty = false,
            inlineLabel = true,
            compact = true,
            options = {
              { value = "1024", label = "1024" },
              { value = "60", label = "60" },
            },
          },
          {
            id = "csv-file",
            type = "file",
            label = "控制 CSV",
            bind = "form.csvPath",
            persist = true,
            inlineLabel = true,
            extensions = { "csv" },
          },
        },
      },
      result = {
        controls = {
          { id = "steps", type = "stepList", showTimestamp = true, timestampFormat = "time" },
          { id = "logs", type = "logViewer", grow = true, errorOnly = true, hideWhenEmpty = true },
        },
      },
    },
  },
  csv = {
    rpmCommands = {
      path = "${form.csvPath}",
      encoding = "utf-8",
      header = true,
      reloadPerRow = true,
    },
  },
  csvLog = {
    rpmLoopLog = {
      path = "${runTimestamp()}.csv",
      baseDir = "executable",
      bom = true,
      header = false,
      columns = {
        "time",
        "torqueTitle", "torqueValue",
        "speedTitle", "speedValue",
        "powerTitle", "powerValue",
        "rearWheelSpeedTitle", "rearWheelSpeedValue",
        "adcCurrentTitle", "adcCurrentValue",
        "coilCurrentTitle", "coilCurrentValue",
        "coilTemperatureTitle", "coilTemperatureValue",
        "pwmTitle", "pwmValue",
        "instantaneousPowerTitle", "instantaneousPowerValue",
        "wheelTemperatureTitle", "wheelTemperatureValue",
        "modeTitle", "modeValue",
        "targetTitle", "targetValue",
        "infrared1Title", "infrared1Value",
        "infrared2Title", "infrared2Value",
        "rawPowerTitle", "rawPowerValue",
      },
    },
  },
  setup = {
    {
      id = "open-motor-uart",
      action = "open",
      display = "hidden",
      channel = "motorUart",
      channelType = "serial",
      name = "Selected Motor UART",
      params = { channelId = "${form.motorChannelId}", baudRate = 9600 },
    },
    {
      id = "open-torque-uart",
      action = "open",
      display = "hidden",
      channel = "torqueUart",
      channelType = "serial",
      name = "Selected Torque UART",
      params = { channelId = "${form.torqueChannelId}", baudRate = 9600 },
    },
    {
      id = "open-infrared-1-uart",
      action = "open",
      display = "hidden",
      when = { ["$ref"] = "form.infrared1ChannelId" },
      channel = "infrared1Uart",
      channelType = "serial",
      name = "Selected Infrared 1 UART",
      params = { channelId = "${form.infrared1ChannelId}", baudRate = 9600 },
    },
    {
      id = "open-infrared-2-uart",
      action = "open",
      display = "hidden",
      when = { ["$ref"] = "form.infrared2ChannelId" },
      channel = "infrared2Uart",
      channelType = "serial",
      name = "Selected Infrared 2 UART",
      params = { channelId = "${form.infrared2ChannelId}", baudRate = 9600 },
    },
    {
      id = "open-ftms-control-point",
      action = "open",
      display = "hidden",
      channel = "ftmsControl",
      channelType = "ble",
      name = "Selected FTMS BLE",
      params = {
        channelId = "${form.bleChannelId}",
        serviceUuid = "${ftmsServiceUuid}",
        charUuid = "${ftmsControlPointCharUuid}",
        subscribe = true,
      },
    },
    {
      id = "open-ftms-resistance-range",
      action = "open",
      display = "hidden",
      channel = "ftmsResistanceRange",
      channelType = "ble",
      name = "Selected FTMS BLE",
      params = {
        channelId = "${form.bleChannelId}",
        serviceUuid = "${ftmsServiceUuid}",
        charUuid = "${ftmsResistanceRangeCharUuid}",
        subscribe = false,
      },
    },
    {
      id = "open-ftms-indoor-bike-data",
      action = "open",
      display = "hidden",
      channel = "ftmsBikeData",
      channelType = "ble",
      name = "Selected FTMS BLE",
      params = {
        channelId = "${form.bleChannelId}",
        serviceUuid = "${ftmsServiceUuid}",
        charUuid = "${ftmsIndoorBikeDataCharUuid}",
        subscribe = true,
      },
    },
    {
      id = "read-ftms-resistance-range",
      action = "read",
      display = "hidden",
      channel = "ftmsResistanceRange",
      saveAs = "ftmsResistanceRange",
    },
    {
      id = "request-ftms-control",
      action = "request",
      display = "hidden",
      channel = "ftmsControl",
      send = { format = "hex", value = "00" },
      expect = { format = "hex", startsWith = "80 00 01" },
    },
    {
      id = "teco-init",
      action = "group",
      display = "hidden",
      steps = {
        { id = "teco-init-w60a", action = "send", display = "hidden", channel = "motorUart", data = { format = "text", value = "W60A0001BF," } },
        { id = "teco-init-w60b", action = "send", display = "hidden", channel = "motorUart", data = { format = "text", value = "W60B0000BF," } },
        { id = "teco-init-speed-zero", action = "send", display = "hidden", channel = "motorUart", data = { format = "text", value = "W5360000B5," } },
        { id = "teco-init-w63e", action = "send", display = "hidden", channel = "motorUart", data = { format = "text", value = "W63E0001C6," } },
        { id = "teco-init-w619", action = "send", display = "hidden", channel = "motorUart", data = { format = "text", value = "W6190001B8," } },
        { id = "teco-init-settle", action = "delay", display = "hidden", durationMs = 100 },
      },
    },
    {
      id = "torque-zero-settle",
      action = "delay",
      display = "hidden",
      durationMs = "${torqueZeroSettleMs}",
    },
    {
      id = "capture-torque-zero",
      action = "request",
      display = "hidden",
      channel = "torqueUart",
      send = { format = "hex", value = "${torqueRequestHex}" },
      expect = {
        format = "hex",
        startsWith = "01 32 08",
        length = 13,
        accumulate = true,
        luaHelper = {
          helper = "bench",
          func = "torqueFrameValid",
          args = { bytes = { ["$ref"] = "packet.bytes" } },
          resultPath = "valid",
          equals = true,
        },
      },
      retry = { times = 4, intervalMs = 40 },
      timeoutMs = "${torqueSampleTimeoutMs}",
      saveAs = "zeroSample",
    },
  },
  handlers = {
    runCsv = {
      {
        id = "run-control-csv",
        action = "forEachCsv",
        source = "rpmCommands",
        rowAs = "row",
        loop = { ["$ref"] = "form.loop" },
        reloadPerRow = true,
        steps = {
          {
            id = "row-${csvPassIndex}-${csvIndex}-rpm-${row.rpm}-${row.mode}-${row.value}-delay-${row.delay}",
            action = "group",
            childDisplay = "nested",
            steps = {
              {
                id = "prepare-row-${csvIndex}",
                action = "luaHelper",
                display = "hidden",
                helper = "bench",
                func = "prepareControl",
                args = {
                  rpm = { ["$ref"] = "row.rpm" },
                  direction = { ["$ref"] = "direction" },
                  mode = { ["$ref"] = "row.mode" },
                  value = { ["$ref"] = "row.value" },
                  resistanceRangeBytes = { ["$ref"] = "ftmsResistanceRange.bytes" },
                  delay = { ["$ref"] = "row.delay" },
                },
                saveAs = "rowControl",
              },
              {
                id = "set-rpm-${row.rpm}",
                action = "send",
                channel = "motorUart",
                data = { format = "text", value = "${rowControl.motorCommand}" },
              },
              {
                id = "set-ftms-${row.mode}-${row.value}",
                action = "request",
                channel = "ftmsControl",
                send = { format = "hex", value = "${rowControl.ftmsCommandHex}" },
                expect = { format = "hex", startsWith = "${rowControl.ftmsResponsePrefix}" },
              },
              {
                id = "sample-row-${csvIndex}",
                action = "repeat",
                times = "${rowControl.sampleCount}",
                periodMs = 1000,
                schedule = "bench-csv-1s",
                steps = {
                  {
                    id = "read-torque-${csvIndex}-${index}",
                    action = "request",
                    display = "hidden",
                    channel = "torqueUart",
                    send = { format = "hex", value = "${torqueRequestHex}" },
                    expect = {
                      format = "hex",
                      startsWith = "01 32 08",
                      length = 13,
                      accumulate = true,
                      luaHelper = {
                        helper = "bench",
                        func = "torqueFrameValid",
                        args = { bytes = { ["$ref"] = "packet.bytes" } },
                        resultPath = "valid",
                        equals = true,
                      },
                    },
                    retry = { times = 4, intervalMs = 40 },
                    timeoutMs = "${torqueSampleTimeoutMs}",
                    saveAs = "torqueSample",
                  },
                  {
                    id = "decode-torque-${csvIndex}-${index}",
                    action = "luaHelper",
                    display = "hidden",
                    helper = "bench",
                    func = "torqueMeasurement",
                    args = {
                      sampleBytes = { ["$ref"] = "torqueSample.bytes" },
                      zeroBytes = { ["$ref"] = "zeroSample.bytes" },
                      toothCount = { ["$ref"] = "form.torqueTeeth" },
                    },
                    saveAs = "benchMeasurement",
                  },
                  {
                    id = "take-ftms-${csvIndex}-${index}",
                    action = "takeLatestPacket",
                    display = "hidden",
                    channel = "ftmsBikeData",
                    maxAgeMs = "${ftmsDataMaxAgeMs}",
                    consume = true,
                    required = false,
                    saveAs = "ftmsPacket",
                  },
                  {
                    id = "decode-ftms-${csvIndex}-${index}",
                    action = "luaHelper",
                    display = "hidden",
                    helper = "bench",
                    func = "ftmsCustomData",
                    args = { packet = { ["$ref"] = "ftmsPacket" } },
                    saveAs = "ftmsSample",
                  },
                  {
                    id = "read-infrared-1-${csvIndex}-${index}",
                    action = "request",
                    display = "hidden",
                    when = { ["$ref"] = "form.infrared1ChannelId" },
                    channel = "infrared1Uart",
                    send = { format = "hex", value = "${infraredRequestHex}" },
                    expect = {
                      format = "hex",
                      startsWith = "01 03 02",
                      length = 7,
                      accumulate = true,
                      luaHelper = {
                        helper = "bench",
                        func = "infraredFrameValid",
                        args = { bytes = { ["$ref"] = "packet.bytes" } },
                        resultPath = "valid",
                        equals = true,
                      },
                    },
                    timeoutMs = "${infraredSampleTimeoutMs}",
                    saveAs = "infrared1Sample",
                  },
                  {
                    id = "decode-infrared-1-${csvIndex}-${index}",
                    action = "luaHelper",
                    display = "hidden",
                    when = { ["$ref"] = "form.infrared1ChannelId" },
                    helper = "bench",
                    func = "infraredTemperature",
                    args = { bytes = { ["$ref"] = "infrared1Sample.bytes" } },
                    saveAs = "infrared1Decoded",
                  },
                  {
                    id = "save-infrared-1-${csvIndex}-${index}",
                    action = "set",
                    display = "hidden",
                    when = { ["$ref"] = "form.infrared1ChannelId" },
                    name = "infrared1Temperature",
                    value = { ["$ref"] = "infrared1Decoded.temperatureC" },
                  },
                  {
                    id = "read-infrared-2-${csvIndex}-${index}",
                    action = "request",
                    display = "hidden",
                    when = { ["$ref"] = "form.infrared2ChannelId" },
                    channel = "infrared2Uart",
                    send = { format = "hex", value = "${infraredRequestHex}" },
                    expect = {
                      format = "hex",
                      startsWith = "01 03 02",
                      length = 7,
                      accumulate = true,
                      luaHelper = {
                        helper = "bench",
                        func = "infraredFrameValid",
                        args = { bytes = { ["$ref"] = "packet.bytes" } },
                        resultPath = "valid",
                        equals = true,
                      },
                    },
                    timeoutMs = "${infraredSampleTimeoutMs}",
                    saveAs = "infrared2Sample",
                  },
                  {
                    id = "decode-infrared-2-${csvIndex}-${index}",
                    action = "luaHelper",
                    display = "hidden",
                    when = { ["$ref"] = "form.infrared2ChannelId" },
                    helper = "bench",
                    func = "infraredTemperature",
                    args = { bytes = { ["$ref"] = "infrared2Sample.bytes" } },
                    saveAs = "infrared2Decoded",
                  },
                  {
                    id = "save-infrared-2-${csvIndex}-${index}",
                    action = "set",
                    display = "hidden",
                    when = { ["$ref"] = "form.infrared2ChannelId" },
                    name = "infrared2Temperature",
                    value = { ["$ref"] = "infrared2Decoded.temperatureC" },
                  },
                  {
                    id = "log-row-${csvIndex}-${index}",
                    action = "logCsv",
                    target = "rpmLoopLog",
                    row = {
                      time = "${nowLocalTimestampSpace()}",
                      torqueTitle = "扭矩", torqueValue = "${benchMeasurement.torqueNm}",
                      speedTitle = "转速", speedValue = "${benchMeasurement.rpm}",
                      powerTitle = "功率", powerValue = "${benchMeasurement.powerW}",
                      rearWheelSpeedTitle = "阻尼轮转速", rearWheelSpeedValue = "${ftmsSample.rearWheelSpeedRpm}",
                      adcCurrentTitle = "电流ADC采样值", adcCurrentValue = "${ftmsSample.adcCurrent}",
                      coilCurrentTitle = "线圈电流", coilCurrentValue = "${ftmsSample.coilCurrentMa}",
                      coilTemperatureTitle = "线圈温度", coilTemperatureValue = "${ftmsSample.siliconTemperatureC}",
                      pwmTitle = "PWM值", pwmValue = "${ftmsSample.pwmTicks}",
                      instantaneousPowerTitle = "瞬时功率", instantaneousPowerValue = "${ftmsSample.instantaneousPowerW}",
                      wheelTemperatureTitle = "阻尼轮温度", wheelTemperatureValue = "${ftmsSample.wheelTemperatureC}",
                      modeTitle = "模式", modeValue = "${row.mode}",
                      targetTitle = "模式下发", targetValue = "${row.value}",
                      infrared1Title = "红外温度1", infrared1Value = "${infrared1Temperature}",
                      infrared2Title = "红外温度2", infrared2Value = "${infrared2Temperature}",
                      rawPowerTitle = "原始功率", rawPowerValue = "${ftmsSample.rawPower}",
                    },
                  },
                },
              },
              {
                id = "delay-row-remainder-${csvIndex}",
                action = "delay",
                display = "hidden",
                durationMs = "${rowControl.sampleRemainderMs}",
              },
            },
          },
        },
      },
    },
  },
  onStop = {
    { id = "stop-set-rpm-zero", action = "send", display = "hidden", channel = "motorUart", data = { format = "text", value = "W5360000B5," } },
  },
  teardown = {
    { id = "teco-stop-speed-zero-first", action = "send", display = "hidden", channel = "motorUart", data = { format = "text", value = "W5360000B5," } },
    { id = "teco-stop-w619", action = "send", display = "hidden", channel = "motorUart", data = { format = "text", value = "W6190000B7," } },
    { id = "teco-stop-w63e", action = "send", display = "hidden", channel = "motorUart", data = { format = "text", value = "W63E0000C5," } },
    { id = "teco-stop-speed-zero-second", action = "send", display = "hidden", channel = "motorUart", data = { format = "text", value = "W5360000B5," } },
    { id = "teco-stop-w60a", action = "send", display = "hidden", channel = "motorUart", data = { format = "text", value = "W60A0000BE," } },
    { id = "close-ftms-indoor-bike-data", action = "close", display = "hidden", channel = "ftmsBikeData" },
    { id = "close-ftms-resistance-range", action = "close", display = "hidden", channel = "ftmsResistanceRange" },
    { id = "close-ftms-control-point", action = "close", display = "hidden", channel = "ftmsControl" },
    { id = "close-infrared-2-uart", action = "close", display = "hidden", when = { ["$ref"] = "form.infrared2ChannelId" }, channel = "infrared2Uart" },
    { id = "close-infrared-1-uart", action = "close", display = "hidden", when = { ["$ref"] = "form.infrared1ChannelId" }, channel = "infrared1Uart" },
    { id = "close-torque-uart", action = "close", display = "hidden", channel = "torqueUart" },
    { id = "close-motor-uart", action = "close", display = "hidden", channel = "motorUart" },
  },
}
