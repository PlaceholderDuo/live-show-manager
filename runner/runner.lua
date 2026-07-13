-- Live Show Manager — runner/runner.lua
-- =========================================
-- The performance engine: tracks the REAPER play cursor against show regions
-- to determine which song is currently playing, and publishes state for
-- the Node.js web server to broadcast to iPhone + stage display.
--
-- HOW IT WORKS:
--   1. loadShow(setlist, library, name) → creates a Show model with computed regions
--   2. start() → begins a reaper.defer() loop that runs every frame (~60fps)
--   3. Each frame: checks GetPlayStateEx + GetPlayPosition, looks up which
--      region/song we're in via Show.lookupByPosition, then calls Bridge.publish()
--   4. Bridge writes state to data/bridge_state.json → server polls → iPhone updates
--
-- Every 10 frames (~166ms), the runner also collects REAPER track data (names,
-- volumes, mute/solo, FX chains) and publishes that alongside the main state.
-- This is throttled because REAPER API calls are relatively expensive.
--
-- USAGE (from another Lua module):
--   local Runner = App.require("runner.runner")
--   local r = Runner.new()
--   r:loadShow(setlist, library, "Friday Night")
--   r:start()
--
-- TROUBLESHOOTING:
--   - Runner won't start without a show loaded (loadShow first)
--   - If no data appears on iPhone, check Bridge.publish errors in console
--   - If track/FX data is empty, REAPER might have no tracks or FX loaded
--   - The defer loop runs indefinitely until Runner.stop() is called

local Runner = {}

local Util = App.require("backend.util")
local Show = App.require("models.show")
local Bridge = App.require("runner.bridge")

-- ── Constructor ──
-- Returns a new Runner instance with all fields initialized.
-- Fields:
--   show       → Show model (computed regions + songs)
--   currentSong → Song model for the currently-playing song
--   nextSong    → Song model for the upcoming song (if any)
--   songIndex   → 1-based index into show.regions
--   totalSongs  → total number of songs in the show
--   playing     → true if REAPER transport is playing
--   paused      → true if REAPER transport is paused
--   position    → current REAPER play position in seconds
--   duration    → duration of current song in seconds
--   running     → true if the defer loop is active
function Runner.new()
  return {
    show = nil,
    currentSong = nil,
    nextSong = nil,
    songIndex = 0,
    totalSongs = 0,
    playing = false,
    paused = false,
    position = 0,
    duration = 0,
    running = false
  }
end

-- ── Load a show ──
-- Takes a setlist (array of song IDs), the library (array of Song objects),
-- an optional show name, and an optional show file path.
-- This creates a Show model and computes regions via RegionBuilder.calculate().
--
-- Parameters:
--   setlist   → array of song ID strings, e.g. {"summer_of_69", "gravity"}
--   library   → array of Song objects from Library.scan()
--   showName  → string name for the show (appears in iPhone header)
--   showPath  → optional file path to the .rpp show file
function Runner.loadShow(self, setlist, library, showName, showPath)
  local setlistObj = { name = showName or "", songs = setlist }
  self.show = Show.fromSetlist(setlistObj, library, showPath)
  self.totalSongs = #self.show.regions
  -- Reset all state for fresh start
  self.songIndex = 0
  self.currentSong = nil
  self.nextSong = nil
  self.playing = false
  self.paused = false
  self.position = 0
  self.duration = 0
  return self
end

-- ── Start the runner ──
-- Begins the reaper.defer() loop that tracks position and publishes state.
-- The loop runs continuously until stop() is called.
-- Returns (true, nil) on success, or (false, errorMessage) if no show is loaded.
function Runner.start(self)
  if not self.show or #self.show.regions == 0 then
    return false, "No show loaded"
  end
  self.running = true
  self.songIndex = 0
  self.currentSong = nil
  self.nextSong = nil
  Util.log("[Runner] Started: " .. self.show.name)
  reaper.defer(function() Runner._loop(self) end)
  return true, nil
end

-- ── Stop the runner ──
-- Stops the defer loop. The runner will no longer track position or publish state.
-- Safe to call even if already stopped.
function Runner.stop(self)
  self.running = false
  Util.log("[Runner] Stopped")
end

-- ═══════════════════════════════════════════════════════════
-- REAPER TRACK/FX DATA COLLECTION
-- ═══════════════════════════════════════════════════════════
-- These functions query REAPER's Lua API for track and FX information.
-- They're called every N frames (see reaperApiInterval below) to avoid
-- overwhelming the REAPER API with per-frame calls.
--
-- Each returns a table that Bridge.publish writes to bridge_state.json
-- and the server broadcasts to the iPhone's FX/Mix tabs.

local SYNTH_PATTERNS = {
  "synth", "analog", "vital", "serum", "massive", "spire", "pigments",
  "diva", "repro", "phase", "vanguard", "zebra", "helm", "surge",
  "vsti", "kontakt", "opx", "mini", "jupiter", "moog", "arp",
  "prophet", "oberheim", "cmi", "wave", "wavetable", "granular",
  "drum synth", "bass synth", "lead"
}

function Runner._collectTrackData(self)
  -- Queries ALL tracks in the current REAPER project.
  -- Returns: [{name, level (0-1), mute (bool), solo (bool), isSynth (bool)}]
  local tracks = {}
  local count = reaper.CountTracks(0)
  for i = 0, count - 1 do
    local track = reaper.GetTrack(0, i)
    local ret, name = reaper.GetTrackName(track)
    local _, vol = reaper.GetTrackUIVolPan(track, 0, 0)
    local mute = reaper.GetMediaTrackInfo_Value(track, "B_MUTE")
    local solo = reaper.GetMediaTrackInfo_Value(track, "B_SOLO")
    table.insert(tracks, {
      name = (name and name ~= "") and name or "Track " .. (i + 1),
      level = vol,
      mute = mute == 1.0,
      solo = solo == 1.0
    })
  end
  return tracks
end

function Runner._collectFXData(self)
  -- Queries ALL tracks and their FX chains.
  -- Returns: { tracks: [{ name, fx: [{ name, params: [{name, value}] }] }] }
  -- Only grabs up to 8 params per FX (enough for the iPhone display).
  local result = { tracks = {} }
  local count = reaper.CountTracks(0)
  for i = 0, count - 1 do
    local track = reaper.GetTrack(0, i)
    local ret, name = reaper.GetTrackName(track)
    local fxCount = reaper.TrackFX_GetCount(track)
    local fxList = {}
    for j = 0, fxCount - 1 do
      -- TrackFX_GetFXName returns full path like "VST3: ValhallaRoom (Valhalla DSP, LLC)"
      -- We extract just the short name after the colon
      local ret, fxName = reaper.TrackFX_GetFXName(track, j, "")
      local fxShort = fxName:match(":(.+)$") or fxName
      local paramCount = reaper.TrackFX_GetNumParams(track, j)
      local params = {}
      -- Limit to 8 params for the iPhone's 2×4 grid
      local pMax = math.min(paramCount - 1, 7)
      for k = 0, pMax do
        local ret, pName = reaper.TrackFX_GetParamName(track, j, k, "")
        local ret2, pVal = reaper.TrackFX_GetParam(track, j, k)
        table.insert(params, { name = pName, value = pVal })
      end
      table.insert(fxList, { name = fxShort, params = params })
    end
    table.insert(result.tracks, { name = name, fx = fxList })
  end
  return result
end

function Runner._collectSynthData(self)
  -- Scans tracks for synth VSTs by name, reports preset info.
  -- Returns: [{name, preset}] or empty array.
  local synths = {}
  local count = reaper.CountTracks(0)
  for i = 0, count - 1 do
    local track = reaper.GetTrack(0, i)
    local ret, trackName = reaper.GetTrackName(track)
    local fxCount = reaper.TrackFX_GetCount(track)
    for j = 0, fxCount - 1 do
      local ret, fxName = reaper.TrackFX_GetFXName(track, j, "")
      local shortName = (fxName:match(":(.+)$") or fxName):lower()
      local isSynth = false
      for _, pat in ipairs(SYNTH_PATTERNS) do
        if shortName:find(pat) then
          isSynth = true
          break
        end
      end
      if isSynth then
        local ret, preset = reaper.TrackFX_GetPreset(track, j, "")
        table.insert(synths, {
          name = fxName:match(":(.+)$") or fxName,
          track = trackName or "Track " .. (i + 1),
          preset = (preset and preset ~= "") and preset or "(factory)"
        })
      end
    end
  end
  return synths
end

function Runner._collectLoopStates(self)
  -- Stub: Mobius doesn't expose loop state via standard REAPER TrackFX API.
  -- Future: Parse MIDI feedback from Mobius (Mobius sends CC/NRPN for loop state).
  -- Returns empty table for now. When Mobius MIDI feedback parsing is wired,
  -- this returns { [trackName]: { status, progress, beats } }.
  return {}
end

-- ═══════════════════════════════════════════════════════════
-- MAIN DEFER LOOP
-- ═══════════════════════════════════════════════════════════
-- Runs every frame via reaper.defer(). Does:
--   1. Read REAPER transport state (playing/paused/stopped + position)
--   2. Look up which song/region the cursor is in
--   3. Every N frames, also collect track/FX data from REAPER API
--   4. Publish everything via Bridge.publish()

local reaperApiTimer = 0               -- Counter for throttling REAPER API calls
local reaperApiInterval = 10           -- Collect track/FX every 10 frames (~166ms)

function Runner._loop(self)
  -- Guard: if stop() was called, exit the loop
  if not self.running then return end

  -- Guard: if REAPER isn't fully loaded yet, skip this frame and retry
  if not reaper or not reaper.GetPlayStateEx then
    reaper.defer(function() Runner._loop(self) end)
    return
  end

  -- ── Read REAPER transport state ──
  -- GetPlayStateEx returns a bitmask:
  --   0 = stopped, 1 = playing, 2 = paused, 4 = recording
  --   5 = playing+recording, 6 = paused+recording
  local playState = reaper.GetPlayStateEx(0)
  self.playing = (playState == 1 or playState == 5)
  self.paused = (playState == 2 or playState == 6)
  self.position = reaper.GetPlayPosition()

  -- ── Determine which song/region we're in ──
  -- Show.lookupByPosition scans regions. Returns (index, region) or (nil, nil).
  local idx, region = Show.lookupByPosition(self.show, self.position)
  self.songIndex = idx or 0

  if region then
    -- Cursor is inside a song region
    self.currentSong = region.song
    self.duration = region.duration
    if idx and idx < #self.show.regions then
      self.nextSong = self.show.regions[idx + 1].song
    else
      self.nextSong = nil  -- Last song or beyond
    end
  else
    -- Cursor is outside all regions (before first or after last)
    if self.position == 0 then
      -- At position 0: default to first song
      self.currentSong = self.show.regions[1].song
      self.nextSong = #self.show.regions > 1 and self.show.regions[2].song or nil
      self.duration = self.show.regions[1].duration
      self.songIndex = 1
    else
      -- Past the end of the last region
      self.currentSong = nil
      self.nextSong = nil
    end
  end

  -- ── Throttled REAPER API data collection ──
  -- Every `reaperApiInterval` frames, collect track and FX data.
  -- This avoids the performance hit of querying REAPER's API every frame.
  reaperApiTimer = reaperApiTimer + 1
  local trackData = nil
  local fxData = nil
  local synthData = {}
  local loopStates = {}
  if reaperApiTimer >= reaperApiInterval then
    reaperApiTimer = 0
    trackData = self:_collectTrackData()
    fxData = self:_collectFXData()
    synthData = self:_collectSynthData()
    loopStates = self:_collectLoopStates()
  end

  -- ── Publish state to the bridge (JSON file → server → iPhone) ──
  local state = {
    playing = self.playing,
    paused = self.paused,
    position = self.position,
    duration = self.duration,
    currentSong = self.currentSong,
    nextSong = self.nextSong,
    songIndex = self.songIndex,
    totalSongs = self.totalSongs,
    showName = self.show and self.show.name or ""
  }

  Bridge.publish(self, trackData, fxData, synthData, loopStates)

  -- ── Schedule next frame ──
  reaper.defer(function() Runner._loop(self) end)
end

return Runner
