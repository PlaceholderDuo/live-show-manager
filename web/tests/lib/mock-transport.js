"use strict";
// MockTransport — simulates the REAPER Lua bridge (bridge.lua) writing
// data/bridge_state.json. Lets the test harness drive the LSM server exactly
// as a real show would, so we can exercise the tempo/transport authority
// headlessly without REAPER.
//
// Usage:
//   const mt = MockTransport.create(bridgePath);
//   mt.set({ playing: true, position: 4.0, bpm: 122, time_sig: [4, 4], songId: "sunset" });
//   mt.play(); mt.tapBpm(146); mt.walk(seconds);   // advance position over time
//   mt.close();
const fs = require("fs");
const path = require("path");

const BASE = {
  connected: true,
  playing: false,
  paused: false,
  position: 0,
  duration: 300,
  bpm: 120,
  time_sig: [4, 4],
  currentSong: null,
  songId: null,
  currentArtist: null,
  currentKey: null,
  nextSong: null,
  nextArtist: null,
  songIndex: 1,
  totalSongs: 1,
  notes: "",
  showName: "test-show",
  elapsed: "0:00",
  remaining: "5:00",
  trackLevels: [],
  loopStates: {},
  fxData: { tracks: [] },
  synthData: {},
  regions: []
};

function create(bridgePath, opts = {}) {
  const state = { ...BASE };
  let mounted = false;
  let heartbeat = null;

  function write() {
    mkdirSync(path.dirname(bridgePath));
    fs.writeFileSync(bridgePath, JSON.stringify(state, null, 2));
  }

  function set(fields) {
    Object.assign(state, fields);
    write();
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    // Keep mtime fresh so the server's <5s active check stays satisfied,
    // mirroring bridge.lua's dynamic throttle (fast when playing).
    write();
    if (opts.heartbeat === undefined || opts.heartbeat === true) {
      heartbeat = setInterval(write, 200);
    }
  }

  // Advance position linearly at the given (real) BPM over `secs` seconds.
  function walk(secs, bpm) {
    const bpmEff = bpm || state.bpm || 120;
    const rate = bpmEff / 60;
    // advance in ~50ms steps to emulate the ~30ms playing throttle
    const stepMs = 50;
    const steps = Math.max(1, Math.floor(secs * 1000 / stepMs));
    for (let i = 0; i < steps; i++) {
      const dt = stepMs / 1000;
      state.position = (state.position || 0) + dt * rate;
      write();
    }
    return state.position;
  }

  function toJson() {
    return JSON.parse(fs.readFileSync(bridgePath, "utf-8"));
  }

  // Continuous playback LIKE bridge.lua at the playing throttle (~30ms):
  // advances state.position at the given BPM and writes. Mirrors a real
  // REAPER transport so count-in/beat math sees a moving position.
  let playbackTimer = null;
  function startPlayback(bpm) {
    const bp = bpm || state.bpm || 120;
    stopPlayback();
    state.playing = true;
    state.paused = false;
    playbackTimer = setInterval(() => {
      state.position = (state.position || 0) + (0.03 * bp) / 60;
      write();
    }, 30);
  }
  function stopPlayback() {
    if (playbackTimer) { clearInterval(playbackTimer); playbackTimer = null; }
  }

  function close() {
    stopPlayback();
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    mounted = false;
  }

  mount();

  return { set, write, walk, mount, close, startPlayback, stopPlayback, state, toJson };
}

function mkdirSync(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

module.exports = { create };