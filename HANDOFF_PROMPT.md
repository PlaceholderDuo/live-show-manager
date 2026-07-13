# Live Show Manager — Context Reset Handoff

**Location:** `~/Library/Application Support/REAPER/Scripts/Live Show Manager/`
**REAPER:** Lua ReaScript, ReaImGui v0.10.0.5
**Test songs:** `~/ReaperSongs/` (Summer of 69, Gravity, Black Magic Woman, Pride and Joy)

## Module Loader

Custom `App.require("path.module")` in `main.lua`. Modules return tables. No globals.

## What's Working (Phases 1-3)

- Library scan (`~/ReaperSongs/` → song objects with meta.json + cue.mid)
- Song CRUD: add, remove, duplicate detection, audio import via ffmpeg (mono 22kHz 48kbps)
- Setlist persistence: save/load JSON to `data/setlists/`
- ReaImGui GUI: library panel, setlist panel, details panel, add/remove dialogs
- Search, selection, reorder (up/down)
- Standalone tools: `tools/add_song.lua`, `tools/remove_song.lua`

## Song Model

```
{ id (slug), title, artist, bpm, key, snapshot_id, duration_bars,
  notes, cue (path), folder, path, valid, warnings }
```

IDs are slugs from folder names (e.g. `summer_of_69`). Never use titles as identifiers.

Setlist = `{ name, songs = { "summer_of_69", "gravity", ... } }` — array of IDs.

## Phase 4 — Show Builder (JUST COMPLETED)

Three new modules in `builders/`:

### `region_builder.lua`
- `calculate(songs)` → walks songs, accumulates time via `(bars * 4 * 60) / bpm`
- `toRPP(regions, startIndex)` → `MARKER idx pos len "title" 0` lines
- Defaults: 120 BPM, 32 bars if missing

### `cue_builder.lua`
- `copyCues(songs, showDir)` → copies `cue.mid` → `show/cues/<slug>.mid`
- `toRPP(cues, regions)` → generates a full `<TRACK NAME "Cues">` block with `<ITEM>` entries referencing copied MIDI files (relative paths), positioned at song start times, looping to fill song duration

### `show_builder.lua`
- `build(setlistSongs, setName, library)` → resolves IDs, creates `~/ReaperShows/<Name>/`, reads `~/ReaperTemplates/MasterRig.rpp`, calls RegionBuilder + CueBuilder, inserts into RPP via depth-based bracket parsing, writes `<Name>.rpp`, returns path
- `insertIntoRPP(template, regionRPP, cueRPP)` — finds project's closing `>` by tracking `<>` depth, inserts region markers and cues track before it
- Template must exist at `~/ReaperTemplates/MasterRig.rpp`

### GUI Changes
- `setlist_panel.lua` returns `build` flag, dark-styled "BUILD SHOW" button with tooltip
- `app.lua` validates setlist name + non-empty, calls `ShowBuilder.build()`, on success shows Yes/No dialog to open via `reaper.OpenProject()`

## Project Directory Structure

```
main.lua
backend/   util, filesystem, json, library, song_manager, audio_import
models/    song, setlist
builders/  region_builder, cue_builder, show_builder
gui/       app, library_panel, setlist_panel, details_panel,
           add_song_dialog, remove_song_dialog (toolbar, theme — stubs)
tools/     add_song, remove_song
data/      setlists/, cache/
runner/    runner, transport (stubs — Phase 5)
```

## Key Decisions

- App.require() over Lua require() — custom path, caching, error handling
- Song IDs are permanent slugs, never titles
- ~/ReaperSongs/ as library root (separate from script)
- ~/ReaperTemplates/MasterRig.rpp as template (must be created by user)
- ~/ReaperShows/<Name>/ for generated show projects
- RPP text manipulation over API calls for show building (deterministic, no async)
- RegionBuilder is pure computation (testable without REAPER)
- 4/4 time assumed for duration calculation
- Cues track items reference external .mid files (not embedded)

## Next Phase — Phase 5: Live Runner

Stubs ready: `runner/runner.lua`, `runner/transport.lua`, `gui/toolbar.lua`, `gui/theme.lua`, `backend/metadata.lua`

Goal: performance interface during a live show — current/next song display, region tracking, transport controls, MIDI control input, notes display, emergency controls.

## Gotchas

- Cues track currently has no GUID (REAPER auto-generates on first load/save)
- No GUID generation for builder-created items (uses REAPER defaults)
- Angle-bracket depth parsing in `insertIntoRPP` assumes strings don't contain `<` or `>` (safe for standard RPP)
- Template must exist or build returns error string
- 4 test songs in ~/ReaperSongs/ — Summer of 69 is fully valid, others have missing/invalid meta.json
- `duration_bars` from meta.json (128 for Summer of 69 → ~3:41 at 139 BPM)
- Always pass song IDs, never titles, as setlist entries
