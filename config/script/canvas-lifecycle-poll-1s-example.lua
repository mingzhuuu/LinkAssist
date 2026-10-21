-- linkassist:type = canvas-lifecycle

return {
  version = 1,
  name = "Canvas Poll Every 1s",

  defaults = {
    stopOnFailure = true,
    timeoutMs = 1000,
    dataFormat = "hex",
  },

  onActivate = {
    { id = "poll-start-log", action = "log", message = "Start 1s polling" },
  },

  whileActive = {
    intervalMs = 1000,
    steps = {
      {
        id = "poll-request",
        action = "send",
        channel = "canvas",
        data = {
          format = "hex",
          value = "01 03 00 00 00 02",
        },
      },
    },
  },

  onDeactivate = {
    { id = "poll-stop-log", action = "log", message = "Stop 1s polling" },
  },
}
