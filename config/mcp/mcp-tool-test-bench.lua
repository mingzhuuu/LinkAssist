-- linkassist:type = mcp

local DEFAULT_MOTOR_PORT = "COM4"
local DEFAULT_SENSOR_PORT = "COM3"

local DEFAULT_MOTOR_CONFIG = {
  path = DEFAULT_MOTOR_PORT,
  baudRate = 9600,
  dataBits = 8,
  stopBits = 1,
  parity = "none",
  flowControl = "none",
  receiveTimeoutMs = 50,
}

local DEFAULT_SENSOR_CONFIG = {
  path = DEFAULT_SENSOR_PORT,
  baudRate = 9600,
  dataBits = 8,
  stopBits = 1,
  parity = "none",
  flowControl = "none",
  receiveTimeoutMs = 80,
}

local MOTOR_INIT_COMMANDS = {
  "W60A0001BF,",
  "W60B0000BF,",
  "W5360000B5,",
  "W63E0001C6,",
  "W6190001B8,",
}

local MOTOR_STOP_COMMANDS = {
  "W5360000B5,",
  "W6190000B7,",
  "W63E0000C5,",
  "W5360000B5,",
  "W60A0000BE,",
}

local DEFAULT_ZERO_SETTLE_S = 1
local DEFAULT_POWER_DURATION_MS = 5000
local DEFAULT_TORQUE_RANGE_NM = 100
local DEFAULT_TORQUE_SPAN_HZ = 5000
local DEFAULT_SPEED_PULSES_PER_REV = 1024
local DEFAULT_SENSOR_REQUEST_HEX = "01 32 81 F5"
local DEFAULT_SENSOR_ADDRESS = nil
local DEFAULT_SENSOR_RESPONSE_WAIT_S = 0.12
local DEFAULT_SENSOR_READ_ATTEMPTS = 4
local DEFAULT_SENSOR_RETRY_GAP_S = 0.04
local DEFAULT_SENSOR_RECEIVE_POLLS = 6
local DEFAULT_SENSOR_RECEIVE_POLL_GAP_S = 0.015
local MOTOR_RAMP_STEP_RPM = 200
local MOTOR_RAMP_INTERVAL_MS = 200

local function clone_table(source)
  local copy = {}
  for key, value in pairs(source) do
    copy[key] = value
  end
  return copy
end

local function number_or(value, fallback)
  if type(value) == "number" then
    return value
  end
  if type(value) == "string" and value ~= "" then
    local parsed = tonumber(value)
    if parsed ~= nil then
      return parsed
    end
  end
  return fallback
end

local function bool_or(value, fallback)
  if type(value) == "boolean" then
    return value
  end
  return fallback
end

local function string_or(value, fallback)
  if type(value) == "string" and value ~= "" then
    return value
  end
  return fallback
end

local function seconds_value(seconds_value, milliseconds_value, fallback_seconds)
  local seconds = number_or(seconds_value, nil)
  if seconds ~= nil then
    return seconds
  end

  local milliseconds = number_or(milliseconds_value, nil)
  if milliseconds ~= nil then
    return milliseconds / 1000
  end

  return fallback_seconds
end

local function seconds_from_args(args, seconds_key, milliseconds_key, fallback_seconds)
  if type(args) ~= "table" then
    return fallback_seconds
  end
  return seconds_value(args[seconds_key], args[milliseconds_key], fallback_seconds)
end

local function seconds_to_milliseconds(seconds)
  return math.max(1, math.floor(math.max(0, number_or(seconds, 0)) * 1000 + 0.5))
end

local function sleep_seconds(seconds)
  local delay_seconds = math.max(0, number_or(seconds, 0))
  if delay_seconds <= 0 then
    return
  end
  sleep_ms(seconds_to_milliseconds(delay_seconds))
end

local function current_time_seconds()
  if type(now_s) == "function" then
    return number_or(now_s(), nil)
  end

  if type(now_ms) == "function" then
    local milliseconds = number_or(now_ms(), nil)
    if milliseconds ~= nil then
      return milliseconds / 1000
    end
  end

  return nil
end

local function session_or_nil()
  return get_session_state()
end

local function require_session()
  local session = session_or_nil()
  if session == nil then
    error("bench_init must be called first")
  end
  return session
end

local function persist_session(session)
  set_session_state(session)
  return session
end

local function append_bytes(target, source)
  for index = 1, #source do
    target[#target + 1] = source[index]
  end
end

local function slice_bytes(bytes, start_index, end_index)
  local sliced = {}
  for index = start_index, end_index do
    sliced[#sliced + 1] = bytes[index]
  end
  return sliced
end

local function ascii_to_bytes(text)
  local bytes = {}
  for index = 1, #text do
    bytes[#bytes + 1] = string.byte(text, index)
  end
  return bytes
end

local function build_channel_id(prefix, path)
  return prefix .. "-" .. string.gsub(path, "[^%w%-_.]", "_")
end

local function open_serial_connection(config, channel_id)
  local result = invoke_tool("serial_open_port", {
    channelId = channel_id,
    config = config,
  })
  return result.connectionId
end

local function close_serial_connection(connection_id)
  if type(connection_id) ~= "string" or connection_id == "" then
    return
  end
  pcall(function()
    invoke_tool("serial_close_port", { connectionId = connection_id })
  end)
end

local function send_serial_bytes(connection_id, bytes)
  return invoke_tool("serial_send_data", {
    connectionId = connection_id,
    data = bytes,
  })
end

local function receive_serial_bytes(connection_id)
  local result = invoke_tool("serial_receive_data", {
    connectionId = connection_id,
  })
  return result.data or {}
end

local function drain_serial(connection_id, max_reads, wait_ms)
  local drained = {}
  local reads = math.max(1, math.floor(number_or(max_reads, 2)))
  for _ = 1, reads do
    local chunk = receive_serial_bytes(connection_id)
    if #chunk == 0 then
      break
    end
    append_bytes(drained, chunk)
    if number_or(wait_ms, 0) > 0 then
      sleep_ms(number_or(wait_ms, 0))
    end
  end
  return drained
end

local function crc16_modbus(bytes, start_index, end_index)
  local crc = 0xFFFF
  local first = start_index or 1
  local last = end_index or #bytes
  for index = first, last do
    crc = crc ~ bytes[index]
    for _ = 1, 8 do
      local lsb = crc & 0x0001
      crc = crc >> 1
      if lsb ~= 0 then
        crc = crc ~ 0xA001
      end
    end
  end
  return crc & 0xFFFF
end

local function find_sensor_frame(bytes, sensor_address)
  if #bytes < 13 then
    return nil
  end

  for start_index = 1, #bytes - 12 do
    local end_index = start_index + 12
    if bytes[start_index] == sensor_address and bytes[start_index + 1] == 0x32 and bytes[start_index + 2] == 0x08 then
      local crc = crc16_modbus(bytes, start_index, end_index - 2)
      local crc_low = crc & 0xFF
      local crc_high = (crc >> 8) & 0xFF
      local response_crc_lo_hi = bytes[end_index - 1] == crc_low and bytes[end_index] == crc_high
      local response_crc_hi_lo = bytes[end_index - 1] == crc_high and bytes[end_index] == crc_low
      if response_crc_lo_hi or response_crc_hi_lo then
        return slice_bytes(bytes, start_index, end_index)
      end
    end
  end

  return nil
end

local function decode_float32_le(bytes, start_index)
  return string.unpack("<f", string.char(table.unpack(bytes, start_index, start_index + 3)))
end

local function decode_sensor_frame(frame)
  if #frame < 13 then
    error("Invalid torque sensor frame length: " .. tostring(#frame))
  end

  return {
    frame = frame,
    torqueHz = decode_float32_le(frame, 4),
    speedHz = decode_float32_le(frame, 8),
  }
end

local function compute_torque_nm(torque_hz, zero_torque_hz, torque_range_nm, torque_span_hz)
  local span_hz = number_or(torque_span_hz, 5000)
  if span_hz == 0 then
    error("torqueSpanHz must not be 0")
  end
  return number_or(torque_range_nm, 100) * ((torque_hz - zero_torque_hz) / span_hz)
end

local function compute_rpm(speed_hz, speed_pulses_per_rev)
  local pulses_per_rev = number_or(speed_pulses_per_rev, 1024)
  if pulses_per_rev == 0 then
    error("speedPulsesPerRev must not be 0")
  end
  return speed_hz * 60 / pulses_per_rev
end

local function compute_power(torque_nm, rpm)
  return torque_nm * rpm * 2 * 3.14 / 60
end

local function to_int16(value)
  local uint16 = value & 0xFFFF
  if uint16 >= 0x8000 then
    return uint16 - 0x10000
  end
  return uint16
end

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

local function build_teco_speed_command(target_rpm, direction)
  local rpm = number_or(target_rpm, 0)
  if number_or(direction, 0) == 1 then
    rpm = -rpm
  end
  local encoded_rpm = to_int16(-math.floor(rpm * 8.192 + 0.5))
  return encode_teco_ascii_command("W536" .. to_hex16(encoded_rpm))
end

local function send_ascii_command(connection_id, command)
  send_serial_bytes(connection_id, ascii_to_bytes(command))
  return command
end

local function signed_rpm(target_rpm, direction)
  local rpm = math.max(0, number_or(target_rpm, 0))
  if number_or(direction, 0) == 1 then
    return -rpm
  end
  return rpm
end

local function split_signed_rpm(value, fallback_direction)
  local rpm = math.abs(value)
  if value < 0 then
    return rpm, 1
  end
  if value > 0 then
    return rpm, 0
  end
  return 0, number_or(fallback_direction, 1)
end

local function init_motor(connection_id)
  local sent_commands = {}
  for index = 1, #MOTOR_INIT_COMMANDS do
    sent_commands[#sent_commands + 1] = send_ascii_command(connection_id, MOTOR_INIT_COMMANDS[index])
  end
  sleep_seconds(0.1)
  return sent_commands
end

local function stop_motor(connection_id)
  local sent_commands = {}
  for index = 1, #MOTOR_STOP_COMMANDS do
    sent_commands[#sent_commands + 1] = send_ascii_command(connection_id, MOTOR_STOP_COMMANDS[index])
  end
  return sent_commands
end

local function set_motor_zero(connection_id)
  return send_ascii_command(connection_id, "W5360000B5,")
end

local function set_motor_rpm(connection_id, target_rpm, direction)
  local command = build_teco_speed_command(target_rpm, direction)
  send_ascii_command(connection_id, command)
  return command
end

local function ramp_motor_rpm(connection_id, current_target_rpm, current_direction, target_rpm, target_direction)
  local current_signed_rpm = signed_rpm(current_target_rpm, current_direction)
  local target_signed_rpm = signed_rpm(target_rpm, target_direction)

  while current_signed_rpm ~= target_signed_rpm do
    local remaining = target_signed_rpm - current_signed_rpm
    local step = math.min(MOTOR_RAMP_STEP_RPM, math.abs(remaining))
    if remaining < 0 then
      step = -step
    end

    current_signed_rpm = current_signed_rpm + step
    local step_target_rpm, step_direction = split_signed_rpm(current_signed_rpm, target_direction)
    set_motor_rpm(connection_id, step_target_rpm, step_direction)

    if current_signed_rpm ~= target_signed_rpm then
      sleep_ms(MOTOR_RAMP_INTERVAL_MS)
    end
  end
end

local function shutdown_session(session)
  local result = {
    motorStopped = false,
    sensorClosed = false,
    motorClosed = false,
  }

  if session ~= nil and type(session.motorConnectionId) == "string" and session.motorConnectionId ~= "" then
    result.motorStopped = pcall(function()
      stop_motor(session.motorConnectionId)
    end)
  end

  if session ~= nil and type(session.sensorConnectionId) == "string" and session.sensorConnectionId ~= "" then
    result.sensorClosed = pcall(function()
      close_serial_connection(session.sensorConnectionId)
    end)
  end

  if session ~= nil and type(session.motorConnectionId) == "string" and session.motorConnectionId ~= "" then
    result.motorClosed = pcall(function()
      close_serial_connection(session.motorConnectionId)
    end)
  end

  return result
end

local function read_raw_sensor_sample(connection_id, args)
  local sensor_request = hex_to_bytes(string_or(args.sensorRequestHex, DEFAULT_SENSOR_REQUEST_HEX))
  local sensor_address = math.floor(number_or(args.sensorAddress, sensor_request[1] or 1))
  local response_wait_s = math.max(0.001, seconds_from_args(args, "sensorResponseWaitS", "sensorResponseWaitMs", DEFAULT_SENSOR_RESPONSE_WAIT_S))
  local read_attempts = math.max(1, math.floor(number_or(args.sensorReadAttempts, DEFAULT_SENSOR_READ_ATTEMPTS)))
  local retry_gap_s = math.max(0, seconds_from_args(args, "sensorRetryGapS", "sensorRetryGapMs", DEFAULT_SENSOR_RETRY_GAP_S))
  local receive_polls = math.max(1, math.floor(number_or(args.sensorReceivePolls, DEFAULT_SENSOR_RECEIVE_POLLS)))
  local receive_poll_gap_s = math.max(0, seconds_from_args(args, "sensorReceivePollGapS", "sensorReceivePollGapMs", DEFAULT_SENSOR_RECEIVE_POLL_GAP_S))

  drain_serial(connection_id, 2, 10)
  local collected = {}
  for attempt = 1, read_attempts do
    send_serial_bytes(connection_id, sensor_request)
    sleep_seconds(response_wait_s)

    for poll = 1, receive_polls do
      local chunk = receive_serial_bytes(connection_id)
      if #chunk > 0 then
        append_bytes(collected, chunk)
      end

      local frame = find_sensor_frame(collected, sensor_address)
      if frame ~= nil then
        local decoded = decode_sensor_frame(frame)
        decoded.rawResponseHex = bytes_to_hex(collected)
        decoded.attempt = attempt
        decoded.poll = poll
        return decoded
      end

      if poll < receive_polls and receive_poll_gap_s > 0 then
        sleep_seconds(receive_poll_gap_s)
      end
    end

    if attempt < read_attempts and retry_gap_s > 0 then
      sleep_seconds(retry_gap_s)
    end
  end

  error(
    "Failed to read a valid 32H torque sensor frame; raw="
      .. bytes_to_hex(collected)
      .. "; attempts=" .. tostring(read_attempts)
      .. "; pollsPerAttempt=" .. tostring(receive_polls)
  )
end

local function build_measurement(decoded_sample, args, zero_torque_hz)
  local torque_nm = compute_torque_nm(
    decoded_sample.torqueHz,
    zero_torque_hz,
    number_or(args.torqueRangeNm, 100),
    number_or(args.torqueSpanHz, 5000)
  )
  local rpm = compute_rpm(decoded_sample.speedHz, number_or(args.speedPulsesPerRev, 1024))
  local power = compute_power(torque_nm, rpm)

  return {
    torqueHz = decoded_sample.torqueHz,
    speedHz = decoded_sample.speedHz,
    torqueNm = torque_nm,
    rpm = rpm,
    power = power,
    rawFrameHex = bytes_to_hex(decoded_sample.frame),
    rawResponseHex = decoded_sample.rawResponseHex,
  }
end

local function summarize_calibration(calibration)
  return {
    zeroTorqueHz = calibration.zeroTorqueHz,
    zeroSpeedHz = calibration.zeroSpeedHz,
    zeroRpm = calibration.zeroRpm,
  }
end

local function update_session_calibration(session, calibration_args, calibration)
  session.calibration = calibration
  session.sensorRequestHex = calibration_args.sensorRequestHex
  session.sensorAddress = calibration_args.sensorAddress
  session.sensorResponseWaitS = calibration_args.sensorResponseWaitS
  session.sensorReadAttempts = calibration_args.sensorReadAttempts
  session.sensorRetryGapS = calibration_args.sensorRetryGapS
  session.sensorReceivePolls = calibration_args.sensorReceivePolls
  session.sensorReceivePollGapS = calibration_args.sensorReceivePollGapS
  session.direction = 1
  session.lastTargetRpm = 0
  persist_session(session)
  return session
end

local function measure_power(connection_id, args, zero_torque_hz)
  local duration_ms = math.max(0, math.floor(number_or(args.durationMs, 0)))
  local sample_interval_ms = math.max(1, math.floor(number_or(args.sampleIntervalMs, 200)))
  local duration_s = duration_ms / 1000
  local sample_interval_s = sample_interval_ms / 1000
  local samples = {}
  local total_power = 0
  local total_torque = 0
  local total_rpm = 0

  local started_s = current_time_seconds()
  if started_s == nil then
    if duration_s > 0 then
      error("bench_read_power requires Lua MCP runtime helper now_s or now_ms; restart LinkAssist/MCP core with the updated backend")
    end
    started_s = 0
  end

  local deadline_s = started_s + duration_s
  local next_sample_due_s = started_s
  local sample_count = 0

  while true do
    if duration_s > 0 then
      local now_before_sleep_s = current_time_seconds()
      if now_before_sleep_s == nil then
        error("Lua MCP runtime helper now_s/now_ms became unavailable during bench_read_power")
      end

      if sample_count > 0 and now_before_sleep_s >= deadline_s then
        break
      end

      if now_before_sleep_s < next_sample_due_s then
        sleep_seconds(next_sample_due_s - now_before_sleep_s)
      end
    end

    local sample_start_s = current_time_seconds()
    if duration_s > 0 and sample_count > 0 and sample_start_s ~= nil and sample_start_s >= deadline_s then
      break
    end

    local index = sample_count + 1
    local sample = build_measurement(read_raw_sensor_sample(connection_id, args), args, zero_torque_hz)
    sample.index = index
    sample.sampleStartedMs = sample_start_s ~= nil and math.max(0, math.floor(sample_start_s * 1000 + 0.5)) or nil
    samples[#samples + 1] = sample
    total_power = total_power + sample.power
    total_torque = total_torque + sample.torqueNm
    total_rpm = total_rpm + sample.rpm

    sample_count = index
    if duration_s == 0 then
      break
    end

    next_sample_due_s = next_sample_due_s + sample_interval_s
  end

  local average_power = total_power / sample_count
  local finished_s = current_time_seconds() or started_s
  local summary = {
    mode = duration_s == 0 and "instant" or "average",
    power = duration_s == 0 and samples[1].power or average_power,
    requestedDurationMs = duration_ms,
    elapsedMs = math.max(0, math.floor((finished_s - started_s) * 1000 + 0.5)),
    zeroTorqueHz = zero_torque_hz,
    durationMs = duration_ms,
    sampleIntervalMs = sample_interval_ms,
    sampleCount = sample_count,
    averagePower = average_power,
    averageTorqueNm = total_torque / sample_count,
    averageRpm = total_rpm / sample_count,
  }

  if bool_or(args.includeSamples, false) then
    summary.samples = samples
  end

  return summary
end

local function calibration_options()
  return {
    zeroSettleS = DEFAULT_ZERO_SETTLE_S,
    torqueRangeNm = DEFAULT_TORQUE_RANGE_NM,
    torqueSpanHz = DEFAULT_TORQUE_SPAN_HZ,
    speedPulsesPerRev = DEFAULT_SPEED_PULSES_PER_REV,
    sensorRequestHex = DEFAULT_SENSOR_REQUEST_HEX,
    sensorAddress = DEFAULT_SENSOR_ADDRESS,
    sensorResponseWaitS = DEFAULT_SENSOR_RESPONSE_WAIT_S,
    sensorReadAttempts = DEFAULT_SENSOR_READ_ATTEMPTS,
    sensorRetryGapS = DEFAULT_SENSOR_RETRY_GAP_S,
    sensorReceivePolls = DEFAULT_SENSOR_RECEIVE_POLLS,
    sensorReceivePollGapS = DEFAULT_SENSOR_RECEIVE_POLL_GAP_S,
  }
end

local function calibrate_zero(motor_connection_id, sensor_connection_id, args)
  set_motor_zero(motor_connection_id)
  sleep_seconds(math.max(0.001, seconds_from_args(args, "zeroSettleS", "zeroSettleMs", DEFAULT_ZERO_SETTLE_S)))
  local decoded = read_raw_sensor_sample(sensor_connection_id, args)

  return {
    zeroTorqueHz = decoded.torqueHz,
    zeroSpeedHz = decoded.speedHz,
    zeroRpm = compute_rpm(decoded.speedHz, number_or(args.speedPulsesPerRev, 1024)),
    torqueRangeNm = number_or(args.torqueRangeNm, 100),
    torqueSpanHz = number_or(args.torqueSpanHz, 5000),
    speedPulsesPerRev = number_or(args.speedPulsesPerRev, 1024),
  }
end

local function bench_init(args)
  args = args or {}
  local previous_session = session_or_nil()
  local calibration_args = calibration_options()

  if previous_session ~= nil then
    local calibration = calibrate_zero(previous_session.motorConnectionId, previous_session.sensorConnectionId, calibration_args)
    update_session_calibration(previous_session, calibration_args, calibration)

    return {
      ok = true,
      reusedSession = true,
      motorPort = string_or(previous_session.motorConfig and previous_session.motorConfig.path, DEFAULT_MOTOR_PORT),
      sensorPort = string_or(previous_session.sensorConfig and previous_session.sensorConfig.path, DEFAULT_SENSOR_PORT),
      calibration = summarize_calibration(calibration),
    }
  end

  local motor_config = clone_table(DEFAULT_MOTOR_CONFIG)
  local sensor_config = clone_table(DEFAULT_SENSOR_CONFIG)
  motor_config.path = string_or(args.motorPort, motor_config.path)
  sensor_config.path = string_or(args.sensorPort, sensor_config.path)
  local motor_connection_id = nil
  local sensor_connection_id = nil

  local ok, result = pcall(function()
    motor_connection_id = open_serial_connection(motor_config, build_channel_id("mcp-bench-motor", motor_config.path))
    sensor_connection_id = open_serial_connection(sensor_config, build_channel_id("mcp-bench-sensor", sensor_config.path))

    init_motor(motor_connection_id)
    local calibration = calibrate_zero(motor_connection_id, sensor_connection_id, calibration_args)
    local session = {
      motorConfig = motor_config,
      sensorConfig = sensor_config,
      motorConnectionId = motor_connection_id,
      sensorConnectionId = sensor_connection_id,
      direction = 1,
      lastTargetRpm = 0,
    }
    update_session_calibration(session, calibration_args, calibration)

    return {
      ok = true,
      reusedSession = false,
      motorPort = motor_config.path,
      sensorPort = sensor_config.path,
      calibration = summarize_calibration(calibration),
    }
  end)

  if not ok then
    if sensor_connection_id ~= nil then
      close_serial_connection(sensor_connection_id)
    end
    if motor_connection_id ~= nil then
      close_serial_connection(motor_connection_id)
    end
    clear_session_state()
    error(result)
  end

  return result
end

local function bench_set_motor_rpm(args)
  args = args or {}
  local session = session_or_nil()
  local auto_initialized = false
  if session == nil then
    bench_init({})
    session = require_session()
    auto_initialized = true
  end

  local target_rpm = number_or(args.targetRpm, nil)
  if target_rpm == nil then
    error("targetRpm is required")
  end

  local direction = number_or(args.direction, 1)
  local current_target_rpm = number_or(session.lastTargetRpm, 0)
  local current_direction = number_or(session.direction, 1)
  if math.abs(signed_rpm(target_rpm, direction) - signed_rpm(current_target_rpm, current_direction)) > MOTOR_RAMP_STEP_RPM then
    ramp_motor_rpm(session.motorConnectionId, current_target_rpm, current_direction, target_rpm, direction)
  else
    set_motor_rpm(session.motorConnectionId, target_rpm, direction)
  end

  session.direction = direction
  session.lastTargetRpm = target_rpm
  persist_session(session)

  return {
    ok = true,
    autoInitialized = auto_initialized,
    targetRpm = target_rpm,
    direction = direction,
  }
end

local function bench_read_power(args)
  args = args or {}
  local session = require_session()
  local read_args = {
    durationMs = math.max(0, math.floor(number_or(args.durationMs, DEFAULT_POWER_DURATION_MS))),
    sampleIntervalMs = math.max(1, math.floor(number_or(args.sampleIntervalMs, 200))),
    includeSamples = bool_or(args.includeSamples, false),
    sensorRequestHex = session.sensorRequestHex or DEFAULT_SENSOR_REQUEST_HEX,
    sensorAddress = session.sensorAddress,
    sensorResponseWaitS = seconds_value(session.sensorResponseWaitS, session.sensorResponseWaitMs, DEFAULT_SENSOR_RESPONSE_WAIT_S),
    sensorReadAttempts = session.sensorReadAttempts,
    sensorRetryGapS = seconds_value(session.sensorRetryGapS, session.sensorRetryGapMs, DEFAULT_SENSOR_RETRY_GAP_S),
    sensorReceivePolls = session.sensorReceivePolls,
    sensorReceivePollGapS = seconds_value(session.sensorReceivePollGapS, session.sensorReceivePollGapMs, DEFAULT_SENSOR_RECEIVE_POLL_GAP_S),
    torqueRangeNm = session.calibration.torqueRangeNm,
    torqueSpanHz = session.calibration.torqueSpanHz,
    speedPulsesPerRev = session.calibration.speedPulsesPerRev,
  }

  return {
    ok = true,
    power = measure_power(session.sensorConnectionId, read_args, session.calibration.zeroTorqueHz),
  }
end

local function bench_deinit(args)
  local session = session_or_nil()
  if session == nil then
    return {
      ok = true,
      alreadyDeinitialized = true,
    }
  end

  local shutdown = shutdown_session(session)
  clear_session_state()

  return {
    ok = true,
    shutdown = shutdown,
  }
end

function on_shutdown(context)
  return bench_deinit({})
end

function mcp_tools()
  return {
    {
      name = "bench_init",
      description = "Open motor and torque-sensor serial ports on first use, or reuse the active session to rerun zero calibration without reopening ports.",
      input_schema = {
        type = "object",
        properties = {
          motorPort = { type = "string" },
          sensorPort = { type = "string" },
        },
        additionalProperties = false,
      },
    },
    {
      name = "bench_set_motor_rpm",
      description = "Set motor RPM using the active session; if the target differs by more than 200rpm, the script ramps in 200rpm steps every 200ms. If no session exists yet, bench_init runs first.",
      input_schema = {
        type = "object",
        properties = {
          targetRpm = { type = "number" },
          direction = { type = "integer" },
        },
        required = { "targetRpm" },
        additionalProperties = false,
      },
    },
    {
      name = "bench_read_power",
      description = "Use the active bench_init session and calibration to read power over a duration in milliseconds; if durationMs is omitted, the default window is 5000ms.",
      input_schema = {
        type = "object",
        properties = {
          durationMs = { type = "integer" },
          sampleIntervalMs = { type = "integer" },
          includeSamples = { type = "boolean" },
        },
        additionalProperties = false,
      },
    },
    {
      name = "bench_deinit",
      description = "Use the active bench_init session to set motor speed to zero, close both serial ports, and clear the persisted session.",
      input_schema = {
        type = "object",
        properties = {},
        additionalProperties = false,
      },
    },
  }
end

function call(tool_name, args)
  if tool_name == "bench_init" then
    return bench_init(args or {})
  end

  if tool_name == "bench_set_motor_rpm" then
    return bench_set_motor_rpm(args or {})
  end

  if tool_name == "bench_read_power" then
    return bench_read_power(args or {})
  end

  if tool_name == "bench_deinit" then
    return bench_deinit(args or {})
  end

  error("Unknown MCP tool: " .. tostring(tool_name))
end