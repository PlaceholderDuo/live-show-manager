local Bridge = {}

local JSON = App.require("backend.json")
local FS = App.require("backend.filesystem")
local Util = App.require("backend.util")

local BRIDGE_PATH = Util.joinPath(App.root, "data", "bridge_state.json")
local lastWrite = 0
local throttleIdle = 500
local throttlePlaying = 30

local function formatTime(seconds)
  if not seconds or seconds < 0 then return "0:00" end
  local m = math.floor(seconds / 60)
  local s = math.floor(seconds % 60)
  return m .. ":" .. string.format("%02d", s)
end

-- Real transport tempo + time signature from REAPER (authoritative clock).
-- TimeMap_GetTimeSigAtTime reflects tempo envelopes + tap-tempo changes and
-- returns (timesig_num, timesig_denom, tempo). Falls back to the project
-- setting (GetProjectTimeSignature2 → bpm, bpi) then the song's meta BPM.
-- Entirely pcall-guarded: this must never crash the publish frame (any probe
-- failure just means we publish the song BPM / 4-4 default).
local function readTransport(songBpm, songTimeSig)
  local beatsPerBar = 4
  local beatsPerBeat = 4
  local bpm = (songBpm and songBpm > 0) and songBpm or 120
  local proj = nil
  if reaper and reaper.EnumProjects then
    local okp, p = pcall(reaper.EnumProjects, 0, 0)
    if okp and p then proj = p end
  end
  if proj then
    local ok1, sigBeats, sigDen, sigBpm = pcall(reaper.TimeMap_GetTimeSigAtTime, proj, reaper.GetPlayPosition())
    if ok1 and sigBpm and sigBpm > 0 and sigBpm < 400 then
      bpm = math.floor(sigBpm + 0.5)
    end
    if ok1 and sigBeats and sigBeats > 0 and sigBeats <= 16 then
      beatsPerBar = math.floor(sigBeats)
    end
    if ok1 and sigDen and sigDen > 0 and sigDen <= 64 then
      beatsPerBeat = math.floor(sigDen)
    end
    if sigBpm == nil then
      local ok2, b2, beats2 = pcall(reaper.GetProjectTimeSignature2, proj)
      if ok2 and b2 and b2 > 0 and b2 < 400 then
        bpm = math.floor(b2 + 0.5)
      end
      if ok2 and beats2 and beats2 > 0 and beats2 <= 16 then
        beatsPerBar = math.floor(beats2)
      end
    end
  end
  -- Fallback: the song's own meter when REAPER's project value is unavailable
  -- or reads as a plain 4 (e.g. time-sig set didn't apply yet).
  if songTimeSig and songTimeSig[1] and songTimeSig[1] > 0 and songTimeSig[1] <= 16 then
    beatsPerBar = math.floor(songTimeSig[1])
  end
  return bpm, beatsPerBar, beatsPerBeat
end

function Bridge.publish(runnerState, trackData, fxData, synthData, loopStates)
  local now = reaper.time_precise and reaper.time_precise() or 0
  local curThrottle = (runnerState and runnerState.playing) and throttlePlaying or throttleIdle
  if (now - lastWrite) * 1000 < curThrottle then
    return
  end
  lastWrite = now

  local currentSong = runnerState.currentSong
  local nextSong = runnerState.nextSong
  local realBpm, beatsPerBar, beatsPerBeat = readTransport((currentSong and currentSong.bpm) or nil, currentSong and currentSong.time_sig)

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
    bpm = realBpm,
    time_sig = { beatsPerBar, beatsPerBeat },
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
    armed = runnerState.armed or false,
    stagedIndex = runnerState.stagedIndex or 0,
    countIn = runnerState.countIn or nil,
    beatAnchorSec = runnerState.beatAnchorSec or 0,
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
