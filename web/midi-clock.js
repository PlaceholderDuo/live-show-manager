// ═══════════════════════════════════════════════════════════
// midi-clock.js — Akai Force (or any MIDI master clock) sync
// ═══════════════════════════════════════════════════════════
// Reads MIDI real-time clock (start/continue/stop/clock/position)
// from a configurable MIDI input port and converts it into the
// transport signals the Show Manager needs:
//   { bpm, playing, downbeatAt, downbeatRev, positionSec, beatAnchorSec }
//
// The Force is the MASTER CLOCK. The click Danny hears comes from
// the Force's own AUX → IEM mixer (never crosses the network). The
// Show Manager only needs the *tempo + beat phase* so the teleprompter
// and beat display follow the click exactly.
//
// Port resolution priority:
//   1. `port` in data/midi-clock.json (explicit device name)
//   2. Port whose name matches a known alias (Force / M-Track / Midi)
//   3. First available input (excluding our own virtual Tuner port)
//
// MIDI clock is 24 PPQN (ticks per beat). Start/Continue begins a
// measure at the next beat-1; Song Position Pointer (16th notes)
// jumps the transport position.
// ═══════════════════════════════════════════════════════════
const easymidi = require("easymidi");
const fs = require("fs");
const path = require("path");

const TICKS_PER_BEAT = 24;
const BEATS_PER_BAR = 4; // 4/4 grid for downbeat anchoring

class MidiClock {
  constructor(configPath) {
    this.configPath = configPath || path.join(__dirname, "..", "data", "midi-clock.json");
    this.input = null;
    this.enabled = true;

    // Beat phase state
    this._bpm = 0;
    this._playing = false;
    this._songStartMs = null;   // epoch ms of transport start (position 0)
    this._downbeatAt = 0;       // epoch ms of the most recent Beat-1
    this._downbeatRev = 0;
    this._positionSec = 0;

    // Tick timing (BPM derivation)
    this._tickTimes = [];       // rolling window of recent inter-tick intervals (ms)
    this._lastTickAt = null;
    this._startedAtEpoch = null;

    this.config = this._loadConfig();
  }

  _loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf-8");
        const cfg = JSON.parse(raw);
        this.enabled = cfg.enabled !== false;
        return cfg;
      }
    } catch (e) {
      console.warn("[MidiClock] Could not read config:", e.message);
    }
    return {};
  }

  _pickInputPort() {
    let ports;
    try {
      ports = easymidi.getInputs();
    } catch (e) {
      console.error("[MidiClock] Could not list MIDI inputs:", e.message);
      return null;
    }
    if (!ports || ports.length === 0) return null;

    // 1. Explicit config
    if (this.config.port) {
      const exact = ports.find((p) => p === this.config.port);
      if (exact) return exact;
      const fuzzy = ports.find((p) => p.toLowerCase().includes(this.config.port.toLowerCase()));
      if (fuzzy) return fuzzy;
      console.warn(`[MidiClock] Config port '${this.config.port}' not found. Scanning...`);
    }

    // 2. Known aliases
    const aliases = ["force", "m-track", "m track", "mtrack", "akai"];
    for (const a of aliases) {
      const hit = ports.find((p) => p.toLowerCase().includes(a));
      if (hit) return hit;
    }

    // 3. First available that is not our own virtual ports
    const skip = ["live show manager"];
    const fallback = ports.find((p) => !skip.some((s) => p.toLowerCase().includes(s)));
    return fallback || null;
  }

  start() {
    if (!this.enabled) {
      console.log("[MidiClock] Disabled via config — skipping.");
      return;
    }
    // Clock-stall watchdog: if a real Force keeps sending ticks this never
    // fires, but if the clock stops (Force transport stopped, USB pulled,
    // cable snagged) we flip back to stopped within ~1.5s so the HUD and
    // click don't keep running on stale beats.
    this._lastTickReceived = 0;
    this._watchdog = setInterval(() => {
      if (this._playing && this._lastTickReceived && Date.now() - this._lastTickReceived > 1500) {
        console.warn("[MidiClock] Clock stall — Force stopped sending. Marking stopped.");
        this._playing = false;
        this._emitState();
      }
    }, 500);

    // Port re-scan: if no port was found at boot (Force powered on later),
    // keep trying every 5s so we auto-connect when it appears.
    this._rescan = setInterval(() => {
      if (this.input) return; // already connected
      const port = this._pickInputPort();
      if (port) {
        console.log(`[MidiClock] Retry: found '${port}' — connecting.`);
        clearInterval(this._rescan);
        this._rescan = null;
        this._connect(port);
      }
    }, 5000);
    const port = this._pickInputPort();
    if (!port) {
      console.warn("[MidiClock] No MIDI input found. Will retry every 5s.");
      this._emitState();
      return;
    }
    this._connect(port);
  }

  _connect(port) {
    try {
      this.input = new easymidi.Input(port);
      console.log(`[MidiClock] Listening for Force clock on '${port}'`);

      this.input.on("clock", () => this._onTick());
      this.input.on("start", () => this._onStart());
      this.input.on("continue", () => this._onStart());
      this.input.on("stop", () => this._onStop());
      this.input.on("position", (msg) => this._onPosition(msg));
      this.input.on("error", (err) => console.warn("[MidiClock] Input error:", err.message));
    } catch (err) {
      console.error("[MidiClock] Could not open input:", err.message);
      this.input = null;
    }
  }

  stop() {
    if (this.input) {
      try { this.input.close(); } catch (e) {}
      this.input = null;
    }
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    if (this._rescan) { clearInterval(this._rescan); this._rescan = null; }
  }

  // ── MIDI clock handlers ──

  _onStart() {
    this._tickTimes = [];
    this._lastTickAt = null;
    this._startedAtEpoch = Date.now();
    this._songStartMs = Date.now();
    this._positionSec = 0;
    this._downbeatAt = Date.now(); // beat 1 anchored at transport start
    this._downbeatRev++;
    this._playing = true;
    console.log(`[MidiClock] START — transport running @ ${this._bpm || "?"} BPM, downbeat anchored`);
    this._emitState();
  }

  _onStop() {
    this._playing = false;
    console.log("[MidiClock] STOP");
    this._emitState();
  }

  _onTick() {
    const now = Date.now();
    this._lastTickReceived = now;

    // BPM derivation from inter-tick interval (24 ticks = 1 beat)
    if (this._lastTickAt) {
      const interval = now - this._lastTickAt;
      if (interval > 0 && interval < 500) {
        this._tickTimes.push(interval);
        while (this._tickTimes.length > 96) this._tickTimes.shift();
        const avg = this._tickTimes.reduce((a, b) => a + b, 0) / this._tickTimes.length;
        const bpm = 60000 / (avg * TICKS_PER_BEAT);
        if (this._bpm === 0 || Math.abs(bpm - this._bpm) > 0.05) {
          this._bpm = Math.round(bpm * 10) / 10;
        }
      }
    }
    this._lastTickAt = now;

    // Position advances from the transport-start anchor (wall clock).
    if (this._songStartMs && this._playing) {
      this._positionSec = (now - this._songStartMs) / 1000;
    }

    // Re-anchor Beat-1 at each measure boundary. With start-time anchor:
    // beat i lands at songStart + i * msPerBeat. Beat-1 of the current bar
    // is the most recent multiple of (4 beats) that is <= elapsed beats.
    if (this._songStartMs && this._bpm > 0) {
      const msPerBeat = 60000 / this._bpm;
      const beatsElapsed = (now - this._songStartMs) / msPerBeat;
      const barIndex = Math.floor(beatsElapsed / BEATS_PER_BAR);
      const downbeatAt = this._songStartMs + barIndex * BEATS_PER_BAR * msPerBeat;
      if (downbeatAt !== this._downbeatAt) {
        this._downbeatAt = downbeatAt;
        this._downbeatRev++;
      }
    }

    // Throttle emission to ~2 ticks (≈8–12 Hz at typical tempos)
    if (this._tickCount % 2 === 0) this._emitState();
    this._tickCount = (this._tickCount || 0) + 1;
  }

  _onPosition(msg) {
    // MIDI Song Position Pointer: 14-bit value in 16th notes since start.
    if (msg && typeof msg.value === "number") {
      const sixteenths = msg.value;
      const beats = sixteenths / 4;
      const msPerBeat = this._bpm > 0 ? 60000 / this._bpm : 500;
      // Shift the transport-start anchor so position == beats
      this._songStartMs = Date.now() - beats * msPerBeat;
      this._positionSec = beats * msPerBeat / 1000;
      this._downbeatAt = this._songStartMs;
      this._downbeatRev++;
      console.log(`[MidiClock] Song Position → ${beats} beats (${this._positionSec.toFixed(1)}s)`);
      this._emitState();
    }
  }

  // ── state snapshot ──

  _emitState() {
    if (this._onState) {
      this._onState({
        bpm: this._bpm,
        playing: this._playing,
        downbeatAt: this._downbeatAt,
        downbeatRev: this._downbeatRev,
        positionSec: this._positionSec,
        beatAnchorSec: this._songStartMs ? this._songStartMs / 1000 : 0,
        source: "midi",
      });
    }
  }

  onState(cb) { this._onState = cb; }
  onError(cb) { this._onError = cb; }
}

module.exports = MidiClock;
