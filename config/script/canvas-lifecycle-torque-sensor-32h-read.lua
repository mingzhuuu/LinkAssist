-- linkassist:type = canvas-lifecycle

return {
  version = 1,
  name = "Table Torque Sensor 32H Read",
  description = "Poll the torque sensor 32H raw torque/speed frame every 1 second through the table canvas selected channel.",

  defaults = {
    stopOnFailure = true,
    timeoutMs = 1000,
    dataFormat = "hex",
    logLimit = 500,
  },

  variables = {
    requestHex = "01 32 81 F5",
  },

  onActivate = {
    {
      id = "table-torque-32h-start-log",
      action = "log",
      message = "Start polling torque sensor 32H through the table selected channel",
    },
  },

  whileActive = {
    intervalMs = 1000,
    steps = {
      {
        id = "table-torque-32h-request",
        action = "send",
        display = "hidden",
        channel = "canvas",
        data = { format = "hex", value = "${requestHex}" },
      },
    },
  },

  onDeactivate = {
    {
      id = "table-torque-32h-stop-log",
      action = "log",
      message = "Stop polling torque sensor 32H",
    },
  },
}
