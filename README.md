# Live Show Manager

REAPER ReaScript for live performance: manage a song library, build setlists, generate show projects, and run the show with an iPhone control surface + stage display.

## Quick Start

### Setup

```bash
# Install Node.js (one-time)
brew install node

# Install web server dependencies (one-time)
cd web
npm install
```

### Run

1. **Open REAPER**, run `main.lua` (Actions > Load ReaScript)
2. **Build a setlist** using the Add/Remove/Save buttons
3. Click **"▶ LAUNCH PERFORMANCE"** (green button)
   — this automatically starts the web server and the performance runner
4. **Open iPhone** Safari at:
   ```
   http://RDFX1-macbook-pro.local:3000/
   ```
   (mDNS Bonjour — works on any WiFi network, Mac's IP doesn't matter)
5. Tap **"Add to Home Screen"** on iPhone for fullscreen/kiosk mode
6. **Stage display** at `http://RDFX1-macbook-pro.local:3000/display.html`

### Server Auto-Startup

The "LAUNCH PERFORMANCE" button starts the bridge server via macOS launchd.
**launchd** uses kernel-level process monitoring (mach ports, not polling):
- **Zero CPU overhead** when the server is running
- **Auto-restarts** the server if it crashes (KeepAlive)
- **Logs** to `web/logs/server.log`

Manual control if needed:
```bash
cd web
./control.sh start      # Start server (with auto-restart)
./control.sh stop       # Stop server
./control.sh status     # Check if server is running
./control.sh direct     # Start in foreground (debug mode)
```

## One-Time REAPER Configuration

### 1. OSC Control Surface (required for transport control from iPhone)

```
Preferences > Control Surfaces > Add "OSC (Open Sound Control) control surface"
  Mode: Control Surface for OSC
  Local listen port: 8000          ← REAPER listens here for server commands
  Destination: 127.0.0.1:9000      ← REAPER sends feedback here
```

Without this, the transport (play/stop/next) and FX parameter buttons won't work.

### 2. Mobius MIDI Routing (required for loop control from iPhone)

The server creates a virtual MIDI port called **"Live Show Manager"**.

1. In REAPER: Preferences > MIDI Devices
2. Find "Live Show Manager" in the list — right-click > **Enable** as MIDI input
3. Route this input to the track containing Mobius (set track MIDI input to "Live Show Manager" or "All MIDI Inputs")
4. In Mobius 3, verify CC assignments match the defaults:

| Command  | CC | iPhone Button |
|----------|----|---------------|
| Record   | 20 | ● REC        |
| Play     | 21 | ▶ PLAY       |
| Overdub  | 22 | ◉ OVD        |
| Multiply | 23 | × MUL        |
| Mute     | 24 | M MUTE       |
| Reset    | 25 | ⎚ ALL RESET  |
| Undo     | 26 | ↩ ALL UNDO   |

These are configurable in Mobius > Preferences > MIDI > Control Output Bindings.

### 3. Alesis V25 Knobs (optional, for physical knob control)

The 4 physical knobs on the Alesis V25 sit directly below the iPhone screen bottom.
Configure each knob on the V25 to send a unique MIDI CC:

| Knob | Default CC | Suggested |
|------|------------|-----------|
| 1    | CC 74 (Cutoff) | **CC 70** |
| 2    | CC 71 (Resonance) | **CC 71** |
| 3    | CC 7 (Volume) | **CC 72** |
| 4    | CC 10 (Pan) | **CC 73** |

To configure (see V25 manual):
1. Press EDIT, press the knob to assign
2. Turn the VALUE knob to select "Control Change"
3. Set the CC number to match above
4. Press EDIT to save

Then in REAPER, use the FX window "Learn" button to bind these CCs to any parameter.

The iPhone shows context-sensitive labels above each knob. Labels change per tab:
- **FX tab**: Shows top 4 parameters when an FX is selected
- **Mix tab**: Volume for first 4 tracks
- **Loops tab**: Record/Overdub/Play/Stop
- **Synths tab**: Preset/Cutoff/Resonance/Level
- **Stats/Show tabs**: No knob labels

## Architecture

```
MacBook (lid closed during performance)
├── REAPER + Mobius        ← audio/MIDI engine
├── Lua Runner             ← show tracking, region sync, synth detection
└── Node.js Web Server     ← HTTP + WebSocket + OSC + MIDI bridge
     │
     ├── iPhone 7           ← CONTROL: transport, FX, mix, loops, synths
     │   (Safari, "Add to Home Screen" fullscreen, 6 tab pages)
     │
     └── Stage Display      ← FEEDBACK: lyrics, levels, loop states, countdown
         (secondary monitor / teleprompter)
```

### Data Flow

```
REAPER ←OSC→ Web Server ←file→ Lua Runner (bridge_state.json)
                   ↕ WebSocket
             iPhone + Stage Display

REAPER ←MIDI→ Web Server (Mobius CC commands via virtual port)
Alesis V25 →MIDI→ REAPER (physical knobs, then learn binds to params)
```

## Project Structure

| Path | Purpose |
|------|---------|
| `main.lua` | Entry point + module loader |
| `backend/` | Util, filesystem, JSON, library scan, song CRUD, audio import |
| `models/` | Song, setlist, show data models |
| `builders/` | Region calculator, MIDI cue builder, show project generator |
| `gui/` | REAPER ImGui interface (edit mode: library + setlist management) |
| `runner/` | Performance engine: runner state machine + JSON bridge |
| `tools/` | Standalone REAPER action scripts |
| `web/` | Node.js server + iPhone + stage display frontend |
| `data/` | Saved setlists, cache, bridge state |

## Tab Pages (iPhone Controller)

| Tab | Function |
|-----|----------|
| **Show** | Current song, progress bar, transport, PANIC button |
| **FX** | Track FX list → tap to drill into up to 8 parameters |
| **Mix** | Vertical faders per track, color-coded levels, mute/solo |
| **Loops** | LoopyPro-style Mobius loop cards with SVG progress rings |
| **Synths** | Synth track cards with current preset name |
| **Stats** | Connection health, show name, position, BPM, uptime |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| iPhone can't connect | Check Mac firewall, use LAN IP not localhost |
| Transport buttons don't work | Configure REAPER OSC control surface (see above) |
| "No Show Loaded" on iPhone | Click LAUNCH PERFORMANCE in REAPER |
| Mobius buttons don't work | Enable "Live Show Manager" MIDI port in REAPER and route to Mobius track |
| Server says EADDRINUSE | Port conflict — use: `node server.js --port 3001 --oscIn 9001 --oscOut 8001` |
| Track levels empty | Lua runner not running or no tracks in project |
| Synths tab empty | No VSTi/synth plugins found on any track |
| MIDI port not showing in REAPER | Restart REAPER after starting the server; check `node server.js` first |

## Stage HUD — Importing Songs for Saturday

The HUD needs a `song.chopro` file per song for the 3-line rolling lyrics engine.

### Your songs already have chordpro if they're in this list:
- `Summer of 69` — full chords √
- `Gravity` — full chords √
- `Beds Are Burning` — full chords √

### All other songs got auto-generated lyrics-only chordpro:
Run `node tools/generate-chordpro.js` to regenerate from `meta.json` lyrics.
These have **no chords** — just lyrics. The HUD will show them without chord brackets.

### To add chords via Ultimate Guitar (easiest way for Saturday):
1. Go to `https://ultimate.ftes.de/` (free UG-to-ChordPro converter)
2. Open Ultimate Guitar tab for any song
3. Copy the chord sheet (the chords-over-lyrics format)
4. Paste into the converter → copy the ChordPro output
5. Save to `~/ReaperSongs/<Song Folder>/song.chopro`
6. The converter will handle `{start_of_chorus}` and `[A]` bracket conversion

### Or: paste from e-chords.com directly into a .chopro file:
1. Go to `https://www.e-chords.com/` and search for the song
2. Copy the chord/lyrics text
3. Convert using the online tool above, paste result into `song.chopro`
4. Add `{title:}`, `{artist:}`, `{key:}` header directives manually

## Key Decisions

- **Node.js over Python** — native WebSocket, single dep install
- **Socket.IO over raw WS** — auto-reconnect, multi-device rooms
- **OSC over MIDI for REAPER** — REAPER native bidirectional control
- **MIDI for Mobius** — Mobius listens for MIDI CC, not OSC
- **Web UI over native app** — iterate in minutes, same API for SwiftUI port later
- **Lua file bridge** — REAPER Lua can't speak WebSocket; JSON file polling is simple and reliable
