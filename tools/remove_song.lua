------------------------------------------------------------
-- Live Show Manager
-- tools/remove_song.lua
--
-- Standalone script: remove a song from the library.
-- Run as a REAPER action.
------------------------------------------------------------

local ROOT = debug.getinfo(1, "S").source:match("@(.*/)")

local loadedModules = {}

App = {}
App.root = ROOT

local function modulePath(name)
    return ROOT .. name:gsub("%.", "/") .. ".lua"
end

function App.require(name)
    if loadedModules[name] then return loadedModules[name] end
    local filename = modulePath(name)
    local chunk, err = loadfile(filename)
    if not chunk then error("Unable to load module:\n" .. name .. "\n\n" .. err) end
    local ok, module = pcall(chunk)
    if not ok then error("Module crashed:\n" .. name .. "\n\n" .. module) end
    loadedModules[name] = module or true
    return loadedModules[name]
end


local Util = App.require("backend.util")
local FS = App.require("backend.filesystem")
local SongManager = App.require("backend.song_manager")
local Library = App.require("backend.library")


reaper.ClearConsole()
Util.log("--- Remove Song ---")
Util.log("")

local songs = Library.scan()

if #songs == 0 then
    Util.log("No songs in library.")
    return
end


Util.log("Songs in library:")
Util.log("")

for i, song in ipairs(songs) do
    Util.log("  " .. i .. ". " .. song.title)
end

Util.log("")


local ret, input = reaper.GetUserInputs(
    "Remove Song",
    1,
    "Enter song number or name:,ext=64",
    ""
)

if not ret or not input or input == "" then
    Util.log("Cancelled.")
    return
end


local index = tonumber(input)
local song = nil

if index then
    if index >= 1 and index <= #songs then
        song = songs[index]
    end
else
    local query = Util.trim(string.lower(input))
    for _, s in ipairs(songs) do
        if string.lower(s.title or "") == query then
            song = s
            break
        end
    end
end


if not song then
    Util.log("Song not found.")
    return
end


local confirm = reaper.MB(
    "Remove \"" .. song.title .. "\"?\n\n"
    .. "This will permanently delete the folder:\n"
    .. song.path,
    "Confirm Removal",
    4
)

if confirm ~= 6 then
    Util.log("Cancelled.")
    return
end


local ok, err = SongManager.remove(song)

if ok then
    Util.log("")
    Util.log("✓ Removed: " .. song.title)
else
    Util.log("")
    Util.log("✗ Failed: " .. (err or "unknown error"))
end

Util.log("")
Util.log("Done.")
