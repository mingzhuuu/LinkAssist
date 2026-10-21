-- linkassist:type = protocol

--[[
  TECO motor RPM command synthesizer.

  Input:
    - ASCII signed RPM text, for example "100", "-100", "0"
    - or a 2-byte little-endian Int16 RPM
    - or a 4-byte little-endian Int32 RPM

  Meaning:
    rpm > 0  => forward
    rpm < 0  => reverse
    rpm = 0  => stop speed command

  Output:
    A single field named "转速".
    Its value/display is the requested signed RPM.
    Its raw_bytes is the complete TECO ASCII command to send to the motor.
    Example:
      100  -> W5360333BE,
      -100 -> W536FCCD05,
      0    -> W5360000B5,
]]

local RPM_SCALE = 8.192

local function to_hex16(value)
  return string.format("%04X", value & 0xFFFF)
end

local function encode_teco_ascii_command(command)
  local upper = string.upper(command)
  local sum = 0
  for index = 1, #upper do
    sum = sum + string.byte(upper, index)
  end
  return string.format("%s%02X,", upper, sum & 0xFF)
end

local function build_teco_speed_command(signed_rpm)
  local rpm = -(signed_rpm or 0)
  local encoded_rpm = -math.floor(rpm * RPM_SCALE + 0.5)
  return encode_teco_ascii_command("W536" .. to_hex16(encoded_rpm))
end

local function bytes_to_ascii(data, len)
  local chars = {}
  for index = 1, len do
    local byte = data[index]
    if byte == nil or byte == 0 then
      break
    end
    chars[#chars + 1] = string.char(byte)
  end
  return table.concat(chars)
end

local function trim(value)
  return (value:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function parse_ascii_rpm(data, len)
  local text = trim(bytes_to_ascii(data, len))
  if text == "" then
    return nil, text
  end
  local rpm = tonumber(text)
  if rpm == nil then
    return nil, text
  end
  return rpm, text
end

local function parse_binary_rpm(data, len)
  if len == 2 then
    return read_i16_le(data, 0), "int16le"
  end
  if len == 4 then
    return read_i32_le(data, 0), "int32le"
  end
  return nil, "unknown"
end

local function ascii_to_bytes(value)
  local bytes = {}
  for index = 1, #value do
    bytes[#bytes + 1] = string.byte(value, index)
  end
  return bytes
end

function schema()
  return {
    { id = "speed", alias = "转速", name = "speed", field_type = "Int32", description = "Signed target speed. Positive is forward, negative is reverse. raw_bytes is the TECO command." },
  }
end

function parse(data, len)
  local rpm = parse_ascii_rpm(data, len)

  if rpm == nil then
    rpm = parse_binary_rpm(data, len)
  end

  if rpm == nil then
    return {
      {
        id = "speed",
        alias = "转速",
        name = "speed",
        value = 0,
        display = "invalid rpm",
        raw_bytes = {},
      },
    }
  end

  rpm = math.floor(rpm + (rpm >= 0 and 0.5 or -0.5))
  local command = build_teco_speed_command(rpm)
  local command_bytes = ascii_to_bytes(command)

  return {
    {
      id = "speed",
      alias = "转速",
      name = "speed",
      value = rpm,
      display = tostring(rpm),
      raw_bytes = command_bytes,
    },
  }
end
