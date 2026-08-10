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
const Timing = require("./public/timing.js");

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
  timeSig: [4, 4],
  armed: false,
  stagedIndex: 0,
  countIn: null,
  beatAnchorSec: 0,
  // Shared tempo authority — the single tempo every display follows.
  tempo: {
    bpm: 120,
    source: "reaper",        // "reaper" | "tap" | "link"
    downbeatAt: 0,           // epoch ms of the current Beat-1 anchor (0 = none)
    downbeatRev: 0,          // bumped each time Beat-1 is re-anchored
    ts: Date.now()
  },
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
let _tapAnchored = false;

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
  let currentRaw = [];
  let inSection = false; // tracks whether inside a start_of/end_of block

  function flushSection() {
    if (!inSection) return;
    // Only keep sections that contain actual content lines
    if (currentLines.filter(l => l && !l.startsWith("{")).length > 0) {
      sections.push({ type: currentType, label: currentLabel, lines: currentLines, raw: currentRaw });
    }
    currentLines = [];
    currentRaw = [];
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

    // Legacy `## Section Label` headers (UG export style) start a new section.
    // Examples: "## Verse 1", "## Chords @21.27". The trailing @N.N is a time
    // hint we can use later for section timing.
    if (/^##\s/.test(trimmed)) {
      flushSection();
      let label = trimmed.replace(/^##\s+/, "").replace(/\s+@[\d.]+$/, "").trim() || "Section";
      currentType = "verse";
      currentLabel = label;
      inSection = true;
      // Refine type from the label text.
      const lowerLabel = label.toLowerCase();
      if (lowerLabel.includes("intro")) currentType = "intro";
      else if (lowerLabel.includes("outro")) currentType = "outro";
      else if (lowerLabel.includes("bridge")) currentType = "bridge";
      else if (lowerLabel.includes("solo")) currentType = "solo";
      else if (lowerLabel.includes("pre-chorus") || lowerLabel.includes("prechorus")) currentType = "pre-chorus";
      else if (lowerLabel.includes("chorus") || lowerLabel.includes("chords")) currentType = "chorus";
      else if (lowerLabel.includes("interlude")) currentType = "interlude";
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
    currentRaw.push(trimmed);
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
function extractLyricLines(choproText, metaBpm, durationHint) {
  // Delegates to the shared Timing parser (web/public/timing.js), which resolves
  // the real lyric times across all the annotation dialects in the library.
  // @time=N is LRCLIB ground truth; @bar=N converts at meta BPM; the trailing
  // @N.NN UG noise is ignored. Returns [{time, bar, text, type}] plus an
  // `estimated` boolean attached to the array when timing is not trustworthy.
  const r = Timing.analyze(choproText, metaBpm || 120, durationHint);
  const out = [];
  for (const ln of r.lines) {
    if (out.length >= 500) break;
    out.push({
      time: ln.time !== null && ln.time !== undefined ? ln.time : null,
      bar: ln.bar !== null && ln.bar !== undefined ? ln.bar : null,
      text: ln.text,
      type: ln.type === "solo" ? "solo" : "lyric",
    });
  }
  out.estimated = !!r.estimated;
  out.bpm = r.bpm;
  out.maxBar = r.maxBar;
  return out;
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

  return normalizeSections(sections, totalBars, bpm);
}

// Subdivides sparse sections or collapses overlapping sections so the Metro Map timeline is clean and useful
function normalizeSections(rawSections, totalBars, bpm) {
  if (!totalBars || totalBars <= 0) totalBars = 128;
  if (!bpm || bpm <= 0) bpm = 120;
  if (!rawSections || rawSections.length === 0) {
    rawSections = [{ bar: 1, text: "Verse", type: "verse", token: "[V1]", time: 0 }];
  }

  // 1. Remove adjacent duplicate-type sections or sections closer than 8 bars apart
  const filtered = [];
  for (let i = 0; i < rawSections.length; i++) {
    const sec = rawSections[i];
    const nextBar = (i + 1 < rawSections.length) ? rawSections[i + 1].bar : totalBars;
    const span = nextBar - sec.bar;
    if (span >= 8 || filtered.length === 0) {
      filtered.push(sec);
    }
  }

  // 2. Subdivide long spans (> 32 bars) into 16-bar section blocks
  const result = [];
  let vC = 0, cC = 0, bC = 0, sC = 0;
  for (let i = 0; i < filtered.length; i++) {
    const sec = filtered[i];
    const nextBar = (i + 1 < filtered.length) ? filtered[i + 1].bar : totalBars;
    const span = nextBar - sec.bar;

    result.push(sec);

    if (span > 32) {
      let currentBar = sec.bar + 16;
      while (currentBar <= nextBar - 12) {
        let subType = sec.type === "chorus" ? "verse" : "chorus";
        if (result.length % 3 === 0) subType = "bridge";

        const time = ((currentBar - 1) * 4 * 60) / bpm;
        result.push({
          bar: currentBar,
          time: Math.round(time * 100) / 100,
          text: subType,
          type: subType,
          token: ""
        });
        currentBar += 16;
      }
    }
  }

  // 3. Reassign unique tokens to all sections
  vC = 0; cC = 0; bC = 0; sC = 0;
  for (const sec of result) {
    const t = sec.type || "verse";
    if (t === "verse") { vC++; sec.token = "[V" + vC + "]"; }
    else if (t === "chorus") { cC++; sec.token = "[C" + cC + "]"; }
    else if (t === "bridge") { bC++; sec.token = "[B" + bC + "]"; }
    else if (t === "solo") { sC++; sec.token = "[S" + sC + "]"; }
    else { sec.token = "[" + t.charAt(0).toUpperCase() + (result.indexOf(sec) + 1) + "]"; }
  }

  return result;
}

// Generate sections directly from ChordPro directive sections when meta is sparse.
// Distributes bars proportionally to each section based on line count.
function sectionsFromChordpro(choproSections, bpm, lyrics, durationBars) {
  const totalBars = durationBars || Math.max(...lyrics.map(e => e.bar), 128) + 8;
  const verseCount = 0, chorusCount = 0, preChorusCount = 0;

  // Prefer REAL bar positions: parse @bar annotations from each section's
  // raw chopro lines (kept verbatim in cs.raw), falling back to proportional
  // line-based distribution only when a section has no @bar.
  let currentBar = 1;
  const sections = [];
  let vC = 0, cC = 0, pC = 0;
  for (const cs of choproSections) {
    // Extract the first @bar= found in this section's raw lines.
    let startBar = null;
    if (cs.raw) {
      for (const rl of cs.raw) {
        const m = /@bar\s*=\s*(\d+)/i.exec(rl);
        if (m) { startBar = parseInt(m[1], 10); break; }
      }
    }
    if (startBar && startBar >= currentBar) currentBar = startBar;
    else if (startBar && startBar >= 1) currentBar = startBar;
    const time = ((currentBar - 1) * 4 * 60) / bpm;

    let type = cs.type || "verse";
    if (type === "verse") vC++;
    else if (type === "chorus") cC++;
    else if (type === "pre-chorus") pC++;

    sections.push({
      bar: currentBar,
      time: Math.round(time * 100) / 100,
      text: cs.label || type,
      type,
      token: getSectionToken(type, vC, cC, pC),
    });

    // Advance to the next section's first bar (or +1 if unknown).
    currentBar = currentBar + 1;
  }

  return normalizeSections(sections, totalBars, bpm);
}

// Resolve meta.json path with slug fallback (folder may not match songId)
function resolveMetaPath(songId) {
  const exactPath = path.join(REAPER_SONGS_PATH, songId, "meta.json");
  if (fs.existsSync(exactPath)) return exactPath;
  // O(1) lookup via slug map
  const folder = slugFolderMap.get(songId.toLowerCase());
  if (folder) {
    const fpath = path.join(REAPER_SONGS_PATH, folder, "meta.json");
    if (fs.existsSync(fpath)) return fpath;
  }
  // Fallback: O(n) scan (only if map not populated)
  try {
    const folders = fs.readdirSync(REAPER_SONGS_PATH, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const f of folders) {
      const slug = f.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      if (slug === songId) {
        const fpath = path.join(REAPER_SONGS_PATH, f.name, "meta.json");
        if (fs.existsSync(fpath)) return fpath;
      }
    }
  } catch (err) {}
  return null;
}

function resolveChoproPath(songId) {
  const exactPath = path.join(REAPER_SONGS_PATH, songId, "song.chopro");
  if (fs.existsSync(exactPath)) return exactPath;
  const folder = slugFolderMap.get(songId.toLowerCase());
  if (folder) {
    const fpath = path.join(REAPER_SONGS_PATH, folder, "song.chopro");
    if (fs.existsSync(fpath)) return fpath;
  }
  try {
    const folders = fs.readdirSync(REAPER_SONGS_PATH, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const f of folders) {
      const slug = f.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      if (slug === songId) {
        const fpath = path.join(REAPER_SONGS_PATH, f.name, "song.chopro");
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
  maxHttpBufferSize: 65536, // 64KB — prevents giant message DOS
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
  // Keep the shared tempo authority in step with whichever source set BPM
  // (song load / REAPER bridge) unless a live tap/link source is authoritative.
  if (Math.abs(state.tempo.bpm - state.bpm) > (state.tempo.source === "tap" ? 0.0001 : 0.01)) {
    state.tempo.bpm = state.bpm;
  }
  if (!state.tempo.ts) state.tempo.ts = Date.now();
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

const SESSION_SETLIST_PATH = process.env.SESSION_SETLIST_PATH || path.join(__dirname, "..", "data", "setlists", "_last_session.json");

function saveSessionSetlist() {
  try {
    if (activeSetlist.length > 0) {
      const data = {
        name: "_last_session",
        songs: activeSetlist.map(s => ({ id: s.id, folder: s.folder, title: s.title, artist: s.artist || "", bpm: s.bpm || 0 })),
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
  ensureSongLibrary();
  activeSetlist = songs.map(enrichSetlistEntry).filter(s => s && s.title);
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
          // Build slug→folder map for O(1) lookups
          slugFolderMap.set(id, dir.name);
          slugFolderMap.set(dir.name.toLowerCase(), dir.name);
          titleFolderMap.set(String(meta.title || dir.name).toLowerCase(), dir.name);
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

// Slug→folder map — built during ensureSongLibrary, used by resolveMetaPath/resolveChoproPath
const slugFolderMap = new Map();
// Title→folder map — used to resolve setlist entries pushed from the TUI
const titleFolderMap = new Map();

// Resolve a setlist entry ({id, slug, title} or a bare string) to the raw
// ~/ReaperSongs folder name. Returns null when unknown.
function resolveEntryFolder(entry) {
  if (typeof entry === "string") {
    return slugFolderMap.get(entry) || slugFolderMap.get(entry.toLowerCase()) || null;
  }
  if (!entry || typeof entry !== "object") return null;
  if (entry.id) {
    const f = slugFolderMap.get(entry.id);
    if (f) return f;
  }
  if (entry.slug) {
    const f = slugFolderMap.get(entry.slug) || slugFolderMap.get(String(entry.slug).toLowerCase());
    if (f) return f;
  }
  if (entry.title) {
    return titleFolderMap.get(String(entry.title).toLowerCase()) || null;
  }
  return null;
}

// Stable slug id — mirrors the Lua library's Util.slug so the REAPER runner
// can join on it ("Summer Of 69" folder → "summer_of_69").
function slugIdForFolder(folder) {
  return String(folder).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// Normalize any incoming setlist item into the canonical
// {id, folder, title, artist, bpm, slug} shape.
function enrichSetlistEntry(entry) {
  if (typeof entry === "string") entry = { slug: entry };
  if (!entry || typeof entry !== "object") return null;
  const folder = resolveEntryFolder(entry);
  const id = folder ? slugIdForFolder(folder) : (entry.id || "");
  const song = id ? songLibrary.find(s => s.id === id) : null;
  return {
    id,
    folder: folder || "",
    title: song ? song.title : (entry.title || entry.slug || id || folder || "?"),
    artist: song ? song.artist : (entry.artist || ""),
    bpm: song ? (song.bpm || 0) : (entry.bpm || 0),
    slug: entry.slug || id,
  };
}

function processSongData(songId) {
  const metaPath = resolveMetaPath(songId);
  const choproPath = resolveChoproPath(songId);
  // Reset before load — prevents stale state leak if any step fails
  state.lyricLines = [];
  state.lyricSync = { ok: false, annotatedPct: 0, totalLines: 0, annotatedLines: 0, warnings: ["Lyric data unavailable"] };
  state.sections = [];
  state.duration = 240;
  try {
    if (metaPath && fs.existsSync(metaPath)) {
      const metaRaw = fs.readFileSync(metaPath, "utf-8");
      const meta = JSON.parse(metaRaw);
      // Validate required field types — prevent undefined/NaN crashes downstream
      if (typeof meta.bpm !== 'number' || !isFinite(meta.bpm) || meta.bpm <= 0 || meta.bpm > 400) {
        console.warn("[Sections] Invalid BPM for", songId, ":", meta.bpm);
      }
      if (!Array.isArray(meta.lyrics)) {
        console.warn("[Sections] Invalid lyrics for", songId, ":", typeof meta.lyrics);
      }
      if (typeof meta.duration_bars !== 'number' || !isFinite(meta.duration_bars) || meta.duration_bars < 0) {
        meta.duration_bars = 128;
      }
      let choproText = "";
      if (choproPath && fs.existsSync(choproPath)) {
        choproText = fs.readFileSync(choproPath, "utf-8");
      }
      if (meta.lyrics && meta.bpm) {
        state.lyricLines = extractLyricLines(choproText, meta.bpm, meta.lrc_duration_sec);

        // Compute lyric sync health
        var totalLyricLines = state.lyricLines.length;
        var annotatedLyricLines = state.lyricLines.filter(function (l) { return (l.time !== null && l.time !== undefined) || (l.bar !== null && l.bar !== undefined); }).length;
        var annotatedPct = totalLyricLines > 0 ? Math.round((annotatedLyricLines / totalLyricLines) * 100) : 100;
        var syncWarnings = [];
        if (state.lyricLines.estimated) {
          syncWarnings.push("Timing flagged — lyrics capped, may be out of sync (re-sync from LRCLIB)");
        } else if (totalLyricLines > 0 && annotatedLyricLines === 0) {
          syncWarnings.push("No @time/@bar — lyrics estimated, may be out of sync");
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

        // Duration: prefer LRCLIB lrc_duration_sec (authoritative real track
        // length). Fall back to timing-parser-derived bar calculation.
        let totalBars = Math.max(state.lyricLines.maxBar || meta.duration_bars || 128, meta.duration_bars || 128);
        if (meta.lrc_duration_sec && meta.lrc_duration_sec > 0) {
          state.duration = Math.round(meta.lrc_duration_sec);
        } else {
          state.duration = Math.round((totalBars * 4 * 60) / (state.lyricLines.bpm || meta.bpm || 120));
        }
        state.sections = computeSections(state.lyricLines.bpm || meta.bpm, meta.lyrics, choproText, totalBars);
        state._lastDurationSongId = songId;
        const secCount = state.sections ? state.sections.length : 0;
        const lyricCount = state.lyricLines ? state.lyricLines.length : 0;
        console.log(`[Sections] ${songId}: ${secCount} sections, ${lyricCount} lyric lines, duration=${state.duration}s, bars=${totalBars}, est=${state.lyricLines.estimated ? 1 : 0}`);
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
  startLocalTick();
  console.log("[Local] Play from", localPlayOffset.toFixed(1) + "s");
}

function localPause() {
  if (localPlaying) {
    localPlayOffset = localPlayOffset + Math.max(0, (Date.now() - localPlayStartTime) / 1000);
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
  stopLocalTick();
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
  state.tempo = state.tempo || { bpm: 120, source: "reaper", downbeatAt: 0, downbeatRev: 0, ts: Date.now() };
  state.tempo.bpm = state.bpm;
  state.tempo.source = "reaper";
  state.tempo.downbeatAt = 0;
  tapTimes = [];
  _tapAnchored = false;
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
// Interval runs only when localPlaying is true — cleared on stop.
let lastBroadcastPos = -1;
let localTickInterval = null;

function startLocalTick() {
  if (localTickInterval) return;
  localTickInterval = setInterval(() => {
    if (!localPlaying) return;
    // REAPER is the authoritative clock when connected — never let the local
    // sim advance or flip state.playing while the runner is live.
    if (state.connected || isReaperActive()) return;
    const elapsed = localPlayOffset + (Date.now() - localPlayStartTime) / 1000;
    const duration = state.duration > 0 ? state.duration : 120;
    if (elapsed >= duration && duration > 0) {
      localStop();
      if (state.songIndex < state.totalSongs) {
        // Song ended: load the next song's lyrics for the teleprompter but
        // do NOT start it and do NOT change BPM. The click keeps running at
        // the previous song's tempo until the user presses PLAY/next, which
        // starts the count-in at the NEW song's tempo.
        console.log("[Local] Song finished, loading next (stopped)");
        const prevBpm = state.bpm;
        state._restoreBpmOnPlay = prevBpm; // hold prev tempo through the gap
        localJumpToSong(state.songIndex + 1);
        state.bpm = prevBpm; // keep old tempo while next is staged
        state.playing = false;
        broadcastState();
      }
      return;
    }
    state.position = elapsed;
    state.playing = true;
    if (Math.floor(elapsed * 10) !== lastBroadcastPos) {
      lastBroadcastPos = Math.floor(elapsed * 10);
      broadcastState();
    }
  }, 33);
}

function stopLocalTick() {
  if (localTickInterval) { clearInterval(localTickInterval); localTickInterval = null; }
}

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
const BRIDGE_STATE_PATH = process.env.BRIDGE_STATE_PATH || path.join(__dirname, "..", "data", "bridge_state.json");

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
          // REAPER is authoritative — disable the local sim so its clock can
          // never advance/flip playing while the runner is live.
          if (localPlaying) { localPlaying = false; stopLocalTick(); }
          else if (localTickInterval) stopLocalTick();
          // Use explicit null coalescing so that null/undefined values from the
          // runner propagate correctly. The `||` fallback was caching stale
          // song titles when the runner published `currentSong: null` (e.g.
          // transport past set end, end-of-show blank). songIndex is NOT
          // null-coalesced because index 0 is a valid "no song" sentinel.
          state.currentSong = luaState.currentSong !== undefined ? luaState.currentSong : state.currentSong;
          state.songId = luaState.songId !== undefined ? luaState.songId : state.songId;
          state.nextSong = luaState.nextSong !== undefined ? luaState.nextSong : state.nextSong;
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
          state.paused = luaState.paused !== undefined ? luaState.paused : state.paused;
          state.armed = luaState.armed !== undefined ? luaState.armed : state.armed;
          state.stagedIndex = luaState.stagedIndex !== undefined ? luaState.stagedIndex : state.stagedIndex;
          state.countIn = luaState.countIn !== undefined ? luaState.countIn : state.countIn;
          state.beatAnchorSec = luaState.beatAnchorSec !== undefined ? luaState.beatAnchorSec : state.beatAnchorSec;
          state.connected = true;
          if (luaState.time_sig) state.timeSig = luaState.time_sig;

          if (luaState.fxData) io.emit("fxData", luaState.fxData);
          if (luaState.trackLevels) io.emit("trackLevels", luaState.trackLevels);
          if (luaState.loopStates) io.emit("loopState", luaState.loopStates);
          if (luaState.synthData) io.emit("synthData", luaState.synthData);

          // Mirror the runner's staged song into the singer queue (teleprompter).
          syncStagedToSinger();

          // Compute current lyric line index from server-parsed lyric lines
          computeCurrentLyricLine();

          // On song change, compute sections from meta.json + ChordPro directives
          if (luaState.songId && luaState.songId !== lastSongId) {
            lastSongId = luaState.songId;
            _syncedStagedSongId = null;
            state.tempo.source = "reaper";
            state.tempo.downbeatAt = 0;
            tapTimes = [];
            _tapAnchored = false;
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
                  state.lyricLines = extractLyricLines(choproText, meta.bpm, meta.lrc_duration_sec);
                  var totalLyricLines = state.lyricLines.length;
                  var annotatedLyricLines = state.lyricLines.filter(function (l) { return (l.time !== null && l.time !== undefined) || (l.bar !== null && l.bar !== undefined); }).length;
                  var annotatedPct = totalLyricLines > 0 ? Math.round((annotatedLyricLines / totalLyricLines) * 100) : 100;
                  var syncWarnings = [];
                  if (state.lyricLines.estimated) {
                    syncWarnings.push("Timing flagged — lyrics capped, may be out of sync (re-sync from LRCLIB)");
                  } else if (totalLyricLines > 0 && annotatedLyricLines === 0) {
                    syncWarnings.push("No @time/@bar — lyrics estimated, may be out of sync");
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
                  let totalBars = Math.max(state.lyricLines.maxBar || meta.duration_bars || 128, meta.duration_bars || 128);
                  if (meta.lrc_duration_sec && meta.lrc_duration_sec > 0) {
                    state.duration = Math.round(meta.lrc_duration_sec);
                  } else {
                    state.duration = Math.round((totalBars * 4 * 60) / (state.lyricLines.bpm || meta.bpm || 120));
                  }
                  state.sections = computeSections(state.lyricLines.bpm || meta.bpm, meta.lyrics, choproText, totalBars);
                  state._lastDurationSongId = luaState.songId;
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
        } else {
          state.connected = false;
        }
      }
    }
  } catch (err) {
    if (err && err.message && !err.message.includes("JSON") && !err.message.includes("ENOENT")) {
      console.warn("[Poll] Error reading bridge_state.json:", err.message);
    }
  }
}

setInterval(pollLuaState, 500);

// Keepalive — broadcast state even when nothing is playing, so the
// HUD's heartbeat banner doesn't fire during idle periods. At rest,
// the local tick only broadcasts when playing; this fills the gap.
setInterval(function () {
  if (!state.playing && !localTickInterval) {
    broadcastState();
  }
}, 3000);

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
        controlPlay();
        break;
      case "pause":
        if (!state.connected) localPause();
        else controlStop();
        break;
      case "stop":
        controlStop();
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
        writeControl("stage", { dir });
        break;
      }
      case "jumpToSong": {
        if (!state.connected) {
          localJumpToSong(parseInt(value) || 1);
          break;
        }
        writeControl("stage", { index: parseInt(value) || 1 });
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
          if (!state.armed) {
            console.log("[Start] Ignored — show not armed");
            break;
          }
          // Route through the control plane so the count-in runs (position is
          // held until the count-in completes, then the song starts). Without
          // this, lyrics start instantly with no count-in.
          controlPlay();
          break;
        }
        controlPlay();
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
        // A long pause starts a fresh run; the first tap of a run also becomes
        // the Beat-1 anchor once it completes 4 taps (one measure).
        if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 1500) {
          tapTimes = [];
          _tapAnchored = false;
        }
        tapTimes.push(now);
        while (tapTimes.length > 4) tapTimes.shift();

        if (tapTimes.length >= 2) {
          const intervals = [];
          for (let i = 1; i < tapTimes.length; i++) {
            intervals.push(tapTimes[i] - tapTimes[i - 1]);
          }
          const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
          const bpm = Math.round((60000 / avgMs) * 10) / 10;

          state.bpm = bpm;
          state.tempo.bpm = bpm;
          state.tempo.source = "tap";
          state.tempo.ts = now;

          // A completed 4-tap run locks Beat-1 to the FIRST tap of that run
          // (Force-style: the 4 taps are one measure).
          if (tapTimes.length === 4 && !_tapAnchored) {
            _tapAnchored = true;
            state.tempo.downbeatAt = tapTimes[0];
            state.tempo.downbeatRev = (state.tempo.downbeatRev || 0) + 1;
            console.log(`[Tempo] Downbeat locked @ ${tapTimes[0]} (rev ${state.tempo.downbeatRev})`);
          }

          sendOSC("/master/beats/minute", [bpm]);
          broadcastState();
          console.log(`[Tempo] ${tapTimes.length} taps → ${bpm} BPM (src=${state.tempo.source})`);
        }
        break;
      }

      case "set_tempo": {
        const num = parseFloat(value && value.bpm);
        if (!isNaN(num) && num > 0 && num <= 400) {
          state.bpm = Math.round(num * 10) / 10;
          state.tempo.bpm = state.bpm;
          state.tempo.source = (value && value.source) || "link";
          state.tempo.ts = Date.now();
          broadcastState();
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json(state);
});

// TUI debug state — the TUI posts its internal view here after every render
let _tuiDebugState = null;

app.post("/api/debug/tui-state", (req, res) => {
  _tuiDebugState = req.body || null;
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// DEBUG SNAPSHOT — "what does the HUD/teleprompter/TUI see?"
// ═══════════════════════════════════════════════════════════
// One call that reveals every system's view + integrity checks, so a mismatch
// (bridge song vs singer song, region duration vs real audio, lyric timing
// health) is visible in seconds instead of "at the rig, days".
app.get("/api/debug/snapshot", async (req, res) => {
  const out = { ts: new Date().toISOString() };

  // 1. Bridge state (what the HUD + click read).
  out.bridge = {
    connected: state.connected,
    playing: state.playing,
    paused: state.paused,
    position: state.position,
    duration: state.duration,
    currentSong: state.currentSong,
    songId: state.songId,
    nextSong: state.nextSong,
    songIndex: state.songIndex,
    totalSongs: state.totalSongs,
    bpm: state.bpm,
    timeSig: state.timeSig,
    armed: state.armed,
    stagedIndex: state.stagedIndex,
    countIn: state.countIn,
    beatAnchorSec: state.beatAnchorSec,
    lyricLines: state.lyricLines ? state.lyricLines.length : 0,
    sections: state.sections ? state.sections.length : 0,
    lyricSync: state.lyricSync,
  };

  // 2. Singer server (what the TUI + teleprompter read).
  let singer = null;
  try {
    const r = await fetch("http://127.0.0.1:3300/api/queue/current");
    singer = await r.json();
  } catch (e) {
    singer = { error: "singer :3300 unreachable: " + e.message };
  }
  out.singer = singer;

  // 2b. TUI internal state (what the TUI thinks, posted every render).
  out.tui = _tuiDebugState ? {
    ageMs: Date.now() - (_tuiDebugState.ts || 0),
    focus: _tuiDebugState.focus,
    queueView: _tuiDebugState.queueView,
    showMode: _tuiDebugState.showMode,
    hudReaperPlaying: _tuiDebugState.hudReaperPlaying,
    reaperState: _tuiDebugState.reaperState,
    queueState: _tuiDebugState.queueState,
  } : { ageMs: null, error: "TUI has not reported state yet" };

  // 3. Current song data integrity (from the bridge's songId).
  const songId = state.songId;
  if (songId) {
    const folder = resolveSongFolder(songId);
    out.song = { id: songId, folder };
    if (folder) {
      const metaPath = path.join(REAPER_SONGS_PATH, folder, "meta.json");
      const choproPath = path.join(REAPER_SONGS_PATH, folder, "song.chopro");
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        out.song.meta = {
          bpm: meta.bpm, bpm_source: meta.bpm_source, bpm_verified: meta.bpm_verified,
          time_sig: meta.time_sig, duration_bars: meta.duration_bars,
          lrc_duration_sec: meta.lrc_duration_sec,
        };
      }
      if (fs.existsSync(choproPath)) {
        const ch = fs.readFileSync(choproPath, "utf-8");
        const parsed = Timing.analyze(ch, (out.song.meta && out.song.meta.bpm) || 120);
        const timed = parsed.lines.filter((l) => l.time !== null);
        let mono = true;
        for (let i = 1; i < timed.length; i++) if (timed[i].time < timed[i - 1].time) { mono = false; break; }
        // HUD lyric window: which line is current at state.position, + next few
        let currentIdx = -1;
        for (let i = 0; i < timed.length; i++) {
          if (timed[i].time !== null && timed[i].time <= state.position) currentIdx = i;
        }
        out.song.chopro = {
          timedLines: timed.length,
          totalLines: parsed.lines.length,
          estimated: parsed.estimated,
          monotonic: mono,
          lastTime: timed.length ? timed[timed.length - 1].time : null,
          lastText: timed.length ? timed[timed.length - 1].text.slice(0, 60) : null,
          currentLineIdx: currentIdx,
          currentLine: currentIdx >= 0 ? timed[currentIdx].text.slice(0, 60) : null,
          nextLines: [1, 2, 3].map((n) => {
            const i = currentIdx + n;
            return i < timed.length ? { time: timed[i].time, text: timed[i].text.slice(0, 60) } : null;
          }).filter(Boolean),
        };
        const meta2 = (out.song.meta && out.song.meta.lrc_duration_sec) ? out.song.meta : null;
        out.song.integrity = {
          regionDuration: state.duration,
          audioDuration: meta2 ? meta2.lrc_duration_sec : null,
          lyricsLastTime: out.song.chopro.lastTime,
          regionVsAudio: (state.duration && meta2 && meta2.lrc_duration_sec)
            ? Math.round(state.duration / meta2.lrc_duration_sec * 100) + "%" : null,
          regionVsLyrics: (state.duration && out.song.chopro.lastTime)
            ? Math.round(state.duration / out.song.chopro.lastTime * 100) + "%" : null,
        };
      }
    }
  }

  // 4. Cross-system consistency checks.
  const checks = [];
  const singerSong = out.singer && out.singer.current_song && out.singer.current_song.title;
  if (singerSong && state.currentSong) {
    const a = String(singerSong).toLowerCase().trim();
    const b = String(state.currentSong).toLowerCase().trim();
    if (a !== b && !a.includes(b) && !b.includes(a)) {
      checks.push({ level: "ERROR", msg: `Singer queue shows "${singerSong}" but bridge is playing "${state.currentSong}"` });
    } else {
      checks.push({ level: "OK", msg: `Singer + bridge agree on "${state.currentSong}"` });
    }
  }
  if (out.song && out.song.integrity) {
    const it = out.song.integrity;
    if (it.regionVsAudio && parseInt(it.regionVsAudio) > 130) {
      checks.push({ level: "ERROR", msg: `Region duration (${it.regionDuration}s) is ${it.regionVsAudio} of audio duration (${it.audioDuration}s) — likely corrupt duration_bars` });
    }
    if (it.regionVsLyrics && parseInt(it.regionVsLyrics) > 130) {
      checks.push({ level: "WARN", msg: `Region duration (${it.regionDuration}s) far exceeds last lyric (${it.lyricsLastTime}s) — lyrics may end early` });
    }
  }
  if (out.song && out.song.chopro) {
    if (!out.song.chopro.monotonic) checks.push({ level: "ERROR", msg: "Lyric @time lines are NOT monotonic" });
    if (out.song.chopro.estimated) checks.push({ level: "WARN", msg: "Lyric timing flagged estimated (corrupt @time values present)" });
  }

  // Cross-system checks: TUI vs Bridge vs Singer
  if (out.tui && out.tui.reaperState) {
    const tuiSong = out.tui.reaperState.currentSong || null;
    const bridgeSong = state.currentSong;
    if (tuiSong && bridgeSong && tuiSong !== bridgeSong) {
      checks.push({ level: "ERROR", msg: `TUI sees "${tuiSong}" but bridge has "${bridgeSong}" — TUI polling is stale` });
    } else if (tuiSong && bridgeSong) {
      checks.push({ level: "OK", msg: `TUI + bridge agree on "${bridgeSong}"` });
    }
    const tuiPlaying = out.tui.reaperState.playing;
    const bridgePlaying = state.playing;
    if (tuiPlaying !== undefined && bridgePlaying !== undefined && tuiPlaying !== bridgePlaying) {
      checks.push({ level: "WARN", msg: `TUI playing=${tuiPlaying} but bridge playing=${bridgePlaying} — transport state drift` });
    }
  }
  if (out.tui && out.tui.queueState) {
    const tuiQueueSong = out.tui.queueState.current_song && out.tui.queueState.current_song.title;
    const singerSong2 = singer && singer.current_song && singer.current_song.title;
    if (tuiQueueSong && singerSong2 && tuiQueueSong !== singerSong2) {
      checks.push({ level: "WARN", msg: `TUI queue shows "${tuiQueueSong}" but singer has "${singerSong2}"` });
    } else if (tuiQueueSong && singerSong2) {
      checks.push({ level: "OK", msg: `TUI queue + singer agree on "${singerSong2}"` });
    }
    if (out.tui.queueView) {
      checks.push({ level: "INFO", msg: `TUI view: ${out.tui.queueView} mode, focus=${out.tui.focus}, show=${out.tui.showMode}` });
    }
  }
  out.checks = checks;
  out.summary = checks.filter((c) => c.level === "ERROR").length ? "HAS ERRORS" : (checks.some((c) => c.level === "WARN") ? "WARNINGS" : "OK");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json(out);
});

// Shared tempo authority write — lets an external clock (Ableton Link peer,
// Force, another device) set the one tempo everyone follows.
app.post("/api/tempo", (req, res) => {
  const { bpm, source } = req.body || {};
  const num = parseFloat(bpm);
  if (isNaN(num) || num <= 0 || num > 400) {
    return res.status(400).json({ error: "bpm out of range" });
  }
  state.bpm = Math.round(num * 10) / 10;
  state.tempo.bpm = state.bpm;
  state.tempo.source = (source === "link" || source === "tap") ? source : "link";
  state.tempo.ts = Date.now();
  broadcastState();
  res.json({ ok: true, tempo: state.tempo });
});

app.post("/api/action", (req, res) => {
  const { type, value } = req.body || {};
  io.emit("action", { type, value });
  res.json({ ok: true });
});

// ── Local playback control (rehearsal mode) ──
// When REAPER is connected the control plane is the real transport: these
// route straight to REAPER (via OSC action) instead of the local clock, so the
// TUI/HUD never fight the authoritative runner state.
function isReaperActive() {
  try {
    if (fs.existsSync(BRIDGE_STATE_PATH)) {
      return (Date.now() - fs.statSync(BRIDGE_STATE_PATH).mtimeMs) / 1000 < 5;
    }
  } catch (e) {}
  return false;
}

// ── Control plane (ARM / PLAY / STOP) ──
// When REAPER is connected the runner owns the real transport; the server just
// forwards commands via control_command.json. When REAPER is offline we fall
// back to the local rehearsal sim, but PLAY is still gated on `armed`.
const CONTROL_PATH = path.join(__dirname, "..", "data", "control_command.json");

function writeControl(cmd, extra) {
  try {
    fs.writeFileSync(CONTROL_PATH, JSON.stringify(Object.assign({ cmd }, extra || {}), null, 2), "utf-8");
  } catch (err) {
    console.warn("[Control] Could not write command file:", err.message);
  }
}

async function syncBandSetToSinger() {
  if (activeSetlist.length === 0) return;
  try {
    await fetch("http://127.0.0.1:3300/api/band-queue/clear", { method: "POST" });
    for (const entry of activeSetlist) {
      const slug = entry.folder || entry.slug || entry.id;
      if (!slug) continue;
      await fetch("http://127.0.0.1:3300/api/band-queue/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
    }
    console.log(`[ARM] Synced ${activeSetlist.length} songs to singer band queue`);
  } catch (e) {
    console.warn("[ARM] Could not sync singer queue:", e.message);
  }
}

function controlArm(armed) {
  state.armed = !!armed;
  if (state.connected || isReaperActive()) {
    writeControl("arm", { armed: state.armed });
  }
  broadcastState();
  if (state.armed) syncBandSetToSinger();
  return { ok: true, armed: state.armed };
}

function controlPlay() {
  // PLAY only starts a song: it is a no-op until armed, and never interrupts a
  // playing song (STOP is the only way to end one).
  if (!state.armed) return { ok: true, ignored: true, reason: "not armed" };
  if (state.playing) return { ok: true, ignored: true, reason: "already playing" };
  if (state.connected || isReaperActive()) {
    writeControl("play");
  } else {
    // Local rehearsal path: generate a count-in so the HUD shows the
    // 4→3→2→1 overlay BEFORE the position clock starts advancing.
    // Count-in + click run at the LOADED song's tempo. Because the between-song
    // gap keeps state.bpm at the previous tempo, re-resolve from the current
    // song's library entry before the count-in begins.
    var loadedSong = songLibrary.find(function (s) { return s.id === state.songId; });
    var nextBpm = (loadedSong && loadedSong.bpm > 0) ? loadedSong.bpm : (state.bpm || 120);
    state.bpm = nextBpm;
    state.tempo.bpm = nextBpm;
    var beatsPerBar = (state.timeSig && state.timeSig[0]) || 4;
    var bpm = nextBpm;
    var beatSec = 60 / bpm;
    state.countIn = {
      active: true,
      beats: beatsPerBar,
      bpm: bpm,
      startedAt: Date.now(),
      expiresAt: Date.now() + (beatsPerBar * beatSec * 1000),
    };
    broadcastState();
    // Delay position start until count-in completes (song begins on beat 1)
    setTimeout(function () {
      if (state.countIn) state.countIn.active = false;
      if (!state.playing) localPlay();
    }, beatsPerBar * beatSec * 1000);
  }
  return { ok: true, playing: true };
}

function controlStop() {
  if (state.connected || isReaperActive()) {
    writeControl("stop");
  } else {
    localStop();
  }
  return { ok: true, playing: false };
}

// ── Stage the next song into the singer server (:3300) for the teleprompter ──
// After STOP the runner stages the next song; we mirror it into the singer
// queue so the teleprompter loads the next song's lyrics (armed, not playing).
let _syncedStagedSongId = null;
const SINGER_CONFIG_PATH = path.join(os.homedir(), "Music", "iPhoneLiveServer", "data", "config.json");
const crypto = require("crypto");

function singerAuthToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(SINGER_CONFIG_PATH, "utf-8"));
    if (cfg.password) return crypto.createHash("sha256").update(cfg.password).digest("hex");
  } catch (e) {}
  return null;
}

function syncStagedToSinger() {
  if (!state.stagedIndex || !state.songId || state.playing) return;
  if (state.songId === _syncedStagedSongId) return;
  _syncedStagedSongId = state.songId;
  const token = singerAuthToken();
  if (!token) return;
  fetch("http://127.0.0.1:3300/api/queue/load-song", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-auth-token": token },
    body: JSON.stringify({ slug: state.songId }),
  }).catch((e) => console.warn("[Stage→Singer] load-song failed:", e.message));
}

app.post("/api/control/arm", (req, res) => {
  res.json(controlArm((req.body && req.body.armed) !== false));
});
app.post("/api/control/play", (req, res) => {
  res.json(controlPlay());
});
app.post("/api/control/stop", (req, res) => {
  res.json(controlStop());
});
app.post("/api/control/next", (req, res) => {
  if (state.connected || isReaperActive()) writeControl("stage", { dir: 1 });
  else localJumpToSong(state.songIndex + 1);
  res.json({ ok: true });
});
app.post("/api/control/prev", (req, res) => {
  if (state.connected || isReaperActive()) writeControl("stage", { dir: -1 });
  else localJumpToSong(Math.max(1, state.songIndex - 1));
  res.json({ ok: true });
});

// Keep /api/local/{play,stop,pause} working for legacy callers (TUI space, HUD)
// but route them through the same control plane when REAPER is live.
app.post("/api/local/play", (req, res) => {
  res.json(controlPlay());
});
app.post("/api/local/stop", (req, res) => {
  res.json(controlStop());
});
app.post("/api/local/pause", (req, res) => {
  if (state.connected || isReaperActive()) {
    writeControl("stop"); // pause maps to STOP in the live model
  } else {
    localPause();
  }
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

// ── TUI live-set push ──
// Updates the active setlist like /api/local/setlist, but NEVER moves the
// transport or edits the play cursor — safe to call repeatedly mid-show.
app.post("/api/local/setlist/set", (req, res) => {
  const songs = req.body && req.body.songs;
  if (!Array.isArray(songs)) return res.json({ ok: false, error: "songs array required" });
  setActiveSetlist(songs);
  broadcastState();
  res.json({ ok: true, count: activeSetlist.length, totalSongs: activeSetlist.length });
});

// ── Pull the live set from the TUI (singer server) ──
// REAPER calls this so the runner always reflects the CURRENT TUI band set,
// even if a push hasn't happened since the queue changed (e.g. fresh boot).
function pullTuiQueue() {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 8000);
    fetch("http://127.0.0.1:3300/api/band-queue", { signal: ctrl.signal })
      .then(async (res) => {
        clearTimeout(timer);
        const text = await res.text();
        if (!text) return resolve({ ok: false, count: 0, reason: `empty body (${res.status})` });
        try {
          const q = JSON.parse(text);
          if (q && Array.isArray(q.band_queue) && q.band_queue.length > 0) {
            setActiveSetlist(q.band_queue.map(s => ({ slug: s.slug, title: s.title, artist: s.artist || "" })));
            broadcastState();
            resolve({ ok: true, count: activeSetlist.length });
            return;
          }
        } catch (e) {
          return resolve({ ok: false, count: 0, reason: e.message });
        }
        resolve({ ok: false, count: 0, reason: "band_queue empty" });
      })
      .catch((e) => resolve({ ok: false, count: 0, reason: e.message }));
  });
}

app.post("/api/local/setlist/pull-tui", async (req, res) => {
  const r = await pullTuiQueue();
  res.json(r);
});
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
  ensureSongLibrary();
  const entry = enrichSetlistEntry({ title });
  if (!entry) return res.json({ ok: false, error: "song not found" });
  if (!activeSetlist.find(s => s.title === entry.title)) {
    activeSetlist.push(entry);
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

// ═══════════════════════════════════════════════════════════
// BPM VERIFICATION (tap-to-verify)
// ═══════════════════════════════════════════════════════════
// Songs whose BPM has no trusted source are flagged bpm_verified=false. This
// endpoint set backs the tap-to-verify page: list pending songs, stream their
// audio, and lock a human-confirmed BPM into meta.json.

const SONG_AUDIO_DIR = path.join(os.homedir(), "Music", "SongAudio");

// Resolve a song folder by slug (mirrors resolveChoproPath).
function resolveSongFolder(songId) {
  if (typeof songId !== "string" || !songId.trim() || songId.includes("..") || songId.includes("/")) return null;
  const exact = path.join(REAPER_SONGS_PATH, songId);
  if (fs.existsSync(path.join(exact, "meta.json"))) return songId;
  try {
    const folders = fs.readdirSync(REAPER_SONGS_PATH, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const folder of folders) {
      const slug = folder.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      if (slug === songId) return folder.name;
    }
  } catch (e) {}
  return null;
}

// List songs needing BPM verification (bpm_verified != true), with audio present.
app.get("/api/verify/list", (req, res) => {
  const pending = [];
  try {
    const folders = fs.readdirSync(REAPER_SONGS_PATH, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const folder of folders) {
      const metaPath = path.join(REAPER_SONGS_PATH, folder.name, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      let meta;
      try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch { continue; }
      if (meta.bpm_verified === true) continue;
      const audioPath = path.join(SONG_AUDIO_DIR, folder.name, "full.mp3");
      if (!fs.existsSync(audioPath)) continue;
      pending.push({
        id: folder.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
        folder: folder.name,
        title: meta.title || folder.name,
        artist: meta.artist || "",
        currentBpm: meta.bpm || null,
        timeSig: meta.time_sig || [4, 4],
      });
    }
  } catch (e) {}
  res.json({ pending, count: pending.length });
});

// Stream a song's full.mp3 (with HTTP Range support for mobile playback).
app.get("/api/song-audio/:songId", (req, res) => {
  const folder = resolveSongFolder(req.params.songId);
  if (!folder) return res.status(404).json({ error: "Song not found" });
  const audioPath = path.join(SONG_AUDIO_DIR, folder, "full.mp3");
  if (!fs.existsSync(audioPath)) return res.status(404).json({ error: "No audio for song" });
  const stat = fs.statSync(audioPath);
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": "audio/mpeg",
    });
    fs.createReadStream(audioPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": stat.size, "Content-Type": "audio/mpeg" });
    fs.createReadStream(audioPath).pipe(res);
  }
});

// Lock a human-verified BPM into meta.json (tap-to-verify).
app.post("/api/verify/lock", (req, res) => {
  const folder = resolveSongFolder(req.body && req.body.id);
  if (!folder) return res.status(400).json({ error: "Song not found" });
  const bpm = parseFloat(req.body && req.body.bpm);
  if (isNaN(bpm) || bpm <= 0 || bpm > 400) return res.status(400).json({ error: "Invalid BPM" });
  const metaPath = path.join(REAPER_SONGS_PATH, folder, "meta.json");
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    meta.bpm = Math.round(bpm * 10) / 10;
    meta.bpm_source = "verified-manual";
    meta.bpm_verified = true;
    // Optional meter capture: 3/4 vs 4/4. Defaults to current (or 4/4).
    if (req.body && req.body.timeSig && Array.isArray(req.body.timeSig) && req.body.timeSig.length === 2) {
      const num = parseInt(req.body.timeSig[0], 10);
      const den = parseInt(req.body.timeSig[1], 10);
      if (num >= 1 && num <= 16 && (den === 4 || den === 8)) {
        meta.time_sig = [num, den];
      }
    } else if (!Array.isArray(meta.time_sig)) {
      meta.time_sig = [4, 4];
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
    console.log(`[Verify] Locked ${folder} BPM → ${meta.bpm} sig=${JSON.stringify(meta.time_sig)} (manual)`);
    res.json({ ok: true, bpm: meta.bpm, time_sig: meta.time_sig, song: folder });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
      .execSync("pgrep -f 'cloudflared tunnel'", { encoding: "utf-8", timeout: 10000 })
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
