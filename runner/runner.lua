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
local FS = App.require("backend.filesystem")
local JSON = App.require("backend.json")
local Library = App.require("backend.library")

-- The TUI-managed live set. The :3000 web server writes this whenever the
-- active setlist changes (from the TUI band set or the iPhone builder). The
-- runner hot-follows it so building/editing a playlist in the TUI updates
-- REAPER's region map live, without touching the transport.
local FOLLOW_SESSION_PATH =
    Util.joinPath(
        App.root,
        "data",
        "setlists",
        "_last_session.json"
    )

-- How often (in loop frames, ~60fps) to re-stat the follow file.
local FOLLOW_CHECK_FRAMES = 90 -- ~1.5s

-- Control-plane command file. The :3000 web server writes {cmd:"arm"|"play"|"stop"}
-- here (from TUI START SHOW / MIDI / phone buttons); the runner polls it and
-- executes against REAPER's real transport (seek, BPM, play/stop).
local CONTROL_PATH =
    Util.joinPath(
        App.root,
        "data",
        "control_command.json"
    )
local CONTROL_CHECK_FRAMES = 30 -- ~0.5s

-- Safe handle to the current (first) project. REAPER's API is
-- reaper.EnumProjects(0, 0); there is no reaper.ProjectIndex. pcall-guarded so
-- a missing/broken API never crashes the defer loop.
function Runner._currentProject()
  if not reaper or not reaper.EnumProjects then return nil end
  local ok, proj = pcall(reaper.EnumProjects, 0, 0)
  if ok and proj then return proj end
  return nil
end

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
  return setmetatable({
    show = nil,
    currentSong = nil,
    nextSong = nil,
    songIndex = 0,
    totalSongs = 0,
    playing = false,
    paused = false,
    position = 0,
    duration = 0,
    running = false,
    followContent = nil,
    followCheckTimer = 0,
    armed = false,
    stagedIndex = 0,
    countIn = nil,
    controlCheckTimer = 0,
    library = nil
  }, { __index = Runner })
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

-- ── Load the TUI-managed live set ──
-- Reads data/setlists/_last_session.json (written by the web server whenever
-- the active setlist changes) and builds the show from it. This is the
-- recommended way to start: the TUI is the playlist manager.
-- Returns (true, nil) or (false, errorMessage) when no live set exists yet.
function Runner.loadFollowShow(self)
  local ok, raw = pcall(FS.read, FOLLOW_SESSION_PATH)
  if not ok or not raw or raw == "" then
    return false, "No live set yet — import one in the TUI, then Launch again"
  end
  local okd, data = pcall(JSON.decode, raw)
  if not okd or not data or not data.songs or #data.songs == 0 then
    return false, "Empty live set"
  end
  self.followContent = raw
  local err = Runner._applySessionData(self, data)
  if err then return false, err end
  return true, nil
end

-- Build/rebuild the Show from a decoded follow file. Keeps the currently
-- referenced song anchored when the set changes mid-show (best effort: if the
-- playing song is gone, we fall back to the cursor position mapping).
function Runner._applySessionData(self, data)
  if not self.library then self.library = Library.scan() end
  local lookup = {}
  for _, s in ipairs(self.library) do
    lookup[s.id] = s
    lookup[s.folder] = s
    if s.title then lookup[string.lower(s.title)] = s end
  end
  local names = {}
  local ids = {}
  for _, s in ipairs(data.songs or {}) do
    local song = nil
    if s.id then song = lookup[s.id] end
    if not song and s.folder then song = lookup[s.folder] end
    if not song and s.title then song = lookup[string.lower(tostring(s.title))] end
    if song then
      table.insert(names, song.title)
      table.insert(ids, song.id)
    end
  end
  if #ids == 0 then return "Live set resolved 0 songs" end

  local built
  local ok, err = pcall(function()
    built = Show.fromSetlist({ name = data.name or "Live set", songs = ids }, self.library, nil)
  end)
  if not ok then return "Show build failed: " .. tostring(err) end
  if not built or #built.regions == 0 then return "Show build produced no regions" end

  self.show = built
  self.totalSongs = #built.regions
  self._lastSongKey = nil -- allow the BPM push to re-fire on next boundary
  -- Re-anchor to the current play position so a live edit never desyncs the
  -- phone (if the cursor is inside a region of the new set, restore it). If the
  -- cursor is past the end of the set, anchor to the last song (not a blank).
  local idx, region = Show.lookupByPosition(self.show, self.position or 0)
  if not idx and self.position and #built.regions > 0 then
    local last = built.regions[#built.regions]
    if self.position >= last.startTime + last.duration then
      idx = #built.regions
      region = last
    end
  end
  self.songIndex = idx or 0
  self.currentSong = region and region.song or nil
  self.nextSong = nil
  self.duration = region and region.duration or 0
  if idx and idx < #built.regions then
    self.nextSong = built.regions[idx + 1].song
  end

  Util.log(("[ShowSrv] Following live set '%s' → %d songs"):format(data.name or "Live set", self.totalSongs))
end

-- Called from the defer loop (throttled): if the TUI updated the set, rebuild.
function Runner._followCheck(self)
  if not self.show then return end
  local ok, raw = pcall(FS.read, FOLLOW_SESSION_PATH)
  if not ok or not raw or raw == "" then return end
  if raw == self.followContent then return end
  local okd, data = pcall(JSON.decode, raw)
  if not okd or not data then return end
  self.followContent = raw
  Runner._applySessionData(self, data)
end

-- ── Control plane (ARM / PLAY / STOP) ──
-- Executes commands from data/control_command.json written by the :3000 server.
-- The runner owns the real transport so all timing (count-in seek, BPM, play
-- edge) is driven by REAPER's own clock — the teleprompter locks onto it via
-- the countIn anchor published in the bridge.
function Runner._controlCheck(self)
  if not self.show or #self.show.regions == 0 then return end
  local ok, raw = pcall(FS.read, CONTROL_PATH)
  if not ok or not raw or raw == "" then return end
  local okd, data = pcall(JSON.decode, raw)
  if not okd or not data or not data.cmd then return end
  -- Consume the command (delete the file) so it only runs once.
  pcall(FS.delete, CONTROL_PATH)
  local cmd = data.cmd
  if cmd == "arm" then
    self.armed = (data.armed ~= false)
    Util.log("[Control] Armed = " .. tostring(self.armed))
    if self.armed then Runner._stageFirst(self) end
  elseif cmd == "play" then
    Runner._cmdPlay(self)
  elseif cmd == "stop" then
    Runner._cmdStop(self)
  elseif cmd == "stage" then
    if data.index and data.index > 0 then
      Runner._stageIndex(self, data.index)
    else
      local dir = (data.dir == -1) and -1 or 1
      Runner._stageAdjacent(self, dir)
    end
  end
end

-- Stage the first song (used on ARM and on first PLAY): cursor to region 1
-- start + its BPM, transport parked (not playing).
function Runner._stageFirst(self)
  Runner._stageIndex(self, 1)
end

-- Stage a song by relative direction (1 = next, -1 = previous), wrapping at
-- the ends. Staging always parks the transport (armed, not playing).
function Runner._stageAdjacent(self, dir)
  local regions = self.show.regions
  if not regions or #regions == 0 then return end
  local cur = (self.stagedIndex > 0) and self.stagedIndex or ((self.songIndex or 0))
  if cur < 1 then cur = 1 end
  local n = #regions
  Runner._stageIndex(self, ((cur - 1 + dir) % n) + 1)
end

-- Stage a specific region index. Sets current song + BPM. Does NOT touch REAPER
-- transport — REAPER is a guitar processor, not our clock.
function Runner._stageIndex(self, idx)
  local regions = self.show.regions
  if not regions or #regions == 0 then return end
  if idx < 1 or idx > #regions then return end
  local target = regions[idx]
  if not target or not target.song then return end
  self.stagedIndex = idx
  self.songIndex = idx
  self.currentSong = target.song
  self.duration = target.duration
  self.nextSong = (idx < #regions) and regions[idx + 1].song or nil
  self.beatAnchorSec = target.startTime
  self.countIn = nil
  Runner._setSongBpm(self, target.song.bpm)
  Util.log("[Control] Staged #" .. idx .. ": " .. target.song.title)
end

-- Stage the NEXT song after STOP. so the HUD/teleprompter track position.
-- Does NOT touch REAPER transport — REAPER is a guitar processor.
-- Pushes the song's BPM to REAPER for delay FX sync.
function Runner._cmdPlay(self)
  if not self.armed then
    Util.log("[Control] PLAY ignored — show not armed")
    return
  end
  if self.playing then
    Util.log("[Control] PLAY ignored — already playing")
    return
  end
  local regions = self.show.regions
  if not regions or #regions == 0 then return end
  local idx = (self.stagedIndex > 0) and self.stagedIndex or ((self.songIndex > 0) and self.songIndex or 1)
  local target = regions[idx]
  if not target or not target.song then return end

  self.stagedIndex = 0
  self.songIndex = idx
  self.currentSong = target.song
  self.duration = target.duration
  self.nextSong = (#regions > idx) and regions[idx + 1].song or nil
  self.beatAnchorSec = target.startTime
  self.playing = true
  self.position = 0
  self._playStartTime = (reaper and reaper.time_precise and reaper.time_precise()) or 0
  Runner._setSongBpm(self, target.song.bpm)

  local beatsPerBar = 4
  local beatsPerBeat = 4
  if target.song.time_sig and target.song.time_sig[1] and target.song.time_sig[1] > 0
     and target.song.time_sig[1] <= 16 then
    beatsPerBar = math.floor(target.song.time_sig[1])
  end
  if target.song.time_sig and target.song.time_sig[2] and target.song.time_sig[2] > 0
     and target.song.time_sig[2] <= 64 then
    beatsPerBeat = math.floor(target.song.time_sig[2])
  end
  if target.song.bpm_verified then
    Runner._setSongTimeSig(self, beatsPerBar, beatsPerBeat)
  end

  Util.log(("[Control] PLAY #%d %s (BPM %.0f)"):format(idx, target.song.title, target.song.bpm or 0))
end

-- STOP: end the current song, stage the next one. Does NOT touch REAPER transport.
function Runner._cmdStop(self)
  if not self.playing then
    Util.log("[Control] STOP ignored — nothing playing")
    return
  end
  self.playing = false
  self.position = 0
  self.countIn = nil
  Runner._stageNext(self)
  Util.log("[Control] STOP — staged next song")
end

-- ── Start the runner ──
-- Begins the reaper.defer() loop that tracks position and publishes state.
-- REAPER's transport is NOT controlled — it runs independently as a guitar
-- processor. We only read position and push BPM for delay FX sync.
-- Returns (true, nil) on success, or (false, errorMessage) if no show is loaded.
function Runner.start(self)
  if not self.show or #self.show.regions == 0 then
    return false, "No show loaded"
  end
  self.running = true
  self.songIndex = 0
  self.currentSong = nil
  self.nextSong = nil
  self.armed = false
  self.stagedIndex = 0
  self.countIn = nil
  self.beatAnchorSec = self.show.regions[1] and self.show.regions[1].startTime or 0
  pcall(FS.delete, CONTROL_PATH)
  Util.log("[Runner] Started: " .. self.show.name .. " (passive observer — not controlling REAPER transport)")
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
  if not self.running then return end

  -- ── Position tracking ──
  -- When "playing" (set by control-plane PLAY), advance our own clock using
  -- wall-clock time. REAPER's transport is NOT used — REAPER is a guitar
  -- processor, not our clock source.
  if self.playing then
    local now = (reaper and reaper.time_precise and reaper.time_precise()) or 0
    local elapsed = (self._playStartTime and now > 0) and (now - self._playStartTime) or 0
    self.position = elapsed
  else
    -- Passively read REAPER position when available (e.g. for song region
    -- context when user has REAPER playing independently).
    if reaper and reaper.GetPlayPosition then
      self.position = reaper.GetPlayPosition()
    end
  end

  -- ── Determine which song/region we're in ──
  -- When playing, the song is set by _cmdPlay from the staged index.
  -- When stopped, use REAPER position or fall back to the staged song.
  if self.playing then
    -- Playing: song was already set by _cmdPlay. Just update nextSong.
    if self.songIndex > 0 and self.songIndex < #self.show.regions then
      self.nextSong = self.show.regions[self.songIndex + 1].song
    else
      self.nextSong = nil
    end
  else
    local idx, region = Show.lookupByPosition(self.show, self.position)
    if region then
      self.songIndex = idx or 0
      self.currentSong = region.song
      self.duration = region.duration
      self.beatAnchorSec = region.startTime
      if self.currentSong and self.currentSong.bpm and self.currentSong.bpm > 0 then
        local songKey = tostring(self.currentSong.id or self.currentSong.title)
        if songKey ~= (self._lastSongKey or "") then
          self._lastSongKey = songKey
          Runner._setSongBpm(self, self.currentSong.bpm)
        end
      end
      self.nextSong = (idx and idx < #self.show.regions) and self.show.regions[idx + 1].song or nil
    end
  end

  -- ── Throttled REAPER API data collection ──
  -- Every `reaperApiInterval` frames, collect track and FX data.
  -- This avoids the performance hit of querying REAPER's API every frame.
  reaperApiTimer = reaperApiTimer + 1
  self.followCheckTimer = self.followCheckTimer + 1
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
  -- Hot-follow the TUI-managed live set (cheap stat, ~1.5s cadence).
  if self.followCheckTimer >= FOLLOW_CHECK_FRAMES then
    self.followCheckTimer = 0
    Runner._followCheck(self)
  end
  -- Poll the control-plane command file (~0.5s cadence).
  self.controlCheckTimer = (self.controlCheckTimer or 0) + 1
  if self.controlCheckTimer >= CONTROL_CHECK_FRAMES then
    self.controlCheckTimer = 0
    Runner._controlCheck(self)
  end
  -- Auto-expire count-in once elapsed time passes the full pre-roll window.
  if self.countIn and self.countIn.active then
    local ci = self.countIn
    local beatSec = 60 / (ci.bpm or 120)
    if self.position >= ci.rollStart + (2 + (ci.beats or 0)) * beatSec then
      self.countIn = nil
    end
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
    showName = self.show and self.show.name or "",
    armed = self.armed,
    stagedIndex = self.stagedIndex,
    countIn = self.countIn,
    beatAnchorSec = self.beatAnchorSec or 0
  }

  Bridge.publish(self, trackData, fxData, synthData, loopStates)

  -- ── Schedule next frame ──
  reaper.defer(function() Runner._loop(self) end)
end

-- Push a song's BPM into REAPER's project tempo. Defensive: skips if the
-- tempo is already close (avoids rescaling beat-anchored media needlessly) or
-- if the required REAPER API is unavailable. Cannot crash the defer loop.
--
-- SAFETY (show-critical):
--   1. Only fires when the song's BPM is verified (bpm_verified=true from
--      LRCLIB/gpif/manual tap). An unverified BPM is never pushed into REAPER,
--      so the click can't run at a guessed tempo.
--   2. Never changes the project tempo if ANY track item is tempo-synced
--      (play-rate tied to project tempo / beat-based source). Changing BPM would
--      time-stretch those items — the catastrophic failure for stems/tracks.
function Runner._setSongBpm(self, bpm)
  if not bpm or bpm <= 0 then return end
  if not reaper or not reaper.EnumProjects or not reaper.SetCurrentBPM then
    return
  end
  -- Gate 1: only verified BPMs.
  if not (self.currentSong and self.currentSong.bpm_verified) then
    Util.log("[ShowSrv] BPM " .. tostring(bpm) .. " not verified — not changing project tempo")
    return
  end
  local proj = Runner._currentProject()
  if not proj then return end

  -- Gate 2: skip if any track item is tempo-synced (would be stretched).
  if Runner._hasTempoSyncedItems() then
    Util.log("[ShowSrv] Tempo-synced items present — NOT changing project BPM (stretch protection)")
    return
  end

  -- Already at target? skip to avoid churn. TimeMap_GetTimeSigAtTime reflects
  -- the current effective tempo (envelope/tap aware) as (num, den, tempo).
  if reaper.TimeMap_GetTimeSigAtTime then
    local _n, _d, curBpm = reaper.TimeMap_GetTimeSigAtTime(proj, reaper.GetPlayPosition())
    if curBpm and math.abs(curBpm - bpm) < 1 then return end
  elseif reaper.GetProjectTimeSignature2 then
    local curBpm = reaper.GetProjectTimeSignature2(proj)
    if curBpm and math.abs(curBpm - bpm) < 1 then return end
  end

  -- SetCurrentBPM(proj, bpm, wantUndo=true) adds its own undo point.
  local ok = pcall(function()
    reaper.SetCurrentBPM(proj, bpm, true)
  end)
  if ok then
    reaper.ShowConsoleMsg(("[ShowSrv] Set project BPM → %.0f (verified)\n"):format(bpm))
  end
end

-- Set REAPER's project time signature to the song's meter (e.g. 3/4 for a
-- waltz). The click accent + count-in + bar display all derive beats-per-bar
-- from this. pcall-guarded; only called for verified songs. Changing the time
-- signature does NOT stretch audio items (it only changes the grid).
function Runner._setSongTimeSig(self, beatsPerBar, beatsPerBeat)
  if not beatsPerBar or beatsPerBar < 1 or beatsPerBar > 16 then return end
  local den = (beatsPerBeat and beatsPerBeat > 0 and beatsPerBeat <= 64) and math.floor(beatsPerBeat) or 4
  if not reaper or not reaper.EnumProjects or not reaper.TimeMap_SetTimeSig then
    return
  end
  local proj = Runner._currentProject()
  if not proj then return end
  -- TimeMap_SetTimeSig(proj, measure_index, timesig_num, timesig_den) sets the
  -- time signature at the given measure. We use the project's start (measure 0).
  -- Den is the beat unit: 4 for quarter-note (3/4, 4/4, 7/4), 8 for eighth-note
  -- (7/8). This drives the click accent (beat 1 of N) + count-in + bar display.
  pcall(function()
    reaper.TimeMap_SetTimeSig(proj, 0, beatsPerBar, den)
  end)
  Util.log(("[ShowSrv] Set project time sig → %d/%d"):format(beatsPerBar, den))
end

-- True if any item in the project is tempo-synced (play rate derived from
-- project tempo, or a beat-based source). Such items would be time-stretched if
-- the project BPM changed. Cheap scan; cached for ~2s to avoid per-frame cost.
local _tempoSyncCheckAt = 0
local _tempoSyncCache = false
function Runner._hasTempoSyncedItems()
  local now = (reaper.time_precise and reaper.time_precise()) or 0
  if now - _tempoSyncCheckAt < 2 then return _tempoSyncCache end
  _tempoSyncCheckAt = now
  _tempoSyncCache = false
  if not reaper or not reaper.CountTracks then return false end
  local ntracks = reaper.CountTracks(0)
  for t = 0, ntracks - 1 do
    local track = reaper.GetTrack(0, t)
    if track then
      local nitems = reaper.CountTrackMediaItems(track)
      for i = 0, nitems - 1 do
        local item = reaper.GetTrackMediaItem(track, i)
        if item then
          local ntake = reaper.CountTakes(item)
          for k = 0, ntake - 1 do
            local take = reaper.GetMediaItemTake(item, k)
            if take then
              -- Tempo-synced takes have a playrate derived from the tempo map.
              local okpr, pr = pcall(reaper.GetMediaItemTakeInfo_Value, take, "PLAYRATE")
              if okpr and pr and pr > 0 then
                local playrateFromTempo = reaper.Master_GetPlayRateAtTime
                  and reaper.Master_GetPlayRateAtTime(0, reaper.GetCursorPositionEx(0)) or 1
                if math.abs(pr - playrateFromTempo) < 0.001 then
                  _tempoSyncCache = true
                  return true
                end
              end
            end
          end
        end
      end
    end
  end
  return false
end

return Runner
