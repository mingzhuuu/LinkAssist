-- linkassist:type = canvas-lifecycle

return {
  version = 1,
  name = "Canvas Init / End",

  defaults = {
    stopOnFailure = true,
    timeoutMs = 2000,
    dataFormat = "hex",
  },

  onActivate = {
    {
      id = "send-init",
      action = "send",
      channel = "canvas",
      data = {
        format = "hex",
        value = "01 03 00 00",
      },
    },
  },

  onDeactivate = {
    {
      id = "send-end",
      action = "send",
      channel = "canvas",
      data = {
        format = "hex",
        value = "01 03 FF FF",
      },
    },
  },
}
