-- linkassist:type = script

-- Generic interactive pytest dashboard for a Script canvas. The selected
-- project's test_case package owns collection, markers, inputs and semantics;
-- LinkAssist only loads the catalog, starts the fixed bridge and renders logs.
return {
  version = 1,
  name = "Project pytest dashboard",
  defaults = {
    stopOnFailure = true,
    logLimit = 2000,
  },
  variables = {
    form = {
      projectRoot = "",
      profile = "ble-information",
      nodeIds = {},
      inputs = {},
    },
    catalog = nil,
    lastRun = nil,
  },
  ui = {
    schemaVersion = 1,
    stateVersion = "pytest-dashboard-product-profiles-v1",
    restore = {
      action = "loadCatalog",
      whenBind = "form.projectRoot",
    },
    toolbar = {
      {
        id = "load",
        type = "button",
        label = "Load",
        loadedLabel = "Reload",
        loadedSource = "catalog",
        action = "loadCatalog",
        reloadDocument = true,
        bind = "form.projectRoot",
        persist = true,
        directoryPicker = true,
      },
      {
        id = "run",
        type = "button",
        label = "Run",
        action = "runTests",
        variant = "primary",
        runningHandler = "runTests",
        runningLabel = "Stop",
        runningAction = "$stop",
      },
    },
    layout = {
      preset = "left-right",
      regions = { "selection", "results" },
      primarySize = 43,
      minPrimaryPx = 300,
      minSecondaryPx = 360,
      resizable = true,
    },
    regions = {
      selection = {
        controls = {
          {
            id = "profile",
            type = "select",
            label = "Profile",
            bind = "form.profile",
            persist = true,
            inlineLabel = true,
            options = { source = "catalog.profiles", valuePath = "id", labelPath = "title" },
          },
          {
            id = "cases",
            type = "testCases",
            label = "Test cases",
            bind = "form.nodeIds",
            persist = true,
            catalogSource = "catalog",
            profileBind = "form.profile",
          },
          {
            id = "inputs",
            type = "testInputs",
            bind = "form.inputs",
            persist = true,
            catalogSource = "catalog",
            profileBind = "form.profile",
            nodeIdsBind = "form.nodeIds",
          },
        },
      },
      results = {
        controls = {
          { id = "progress", type = "runSummary", source = "lastRun" },
          { id = "logs", type = "logViewer", grow = true },
        },
      },
    },
  },
  handlers = {
    loadCatalog = {
      {
        id = "load-catalog",
        action = "testCatalog",
        projectRoot = "${form.projectRoot}",
        saveAs = "catalog",
      },
    },
    runTests = {
      {
        id = "pytest-run",
        action = "testRun",
        projectRoot = "${form.projectRoot}",
        profile = "${form.profile}",
        nodeIds = { ["$ref"] = "form.nodeIds" },
        inputs = { ["$ref"] = "form.inputs" },
        selectionMode = "exact-or-profile",
        catalogSource = "catalog",
        catalogRevision = { ["$ref"] = "catalog.catalogRevision" },
        saveAs = "lastRun",
      },
    },
  },
}
