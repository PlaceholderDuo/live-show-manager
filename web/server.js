// Live Show Manager — Web Bridge Server
// -----------------------------------------
// What this does:
//   1. Serves the iPhone controller UI at http://<mac>:3000/
//   2. Serves the stage display at http://<mac>:3000/display.html
//   3. Maintains a WebSocket (Socket.IO) connection to all browser clients
//   4. Bridges commands from the iPhone → REAPER via OSC (Open Sound Control)
//   5. Bridges Mobius commands from iPhone → REAPER via MIDI CC
//   6. Maintains per-client knob context for Alesis V25 routing
//   7. Polls data/bridge_state.json (written by the Lua runner) and pushes
//      state to all connected browsers in real-time
//
// Data flow:
//   REAPER ←OSC→ Server ←file→ Lua Runner (runner/bridge.lua)
//                    ↕ WebSocket
//              iPhone + Stage Display
//   REAPER ←MIDI→ Server (Mobius CC commands)
//   Alesis V25 →MIDI→ REAPER (physical knobs, then OSC feedback to us)
//
// Startup:
//   node server.js              (default: port 3000, OSC in 9000, OSC out 8000)
//   node server.js --port 3001  (custom port)
//
// First-time REAPER setup (required for iPhone → REAPER transport control):
//   Preferences > Control Surfaces > Add "OSC (Open Sound Control) control surface"
//   Local listen port: 8000          ← REAPER listens here for our commands
//   Destination: 127.0.0.1:9000      ← REAPER sends feedback here
//
// Mobius setup (required for loop control from iPhone):
//   See README.md: Mobius 3 defaults to CC 20-26 for Record/Play/Overdub/etc.
//   Route the "Live Show Manager" virtual MIDI port to Mobius track in REAPER.
//
// Alesis V25 setup:
//   Configure 4 knobs to send CC 70, 71, 72, 73 (see V25 manual).
//
// Troubleshooting:
//   - "iPhone can't connect": Check Mac firewall, use Mac's LAN IP not localhost
//   - "Transport buttons don't work": REAPER OSC control surface not configured
//   - "No song data showing": Lua runner not running (click LAUNCH PERFORMANCE)
//   - "Mobius buttons don't work": MIDI port not created / not routed to Mobius track
//   - "OSC Error: EADDRINUSE": Port 9000 or 8000 is in use

const express = require("express");
const http = require("http");
const { Server: SocketIOServer } = require("socket.io");
const osc = require("osc");
const easymidi = require("easymidi");
const os = require("os");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════
const args = process.argv.slice(2);
const PORT = parseInt(args[args.indexOf("--port") + 1], 10) || 3000;
const OSC_IN_PORT = parseInt(args[args.indexOf("--oscIn") + 1], 10) || 9000;
const OSC_OUT_PORT = parseInt(args[args.indexOf("--oscOut") + 1], 10) || 8000;
const OSC_OUT_HOST = "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const REAPER_SONGS_PATH = path.join(os.homedir(), "ReaperSongs");
const BUMPER_DIR = path.join(os.homedir(), "bumper-music");
const BUMPER_VOLUME_FILE = path.join(os.homedir(), ".bumper-volume");

function loadBumperVolume() {
  try { return parseFloat(fs.readFileSync(BUMPER_VOLUME_FILE, "utf-8").trim()) || 0.2; }
  catch { return 0.2; }
}
function saveBumperVolume(v) {
  fs.writeFileSync(BUMPER_VOLUME_FILE, String(v), "utf-8");
}
let bumperVolume = loadBumperVolume();

// ═══════════════════════════════════════════════════════════
// BUMPER MUSIC ENGINE (on-demand, zero resources when idle)
// ═══════════════════════════════════════════════════════════
let bumperProcess = null;
let bumperPlaying = false;
let bumperPlaylist = [];
let bumperIndex = 0;
let bumperScanned = false;
let bumperGracefulStop = false;
let bumperExplicitStop = false;

function scanBumperMusic() {
  try {
    const files = fs.readdirSync(BUMPER_DIR)
      .filter(f => /\.(m4a|mp3|wav)$/i.test(f))
      .sort(() => Math.random() - 0.5);
    bumperPlaylist = files.map(f => path.join(BUMPER_DIR, f));
    bumperScanned = true;
    if (bumperPlaylist.length === 0) console.warn("[Bumper] No music files in", BUMPER_DIR);
  } catch (e) {
    console.warn("[Bumper] Cannot read dir:", e.message);
    bumperPlaylist = [];
    bumperScanned = true;
  }
}

function bumperPlay(trackPath) {
  bumperStop();
  bumperExplicitStop = false;
  if (!bumperScanned) scanBumperMusic();
  if (!trackPath || !fs.existsSync(trackPath)) {
    if (bumperPlaylist.length === 0) { if (!bumperScanned) scanBumperMusic(); if (bumperPlaylist.length === 0) return; }
    bumperIndex = bumperIndex % bumperPlaylist.length;
    trackPath = bumperPlaylist[bumperIndex];
  }
  console.log("[Bumper] Play", path.basename(trackPath));
  bumperProcess = cp.spawn("afplay", ["-v", String(bumperVolume), trackPath], { stdio: "ignore" });
  bumperPlaying = true;
  bumperProcess.on("exit", () => {
    bumperPlaying = false;
    bumperProcess = null;
    if (bumperExplicitStop) {
      bumperExplicitStop = false;
    } else if (bumperGracefulStop) {
      bumperGracefulStop = false;
    } else {
      bumperIndex = (bumperIndex + 1) % bumperPlaylist.length;
      bumperPlay(null);
    }
    broadcastBumperStatus();
  });
  broadcastBumperStatus();
}

function bumperStop() {
  if (bumperProcess) {
    bumperProcess.removeAllListeners("exit");
    bumperProcess.kill();
    bumperProcess = null;
  }
  bumperPlaying = false;
  bumperGracefulStop = false;
  bumperExplicitStop = true;
  broadcastBumperStatus();
}

function bumperStopGraceful() {
  if (bumperPlaying) {
    bumperGracefulStop = true;
    console.log("[Bumper] Will stop after current track");
  }
  broadcastBumperStatus();
}

function bumperToggle() {
  if (bumperPlaying) bumperStop(); else bumperPlay(null);
}

function bumperSkip() {
  if (!bumperScanned) scanBumperMusic();
  if (bumperPlaylist.length === 0) return;
  bumperIndex = (bumperIndex + 1) % bumperPlaylist.length;
  if (bumperPlaying) bumperPlay(bumperPlaylist[bumperIndex]);
}

function getBumperStatus() {
  return {
    type: "bumper_status",
    playing: bumperPlaying,
    currentTrack: bumperPlaying && bumperPlaylist[bumperIndex]
      ? path.basename(bumperPlaylist[bumperIndex]).replace(/\.[^.]+$/, "")
      : null,
    queueSize: bumperScanned ? bumperPlaylist.length : 0,
    volume: Math.round(bumperVolume * 100)
  };
}

function broadcastBumperStatus() {
  io.emit("bumper_status", getBumperStatus());
}

// ═══════════════════════════════════════════════════════════
// MIDI OUTPUT (for Mobius loop control)
// ═══════════════════════════════════════════════════════════
// Creates a virtual MIDI output port that appears in REAPER's MIDI device list.
// Route this to the Mobius track in REAPER.
let midiOut;
try {
  midiOut = new easymidi.Output("Live Show Manager", true);
  console.log("[MIDI] Created virtual port 'Live Show Manager'");
} catch (err) {
  console.warn("[MIDI] Could not create MIDI output:", err.message);
  console.warn("[MIDI] Mobius loop control will be unavailable");
  midiOut = null;
}

// Mobius 3 default MIDI CC mapping (configurable in Mobius settings)
const MOBIUS_CC = {
  record: 20,
  play: 21,
  overdub: 22,
  multiply: 23,
  mute: 24,
  reset: 25,
  undo: 26,
};

// ═══════════════════════════════════════════════════════════
// MIDI INPUT (ReaTune pitch detection → iPhone tuner)
// ═══════════════════════════════════════════════════════════
// ReaTune sends MIDI note + pitch bend when "Send MIDI events
// when pitch changes" is enabled. This listener converts those
// to the tuner OSC format and relays to iPhone via WebSocket.
// Clears tuner after 1.5s of silence (no note detected).
let midiIn = null;
let tunerCurrentNote = null;
let tunerLastUpdate = 0;
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

function detectString(midiNote) {
  const strings = [
    { name: "6 (low E)", midi: 40 },
    { name: "5 (A)",     midi: 45 },
    { name: "4 (D)",     midi: 50 },
    { name: "3 (G)",     midi: 55 },
    { name: "2 (B)",     midi: 59 },
    { name: "1 (high E)",midi: 64 },
  ];
  let best = strings[0], bestDist = Math.abs(midiNote - best.midi);
  for (const s of strings) {
    const d = Math.min(Math.abs(midiNote - s.midi), Math.abs(midiNote - s.midi - 12));
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best.name;
}

function noteName(midiNote) {
  if (midiNote == null) return "--";
  return NOTE_NAMES[midiNote % 12] + (Math.floor(midiNote / 12) - 1);
}

function emitTuner(note, cents, freq, str) {
  state.tuner = { note, cents, frequency: freq, string: str };
  io.emit("tuner", state.tuner);
  tunerLastUpdate = Date.now();
}

setInterval(() => {
  if (state.tuner && state.tuner.note !== "--" && Date.now() - tunerLastUpdate > 1500) {
    emitTuner("--", 0, 0, "");
  }
}, 500);

try {
  midiIn = new easymidi.Input("Live Show Manager Tuner", true);
  console.log("[MIDI In] Listening on 'Live Show Manager Tuner'");

  midiIn.on("noteon", (msg) => {
    if (msg.velocity > 0) {
      console.log("[Tuner] NOTEON:", noteName(msg.note), "midi=" + msg.note);
      tunerCurrentNote = msg.note;
      const freq = 440 * Math.pow(2, (msg.note - 69) / 12);
      emitTuner(noteName(msg.note), 0, freq, detectString(msg.note));
    }
  });

  midiIn.on("pitch", (msg) => {
    console.log("[Tuner] PITCH BEND: value=" + msg.value + " (center=8192)");
    if (tunerCurrentNote == null) return;
    const cents = ((msg.value - 8192) / 8192) * 200;
    const freq = 440 * Math.pow(2, (tunerCurrentNote - 69 + cents / 100) / 12);
    emitTuner(noteName(tunerCurrentNote), Math.round(cents * 10) / 10, freq, detectString(tunerCurrentNote));
  });

} catch (err) {
  console.warn("[MIDI In] Could not create input:", err.message);
}

// Alesis V25 knob CC assignments (configure on V25 hardware)
const ALESIS_CC = { 1: 70, 2: 71, 3: 72, 4: 73 };

function sendMIDI(cc, value, channel) {
  if (!midiOut) return;
  try {
    midiOut.send("cc", {
      controller: cc,
      value: Math.min(127, Math.max(0, Math.round((value || 1) * 127))),
      channel: (channel || 1) - 1,
    });
  } catch (err) {
    console.error("[MIDI] Send error:", err.message);
  }
}

function mobiusAction(action) {
  const cc = MOBIUS_CC[action];
  if (cc !== undefined) {
    sendMIDI(cc, 127);
    console.log("[MIDI] Mobius:", action, "→ CC", cc);
  } else {
    console.warn("[MIDI] Unknown Mobius action:", action);
  }
}

// ═══════════════════════════════════════════════════════════
// STATE (single source of truth on the server side)
// ═══════════════════════════════════════════════════════════
const state = {
  connected: false,
  playing: false,
  position: 0,
  duration: 0,
  bpm: 120,
  currentSong: null,
  songId: null,
  nextSong: null,
  songIndex: 0,
  totalSongs: 0,
  currentKey: null,
  currentArtist: null,
  trackLevels: [],
  loopStates: {},
  notes: "",
  elapsed: "0:00",
  remaining: "0:00",
  regions: [],
  sections: [],
  lyricSync: { ok: true, annotatedPct: 100, totalLines: 0, annotatedLines: 0, warnings: [] },
  // OSC feedback from REAPER (track volumes, FX params, tuner data, etc.)
  trackVolumes: {},       // { trackIdx: dB }
  trackMutes: {},         // { trackIdx: true/false }
  trackNames: {},         // { trackIdx: "name" }
  fxParams: {},           // { "track-fx-param": value }
  tuner: null,            // { note: "A", cents: -3.2, frequency: 438.7, string: "A (5)" }
  activeAmpPreset: "OSD",
  activeScene: 0,
  keysOn: true,
  mixerValues: {},
  setlist: [],        // EDM knob values relayed from ReaLearn → REAPER → here
};

// Per-client context for knob routing
const clientContexts = new Map();

// Tap tempo accumulator
let tapTimes = [];

// ── Song sections: derived from meta.json lyrics array ──
// Converts bar-positioned lyric entries to timed sections.
// Uses ChordPro {start_of_verse/chorus/solo} directives for accurate
// section type detection instead of keyword matching on lyric text.
// Falls back to keyword detection if no ChordPro file is available.

// ── ChordPro directive parser ──
// Extracts ordered section types and labels from ChordPro text directives.
// Returns [{type, label, lines}]. Handles instrumental sections (empty lines
// inside directive blocks, like {start_of_solo} ... {end_of_solo} with
// only chord content).
function parseChoproDirectiveSections(text) {
  const sections = [];
  const rawLines = (text || "").split("\n");
  let currentType = "verse";
  let currentLabel = "";
  let currentLines = [];
  let inSection = false; // tracks whether inside a start_of/end_of block

  function flushSection() {
    if (!inSection) return;
    sections.push({ type: currentType, label: currentLabel, lines: currentLines });
    currentLines = [];
    inSection = false;
  }

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("{")) {
      const isEnd = /^\{end_of_/i.test(trimmed);
      if (isEnd) { flushSection(); continue; }

      const match = trimmed.match(/^\{([^:]+)(?::\s*(.+))?\}$/);
      if (match) {
        const name = match[1].trim().toLowerCase();
        const val = (match[2] || "").trim();

        if (name.includes("start_of_verse")) {
          flushSection();
          currentType = "verse";
          currentLabel = val || "Verse";
          inSection = true;
        } else if (name.includes("start_of_chorus")) {
          flushSection();
          currentType = "chorus";
          currentLabel = val || "Chorus";
          inSection = true;
        } else if (name.includes("start_of_solo")) {
          flushSection();
          currentType = "solo";
          currentLabel = val || "Solo";
          inSection = true;
        } else if (name.includes("start_of_pre-chorus") || name.includes("start_of_prechorus")) {
          flushSection();
          currentType = "pre-chorus";
          currentLabel = val || "Pre-Chorus";
          inSection = true;
        } else if (name.includes("start_of_bridge")) {
          flushSection();
          currentType = "bridge";
          currentLabel = val || "Bridge";
          inSection = true;
        } else if (name.includes("start_of_intro")) {
          flushSection();
          currentType = "intro";
          currentLabel = val || "Intro";
          inSection = true;
        } else if (name.includes("start_of_outro")) {
          flushSection();
          currentType = "outro";
          currentLabel = val || "Outro";
          inSection = true;
        } else if (name.includes("start_of_interlude")) {
          flushSection();
          currentType = "interlude";
          currentLabel = val || "Interlude";
          inSection = true;
        }
        // metadata directives like {title: ...} don't set inSection
      }
      continue;
    }

    // Content line — strip chord brackets and emoji for matching
    // Always accumulate lines inside a section, even if they're empty after
    // stripping. If not inside a section, auto-start one (handles legacy
    // chordpro files that put all lyrics after a single {end_of_verse}).
    if (!inSection) {
      inSection = true; // auto-start section for orphan lines
      currentLabel = currentLabel || "Section";
    }
    const cleaned = trimmed.replace(/\[([^\]]+)\]/g, "").replace(/[🎸🗿👍]/gu, "").trim();
    currentLines.push(cleaned);
  }

  flushSection();

  // Refine types based on label text — handles cases like
  // {start_of_verse: Intro} → type intro  instead of verse
  for (const sec of sections) {
    const lowerLabel = (sec.label || "").toLowerCase();
    if (lowerLabel.includes("intro") && sec.type === "verse") sec.type = "intro";
    else if (lowerLabel.includes("outro") && sec.type === "verse") sec.type = "outro";
    else if (lowerLabel.includes("bridge") && sec.type === "verse") sec.type = "bridge";
    else if (lowerLabel.includes("solo") && sec.type === "verse") sec.type = "solo";
    else if ((lowerLabel.includes("pre-chorus") || lowerLabel.includes("prechorus")) && sec.type === "verse") sec.type = "pre-chorus";
  }

  return sections;
}

// ── Lyric line extractor (for phone teleprompter) ──
// Extracts content lines from chordpro with @time=N / @bar=N annotations
// for client-side rendering. Returns [{time, bar, text, type}] where type
// is "lyric" or "solo". @time=N (seconds) preferred over @bar=N (bars).
// Lines without either get time=null, bar=null and the client estimates position.
function extractLyricLines(choproText) {
  const lines = [];
  const rawLines = (choproText || "").split("\n");

  function isDirective(s) { return /^\{/.test(s.trimStart()); }
  function isBareChord(s) {
    let trimmed = s.trim();
    if (!trimmed) return false;
    // Unwrap /slash/ chord markers: /Am7/ /Dm7/ → Am7 Dm7
    if (trimmed.charAt(0) === '/' && trimmed.lastIndexOf('/') === trimmed.length - 1) {
      trimmed = trimmed.substring(1, trimmed.length - 1).trim();
    }
    const words = trimmed.split(/\s+/);
    const chordLike = words.filter(w => /^[A-G][#b]?(?:m7?|dim|aug|sus[24]|add\d+|5|7b?9?|maj7?|min7?|dim7?|aug7?|6|9|11|13)?(?:\/[A-G][#b]?)?$/.test(w));
    return chordLike.length >= words.length * 0.7 && chordLike.length > 0;
  }
  function stripChords(s) {
    // Strip [bracket] chords and /slash/ chord markers
    return s.replace(/\[.*?\]/g, "").replace(/\/[A-G][#b]?(?:m7?|dim|aug|sus[24]|add\d+|5|7b?9?|maj7?|min7?|dim7?|aug7?|6|9|11|13)?(?:\/[A-G][#b]?)?\//g, "").trim();
  }

  let inSolo = false;

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed || isDirective(trimmed)) {
      const lower = trimmed.toLowerCase();
      if (lower.includes("start_of_solo")) { inSolo = true; }
      else if (lower.includes("end_of_solo")) { inSolo = false; }
      else if (lower.includes("start_of")) { inSolo = false; }
      continue;
    }
    if (/^##\s/.test(trimmed)) continue;
    if (isBareChord(trimmed)) continue;

    // Extract @time=N (preferred) and @bar=N (legacy fallback)
    let time = null;
    let bar = null;
    let clean = stripChords(trimmed);

    // Old prefix format: @time=N @bar=N
    const timeMatch = clean.match(/@time\s*=\s*([\d]+\.?\d*)/i);
    if (timeMatch) {
      const t = parseFloat(timeMatch[1]);
      if (!isNaN(t)) time = t;
      clean = clean.replace(/@time\s*=\s*[\d]+\.?\d*/i, "");
    }

    const barMatch = clean.match(/@bar\s*=\s*(\d+)/i);
    if (barMatch) {
      const b = parseInt(barMatch[1], 10);
      if (!isNaN(b)) bar = b;
      clean = clean.replace(/@bar\s*=\s*\d+/i, "");
    }

    // New format trailing @N.N (after stripping @time/@bar, before stripping remaining)
    if (time === null) {
      const trailMatch = clean.match(/\s@([\d]+\.?\d{1,2})\s*$/);
      if (trailMatch) {
        const t = parseFloat(trailMatch[1]);
        if (!isNaN(t)) time = t;
        clean = clean.replace(/\s@[\d]+\.?\d{1,2}\s*$/, "");
      }
    }

    // Strip any remaining @\w+=\S+ annotations
    clean = clean.replace(/@\w+=\S+/g, "").trim();
    // Strip embedded ## section headers (mixed-format files)
    clean = clean.replace(/##\s+[^@]*?(?:\s*@[\d.]+)?$/, "").trim();

    if (!clean) continue;

    // Skip metadata lines
    const lower = clean.toLowerCase();
    if (/^(song|artist|tuning|capo|tabbed|standard|no chords|let ring|palm mute)[:\s]/i.test(lower)) continue;

    lines.push({ time, bar, text: clean, type: inSolo ? "solo" : "lyric" });
  }

  return lines;
}

// ── Section type from meta text (fallback when no ChordPro) ──
const SECTION_TYPES = [
  { match: "intro", type: "intro" },
  { match: "solo", type: "solo" },
  { match: "outro", type: "outro" },
  { match: "chorus", type: "chorus" },
  { match: "bridge", type: "bridge" },
  { match: "pre-chorus", type: "pre-chorus" },
  { match: "interlude", type: "interlude" },
];

function detectSectionType(text) {
  const lower = (text || "").toLowerCase();
  for (const t of SECTION_TYPES) {
    if (lower.includes(t.match)) return t.type;
  }
  return "verse";
}

// ── Match meta entries to ChordPro sections by progressive text + bar proximity ──
// Scans forward through ChordPro sections. Checks the last-matched section first
// (within expected bar span) to handle continuations, then scans forward.
// When text doesn't match, advances to next section.
function createProgressiveMatcher(choproSections, totalBars) {
  let choproIdx = 0;
  let lastMatchedIdx = -1;
  const totalContentLines = choproSections.reduce((sum, cs) => sum + Math.max(cs.lines.length, 1), 0);

  function linesMatch(metaStart, cs) {
    for (const line of cs.lines) {
      const cleanLine = line.replace(/[^a-zA-Z0-9\s']/g, "").trim().toLowerCase();
      const lineStart = cleanLine.substring(0, 30);
      // Check prefix match OR substring match (handles cases where [Chord] 
      // wrapping around a word strips it, e.g. [Ain't] no use → "no use")
      if (lineStart && (metaStart.startsWith(lineStart) || lineStart.startsWith(metaStart) || metaStart.includes(lineStart))) {
        return true;
      }
    }
    return false;
  }

  // Track actual bar positions from meta entries that first matched each section
  const sectionStartBars = {};

  return function matchNext(metaText, metaBar) {
    if (!choproSections || choproSections.length === 0) return null;
    if (choproIdx >= choproSections.length) {
      return choproSections[choproSections.length - 1];
    }

    if (metaText) {
      const cleanMeta = metaText.replace(/[^a-zA-Z0-9\s']/g, "").trim().toLowerCase();
      const metaStart = cleanMeta.substring(0, 30);

      if (metaStart) {
        // Step 1: Check last-matched section first (handles same-section continuations)
        if (lastMatchedIdx >= 0 && lastMatchedIdx < choproSections.length) {
          const cs = choproSections[lastMatchedIdx];
          const actualStartBar = sectionStartBars[lastMatchedIdx] !== undefined
            ? sectionStartBars[lastMatchedIdx]
            : (lastMatchedIdx / Math.max(choproSections.length, 1)) * (totalBars || 128);
          const sectionSpan = (Math.max(cs.lines.length, 1) / Math.max(totalContentLines, 1)) * (totalBars || 128);
          if (metaBar >= actualStartBar && metaBar <= actualStartBar + sectionSpan * 1.5) {
            if (linesMatch(metaStart, cs)) {
              choproIdx = Math.max(choproIdx, lastMatchedIdx + 1);
              return cs; // stay on same section (continuation)
            }
          }
        }

        // Step 2: Search forward from current position
        for (let ci = choproIdx; ci < choproSections.length; ci++) {
          const cs = choproSections[ci];
          if (linesMatch(metaStart, cs)) {
            if (sectionStartBars[ci] === undefined) {
              sectionStartBars[ci] = metaBar; // record actual start bar
            }
            lastMatchedIdx = ci;
            choproIdx = ci + 1;
            return cs;
          }
        }
      }
    }

    // Step 3: No text match — advance
    const cs = choproSections[Math.min(choproIdx, choproSections.length - 1)];
    if (sectionStartBars[choproIdx] === undefined) {
      sectionStartBars[choproIdx] = metaBar;
    }
    lastMatchedIdx = choproIdx;
    choproIdx = Math.min(choproIdx + 1, choproSections.length);
    return cs;
  };
}

// ── Short token for section type with sequence count ──
// e.g. [V1], [C1], [S], [I], [B], [O]
function getSectionToken(type, verseCount, chorusCount, preChorusCount) {
  const t = (type || "").toLowerCase();
  if (t === "intro") return "[I]";
  if (t === "verse") return "[V" + verseCount + "]";
  if (t === "chorus") return "[C" + chorusCount + "]";
  if (t === "pre-chorus") return "[P" + preChorusCount + "]";
  if (t === "solo") return "[S]";
  if (t === "bridge") return "[B]";
  if (t === "outro") return "[O]";
  if (t === "interlude") return "[I]";
  return "[V" + verseCount + "]";
}

// ── Compute sections from meta.json + ChordPro directives ──
// Uses ChordPro for accurate types/labels, meta.json for bar positions.
// When meta.lyrics is sparse (≤2 entries) but chordpro has many directive
// sections, generates sections directly from the chordpro directives
// with proportional bar distribution — giving the Metro Map timeline
// enough blocks to be useful.
function computeSections(bpm, lyrics, choproText, durationBars) {
  if (!lyrics || !bpm || bpm <= 0) return [];

  const choproSections = parseChoproDirectiveSections(choproText);

  if (choproSections.length <= 2) {
    // ChordPro also has few sections — use meta-only approach below
  } else if (lyrics.length <= 2) {
    // Meta is sparse but chordpro is rich — generate from chordpro directives
    return sectionsFromChordpro(choproSections, bpm, lyrics, durationBars);
  }

  const totalBars = durationBars || Math.max(...lyrics.map(e => e.bar), 128) + 8;
  const matchNext = createProgressiveMatcher(choproSections, totalBars);

  const sections = [];
  let verseCount = 0;
  let chorusCount = 0;
  let preChorusCount = 0;
  let lastChoproIdx = -1;

  for (let i = 0; i < lyrics.length; i++) {
    const entry = lyrics[i];
    const time = ((entry.bar - 1) * 4 * 60) / bpm;

    const matched = matchNext(entry.text, entry.bar);
    const matchedIdx = matched ? choproSections.indexOf(matched) : -1;
    let type = (matched && matched.type) || detectSectionType(entry.text);
    let text = (matched && matched.label) || entry.text.replace(/^[^a-zA-Z0-9]+/, "").trim() || "Section";

    if (i === lyrics.length - 1 && choproSections.length > 0 && matchedIdx < choproSections.length - 1) {
      const lastCS = choproSections[choproSections.length - 1];
      type = lastCS.type;
      text = lastCS.label;
    }

    if (matchedIdx !== lastChoproIdx) {
      if (type === "verse") verseCount++;
      else if (type === "chorus") chorusCount++;
      else if (type === "pre-chorus") preChorusCount++;
      lastChoproIdx = matchedIdx;
    }

    sections.push({
      bar: entry.bar,
      time: Math.round(time * 100) / 100,
      text,
      type,
      token: getSectionToken(type, verseCount, chorusCount, preChorusCount),
    });
  }

  return sections;
}

// Generate sections directly from ChordPro directive sections when meta is sparse.
// Distributes bars proportionally to each section based on line count.
function sectionsFromChordpro(choproSections, bpm, lyrics, durationBars) {
  const totalBars = durationBars || Math.max(...lyrics.map(e => e.bar), 128) + 8;
  const totalLines = choproSections.reduce((s, cs) => s + Math.max(cs.lines.length, 1), 0);
  let currentBar = 1;
  let verseCount = 0, chorusCount = 0, preChorusCount = 0;

  const sections = [];
  for (const cs of choproSections) {
    const lineCount = Math.max(cs.lines.length, 1);
    const barSpan = Math.max(1, Math.round((lineCount / totalLines) * totalBars));
    const time = ((currentBar - 1) * 4 * 60) / bpm;

    let type = cs.type || "verse";
    if (type === "verse") verseCount++;
    else if (type === "chorus") chorusCount++;
    else if (type === "pre-chorus") preChorusCount++;

    sections.push({
      bar: currentBar,
      time: Math.round(time * 100) / 100,
      text: cs.label || type,
      type,
      token: getSectionToken(type, verseCount, chorusCount, preChorusCount),
    });

    currentBar += barSpan;
  }

  return sections;
}

// Resolve meta.json path with slug fallback (folder may not match songId)
function resolveMetaPath(songId) {
  const exactPath = path.join(REAPER_SONGS_PATH, songId, "meta.json");
  if (fs.existsSync(exactPath)) return exactPath;
  try {
    const folders = fs.readdirSync(REAPER_SONGS_PATH, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const folder of folders) {
      const slug = folder.name.toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      if (slug === songId) {
        const fpath = path.join(REAPER_SONGS_PATH, folder.name, "meta.json");
        if (fs.existsSync(fpath)) return fpath;
      }
    }
  } catch (err) {}
  return null;
}

// Resolve song.chopro path with slug fallback
function resolveChoproPath(songId) {
  const exactPath = path.join(REAPER_SONGS_PATH, songId, "song.chopro");
  if (fs.existsSync(exactPath)) return exactPath;
  try {
    const folders = fs.readdirSync(REAPER_SONGS_PATH, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const folder of folders) {
      const slug = folder.name.toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      if (slug === songId) {
        const fpath = path.join(REAPER_SONGS_PATH, folder.name, "song.chopro");
        if (fs.existsSync(fpath)) return fpath;
      }
    }
  } catch (err) {}
  return null;
}

// Tracks the last songId so we only recompute sections on song change
let lastSongId = null;

// Default knob labels per tab
const TAB_KNOB_LABELS = {
  show:   ["--",      "--",       "--",     "--"],
  fx:     ["Param 1", "Param 2", "Param 3", "Param 4"],
  mix:    ["Vol 1",   "Vol 2",   "Vol 3",  "Vol 4"],
  mobius: ["Record",  "Overdub", "Play",   "Stop"],
  synths: ["Preset",  "Cutoff",  "Res",    "Level"],
  stats:  ["--",      "--",      "--",     "--"]
};

function getKnobLabelsForTab(tab, fx) {
  if (tab === "fx" && fx && fx.params) {
    return [
      fx.params[0] ? fx.params[0].name : "--",
      fx.params[1] ? fx.params[1].name : "--",
      fx.params[2] ? fx.params[2].name : "--",
      fx.params[3] ? fx.params[3].name : "--",
    ];
  }
  return TAB_KNOB_LABELS[tab] || ["--","--","--","--"];
}

// ═══════════════════════════════════════════════════════════
// HTTP + WEBSOCKET SERVER
// ═══════════════════════════════════════════════════════════
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*" },
  pingInterval: 2000,
  pingTimeout: 5000,
  transports: ["polling", "websocket"],
});

app.use(express.static(PUBLIC_DIR, {
  maxAge: 0,
  setHeaders: (res, path) => {
    if (path.endsWith(".html") || path.endsWith(".js") || path.endsWith(".css")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    }
  },
}));
app.use(express.json());

// ─── Bumper Music API ──────────────────────────────────
app.get("/bumper/api/status", (req, res) => {
  if (!bumperScanned) scanBumperMusic();
  res.json(getBumperStatus());
});
app.post("/bumper/api/toggle", (req, res) => { bumperToggle(); res.json(getBumperStatus()); });
app.post("/bumper/api/play", (req, res) => { bumperExplicitStop = false; bumperPlay(null); res.json(getBumperStatus()); });
app.post("/bumper/api/stop", (req, res) => { bumperStop(); res.json(getBumperStatus()); });
app.post("/bumper/api/stop-graceful", (req, res) => { bumperStopGraceful(); res.json(getBumperStatus()); });
app.post("/bumper/api/skip", (req, res) => { bumperSkip(); res.json(getBumperStatus()); });
app.post("/bumper/api/volume/up", (req, res) => {
  bumperVolume = Math.min(1.0, Math.round((bumperVolume + 0.05) * 100) / 100);
  saveBumperVolume(bumperVolume);
  if (bumperPlaying && bumperProcess) {
    // Detach exit handler so kill doesn't auto-next
    bumperProcess.removeAllListeners("exit");
    bumperProcess.kill();
    bumperProcess = null;
    bumperPlay(bumperPlaylist[bumperIndex]);
  }
  res.json(getBumperStatus());
});
app.post("/bumper/api/volume/down", (req, res) => {
  bumperVolume = Math.max(0.05, Math.round((bumperVolume - 0.05) * 100) / 100);
  saveBumperVolume(bumperVolume);
  if (bumperPlaying && bumperProcess) {
    bumperProcess.removeAllListeners("exit");
    bumperProcess.kill();
    bumperProcess = null;
    bumperPlay(bumperPlaylist[bumperIndex]);
  }
  res.json(getBumperStatus());
});
app.use("/bumper-music", express.static(BUMPER_DIR, { maxAge: 0 }));

// ═══════════════════════════════════════════════════════════
// OSC (Open Sound Control) — talk to REAPER
// ═══════════════════════════════════════════════════════════
const oscPort = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: OSC_IN_PORT,
  remoteAddress: OSC_OUT_HOST,
  remotePort: OSC_OUT_PORT,
});

const REAPER_ACTIONS = {
  play: "/action/40044",
  pause: "/action/40046",
  stop: "/action/40045",
  record: "/action/40073",
  nextTrack: "/action/1016",
  prevTrack: "/action/1017",
};

function broadcastState() {
  const payload = { ...state, mixerValues: { ...state.mixerValues }, fxParams: { ...state.fxParams } };
  io.emit("state", payload);
}

function computeCurrentLyricLine() {
  if (!state.lyricLines || state.lyricLines.length === 0) {
    state.currentLineIdx = null;
    return;
  }
  var pos = state.position || 0;
  var best = 0;
  for (var i = 0; i < state.lyricLines.length; i++) {
    if (state.lyricLines[i].time !== null && state.lyricLines[i].time !== undefined && state.lyricLines[i].time <= pos) {
      best = i + 1;
    }
  }
  state.currentLineIdx = best > 0 ? best : null;
}

oscPort.on("ready", () => {
  console.log(`[OSC] Listening on port ${OSC_IN_PORT}, sending to ${OSC_OUT_HOST}:${OSC_OUT_PORT}`);
});

oscPort.on("message", (oscMsg) => {
  const address = oscMsg.address;
  const args = oscMsg.args;

  if (address === "/play") { state.playing = true; broadcastState(); }
  else if (address === "/stop") { state.playing = false; broadcastState(); }
  else if (address === "/time") {
    if (args && args[0] !== undefined) state.position = args[0];
  }

  // ── Track volume feedback: /track/{N}/volume [dB] ──
  else if (/^\/track\/(\d+)\/volume$/.test(address)) {
    const m = address.match(/^\/track\/(\d+)\/volume$/);
    const val = args && args[0] !== undefined ? parseFloat(args[0]) : 0;
    state.trackVolumes[m[1]] = val;
  }

  // ── Track mute feedback: /track/{N}/mute [0/1] ──
  else if (/^\/track\/(\d+)\/mute$/.test(address)) {
    const m = address.match(/^\/track\/(\d+)\/mute$/);
    state.trackMutes[m[1]] = args && args[0] ? true : false;
  }

  // ── Track name feedback: /track/{N}/name ──
  else if (/^\/track\/(\d+)\/name$/.test(address)) {
    const m = address.match(/^\/track\/(\d+)\/name$/);
    state.trackNames[m[1]] = args && args[0] || "";
  }

  // ── FX parameter feedback: /track/{N}/fx/{F}/param/{P}/value ──
  else if (/^\/track\/(\d+)\/fx\/(\d+)\/param\/(\d+)\/value$/.test(address)) {
    const m = address.match(/^\/track\/(\d+)\/fx\/(\d+)\/param\/(\d+)\/value$/);
    const key = `${m[1]}-${m[2]}-${m[3]}`;
    state.fxParams[key] = args && args[0] !== undefined ? parseFloat(args[0]) : 0;
  }

  // ── Tuner data: /tuner [note_str, cents, frequency, string_str] ──
  else if (address === "/tuner") {
    state.tuner = {
      note: args && args[0] || "--",
      cents: args && args[1] !== undefined ? parseFloat(args[1]) : 0,
      frequency: args && args[2] !== undefined ? parseFloat(args[2]) : 0,
      string: args && args[3] || "",
    };
    io.emit("tuner", state.tuner);
  }

  // ── Master BPM feedback ──
  else if (address === "/master/beats/minute") {
    if (args && args[0] !== undefined) state.bpm = parseFloat(args[0]);
  }

  // ── Generic value feedback (for knob labels) ──
  // Format: /control/{param_name} [value]
  else if (/^\/control\//.test(address)) {
    const key = address.replace(/^\/control\//, "");
    state.mixerValues[key] = args && args[0] !== undefined ? parseFloat(args[0]) : 0;
  }
});

oscPort.on("error", (err) => {
  console.error("[OSC] Error:", err.message, "- REAPER OSC feedback will not be available");
});

try {
  oscPort.open();
} catch (err) {
  console.error("[OSC] Could not open OSC port:", err.message, "- HUD and mobile control will still work");
}

function sendOSC(address, args) {
  try {
    oscPort.send({ address, args: args || [] });
  } catch (err) {
    console.error("[OSC] Send error:", err.message);
  }
}

function reaperAction(actionName) {
  const cmd = REAPER_ACTIONS[actionName];
  if (cmd) sendOSC(cmd);
  else console.warn(`[OSC] Unknown action: ${actionName}`);
}

// ═══════════════════════════════════════════════════════════
// SONG LIBRARY + ACTIVE SETLIST
// ═══════════════════════════════════════════════════════════
let songLibrary = [];
let songLibraryScanned = false;
let activeSetlist = []; // ordered array of {title} from TUI

const SESSION_SETLIST_PATH = path.join(__dirname, "..", "data", "setlists", "_last_session.json");

function saveSessionSetlist() {
  try {
    if (activeSetlist.length > 0) {
      const data = {
        name: "_last_session",
        songs: activeSetlist.map(s => ({ title: s.title, artist: s.artist || "" })),
        savedAt: new Date().toISOString(),
        autoSaved: true,
      };
      fs.writeFileSync(SESSION_SETLIST_PATH, JSON.stringify(data, null, 2), "utf-8");
    }
  } catch (err) {
    // silently ignore — session persistence is best-effort
  }
}

function loadSessionSetlist() {
  try {
    if (fs.existsSync(SESSION_SETLIST_PATH)) {
      const data = JSON.parse(fs.readFileSync(SESSION_SETLIST_PATH, "utf-8"));
      if (data.songs && data.songs.length > 0) {
        setActiveSetlist(data.songs);
        console.log(`[Setlist] Restored session: ${activeSetlist.length} songs (saved ${data.savedAt})`);
        return true;
      }
    }
  } catch (err) {
    console.warn("[Setlist] Could not restore session:", err.message);
  }
  return false;
}

function setActiveSetlist(songs) {
  if (!Array.isArray(songs) || songs.length === 0) return;
  activeSetlist = songs.filter(s => s && s.title);
  state.totalSongs = activeSetlist.length;
  state.songIndex = 1;
  state.setlist = activeSetlist;
  console.log(`[Setlist] Active: ${activeSetlist.length} songs`);
  saveSessionSetlist();
}

function ensureSongLibrary() {
  if (songLibraryScanned) return;
  try {
    const dirs = fs.readdirSync(REAPER_SONGS_PATH, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const dir of dirs) {
      const metaPath = path.join(REAPER_SONGS_PATH, dir.name, "meta.json");
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          const id = dir.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
          songLibrary.push({
            id,
            title: meta.title || dir.name,
            artist: meta.artist || "",
            key: meta.key || "",
            bpm: meta.bpm || 120,
            duration: meta.bpm && meta.duration_bars
              ? Math.round((meta.duration_bars * 4 * 60) / meta.bpm)
              : (meta.bpm ? Math.round((128 * 4 * 60) / meta.bpm) : 256),
          });
        } catch {}
      }
    }
    songLibrary.sort((a, b) => a.title.localeCompare(b.title));
    songLibraryScanned = true;
    console.log(`[Library] Scanned ${songLibrary.length} songs from ${REAPER_SONGS_PATH}`);
    state.totalSongs = songLibrary.length;
  } catch (err) {
    console.warn("[Library] Scan error:", err.message);
    songLibraryScanned = true;
  }
}

function processSongData(songId) {
  const metaPath = resolveMetaPath(songId);
  const choproPath = resolveChoproPath(songId);
  // Reset before load — prevents stale state leak if any step fails
  state.lyricLines = [];
  state.lyricSync = { ok: false, annotatedPct: 0, totalLines: 0, annotatedLines: 0, warnings: ["Lyric data unavailable"] };
  state.sections = [];
  state.duration = 240; // safe default: 4 minutes
  try {
    if (metaPath && fs.existsSync(metaPath)) {
      const metaRaw = fs.readFileSync(metaPath, "utf-8");
      const meta = JSON.parse(metaRaw);
      let choproText = "";
      if (choproPath && fs.existsSync(choproPath)) {
        choproText = fs.readFileSync(choproPath, "utf-8");
      }
      if (meta.lyrics && meta.bpm) {
        state.lyricLines = extractLyricLines(choproText);

        // Compute lyric sync health
        var totalLyricLines = state.lyricLines.length;
        var annotatedLyricLines = state.lyricLines.filter(function (l) { return (l.time !== null && l.time !== undefined) || (l.bar !== null && l.bar !== undefined); }).length;
        var annotatedPct = totalLyricLines > 0 ? Math.round((annotatedLyricLines / totalLyricLines) * 100) : 100;
        var syncWarnings = [];
        if (totalLyricLines > 0 && annotatedLyricLines === 0) {
          syncWarnings.push("No @bar=N — lyrics estimated, may be out of sync");
        } else if (totalLyricLines > 0 && annotatedPct < 80) {
          syncWarnings.push("Only " + annotatedPct + "% of lines timed — gaps present");
        } else if (totalLyricLines > 0 && annotatedPct < 100) {
          syncWarnings.push(annotatedPct + "% timed — minor gaps");
        }
        if (meta.bpm === 120 && totalLyricLines > 0) {
          syncWarnings.push("BPM is default 120 — timing may be inaccurate");
        }
        state.lyricSync = {
          ok: syncWarnings.length === 0,
          annotatedPct: annotatedPct,
          totalLines: totalLyricLines,
          annotatedLines: annotatedLyricLines,
          warnings: syncWarnings,
        };

        let maxBar = meta.duration_bars || 128;
        if (state.lyricLines && state.lyricLines.length > 0) {
          for (const l of state.lyricLines) {
            if (l.bar && l.bar > maxBar) maxBar = l.bar;
            if (l.time && l.time > 0) {
              var barFromTime = Math.floor(l.time * (meta.bpm || 120) / (4 * 60)) + 1;
              if (barFromTime > maxBar) maxBar = barFromTime;
            }
          }
        }
        const totalBars = Math.max(maxBar, meta.duration_bars || 128);
        state.sections = computeSections(meta.bpm, meta.lyrics, choproText, totalBars);
        state.duration = Math.round((totalBars * 4 * 60) / (meta.bpm || 120));
        state._lastDurationSongId = songId;
        const secCount = state.sections ? state.sections.length : 0;
        const lyricCount = state.lyricLines ? state.lyricLines.length : 0;
        console.log(`[Sections] ${songId}: ${secCount} sections, ${lyricCount} lyric lines, duration=${state.duration}s, bars=${totalBars}`);
      }
    }
  } catch (err) {
    console.warn("[Sections] error for", songId, ":", err.message);
    // Safe defaults already set at top of function — no stale state leak
  }
}

// ═══════════════════════════════════════════════════════════
// LOCAL PLAYBACK ENGINE (rehearsal mode — no REAPER needed)
// ═══════════════════════════════════════════════════════════
// Runs at 60fps. Advances position locally when the Lua runner
// is not connected (REAPER not running). Allows the HUD,
// iPhone controller, and TUI to function standalone without
// REAPER transport.
let localPlaying = false;
let localPlayStartTime = 0;
let localPlayOffset = 0;
let localLastSongId = null;

function localPlay() {
  ensureSongLibrary();
  if (!state.currentSong && songLibrary.length > 0) {
    // No song loaded yet — load the first one
    const entry = songLibrary[0];
    state.songId = entry.id;
    state.currentSong = entry.title;
    state.currentArtist = entry.artist || "";
    state.currentKey = entry.key || "";
    state.bpm = entry.bpm || 120;
    state.songIndex = 1;
    state.totalSongs = songLibrary.length;
    state.nextSong = songLibrary.length > 1 ? songLibrary[1].title : null;
    lastSongId = null;
    processSongData(entry.id);
  }
  localPlayOffset = state.position || 0;
  localPlayStartTime = Date.now();
  localPlaying = true;
  state.playing = true;
  broadcastState();
  console.log("[Local] Play from", localPlayOffset.toFixed(1) + "s");
}

function localPause() {
  if (localPlaying) {
    localPlayOffset = localPlayOffset + (Date.now() - localPlayStartTime) / 1000;
    state.position = localPlayOffset;
  }
  localPlaying = false;
  state.playing = false;
  broadcastState();
  console.log("[Local] Pause at", state.position.toFixed(1) + "s");
}

function localStop() {
  localPlaying = false;
  localPlayOffset = 0;
  state.position = 0;
  state.playing = false;
  broadcastState();
  console.log("[Local] Stop");
}

function localSeek(secs) {
  localPlayOffset = Math.max(0, secs);
  state.position = localPlayOffset;
  if (localPlaying) localPlayStartTime = Date.now();
  broadcastState();
}

function localSeekOffset(offset) {
  const currentPos = localPlaying
    ? localPlayOffset + (Date.now() - localPlayStartTime) / 1000
    : (state.position || 0);
  const newPos = Math.max(0, Math.min(currentPos + offset, state.duration || Infinity));
  localPlayOffset = newPos;
  state.position = localPlayOffset;
  if (localPlaying) localPlayStartTime = Date.now();
  broadcastState();
  console.log("[Local] Seek", (offset > 0 ? "+" : "") + offset + "s →", newPos.toFixed(1) + "s");
}

function localJumpToSong(songIdx, songTitle) {
  localStop();
  ensureSongLibrary();
  let entry = null;

  if (activeSetlist.length > 0 && songTitle) {
    const lower = songTitle.toLowerCase().trim();
    const idx = activeSetlist.findIndex(s => s.title.toLowerCase().trim() === lower);
    if (idx >= 0) {
      state.songIndex = idx + 1;
      songTitle = activeSetlist[idx].title;
    }
  } else if (activeSetlist.length > 0 && songIdx !== undefined) {
    const idx = Math.max(0, Math.min(activeSetlist.length - 1, songIdx - 1));
    state.songIndex = idx + 1;
    songTitle = activeSetlist[idx].title;
  }

  if (songTitle) {
    const lower = songTitle.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
    entry = songLibrary.find(s => {
      const sLower = s.title.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
      return sLower === lower || (sLower.length > 5 && lower.length > 5 &&
        (sLower.includes(lower) || lower.includes(sLower)));
    });
    if (!entry) {
      console.warn(`[Local] Song not found: "${songTitle}"`);
      return false;
    }
  }
  if (!entry) {
    const idx = Math.max(0, Math.min(songLibrary.length - 1, (songIdx || 1) - 1));
    entry = songLibrary[idx];
    state.songIndex = idx + 1;
  }

  state.songId = entry.id;
  state.currentSong = entry.title;
  state.currentArtist = entry.artist || "";
  state.currentKey = entry.key || "";
  state.bpm = entry.bpm || 120;
  state.totalSongs = activeSetlist.length || songLibrary.length;
  if (activeSetlist.length > 0) {
    state.nextSong = state.songIndex < activeSetlist.length ? activeSetlist[state.songIndex].title : null;
    state.setlist = activeSetlist;
  }
  lastSongId = null;
  localPlayOffset = 0;
  state.position = 0;
  processSongData(entry.id);
  broadcastState();
  console.log(`[Local] Loaded: ${entry.title} (${state.songIndex}/${state.totalSongs})`);
  return true;
}

// 30fps tick — only active when local playback is running
// Position advances every ~33ms. Broadcasts at ~10Hz to all clients.
let lastBroadcastPos = -1;
setInterval(() => {
  if (!localPlaying) return;

  const elapsed = localPlayOffset + (Date.now() - localPlayStartTime) / 1000;
  const duration = state.duration > 0 ? state.duration : 120;

  if (elapsed >= duration && duration > 0) {
    // Song finished — advance to next
    localStop();
    if (state.songIndex < state.totalSongs) {
      console.log("[Local] Song finished, advancing to next");
      localJumpToSong(state.songIndex + 1);
      localPlay();
    }
    return;
  }

  state.position = elapsed;
  state.playing = true;

  // Broadcast at ~10fps (every 100ms of playback time)
  if (Math.floor(elapsed * 10) !== lastBroadcastPos) {
    lastBroadcastPos = Math.floor(elapsed * 10);
    broadcastState();
  }
}, 33);

// Restart local playback when new song data arrives
function onSongLoaded() {
  if (localPlaying) {
    localPlayOffset = 0;
    localPlayStartTime = Date.now();
    state.position = 0;
    broadcastState();
  }
}

// ═══════════════════════════════════════════════════════════
// LUA STATE BRIDGE (file polling)
// ═══════════════════════════════════════════════════════════
const BRIDGE_STATE_PATH = path.join(__dirname, "..", "data", "bridge_state.json");

function pollLuaState() {
  try {
    if (fs.existsSync(BRIDGE_STATE_PATH)) {
      const stat = fs.statSync(BRIDGE_STATE_PATH);
      const ageSec = (Date.now() - stat.mtimeMs) / 1000;
      const reaperActive = ageSec < 5;

      const raw = fs.readFileSync(BRIDGE_STATE_PATH, "utf-8").trim();
      if (raw) {
        const luaState = JSON.parse(raw);

        // Only use bridge data when REAPER is actively connected.
        // In local playback mode, the server manages these fields.
        if (reaperActive && luaState.connected) {
          state.currentSong = luaState.currentSong || state.currentSong;
          state.songId = luaState.songId || state.songId;
          state.nextSong = luaState.nextSong || state.nextSong;
          state.songIndex = luaState.songIndex !== undefined ? luaState.songIndex : state.songIndex;
          state.totalSongs = luaState.totalSongs !== undefined ? luaState.totalSongs : state.totalSongs;
          state.bpm = luaState.bpm || state.bpm;
          state.notes = luaState.notes || state.notes;
          state.duration = luaState.duration > 0 ? luaState.duration : state.duration;
          state.currentKey = luaState.currentKey || state.currentKey;
          state.currentArtist = luaState.currentArtist || state.currentArtist;
          state.trackLevels = luaState.trackLevels || state.trackLevels;
          state.loopStates = luaState.loopStates || state.loopStates;
      state.regions = luaState.regions || state.regions;
      state.position = luaState.position !== undefined && luaState.playing !== undefined
        ? luaState.position : state.position;
      state.playing = luaState.playing !== undefined ? luaState.playing : state.playing;
      state.connected = true;

          if (luaState.fxData) io.emit("fxData", luaState.fxData);
          if (luaState.trackLevels) io.emit("trackLevels", luaState.trackLevels);
          if (luaState.loopStates) io.emit("loopState", luaState.loopStates);
          if (luaState.synthData) io.emit("synthData", luaState.synthData);
        } else {
          state.connected = false;
        }

        // Compute current lyric line index from server-parsed lyric lines
        computeCurrentLyricLine();

        // On song change, compute sections from meta.json + ChordPro directives
        if (luaState.songId && luaState.songId !== lastSongId) {
          lastSongId = luaState.songId;
          const metaPath = resolveMetaPath(luaState.songId);
          const choproPath = resolveChoproPath(luaState.songId);
          try {
            if (metaPath && fs.existsSync(metaPath)) {
              const metaRaw = fs.readFileSync(metaPath, "utf-8");
              const meta = JSON.parse(metaRaw);
              let choproText = "";
              if (choproPath && fs.existsSync(choproPath)) {
                choproText = fs.readFileSync(choproPath, "utf-8");
              }
              if (meta.lyrics && meta.bpm) {
                state.lyricLines = extractLyricLines(choproText);

                // Compute lyric sync health for HUD warning display
                var totalLyricLines = state.lyricLines.length;
                var annotatedLyricLines = state.lyricLines.filter(function (l) { return (l.time !== null && l.time !== undefined) || (l.bar !== null && l.bar !== undefined); }).length;
                var annotatedPct = totalLyricLines > 0 ? Math.round((annotatedLyricLines / totalLyricLines) * 100) : 100;
                var syncWarnings = [];
                if (totalLyricLines > 0 && annotatedLyricLines === 0) {
                  syncWarnings.push("No @bar=N — lyrics estimated, may be out of sync");
                } else if (totalLyricLines > 0 && annotatedPct < 80) {
                  syncWarnings.push("Only " + annotatedPct + "% of lines timed — gaps present");
                } else if (totalLyricLines > 0 && annotatedPct < 100) {
                  syncWarnings.push(annotatedPct + "% timed — minor gaps");
                }
                if (meta.bpm === 120 && totalLyricLines > 0) {
                  syncWarnings.push("BPM is default 120 — timing may be inaccurate");
                }
                state.lyricSync = {
                  ok: syncWarnings.length === 0,
                  annotatedPct: annotatedPct,
                  totalLines: totalLyricLines,
                  annotatedLines: annotatedLyricLines,
                  warnings: syncWarnings,
                };

                // Compute actual duration + bar span from chordpro @bar annotations
                let maxBar = meta.duration_bars || 128;
                if (state.lyricLines && state.lyricLines.length > 0) {
                  for (const l of state.lyricLines) {
                    if (l.bar && l.bar > maxBar) maxBar = l.bar;
            if (l.time && l.time > 0) {
              var barFromTime = Math.floor(l.time * (meta.bpm || 120) / (4 * 60)) + 1;
              if (barFromTime > maxBar) maxBar = barFromTime;
            }
                  }
                }
                const totalBars = Math.max(maxBar, meta.duration_bars || 128);

                state.sections = computeSections(meta.bpm, meta.lyrics, choproText, totalBars);
                state.duration = Math.round((totalBars * 4 * 60) / (meta.bpm || 120));
                state._lastDurationSongId = luaState.songId;

                const secCount = state.sections ? state.sections.length : 0;
                const lyricCount = state.lyricLines ? state.lyricLines.length : 0;
                console.log(`[Sections] ${luaState.songId}: ${secCount} sections, ${lyricCount} lyric lines, metaEntries=${meta.lyrics.length}, duration=${state.duration}s, bars=${totalBars}`);
                onSongLoaded();
              }
            }
          } catch (err) {
            console.warn("[Sections] compute error for song '" + (luaState.songId || "?") + "': " + (err.message || err));
          }
        }

        broadcastState();
        if (luaState.fxData) io.emit("fxData", luaState.fxData);
        if (luaState.trackLevels) io.emit("trackLevels", luaState.trackLevels);
        if (luaState.loopStates) io.emit("loopState", luaState.loopStates);
        if (luaState.synthData) io.emit("synthData", luaState.synthData);
        if (luaState.regions) state.regions = luaState.regions;
      }
    }
  } catch (err) {
    if (err && err.message && !err.message.includes("JSON") && !err.message.includes("ENOENT")) {
      console.warn("[Poll] Error reading bridge_state.json:", err.message);
    }
  }
}

setInterval(pollLuaState, 500);

// ═══════════════════════════════════════════════════════════
// WEBSOCKET EVENTS
// ═══════════════════════════════════════════════════════════
io.on("connection", (socket) => {
  console.log(`[WebSocket] Client connected: ${socket.id}`);
  const rawIp = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address || "unknown";
  const ip = (rawIp || "").split(",")[0].trim().replace(/^::ffff:/, "");

  // Initialize per-client context
  clientContexts.set(socket.id, {
    activeTab: "show",
    ip: ip,
    userAgent: socket.handshake.headers["user-agent"] || null,
  });
  socket.emit("state", state);

  // ── Transport + show actions ──
  socket.on("action", (data) => {
    const { type, value } = data || {};
    console.log(`[Action] ${type}${value !== undefined ? ` = ${value}` : ""}`);

    switch (type) {
      case "play":
        if (!state.connected) {
          // Local playback mode — REAPER not connected
          if (localPlaying) localPause();
          else localPlay();
        } else {
          if (state.playing) reaperAction("pause");
          else reaperAction("play");
        }
        break;
      case "pause":
        if (!state.connected) localPause();
        else reaperAction("pause");
        break;
      case "stop":
        if (!state.connected) localStop();
        else reaperAction("stop");
        break;
      case "seek":
        // Nudge position by offset seconds (local mode only)
        if (!state.connected) {
          localSeekOffset(parseFloat(value && value.offset) || 0);
        }
        break;
      case "prev":
      case "next": {
        const dir = type === "next" ? 1 : -1;
        if (!state.connected) {
          localJumpToSong(state.songIndex + dir);
          break;
        }
        const targetIdx = Math.max(1, Math.min(state.totalSongs, (state.songIndex || 1) + dir));
        const targetRegion = state.regions && state.regions[targetIdx - 1];
        if (targetRegion && targetIdx !== state.songIndex) {
          const wasPlaying = state.playing;
          sendOSC("/play", [targetRegion.startTime, wasPlaying ? 1 : 0]);
        }
        break;
      }
      case "jumpToSong": {
        const targetIdx = Math.max(1, Math.min(state.totalSongs, parseInt(value) || 1));
        const targetRegion = state.regions && state.regions[targetIdx - 1];
        if (targetRegion) {
          const wasPlaying = state.playing;
          sendOSC("/play", [targetRegion.startTime, wasPlaying ? 1 : 0]);
        }
        break;
      }
      case "panic":
        sendOSC("/action/40045");
        sendOSC("/action/40364");
        break;

      // ── Mobius loop commands (routed via MIDI CC) ──
      case "mobiusRecord":
      case "mobiusPlay":
      case "mobiusOverdub":
      case "mobiusMultiply":
      case "mobiusMute":
        mobiusAction(type.replace("mobius", "").toLowerCase());
        break;
      case "mobiusAllReset":
        mobiusAction("reset");
        break;
      case "mobiusAllUndo":
        mobiusAction("undo");
        break;

      // ── Mix mute/solo (via OSC) ──
      case "mute":
        if (typeof value === 'object' && value.track !== undefined) {
          sendOSC(`/mixer/mute/${value.track}`, [value.state ? 1 : 0]);
          state.trackMutes[value.track] = value.state;
          broadcastState();
        } else {
          sendOSC(`/mixer/mute/${value}`, [1]);
        }
        break;
      case "solo":
        sendOSC(`/mixer/solo/${typeof value === 'object' ? value.track : value}`, [1]);
        break;

      // ── Live Controller: Level-based mute ──
      // ReaLearn maps: /panic/vocal → mute vocal, /panic/all → mute all, /panic/restore → unmute
      case "mute_with_level": {
        const level = (value && value.level) || "none";
        if (level === "vocal") sendOSC("/panic/vocal", [1]);
        else if (level === "all") sendOSC("/panic/all", [1]);
        else sendOSC("/panic/restore", [1]);
        break;
      }

      // ── Live Controller: Scene select (SWS Snapshots 1-8) ──
      // value: scene number (1-8) or { scene: N }
      case "scene_select": {
        const scene = parseInt((value && value.scene) || value, 10);
        if (scene >= 1 && scene <= 8) {
          const n = String(scene).padStart(2, "0");
          sendOSC(`/edm/scene/${scene}`, [1]);
          state.activeScene = scene;
          broadcastState();
          console.log(`[Scene] /edm/scene/${scene}`);
        }
        break;
      }

      // ── Live Controller: Keys (VST) toggle ──
      // ReaLearn maps: /keys/on → unmute VST tracks, /keys/off → mute them
      case "keys_toggle": {
        const on = value && value.on;
        sendOSC(on ? "/keys/on" : "/keys/off", [1]);
        state.keysOn = on;
        broadcastState();
        console.log(`[Keys] ${on ? 'ON' : 'OFF'}`);
        break;
      }

      // ── Live Controller: Start next song in queue ──
      case "start_song": {
        if (!state.connected) {
          localJumpToSong(state.songIndex + 1);
          localPlay();
          console.log(`[Start] Local: jump to song ${state.songIndex}`);
          break;
        }
        const nextIdx = Math.min(state.totalSongs, (state.songIndex || 0) + 1);
        const target = state.regions && state.regions[nextIdx - 1];
        if (target) {
          sendOSC("/play", [target.startTime, 1]);
          console.log(`[Start] Jump to song ${nextIdx}: ${target.title}`);
        } else {
          reaperAction("play");
        }
        break;
      }

      // ── Live Controller: GTR AMP preset ──
      // Sends clean OSC commands for ReaLearn to map.
      // Configure once in ReaLearn (no server changes needed):
      //   /amp/select/BE       → Track "GTR NAM": unmute + enable BE FX
      //   /amp/select/SSS      → Track "GTR NAM": unmute + enable SSS FX
      //   /amp/select/Acoustic → Track "GTR NAM": mute + Track "Acoustic": unmute
      case "gtr_amp_preset": {
        const preset = (value && value.preset) || "BE";
        sendOSC(`/amp/select/${preset}`, [1]);
        state.activeAmpPreset = preset;
        broadcastState();
        console.log(`[GTR AMP] OSC → /amp/select/${preset}`);
        break;
      }

      // ── Live Controller: Tap tempo ──
      case "tap_tempo": {
        const now = Date.now();
        if (!tapTimes) tapTimes = [];
        tapTimes.push(now);
        while (tapTimes.length > 0 && now - tapTimes[0] > 3000) tapTimes.shift();
        if (tapTimes.length >= 2) {
          const intervals = [];
          for (let i = 1; i < tapTimes.length; i++) {
            intervals.push(tapTimes[i] - tapTimes[i - 1]);
          }
          const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
          const bpm = Math.round((60000 / avgMs) * 10) / 10;
          state.bpm = bpm;
          sendOSC("/master/beats/minute", [bpm]);
          broadcastState();
          console.log(`[Tempo] ${tapTimes.length} taps → ${bpm} BPM`);
        }
        break;
      }

      // ── Live Controller: Bumper music toggle ──
      case "bumper_toggle": {
        bumperToggle();
        break;
      }

      // ── Live Controller: Tuner teleprompter toggle ──
      case "tuner_teleprompter": {
        const enabled = value && value.enabled;
        console.log(`[Tuner] Teleprompter: ${enabled ? 'ON' : 'OFF'}`);
        break;
      }

      // ── Live Controller: Queue management ──
      case "queue_skip": {
        const idx = value && (value.index !== undefined ? value.index : value);
        console.log(`[Queue] Skip index: ${idx}`);
        break;
      }
      case "queue_remove": {
        const ridx = value && (value.index !== undefined ? value.index : value);
        console.log(`[Queue] Remove index: ${ridx}`);
        break;
      }

      default:
        console.warn(`[Action] Unknown type: ${type}`);
    }
  });

  // ── EDM FX knob parameter changes (iPhone virtual knobs → REAPER) ──
  socket.on("edmKnob", (data) => {
    const { knob, value } = data || {};
    const TRACK_MAP = { filter: 1, res: 2, rev: 3, delay: 4 };
    const PARAM_MAP = { filter: 1, res: 2, rev: 1, delay: 1 };
    const FX_MAP = { filter: 1, res: 1, rev: 2, delay: 3 };
    const trackIdx = TRACK_MAP[knob] || 1;
    const fxIdx = FX_MAP[knob] || 1;
    const paramIdx = PARAM_MAP[knob] || 1;
    sendOSC(`/edm/${knob}`, [value]);
  });

  // ── GTR FX knob changes (iPhone → REAPER) ──
  socket.on("gtrFxKnob", (data) => {
    const { param, value } = data || {};
    sendOSC(`/gtrfx/${param}`, [value]);
  });

  // ── FX parameter change (via OSC) ──
  socket.on("fxParam", (data) => {
    const { trackIdx, value } = data || {};
    sendOSC(`/vst/next/${trackIdx}`, [value || 1]);
  });

  // ── FX selected (user taps FX chip → server updates knob context) ──
  socket.on("fxSelected", (data) => {
    const { trackIdx, fxIdx } = data || {};
    const ctx = clientContexts.get(socket.id) || {};
    ctx.activeTab = "fx";
    ctx.fxTrackIdx = trackIdx;
    ctx.fxIdx = fxIdx;
    clientContexts.set(socket.id, ctx);
  });

  // ── Tab change → update knob context for this client ──
  socket.on("tabChange", (data) => {
    const ctx = clientContexts.get(socket.id) || {};
    ctx.activeTab = (data && data.tab) || "show";
    ctx.fxTrackIdx = undefined;
    ctx.fxIdx = undefined;
    clientContexts.set(socket.id, ctx);
  });

  // ── Physical knob from iPhone (touch-controlled virtual knobs) ──
  // In the future, Alesis V25 physical knobs send MIDI CC direct to REAPER.
  // This handler covers the iPhone's on-screen virtual knob controls.
  socket.on("knob", (data) => {
    const { knob, value } = data || {};
    sendOSC(`/control/knob/${knob}`, [value]);
  });

  socket.on("disconnect", () => {
    console.log(`[WebSocket] Client disconnected: ${socket.id}`);
    clientContexts.delete(socket.id);
    broadcastClientCount();
  });

  // ── Broadcast updated client count on connect ──
  broadcastClientCount();
});

// ═══════════════════════════════════════════════════════════
// CLIENT MONITORING
// ═══════════════════════════════════════════════════════════
// Tracks connected WebSocket clients so the system knows
// if the iPhone controller or stage display is connected.
// Also tracks client IPs for Dell discovery.

function broadcastClientCount() {
  const clients = [];
  for (const [id, ctx] of clientContexts) {
    clients.push({ id });
  }
  io.emit("clientCount", { count: clients.length, clients });
}

app.get("/api/clients", (req, res) => {
  const clients = [];
  for (const [id, ctx] of clientContexts) {
    clients.push({ id, context: ctx, ip: ctx.ip || null, userAgent: ctx.userAgent || null });
  }
  res.json({ count: clients.length, clients });
});

// ═══════════════════════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════════════════════
app.get("/api/state", (req, res) => {
  res.json(state);
});

app.post("/api/action", (req, res) => {
  const { type, value } = req.body || {};
  io.emit("action", { type, value });
  res.json({ ok: true });
});

// ── Local playback control (rehearsal mode) ──
app.post("/api/local/play", (req, res) => {
  localPlay();
  res.json({ ok: true, playing: true, position: state.position });
});
app.post("/api/local/stop", (req, res) => {
  localStop();
  res.json({ ok: true, playing: false, position: 0 });
});
app.post("/api/local/pause", (req, res) => {
  localPause();
  res.json({ ok: true, playing: false, position: state.position });
});
app.post("/api/local/seek", (req, res) => {
  const offset = parseFloat(req.body && req.body.offset) || 0;
  localSeekOffset(offset);
  res.json({ ok: true, position: state.position, playing: state.playing });
});
app.post("/api/local/jump", (req, res) => {
  const idx = req.body && req.body.songIndex;
  localJumpToSong(idx || 1);
  res.json({ ok: true, songIndex: state.songIndex, currentSong: state.currentSong });
});
app.post("/api/local/next", (req, res) => {
  const title = req.body && req.body.title;
  const idx = state.songIndex + 1;
  localJumpToSong(title ? undefined : idx, title);
  res.json({ ok: true, songIndex: state.songIndex, currentSong: state.currentSong });
});
app.post("/api/local/prev", (req, res) => {
  const title = req.body && req.body.title;
  const idx = Math.max(1, state.songIndex - 1);
  localJumpToSong(title ? undefined : idx, title);
  res.json({ ok: true, songIndex: state.songIndex, currentSong: state.currentSong });
});
app.post("/api/local/load", (req, res) => {
  const title = req.body && req.body.title;
  if (title) {
    const ok = localJumpToSong(1, title);
    res.json({ ok, songIndex: state.songIndex, currentSong: state.currentSong });
  } else {
    res.json({ ok: false, error: "title required" });
  }
});

app.post("/api/local/setlist", (req, res) => {
  const songs = req.body && req.body.songs;
  setActiveSetlist(songs || []);
  if (activeSetlist.length > 0) {
    localJumpToSong(1, activeSetlist[0].title);
  }
  saveSessionSetlist();
  res.json({ ok: true, count: activeSetlist.length, currentSong: state.currentSong });
});

// ── Song library endpoint (for iPhone setlist builder) ──
app.get("/api/library", (req, res) => {
  ensureSongLibrary();
  res.json({
    total: songLibrary.length,
    songs: songLibrary.map(s => ({ id: s.id, title: s.title, artist: s.artist, key: s.key, bpm: s.bpm })),
  });
});

// ── Add/remove songs from active setlist ──
app.post("/api/local/setlist/add", (req, res) => {
  const title = req.body && req.body.title;
  if (!title) return res.json({ ok: false, error: "title required" });
  if (!activeSetlist.find(s => s.title === title)) {
    activeSetlist.push({ title });
    state.totalSongs = activeSetlist.length;
    state.setlist = activeSetlist;
    if (activeSetlist.length === 1) {
      localJumpToSong(1, title);
    }
    saveSessionSetlist();
    broadcastState();
    res.json({ ok: true, count: activeSetlist.length });
  } else {
    res.json({ ok: false, error: "already in setlist" });
  }
});

app.post("/api/local/setlist/remove", (req, res) => {
  const title = req.body && req.body.title;
  if (!title) return res.json({ ok: false, error: "title required" });
  const idx = activeSetlist.findIndex(s => s.title === title);
  if (idx >= 0) {
    activeSetlist.splice(idx, 1);
    state.totalSongs = activeSetlist.length;
    state.setlist = activeSetlist;
    saveSessionSetlist();
    broadcastState();
    res.json({ ok: true, count: activeSetlist.length });
  } else {
    res.json({ ok: false, error: "not in setlist" });
  }
});

// ── Save/Load named setlists ──
const SETLIST_DIR = path.join(__dirname, "..", "data", "setlists");

function ensureSetlistDir() {
  if (!fs.existsSync(SETLIST_DIR)) fs.mkdirSync(SETLIST_DIR, { recursive: true });
}

function sanitizeName(name) {
  return (name || "untitled").replace(/[^a-zA-Z0-9 _-]/g, "").substring(0, 64);
}

app.post("/api/local/setlist/save", (req, res) => {
  ensureSetlistDir();
  const name = sanitizeName(req.body && req.body.name);
  const filePath = path.join(SETLIST_DIR, name + ".json");
  const data = {
    name,
    songs: activeSetlist.map(s => ({ title: s.title, artist: s.artist || "" })),
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  res.json({ ok: true, name, count: data.songs.length });
});

app.get("/api/local/setlist/list", (req, res) => {
  ensureSetlistDir();
  try {
    const files = fs.readdirSync(SETLIST_DIR).filter(f => f.endsWith(".json"));
    const list = files.map(f => {
      const filePath = path.join(SETLIST_DIR, f);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return { name: data.name, count: (data.songs || []).length, savedAt: data.savedAt };
    }).sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
    res.json({ ok: true, setlists: list });
  } catch (e) {
    res.json({ ok: true, setlists: [] });
  }
});

app.post("/api/local/setlist/load", (req, res) => {
  ensureSetlistDir();
  const name = sanitizeName(req.body && req.body.name);
  const filePath = path.join(SETLIST_DIR, name + ".json");
  if (!fs.existsSync(filePath)) {
    return res.json({ ok: false, error: "Setlist not found: " + name });
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    setActiveSetlist(data.songs || []);
    if (activeSetlist.length > 0) {
      localJumpToSong(1, activeSetlist[0].title);
    }
    saveSessionSetlist();
    res.json({ ok: true, name: data.name, count: activeSetlist.length, currentSong: state.currentSong });
  } catch (e) {
    res.json({ ok: false, error: "Failed to read setlist file" });
  }
});

// ── ChordPro file endpoint ──
// Returns the raw ChordPro text for a song, or 404.
app.get("/api/chordpro/:songId", (req, res) => {
  const songId = req.params.songId;
  // Sanitize: prevent directory traversal — only allow alphanumeric, underscores, hyphens
  if (typeof songId !== "string" || !songId.trim() || songId.includes("..") || songId.includes("/")) {
    return res.status(400).json({ error: "Invalid song ID" });
  }
  // Try exact slug match first
  let choproPath = path.join(REAPER_SONGS_PATH, songId, "song.chopro");
  if (fs.existsSync(choproPath)) {
    return res.type("text/plain").send(fs.readFileSync(choproPath, "utf-8"));
  }
  // Fallback: scan ReaperSongs for a folder whose slug matches
  try {
    const folders = fs.readdirSync(REAPER_SONGS_PATH, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const folder of folders) {
      const slug = folder.name.toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      if (slug === songId) {
        choproPath = path.join(REAPER_SONGS_PATH, folder.name, "song.chopro");
        if (fs.existsSync(choproPath)) {
          return res.type("text/plain").send(fs.readFileSync(choproPath, "utf-8"));
        }
      }
    }
  } catch (err) {
    // Fallback failed
  }
  res.status(404).json({ error: "ChordPro file not found" });
});

// ── Full song data endpoint ──
// Returns the merged meta.json contents for a song.
app.get("/api/song-data/:songId", (req, res) => {
  const songId = req.params.songId;
  if (typeof songId !== "string" || !songId.trim() || songId.includes("..") || songId.includes("/")) {
    return res.status(400).json({ error: "Invalid song ID" });
  }
  // Try exact folder name, then slug fallback
  const tryPaths = [
    path.join(REAPER_SONGS_PATH, songId, "meta.json"),
  ];
  try {
    const folders = fs.readdirSync(REAPER_SONGS_PATH, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const folder of folders) {
      const slug = folder.name.toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      if (slug === songId) {
        tryPaths.push(path.join(REAPER_SONGS_PATH, folder.name, "meta.json"));
        break;
      }
    }
  } catch (err) {}
  for (const p of tryPaths) {
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, "utf-8"));
        return res.json(data);
      } catch (err) {
        return res.status(500).json({ error: "Invalid meta.json" });
      }
    }
  }
  res.status(404).json({ error: "Song data not found" });
});

// Sync health for current song (TUI + HUD warnings)
app.get("/api/sync-health", (req, res) => {
  res.json({
    currentSong: state.currentSong,
    songId: state.songId,
    lyricSync: state.lyricSync,
    playing: state.playing,
  });
});

// ═══════════════════════════════════════════════════════════
// PRE-FLIGHT CHECK — one-shot system health check for iPhone
// ═══════════════════════════════════════════════════════════
app.get("/api/preflight", (req, res) => {
  const issues = [];

  // 1. Server — always true if we're responding
  const serverOk = true;

  // 2. REAPER connection — check bridge_state.json age
  let reaperConnected = false;
  let bridgeAge = null;
  try {
    if (fs.existsSync(BRIDGE_STATE_PATH)) {
      const stat = fs.statSync(BRIDGE_STATE_PATH);
      bridgeAge = (Date.now() - stat.mtimeMs) / 1000;
      reaperConnected = bridgeAge < 5;
    }
  } catch (e) {}
  if (!reaperConnected) issues.push("REAPER not connected (bridge file stale or missing)");

  // 3. Tunnel — check cloudflared process
  let tunnelActive = false;
  let tunnelUrl = null;
  try {
    const cfRunning = require("child_process")
      .execSync("pgrep -f 'cloudflared tunnel'", { encoding: "utf-8", timeout: 2000 })
      .trim().length > 0;
    tunnelActive = cfRunning;
    const urlPath = path.join(__dirname, "..", "..", "..", "..", "Documents", "projects", "live-stage-hud", "web", "public", "assets", "tunnel-url.txt");
    // Try the project root relative to this file
    const altPath = path.join(__dirname, "..", "public", "assets", "tunnel-url.txt");
    if (fs.existsSync(altPath)) {
      tunnelUrl = fs.readFileSync(altPath, "utf-8").trim();
    }
  } catch (e) {}
  if (!tunnelActive) issues.push("Cloudflare tunnel not active (guest singers can't connect externally)");

  // 4. Bumper music
  const bumperReady = fs.existsSync(path.join(os.homedir(), "bumper-music"));
  let bumperTrackCount = 0;
  if (bumperReady) {
    try {
      bumperTrackCount = fs.readdirSync(path.join(os.homedir(), "bumper-music"))
        .filter(f => /\.(mp3|m4a|wav|flac)$/i.test(f)).length;
    } catch (e) {}
  }
  if (!bumperReady || bumperTrackCount === 0) issues.push("Bumper music library missing or empty");

  // 5. Connected clients
  let clientCount = 0;
  try {
    const sockets = io.sockets.sockets;
    clientCount = sockets ? sockets.size : 0;
  } catch (e) {}
  if (clientCount === 0) issues.push("No clients connected (HUD or iPhone not open)");

  // 6. Setlist lyric sync — scan each song in the active setlist
  const setlistSongs = [];
  const setlist = state.setlist || [];
  let setlistOk = 0, setlistWarn = 0, setlistError = 0;

  for (const entry of setlist) {
    const title = entry.title || "";
    const songId = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    let annotatedPct = 0;
    let totalLines = 0;
    let annotatedLines = 0;
    let found = false;

    // Try exact folder name first, then slug
    const tryDirs = [songId];
    try {
      const dirs = fs.readdirSync(REAPER_SONGS_PATH, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const d of dirs) {
        const slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        if (slug === songId && d.name !== songId) tryDirs.push(d.name);
      }
    } catch (e) {}

    for (const dirName of tryDirs) {
      const choproPath = path.join(REAPER_SONGS_PATH, dirName, "song.chopro");
      if (fs.existsSync(choproPath)) {
        found = true;
        try {
          const text = fs.readFileSync(choproPath, "utf-8");
          const allLines = text.split("\n").filter(l => {
            const t = l.trim();
            return t && !/^\{/.test(t);
          });
          totalLines = allLines.length;
          annotatedLines = allLines.filter(l => /@time=/.test(l)).length;
          // Also count @bar= lines
          const barLines = allLines.filter(l => /@bar=/.test(l)).length;
          annotatedLines = Math.max(annotatedLines, barLines);
          annotatedPct = totalLines > 0 ? Math.round((annotatedLines / totalLines) * 100) : 0;
        } catch (e) {
          annotatedPct = 0;
        }
        break;
      }
    }

    const songStatus = annotatedPct >= 95 ? "ok" : annotatedPct >= 70 ? "warn" : "error";
    if (songStatus === "ok") setlistOk++;
    else if (songStatus === "warn") setlistWarn++;
    else setlistError++;

    setlistSongs.push({
      title,
      annotatedPct,
      annotatedLines,
      totalLines,
      status: songStatus,
      found,
    });
  }

  if (setlistError > 0) issues.push(`${setlistError} song(s) have less than 70% lyric timing coverage`);
  else if (setlistWarn > 0) issues.push(`${setlistWarn} song(s) have less than 95% lyric timing coverage`);

  const allClear = issues.length === 0;

  res.json({
    server: { ok: serverOk, port: PORT },
    reaper: { connected: reaperConnected, bridgeAgeSec: bridgeAge ? Math.round(bridgeAge * 10) / 10 : null },
    tunnel: { active: tunnelActive, url: tunnelUrl },
    bumper: { ready: bumperReady, tracks: bumperTrackCount },
    clients: { count: clientCount },
    setlist: {
      count: setlist.length,
      ok: setlistOk,
      warn: setlistWarn,
      error: setlistError,
      songs: setlistSongs,
    },
    allClear,
    issues,
  });
});

// ═══════════════════════════════════════════════════════════
// AUTO-DISCOVER — zero-CPU, uses macOS built-in Bonjour
// ═══════════════════════════════════════════════════════════
// macOS runs mDNSResponder by default — every Mac advertises
// <computername>.local via Bonjour with zero config or CPU cost.
// The iPhone can always reach the server at:
//   http://<HostName>.local:PORT/    (system Bonjour, no overhead)
//   http://<lan-ip>:PORT/            (direct IP fallback)

function getLanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

function getBonjourHostname() {
  // macOS hostname → Bonjour .local format
  // e.g. "MacBook Pro" → "MacBook-Pro.local"
  let name = os.hostname();
  // Remove .local if present (os.hostname() sometimes includes domain)
  name = name.replace(/\.local$/, "");
  return name + ".local";
}

app.get("/api/discover", (req, res) => {
  const ip = getLanIP();
  const hostname = getBonjourHostname();
  res.json({
    ip,
    port: PORT,
    bonjour: hostname,
    url: `http://${ip}:${PORT}`,
    bonjourUrl: `http://${hostname}:${PORT}`,
  });
});

// ═══════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════
server.listen(PORT, "0.0.0.0", () => {
  const ip = getLanIP();
  const bonjour = getBonjourHostname();

  // Restore session setlist on startup
  loadSessionSetlist();
  ensureSongLibrary();

  // Register Bonjour service so iOS can discover via mDNS hostname resolution
  let bonjourSvc = null;
  try {
    // Use -R with hostname as service name for maximum compatibility
    const hostname = getBonjourHostname().replace(/\.local$/, "");
    bonjourSvc = cp.spawn("dns-sd", [
      "-R", hostname, "_http._tcp", ".", String(PORT)
    ], { stdio: ["ignore", "ignore", "ignore"], detached: false });
    bonjourSvc.unref();
    process.on("exit", () => { try { bumperStop(); midiIn && midiIn.close(); bonjourSvc.kill(); } catch {} });
    process.on("SIGINT", () => { try { bumperStop(); midiIn && midiIn.close(); bonjourSvc.kill(); } catch {} });
    process.on("SIGTERM", () => { try { bumperStop(); midiIn && midiIn.close(); bonjourSvc.kill(); } catch {} });
  } catch (err) {
    // dns-sd may not be available — skip
  }

  console.log("─────────────────────────────────────────────");
  console.log("  Live Show Manager — Bridge Server");
  console.log("─────────────────────────────────────────────");
  console.log(`  Bonjour    : http://${bonjour}:${PORT}/`);
  console.log(`  iPhone URL : http://${ip}:${PORT}/`);
  console.log(`  Stage HUD  : http://${ip}:${PORT}/hud.html`);
  console.log(`  OSC In     : port ${OSC_IN_PORT}  (REAPER feedback → us)`);
  console.log(`  OSC Out    : ${OSC_OUT_HOST}:${OSC_OUT_PORT}  (we → REAPER)`);
  console.log(`  MIDI Out   : "Live Show Manager" virtual port (Mobius)`);
  console.log(`  Lua bridge : ${BRIDGE_STATE_PATH}`);
  console.log("─────────────────────────────────────────────");
  console.log("  REAPER OSC:  Preferences > Control Surfaces");
  console.log("   Add OSC:  Local port " + OSC_OUT_PORT + " | Dest: 127.0.0.1:" + OSC_IN_PORT);
  console.log("─────────────────────────────────────────────");
  console.log("  MOBIUS:  Route 'Live Show Manager' MIDI to Mobius track");
  console.log("  CC defaults: Record=20 Play=21 Overdub=22 Multiply=23 Mute=24");
  console.log("─────────────────────────────────────────────");
  console.log("  ALESIS V25:  Set knobs to CC 70, 71, 72, 73");
  console.log("─────────────────────────────────────────────");
  console.log(`  iPhone: http://${bonjour}:${PORT}/   (or http://${ip}:${PORT}/)`);
  console.log("─────────────────────────────────────────────");

  // Generate QR code for iPhone scanning
  try {
    const QR_DIR = path.join(PUBLIC_DIR, "qr");
    const url = `http://${ip}:${PORT}/`;
    // Save PNG for the web
    cp.execSync(`qrencode -o "${path.join(PUBLIC_DIR, "qr.png")}" "${url}"`, { stdio: "ignore" });
    // Print ANSI QR to terminal
    const qr = cp.execSync(`qrencode -t ANSIUTF8 "${url}"`, { maxBuffer: 1024*10 }).toString();
    console.log(qr);
    console.log(`  Scan QR above with iPhone camera → opens ${url}`);
    console.log("─────────────────────────────────────────────");
  } catch (err) {
    // qrencode not installed — just skip QR
  }
});
