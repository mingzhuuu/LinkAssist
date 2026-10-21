-- linkassist:type = protocol

--[[
  UNI-T UT61E Digital Multimeter Protocol Parser
  -----------------------------------------------
  Based on Cyrustek ES51922 chipset protocol
  Reference: https://github.com/4x1md/ut61e_py

  Serial Settings: 19200 baud, 7 data bits, odd parity, 1 stop bit
  Data Packet: 14 bytes

  Byte 0: Measurement range + mode info
  Byte 1-5: 5 display digits (BCD encoded)
  Byte 6: DMM mode
  Byte 7: Info flags (percent, minus, low battery, OL)
  Byte 8: Relative mode flags
  Byte 9: Limit flags
  Byte 10: Voltage and auto range flags
  Byte 11: Hold flags
  Byte 12: Footer 0x0D (\r)
  Byte 13: Footer 0x0A (\n)
]]

local MODE_MAP = {
  [0x0B] = "Voltage",
  [0x03] = "Resistance",
  [0x06] = "Capacitance",
  [0x02] = "Frequency",
  [0x0D] = "Current_uA",
  [0x0F] = "Current_mA",
  [0x00] = "Current_A",
}

local RANGE_TABLE = {
  [0x0B] = {
    [0] = "2.2000",
    [1] = "22.000",
    [2] = "220.00",
    [3] = "1000.0",
    [4] = "220.00m"
  },
  [0x03] = {
    [0] = "220.00",
    [1] = "2.2000k",
    [2] = "22.000k",
    [3] = "220.00k",
    [4] = "2.200M",
    [5] = "22.000M",
    [6] = "220.00M"
  },
  [0x06] = {
    [0] = "22.000n",
    [1] = "220.00n",
    [2] = "2.2000u",
    [3] = "22.000u",
    [4] = "220.00u",
    [5] = "2.2000m",
    [6] = "22.000m",
    [7] = "220.00m"
  },
  [0x02] = {
    [0] = "220.00",
    [1] = "2200.0",
    [3] = "22.000k",
    [4] = "220.00k",
    [5] = "2.2000M",
    [6] = "22.000M",
    [7] = "220.00M"
  },
  [0x0D] = {
    [0] = "220.00u",
    [1] = "2200.0u"
  },
  [0x0F] = {
    [0] = "22.000m",
    [1] = "220.00m"
  },
  [0x00] = {
    [0] = "10.000"
  }
}

local UNIT_MAP = {
  [0x0B] = "V",
  [0x03] = "Ohm",
  [0x06] = "F",
  [0x02] = "Hz",
  [0x0D] = "uA",
  [0x0F] = "mA",
  [0x00] = "A"
}

local function bcd_to_digit(byte_val)
  return byte_val & 0x0F
end

local function parse_display_value(d1, d2, d3, d4, d5, range_str)
  local digit1 = bcd_to_digit(d1)
  local digit2 = bcd_to_digit(d2)
  local digit3 = bcd_to_digit(d3)
  local digit4 = bcd_to_digit(d4)
  local digit5 = bcd_to_digit(d5)

  local display_str = string.format("%d%d%d%d%d", digit1, digit2, digit3, digit4, digit5)
  local display_num = tonumber(display_str)

  if not range_str then
    return display_num
  end

  if string.find(range_str, "%.%d%d%d%d$") then
    return display_num / 10000
  elseif string.find(range_str, "%.%d%d%d$") then
    return display_num / 1000
  elseif string.find(range_str, "%.%d%d$") then
    return display_num / 100
  elseif string.find(range_str, "%.%d$") then
    return display_num / 10
  end

  return display_num
end

local function get_range_index(byte0)
  return byte0 & 0x07
end

function schema()
  return {
    { id = "display_value", alias = "Display Value", name = "display_value", field_type = "Float32BE", description = "Measured value from display digits" },
    { id = "normalized_value", alias = "Normalized Value", name = "normalized_value", field_type = "Float32BE", description = "Value normalized to base units (V, A, Ohm, F, Hz)" },
    { id = "mode", alias = "Measurement Mode", name = "mode", field_type = "Utf8String", description = "Measurement mode (Voltage, Resistance, etc.)" },
    { id = "range", alias = "Measurement Range", name = "range", field_type = "Utf8String", description = "Range display string" },
    { id = "unit", alias = "Unit", name = "unit", field_type = "Utf8String", description = "Measurement unit" },
    { id = "raw_byte0", alias = "Range Byte", name = "raw_byte0", field_type = "UInt8", description = "Byte 0: Range and mode info" },
    { id = "raw_mode", alias = "Mode Byte", name = "raw_mode", field_type = "UInt8", description = "Byte 6: DMM mode" },
    { id = "raw_info", alias = "Info Byte", name = "raw_info", field_type = "UInt8", description = "Byte 7: Info flags" },
    { id = "is_percent", alias = "Percent Mode", name = "is_percent", field_type = "Bool", description = "Duty cycle % measurement" },
    { id = "is_negative", alias = "Negative Value", name = "is_negative", field_type = "Bool", description = "Negative value displayed" },
    { id = "low_battery", alias = "Low Battery", name = "low_battery", field_type = "Bool", description = "Low battery indicator" },
    { id = "overload", alias = "Overload (OL)", name = "overload", field_type = "Bool", description = "Overload (OL) indicator" },
    { id = "is_relative", alias = "Relative Mode", name = "is_relative", field_type = "Bool", description = "Relative measurement (delta)" },
    { id = "is_max", alias = "MAX Mode", name = "is_max", field_type = "Bool", description = "Peak max value" },
    { id = "is_min", alias = "MIN Mode", name = "is_min", field_type = "Bool", description = "Peak min value" },
    { id = "underload", alias = "Underload (UL)", name = "underload", field_type = "Bool", description = "Underload (UL) indicator" },
    { id = "is_dc", alias = "DC Measurement", name = "is_dc", field_type = "Bool", description = "DC voltage/current is measured" },
    { id = "is_ac", alias = "AC Measurement", name = "is_ac", field_type = "Bool", description = "AC voltage/current is measured" },
    { id = "auto_range", alias = "Auto Range", name = "auto_range", field_type = "Bool", description = "Auto range enabled" },
    { id = "is_hz", alias = "Frequency Mode", name = "is_hz", field_type = "Bool", description = "Frequency measurement (Hz)" },
    { id = "hold", alias = "Data Hold", name = "hold", field_type = "Bool", description = "Data hold active" },
    { id = "raw_packet", alias = "Raw Packet", name = "raw_packet", field_type = "Utf8String", description = "Complete raw packet as hex string" },
  }
end

function parse(data, len)
  local fields = {}

  if len < 14 then
    return fields
  end

  local byte0 = read_u8(data, 0)
  local byte1 = read_u8(data, 1)
  local byte2 = read_u8(data, 2)
  local byte3 = read_u8(data, 3)
  local byte4 = read_u8(data, 4)
  local byte5 = read_u8(data, 5)
  local byte6 = read_u8(data, 6)
  local byte7 = read_u8(data, 7)
  local byte8 = read_u8(data, 8)
  local byte9 = read_u8(data, 9)
  local byte10 = read_u8(data, 10)
  local byte11 = read_u8(data, 11)
  local byte12 = read_u8(data, 12)
  local byte13 = read_u8(data, 13)

  local raw_bytes = {byte0, byte1, byte2, byte3, byte4, byte5, byte6, byte7,
                     byte8, byte9, byte10, byte11, byte12, byte13}
  fields[#fields + 1] = { id = "raw_packet", value = bytes_to_hex(raw_bytes) }
  fields[#fields + 1] = { id = "raw_byte0", value = byte0 }
  fields[#fields + 1] = { id = "raw_mode", value = byte6 }
  fields[#fields + 1] = { id = "raw_info", value = byte7 }

  local mode_nibble = byte6 & 0x0F
  local mode_name = MODE_MAP[mode_nibble] or "Unknown"
  fields[#fields + 1] = { id = "mode", value = mode_name }

  local range_idx = get_range_index(byte0)

  local range_str = nil
  if RANGE_TABLE[mode_nibble] then
    range_str = RANGE_TABLE[mode_nibble][range_idx]
  end
  fields[#fields + 1] = { id = "range", value = range_str or "Unknown" }

  local unit = UNIT_MAP[mode_nibble] or ""
  fields[#fields + 1] = { id = "unit", value = unit }

  local display_val = parse_display_value(byte1, byte2, byte3, byte4, byte5, range_str)

  local is_negative = (byte7 & 0x04) ~= 0
  if is_negative then
    display_val = -display_val
  end
  fields[#fields + 1] = { id = "display_value", value = display_val }

  local normalized_val = display_val
  if range_str then
    if string.find(range_str, "m$") or string.find(range_str, "m ") then
      normalized_val = display_val / 1000
    elseif string.find(range_str, "u$") or string.find(range_str, "u ") then
      normalized_val = display_val / 1000000
    elseif string.find(range_str, "n$") or string.find(range_str, "n ") then
      normalized_val = display_val / 1000000000
    elseif string.find(range_str, "k$") or string.find(range_str, "k ") then
      normalized_val = display_val * 1000
    elseif string.find(range_str, "M$") or string.find(range_str, "M ") then
      normalized_val = display_val * 1000000
    end
  end
  fields[#fields + 1] = { id = "normalized_value", value = normalized_val }

  fields[#fields + 1] = { id = "is_percent", value = (byte7 & 0x08) ~= 0 }
  fields[#fields + 1] = { id = "is_negative", value = is_negative }
  fields[#fields + 1] = { id = "low_battery", value = (byte7 & 0x02) ~= 0 }
  fields[#fields + 1] = { id = "overload", value = (byte7 & 0x01) ~= 0 }

  fields[#fields + 1] = { id = "is_relative", value = (byte8 & 0x02) ~= 0 }
  fields[#fields + 1] = { id = "is_max", value = (byte8 & 0x08) ~= 0 }
  fields[#fields + 1] = { id = "is_min", value = (byte8 & 0x04) ~= 0 }

  fields[#fields + 1] = { id = "underload", value = (byte9 & 0x08) ~= 0 }

  fields[#fields + 1] = { id = "is_dc", value = (byte10 & 0x08) ~= 0 }
  fields[#fields + 1] = { id = "is_ac", value = (byte10 & 0x04) ~= 0 }
  fields[#fields + 1] = { id = "auto_range", value = (byte10 & 0x02) ~= 0 }
  fields[#fields + 1] = { id = "is_hz", value = (byte10 & 0x01) ~= 0 }

  fields[#fields + 1] = { id = "hold", value = (byte11 & 0x02) ~= 0 }

  return fields
end
