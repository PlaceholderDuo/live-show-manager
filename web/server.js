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
  // OSC feedback from REAPER (track volumes, FX params, tuner data, etc.)
  trackVolumes: {},       // { trackIdx: dB }
  trackMutes: {},         // { trackIdx: true/false }
  trackNames: {},         // { trackIdx: "name" }
  fxParams: {},           // { "track-fx-param": value }
  tuner: null,            // { note: "A", cents: -3.2, frequency: 438.7, string: "A (5)" }
  activeAmpPreset: "OSD",
  activeScene: 0,
  keysOn: true,
  mixerValues: {},        // EDM knob values relayed from ReaLearn → REAPER → here
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
// Extracts content lines from chordpro with @bar=N annotations for client-side
// rendering. Returns [{bar, text, type}] where type is "lyric" or "solo".
// Lines without @bar=N get bar=null and the client estimates position.
function extractLyricLines(choproText) {
  const lines = [];
  const rawLines = (choproText || "").split("\n");

  function isDirective(s) { return /^\{/.test(s.trimStart()); }
  function isBareChord(s) {
    const trimmed = s.trim();
    if (!trimmed) return false;
    const words = trimmed.split(/\s+/);
    const chordLike = words.filter(w => /^[A-G][#b]?(?:m|dim|aug|sus[24]|add\d+|7b?9?|maj7?|dim7?|aug7?|6|9|11|13)?(?:\/[A-G][#b]?)?$/.test(w));
    return chordLike.length >= words.length * 0.7 && chordLike.length > 0;
  }
  function stripChords(s) {
    return s.replace(/\[.*?\]/g, "").trim();
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
    if (isBareChord(trimmed)) continue;

    // Extract @bar=N and @duration=N annotations
    let bar = null;
    let clean = stripChords(trimmed);
    const barMatch = clean.match(/^@bar=(\d+)\s*/);
    if (barMatch) {
      bar = parseInt(barMatch[1], 10);
      clean = clean.replace(/^@bar=\d+\s*/, "");
    }
    // Strip any remaining @\w+=\S+ annotations
    clean = clean.replace(/@\w+=\S+/g, "").trim();

    if (!clean) continue;

    // Skip metadata lines
    const lower = clean.toLowerCase();
    if (/^(song|artist|tuning|capo|tabbed|standard|no chords|let ring|palm mute)[:\s]/i.test(lower)) continue;

    lines.push({ bar, text: clean, type: inSolo ? "solo" : "lyric" });
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
// LUA STATE BRIDGE (file polling)
// ═══════════════════════════════════════════════════════════
const BRIDGE_STATE_PATH = path.join(__dirname, "..", "data", "bridge_state.json");

function pollLuaState() {
  try {
    if (fs.existsSync(BRIDGE_STATE_PATH)) {
      const raw = fs.readFileSync(BRIDGE_STATE_PATH, "utf-8").trim();
      if (raw) {
        const luaState = JSON.parse(raw);
        if (luaState.currentSong) state.currentSong = luaState.currentSong;
        if (luaState.songId) state.songId = luaState.songId;
        if (luaState.nextSong) state.nextSong = luaState.nextSong;
        if (luaState.songIndex !== undefined) state.songIndex = luaState.songIndex;
        if (luaState.totalSongs !== undefined) state.totalSongs = luaState.totalSongs;
        if (luaState.bpm) state.bpm = luaState.bpm;
        if (luaState.notes) state.notes = luaState.notes;
        if (luaState.position !== undefined) state.position = luaState.position;
        if (luaState.playing !== undefined) state.playing = luaState.playing;
        if (luaState.duration) state.duration = luaState.duration;
        if (luaState.currentKey) state.currentKey = luaState.currentKey;
        if (luaState.currentArtist) state.currentArtist = luaState.currentArtist;
        if (luaState.trackLevels) state.trackLevels = luaState.trackLevels;
        if (luaState.loopStates) state.loopStates = luaState.loopStates;
        if (luaState.connected !== undefined) state.connected = luaState.connected;

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
                state.sections = computeSections(meta.bpm, meta.lyrics, choproText, meta.duration_bars);
                state.lyricLines = extractLyricLines(choproText);
                const secCount = state.sections ? state.sections.length : 0;
                const lyricCount = state.lyricLines ? state.lyricLines.length : 0;
                console.log(`[Sections] ${luaState.songId}: ${secCount} sections, ${lyricCount} lyric lines, metaEntries=${meta.lyrics.length}`);
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
        if (state.playing) reaperAction("pause");
        else reaperAction("play");
        break;
      case "pause":
        reaperAction("pause");
        break;
      case "stop":
        reaperAction("stop");
        break;
      case "prev":
      case "next": {
        const dir = type === "next" ? 1 : -1;
        const targetIdx = Math.max(1, Math.min(state.totalSongs, (state.songIndex || 1) + dir));
        const targetRegion = state.regions && state.regions[targetIdx - 1];
        if (targetRegion && targetIdx !== state.songIndex) {
          const wasPlaying = state.playing;
          // Seek + play if was playing, just seek if stopped
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
          sendOSC(`/track/${value.track}/mute`, [value.state ? 1 : 0]);
          state.trackMutes[value.track] = value.state;
          broadcastState();
        } else {
          sendOSC(`/track/${value}/mute`, [1]);
        }
        break;
      case "solo":
        if (typeof value === 'object' && value.track !== undefined) {
          sendOSC(`/track/${value.track}/solo`, [value.state ? 1 : 0]);
        } else {
          sendOSC(`/track/${value}/solo`, [1]);
        }
        break;

      // ── Live Controller: Level-based mute (vocal/all/none) ──
      // value.level: "vocal" | "all" | "none"
      case "mute_with_level": {
        const level = (value && value.level) || "none";
        // Track indices for the current live project (edm-live-rig + vocal)
        const TRACKS = { vocal: 0, drums: 1, bass: 2, pads: 3 };
          // ⚠ Adjust these indices to match the actual REAPER project
        if (level === "vocal") {
          sendOSC(`/track/${TRACKS.vocal}/mute`, [1]);
        } else if (level === "all") {
          sendOSC(`/track/${TRACKS.vocal}/mute`, [1]);
          sendOSC("/master/mute", [1]);
        } else {
          sendOSC(`/track/${TRACKS.vocal}/mute`, [0]);
          sendOSC("/master/mute", [0]);
        }
        break;
      }

      // ── Live Controller: Scene select (SWS Snapshots 1-8) ──
      // value: scene number (1-8) or { scene: N }
      case "scene_select": {
        const scene = parseInt((value && value.scene) || value, 10);
        if (scene >= 1 && scene <= 8) {
          const n = String(scene).padStart(2, "0");
          sendOSC(`/action/_SWSSNAPSHOT_GET_${n}`, []);
          state.activeScene = scene;
          broadcastState();
          console.log(`[Scene] Load snapshot ${scene}`);
        }
        break;
      }

      // ── Live Controller: Keys (VST) toggle ──
      // value.on: true (unmute) / false (mute)
      case "keys_toggle": {
        const on = value && value.on;
        // Mute/unmute keyboard VST tracks (PADS, LEADS, PLUCKS)
        // Track indices: adjust to match project
        [3, 4, 5].forEach(function(ti) {
          sendOSC(`/track/${ti}/mute`, [on ? 0 : 1]);
        });
        state.keysOn = on;
        broadcastState();
        console.log(`[Keys] ${on ? 'ON' : 'OFF'}`);
        break;
      }

      // ── Live Controller: Start next song in queue ──
      case "start_song": {
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
      // value.preset: "OSD" | "SSS" | "SSS CLN" | "BE" | "BE CLN" | "TRLX" | "TWD"
      case "gtr_amp_preset": {
        const preset = (value && value.preset) || "OSD";
        const GTR_TRACK = 6;
        // NAM preset index mapping — adjust FX and param indices to match project
        const NAM_PRESET_MAP = {
          "OSD": 0, "SSS": 1, "SSS CLN": 2, "BE": 3, "BE CLN": 4, "TRLX": 5, "TWD": 6
        };
        const presetIdx = NAM_PRESET_MAP[preset] !== undefined ? NAM_PRESET_MAP[preset] : 0;
        sendOSC(`/track/${GTR_TRACK}/fx/1/param/1/value`, [presetIdx / 6]);
        state.activeAmpPreset = preset;
        broadcastState();
        console.log(`[GTR AMP] Preset: ${preset} → NAM index ${presetIdx}`);
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
    sendOSC(`/track/${trackIdx}/fx/${fxIdx}/param/${paramIdx}/value`, [value]);
  });

  // ── GTR FX knob changes (iPhone → REAPER) ──
  socket.on("gtrFxKnob", (data) => {
    const { param, value } = data || {};
    const GTR_TRACK = 6;
    const PARAM_MAP = { delay_time: 1, feedback: 2, mod_rate: 3, mod_depth: 4 };
    const paramIdx = PARAM_MAP[param] || 1;
    sendOSC(`/track/${GTR_TRACK}/fx/1/param/${paramIdx}/value`, [value]);
  });

  // ── FX parameter change (via OSC) ──
  socket.on("fxParam", (data) => {
    const { trackIdx, fxIdx, paramIdx, value } = data || {};
    const address = `/track/${trackIdx}/fx/${fxIdx}/param/${paramIdx}/value`;
    sendOSC(address, [value]);
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
    const ctx = clientContexts.get(socket.id);

    if (ctx && ctx.activeTab === "fx" && ctx.fxTrackIdx !== undefined && ctx.fxIdx !== undefined) {
      const address = `/track/${ctx.fxTrackIdx}/fx/${ctx.fxIdx}/param/${knob}/value`;
      sendOSC(address, [value]);
    } else {
      sendOSC(`/control/knob/${knob}`, [value]);
    }
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

// ── ChordPro file endpoint ──
// Returns the raw ChordPro text for a song, or 404.
app.get("/api/chordpro/:songId", (req, res) => {
  const songId = req.params.songId;
  // Sanitize: prevent directory traversal — only allow alphanumeric, underscores, hyphens
  if (!/^[a-zA-Z0-9_\-]+$/.test(songId)) {
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
  if (!/^[a-zA-Z0-9_\-]+$/.test(songId)) {
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

  // Register Bonjour service so iOS can discover via mDNS hostname resolution
  let bonjourSvc = null;
  try {
    // Use -R with hostname as service name for maximum compatibility
    const hostname = getBonjourHostname().replace(/\.local$/, "");
    bonjourSvc = cp.spawn("dns-sd", [
      "-R", hostname, "_http._tcp", ".", String(PORT)
    ], { stdio: ["ignore", "ignore", "ignore"], detached: false });
    bonjourSvc.unref();
    process.on("exit", () => { try { bumperStop(); bonjourSvc.kill(); } catch {} });
    process.on("SIGINT", () => { try { bumperStop(); bonjourSvc.kill(); } catch {} });
    process.on("SIGTERM", () => { try { bumperStop(); bonjourSvc.kill(); } catch {} });
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
