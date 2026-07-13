local Bridge = {}

local JSON = App.require("backend.json")
local FS = App.require("backend.filesystem")
local Util = App.require("backend.util")

local BRIDGE_PATH = Util.joinPath(App.root, "data", "bridge_state.json")
local lastWrite = 0
local throttleMs = 200

local function formatTime(seconds)
  if not seconds or seconds < 0 then return "0:00" end
  local m = math.floor(seconds / 60)
  local s = math.floor(seconds % 60)
  return m .. ":" .. string.format("%02d", s)
end

function Bridge.publish(runnerState, trackData, fxData, synthData, loopStates)
  local now = reaper.time_precise and reaper.time_precise() or 0
  if (now - lastWrite) * 1000 < throttleMs then
    return
  end
  lastWrite = now

  local currentSong = runnerState.currentSong
  local nextSong = runnerState.nextSong

  local trackLevels = {}
  if trackData then
    for _, t in ipairs(trackData) do
      table.insert(trackLevels, {
        name = t.name,
        level = t.level or 0,
        mute = t.mute or false,
        solo = t.solo or false
      })
    end
  end

  local regions = {}
  if runnerState.show and runnerState.show.regions then
    for _, r in ipairs(runnerState.show.regions) do
      table.insert(regions, {
        startTime = r.startTime,
        duration = r.duration,
        title = (r.song and r.song.title) or "",
        artist = (r.song and r.song.artist) or "",
        bpm = (r.song and r.song.bpm) or 120,
        key = (r.song and r.song.key) or ""
      })
    end
  end

  local payload = {
    connected = true,
    playing = runnerState.playing or false,
    paused = runnerState.paused or false,
    position = runnerState.position or 0,
    duration = runnerState.duration or 0,
    bpm = (currentSong and currentSong.bpm) or 120,
    currentSong = (currentSong and currentSong.title) or nil,
    songId = (currentSong and currentSong.id) or nil,
    currentArtist = (currentSong and currentSong.artist) or nil,
    currentKey = (currentSong and currentSong.key) or nil,
    nextSong = (nextSong and nextSong.title) or nil,
    nextArtist = (nextSong and nextSong.artist) or nil,
    songIndex = runnerState.songIndex or 0,
    totalSongs = runnerState.totalSongs or 0,
    notes = (currentSong and currentSong.notes) or "",
    showName = runnerState.showName or "",
    elapsed = formatTime(runnerState.position),
    remaining = formatTime((runnerState.duration or 0) - (runnerState.position or 0)),
    trackLevels = trackLevels,
    loopStates = loopStates or {},
    fxData = fxData or { tracks = {} },
    synthData = synthData or {},
    regions = regions
  }

  local ok, json = pcall(JSON.encode, payload)
  if ok then
    FS.write(BRIDGE_PATH, json)
  end

  Bridge._lastPayload = payload
end

return Bridge
