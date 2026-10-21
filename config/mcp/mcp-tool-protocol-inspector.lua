-- linkassist:type = mcp

--[[
  LinkAssist Lua MCP Multi-Tool Example
  -------------------------------------
  This example shows how one Lua MCP tool script can expose multiple tools with:
  - mcp_tools()
  - call(tool_name, args)
  - current protocol parsing
  - configured protocol-file parsing
]]

function mcp_tools()
  return {
    {
      name = "protocol_inspect_packet",
      description = "Inspect raw bytes, decode them with LinkAssist protocol helpers, and return both raw and parsed views.",
      input_schema = {
        type = "object",
        properties = {
          data = {
            type = "array",
            items = {
              type = "integer",
              minimum = 0,
              maximum = 255,
            },
          },
          parser = {
            type = "string",
            enum = { "current", "configured" },
          },
        },
        required = { "data" },
        additionalProperties = false,
      },
      protocol_file = "config/protocol/protocol-example.lua",
    },
    {
      name = "protocol_inspect_hex",
      description = "Convert hex input to bytes, decode it, and return both hex and parsed output.",
      input_schema = {
        type = "object",
        properties = {
          hex = {
            type = "string",
          },
          parser = {
            type = "string",
            enum = { "current", "configured" },
          },
        },
        required = { "hex" },
        additionalProperties = false,
      },
      protocol_file = "config/protocol/protocol-example.lua",
    },
  }
end

local function normalize_data(args)
  if args == nil or args.data == nil then
    return {}
  end
  return args.data
end

local function inspect_bytes(args)
  local data = normalize_data(args)
  local parser = (args and args.parser) or "current"

  local parsed
  if parser == "configured" then
    parsed = parse_configured_protocol_file(data)
  else
    parsed = parse_current_protocol(data)
  end

  return {
    ok = true,
    parser = parser,
    current_channel = get_current_channel(),
    raw_hex = bytes_to_hex(data),
    parsed = parsed,
  }
end

local function inspect_hex(args)
  local parser = (args and args.parser) or "current"
  local hex = (args and args.hex) or ""
  local data = hex_to_bytes(hex)

  local parsed
  if parser == "configured" then
    parsed = parse_configured_protocol_file(data)
  else
    parsed = parse_current_protocol(data)
  end

  return {
    ok = true,
    parser = parser,
    current_channel = get_current_channel(),
    raw_hex = bytes_to_hex(data),
    parsed = parsed,
  }
end

function call(tool_name, args)
  if tool_name == "protocol_inspect_packet" then
    return inspect_bytes(args)
  end

  if tool_name == "protocol_inspect_hex" then
    return inspect_hex(args)
  end

  error("Unknown MCP tool: " .. tostring(tool_name))
end
