------------------------------------------------------------
-- Live Show Manager
-- tools/add_song.lua
--
-- Standalone script: add a new song to the library.
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
Util.log("--- Add Song ---")
Util.log("")


local ret, title = reaper.GetUserInputs(
    "New Song",
    1,
    "Song title:,ext=64",
    ""
)

if not ret or not title or title == "" then
    Util.log("Cancelled.")
    return
end

title = Util.trim(title)


local songs = Library.scan()
local existing = SongManager.findExact(songs, title)

if existing then
    local msg = "Song \"" .. title .. "\" already exists!"
    reaper.MB(msg, "Duplicate", 0)
    Util.log(msg)
    return
end


local ret2, artist, bpmStr, key, notes = reaper.GetUserInputs(
    "Song Details",
    4,
    "Artist:,ext=64,BPM:,ext=10,Key:,ext=8,Notes:,ext=128",
    ",,,"
)

if not ret2 then
    Util.log("Cancelled.")
    return
end


local data = {
    title = title,
    artist = Util.trim(artist or ""),
    bpm = tonumber(bpmStr) or 0,
    key = Util.trim(key or ""),
    notes = Util.trim(notes or "")
}


local song, err = SongManager.add(data)

if song then

    local audioFile = SongManager.pickAudioFile()

    if audioFile then

        local AudioImport = App.require("backend.audio_import")
        local dest, impErr = AudioImport.import(audioFile, song.path)

        if dest then
            Util.log("Audio imported: " .. dest)
        else
            Util.log("Audio import skipped: " .. (impErr or "?"))
        end

    end

    Util.log("")
    Util.log("✓ Added: " .. song.title)
    Util.log("  Folder: " .. song.folder)

else

    Util.log("")
    Util.log("✗ Failed: " .. (err or "unknown error"))

end

Util.log("")
Util.log("Done.")
