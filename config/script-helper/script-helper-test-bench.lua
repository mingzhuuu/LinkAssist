-- linkassist:type = script-helper

-- Device-specific codecs and calculations for the bundled meter-bench scripts.
-- LinkAssist only supplies the generic Script Helper sandbox and calls `call`;
-- adding another bench protocol does not require a Runtime change.

local function byte_array(value)
  if type(value) ~= "table" then return nil end
  local result = {}
  for index = 1, #value do
    local byte = tonumber(value[index])
    if byte == nil or byte % 1 ~= 0 or byte < 0 or byte > 255 then return nil end
    result[index] = byte
  end
  return result
end

local function round(value, digits)
  local factor = 10 ^ (digits or 0)
  return math.floor(value * factor + 0.5) / factor
end

local function uint16_le(bytes, offset)
  local low = bytes[offset + 1]
  local high = bytes[offset + 2]
  if low == nil or high == nil then return nil end
  return low | (high << 8)
end

local function int16_le(bytes, offset)
  local value = uint16_le(bytes, offset)
  if value == nil then return nil end
  if value >= 0x8000 then return value - 0x10000 end
  return value
end

local function float32_le(bytes, offset)
  local a, b, c, d = bytes[offset + 1], bytes[offset + 2], bytes[offset + 3], bytes[offset + 4]
  if a == nil or b == nil or c == nil or d == nil then return nil end
  local value = string.unpack("<f", string.char(a, b, c, d))
  if value ~= value or value == math.huge or value == -math.huge then return nil end
  return value
end

local function crc16_modbus(bytes, count)
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

local function torque_frame_valid(value)
  local bytes = byte_array(value)
  if bytes == nil or #bytes ~= 13 or bytes[1] ~= 0x01 or bytes[2] ~= 0x32 or bytes[3] ~= 0x08 then
    return false
  end
  local crc = crc16_modbus(bytes, 11)
  local low, high = crc & 0xFF, (crc >> 8) & 0xFF
  return (bytes[12] == low and bytes[13] == high)
    or (bytes[12] == high and bytes[13] == low)
end

local function infrared_frame_valid(value)
  local bytes = byte_array(value)
  if bytes == nil or #bytes ~= 7 or bytes[1] ~= 0x01 or bytes[2] ~= 0x03 or bytes[3] ~= 0x02 then
    return false
  end
  local crc = crc16_modbus(bytes, 5)
  return bytes[6] == (crc & 0xFF) and bytes[7] == ((crc >> 8) & 0xFF)
end

local function hex(bytes)
  local parts = {}
  for index = 1, #bytes do parts[index] = string.format("%02X", bytes[index] & 0xFF) end
  return table.concat(parts, " ")
end

local function teco_ascii(command)
  command = string.upper(command)
  local checksum = 0
  for index = 1, #command do checksum = checksum + string.byte(command, index) end
  return command .. string.format("%02X,", checksum & 0xFF)
end

local function teco_speed_command(rpm_value, direction_value)
  local rpm = tonumber(rpm_value) or 0
  if (tonumber(direction_value) or 0) == 1 then rpm = -rpm end
  local encoded = -math.floor(rpm * 8.192 + 0.5)
  return teco_ascii(string.format("W536%04X", encoded & 0xFFFF))
end

local function resistance_range(value)
  local bytes = byte_array(value)
  if bytes == nil then return nil end
  if #bytes >= 6 then
    local minimum = int16_le(bytes, 0)
    local maximum = int16_le(bytes, 2)
    local increment = uint16_le(bytes, 4)
    if minimum == nil or maximum == nil or increment == nil or maximum < minimum then return nil end
    return { minimum = minimum, maximum = maximum, increment = increment, width = 2 }
  end
  if #bytes >= 3 and bytes[2] >= bytes[1] then
    return { minimum = bytes[1], maximum = bytes[2], increment = bytes[3], width = 1 }
  end
  return nil
end

local function ftms_target(mode_value, target_value, range_value)
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
    return hex({ 0x11, 0x00, 0x00, encoded & 0xFF, (encoded >> 8) & 0xFF, 40, 51 }), "80 11 01"
  end

  local target = tonumber(target_value)
  if target == nil then error("FTMS " .. (mode ~= "" and mode or "target") .. " value must be numeric") end

  if mode == "power" then
    local watts = math.floor(target + 0.5)
    if watts < -32768 or watts > 32767 then error("FTMS power is outside SINT16 range") end
    local encoded = watts & 0xFFFF
    return hex({ 0x05, encoded & 0xFF, (encoded >> 8) & 0xFF }), "80 05 01"
  end

  if mode ~= "percent" then error("FTMS mode must be percent, power or grade") end
  if target < 0 or target > 100 then error("FTMS resistance percentage must be between 0 and 100") end
  local range = resistance_range(range_value)
  if range == nil then error("FTMS Supported Resistance Level Range must contain 3 or 6 bytes") end
  local requested = range.minimum + ((range.maximum - range.minimum) * target / 100)
  local increment = math.max(1, range.increment)
  local raw = range.minimum + math.floor(((requested - range.minimum) / increment) + 0.5) * increment
  raw = math.min(range.maximum, math.max(range.minimum, raw))
  if range.width == 1 then return hex({ 0x04, raw & 0xFF }), "80 04 01" end
  local encoded = raw & 0xFFFF
  return hex({ 0x04, encoded & 0xFF, (encoded >> 8) & 0xFF }), "80 04 01"
end

local function prepare_control(args)
  local delay_seconds = tonumber(args.delay)
  if delay_seconds == nil or delay_seconds < 0 then error("CSV delay must be a non-negative number") end
  local delay_ms = math.floor(delay_seconds * 1000 + 0.5)
  local ftms_command, response_prefix = ftms_target(args.mode, args.value, args.resistanceRangeBytes)
  return {
    motorCommand = teco_speed_command(args.rpm, args.direction),
    ftmsCommandHex = ftms_command,
    ftmsResponsePrefix = response_prefix,
    sampleCount = math.floor(delay_ms / 1000),
    sampleRemainderMs = delay_ms % 1000,
  }
end

local function torque_measurement(args)
  local sample = byte_array(args.sampleBytes)
  local zero = byte_array(args.zeroBytes)
  if sample == nil or not torque_frame_valid(sample) then error("Torque sample is not a valid 32H frame") end
  if zero == nil or not torque_frame_valid(zero) then error("Torque zero sample is not a valid 32H frame") end
  local torque_hz = float32_le(sample, 3)
  local speed_hz = float32_le(sample, 7)
  local zero_torque_hz = float32_le(zero, 3)
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
    torqueHz = round(torque_hz, 3),
    speedHz = round(speed_hz, 3),
    torqueNm = round(torque_nm, 3),
    rpm = round(rpm, 3),
    powerW = round(power_w, 3),
  }
end

local function infrared_temperature(args)
  local bytes = byte_array(args.bytes)
  if bytes == nil or not infrared_frame_valid(bytes) then
    error("Infrared temperature response is not a valid Modbus frame")
  end
  local raw = (bytes[4] << 8) | bytes[5]
  if (raw & 0x8000) ~= 0 then raw = raw - 0x10000 end
  return { temperatureC = round(raw / 10, 1) }
end

local function empty_ftms(reason)
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
  }
end

local function ftms_custom_data(args)
  local packet = args.packet
  if type(packet) ~= "table" or packet.available ~= true then
    return empty_ftms(type(packet) == "table" and tostring(packet.reason or "no new packet") or "no new packet")
  end
  local bytes = byte_array(packet.bytes)
  if bytes == nil or #bytes < 2 then return empty_ftms("packet does not contain FTMS Indoor Bike Data") end
  local flags = uint16_le(bytes, 0)
  local offset = 2
  local instantaneous_power = ""
  if (flags & (1 << 0)) == 0 then offset = offset + 2 end
  if (flags & (1 << 1)) ~= 0 then offset = offset + 2 end
  if (flags & (1 << 2)) ~= 0 then offset = offset + 2 end
  if (flags & (1 << 3)) ~= 0 then offset = offset + 2 end
  if (flags & (1 << 4)) ~= 0 then offset = offset + 3 end
  if (flags & (1 << 5)) ~= 0 then offset = offset + 2 end
  if (flags & (1 << 6)) ~= 0 then
    instantaneous_power = int16_le(bytes, offset)
    if instantaneous_power == nil then return empty_ftms("truncated FTMS instantaneous power") end
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
    return empty_ftms("Indoor Bike Data does not contain a valid 10-byte or 12-byte custom suffix")
  end
  local wheel_temperature = custom_length >= 12 and int16_le(bytes, offset + 10) or ""
  local result = {
    valid = true,
    reason = "",
    instantaneousPowerW = instantaneous_power,
    rearWheelSpeedRpm = uint16_le(bytes, offset),
    adcCurrent = int16_le(bytes, offset + 2),
    coilCurrentMa = int16_le(bytes, offset + 4),
    siliconTemperatureC = round(int16_le(bytes, offset + 6) / 10, 1),
    pwmTicks = int16_le(bytes, offset + 8),
    wheelTemperatureC = wheel_temperature == "" and "" or round(wheel_temperature / 10, 1),
  }
  if result.rearWheelSpeedRpm == nil or result.adcCurrent == nil or result.coilCurrentMa == nil
    or result.siliconTemperatureC == nil or result.pwmTicks == nil then
    return empty_ftms("truncated FTMS custom suffix")
  end
  return result
end

local function spin_down_target(bytes_value)
  local bytes = byte_array(bytes_value)
  if bytes == nil or #bytes < 7 or bytes[1] ~= 0x80 or bytes[2] ~= 0x13 or bytes[3] ~= 0x01 then
    return { available = false, label = "target speed unavailable" }
  end
  local low, high = uint16_le(bytes, 3) / 100, uint16_le(bytes, 5) / 100
  if low > high then low, high = high, low end
  local label = math.abs(low - high) < 0.001
    and string.format("%.1f km/h", low)
    or string.format("%.1f-%.1f km/h", low, high)
  return { available = true, lowKph = low, highKph = high, label = label }
end

local function indoor_bike_speed(bytes_value)
  local bytes = byte_array(bytes_value)
  if bytes == nil or #bytes < 4 then return { available = false, label = "speed unavailable" } end
  local flags = uint16_le(bytes, 0)
  if (flags & 0x0001) ~= 0 then return { available = false, label = "speed unavailable" } end
  local speed = uint16_le(bytes, 2) / 100
  return { available = true, speedKph = speed, label = string.format("%.1f km/h", speed) }
end

local function spin_down_status(bytes_value)
  local bytes = byte_array(bytes_value)
  if bytes == nil or #bytes < 2 or bytes[1] ~= 0x14 then
    return { available = false, code = -1, label = "Unknown", resultReady = false }
  end
  local code = bytes[2]
  local labels = {
    [0x01] = "Spin Down Requested",
    [0x02] = "Success",
    [0x03] = "Error",
    [0x04] = "Stop Pedaling",
  }
  return {
    available = true,
    code = code,
    label = labels[code] or string.format("Unknown (%d)", code),
    resultReady = code == 0x02 or code == 0x03,
  }
end

local implementations = {
  prepareControl = prepare_control,
  torqueFrameValid = function(args) return { valid = torque_frame_valid(args.bytes) } end,
  torqueMeasurement = torque_measurement,
  infraredFrameValid = function(args) return { valid = infrared_frame_valid(args.bytes) } end,
  infraredTemperature = infrared_temperature,
  ftmsCustomData = ftms_custom_data,
  spinDownTarget = function(args) return spin_down_target(args.bytes) end,
  indoorBikeSpeed = function(args) return indoor_bike_speed(args.bytes) end,
  indoorBikeSpeedInTarget = function(args)
    local speed = indoor_bike_speed(args.bytes)
    local target = args.target
    return {
      matched = speed.available == true and type(target) == "table" and target.available == true
        and speed.speedKph >= target.lowKph and speed.speedKph <= target.highKph,
    }
  end,
  spinDownStatus = function(args) return spin_down_status(args.bytes) end,
  spinDownResultReady = function(args) return { matched = spin_down_status(args.bytes).resultReady } end,
}

function helpers()
  local result = {}
  for name, _ in pairs(implementations) do result[#result + 1] = { name = name } end
  return result
end

function call(name, args)
  local implementation = implementations[name]
  if implementation == nil then error("unknown test-bench helper: " .. tostring(name)) end
  return implementation(args or {})
end
