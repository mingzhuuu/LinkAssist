-- linkassist:type = canvas-lifecycle

return {
  version = 1,
  name = "Form Motor Init / Stop",
  description = "Initialize the TECO motor when a form canvas activates, then stop and disable it when the canvas deactivates.",

  defaults = {
    stopOnFailure = true,
    timeoutMs = 2000,
    dataFormat = "text",
    logLimit = 200,
  },

  onActivate = {
    { id = "form-motor-init-log", action = "log", message = "Initializing motor for form canvas" },
    { id = "motor-init-w60a", action = "send", channel = "canvas", data = { format = "text", value = "W60A0001BF," } },
    { id = "motor-init-w60b", action = "send", channel = "canvas", data = { format = "text", value = "W60B0000BF," } },
    { id = "motor-init-speed-zero", action = "send", channel = "canvas", data = { format = "text", value = "W5360000B5," } },
    { id = "motor-init-w63e", action = "send", channel = "canvas", data = { format = "text", value = "W63E0001C6," } },
    { id = "motor-init-w619", action = "send", channel = "canvas", data = { format = "text", value = "W6190001B8," } },
    { id = "motor-init-settle", action = "delay", durationMs = 100 },
  },

  onDeactivate = {
    { id = "form-motor-stop-log", action = "log", message = "Stopping motor for form canvas" },
    { id = "motor-stop-speed-zero-first", action = "send", channel = "canvas", data = { format = "text", value = "W5360000B5," } },
    { id = "motor-stop-w619", action = "send", channel = "canvas", data = { format = "text", value = "W6190000B7," } },
    { id = "motor-stop-w63e", action = "send", channel = "canvas", data = { format = "text", value = "W63E0000C5," } },
    { id = "motor-stop-speed-zero-second", action = "send", channel = "canvas", data = { format = "text", value = "W5360000B5," } },
    { id = "motor-stop-w60a", action = "send", channel = "canvas", data = { format = "text", value = "W60A0000BE," } },
  },
}
