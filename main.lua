------------------------------------------------------------
-- Live Show Manager
-- main.lua
--
-- Application entry point and module loader.
------------------------------------------------------------

local ROOT =
    debug.getinfo(1, "S").source
        :match("@(.*/)")

local loadedModules = {}

App = {}

App.root = ROOT


local function modulePath(name)

    local path =
        name:gsub("%.", "/")

    return ROOT .. path .. ".lua"

end


function App.require(name)

    if loadedModules[name] then
        return loadedModules[name]
    end


    local filename =
        modulePath(name)


    local chunk, err =
        loadfile(filename)


    if not chunk then

        error(
            "Unable to load module:\n"
            .. name
            .. "\n\n"
            .. err
        )

    end


    local ok, module =
        pcall(chunk)


    if not ok then

        error(
            "Module crashed:\n"
            .. name
            .. "\n\n"
            .. module
        )

    end


    if module == nil then
        module = true
    end


    loadedModules[name] =
        module


    return module

end


local Util =
    App.require("backend.util")

local FS =
    App.require("backend.filesystem")

local JSON =
    App.require("backend.json")


local Song =
    App.require("models.song")

local Library =
    App.require("backend.library")


local AppGUI =
    App.require("gui.app")


Util.clearConsole()

Util.log("--------------------------------")
Util.log("Live Show Manager")
Util.log("--------------------------------")
Util.log("")
Util.log("Module loader initialized.")
Util.log("Root:")
Util.log(ROOT)
Util.log("")
Util.log("Launching GUI...")

AppGUI.run()
