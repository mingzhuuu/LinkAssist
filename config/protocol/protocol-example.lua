-- linkassist:type = protocol

--[[
  LinkAssist Lua Protocol Script Example
  -------------------------------------
  This file demonstrates the schema() + parse() convention.

  Functions must be global (not local) to be callable by the runtime.
]]

-- Helper: Read helpers are pre-injected by the Lua engine
-- read_u8(data, offset) -> number
-- read_u16_le(data, offset) -> number
-- read_float_le(data, offset) -> number
-- bytes_to_hex(bytes) -> string

-- schema() returns field metadata for UI field selection
-- Returns: table of { id, alias, name, field_type, description }
function schema()
  return {
    { id = "packet_type", alias = "Packet Type", name = "packet_type", field_type = "UInt8", description = "Packet type identifier" },
    { id = "device_status", alias = "Device Status", name = "device_status", field_type = "UInt8", description = "Bit flags for device state" },
    { id = "temperature", alias = "Temperature", name = "temperature", field_type = "Float32LE", description = "Temperature in Celsius" },
    { id = "humidity", alias = "Humidity", name = "humidity", field_type = "Float32LE", description = "Relative humidity %" },
    { id = "pressure", alias = "Pressure", name = "pressure", field_type = "UInt32LE", description = "Pressure in Pa" },
    { id = "battery_mv", alias = "Battery mV", name = "battery_mv", field_type = "UInt16LE", description = "Battery voltage in mV" },
    { id = "alarm_active", alias = "Alarm Active", name = "alarm_active", field_type = "Bool", description = "Alarm active flag" },
    { id = "label", alias = "Device Label", name = "label", field_type = "Utf8String", description = "Device label, max 8 bytes" },
    { id = "raw_payload", alias = "Raw Payload", name = "raw_payload", field_type = "ByteArray", extra = 6, description = "Reserved payload bytes" },
  }
end

-- parse() parses raw bytes into field values
-- @data: table of byte values (e.g., {0x01, 0x02, 0x03, ...})
-- @len: number of valid bytes in data
-- Returns: table of { id, value } objects
function parse(data, len)
  local fields = {}

  -- Packet type (offset 0, 1 byte)
  fields[#fields + 1] = { id = "packet_type", value = read_u8(data, 0) }

  -- Device status (offset 1, 1 byte)
  fields[#fields + 1] = { id = "device_status", value = read_u8(data, 1) }

  -- Temperature (offset 2, 4 bytes, float32 little-endian)
  if len >= 6 then
    fields[#fields + 1] = { id = "temperature", value = read_float_le(data, 2) }
  end

  -- Humidity (offset 6, 4 bytes)
  if len >= 10 then
    fields[#fields + 1] = { id = "humidity", value = read_float_le(data, 6) }
  end

  -- Pressure (offset 10, 4 bytes, uint32)
  if len >= 14 then
    fields[#fields + 1] = { id = "pressure", value = read_u32_le(data, 10) }
  end

  -- Battery voltage (offset 14, 2 bytes)
  if len >= 16 then
    fields[#fields + 1] = { id = "battery_mv", value = read_u16_le(data, 14) }
  end

  -- Alarm active (offset 16, 1 byte)
  if len >= 17 then
    local alarm_byte = read_u8(data, 16)
    fields[#fields + 1] = { id = "alarm_active", value = (alarm_byte ~= 0) }
  end

  -- Device label (offset 17, 8 bytes)
  if len >= 25 then
    fields[#fields + 1] = { id = "label", value = read_string(data, 17, 8) }
  end

  -- Raw payload (offset 25, 6 bytes)
  if len >= 31 then
    local payload = {}
    for i = 0, 5 do
      payload[#payload + 1] = data[25 + i]
    end
    fields[#fields + 1] = { id = "raw_payload", value = bytes_to_hex(payload) }
  end

  return fields
end
