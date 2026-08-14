# Live Show Manager — BUILD_LOG

# ═══════════════════════════════════════════════════════════
# SESSION HANDOFF — 2026-08-08 (night) — READ THIS FIRST
# ═══════════════════════════════════════════════════════════
# ⚠️  CRITICAL: This session must be resumed by an IMAGE-CAPABLE model.
#     The core unfinished work is RENDERING/VISUAL issues on the stage HUD
#     (`live-stage-hud/web/public/hud.html`). The next model MUST take
#     screenshots (Puppeteer → PNG) and LOOK at them; text-only DOM inspection
#     is insufficient to fix the remaining visual problems.

## THE ONE TRUE ARCHITECTURE (this got "lost" repeatedly — internalize it)

- **REAPER** (`~/Library/Application Support/REAPER/Scripts/Live Show Manager/`):
  is ONLY a guitar FX chain (one delay that needs BPM). We never touch its
  transport. The Lua runner is a passive observer: reads position, pushes BPM
  to REAPER for delay sync, tracks its OWN clock for the HUD.
- **Akai Force** = master click + transport. NOT integrated yet (future work).
- **Live Show Manager server** (`web/server.js`, port **`:3000`**): the show
  brain. localPlay engine, control plane (ARM/PLAY/STOP), count-in, lyric
  timing. Started via launchd (`web/control.sh`).
- **Singer server** (`~/Music/iPhoneLiveServer/server/index.js`, port **`:3300`**):
  TUI + singer queue + band set. TUI = `scripts/tui.js`.
- **Stage HUD + phone controller** (`~/Documents/projects/live-stage-hud/web/public/`):
  hud.html/css/js + controller.js. NOTE: hud.html/css/js are SYMLINKED into
  the :3000 public dir — edit in live-stage-hud, the :3000 server serves them.
- **Song data**: `~/ReaperSongs/<Song>/{meta.json,song.chopro}`. `@time=N`
  (seconds) is the LRCLIB ground-truth lyric timing.

## SHOW FLOW (final, verified)
1. Song ends → server loads NEXT song's lyrics (teleprompter shows it) but does
   NOT start it; BPM stays at previous tempo.
2. PLAY/NEXT → server switches to the loaded song's BPM, starts a **count-in**
   (4→3→2→1 at song BPM, position held at 0 during count-in).
3. Song begins → position clock advances, lyrics scroll, click at song tempo.

## WHAT WORKS (proven by tests + headless runs)
- `npm test` in `web/`: **27/27 pass** (transport + control-plane integration + browser)
- `node tools/prove-it.js`: ~75 checks (servers, ARM, PLAY, STOP, clock accuracy,
  next/prev, tempo changes, stress, debug endpoint)
- `node tools/test-show-ready.js`: 39 checks (SHOW READY exit 0)
- Count-in: fires from ALL paths now (controlPlay + start_song socket action),
  position held at 0 during count-in (verified via puppeteer)
- Metadata 3x (SONG/KEY/BPM=60px, NEXT=30px @1080p)
- Chords render clean (no brackets) colored per-root (circle mode) — after
  fixing config that was `chord_color_mode: flavor` (all yellow → looked gone)
- Sync warning in-flow (no header overlap), only for serious issues
- Heartbeat/SIGNAL-LOST gone (keepalive broadcast every 3s)
- Duration correct via `lrc_duration_sec` (191s not 1102s)
- Beat transitions 0.25s CSS

## STILL BROKEN / RENDERING (THE ACTUAL REMAINING WORK — needs IMAGE EYES)
Verified DOM-level that the HUD html for the four noticed items was improved
(C1 timeline 95%→32%, sync warn moved, count-in present, ring removed), but the
USER reports the SCREEN still looks wrong. **Take a screenshot of hud.html
while playing a song and LOOK at it.** Suspects:
1. **Section bar / timeline** (`#hudSections` + `.timeline-block`): user said
   earlier "C1 shows 95% of the song" and it "stays around 5% filled the whole
   song". DOM shows `[V1]:1px [V2]:1px [C1]:<mx>px`. Section data comes from
   `web/server.js computeSections()` — meta.lyrics is sparse (≤2 entries) on
   many songs → `sectionsFromChordpro()` distributes wrong. Needs visual verify.
2. **Layout/overlap**: the earlier screenshot showed the SYNC banner overlapping
   song metadata + bar widget. We changed it to in-flow, but the metadata is now
   3x huge — RE-VERIFY nothing overlaps at 1080p (especially with long song names).
3. **Count-in** must be VISUALLY confirmed as an overlay on the real display.
4. Full-screen look: battery of everything at once — header, sections strip,
   lyrics engine, footer (time row) — no clipping/overlap/blank spots.

## DEBUG DASHBOARD (open during any live test)
`http://localhost:3000/debug.html` — shows Bridge / Singer / TUI side by side
with cross-system mismatch checks. TUI posts its state every render.

## HOW TO SCREENSHOT THE HUD (image-capable model MUST do this)
Use Puppeteer (headless) to PNG the HUD while the local engine is playing:
```js
// in web/: node -e "..." (puppeteer already a dependency)
const puppeteer = require('puppeteer');
(async()=>{
  const b=await puppeteer.launch({headless:true});
  const p=await b.newPage();
  await p.setViewport({width:1920,height:1080});
  await p.goto('http://localhost:3000/hud.html',{waitUntil:'networkidle0'});
  // arm+play first so lyrics/beats are active
  await fetch('http://localhost:3000/api/control/arm',{method:'POST',headers:{'content-type':'application/json'},body:'{\"armed\":true}'});
  await fetch('http://localhost:3000/api/control/play',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  await new Promise(r=>setTimeout(r,5000));
  await p.screenshot({path:'/tmp/hud-live.png'});
  await b.close();
})();
```

## LIVE STATE RIGHT NOW (for resume)
- :3000 bridge running (launchd). :3300 singer running. TUI running in a
  Terminal.app window (PID listed in ps; needs a REAL terminal, can't be spawned
  headlessly — `script`/PTY tricks fail on `stdin.isTTY`).
- Bridge: song=After Midnight, armed=true, playing=false, pos=0, bpm=131.6.
- Singer: A Boy Named Sue, status=playing (slightly stale vs bridge — normal
  until ARM re-syncs).
- debug.html checks show a WARN about After Midnight lyric timing estimated /
  last lyric 102s < 194s region — known song-data issue, not a code bug.
- Leftover `data/control_command.json` (`{"cmd":"stage","dir":1}`) exists —
  harmless unless runner connects.

## GIT (both repos pushed to GitHub `main` as of this session)
- `PlaceholderDuo/live-show-manager` (server/runner/tests)
- `PlaceholderDuo/live-stage-hud` (HUD phone)

## TASKS THIS SESSION (proven + committed)
- Decoupled REAPER: runner is passive observer (no Main_OnCommand)
- Null-coalescing fix, singer ARM sync, TUI debug state endpoint
- Count-in generation + HUD local 50ms countdown clock
- Timing parser uses lrc_duration_sec; sections use real @bar
- Metadata 3x, chords clean (no brackets) + circle colors, countdown ring removed
- Extended test harness (integration, prove-it, test-show-ready)
- Fixed song-change stale-lyrics (wrong songId refetch + currentSongId reset)
- start_song socket action now routes through controlPlay (count-in)

## NEXT SESSION TODO (in priority order)
1. **SCREENSHOT the HUD while playing. LOOK at it.** Fix remaining visual/
   layout issues (section timeline proportions, any overlap at 3x metadata,
   count-in overlay appearance).
2. If section pills still wrong, improve section detection to use real @bar
   positions across ALL songs (many have sparse meta.lyrics).
3. Consider `chord_color_mode` default → keep `circle` (user prefers distinct
   chord colors).
4. Optional future: Akai Force integration (MIDI clock) for click/transport.
5. Re-run `npm test`, `prove-it`, `test-show-ready` after any change.

# ═══════════════════════════════════════════════════════════
# (older entries below)
# ═══════════════════════════════════════════════════════════

## 2026-08-08: Architecture Reset — REAPER is a guitar processor, not the clock

### Summary

Major architecture correction: REAPER is a guitar signal chain with a single delay FX that needs BPM sync. We do NOT control REAPER's transport — no play, stop, seek, or record from our code. The runner is now a passive observer that pushes BPM to REAPER (for delay sync) and tracks its own position for the HUD. The Akai Force is the master click + transport. We also built a comprehensive self-testing harness (`test-show-ready.js`) and a three-system debug dashboard (`debug.html`).

---

### Key Architecture Decision

| Before | After |
|--------|-------|
| Runner called `Main_OnCommand(40044)` to start REAPER transport | Runner sets `playing=true` on its own wall-clock |
| Runner called `Main_OnCommand(40045)` to stop REAPER transport | Runner sets `playing=false`, stages next song |
| Runner called `_seekTo()` to move REAPER play cursor | No seeking — position tracked independently |
| `_haltTransport()` stopped REAPER at launch | Removed entirely — REAPER runs freely |
| `_loop()` derived playing state from `GetPlayStateEx` | `_loop()` uses our clock when playing, passive read when stopped |
| `_cmdPlay()` included count-in pre-roll + transport start | `_cmdPlay()` sets `self.playing=true`, starts `_playStartTime` |
| Count-in/click from REAPER | Count-in/click from Akai Force (separate system) |

**What we KEPT:** `_setSongBpm()` and `_setSongTimeSig()` — these push BPM + meter to REAPER so the delay FX is tempo-synced. These are SAFE (guarded by `bpm_verified` and `_hasTempoSyncedItems()`).

### Runner Changes — `runner/runner.lua`

- **Removed:** `_haltTransport()` function (deleted), `_seekTo()` function (deleted)
- **Rewrote `_cmdPlay()`:** Sets `self.playing=true`, `self.position=0`, `self._playStartTime=time_precise()`. Pushes BPM. No count-in, no transport start, no `Main_OnCommand`.
- **Rewrote `_cmdStop()`:** Sets `self.playing=false`, `self.position=0`, stages next song. No `Main_OnCommand`.
- **Rewrote `_loop()`:** When playing, position = `elapsed` seconds from `_playStartTime`. When stopped, passively reads `reaper.GetPlayPosition()`. Song lookup uses `stagedIndex` when playing, `lookupByPosition` when stopped.
- **Cleaned `start()`:** No transport halt. Just initializes state.

**To deploy:** Reload `main.lua` in REAPER (Actions → Load ReaScript).

### Server Changes — `web/server.js`

- **Fixed null coalescing:** `state.currentSong` changed from `||` to explicit `!== undefined` check so `null` from bridge clears stale titles (was the "songIndex=0 but currentSong=Dock of the Bay" bug).
- **Added singer sync on ARM:** `syncBandSetToSinger()` clears singer's band_queue and adds all songs from active setlist. Called by `controlArm(true)`.
- **Added TUI debug endpoint:** `POST /api/debug/tui-state` receives TUI internal state every render.
- **Added TUI to debug snapshot:** `/api/debug/snapshot` now includes TUI state + cross-system checks (TUI-vs-Bridge song mismatch, TUI-vs-Bridge playing drift, TUI-vs-Singer queue mismatch).
- **Isolated test env:** `SESSION_SETLIST_PATH` respects env var override so tests don't corrupt live setlist.

### TUI Changes — `scripts/tui.js`

- **Space key fix:** Uses `reaperState.playing` as authority when bridge is connected (was `queueState.status` from singer). When bridge connected, REAPER's playing state drives stop/play. When disconnected, falls back to singer queue.
- **Next/Prev in band set:** When `queueView !== 'singers'`, `n`/`b` keys now promote the next band_queue song, load it, and push setlist to bridge. Previously always advanced singer rotation.
- **Debug state posting:** `postDebugState()` called after every render cycle — POSTs `focus`, `queueView`, `reaperState`, `queueState`, `band_queue` to `:3000/api/debug/tui-state`.

### Debug Dashboard — `web/public/debug.html`

Complete rewrite. Three-column layout showing:
1. **TRANSPORT** — Bridge / Singer / TUI song titles side-by-side with red mismatch highlighting
2. **TUI STATE** — Focus, queueView, showMode, band_queue contents, internal status
3. **LYRIC WINDOW** — Current lyric line + next lines + progress bar
4. **SONG INTEGRITY** — Region vs audio vs lyric duration comparison
5. **CHECKS** — Auto-generated cross-system consistency checks

Open `http://localhost:3000/debug.html` to see all three systems' perspective simultaneously.

### Self-Test Harness — `web/tools/test-show-ready.js`

NEW: Full show-readiness self-test. Zero REAPER dependency. 13 phases, 39 checks:
1. Server startup + setlist load
2. Initial state (not armed, not playing)
3. ARM (sets armed, doesn't start playback)
4. PLAY starts position tracking
5. Clock accuracy (~1s per wall-clock second)
6. STOP resets position, stages next song
7. Re-PLAY from stopped state
8. PLAY gating (disarmed, already-playing)
9. Next/Prev navigation through setlist
10. BPM changes per song
11. Duration from lyric timing
12. Lyric sync health (% annotated)
13. Stress test (rapid ARM/PLAY/STOP/PLAY)

Run: `npm run test:show-ready` or `node tools/test-show-ready.js`
Exit code 0 = SHOW READY.

### Test Suite Updates

- **`npm test`** now runs 27 tests (was 13): 9 transport + 14 integration + 4 browser
- **`npm run test:show-ready`** — standalone 39-check lifecycle test
- `spawn-server.js` now isolates `SESSION_SETLIST_PATH` to temp dir
- Integration tests cover: setlist load, ARM, PLAY gating, STOP, end-of-set cleanup, null coalescing, region progression

### Live State After Restart

Server restarted via launchd. Bridge has 4-song setlist: Don't Let Me Down, Dock of the Bay, After Midnight, A Boy Named Sue. TUI needs restart to load new code (`stop show` → `start show`).

### Next Steps

1. **Restart TUI:** `stop show` then `start show` to load new space-key and next/prev code
2. **Reload main.lua in REAPER:** Runner no longer touches REAPER transport
3. **Run `npm run test:show-ready`** before any show to verify system health
4. **Open `debug.html`** during rehearsals to catch cross-system mismatches
5. **Force integration:** Accept MIDI clock or OSC from Force to sync our BPM/position

### Files Touched

```
runner/runner.lua              — Removed _haltTransport, _seekTo. Rewrote _cmdPlay,
                                  _cmdStop, _loop, start(). BPM push kept.
web/server.js                  — Null coalescing fix, singer ARM sync, TUI debug
                                  endpoint + snapshot, SESSION_SETLIST_PATH env override
web/public/debug.html          — COMPLETE REWRITE: 3-system dashboard
web/tools/test-show-ready.js   — NEW: 39-check show-readiness self-test
web/tests/lib/spawn-server.js  — Setlist path isolation (SESSION_SETLIST_PATH env var)
web/tests/integration.test.js  — NEW: 14 control-plane integration tests
web/package.json               — Added test:show-ready script
scripts/tui.js                 — Space key fix, next/prev band set, debug state posting
BUILD_LOG.md                   — This entry
```

### Summary

Three major fronts advanced: (1) discovered that Official/Pro UG tabs ship Guitar Pro 7 files with a full `score.gpif` XML containing named chord definitions, lyrics, and beat-level chord mappings — unlocking all 179 previously-unimportable tabs; (2) fixed the missing `meterRow` DOM element in the HUD; (3) backfilled `ug_tab_id` for 34 more songs.

---

### 1. Official/Pro Tab Import Breakthrough

#### The Problem
179 of 223 saved UG tabs returned `"No content"` from the mobile API. These are **Official** or **Pro** tabs that don't have text-based chord/lyric content. The mobile API's `/tab/info` endpoint returns metadata (key, tuning, artist, song name) but an empty or missing `content` field for these tabs. Their type is `"Official"` or `"Pro"` in the API response.

#### Investigation Process
1. **Mobile API check** — Polled `/api/v1/tab/info?tab_id=2076711` (a Pink Floyd "Have A Cigar" Official tab). Confirmed: 200 OK, full metadata, no `content` field.

2. **Full response dump** — Discovered a `content_urls` object in the API response with four URLs:
   ```json
   {
     "source": "https://api.ultimate-guitar.com/api/v1/tab/download?tab_id=2076711&tab_access_type=public&key=c623bc43c6c2e461aa8ede9a30ceda19&ver=ver_test_1",
     "source_encoded": "https://api.ultimate-guitar.com/api/v1/tab/download/file?ssid=2076711&m=2&s=741ed5d562a9b3dc5d737bdeb5a13d51bee6b5ed",
     "gp": "https://s3w.ultimate-guitar.com/ug.shared.wasabi/storage/tab_pro/e/4/e4c8f2ac6ebf2a9a85b2dc8712dd81a4.json",
     "midi": "https://s3w.ultimate-guitar.com/ug.shared.wasabi/storage/tab_pro/e/4/e4c8f2ac6ebf2a9a85b2dc8712dd81a4.mid",
     "tux_guitar": "https://s3w.ultimate-guitar.com/ug.shared.wasabi/storage/tab_pro/e/4/e4c8f2ac6ebf2a9a85b2dc8712dd81a4.tg"
   }
   ```
   The `gp` key is a misnomer — it points to a `.json` file on UG's Wasabi CDN. The other URLs point to Guitar Pro download endpoints and alternative formats.

3. **`source` download attempt** — Fetched `/api/v1/tab/download?...&token=<bbsessionhash>` with full mobile API auth headers (X-UG-CLIENT-ID, X-UG-API-KEY, User-Agent: UGT_ANDROID/4.11.1). Returned **200 OK, 62KB binary**. Magic bytes: `PK` (ZIP file).

4. **`source_encoded` download attempt** — Different URL (with `m=2`, signed auth). Returned **62KB**, magic bytes `XTZ2` (TuxGuitar `.tg` format).

5. **`gp` Wasabi CDN** — Blocked by Cloudflare (403), even though the URL is publicly accessible from UG's own web player. Would need browser-context fetch or signed cookies.

6. **ZIP extraction** — `source` URL returns a standard ZIP containing:
   ```
   Content/
   Content/BinaryStylesheet     (binary layout hints)
   Content/LayoutConfiguration  (binary)
   Content/PartConfiguration    (binary)
   Content/Preferences.json     (tonality, tempo, view settings)
   Content/score.gpif           ⭐ THE GOLD — XML with full tab data
   VERSION                      (plaintext "7.0")
   ```

7. **`score.gpif` analysis** — GPIF = Guitar Pro Interchange Format. This is Guitar Pro 7's native XML format. Contains:
   - **`<Score>`** — Title, artist, subtitle
   - **`<MasterBar>`** (150 bars) — Key signature, time signature, tempo automations, bar-to-track mapping
   - **`<Track>`** (10 tracks) — Named instruments (Rhythm Guitar, Bass Guitar, Piano 1/2, Drums, etc.)
   - **`<Bar>`** — Per-track bar content with `<Voice>` → `<Beat>` → `<Note>` hierarchy
   - **`<Note>`** — Individual string/fret positions with bends, vibrato, slides, ties, hammer-ons
   - **`<Chord>`** (38 definitions) — Structured chord data with:
     - `KeyNote` (step + accidental) — root note, e.g. E, F#, G
     - `BassNote` (step + accidental) — bass note
     - `Degree` (interval + alteration) — e.g. Third+Major, Third+Minor, Fifth+Perfect
   - **`<Lyrics>`** — Multiple lyric blocks with:
     - `<Line>` → `<Text>` with CDATA containing syllabified lyrics
     - `<Offset>` — syllable position offset within the bar
   - **`@$Chords$@` track** — A special track that maps chord IDs to beats across the song
   - **`@$Strumming$@` track** — Strumming pattern hints

8. **Chord name derivation formula** (from `<Chord>` elements):
   - `KeyNote.step + KeyNote.accidental` = root (e.g. F + Sharp = F#)
   - `Degree.interval=Third alteration=Minor` → suffix `m`
   - `Degree.interval=Third alteration=Major` → no suffix
   - `Degree.interval=Fifth alteration=Diminished` → suffix `dim`
   - `Degree.interval=Fifth alteration=Augmented` → suffix `aug`
   - `Degree.interval=Seventh alteration=Minor` → suffix `7`
   - Result: `Em`, `F#m`, `G`, `C`, `D`, `F`, etc.

#### Impact
All 179 Official/Pro tabs can now be imported. The approach:
1. Detect empty `content` from `/tab/info` → check `content_urls.source`
2. Download ZIP via authenticated `/tab/download` API
3. Unzip and parse `Content/score.gpif` XML
4. Extract chord definitions, beat-to-chord mapping (from `@$Chords$@` track), and lyrics
5. Convert to ChordPro format: `[Chord]Lyric` lines with `{start_of_verse/chorus}` section directives derived from key changes and lyrical structure
6. Save song.chopro + meta.json as usual

#### Dependencies Added
- `guitarpro-parser` (npm) — Pure JS Guitar Pro parser. However, the library's `parseGpxFile()` doesn't support GP7 format (fails with "Bad GPX header"). We'll need to write a custom GPIF XML parser since the format is well-documented XML.

---

### 2. HUD Fixes & Polish

#### meterRow Missing DOM Element
- **Symptom**: `hud.js` line 47 references `document.getElementById("meterRow")`, and `updateMeters()` on socket `trackLevels` events tries to render into it — but the `<div id="meterRow">` didn't exist in `hud.html`.
- **Fix**: Added `<div id="meterRow" class="meter-row">` at line 73 of `hud.html`, between the main lyrics zone and the footer.
- **CSS added** to `hud.css`:
  ```css
  .meter-row      { display: flex; gap: 4px; padding: 2px 0; flex: 0 0 auto; }
  .meter-strip    { flex: 1; height: 5px; background: #1a1a1a; border-radius: 2px; overflow: hidden; }
  .meter-fill     { height: 100%; border-radius: 2px; transition: width 0.15s; background: #2ecc71; }
  .meter-fill.warn  { background: #f1c40f; }
  .meter-fill.clip  { background: #e74c3c; }
  ```
- **Verification**: `curl -s http://localhost:3000/hud.html | grep -c "meterRow"` → `1`. All endpoints return 200.

#### ug_tab_id Backfill
- **Problem**: Only 10/225 songs had `ug_tab_id` in their `meta.json`. The `saveSong()` function checked `meta.json` for an existing `ug_tab_id`, but when `choproPath` existed without `ug_tab_id`, it returned early without writing the ID.
- **Fix** in `tools/ug-import.js` `saveSong()`: When `choproPath` exists but `meta.json` lacks `ug_tab_id`, the function now reads the existing meta, adds `ug_tab_id` (and tuning/capo/difficulty if missing), and writes it back.
- **Result**: 44/225 songs now have `ug_tab_id`. The remaining 181 were imported from playlists (not My Tabs), so they don't appear in the 223-favorite ID list and can't be matched.

---

### 3. Songs Without ug_tab_id (181 songs)

These songs exist in the filesystem (imported via the old playlist-scraping path) but are NOT in the user's UG favorites list. The import script only knows about the 223 My Tabs IDs. To backfill these, we'd need to either:
- Match by song title/artist via UG search API (rate-limited, approximate matching)
- Accept the status quo — each import run costs ~200ms per unmatched song (the mobile API fetch returns "No content" or finds the choproPath exists)

Current behavior: songs without `ug_tab_id` get fetched by the mobile API loop, the API returns metadata but no content (or the `choproPath` check catches them), and the new backfill code writes `ug_tab_id` if the tab happens to be one of the 223 favorites. For non-favorites, they remain without an ID.

---

### 4. Architecture Decisions (V2 HUD)

| Decision | Rationale |
|----------|-----------|
| 3-line rolling engine over scrolling teleprompter | Eliminates viewport cutoff, scroll bugs, line height miscalculations |
| Yellow chords with brackets, not colored spans | Single high-vis color survives RGB stage wash; no rainbow |
| White conductor box with black glow on active beat | High contrast, instant visual click |
| Proportional Metro Map timeline | Pure peripheral "where am I in song" awareness |
| Heartbeat banner at 3.5s timeout | Detects stale state without false positives |
| Mobile API over Puppeteer scraping | 200ms vs 3-5s per tab; no Cloudflare; no headless browser complexity |
| `bbsessionhash` cookie as API token | No password needed; works with Apple SSO |

---

### 5. Files Touched

```
web/public/hud.html          — Added meterRow div
web/public/hud.css           — Added meter-row, meter-strip, meter-fill styles
web/public/hud.js            — No changes (just read for context)
web/tools/ug-import.js       — saveSong() backfill for ug_tab_id
web/package.json             — Added guitarpro-parser dependency
web/node_modules/guitarpro-parser/ — New dependency (not yet used)
```

### 6. Next Steps (Planned)

1. **OSC port 9000 fix** — Wrap `oscPort.open()` in try/catch to prevent crash when port is in use
2. **Section token fixes** — Manually fix `beds_are_burning` and `slow_dancing_in_a_burning_room` chopro/meta mismatches
3. **GPIF-to-ChordPro converter** — Build a converter for Official/Pro tabs:
   - Parse `Content/score.gpif` XML
   - Extract chord definitions (38 per song on average)
   - Map `@$Chords$@` track beat references to chord names
   - Align `<Lyrics><Text>` with chord changes
   - Output standard ChordPro format
   - Import all 179 Official tabs
4. **Section directive auto-upgrade** — Optionally convert `{start_of_verse: Intro}` → `{start_of_intro: Intro}` etc. across the library for correctness

---

## 2026-07-11 (Afternoon): GPX Format Fix, 30 More Songs, Teleprompter Test

### Summary

Completed the Official/Pro tab import by fixing a format detection gap (GPX/GP6 BCFZ files weren't handled), imported 30 more songs, and set up a live HUD simulator for teleprompter testing.

---

### 1. GPX (BCFZ) Format Discovery & Fix

#### The Problem
32 of 223 Official/Pro tabs still failed to import. The error was identical for all: `"Failed to extract score.gpif from ZIP: Command failed: unzip -p ... Content/score.gpif"`. The existing `loadGpif()` assumed all `.gp` files were ZIP archives (GP7 format), but that's only true for Guitar Pro 7 files.

#### Investigation
Checked the temp GP files from failed downloads:
- **30/32** were **GPX format** (Guitar Pro 6) — file header bytes `BCFZ` (0x4243465a), not ZIP's `PK` (0x504b)
- **2/32** were legacy binary formats: `219945` = GP4 (v4.06, "Little Liza Jane"), `2711814` = GP5 (v5.00, "Shape of My Heart")

The `BCFZ` format is a proprietary Guitar Pro 6 compressed container, not a standard ZIP. The `guitarpro-parser` npm library (already a dependency) had a `decodeGpxBinary()` function that handles BCFZ decompression, but it wasn't exported. The library's `parseGpxFile()` DID parse these files successfully — but it returned structured track/beat/note data without **chord names** (only fret positions), making it unusable for ChordPro generation.

#### Solution: BCFZ Decompressor in gpif-to-chopro.js
Ported the BCFZ decompression algorithm from `guitarpro-parser` (`BinaryReader`, `decompressBlock`, `parseBlockFilesystem`) directly into `tools/gpif-to-chopro.js`. The updated `loadGpif()` now:

1. Reads the file header bytes
2. If `BCFZ` or `BCFS` → decompresses using the GPX LZ77 algorithm, extracts `score.gpif` XML
3. If `PK` (ZIP) → falls through to existing `unzip -p Content/score.gpif` path (GP7)
4. Returns GPIF XML to our existing chord/lyric parser

This reuses our own `<Chord>` element parser (which extracts named chords like "Em", "C", "G" from KeyNote+Degree attributes) — the same parser already proven on GP7 files.

#### Result
**30/32 failed tabs now parse correctly.** Verified all 30 BCFZ files:
```
2421543: OK "Gimme Shelter" — 3 chords, 42 lines
2440353: OK "Honky Tonk Women" — 4 chords, 24 lines
... (30 passed, 2 failed — GP4/GP5 binary format)
```

### 2. Import Retry — 30 New Songs

Ran the import with `--ids` flag for all 32 failed IDs:
```
Done. 30 imported, 2 failed.
```

The 2 remaining failures are the GP4/GP5 edge cases:
- **"Little Liza Jane"** (tab 219945) — GP4 binary, likely lyrics-only tab
- **"Shape of My Heart"** (tab 2711814) — GP5 format, fails to parse

**Updated song count:**
| Metric | Before | After |
|--------|--------|-------|
| Total folders | 225 | 328 |
| With song.chopro | 225 | 327 |
| With ug_tab_id | 44 | 191 |
| Remaining failures | 179 | 2 |

### 3. Section Detection Improvements in gpif-to-chopro.js

The GPIF-to-ChordPro converter had a weak section detection algorithm — it only recognized explicit `[Verse]`, `[Chorus]` markers in the lyric text (which GPIF lyrics never have). All GP-converted songs showed as a single "Verse 1" section containing all lyrics.

**Updated algorithm** (`gpifToChopro` in `tools/gpif-to-chopro.js`):
1. Preserves blank-line-separated stanzas from GPIF CDATA lyrics
2. Groups lyric lines into stanzas at blank-line boundaries
3. Labels stanzas heuristically:
   - First stanza → Verse 1
   - Repeated stanzas (same first-20-chars + line count signature) → Chorus N
   - Last short stanza (1-2 lines) → Outro
   - Everything else → Verse N
4. Emits proper `{start_of_verse}` / `{end_of_chorus}` directives

Also fixed `parseLyrics()` to preserve blank lines (removed `.filter(Boolean)` that was dropping them).

### 4. Teleprompter Test Setup

Set up the server and a live simulation for teleprompter testing:

- **Server** running at `http://0.0.0.0:3000` on port 3000
- **HUD** at `http://localhost:3000/hud.html` or `http://RDFX1-macbook-pro.local:3000/hud.html`
- **State simulation** (`/tmp/hud-sim.js`) — Node.js script that writes `bridge_state.json` with advancing position, cycling through all 327 songs with realistic durations
- **Bonjour/mDNS** — Server registered as `RDFX1-macbook-pro.local`, reachable from any Mac on LAN without IP address lookup
- **No-cache headers** — All HTML/JS/CSS served with `Cache-Control: no-store, no-cache, must-revalidate` for live updates
- **Google Fonts** — Added Montserrat font loading in `<head>` (was missing — CSS referenced it but HTML never loaded it)

#### How to Test
1. Server is already running — `node server.js` on port 3000
2. Simulator is running — writes `bridge_state.json` every 500ms with advancing position
3. On teleprompter Mac: open `http://RDFX1-macbook-pro.local:3000/hud.html` in Safari
4. Press `Cmd+Shift+F` for fullscreen
5. HUD auto-updates as position advances through songs

### 5. Files Touched

```
web/tools/gpif-to-chopro.js   — Added BCFZ decompressor (BinaryReader, decompressBlock,
                                 parseBlockFilesystem, decodeGpxBinary), updated loadGpif()
                                 to heuristically detect BCFZ vs ZIP, improved section
                                 detection with stanza-based grouping
web/public/hud.html           — Added Google Fonts preconnect + Montserrat stylesheet link
temp/hud-sim.js               — New: Node.js teleprompter state simulator (writes bridge_state.json)
BUILD_LOG.md                  — This entry

### 6. Chords Not Rendering + Scroll Speed Fix

#### The Problem

After the initial innerHTML bugfix (loading bar destroying DOM children), the HUD showed lyrics but:
1. **No yellow chord brackets** — `[G]`, `[Am]`, `[D7]` never appeared, even though chords exist in the source ChordPro files
2. **Lyrics scrolled way too slow** — each line took ~5x its expected time to advance, making songs unreadable

#### Investigation

**Root cause of missing chords:** Two separate issues:

1. **Old UG import format** — Songs like "American Pie" use bare chord lines without brackets:
   ```
   G     D/F# Em        Am            C
   A long, long time ago, I can still remember
   ```
   The `parseLinePairs` function created ONE pair with the entire chord bar as a single word: `{word: "G     D/F# Em        Am            C", chord: ""}`. The `isChordOnlyLine` check only tested individual pair words against a chord regex — the full string has spaces so it never matched.

2. **Merge post-process overwrote inline brackets** — When pending chords from a bare chord line were distributed to the next lyric line, the merge replaced existing inline bracket chords (`[Em]How [D]that...`) instead of preserving them.

**Root cause of slow scroll:** `totalBars` in `computeSections` was computed as:
```js
const totalBars = Math.max(...lyrics.map(e => e.bar), 128) + 8;
```
For a 25-bar song with max lyric bar 9, this gave 136 bars — 5.4x the actual song duration (`duration_bars`). Each line's bar span was 5.4x too large, making the rolling engine advance 5.4x too slowly.

#### Fixes

1. **`parseLinePairs` bare chord detection** (`hud.js:110`):
   - When a line has no brackets, splits by whitespace and checks if ALL tokens are chord names (matched by a new `chordNameRe` regex: `/^[A-G][b#]?(?:m|dim|aug|sus[24]|add\d+|maj7|maj9|m6|m7|m9|7|9|11|13|6)*(?:\/[A-G][b#]?)?$/`)
   - If all tokens are chords, creates individual chord pairs: `[{chord:"G",word:""}, {chord:"D/F#",word:""}, ...]`
   - These pairs feed into the existing merge post-process which collects them as `pendingChords` and distributes to the next lyric line

2. **Merge overwrite fix** (`hud.js:213`):
   - Added `&& !lines[i].pairs[pi].chord` guard to prevent pending chords overwriting inline bracket chords

3. **`duration_bars` integration** (`server.js:374,431,652`):
   - Passed `meta.duration_bars` from the call site to `computeSections` and `sectionsFromChordpro`
   - Used `durationBars` as the primary `totalBars` value for proportional section bar distribution
   - This improved Metro Map timeline and section bar estimates but did NOT fix scroll speed

4. **Missing DOM refs** (`hud.js:48`):
   - Declared `hudNotes` and `notesTimeout` variables that were used but never declared, which would throw in strict mode if `showNotes()` was ever called
   - Same fix for `_debugEl` createElement

#### Result (verified via Puppeteer headless tests)

- Chords now render correctly for ALL song formats:
  - Songs with inline brackets (`[Em]How [D]that`): brackets preserved, yellow colored
  - Songs with bare chord lines (`G D/F# Em Am C`): chords distributed to next lyric line, shown as `[G]` before words
  - Songs with tablature (`e|------------------`): ignored (not chord names)
- DOM elements `linePast`, `linePresent`, `lineFuture` persist correctly
- **Scroll speed was NOT fixed by duration_bars** — still way too slow (see section 8 below)

### 7. HUD Window Scaling

#### The Problem

The HUD was designed for 1080p display but cut off at smaller browser windows. Fixed font sizes in `px` and `rem` (relative to root 16px) didn't scale to smaller viewports.

#### Fix

1. **CSS custom property** (`hud.css:18`):
   ```css
   html { font-size: calc(16px * var(--hud-scale, 1)); }
   ```
   All `rem`-based font sizes (chords 2.4rem, words 4.4rem, labels 1.25rem, etc.) scale automatically when `--hud-scale` changes.

2. **JS resize handler** (`hud.js:61-70`):
   ```js
   function fitHud() {
     var scale = Math.min(1, Math.max(0.35, window.innerHeight / 1080));
     document.documentElement.style.setProperty('--hud-scale', scale);
   }
   window.addEventListener('resize', fitHud);
   ```
   Linear scale from viewport height. Design target: 1080p = 1.0x. Clamped at 0.35x minimum for readability.

3. **Converted all px font sizes to rem** — `28px → 1.75rem`, `20px → 1.25rem`, `16px → 1rem`, etc.

#### Verification

Puppeteer headless tests at three viewports confirmed proportional scaling with no overflow:
| Viewport | Scale | Base font | Present word | Present chord |
|----------|-------|-----------|-------------|---------------|
| 1920×1080 | 1.0 | 16px | 70.4px | 38.4px |
| 1024×600 | 0.56 | 8.9px | 39.1px | 21.3px |
| 800×400 | 0.37 | 5.9px | 26.0px | 14.2px |

### 8. `@bar=N` Annotation Format & Bar-Accurate Line Advancement

#### The Problem

Even after the `duration_bars` fix, lyrics scrolled too slowly and without phrase awareness. GPIF bar counts include ALL master bars (empty bars, alternate endings, pickup bars across all tracks), making per-line spans unreasonably large. A 16-line section spanning 52 bars = 104 seconds at 120bpm. And the time-based uniform distribution had no awareness of song structure — solos, intros, interlocks consumed line screen-time while no singing occurred.

#### Re-orienting on the Build's Purpose

This is a **live stage monitor HUD for a band using IEMs with click tracks**. REAPER's bar position (`position × bpm / 240`) is the ground truth. Each lyric line must advance at the exact bar the singer sings it. Instrumental sections (solos, intros) must be handled differently — showing the chord grid for the correct number of bars.

The key insight: the system needs a **human-editable timecode format** embedded in the chordpro file itself. No external database, no GPIF dependency. The musician edits the chordpro file in any text editor to add/remove/modify timings.

#### The Fix: `@bar=N` + `@duration=N` Annotations

**1. `@bar=N` per-line annotation** (`hud.js:213-220`):
   ```chordpro
   @bar=1  A long, long time ago
   @bar=3  I can still remember
   @bar=9  How that music used to make me smile
   ```
   - `parseChordPro` strips `@bar=N` prefix from content lines and stores as `lines[i]._bar`
   - `renderRollingEngine` finds `currentIdx` by `lines[i]._bar <= bar`
   - Lines without `@bar=N` get uniform distribution within their section via `estimateLineBars`

**2. `@duration=N` section directive** (`hud.js:185-191`):
   ```chordpro
   {start_of_solo: Guitar Solo @duration=24}
   ```
   - Extracted from directive value, stripped from label text
   - Stored as `lines[i]._duration` for all content lines in that section
   - Solo sections with `@duration=N` show chord grid for N bars

**3. Solo protocol** (`hud.js:405-436`):
   - When `lines[currentIdx].type === "solo"`, HUD switches to chord grid mode
   - All chords from all lines in the solo section shown in tiled grid
   - Progress bar from 0% → 100% based on `(bar - soloStart) / duration`
   - Grid dismisses when bar exceeds solo start + duration
   - Legacy detection: chord-only lines (bare chord names) also trigger grid with 8-bar default

**4. `estimateLineBars` respects exact annotations** (`hud.js:247-290`):
   - Lines with `_bar !== null` use the exact value
   - Remaining un-annotated lines in each section distribute uniformly across that section's bar range
   - This allows mixed files: some annotated lines for critical cues, rest auto-distributed

#### Sync Accuracy Tiers

| Tier | Source | Accuracy | Coverage |
|------|--------|----------|----------|
| Exact | Manual `@bar=N` in chordpro | Perfect | User-edited songs |
| Estimated | Uniform within GPIF sections | Per-section approximation | 191 songs with ug_tab_id |
| Fallback | Uniform across entire song | Coarse | All 327 songs |

#### Verification

Puppeteer test with live simulator confirmed lines advance with bar position:
```
T=0 bar=8: "Another lesson 'bout a naive fool who came to baby"  [INTRO 1]
T=5 bar=10: "And found out that the pie don't taste so sweet"    [INTRO 1]
```
Lines advance at ~2 bars/line (~4s at 120bpm). Section labels display correctly from server sections.

### 9. 6-Line Rolling Display

#### The Problem

The original HUD showed 3 lines (past/present/future). The spec says 4-6 lines visible so the singer has more context — several past lines fading upward, present bold, and upcoming lines previewed.

#### Fixes

1. **DOM** (`hud.html:55-62`): Replaced 3-line engine with 6 elements: `linePast3`, `linePast2`, `linePast1`, `linePresent`, `lineFuture1`, `lineFuture2`. Referenced in JS as `lineEls` array.

2. **CSS opacity ladder** (`hud.css`):
   | Class | Opacity | Word size | Color | Chords |
   |-------|---------|-----------|-------|--------|
   | `.past-3` | 0.15 | 1.8rem | #444 | hidden |
   | `.past-2` | 0.25 | 2.2rem | #555 | hidden |
   | `.past-1` | 0.40 | 2.6rem | #777 | hidden |
   | `.present` | 1.00 | 4.4rem | #fff | shown |
   | `.future-1` | 0.65 | 3.6rem | #999 | dimmed |
   | `.future-2` | 0.35 | 2.8rem | #666 | hidden |

3. **Render** (`hud.js:438-464`): Builds `[current-3, -2, -1, 0, +1, +2]` → maps to CSS classes. Lines outside bounds show `…`.

#### Verification

Puppeteer test confirmed all 6 DOM elements exist with correct CSS classes:
```
past-3:   "And I'll always let hope in wherever I'll be"
past-2:   "And if I go blind, I'd still find my way"
past-1:   "I guess I just felt like giving up to-day"
present:  "Mmm, yeah, yeah"
future-1: …
future-2: …
```

### 10. LRC-to-`@bar=N` Bulk Import

#### The Problem

Zero of 327 songs had `@bar=N` annotations. The HUD used `estimateLineBars()` — uniform distribution of lines within each section's bar range. This got the right *section* at the right time, but line-to-line timing was a rough approximation. Guitar breaks and solos without `{start_of_solo}` directives were invisible — the rolling engine treated them as empty content frames.

#### The Fix: LRCLIB + Fuzzy Matching Pipeline

Built `web/tools/lrc-to-bars.js` — a Node.js script that:

1. **Queries LRCLIB** (`GET /api/get?artist_name=&track_name=`) — free, no API key, community-maintained time-synced lyrics database. 1.1s delay between requests to respect rate limits.

2. **Parses LRC timestamps** — `[MM:SS.TT]Lyric text` format, converts to seconds.

3. **Fuzzy-matches LRC lines to chordpro content lines** — strips `[Chord]` brackets, removes syllable-splitting hyphens ("Was- tin' time" → matches "wasting time"), normalized word overlap with substring fallback. Skips directives, bare chord lines, tuning/capo headers, and other non-lyric lines.

4. **Converts timestamps to bar numbers**: `bar = floor(time_s * bpm / (beatsPerBar * 60)) + 1` using each song's BPM and time signature from `meta.json`.

5. **Merges `@bar=N`** into `song.chopro`, preserving existing `[Chord]` brackets and section directives.

#### Results

| Metric | Value |
|--------|-------|
| Total folders | 328 |
| Freshly annotated | 255 |
| Already had @bar=N | 6 |
| No LRCLIB entry (duplicate/cleaned folders) | 48 |
| No synced lyrics available | 7 |
| Errors/other | 12 |
| **Usable songs with @bar=N** | **261** |
| Avg match rate per song | 85-95% of lyric content lines |

The 48 "no entry" songs are mostly duplicate folders with uncleaned names (e.g. `OFFICIAL ALL MY EXS LIVE IN TEXAS TABS` vs cleaned `All My Exs Live in Texas` which was annotated). Failed matches are syllable-fragment edge cases; those lines fall back to `estimateLineBars()`.

**Sync accuracy tiers (after LRC import):**

| Tier | Count | Source |
|------|-------|--------|
| Exact | 261 songs | LRC timecoded lyrics via LRCLIB |
| Estimated | ~55 songs | Uniform within sections (duplicates, no LRCLIB data) |
| Fallback | ~12 songs | Uniform across song (no sections in meta) |

#### Per-line Opacity Bump

Also raised past/future line colors and opacities for readability when singer is ahead/behind:

| State | Before | After |
|-------|--------|-------|
| past-3 | #444 @ 0.15 | #888 @ 0.40 |
| past-2 | #555 @ 0.25 | #aaa @ 0.55 |
| past-1 | #777 @ 0.40 | #ccc @ 0.70 |
| future-1 | #999 @ 0.65 | #ddd @ 0.80 |
| future-2 | #666 @ 0.35 | #bbb @ 0.60 |

Present (white @ 1.0) and harmony (#ffeb3b) unchanged. Chords still hidden on past-3/2 and future-2.

### 11. Phone Controller Mini Teleprompter & "Ready for Tonight"

#### The Problem

The phone controller (`index.html`) had no visibility into current lyric position — the show runner couldn't see where the song was lyrically without looking at the stage HUD. Other band members needed a way to see the synced teleprompter on their personal phones when far from the main screen.

#### The Fix

**Server-side: `extractLyricLines(choproText)`** (`server.js:263-315`):
- Parses chordpro text on song change, same data source as the HUD
- Extracts `@bar=N` annotations, strips `[Chord]` brackets and directives
- Skips bare chord lines, metadata headers (tuning, capo, etc.)
- Tracks `inSolo` state from `{start_of_solo}`/`{end_of_solo}` directives
- Returns `[{ bar, text, type }]` — stored in `state.lyricLines` for broadcast

**Phone controller HTML** (`index.html:50-53`):
```html
<div id="miniTeleprompter" class="mini-tele">
  <div id="miniLyricCurrent"></div>
  <div id="miniLyricNext"></div>
</div>
```

**Phone controller CSS** (`style.css:149-172`):
- Green left border accent, dark card background
- Current line: 18px bold white
- Next line: 14px dimmed gray (70% opacity)
- Hidden entirely when no lyric data

**Phone controller JS** (`index.html:293-323`):
- `updateMiniTeleprompter(s)` called on every state update
- Computes line index from position/duration ratio
- Shows current + next line, solo lines get `#ffeb3b` Gold prefix "(solo)"

**Band-member teleprompter** — `hud.html` already works on phones:
- Viewport meta with `user-scalable=no`, `fitHud()` auto-scaling from 0.35x–1.0x
- Band members navigate to `http://<host>:3000/hud.html` → same synced view as stage display
- No special setup — just a URL opened in Safari

**Debug overlay removed** — `_debugEl` (green monospace div bottom-left) purged from `hud.js:804-808`

#### Ready-for-Tonight Checklist

| Check | Status |
|-------|--------|
| REAPER setlist → LAUNCH PERFORMANCE | Via ReaImGui GUI |
| Lua runner → bridge_state.json (200ms) | `runner/runner.lua` |
| Server polls bridge (500ms) → WebSocket broadcast | `server.js:677` |
| Phone controller receives state → transport + progress | `index.html` Show tab |
| Phone mini teleprompter shows current lyric | New — `updateMiniTeleprompter()` |
| HUD fetches chordpro → 6-line rolling engine | `hud.js` with `@bar=N` sync |
| Band-member phones → `/hud.html` | URL-accessible, auto-scaling |
| Transport control (play/stop/next/prev/panic) | WebSocket → OSC → REAPER |
| 261/328 songs with exact `@bar=N` timing | LRCLIB import via `lrc-to-bars.js` |

## Files Touched

```
web/tools/lrc-to-bars.js       — New: LRCLIB fetch, LRC parser, fuzzy matcher,
                                  time→bar conversion, @bar=N merge into song.chopro.
                                  Supports --all, --song, and interactive modes.
web/server.js                  — extractLyricLines() function, included in state
                                  broadcast on song change
web/public/hud.js              — Removed debug overlay (_debugEl:804-808)
web/public/hud.css             — Past/future line opacities and colors bumped
web/public/index.html          — Mini teleprompter HTML + updateMiniTeleprompter() JS
web/public/style.css           — Mini teleprompter CSS (.mini-tele, #miniLyricCurrent/Next)
BUILD_LOG.md                   — This entry
```

## 2026-07-11 (Night): TUI, Cloudflare Tunnel, GitHub Pages Redirect

### Summary

Built the Show Manager TUI (`live-stage-hud/tui/showman.js`) to manage the entire live show from one terminal. Set up Cloudflare Tunnel for public access, a permanent QR code via GitHub Pages redirect, and the `live-stage-hud` project as a standalone guest-facing server (port 5800).

### Architecture

```
Terminal TUI (showman.js)
    │
    ├── Starts/stops Cloudflare Tunnel → exposes port 3000 publicly
    ├── Generates QR codes → web/public/assets/
    ├── Updates gh-pages/tunnel-url.txt
    └── Git push → GitHub Pages

Cloudflare Tunnel (port 3000)
    │
    └── https://<random>.trycloudflare.com
         ├── /hud.html     — Guest singer synced HUD
         ├── /qr.html      — QR code display card
         └── /             — iPhone controller

GitHub Pages (permanent)
    │
    └── https://PlaceholderDuo.github.io/live-hud/guest.html
         Reads tunnel-url.txt → redirects to current tunnel HUD
```

### TUI Commands

| Key | Action |
|-----|--------|
| `1` | Start Cloudflare Tunnel |
| `2` | Stop Tunnel |
| `q` | Regenerate QR code |
| `p` | Push URL to GitHub Pages |
| `r` | Refresh status |
| `0` | Exit (stops tunnel) |

Permanent QR code (print once): `https://PlaceholderDuo.github.io/live-hud/guest.html`

### Files Created (in live-stage-hud/)

```
tui/showman.js              — Show Manager TUI
tunnel.sh                   — CLI tunnel launcher with QR regeneration
setup-gh-pages.sh           — One-time GitHub Pages setup
gh-pages/guest.html         — Redirect page (reads tunnel-url.txt)
gh-pages/tunnel-url.txt     — Current tunnel URL (TUI updates this)
web/public/qr.html          — QR code display card
web/public/hud.html/css/js  — Copied from LSM project
web/public/assets/qr-hud.png — Current QR (temporary tunnel URL)
web/public/assets/qr-permanent.png — Permanent QR (GitHub Pages)
```

### One-Time Setup Remaining

1. Create `PlaceholderDuo/live-hud` repo on GitHub (public)
2. `git push -u origin main`
3. Enable GitHub Pages: Settings → Pages → Source: Deploy from a branch → main / gh-pages
4. Print `qr-permanent.png` — this QR works forever

---

## 2026-07-30: Song Metadata Repair (BPM + Key + Naming + Dedup)

### Summary

Executed a comprehensive metadata repair pass across all 323 songs in `~/ReaperSongs/`. Key completion, folder name standardization, duplicate archival, BPM extraction from GPIF, and `@time` annotation re-computation.

---

### 1. Key Completion (fix-metadata.js)

**Built:** `web/tools/fix-metadata.js` — multi-source key resolver:
- **Source 1**: `data/key-fallback.json` (74 manual entries)
- **Source 2**: `song.chopro` `{key: X}` directive
- **Source 3**: Chord frequency analysis (most common root = likely key)
- **Source 4**: Spotify API framework (ready when credentials available)

**Result:** 100% key coverage (0 songs with empty key, up from ~300). 70 keys from fallback, 23 from chord detection. All songs have `key_source` field tracking provenance.

---

### 2. Folder Name Standardization (rename-songs.js)

**Built:** `web/tools/rename-songs.js` — converts slug-named (`aint_no_sunshine`) and ALL_CAPS folders to Title Case. Handles contractions (`dont` → `Don't`, `aint` → `Ain't`). Small words lowercased, first/last word capitalized.

**Result:** 15 folders renamed. 12 slug-named → Title Case. 3 ALL_CAPS → Title Case (where no Title Case version existed).

---

### 3. Song Deduplication (dedupe-songs.js — modified)

**Modified:** `web/tools/dedupe-songs.js` — changed behavior from `fs.rmSync` (permanent delete) to `fs.renameSync` → `_duplicates/` (safe archive). Three phases: OFFICIAL/TABS/CHORDS variant scoring, slug-named resolution, remaining name standardization.

**Result:** 49 duplicates archived to `_duplicates/`. 1 slug renamed. Song library reduced from 323 to 271 active folders.

---

### 4. BPM Extraction from GPIF (fix-bpm-gp.js)

**The Bug:** `ug-import.js` line 288 hardcodes `bpm: 120` in `buildMeta()`, even though `gpifToChopro()` already extracts the real BPM from the Guitar Pro GPIF XML. The `bpm` field in the `gpifToChopro()` return value was simply never passed through to `meta.json`. All 191 UG-imported songs shipped with BPM=120 regardless of real tempo.

**Why it matters:** For a 94 BPM song, the BPM=120 default causes:
- `@time` values drift 28% by end of song
- HUD shows lyrics 10–24 seconds early for a typical song
- Section pills advance at wrong times
- Countdown ring shows wrong remaining time

**Built:** `web/tools/fix-bpm-gp.js` — integrated browser-based UG authentication (Puppeteer + Stealth), GPIF re-download, BPM extraction, and `meta.json` update.

Flow:
1. Opens Chrome window → user logs into Ultimate Guitar
2. Auto-detects login (polls cookies + page content, no terminal command needed)
3. Saves session cookie for reuse
4. For each of 181 songs with `ug_tab_id`:
   - Fetches `/tab/info` → gets `content_urls.source`
   - Downloads GP file (ZIP for GP7, BCFZ for GP6)
   - Extracts `Content/score.gpif` → parses `<Automation><Type>Tempo</Type><Value>N</Value>`
   - Writes BPM to `meta.json` with `bpm_source: "gpif"`
   - 800ms delay between requests (UG rate limit)

**Result:** 181 songs get real BPMs from Guitar Pro files. Library goes from ~256 with BPM=120 to ~75 (remaining are non-UG songs without gpif source).

---

### 5. @time Re-computation (migrate-to-atime.js — modified)

**Modified:** Added `--force` flag to `migrate-to-atime.js` that re-computes `@time=N` even when it already exists. This is necessary because the initial migration computed `@time` using the wrong BPM=120. With corrected BPMs from step 4, `--force` produces accurate `@time` values.

Formula: `time = (bar - 1) * 4 * 60 / correct_bpm`

**Result:** 253 songs re-migrated with corrected BPMs. 22 skipped (no `@bar=N` annotations in chopro).

---

### 6. Final State

| Metric | Before | After |
|--------|--------|-------|
| Total songs | 323 | **271** |
| Empty key | ~300 | **0 (100%)** |
| BPM=120 songs | ~300 | **~75** |
| BPM from GPIF | 0 | **181** |
| Slug-named folders | 12 | **0** |
| OFFICIAL/TABS/(ver N) | ~50 | **0** |
| Duplicates archived | 0 | **56** to `_duplicates/` |
| @time=N annotated | 0 | **253** |

### Files Created/Modified

```
web/tools/fix-metadata.js      — NEW: Multi-source key + BPM resolver (Spotify-ready)
web/tools/rename-songs.js       — NEW: Slug-to-Title Case converter
web/tools/fix-bpm-gp.js         — NEW: GPIF BPM extractor with browser auth
web/tools/dedupe-songs.js       — MOD: Archive to _duplicates/ instead of delete
web/tools/migrate-to-atime.js   — MOD: Added --force flag for re-computation
BUILD_LOG.md                    — This entry
```

### Why GPIF BPM and not Spotify/LRCLIB/Tunebat

All attempted BPM sources hit walls:
- **Spotify Web API**: Requires Premium subscription (not free tier)
- **Tunebat / Getsongbpm / Songbpm**: All behind Cloudflare bot protection — curl, Puppeteer+Stealth all blocked
- **LRCLIB**: Down/unreachable, and doesn't include BPM anyway
- **Deezer API**: Returns `bpm: null` for all tracks
- **Last.fm API**: Slow/timeout

The GPIF approach was the only viable path — the BPM data was already in the files we downloaded, just never saved. The `fix-bpm-gp.js` script closes the gap.

---

## 2026-07-30 (Evening): Audio Download Pipeline + Aubio BPM Detection

### Summary

Built a full audio pipeline that downloads 249 songs from YouTube, downsamples them (mono 22kHz 48kbps), and extracts BPM from the audio using aubio beat tracking. This fills the BPM gap for songs that couldn't get BPM from GPIF (regular UG text tabs).

### Pipeline: `tools/audio-pipeline.py`

**Output:** `~/Music/SongAudio/<Song Name>/`
- `full.mp3` — downsampled full song (mono 22kHz 48kbps, ~1.3MB per song)
- `stems/` — (future) demucs stem separation output

**Flow per song:**
1. Search YouTube via yt-dlp (`artist title official audio`)
2. Download best audio (m4a/webm)
3. ffmpeg downsample → `full.mp3` (matching `audio_import.lua` spec: `-ac 1 -ar 22050 -b:a 48k`)
4. aubio beat tracking → BPM + confidence score
5. Write BPM to `meta.json` with `bpm_source: "aubio"` + `bpm_confidence`
6. Skip songs already at `full.mp3` (idempotent)
7. Support for existing ReaperSongs audio files (import + downsample)

**Confidence gating:** Minimum 0.3 confidence for aubio BPM. Lower confidence results are discarded to avoid bad data.

### Final BPM State

| Source | Count | Accuracy |
|--------|-------|----------|
| GPIF (UG Official/Pro tabs) | 133 | Exact (Guitar Pro tempo automation) |
| Aubio (audio beat tracking) | 100 | ±3-8 BPM (onset detection) |
| Existing (slug-named songs) | 15 | Manual/existing |
| Still BPM=120 | 23 | Failed download or low confidence |
| **Real BPM coverage** | **248/271 (92%)** | |

### Storage

| Artifact | Per Song | Total |
|----------|----------|-------|
| Full song (downsampled) | ~1.3 MB | **365 MB** (249 songs) |
| Full stems (4, downsampled) | ~5.0 MB | ~1.4 GB (estimated, not yet built) |
| Combined (songs + stems) | ~6.3 MB | ~1.7 GB |

### Demucs Status

`demucs` + PyTorch installed and tested. Stem separation not yet run (takes ~30-60s per song). Pipeline has `--stems` flag ready. Will produce:
- `stems/vocals.mp3`
- `stems/drums.mp3` 
- `stems/bass.mp3`
- `stems/other.mp3`

All downsampled to same mono 22kHz 48kbps format.

### Files Created/Modified

```
web/tools/audio-pipeline.py    — NEW: Full audio download + downsample + BPM pipeline
BUILD_LOG.md                   — This entry
~/Music/SongAudio/             — 249 song audio folders (365 MB)
```

---

## 2026-07-31: Overnight Pipeline, Whisper Sync, Song Import & TUI

### Summary

Ran a comprehensive overnight pipeline processing all 271 songs through demucs stems, aubio BPM detection, and Whisper-based lyric sync. Built a song import system, UG playlist automation, and a full terminal UI for library management. Completed the Eagles 15-song import workflow end-to-end.

---

### 1. Overnight Pipeline Results

**Script:** `~/Music/SongAudio/overnight.sh` — unattended 14-hour run (10:41 PM → 12:53 PM)

| Phase | What | Result |
|-------|------|--------|
| 1 | Audio download + Demucs stems (all songs, full CPU) | 270/271 stems created |
| 2 | Aubio BPM detection | 100% real BPM coverage |
| 3 | Whisper lyric sync (base model) | Tested on 10 songs (46-94% match) |
| 4 | @time migration (--force) | 263/271 annotated |

**Final overnight state:**
- 270/271 audio downloaded
- 270/271 stems (vocals, drums, bass, other)
- 271/271 real BPM (100% coverage)
- 263/271 @time=N annotated
- 1.8 GB total disk usage

**Failures investigated + fixed:**
- 15 songs had no audio (yt-dlp search failed during batch — rate limit). Added retry logic with 4 search queries and 3 download attempts.
- "Urgent" had a 12.7MB 36-minute compilation version. Re-downloaded official 3:57 version, stems succeeded.
- "Midnight Rider" had no audio at all. Found with alternate search query, downloaded + stemmed.

### 2. Whisper-Based Lyric Sync

**Script:** `web/tools/sync-lyric-to-audio.py`

Approach: uses OpenAI Whisper on the vocals stem to get word-level timestamps, then matches ChordPro lyric text against Whisper words to find the correct audio position for each line. Rewrites `@time=N @bar=N` annotations with ground-truth timing from real audio.

**Results on 10 test songs (tiny model):**
- 46-94% match rate (avg ~72%)
- Higher with base model (takes 2-3x longer per song)
- Key insight: Whisper word timestamps give correct audio positions regardless of BPM accuracy

**Limitation:** Whisper lyric text is unreliable for chords — UG remains the source for accurate chord charts. The sync tool is useful for verifying that @time annotations align with actual singing, but human-curated UG lyrics are preferred.

### 3. Song Import System

**Script:** `web/tools/import-songs.py`

Quick-import flow for new songs without UG dependency:
1. Download audio from YouTube (yt-dlp with multi-query search)
2. Detect BPM from audio (aubio)
3. Create basic meta.json + placeholder song.chopro
4. UG import later fills in chord charts when songs are liked/favorited

**Usage:** `echo "Artist — Title" | python3 tools/import-songs.py`

**Eagles test:** Imported 10 new Eagles songs in ~3 minutes with audio + BPM.

### 4. UG Playlist Bulk-Add Automation

**Script:** `web/tools/add-to-ug-playlist.js`

Chrome Puppeteer automation that takes a text file of `Artist — Title` pairs, opens Ultimate Guitar, searches each song, and adds it to a playlist. Uses saved UG cookies for auth.

**Flow:**
1. User creates a text file of songs
2. Script opens Chrome → searches UG for each → adds to "Bulk Import" playlist
3. User then runs `ug-import.js --playlist-id <ID>` to pull chords

### 5. Eagles Import Workflow (End-to-End)

Demonstrated the complete "new songs → fully show-ready" flow:

1. **Import:** `import-songs.py` downloaded audio + detected BPM for 10 Eagles songs
2. **Stems:** Ran demucs on all 10 (vocals, drums, bass, other)
3. **UG:** Used `ug-import.js` to pull chord charts for songs in My Tabs
4. **Merge:** Copied audio/stems from our imports to UG-imported folders, removed duplicates
5. **Result:** 14 Eagles songs total (5 existing + 4 new with full chords/stems/BPM + 6 with audio/stems pending UG)

### 6. TUI: Song Library Manager

**Script:** `web/tools/tui.js` — Full terminal UI using `blessed`

**Shell binding:** `manage songs` — added to `~/.zshrc` as a zsh function

**Architecture:**
- Stack-based view navigation (Esc pops the stack)
- `blessed` terminal UI library (lightweight, mature)
- All heavy work dispatched as child processes (spawn)
- Zero resources when quit (single Node process, no daemon)

**Views:**

| View | Key | Description |
|------|-----|-------------|
| Dashboard | default | All songs with color-coded status icons (C=chords, A=audio, S=stems, B=bpm, K=key). Stats bar shows totals. |
| Song Detail | Enter | Metadata, chordpro preview, actions: demucs (s), BPM (b), re-download (d), edit key (Enter) |
| Add Songs | a | Paste artist/title pairs, bulk import |
| Demucs | d | See what needs stems, run on all |
| UG Import | u | Launch ug-import.js (My Tabs), import by playlist ID, or open Chrome to add songs to UG playlist |
| Quick Import | i | Same as Add Songs |

**Status icons** are color-coded: `✓` = complete, letter codes in red = what's missing. Gives instant visual feedback on every song's state.

### 7. Final Library State

| Metric | Before Session | After |
|--------|---------------|-------|
| Total songs | 323 (messy) | **281** (clean) |
| Real BPM | 5% | **100%** |
| Key coverage | 5% | **100%** |
| Audio downloaded | 0 | **281/281** |
| Stems created | 0 | **281/281** |
| @time=N annotated | 0 | **263/281** |
| Disk usage (audio+stems) | 0 | **1.9 GB** |
| Duplicates archived | 0 | **56** to `_duplicates/` |

### Files Created/Modified

```
web/tools/audio-pipeline.py    — Audio download + downsample + BPM + stems pipeline
web/tools/sync-lyric-to-audio.py — Whisper-based lyric sync from vocals stem
web/tools/import-songs.py      — Song import (audio + BPM, chords from UG later)
web/tools/add-to-ug-playlist.js — Chrome automation: bulk-add songs to UG playlist
web/tools/tui.js                — Terminal UI: full song library manager
web/tools/migrate-to-atime.js   — MOD: Added --force + bare @N format support
web/tools/fix-bpm-gp.js         — MOD: Browser-based auth, auto-detect login
web/tools/dedupe-songs.js       — MOD: Archive to _duplicates/ instead of delete
~/Music/SongAudio/              — 281 song audio folders (1.9 GB)
~/Music/SongAudio/overnight.sh  — Unattended overnight pipeline
~/.zshrc                        — Added "manage songs" shell function
BUILD_LOG.md                    — This entry
```

---

## 2026-08-07: TUI is now the playlist manager — REAPER hot-follows the live set

### Summary

Workflow change: playlist authoring moved out of the REAPER GUI into the TUI (singer server). The REAPER-side "LAUNCH PERFORMANCE" now ALWAYS follows the TUI's current band set (auto-synced on every edit), instead of a setlist you had to build/save inside the REAPER window. Also fixed ReaImGui version incompatibilities that were blocking the guidance script from launching.

### 1. ReaImGui 0.10 API compat (blocking fix)

`main.lua` crashed at `gui/app.lua:188` because `ImGui_PushStyleColor` in the installed ReaImGui takes exactly `(ctx, col, packed_color)` — one packed 32-bit RGBA integer, not a 4-float or a table.

- Added `Util.rgba(r,g,b,a)` (`backend/util.lua`) → packed int (e.g. green btn = 647581183).
- Converted all call sites to `reaper.ImGui_PushStyleColor(ctx, Col_*, Util.rgba(...))`:
  - `gui/app.lua:188` (button + hover)
  - `gui/setlist_panel.lua:124-155` (BUILD SHOW button, 3 states)
  - `gui/add_song_dialog.lua:135` (already 4-scalar form → also broken, converted)
- Verified with `luac -p` + packed-value checks. The GUI now launches and LAUNCH PERFORMANCE is reachable.

### 2. Live-set pipeline (TUI → :3000 → runner)

**Shared source of truth:** `web/server.js` already persisted the active setlist to
`data/setlists/_last_session.json`. Two changes made it feed REAPER:

- **Enrichment:** every setlist entry is now normalized to `{id (slug), folder, title, artist, bpm}` via `enrichSetlistEntry()` using the `slugFolderMap`/`titleFolderMap` built during `ensureSongLibrary()`. `setActiveSetlist()` and `saveSessionSetlist()` now write the enriched shape (id = slugged folder name matching the Lua library so the runner can join, raw `folder` kept as fallback).
- **New endpoint** `POST /api/local/setlist/set` — same as `/api/local/setlist` but **never moves the transport/jump to song 1**, so it's safe to call repeatedly mid-show (e.g. editing the set while a song is playing). It just rebases the active set + broadcasts.

The REAPER **runner** hot-follows the file:

- `Runner.loadFollowShow()` reads `data/setlists/_last_session.json`, resolves each song by `id` → raw `folder` → lowercased title against a live `Library.scan()`, builds the region map, and logs `[ShowSrv] Following live set '…' → N songs`.
- `Runner._followCheck()` (throttled to ~`1.5s`) re-stats the file every loop; when it changes, it rebuilds regions and RE-anchors to the current play cursor (keeps the current song truthful on the phones; BPM push is retriggered safely via `_lastSongKey=nil`).
- The REAPER GUI button `LAUNCH PERFORMANCE` now just boots the runner against this file (no "save setlist first" gate), showing `FOLLOWING TUI set: <name> (N songs)`.

**The TUI auto-pushes** (`scripts/tui.js`):

- New `pushLiveSetSync()` → `POST :3000/api/local/setlist/set` with `{slug,title}` from the current `band_queue`; debounced 400ms via `scheduleLiveSetSync()`.
- Hooked onto every band-set mutation: `add`, `add-band`, `remove-band`, `play-band-now`, `import-setlist`, `append-setlist`, plus the Space start/stop toggle.
- Status line flashes `LIVE set synced → N songs`.

**The TUI's `band_queue` slug = raw `~/ReaperSongs` folder name — identical to the Lua library namespace** — with three-level resolution covering naming mismatches (server slug ≠ Lua slug for names with apostrophes/parens: folder + title fallbacks catch it).

### 3. Verification

- `npm test` (transport 9 + browser 4): **13/13 pass.**
- Live integration (`spawnServer` temp instance + real REAPER songs):
  - `POST /api/local/setlist/set` with `{"slug":"Gravity"}`, `"867-5309 Jenny"` → resolved `id`/`folder`/`bpm` (71/71) in `/api/state` + `_last_session.json`.
- Restarted the launchd bridge (`com.liveshowmanager.bridge`, now PID 14778) so `:3000` serves the new endpoint; live probe `curl :3000/api/local/setlist/set` → `{ok:true, count:2}`.
- singer `:3300` node server left running; TUI picks up autyun-sync on next `start show` launch.

### Next up

- Real-rig test: import a setlist in the TUI while REAPER runner is live → verify region map + phones update without touching transport.
- Decide whether the REAPER GUI setlist builder (panels) should be hidden now that TUI owns playlists.

---

## 2026-08-07: REAPER GUI trimmed to a launch/status console — TUI owns playlists

### Summary

Applied the "always follow the TUI set" decision to the UI itself: the in-REAPER
setlist builder is retired from the window. `gui/app.lua` is now a compact
launch/status console — it boots the Runner against the TUI-pushed live set and
shows follow + network status. Also fixed a TUI startup TDZ crash.

### 1. GUI retirement

- `gui/app.lua` rewritten (~945 → ~380 lines). Removed from the window:
  - Toolbar (Add Song / Remove Song / Refresh Library)
  - Library panel, Setlist panel (Save/Load/BUILD SHOW), Details panel
  - Add/Remove song dialogs and their `SongManager`/`SetlistModel` flows
  - `gui/library_panel.lua`, `gui/setlist_panel.lua`, `gui/details_panel.lua`,
    `gui/add_song_dialog.lua`, `gui/remove_song_dialog.lua` still exist on
    disk but are **no longer required/rendered** (leaving the files in place
    avoids breaking anything that might still reference them).
- Kept & restyled: `▶ LAUNCH PERFORMANCE` (green, packed `Util.rgba` colors),
  a live "FOLLOWING: <name> (N songs)" readout, a `Restart` button, a
  pre-launch preview of the pushed TUI set (`data/setlists/_last_session.json`),
  and the Network/Troubleshooting section (updated guidance now points to the
  TUI for playlist management).

### 2. TUI startup crash (blocking, fixed)

`node scripts/tui.js` crashed with `ReferenceError: Cannot access
'CHORD_COLOR_OPTIONS' before initialization` because `TELEPROMPTER_FIELDS`
referenced two option consts (`CHORD_COLOR_OPTIONS`, `COUNT_IN_OPTIONS`) that
were declared after it. Moved both declarations above `TELEPROMPTER_FIELDS`
(`scripts/tui.js`). Verified: boots past module load to the terminal guard.

### 3. Resulting workflow (single path)

1. **TUI** = build/load/edit the playlist (band set). Auto-pushes to `:3000`.
2. **REAPER** `main.lua` → **LAUNCH PERFORMANCE** → Runner follows the live set.
3. The window's job is now only: launch, follow, and status.

### Verification

- `luac -p gui/app.lua` pass; no remaining references to the retired panels
  from `gui/app.lua` or `main.lua`.
- `node --check scripts/tui.js` pass; consts ordered
  `CHORD_COLOR_OPTIONS(165) → COUNT_IN_OPTIONS(170) → TELEPROMPTER_FIELDS(175)`.

### 4. Pull from the TUI works (`POST /api/local/setlist/pull-tui`)

`pullTuiQueue()` initially failed — the raw-node `http.request({hostname: "localhost", port: 3300})`
got a `408`/empty body from the singer server (DNS/IPv6 fallback flake), so
`pull-tui` returned `{ok:false,"reason":"empty body"}` and the live set stayed
stale (`Gravity / 867-5309 Jenny`).

Fix: replaced with global `fetch("http://127.0.0.1:3300/api/band-queue")` +
`AbortController` (8s). Verified:

- `POST localhost:3000/api/local/setlist/pull-tui` → `{"ok":true,"count":4}`
- live set now equals TUI band board exactly:
  `["Don't Let Me Down", "(Sittin on) The dock of the bay", "After Midnight", "A Boy Named Sue"]`

Also confirmed earlier: `e` republishes the TUI set, and the TUI pushes on
boot (`scheduleLiveSetSync()` in `init()`), so REAPER's `pullTuiSet()` at open
+ launch is the third safety net.

### 5. Transport authority: REAPER wins, local sim can't mask it (4 issues)

Four related reports from an actual show rehearsal:

1. **Shift+S quit Safari** — `scripts/show-optimize start` had
   `osascript 'tell application "Safari" to quit'`. Quitting makes macOS
   *relaunch* Safari (session restore), which is what grabbed focus. Removed
   the Safari line entirely.

2. **Song started but TUI didn't reflect playing until space↔space** —
   The TUI's transport keys hit `/api/local/{play,pause,stop}`, which always
   drove the **local simulated clock** (`localPlay()`, 33ms tick advancing
   position + forcing `state.playing=true`). That sim raced the runner's
   bridge data every poll → the TUI froze/wobbled depending on which won.
   Fixed: `/api/local/{play,pause,stop}` now route through `reaperAction()`
   (OSC `40044/40046/40045`) whenever REAPER is connected/active, so Space in
   the TUI actually rides REAPER's transport.

3. **Brief "REAPER PAUSED" flicker mid-song** — same race: local tick set
   `playing=true` every 33ms, `pollLuaState` set `false` every 500ms. Now:
   `startLocalTick()` bails if REAPER is active, and `pollLuaState()` does
   `stopLocalTick()` + syncs `paused` when the runner is live.

4. **"Not progressing / shows playing when true?"** — the bridge is now the
   only writer of `state.playing/paused/position` while REAPER is connected.
   Yes, the REAPER timeline must actually be rolling for play to show;
   verified live: `POST /api/local/play` → bridge flipped `playing:true,
   position:13.29→` and API mirrored it exactly (mirror test 4×1s, no drift).

### 6. "Playing" now means the playhead is actually moving (stall-guard)

Live diagnosis showed REAPER's transport was in "play" (GetPlayStateEx bit 1)
with the playhead **frozen at 13.2934s** for minutes — so the UI said PLAYING
while nothing rolled. Root cause is REAPER-side (transport engaged, cursor not
advancing), but the display must not claim PLAYING in that state.

Added a stall-guard to `Runner._loop` (runner.lua): `playing` is only true when
the play bit is set AND the position has advanced within the last 1.5s. If the
playhead sits still for >1.5s while transport claims play, we report paused.
Resets the moment the cursor moves or transport leaves the play bit.

REQUIRES re-running `main.lua` in REAPER to load (runner lives inside REAPER;
the server + TUI picks it up automatically afterwards).

Also verified for the "did you edit the right file?" concern:
- Bridge PID 19257 started 22:02:10 AFTER server.js edit (22:01:48), cwd =
  `.../Live Show Manager/web` — it IS running the edited server.js.
- Only one real server.js on disk (other match is node_modules engine.io).
- `scripts/show-optimize` is executed fresh from disk on every Shift+S by the
  running TUI (no TUI restart needed) — Safari quit line is gone.

### 7. Auto-start transport on LAUNCH PERFORMANCE

`Runner.start()` now calls `Runner._ensureTransport()`: if REAPER's transport
is stopped/paused when the show launches, it issues `Main_OnCommand(40044)`
(Transport: Play/pause) so the needle starts moving immediately. Guarded — it
never toggles if already playing. `Runner:` .lua reload required in REAPER.

### 8. Show control plane: ARM / PLAY / STOP (+ count-in click sync)

Locked model (live show):
- **ARM** (START SHOW, Shift+S) gates everything; PLAY is a no-op until armed.
- **PLAY** (MIDI/OSC/phone) only starts the next song; ignored while a song is
  playing. First PLAY starts top of song 1. Counts in (seeks back one bar),
  starts transport so the REAPER click + teleprompter flash both begin on flash-1.
- **STOP** halts transport and stages the next song (cursor to its start + BPM),
  armed, not playing. Next PLAY starts it.
- Lyric-end = keep clicking (jam); no sound automations; teleprompter auto-advances.

Files:
- `runner/runner.lua` — polls `data/control_command.json`; `_cmdPlay`/`_cmdStop`/
  `_stageFirst`/`_stageNext` seek, set BPM, start/stop transport; publishes
  `armed`, `stagedIndex`, `countIn{active,rollStart,beats,bpm}`.
- `runner/bridge.lua` — publishes the new control fields.
- `web/server.js` — `/api/control/{arm,play,stop}` write the command file (fall
  back to local sim when REAPER off); `/api/local/*` + socket play/stop route
  through the control plane; merges `armed/countIn/stagedIndex` into state.
- `scripts/tui.js` — Shift+S arms/disarms :3000 (`lsmPost('/api/control/arm')`).
- `web/public/click.html` — WebAudio click page, beat-locked to transport
  position (same math as HUD), output = Mac default device. Testable now;
  Force/MIDI output slot via config at the rig.
- `teleprompter.html` — count-in flashes now anchor to the transport's
  `countIn.rollStart` (position-driven) instead of a wall-clock timer, so they
  lock to the click.

Click device investigation: show-time REAPER audio = M-Audio M-Track Plus
IN/OUT (guitar bus). Mac LAN 192.168.0.202. Force is part of rig (not connected
now). No Link library yet; the `tempo.source==='link'` model already exists.
Recommended end-state: Force click on out 3/4 via Ableton Link; REAPER joins
the Link session. Buildable now as a swappable output on the click scheduler.

### 9. STOP stages the next song into the singer queue (teleprompter)

When the control-plane STOP stages the next song (runner publishes
`stagedIndex` + `songId`), the bridge now mirrors it into the :3300 singer
queue so the teleprompter loads the next song's lyrics immediately (status
`loaded`, not playing).

- `server/api/queue.js` — new `POST /api/queue/load-song` (slug or title);
  resolves slugified folder names (e.g. `don_t_let_me_down` → `Don't Let Me
  Down`), sets current_song + status `loaded`, triggers lyric load.
- `web/server.js` — `syncStagedToSinger()` POSTs the staged song to :3300 with
  the singer config's sha256 auth token; fires from `pollLuaState` when
  staged && !playing && not-yet-synced; resets on each new song start.

Verified live: `load-song` with the slugified id resolves the real song, sets
status `loaded`, and `/api/queue/current` reflects it for the teleprompter.

### 10. Jam + count-in fixes (from live review)

- **Count-in pre-roll now fits the visual count-in.** The teleprompter's
  count-in is 2 attention flashes + a count-down bar (`FLASHES + countBeats`),
  but the runner rolled back only one bar. Now rolls back `2 + countBeats`
  beats, so flash-1 = transport start = first click, and the last count-down
  beat lands exactly on the song start. Count-in expiry also uses the full
  `2 + countBeats` window.
- **NOW PLAYING holds through the jam.** When the cursor passes the song's
  region end while playing, the runner keeps the last song + BPM (instead of
  blanking `currentSong`), so the label and click stay on the song until STOP.
  The teleprompter still auto-advances at the boundary (per the earlier choice).

### 11. Click beat anchoring (song-downbeat grid)

The click accent was `floor(position*bpm/60) % 4 == 1` — musically meaningless
(beat 0 = start of REAPER timeline, not the song). Fixed by anchoring beats to
the song's downbeat:

- Runner publishes `beatAnchorSec` (the current/staged song's region start in
  seconds) — set in `_loop` (region lookup), `_cmdPlay`, `_stageFirst`,
  `_stageNext`; carried through bridge + `/api/state`.
- click.html computes `relBeats = (position - beatAnchorSec) * bpm / 60` and
  accents beat 1 of each bar (`floor(relBeats) % beatsPerBar == 0`), falling
  back to absolute beats when no anchor is present. Bar/beat display uses the
  same model.
- Verified: accent lands on count-in beat 1 (one bar before the downbeat) and
  on every song bar's beat 1; the downbeat lands exactly at the song start.

Robust: uses current BPM consistently, independent of how the tempo got set;
negative relBeats during the pre-roll handled by the modulo.

### 12. Crash fix: reaper.ProjectIndex is not a REAPER API

`_cmdPlay` passed `reaper.ProjectIndex(0)` as an argument (evaluated before
`pcall`), so the nil call crashed REAPER when PLAY was pressed for song 1.

`ProjectIndex` does not exist in REAPER's Lua API — the correct call is
`reaper.EnumProjects(0, 0)`. It was used (silently no-op'ing due to guards) in
`_seekTo`, `_setSongBpm`, and bridge.lua's `readTransport`, meaning song BPM was
never actually pushed into REAPER's project tempo and real project tempo reads
fell back to meta BPM. Added `Runner._currentProject()` (pcall-guarded
`EnumProjects(0,0)`) and replaced all call sites. Verify by re-running
`main.lua` and pressing PLAY.

### 13. Launch = disarmed + transport parked (and ignore stale commands)

Reported: show launched "disarmed but playing", so the song started as soon as
ARM was pressed.

Root cause (two parts):
1. `Runner.start()` never stopped a transport that was already rolling from a
   previous session, and didn't reset `armed`.
2. A stale `data/control_command.json` (a leftover `play` from an earlier live
   test) sat on disk; when the runner reloaded, `_controlCheck` consumed it and
   fired PLAY immediately.

Fixes:
- `Runner.start()` forces `armed=false`, `stagedIndex=0`, `countIn=nil`, sets
  `beatAnchorSec` to region 1, and calls `_haltTransport()` (Transport: Stop).
- New `Runner._haltTransport()` — pcall-guarded stop, only if actually playing.
- `_stageFirst`/`_stageNext` also park the transport (staging always = parked).
- `start()` deletes any pre-existing control_command.json so a fresh launch
  never inherits stale arm/play/stop commands.
- Cleared the leftover `play` file on disk.

### 14. Song duration from chopro; skip/prev buttons; START label

1. **Lyrics vs song-length mismatch** — "Don't Let Me Down" played as a 75s
   region (meta.duration_bars=25) but its chopro `@bar`/`@time` annotations ran
   to bar 56 / 165.8s, so lyrics scrolled ~2.2x too fast and ran out while the
   countdown/sections said lots remained. Fix: `Library.scan()` now reads the
   song.chopro and raises `duration_bars` to the max of meta and the chopro's
   max `@bar` (or last `@time`→bar). Regions now match the timed lyrics.
   Requires main.lua re-run.

2. **Phone START button** sub-label was "Next song" (misleading — PLAY is
   ignored mid-song). Changed to "Play loaded song".

3. **Skip/Previous buttons** added to the phone controller (SKIP/PREV), wired to
   the `next`/`prev` socket actions, which now write a `stage {dir}` command to
   the runner (halts transport + stages adjacent song) instead of raw OSC jump.
   Also `/api/control/next` and `/api/control/prev` HTTP endpoints for MIDI/OSC
   mapping; runner supports `stage {dir}` and `stage {index}`.

4. `parseChoproDirectiveSections` now recognizes `## Section` headers (UG
   export style), so full-song sections are built instead of the sparse
   meta-only list.

### 15. Timing system deep-dive + corrected parser (LRCLIB ground truth)

Investigated the lyric-timing pipeline across all 290 songs. Root cause of the
"lyrics ran out early" report and general timing drift:

- Timing ORIGINATES from LRCLIB (real synced lyric seconds) → imported via
  `web/tools/lrc-to-bars.js` → `@bar=N` → then `migrate-to-atime.js` converted
  `@bar`→`@time` using `meta.bpm`.
- The `@bar`→`@time` conversion is lossless IF `meta.bpm` is correct. But
  `meta.bpm` (aubio auto-detect) is wrong for ~1/3 of songs, STRETCHING the
  timestamps (e.g. American Pie 522s real → 4092s). The trailing `@N.NN` UG
  noise was also being trusted in some parsers.
- Net: ~190 songs fine, ~98 wrong-BPM/estimated, ~2 no timing.

Fixes:
- **`web/public/timing.js`** (shared parser, used by server + available to HUD):
  trusts `@time` (LRC ground truth), ignores the trailing `@N.NN`, converts
  `@bar` at meta BPM, caps implausible times (600s / 300 bars), and returns an
  `estimated` flag.
- **`web/server.js`** `extractLyricLines()` now delegates to `Timing.analyze` in
  BOTH the local-playback and live-REAPER section paths; sync-health gains an
  "estimated" warning; duration uses the parser's capped maxBar.
- **`web/public/hud.js`** `parseChordPro` now prefers `@time=` over the trailing
  `@N.NN` (was inverted) and strips the trailing noise from display; caps `_time`
  at 600s.
- **`backend/library.lua`** derives `duration_bars` from the last `@time` (capped
  +12s outro) instead of the unreliable meta value, so REAPER regions match.

The definitive fix for the ~98 flagged songs is a ground-truth re-fetch:
**`node web/tools/re-sync-timing.js`** (targeted, dry-run available) re-runs the
LRCLIB pipeline with `--force` only on songs the audit flags.

### 16. LRCLIB re-sync + outlier rejection (timing fixed to 96.6%)

Ran `web/tools/re-sync-timing.js` (130 songs re-fetched from LRCLIB, 0 failures).
Added **outlier rejection** to `timing.js`: drops @time values > 3× the median
(removes corrupt LRCLIB fuzzy-match lines like `@time=931.53 reach`) and their
@bar fallback. Result: library went from 223 → **280/290 good (96.6%)**.

Remaining (10): 4 genuinely bad-BPM songs (GEORGIA PEACHES, HEY HEY MY MY,
MR JONES, Papa Was a Rollin Stone — median itself inflated), 4 legitimately
short songs, 2 with no timing. All still flagged via sync-health.

Also discovered: the lyric pipeline corrupted timestamps by round-tripping
LRCLIB seconds through `meta.bpm` (aubio wrong ~1/3 of time). Lyric timing is
now decoupled from BPM (`@time` trusted directly). BPM still matters for the
click + regions → see `docs/BPM_VALIDATION_PLAN.md` (pass / go-deeper design,
PLANNED not built).

### 17. BPM verification + click safety gates (stems/tracks protection)

**Problem**: aubio BPM is unreliable on rock (locks onto half/double tempo), and
the lyric pipeline round-tripped timestamps through meta.bpm, stretching them.

**BPM resolution** (`web/tools/verify-bpm.js`):
- LRCLIB-derived BPM (raw synced-lyrics seconds matched to chopro bars) is the
  ground truth — non-circular, no audio/aubio needed. Writes meta.json with
  `bpm_source="verified"`, `bpm_verified=true`, `lrc_duration_sec`.
- 199/290 songs verified this way (incl. previously-broken American Pie, Hey Jude).

**Tap-to-verify** (`web/tools + /tap-verify.html` + server endpoints):
- `/api/verify/list` (pending), `/api/song-audio/:id` (range streaming),
  `/api/verify/lock` (write human-confirmed BPM).
- Keyboard-driven page: SPACE=tap, Enter=lock, N=skip, P=prev, R=replay.
- Auto-plays each unverified song, locks on 4 consistent taps, auto-advances.

**Runner safety gates** (show-critical — the stems/tracks concern):
- `_setSongBpm` only fires when `bpm_verified=true` (never guesses into REAPER).
- `_hasTempoSyncedItems()` — if ANY track item's play-rate is tied to project
  tempo, `_setSongBpm` skips entirely (changing BPM would stretch stems/tracks).
- Count-in/click only runs when BPM is verified; unverified songs start the
  transport but WITHOUT click/count-in (never a wrong-tempo click live).

**State**: 199 verified + 90 pending tap-verify + 4 gpif. Run `/tap-verify.html`
to lock the remaining 90 manually.

### 18. Tap-to-verify meter (3/4 vs 4/4) + runner time-signature support

Real-world tap findings:
- **3/4 waltzes tapped at 2× the beat tempo.** The user tapped the triplet
  subdivision (1-2-3 as eighth-triplets) instead of the beat, so Cover Me Up
  stored 130.7 vs aubio 65.05 (=2.01×), and all six waltzes matched ~2×. In 3/4,
  "123 123" on the BEAT = the real tempo; tapping subdivisions doubles it.

Fixes:
- **Tap tool** now captures meter: press `3` (3/4) or `4` (4/4) before locking;
  `/api/verify/lock` stores `meta.time_sig`. `/api/verify/list` returns the
  current time_sig so the tool presets it.
- **Re-tap required**: the six waltzes must be re-tapped ON THE BEAT with meter 3.
- **Runner**: `_setSongTimeSig` sets REAPER's project time signature from the
  song's verified meter (TimeMap_SetTimeSig 3/4 or 4/4), so the count-in + click
  accent beat 1 of the correct bar. Bridge falls back to the song's time_sig.
  Changing time signature does NOT stretch audio (grid only).

Flagged songs to fix:
- GEORGIA PEACHES: wrong audio (different version; needs correct Cody Johnson).
- Untitled: Pink Floyd "Money" mislabeled + 82s clip (needs full re-import).
- You Can Have the Crown: re-sync official audio/lyrics.
- CADILLAC RANCH + Folsom Prison: intros to handle/note.
- Whiskey and Rain: lock BPM ~101 (aubio-confirmed).

### 19. 3/4 waltz conversion (taps were on the beat)

User confirmed the waltz taps were each hit = one beat (1-2-3-1-2-3), so the
stored BPMs are correct — no re-tap needed. Converted all 7 waltzes:
Cover Me Up, Songs About Rain, Hard to Be Humble, Cadillac Ranch,
I Can Lie the Truth Is, both Take-an-Angel versions → `meta.time_sig=[3,4]`
(kept tapped BPMs). Runner `_setSongTimeSig` now sets REAPER's project time
signature + the click accents beat 1 of 3. If the click feels 2x fast at the
rig, halve those 7 (one flag).

Also: removed the risky `clean-atime-outliers.js` tool — it modified source
chopro files and was unnecessary (the parser handles messy files at display
time). Current display state: 284/290 songs monotonic+plausible (97.9%).

### 20. Waltz conversion + problem-song cleanup

- **7 waltzes → 3/4** (user confirmed taps were on the beat): Cover Me Up,
  Songs About Rain, Hard to Be Humble, Cadillac Ranch, I Can Lie the Truth Is,
  both Take-an-Angel versions. `meta.time_sig=[3,4]`, BPMs kept. Runner sets
  REAPER time sig + click accents beat 1 of 3.
- **Removed corrupt GEORGIA PEACHES** entry — it was a *different song* (a
  moonshine-runnin' track, not Lauren Alaina's "Georgia Peaches"); wrong audio
  + wrong lyrics.
- **Fixed Untitled → Pink Floyd "Money"**: renamed folder, corrected meta,
  re-downloaded the official full audio (382s, 2023 Remaster vs the 82s clip),
  re-synced LRCLIB lyrics (17.7→377s). Money is in **7/8** — flagged for
  manual meter handling (aubio/tap unreliable in odd meter).
- Removed risky clean-atime-outliers.js tool. Display timing: 284/290 (97.9%).

### 21. Money (7/8) accent + Cadillac Ranch intro trim

- **Money (Pink Floyd)**: `time_sig=[7,8]`, BPM kept (64, tune at rig). The
  accent system now supports ANY meter — `_setSongTimeSig(beatsPerBar,
  beatsPerBeat)` uses the song's denominator (4 or 8), and the click accents
  beat 1 of N (3/4, 4/4, 7/8 all work through the same machinery). Re-downloaded
  official full audio (382s) + re-synced LRCLIB lyrics (17.7→377s).
- **CADILLAC RANCH**: music-video intro was the first ~45s (quiet, -35dB, no
  lyrics). Trimmed audio (224.9→179.9s, backup at full.mp3.orig), shifted all
  lyric @time by −45s, stripped @time from the 11 intro lines that went
  negative. Final: est=false, monotonic, last lyric 104s vs 179.9s audio.
- **GEORGIA PEACHES**: removed corrupt entry (was a different song entirely).

# ═══════════════════════════════════════════════════════════════════
# SESSION DEEP-DIVE — 2026-08-08: Timing system rebuilt end-to-end
# ═══════════════════════════════════════════════════════════════════
# This is the resume point. Read this first after clearing context.
# ═══════════════════════════════════════════════════════════════════

## 1. The original problem (user-visible)

- "Teleprompter got through ALL lyrics then the song still had many sections."
- Click tempo and lyric scroll drifted from the real recording.

## 2. Root cause (the whole chain)

- Lyrics originated from **LRCLIB** (real synced lyric seconds) → imported via
  `web/tools/lrc-to-bars.js` → `@bar=N` → then `migrate-to-atime.js` converted
  `@bar`→`@time=N` using `meta.bpm`.
- That conversion is lossless ONLY when `meta.bpm` is correct. But `meta.bpm`
  comes from **aubio auto-detection, which is wrong ~1/3 of the time**. When
  wrong, it STRETCHED all the LRCLIB timestamps (American Pie: real 522s →
  4092s).
- The library has TWO annotation dialects that the parser confused:
  - **bar-derived `@time`** (91%): `@time` = (bar-1)*240/bpm, redundant with @bar.
  - **true-seconds `@time`** (Eagles style): `@time` IS the real second.
  - Plus the **trailing `@N.NN`** (UG noise) that some parsers trusted wrongly.
- `meta.duration_bars` was ALSO unreliable (Hey Jude said 25 bars = 79s; real
  431s), so REAPER regions were far too short.

## 3. What we built (the fixes)

### A. Shared timing parser — `web/public/timing.js`
- `Timing.analyze(choproText, metaBpm)` → `{lines, bpm, maxBar, estimated}`.
- Trusts `@time` (LRC ground truth), ignores trailing `@N.NN`, converts `@bar`
  at meta BPM, caps implausible times (600s / 300 bars), outlier-rejects corrupt
  values (>3x median), returns an `estimated` confidence flag.
- Used by server.js (`extractLyricLines`), and the same logic now in hud.js
  (which had its OWN inverted bug — preferred trailing over @time).

### B. LRCLIB re-sync — `web/tools/re-sync-timing.js`
- Re-fetched LRCLIB synced lyrics for flagged songs with `--force`, writing
  REAL seconds as `@time`. 130 songs processed, 0 failures.

### C. BPM verification — `web/tools/verify-bpm.js`
- Derived BPM from LRCLIB synced-lyrics seconds matched to chopro bars
  (non-circular, no audio/aubio needed). 199 songs verified this way.
- Wrote `meta.json`: `bpm_source="verified"`, `bpm_verified=true`,
  `lrc_duration_sec`.

### D. Tap-to-verify — `/tap-verify.html` + server endpoints
- `GET /api/verify/list` (pending), `GET /api/song-audio/:id` (range-streams
  `~/Music/SongAudio/<song>/full.mp3`), `POST /api/verify/lock` (writes BPM +
  time_sig to meta.json).
- Keyboard-driven: SPACE=tap, Enter=lock, N=skip, P=prev, R=replay, **3=3/4,
  4=4/4** (meter), `?song=<id>` to re-tap a specific song.
- Tap logic: median of recent intervals, reject outliers (>50%), lock only when
  last 4 taps are within 4% (strict, no drift).

### E. Runner safety gates — `runner/runner.lua`
- `_setSongBpm` ONLY fires when `bpm_verified=true` (never guesses into REAPER).
- `_hasTempoSyncedItems()` — if ANY track item's play-rate is tied to project
  tempo, BPM changes are SKIPPED (stems/tracks can never be stretched live).
- `_setSongTimeSig(beatsPerBar, beatsPerBeat)` — sets REAPER project time sig
  from the song's meter (3/4, 4/4, 7/8 all work). The click accents beat 1 of N.
- Count-in/click only runs for verified BPMs; unverified songs start transport
  with NO click (never a wrong-tempo click).

### F. Fixes to `reaper.ProjectIndex` (was a non-existent REAPER API)
- Replaced with `reaper.EnumProjects(0,0)` via `Runner._currentProject()`. This
  was silently no-op'ing `_setSongBpm`, `_seekTo`, and bridge `readTransport`.

## 4. The data problems found & fixed

| Song | Problem | Fix |
|------|---------|-----|
| 7 waltzes | tapped 2x (subdivision vs beat) — CONFIRMED on-the-beat | time_sig=[3,4], BPMs kept |
| Money (was "Untitled") | 82s clip + mislabeled | renamed, full 382s audio, 7/8 meter, re-synced lyrics |
| GEORGIA PEACHES | wrong song entirely (moonshine track) | removed |
| CADILLAC RANCH | ~45s music-video intro | trimmed audio + shifted @time −45s |
| You Can Have the Crown | corrupt tail @time (1373s on 360s audio) | outlier-rejected; timing now 157s |
| Whiskey and Rain | untapped | locked 101 (aubio-confirmed) |

## 5. MISTAKES MADE (learn from these)

1. **`clean-atime-outliers.js` modified SOURCE chopro files.** The parser already
   handles messy files at display time; touching the source was wrong and caused
   a scary-looking regression (54% audit). Restored from `.lrc-bak` backups;
   display timing verified intact (97.9%). Lesson: NEVER bulk-edit source song
   files; the parser is the boundary.
2. **The "2x tempo" panic.** Initially concluded the waltzes were tapped 2x and
   planned to halve them. User clarified each tap = ONE beat (1-2-3-1-2-3 on
   beats). BPMs were correct; only the METER was missing. Lesson: confirm the
   human's counting pattern before "correcting" data.
3. **Audit metric inconsistency.** Kept switching between "good = plausible
   last-time" vs "estimated flag" — caused false alarm. Lesson: define ONE
   show-readiness metric (monotonic + plausible last time) and stick to it.
4. **aubio is unreliable for rock/odd meters** (locks onto half/double tempo,
   unstable across params). Never trust it alone for BPM.

## 6. KEY ARCHITECTURE INSIGHTS

- **Lyric timing must be DECOUPLED from BPM.** `@time` (LRC seconds) is ground
  truth; BPM is only for click + regions. Don't derive one from the other.
- **LRCLIB is the authoritative timing source** (real synced seconds + duration).
  The audio (`~/Music/SongAudio/<song>/full.mp3`) is the BPM tiebreaker + fallback.
- **The accent system is unified**: beatsPerBar from time_sig[0], accent on beat
  1. 3/4, 4/4, 7/8 all flow through the same machinery.
- **Meta fields now**: `bpm`, `bpm_source` (verified/gpif/aubio/manual),
  `bpm_verified`, `time_sig`, `lrc_duration_sec`.

## 7. FINAL STATE (show-readiness audit)

- **Lyric timing: 283/289 (97.9%)** monotonic + plausible.
  - 200 clean, 83 `estimated` flag (confidence marker, scrolls correctly).
  - 6 edge cases: BEER AND BONES (24s), Cold as Ice (5s), HORSEPOWER (29s),
    Hey hey my my (0s, no timing), Little Wing, Pride and Joy (no timing).
- **Meters**: 279× 4/4, 7× 3/4 (waltzes), 1× 7/8 (Money).
- **All BPMs verified** except flagged edge cases.

## 8. TO ACTIVATE / VERIFY AT THE RIG

1. Re-run `main.lua` in REAPER (loads runner time-sig + BPM gates).
2. Test the waltz clicks — if any sounds 2x too fast, halve that song's BPM
   (one flag). Money's 7/8 BPM needs human tuning.
3. You Can Have the Crown: re-download official audio at the rig.
4. Folsom Prison: "Hello, I'm Johnny Cash" intro — won't use stems, informational.

## 9. FILES TOUCHED

- `web/public/timing.js` (NEW, shared parser)
- `web/public/tap-verify.html` (NEW, keyboard tap tool)
- `web/public/click.html` (accent uses timeSig)
- `web/public/hud.js` (prefer @time over trailing)
- `web/server.js` (verify endpoints, Timing integration, control plane)
- `web/tools/re-sync-timing.js` (NEW), `web/tools/verify-bpm.js` (NEW)
- `web/tools/lrc-to-bars.js`, `web/tools/migrate-to-atime.js` (data pipeline)
- `runner/runner.lua` (BPM/time-sig gates, EnumProjects fix)
- `runner/bridge.lua` (time_sig fallback)
- `backend/library.lua`, `models/song.lua` (bpm_verified, time_sig)
- `docs/BPM_VALIDATION_PLAN.md` (design doc)

## 10. NEXT STEPS (after clearing context)

1. Rig test: full run, check waltz click tempos, Money 7/8, Crown audio.
2. Re-run `node web/tools/re-sync-timing.js` if new songs are added.
3. Re-run `node web/tools/verify-bpm.js` after any library change.
4. Re-run the audit (see `web/public/timing.js` usage in this log) after data
   changes to confirm 97.9%+.
5. Consider the "estimated" songs (83) — optionally re-fetch from LRCLIB or
   manually verify the ones in the live setlist.

### 22. Fix: CountTrackItems → CountTrackMediaItems (crash)

`_hasTempoSyncedItems()` called `reaper.CountTrackItems` which doesn't exist
(correct API: `reaper.CountTrackMediaItems`). Crashed the runner at line 793 on
full run. Fixed. Audited ALL reaper.* calls in runner.lua — every other API
name is valid (`ProjectIndex` only appears in a comment).

### 23. Authoritative region duration + debug visibility layer

**System fix (new songs just work):** Region length is now authoritative:
  1. `meta.lrc_duration_sec` (real LRCLIB track length) — 282/289 songs have it
  2. fallback: last CLEAN chopro @time + 12s (outlier-rejected like timing.js)
  3. fallback: meta.duration_bars
  Verified: **all 289 regions now match real duration (0 mismatches)**. This
  fixes "Dock of the Bay finished way early" (region was 600s from corrupt
  @time=1055; now 167s = real).

**Debug visibility (no more "day to nail down"):**
- `GET /api/debug/snapshot` — one call revealing: bridge state, singer queue,
  current song meta + chopro health (monotonic, estimated, last time), region
  vs audio vs lyrics integrity %, AND auto-generated consistency checks
  (bridge-song vs singer-song mismatch, region too long, non-monotonic lyrics).
- `GET /debug.html` — human dashboard rendering BRIDGE | SINGER | HUD LYRIC
  WINDOW | INTEGRITY | CHECKS, auto-refresh 2s. Open http://<host>:3000/debug.html
  during a run to see exactly what each system sees.

Right now it surfaces the live desync (bridge playing Dock of the Bay at stale
600s region while singer queue shows Don't Let Me Down). After re-running
`main.lua` (rebuilds regions with the 167s duration), re-check `/debug.html` —
the mismatch should clear.

Also fixed a server crash in the debug endpoint (meta scope) that took the
bridge down briefly.
# SESSION HANDOFF — 2026-08-08 final state
# Read this first when resuming.

## Live Symptoms (what you see on screen right now)

1. **Teleprompter stuck on Dock of the Bay, "wastin' time"** — last lyric line,
   not advancing. Bridge confirms: position 1699s, current song Dock of the Bay,
   lyrics end at 133s. Transport is rolling but past all regions (set end 764s).
2. **TUI shows bar 369** — position 1699s × 52bpm/240 + 1 = 369. This is
   the beat grid continuing past the set end into dead space.
3. **TUI "next" does nothing** — the singer queue (main_queue) is on a
   DIFFERENT rotation [Dock, 867-5309, Satisfaction, ACHY BREAKY HEART] that
   has nothing to do with the band set. Advancing it goes to a different song.
4. **TUI rendering glitches** — bottom row height changing, color bars broken,
   countdown/timer broken. This is likely the TUI driving off the bridge's
   inconsistent state (position past set end, songIndex 0, stagedIndex 1).
5. **Singer server and bridge disagree on current song**:
   Bridge shows Dock of the Bay, singer queue shows ACHY BREAKY HEART.

## Root Cause Chain

The transport ran past the end of the set (all 4 regions end at 764s) and kept
rolling. Position is now 1699s — twice the set length. When the runner's follow
check (`_applySessionData`) runs, it sees position past the end, sets
`songIndex = 0` (no region found) and blanks `currentSong`. But the bridge's
server state caches the last `currentSong` (Dock of the Bay) because
`pollLuaState` only updates it inside the `connected` branch, and the runner
publishes `currentSong = null` which the server's `||` logic doesn't overwrite
(started with the cached title).

The teleprompter reads `/api/queue/current` from the singer server (a separate
rotation), not the bridge's current song. So it shows ACHY BREAKY HEART while
the HUD/bridge think Dock of the Bay.

## State Right Now (debug snapshot of live system)

```
Bridge:  Dock of the Bay | pos=1699s | dur=165s | playing=true | idx=0/4 | bpm=52
Singer:  ACHY BREAKY HEART | status=loaded | idx=3
Regions: DLMD(0-215) Dock(215-380) AfterMid(380-573) ABNS(573-764) — total 764s
Song health: lyrics end 133s, audio 167s, region 165s (99% match — FIXED)
Checks:   ERROR: singer vs bridge song mismatch
          WARN: estimated timing (file has corrupt @time values)
```

## What's Already Working (from yesterday — do NOT re-do these)

- **Region durations** are now correct (lrc_duration_sec authoritative, 289/289 match).
- **BPMs** are verified (199 LRCLIB-derived, 4 gpif, rest manual-tap or aubio).
- **Timing parser** (`timing.js`) handles all chopro dialects correctly (97.9% good).
- **Runner safety gates** (`_setSongBpm` only fires when verified, never stretches stems).
- **Time-sig flow** works (3/4, 4/4, 7/8 all accent correctly via `_setSongTimeSig`).
- **Tap-to-verify** works (keyboard-driven, meter capture, `?song=` re-tap).
- **Debug tools:**
  - `/api/debug/snapshot` — one call reveals bridge + singer + song health + checks
  - `/debug.html` — auto-refresh dashboard (open at rig, I query same data)

## What Needs Investigation (fresh eyes)

1. **Transport runs past set end** — should auto-stop or at least not drift to
   2× the set length. Runner's `_loop` has no end-of-set transport stop.
   When position > last region end, the runner blanks songIndex/currentSong,
   which cascades into the bridge caching stale state. Fix: either auto-stop
   the transport at set-end, or hold the last song cleanly.

2. **Teleprompter reads singer rotation, not the live set** — this is by
   design (singer queue is the teleprompter source), but the singer queue
   must BE the same list as the band set for it to agree. Either sync them
   (on ARM, populate singer queue from band set), or make the teleprompter
   follow the bridge's current song.

3. **songIndex=0 bug** — the bridge shows `songIndex:0` with `currentSong:
   "Dock of the Bay"`. Index 0 should be Don't Let Me Down. Something is
   resetting songIndex while currentSong lingers. Root: `_applySessionData`
   sets songIndex=0 when position is past the end; server keeps stale
   currentSong because `||` logic doesn't nil out.

4. **TUI rendering glitch** — likely caused by the bridge's broken state
   (position past end, songIndex 0, stagedIndex 1) feeding into the TUI's
   render logic. Fix the bridge state and the TUI will likely stabilize.

5. **"next" in TUI no-op** — the TUI's `doAction('next')` advances the
   singer queue (`main_queue`), not the band set. This is working as
   intended for the singer rotation, but doesn't match the live-show
   expectations.

## Files With Uncommitted Changes (everything from this session)

All Lua and JS files in the repo are modified vs HEAD. The key files touched:
- `runner/runner.lua` — runner.lua modified (EnumProjects fix, duration fix, time_sig, safety gates, _loop changes from today)
- `backend/library.lua` — region duration now authoritative (lrc_duration_sec)
- `models/song.lua` — bpm_verified, time_sig fields
- `runner/bridge.lua` — time_sig fallback, EnumProjects fix
- `web/server.js` — control plane, debug endpoints, Timing integration, verify endpoints
- `web/public/timing.js` (NEW) — shared parser
- `web/public/tap-verify.html` (NEW) — keyboard tap-to-verify
- `web/public/debug.html` (NEW) — debug dashboard
- `web/public/click.html` — timeSig-based accent
- `web/public/hud.js` — prefers @time over trailing
- `web/public/controller.js` — skip/prev buttons, START label fix
- `web/tools/re-sync-timing.js` (NEW), `web/tools/verify-bpm.js` (NEW)

The `reaper/` library metadata also changed (90+ chopro files, meta.json updates).

## What to do on resume

1. Start by looking at `/api/debug/snapshot` to see live state.
2. Stop REAPER's transport (it's running in dead space at 1699s).
3. Fix the transport-past-set-end problem (runner _loop).
4. Resolve the singer/bridge mismatch (either sync singer queue to band set
   on ARM, or change teleprompter source).
5. Once the bridge state is consistent, the TUI rendering glitch should resolve.
6. Run a full show: ARM → PLAY → (song) → STOP → (advance) → PLAY → ...
   and watch `/debug.html` for mismatches.

## 2026-08-08 (Late): Correct show flow — no auto-start between songs, count-in drives tempo

### The show flow (final, agreed)

1. **Song ends** → server auto-loads the NEXT song's lyrics for the teleprompter, but does NOT start it. BPM stays at the PREVIOUS song's tempo (the gap keeps the old pulse).
2. **PLAY or NEXT pressed** → server re-resolves the LOADED song's BPM from the library, switches `state.bpm` to it, and starts a **count-in** (4→3→2→1 at the new song's BPM, position frozen during count-in).
3. **Song begins** → position clock starts advancing, click at the new tempo, lyrics scroll, HUD count-in overlay hides.

### Changes — `web/server.js`

- `startLocalTick()` auto-advance: now calls `localJumpToSong(next)` then **restores the previous BPM** and does NOT call `localPlay()`. Song loads stopped. The old auto-playing (`localJumpToSong` + `localPlay`) is removed.
- `controlPlay()` local path: re-resolves the current song's BPM from `songLibrary` (via `state.songId`) so the count-in and click run at the LOADED song's tempo even though `state.bpm` was held at the previous tempo during the gap.
- `sectionsFromChordpro()`: rewritten to use the real `@bar=` annotations from each chopro section's raw lines (via new `cs.raw`) instead of proportional line-count distribution — fixes the "C1 = 95% of song bar" bug (C1 went 105px → 35px).
- `parseChoproDirectiveSections()`: now preserves `raw` lines per section for `@bar` extraction.

### HUD count-in (`live-stage-hud/web/public/`)

- Added `#countOverlay` (fixed fullscreen, big 4→3→2→1 number) + `#countNum` to `hud.html`.
- Added CSS (pulse animation).
- Added a **local 50ms count-down clock** in `hud.js` driven by `lastCountIn.startedAt + BPM` — smooth/on-beat, independent of the ~10Hz socket broadcast cadence (was jerky before).
- The socket state handler now just stores `lastCountIn = s.countIn`; the timer renders it.
- `#syncWarning` changed from `position:fixed` (overlapped header) to in-flow, pushing content down; only shows for serious issues.
- Connection LED gets `.connected` class (green) from JS.

### Verified

- PLAY → countIn `{active:true, bpm: songBpm}`, position frozen at 0, then advances after count-in completes.
- Song-end loads next stopped, BPM preserved, then PLAY re-resolves to the loaded song's BPM (81.4 → 131.6).
- `npm test`: 27/27 pass.

## 2026-08-08 (Late night): Count-in via every path, metadata 2x, countdown ring removed, GitHub push

### Count-in now fires from ALL play paths
- **Bug:** the phone controller's START button sent the `start_song` socket action, which called `localPlay()` DIRECTLY — bypassing `controlPlay()` and skipping the count-in (lyrics started instantly, no wait).
- **Fix:** `server.js` `case "start_song"` now routes through `controlPlay()`, so the count-in always runs and position is held at 0 until the count-in completes, then the song starts.
- **Verified headless:** `start_song` → `countIn.active=true`, overlay visible, position held at 0.0 during count-in.
- Also enabled `count_in_display: enabled` on the :3300 teleprompter config (it was `disabled`), so the standalone teleprompter shows its count-in too.

### Metadata section scaled 2x
- `.meta-row-clean` font-size `1.25rem → 2.5rem` in `hud.css` (2x). Header gap increased to match.

### Countdown ring removed
- Removed the circular countdown ring ("time remaining pie") from the HUD: its HTML (`#countdownRing` SVG), its JS (`updateCountdownRing`/`renderRingTickMarks` + element refs), and its CSS (`.countdown-ring`, `.ring-*` classes/keyframes).
- Footer time (elapsed/total) in `#footerTimeRow` retained. Note this in future design docs.

### Git / GitHub
- Pushed both repos to GitHub:
  - `live-show-manager` (REAPER bridge/server/tests) → `main`
  - `live-stage-hud` (HUD/controller) → `main`

### Verified
- Metadata 2x, ring absent, start_song count-in holds position, 27/27 tests pass.

## 2026-08-08 (Late night cont.): HUD metadata 3x, chord display fixed, chord color mode circle

### Metadata scaling (verified @1920x1080)
- SONG / KEY / BPM rows: `3.75rem` (3× the original 1.25rem) → 60px at scale 1.0
- NEXT row: `1.875rem` (1.5×) → 30px, via new `.meta-row-next` class
- Both `@media (max-height:700px)` and `@media (max-width:900px)` overrides updated
  proportionally (NEXT half of the rows) so it never inverts on small screens.
- The apparent "inversion" in headless testing was a 600px-viewport artifact; at real
  1080p the sizes read 60px / 60px / 60px / 30px.

### Chords "went away" — root cause
- The config had `chord_color_mode: "flavor"` (all major chords yellow), making chords
  indistinguishable → looked "gone". Set back to `circle` mode (per-root Circle-of-5ths
  colors). Verified: F=green, C=red, Eb=orange, G=blue.
- Also removed the `[...]` brackets around chord names: chords now render as clean
  colored root notes (matching STAGE-HUD-SPEC) instead of `[F]` bracketed markup.

### "Flashing connected dot" — answered
- The flashing green dot is the **metronome beat indicator** (`#metronodeDot`, bottom
  right) which pulses on every beat (80ms flash) — intentional, synced to the click.
  The top-right `#connectionStatus` is static text, no flash. Both OK as-is.

### Verified
- Full HUD render @1920x1080: metadata 3x/1.5x, clean colored chords, zero page errors.
- `npm test`: 27/27 pass.
- Pushed live-stage-hud to GitHub `main`.

---

## 2026-08-10 — V2: Akai Force as Master Clock via MIDI Real-Time Clock (USB or DIN via M-Track Plus)

### The problem (post-show 2026-08-08)

Danny's #1 pain: no click in the IEMs → the band drifted off-tempo and he had to rewind/skip lyrics. Latency of a network-sent click is unacceptable. The clock architecture decision (recorded in live-stage-hud Session 8):

```
Akai Force = MASTER CLOCK
  ├── AUX out → IEM mixer        ← the click Danny HEARS (sample-accurate, zero network latency)
  └── MIDI clock → Show Manager  ← display-only tempo/downbeat sync for the teleprompter/HUD
```

- Reaper = guitar signal chain ONLY. Not in the tempo path (may gain time-based features later — out of scope).
- The audible click never crosses the network; only display sync does, and that tolerates ms of jitter.

### Why MIDI clock (not Ableton Link, not network click)

- Link over WiFi was the "recommended end-state" in the docs, but USB MIDI with the Force was already attempted and failed. For V2 we made the Force's MIDI real-time clock the transport — it works over **USB MIDI** (preferred) or a **physical DIN cable Force → M-Track Plus MIDI port** (fallback).
- The Force's own AUX output still carries the audible click to the IEMs. The Show Manager only reads tempo + beat phase.

### What was built

New `web/midi-clock.js` (Live Show Manager) — a MIDI real-time clock reader:

| Signal | MIDI msg | Handling |
|--------|----------|----------|
| START / CONTINUE | 0xFA / 0xFB | `playing=true`, position=0, downbeat anchored |
| STOP | 0xFC | `playing=false` |
| CLOCK | 0xF8 | BPM from inter-tick interval (24 PPQN, smoothed); position advances; beat-1 re-anchored each measure (4/4 grid) |
| SONG POSITION | 0xF2 | jump transport position (16th notes → beats → seconds) |

- **Clock-stall watchdog** — if ticks stop for >1.5s (USB pulled, cable snag, Force powered down) the transport flips to stopped so the HUD/click don't run on stale beats.
- **Port auto-discovery** — explicit `port` in `data/midi-clock.json`, else alias match (Force / M-Track / Midi / Akai), else first available non-virtual input. **Re-scans every 5s** so a Force powered on after the bridge still auto-connects.

Server wiring (`server.js`):
- On Force playing → `state.tempo.source = "midi"`, `state.bpm` follows the Force, `downbeatAt`/`downbeatRev` updated (this is what the HUD beat display anchors to), `position` advances, broadcasts ~10Hz.
- Force is authoritative while sending clock — re-asserts `source="midi"` even if a song-load momentarily reset it to `"reaper"` (the master clock always wins).
- `beatAnchorSec` stays 0 on the Force path (position 0 IS transport start; click.html's absolute-beat fallback is correct).
- Clean shutdown in the launchd cleanup handler.

HUD (`live-stage-hud/web/public/hud.js`):
- `updateConductor` now treats `tempo.source === "midi"` the same as `"tap"` — the beat/bar display derives from the shared `downbeatAt` wall-clock anchor so the HUD beats lock to the Force's click.

### Verified (headless, virtual 'Akai Force' MIDI port)

- Bridge discovers the Force at boot (or via 5s rescan if the Force connects later).
- START + clock → `source=midi`, `playing=true`, BPM derived (~114-119 from a 120 sim, 1% jitter expected), position advances, `downbeatRev` increments per bar.
- Clock stall → `playing=false` within ~1.5s.
- Song load while Force driving → source re-asserts to `midi` immediately.
- HUD beat display advances with the Force (bar counter + active beat cycling).
- `npm test`: 27/27 pass.

### Config

`data/midi-clock.json`:
```json
{ "enabled": true, "port": "" }
```
- `port: ""` → auto-discover (alias match first, then first available).
- Set `port` to a specific device name to force it.

### At the rig (gig checklist)

1. Force MIDI OUT → Mac USB (or → M-Track Plus MIDI IN if USB fails).
2. Force AUX OUT → IEM mixer (the click you hear).
3. Force clock preferences: MIDI Sync = ON, and it should send START/STOP.
4. Start the bridge → it auto-finds the Force port.
5. Press play on the Force → teleprompter/HUD lock to the Force's beat.
6. TUI/`POST /api/tempo {bpm, source:"link"}` still work for manual override if the Force is absent.

### Files

| File | Changes |
|------|---------|
| `Live Show Manager/web/midi-clock.js` | NEW — Force MIDI clock reader (start/stop/clock/position, BPM+downbeat derivation, stall watchdog, port rescan) |
| `Live Show Manager/web/server.js` | Force clock wiring → state.tempo (source midi, downbeatAt/Rev, position), ~10Hz broadcast, cleanup |
| `Live Show Manager/data/midi-clock.json` | NEW — `{ enabled, port }` config |
| `live-stage-hud/web/public/hud.js` | `updateConductor` anchors beats to `downbeatAt` when `source === "midi"` |

### Rollback

This is on top of the `show-2026-08-08` tags. To return to the last-gig state:
```bash
git reset --hard show-2026-08-08   # in each repo
```

---

## 2026-08-14 (Session 9) — Rig wiring status + V25→Force control path + Mod-Wheel Middleman decision

### The update (physical rig)

- MIDI now flows **Mac → Force** over a single 5-pin DIN cable:
  `Mac → M-Track Plus (USB) → M-Track DIN OUT → cable → Force MIDI IN`.
- **Force → Mac is NOT connected yet** (no return cable). The clock reader
  (`web/midi-clock.js`, built 2026-08-10) is fully built and waiting — this is a
  purely physical blocker, no code change needed.
- The **Alesis V25** (USB → Mac) now controls the Force: its zones route through
  the Mac to the Force — **keys on channel 1, knobs on channel 3**. Works, with
  slight latency from the USB→DIN chain.

### Decision locked: the Mac is the mod-wheel MIDDLEMAN (required, not optional)

- Goal: the V25 mod wheel drives a Force control.
- Problem: the Force's MIDI mapping/learn **cannot map a mod wheel (CC1)** to a
  control — it refuses the assignment. Mod wheel is not mappable to "anything"
  on the Force.
- Therefore the Mac **must** sit in the V25→Force path as a **MIDI middleman**
  that transforms mod-wheel CC1 → a CC the Force *can* learn.
- Consequence: the "direct" V25 USB → Force topology is **off the table for V2**.
  The slight-latency Mac-routed path is accepted and permanent for control in V2.
- New software item to build (pending): a **CC1 → CCn transformer** in the Show
  Manager's MIDI layer (easymidi already present) so the mod wheel arrives at
  the Force as a learnable controller.

### Clock sync status (code done, physical blocker only)

- `web/midi-clock.js` + server wiring already built (2026-08-10): port
  auto-discovery (alias match Force / M-Track / Akai, 5s rescan), 24-PPQN BPM
  derivation, beat-1 downbeat anchoring, 1.5s clock-stall watchdog,
  `source="midi"` takeover of `state.tempo`.
- Verified headless against a virtual 'Akai Force' port; `npm test` 27/27 pass.
- Waiting on: a **2nd DIN cable** `Force MIDI OUT → M-Track DIN IN` (clock
  direction). The USB option was previously tried and failed (2026-08-10).
- Force config to set when the clock cable lands:
  **Force → MIDI Sync → Clock Out = ON** on the DIN port.

### End-state topology (2 DIN cables)

```
V25 ──USB──▶ Mac ──USB──▶ M-Track Plus
                           ├── DIN OUT ──cable 1──▶ Force MIDI IN   (V25 keys/knobs/mod-wheel, post-transform)
                           └── DIN IN  ──cable 2──◀ Force MIDI OUT  (Force real-time clock → Show Manager)
Force ──AUX──▶ IEM mixer   ← the click you hear (never crosses the network)
```

### Todo / next

1. [ ] 2nd DIN cable: `Force MIDI OUT → M-Track DIN IN` → live Force clock.
2. [ ] Force: enable Clock Out on DIN.
3. [ ] Build the mod-wheel transformer (CC1 → Force-learnable CC) in the Show
      Manager MIDI layer.
4. [ ] Verify on the rig: mod wheel drives the target Force control; teleprompter
      beat locks to the Force clock.

### Files

| File | Changes |
|------|---------|
| `Live Show Manager/BUILD_LOG.md` | This entry — no code changes this session (decision/status only) |
