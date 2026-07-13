-- Live Show Manager — models/show.lua
-- =========================================
-- Show model: represents a performance show (setlist + computed regions).
-- Used by both the Show Builder (Phase 4) and the Live Runner (Phase 5).
--
-- KEY FUNCTIONS:
--   Show.fromSetlist(setlist, library, showPath)
--     → Takes a setlist (array of song IDs or {name, songs[]} object),
--       resolves songs from the library, computes regions via RegionBuilder.
--     → Returns a Show object with .regions populated.
--
--   Show.lookupByPosition(show, seconds)
--     → Scans the show's regions to find which song the play cursor is in.
--     → Returns (index, region) or (nil, nil) if cursor is outside all regions.
--     → Used by Runner._loop() every frame to determine current/next song.
--
-- DATA MODEL:
--   {
--     name: string,          // Show name (e.g., "Friday Night")
--     songs: Song[],          // Array of resolved Song objects
--     regions: Region[],      // Array of {song, startTime, duration}
--     path: string            // Optional path to .rpp show file
--   }
--
-- TROUBLESHOOTING:
--   - Empty regions array → RegionBuilder didn't produce results (check songs have bpm/duration_bars)
--   - lookupByPosition returns nil → cursor is past the last region's end time
--   - Wrong current song → region boundaries don't match song durations (check BPM + bars in meta.json)

local Show = {}

local Util = App.require("backend.util")
local JSON = App.require("backend.json")
local FS = App.require("backend.filesystem")
local RegionBuilder = App.require("builders.region_builder")

-- ── Constructor ──
-- Creates a new Show object with default empty values.
-- Parameters:
--   name  → string display name for the show
--   songs → array of resolved Song objects
--   path  → optional file path to the .rpp show file
function Show.new(name, songs, path)
  return {
    name = name or "",
    songs = songs or {},
    regions = {},      -- Populated by fromSetlist() or manually
    path = path or ""
  }
end

-- ── Build show from setlist + library ──
-- Resolves song IDs from the setlist against the library,
-- then computes region positions using RegionBuilder.calculate().
--
-- Parameters:
--   setlist   → either a setlist object {name, songs[]} or a flat array of song IDs
--   library   → array of Song objects from Library.scan()
--   showPath  → optional file path to the .rpp show file
--
-- Returns a Show object with .regions populated.
--
-- Region calculation (from RegionBuilder.calculate):
--   position = accumulated total of previous songs' durations
--   duration = (duration_bars × 4 beats × 60) / BPM
--   Defaults: 120 BPM, 32 bars if meta.json values are missing
function Show.fromSetlist(setlist, library, showPath)
  -- Build lookup table for O(1) song resolution by ID
  local lookup = {}
  for _, s in ipairs(library) do
    lookup[s.id] = s
  end

  -- Resolve each song ID in the setlist to its Song object
  local resolved = {}
  for _, id in ipairs(setlist.songs or setlist) do
    if lookup[id] then
      table.insert(resolved, lookup[id])
    end
    -- Silently skip unresolved IDs (song may have been deleted from library)
  end

  -- Compute regions from the resolved songs
  local regions = RegionBuilder.calculate(resolved)

  -- Build and return the Show object
  local show = Show.new(setlist.name, resolved, showPath)
  show.regions = regions
  return show
end

-- ── Find which region contains a given time position ──
-- Linear scan of regions (there are typically < 50, so binary search isn't needed).
-- Returns (regionIndex, region) or (nil, nil) if position is outside all regions.
--
-- Edge cases handled:
--   - Position before first region → returns first region (index 1)
--   - Position after last region → returns nil (show is over)
--   - Empty show → returns nil
--   - Position exactly at region boundary → belongs to the next region
--
-- Used by: Runner._loop() every frame to track current song
function Show.lookupByPosition(show, seconds)
  if not show or #show.regions == 0 then
    return nil
  end

  for i, r in ipairs(show.regions) do
    if seconds >= r.startTime and seconds < r.startTime + r.duration then
      return i, r
    end
  end

  -- Before first region: return first region as default
  if seconds < show.regions[1].startTime then
    return 1, show.regions[1]
  end

  -- After last region: return nil (show is over)
  if seconds >= show.regions[#show.regions].startTime + show.regions[#show.regions].duration then
    return nil, nil
  end

  return nil, nil
end

return Show
