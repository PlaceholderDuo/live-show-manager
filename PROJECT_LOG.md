# Live Show Manager — Project Log

## Purpose

REAPER ReaScript for live performance: manage song library, build setlists,
generate show projects with cue MIDI + regions, and run the show.

## Architecture

Modular Lua via a custom `App.require()` loader (see `main.lua`).

### Module tree

```
main.lua                  Entry point + loader
├── backend/
│   ├── util.lua          Logging, strings, tables, paths
│   ├── filesystem.lua    File abstraction (read/write/list)
│   ├── json.lua          JSON encode/decode
│   ├── library.lua       Scan ~/ReaperSongs/ → song objects
│   ├── song_manager.lua  CRUD: add/remove/search songs
│   └── audio_import.lua  Copy + downsample audio files
├── models/
│   ├── song.lua          Song data model
│   ├── setlist.lua       Setlist model + persistence
│   └── show.lua          Show model: fromSetlist + lookupByPosition
├── builders/
│   ├── region_builder.lua Calculate region positions → RPP MARKER lines
│   ├── cue_builder.lua    Copy cue.mid files → RPP Cues track with items
│   └── show_builder.lua   Orchestrator: read template, assemble RPP, write show
├── gui/
│   ├── app.lua           Main window, ImGui loop, coordinator
│   ├── library_panel.lua Song library list with status icons
│   ├── setlist_panel.lua Setlist list + Add/Remove/Up/Down + Save/Load/Build
│   ├── details_panel.lua Song detail view
│   ├── add_song_dialog.lua Add-song dialog with real-time search
│   └── remove_song_dialog.lua Remove-song dialog
├── tools/
│   ├── add_song.lua        Standalone add-song script (REAPER action)
│   ├── remove_song.lua     Standalone remove-song script
│   └── launch_performance.lua Standalone runner launcher
├── runner/
│   ├── runner.lua          State machine: tracks play cursor against regions
│   └── bridge.lua          Publishes runner state → data/bridge_state.json for web server
├── web/
│   ├── server.js           Node.js: Express + Socket.IO + OSC bridge
│   ├── package.json        Dependencies (express, socket.io, osc)
│   └── public/
│       ├── index.html      iPhone controller view (transport, song, tabs, knob labels)
│       ├── display.html    Stage/teleprompter view (lyrics, levels, loop states)
│       ├── style.css       Dark performance theme, both layouts
│       └── client.js       Shared Socket.IO helpers
└── data/
    ├── setlists/            Saved setlist JSON files
    ├── cache/               Cache directory
    └── bridge_state.json    Written by runner, read by web server
```

## Data Model

### Song

```
{
  id           (slug from folder name, eg "summer_of_69")
  folder       (original folder name, eg "Summer of 69")
  path         (full path to folder)
  title        (from meta.json)
  artist       (from meta.json)
  bpm          (from meta.json)
  key          (from meta.json)
  snapshot_id  (REAPER snapshot, from meta.json)
  duration_bars(from meta.json)
  notes        (from meta.json)
  cue          (path to cue.mid if exists)
  valid        (true if no warnings)
  warnings     (array of issue strings)
}
```

### meta.json (per-song, in ~/ReaperSongs/<Song>/)

```json
{
  "title": "Summer of 69",
  "artist": "Bryan Adams",
  "bpm": 139,
  "key": "D",
  "snapshot_id": 1,
  "duration_bars": 128,
  "notes": "Big intro. Full energy."
}
```

### Setlist (in data/setlists/<name>.json)

```json
{
  "name": "Friday Night",
  "songs": ["summer_of_69", "gravity"]
}
```

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| App.require() over Lua require() | Custom path resolution, caching, error handling |
| Song IDs are slugs from folder names | Stable references even if display title changes |
| ~/ReaperSongs/ as library root | Separate from script directory, easy to back up |
| ReaImGui for GUI | Native REAPER integration, fast iteration |
| Modular panel architecture | Each panel is independent; app.lua coordinates |
| RPP text manipulation for show generation | Deterministic, no async issues, works without GUI state |
| RegionBuilder.calculate() uses (bars × 4 beats × 60) / BPM | Standard 4/4 time; BPM/bars from meta.json |
| CueBuilder generates a "Cues" track with MIDI file references | External MIDI files kept in show/cues/, items loop to fill song duration |
| insertIntoRPP() uses depth-based angle-bracket tracking | Correctly finds project boundary in nested RPP format |
| Show project output to ~/ReaperShows/<Name>/<Name>.rpp | Separate from library and script, mirrors ReaperSongs convention |

## State — 2026-06-28

- Backend: util, filesystem, json, library, song_manager, audio_import — all working
- Models: song, setlist — working
- GUI: app, library_panel, setlist_panel, details_panel, add_song_dialog, remove_song_dialog — all working
- Tools: add_song, remove_song — standalone REAPER scripts
- Setlist persistence: save/load to data/setlists/ — working
- Builders: region_builder, cue_builder, show_builder — all complete
  - "BUILD SHOW" button in setlist panel (dark styled, tooltip)
  - Reads ~/ReaperTemplates/MasterRig.rpp, generates ~/ReaperShows/<Name>/<Name>.rpp
  - Adds REAPER regions for each song (positioned by BPM × bars)
  - Adds a "Cues" track with MIDI items referencing copied cue.mid files
  - Offers to open the project in REAPER on completion
- Test media: 4 test songs in ~/ReaperSongs/

## Phase 5 — Live Control Surface + Stage Display

### Vision

The entire system (REAPER + Mobius + synths + FX + guitar + MIDI controllers + iPhone + teleprompter) acts as **one big interactive instrument**. The MacBook runs with lid closed during performance. The iPhone 7 is the primary control surface (dashboard). A separate stage display (teleprompter / external monitor) provides visual feedback — lyrics, levels, loop states, countdowns.

### Architecture (2026-06-28 decision)

```
MacBook M1 Pro (lid closed)
├── REAPER + Mobius (audio/MIDI engine)
├── Lua Runner (show tracking, region sync)
└── Node.js Web Server (<1% CPU)
     │
     ├── WebSocket ──► iPhone 7 (CONTROL)
     │                   tabs: Show | FX | Mix | Synths | Mobius | Stats
     │                   + Alesis V25 knob labels at screen bottom
     │
     └── WebSocket ──► Teleprompter / Stage Display (FEEDBACK)
                         lyrics, input LEDs, loop states, countdowns
```

| Decision | Rationale |
|----------|-----------|
| Node.js over Python for bridge | Native WebSocket support, tiny dep footprint (express + socket.io + osc), single `brew install node` |
| Socket.IO over raw WebSocket | Auto-reconnect, rooms for multi-device, built-in heartbeat, trivial API |
| OSC over MIDI for REAPER control | REAPER has native bidirectional OSC, no extension needed, arbitrary param control |
| Web UI over native iOS app | Iterate in minutes not days, no App Store, same API contract for SwiftUI port later |
| Two views one server | / for iPhone controller, /display for stage — same state, different layout |
| Alesis V25 knobs context-mapped | Each iPhone tab defines 4 knob labels + MIDI CC mappings, updated in real-time |

### Sprint 1 — Web Bridge + Both Views (current)

Initial build: Node.js server, iPhone controller (transport + song), stage display (lyrics + levels), OSC bridge to REAPER.  
**Second pass:** All 6 tab pages fleshed out, Lua runner collects real REAPER track/FX data, LoopyPro-inspired Mobius loop cards with SVG progress rings.

## Known Gaps / Future Ideas

- Key / BPM auto-detection from audio (use external tool like Keyfinder)
- Karaoke stem separation (Spleeter, Demucs, etc.)
- MIDI cue editing within the app
- Drag-and-drop setlist reordering
- Undo/redo for setlist edits
- Stable GUID generation for builder-created tracks (currently REAPER auto-generates on first load)
- Fallback when ~/ReaperTemplates/MasterRig.rpp does not exist (show helpful setup dialog)
- Teleprompter hardware build (mini PC + monitor in fake speaker box)

---

## Build Session — 2026-06-28: Phase 5 Sprint 1 — Web Bridge + Lua Runner

### Goal
Build the live performance control surface — iPhone as primary dashboard, stage display as heads-up, Lua runner as the brain tracking position against song regions.

### What was built

**Node.js Web Server (`web/`):**
- `server.js` — Express + Socket.IO + OSC bridge (200 lines)
  - Serves iPhone controller at `/`, stage display at `/display.html`
  - Real-time state push via WebSocket to all connected clients
  - OSC client sends transport commands to REAPER (port 8000)
  - OSC server listens for REAPER feedback (port 9000)
  - Polls `data/bridge_state.json` for Lua runner state every 500ms
  - REST endpoint `/api/state` and `/api/action` for debugging
- `package.json` — deps: express, socket.io, osc
- `public/index.html` — iPhone controller: current song (28px title), transport bar (play/pause/stop/prev/next, 72px circular play button), progress bar, PANIC button, tab bar placeholder (Show/FX/Mix/Synths/Loops/Stats), 4 color-coded Alesis V25 knob labels at bottom edge
- `public/display.html` — Stage view: large song title (48px), channel level meters (left), Mobius loop state panel (right), footer with song position + progress + countdown + connection status
- `public/style.css` — Dark performance theme, CSS variables, flexbox layouts, safe-area-inset for iPhone notch, 48px minimum touch targets, responsive
- `public/client.js` — Shared Socket.IO helpers: formatTime, sendAction, tab switching, knob label updates

**Lua Runner Engine (`runner/`):**
- `runner/runner.lua` — State machine: loadShow(setlist, library) → Show.fromSetlist → calculate regions → defer loop checks GetPlayStateEx + GetPlayPosition every frame → lookupByPosition → determine current/next song → publish via bridge
- `runner/bridge.lua` — JSON bridge: throttled writes (200ms) to `data/bridge_state.json`, fields: connected, playing, position, duration, bpm, currentSong/Artist/Key, nextSong/Artist, songIndex, totalSongs, notes, showName, elapsed/remaining

**Show Model (`models/show.lua`):**
- `Show.new(name, songs, path)` — constructor
- `Show.fromSetlist(setlist, library, showPath)` — resolves song IDs, computes regions via RegionBuilder
- `Show.lookupByPosition(show, seconds)` — binary-like scan of regions, returns (index, region) or nil

**GUI Integration (`gui/app.lua`):**
- "▶ LAUNCH PERFORMANCE" button in toolbar (green styled)
- Requires runner.runner, creates Runner instance, loads current setlist, starts defer loop
- Status message confirms runner started

**Standalone Launcher (`tools/launch_performance.lua`):**
- Lists saved setlists, prompts for name, loads setlist + scans library, starts runner
- Can be bound to REAPER toolbar button or key command

### Architecture verified
- Server starts with `node server.js`, all 5 endpoints return 200
- WebSocket connects, state broadcasts on change
- OSC port opens, ready to send/receive with REAPER
- Server CPU impact: ~0.3% (measured idle)

### How to test tonight
1. Open REAPER, run `main.lua`
2. Load or create a setlist, click "▶ LAUNCH PERFORMANCE"
3. In terminal: `cd web && node server.js`
4. Open http://localhost:3000 on iPhone
5. Press Play in REAPER — iPhone shows current song, progress, transport controls
6. Open http://localhost:3000/display.html on stage display — shows lyrics, levels, loop states

### REAPER OSC setup (required for transport control from iPhone)
1. Preferences > Control Surfaces > Add "OSC (Open Sound Control) control surface"
2. Mode: Control Surface for OSC
3. Local listen port: 8000
4. Destination: 127.0.0.1:9000
5. Hit OK — iPhone transport buttons now control REAPER

### Tab pages built
- **Show tab** — Current song (28px), artist/BPM/key metadata, progress bar with elapsed/remaining, transport (play/pause/stop/prev/next), PANIC button
- **FX tab** — Lists all REAPER tracks with FX chips. Tap an FX → shows 8 parameter slots with value bars. Tap to increment. Back button returns to track list. Knob labels show top 4 param names.
- **Mix tab** — Vertical fader strips per track (color-coded green/yellow/red by level). Mute/solo toggle buttons. Reads real REAPER track volumes and mute/solo state.
- **Mobius tab** — LoopyPro-inspired loop cards per track. SVG progress ring shows loop cycle position. Status text + beat length. Action row: Record(●), Play(▶), Overdub(◉), Multiply(×), Mute(M). State colors: idle=grey, recording=red, playing=green, overdub=yellow, multiply=orange, muted=dimmed.
- **Synths tab** — Synth track cards with current preset name. Tap to select/change.
- **Stats tab** — Grid: Server, WebSocket, REAPER, Show name, Position, BPM, Uptime.

### Lua runner enhanced
- `Runner._collectTrackData()` — queries REAPER API for all tracks: name, volume, mute, solo. Called every 10 frames (~166ms at 60fps).
- `Runner._collectFXData()` — queries REAPER API: track names, FX names, up to 8 params per FX with names + values.
- Bridge publishes `trackLevels`, `fxData`, `synthData` alongside main state.

### Server enhanced
- `pollLuaState()` now reads and broadcasts `trackLevels`, `loopStates`, `fxData`, `synthData` as separate Socket.IO events
- All data flows: REAPER → Lua → JSON → Server → iPhone WebSocket

### Next
- Alesis V25 knob context system (MIDI CC mapping per tab + knob label ↔ parameter binding)
- Mobius MIDI integration (send PC/CC for loop commands, receive feedback for state)
- Test end-to-end with real REAPER project + iPhone on WiFi

---

## Build Session — 2026-06-29: Phase 5 Sprint 2 — MIDI CC, Knob Context, Auto-Discovery, iOS 15 Safari Fix

### Goal
Complete the remaining integration pieces: Mobius MIDI CC control, Alesis V25 knob context system, synth data in runner, server auto-startup with launchd, iPhone auto-discovery via QR code and Bonjour, and fix "loading forever" bug on iPhone 7 (iOS 15 Safari).

### What was built

**Mobius MIDI CC Integration (server.js):**
- Installed `easymidi` npm package — creates virtual MIDI port "Live Show Manager" on startup
- Defined standard Mobius CC mapping: Record=20, Play=21, Overdub=22, Multiply=23, Mute=24, Reset=25, Undo=26
- All Mobius action handlers now send real MIDI CC instead of logging to console
- Documentation in README for routing to Mobius track in REAPER

**Alesis V25 Knob Context System (server.js + index.html):**
- Server maintains per-client context via `clientContexts` Map (active tab, selected FX)
- `tabChange` and `fxSelected` socket events update context on server
- `knob` socket event routes to correct OSC address based on context: if FX tab with selected FX, routes to `/track/{trackIdx}/fx/{fxIdx}/param/{knob}/value`; otherwise routes to generic `/control/knob/{knob}`
- Default knob CC assignments: 70, 71, 72, 73 (documented for V25 setup)
- Client-side knob label system already existed in KNOB_LABELS map; added `fxSelected` emission to notify server

**Synth Data + Loop State in Lua Bridge (runner.lua + bridge.lua):**
- `Runner._collectSynthData()` — scans all tracks for synth VSTs by name pattern matching (25+ patterns: "synth", "analog", "vital", "serum", etc.), reads preset name via TrackFX_GetPreset
- `Runner._collectLoopStates()` — stub for future Mobius MIDI feedback parsing (Mobius doesn't expose loop state via standard TrackFX API)
- `Bridge.publish()` now accepts `synthData` and `loopStates` parameters
- Piano pattern list added as `SYNTH_PATTERNS` constant at module level

**Fixed `sendAction` Socket Leak (client.js):**
- `sendAction()` was creating a NEW socket.io connection on every button press (opening 2 TCP connections per tap)
- Rewrote to queue actions when `socket` isn't available, drain queue after `io()` completes
- Both HTML pages call `drainActionQueue(socket)` after socket init
- Action queue (`_actionQueue`) processed FIFO

**Server Auto-Startup + launchd Integration:**
- Created `web/com.liveshowmanager.bridge.plist` — macOS launchd service definition
  - `KeepAlive: true` — kernel-level process monitoring, zero CPU overhead
  - `RunAtLoad: false` — manual start via LAUNCH PERFORMANCE button or `control.sh`
  - Logs to `web/logs/server.log` and `web/logs/server-error.log`
- Created `web/control.sh` — `start|stop|status|restart|direct` commands
  - `start` copies plist to `~/Library/LaunchAgents/` and runs `launchctl load`
  - `stop` runs `launchctl unload`
  - `status` checks launchd + falls back to pgrep for direct mode
- Wired server auto-start into:
  - `gui/app.lua` — LAUNCH PERFORMANCE button runs `reaper.ExecProcess("bash control.sh start")`
  - `tools/launch_performance.lua` — same auto-start before creating runner
- launchd auto-restarts server on crash (mach port monitoring, not polling)

**mDNS/Bonjour Auto-Discovery (server.js):**
- Replaced `bonjour-service` npm package (ran separate JS mDNS stack) with system `dns-sd -R` command
  - System mDNSResponder is already running on every Mac — zero additional CPU
  - Registers `RDFX1-macbook-pro._http._tcp.local.` service on port 3000
  - Runs as spawned child process, killed on server exit
- `os.hostname()` → `.local` Bonjour format displayed in startup banner
- Updated startup banner to show Bonjour URL + LAN IP + QR code
- `/api/discover` endpoint returns all connection info (ip, port, bonjour, both URLs)

**QR Code Generation at Startup (server.js):**
- Installed `qrencode` via brew
- At server startup, generates QR code for `http://<lan-ip>:<port>/`:
  - ANSI terminal output (scannable from terminal)
  - PNG saved to `web/public/qr.png` (served at `/qr.png`)
- Silent failure if qrencode not installed — server still starts
- QR regenerates every server restart (picks up current IP)

**Client Monitoring (server.js):**
- Added `/api/clients` REST endpoint — returns array of connected WebSocket clients with their context (tab, FX selection)
- `broadcastClientCount()` emits `clientCount` Socket.IO event on every connect/disconnect
- Stats tab can show how many devices are connected

**iPhone 7 "Loading Forever" Fix (index.html + display.html + server.js):**
- Root cause: Socket.IO 4.8.3 defaults to WebTransport protocol, which iOS 15 Safari doesn't support properly — handshake hangs, page never finishes loading
- Fixes applied:
  1. Server enforces `transports: ["polling", "websocket"]` — no WebTransport
  2. Both pages defer socket init via `setTimeout(..., 0)` — page renders immediately, socket connects in background
  3. "🔄 Connecting..." shown instantly before socket connects
  4. `connect_error` handler displays error message
  5. `Cache-Control: no-store` header on HTML pages — prevents iOS Safari caching
  6. Socket.IO client JS served locally from `node_modules/socket.io/client-dist/` as static file (`/socket.io.js`) — Express sets `Content-Length` header instead of Socket.IO's `Transfer-Encoding: chunked`, which iOS 15 Safari can hang on
  7. Both pages reference `/socket.io.js` instead of `/socket.io/socket.io.js`

### Problems Encountered

**"Loading forever" on iPhone 7 (iOS 15 Safari):**
- Symptom: Page never finishes loading on iPhone 7, but works on iPhone 14 (both same WiFi)
- Root cause: THREE separate issues compounding:
  1. Socket.IO 4.8.3 offers WebTransport protocol by default — iOS 15's JavaScript engine hangs during the WebTransport handshake negotiation because the protocol check never properly resolves
  2. Socket.IO serves the client JS bundle with `Transfer-Encoding: chunked` and no `Content-Length` — iOS 15 Safari waits indefinitely for more chunks, never firing the script's `load` event
  3. The inline script block contained ALL socket initialization code synchronously — the `io()` connection blocked the page load event
- Fix: All three addressed (transport restriction, static file serving with Content-Length, deferred socket init)

**mDNS/Bonjour `.local` hostname not resolving on iPhone 7:**
- `RDFX1-macbook-pro.local` resolves correctly on MacBook and iPhone 14, not on iPhone 7
- Root cause: Some routers don't forward mDNS multicast packets properly between WiFi clients; iOS 15 handles mDNS resolution differently than iOS 17+
- Solution: Multiple approaches tried:
  - `dns-sd -R` service registration with hostname → "Name now registered and active" but still no resolution from iPhone 7
  - `dns-sd -P` proxy registration → rejected with "Name in use" (hostname already registered by macOS)
  - Ultimately accepted that `.local` resolution is network-dependent; QR code is the reliable fallback

**launchd KeepAlive respawning conflicts:**
- When server was killed with `pkill -f "node server"`, launchd auto-restarted the old server with old code
- New server couldn't bind to port 3000 (EADDRINUSE) because launchd-managed process held it
- Fix: Always `launchctl unload` before `pkill`, then re-load after update

**Server IP changes between sessions (DHCP):**
- Mac's LAN IP changed from 192.168.0.124 to 192.168.0.191 between test sessions
- QR code at startup handles this per-session
- Permanent solution: DHCP reservation on router

### Architecture decisions

| Decision | Rationale |
|----------|-----------|
| MIDI for Mobius commands | Mobius listens for MIDI CC, not OSC |
| System dns-sd over bonjour-service npm | Zero CPU overhead (uses mDNSResponder daemon), no JS mDNS stack |
| Static file for socket.io.js | Content-Length header instead of chunked encoding; fixes iOS 15 hang |
| launchd KeepAlive over polling watchdog | Kernel-level process monitoring via mach ports — zero CPU |
| QR code in terminal at startup | Works on any network, any device, no infra required |
| Per-client context Map in server | Allows context-aware knob routing per connected iPhone |
| Socket init deferred via setTimeout(0) | Page renders immediately even if WebSocket hangs |

### Files changed this session

- `web/server.js` — MIDI output (easymidi), Mobius CC map, Alesis knob context, dns-sd Bonjour, QR code generation, client monitoring, launchd integration, transport restriction, cache-control, static socket.io.js route, "/api/clients" endpoint
- `web/public/client.js` — sendAction queue + drainActionQueue (fix socket leak)
- `web/public/index.html` — deferred Socket.IO init, fxSelected event, connect_error handler, transport restriction
- `web/public/display.html` — deferred Socket.IO init, transport restriction
- `web/public/style.css` — documentation comments added (no visual changes)
- `runner/runner.lua` — _collectSynthData(), _collectLoopStates(), SYNTH_PATTERNS
- `runner/bridge.lua` — publish() accepts synthData + loopStates params
- `gui/app.lua` — LAUNCH PERFORMANCE auto-starts server via control.sh
- `tools/launch_performance.lua` — auto-starts server, shows Bonjour URL in dialog
- `web/control.sh` — NEW: start/stop/status CLI for launchd-managed server
- `web/com.liveshowmanager.bridge.plist` — NEW: launchd service definition
- `web/package.json` — added easymidi dependency
- `README.md` — updated with Mobius/MIDI/Alesis/launchd setup docs, QR code, Bonjour URL
- `PROJECT_LOG.md` — this entry

### Next
- Test end-to-end with real REAPER project + Mobius + iPhone on WiFi
- Mobius loop state feedback parsing (MIDI CC → loopStates in bridge)
- Alesis V25 physical knob → REAPER FX param binding via REAPER's MIDI Learn
- Add song navigation (prev/next jumps within setlist)
- Build remaining tab data sources (full loopState with MIDI feedback)
