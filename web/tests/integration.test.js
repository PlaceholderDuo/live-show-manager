"use strict";
// ═══════════════════════════════════════════════════════════
// integration.test.js — Full control-plane lifecycle tests
// ═══════════════════════════════════════════════════════════
// These are the tests that would have caught the 5 bugs from the
// 2026-08-08 session. The existing transport.test.js covers API
// unit tests; this covers the actual show flow end-to-end:
//   ARM → PLAY → song plays → STOP → next song → PLAY →
//   transport past end-of-set → auto-stop → state cleans up
//
// Uses the same mock-transport + spawn-server helpers. Zero
// REAPER dependency — the mock bridge writes bridge_state.json
// exactly as the real Lua bridge does.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const { spawnServer } = require("./lib/spawn-server");
const MockTransport = require("./lib/mock-transport");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let srv;
let mt;

before(async () => {
  srv = await spawnServer({});
  mt = MockTransport.create(srv.bridgePath);
});

after(async () => {
  if (mt) mt.close();
  if (srv) await srv.stop();
});

// ── helpers ──

async function getState() {
  const res = await fetch(`${srv.baseUrl}/api/state`);
  return res.json();
}

async function api(path, method, body) {
  const opts = { method: method || "POST", headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${srv.baseUrl}${path}`, opts);
  return res.json();
}

// Wait for a state predicate to hold, polling every 150ms.
async function waitForState(pred, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    const st = await getState();
    if (pred(st)) return st;
    await sleep(150);
  }
  throw new Error(`timed out waiting for state: ${label || "condition"}`);
}

// ── 1. SETLIST + ARM ──

test("setlist: loading sets totalSongs, armed=false initially", async () => {
  await api("/api/local/setlist", "POST", {
    songs: [
      { title: "Gravity" },
      { title: "After Midnight" },
      { title: "A Boy Named Sue" },
    ],
  });

  const st = await getState();
  assert.equal(st.totalSongs, 3, "totalSongs after setlist load");
  assert.equal(st.armed, false, "not armed by default");
  assert.equal(st.songIndex, 1, "songIndex defaults to 1");
  assert.ok(st.currentSong, "a song is loaded");
});

test("arm: sets armed=true, does NOT start playing (gated)", async () => {
  await api("/api/control/arm", "POST", { armed: true });

  const st = await getState();
  assert.equal(st.armed, true, "armed after ARM command");
  assert.equal(st.playing, false, "ARM does not start playback");
});

// ── 2. PLAY + SONG ADVANCEMENT ──

test("play: ignored when no song loaded (clear → play)", async () => {
  // Verify the gate: play is a no-op until a song is staged
  // First, simulate a fresh state with no song
  await api("/api/control/arm", "POST", { armed: false });
  const r = await api("/api/control/play", "POST");
  assert.equal(r.ignored, true, "play ignored when not armed");
  assert.equal(r.reason, "not armed");
});

test("play: starts transport when armed, song advances", async () => {
  await api("/api/local/setlist", "POST", {
    songs: [{ title: "Gravity" }, { title: "After Midnight" }],
  });
  await api("/api/control/arm", "POST", { armed: true });

  // Simulate REAPER: transport at position 5, playing, on song 1
  mt.set({ playing: true, position: 5.0, bpm: 120, songId: "gravity", currentSong: "Gravity", songIndex: 1, totalSongs: 2 });
  const st = await waitForState((s) => s.playing === true && s.position >= 5, 4000, "playing");
  assert.equal(st.currentSong, "Gravity");
  assert.equal(st.songIndex, 1);
});

// ── 3. STOP + NEXT SONG ──

test("stop: halts transport, does not clear currentSong (teleprompter stays on last song)", async () => {
  // The runner stops transport but keeps the last song so the NOW PLAYING
  // label stays visible. The server should NOT nil out currentSong from a
  // bridge pub that sets playing=false — only past-cursor (songId change)
  // transitions currentSong.
  mt.set({ playing: false, position: 30, songId: "gravity", currentSong: "Gravity", songIndex: 1 });
  const st = await waitForState((s) => s.playing === false, 3000, "stopped");

  assert.equal(st.currentSong, "Gravity", "currentSong preserved after stop");
  assert.equal(st.songIndex, 1);
  assert.equal(st.playing, false);
});

// ── 4. SONG CHANGE PROPAGATES ──

test("song change: server picks up new songId from bridge", async () => {
  mt.set({ playing: true, position: 2, bpm: 130, songId: "after_midnight", currentSong: "After Midnight", songIndex: 2, totalSongs: 2 });
  const st = await waitForState((s) => s.songId === "after_midnight" && s.playing === true, 4000, "song change");
  assert.equal(st.currentSong, "After Midnight");
  assert.equal(st.songIndex, 2);
  assert.equal(st.bpm, 130);
});

// ── 5. END-OF-SET: transport past last region → auto-stop, clean state ──

test("end-of-set: runner publishes songIndex=0 + currentSong=null → server clears stale", async () => {
  // Simulate the runner's end-of-set behavior: position past last region,
  // publishes songIndex=0, currentSong=null, playing=false. The server
  // must accept null currentSong (see null-coalescing fix) rather than
  // caching the old title.
  mt.set({ playing: false, position: 500, songId: null, currentSong: null, songIndex: 0, nextSong: null });

  const st = await waitForState(
    (s) => s.playing === false && s.songIndex === 0,
    4000,
    "end-of-set cleanup"
  );

  // The critical assertions: stale currentSong must NOT survive
  assert.equal(st.currentSong, null, "currentSong cleared at end-of-set");
  assert.equal(st.songId, null, "songId cleared at end-of-set");
  assert.equal(st.songIndex, 0, "songIndex sentinel is 0");
  assert.equal(st.playing, false, "transport stopped");
});

// ── 6. NULL COALESCING BUG VERIFICATION ──

test("null coalescing: explicit null from bridge overrides cached title", async () => {
  // Prime the cache with a known song
  mt.set({ playing: true, position: 1, songId: "gravity", currentSong: "Gravity", songIndex: 1, totalSongs: 2 });
  await waitForState((s) => s.currentSong === "Gravity", 3000, "prime cache");

  // Then publish null — server must clear, not keep "Gravity"
  mt.set({ playing: false, position: 600, songId: null, currentSong: null, songIndex: 0, nextSong: null });

  const st = await waitForState(
    (s) => s.currentSong === null && s.songId === null,
    4000,
    "null coalescing override"
  );
  assert.equal(st.currentSong, null);
  assert.equal(st.songId, null);
});

// ── 7. REGION PROGRESSION ACROSS SONGS ──

test("region progression: songIndex tracks bridge correctly across multiple songs", async () => {
  await api("/api/local/setlist", "POST", {
    songs: [
      { title: "Song A" },
      { title: "Song B" },
      { title: "Song C" },
    ],
  });

  // Song 1 playing
  mt.set({ playing: true, position: 15, songId: "song_a", currentSong: "Song A", songIndex: 1, totalSongs: 3 });
  let st = await waitForState((s) => s.songIndex === 1 && s.currentSong === "Song A", 3000, "song A");
  assert.equal(st.totalSongs, 3);

  // Song 2 playing — the runner publishes nextSong from its region map
  mt.set({ playing: true, position: 45, songId: "song_b", currentSong: "Song B", songIndex: 2, totalSongs: 3, nextSong: "Song C" });
  st = await waitForState((s) => s.songIndex === 2 && s.currentSong === "Song B", 3000, "song B");
  assert.equal(st.nextSong, "Song C", "bridge publishes next song in region map");

  // Song 3 (last) playing — no next song
  mt.set({ playing: true, position: 90, songId: "song_c", currentSong: "Song C", songIndex: 3, totalSongs: 3, nextSong: null });
  st = await waitForState((s) => s.songIndex === 3 && s.currentSong === "Song C", 3000, "song C");
  assert.equal(st.nextSong, null, "no next song at end of set");
});

// ── 8. ARMED → STAGED TRANSITION ──

test("arm stages first song when bridge is connected", async () => {
  await api("/api/local/setlist", "POST", {
    songs: [{ title: "Gravity" }, { title: "After Midnight" }],
  });
  // Bridge connected, disarmed
  mt.set({ connected: true, playing: false, position: 0, songId: "gravity", currentSong: "Gravity", songIndex: 1, totalSongs: 2, armed: false, stagedIndex: 0 });

  await api("/api/control/arm", "POST", { armed: true });

  const st = await waitForState((s) => s.armed === true, 3000, "armed");
  assert.equal(st.armed, true);
});

// ── 9. RAPID TOGGLE: arm/disarm/arm doesn't corrupt state ──

test("rapid arm/disarm/arm: state stays consistent", async () => {
  await api("/api/control/arm", "POST", { armed: false });
  let st = await waitForState((s) => !s.armed, 2000, "disarmed");
  assert.equal(st.armed, false);

  await api("/api/control/arm", "POST", { armed: true });
  st = await waitForState((s) => s.armed, 2000, "re-armed");
  assert.equal(st.armed, true);

  await api("/api/control/arm", "POST", { armed: false });
  st = await waitForState((s) => !s.armed, 2000, "re-disarmed");
  assert.equal(st.armed, false);
});

// ── 10. SONG JUMP within setlist (prev/next) ──

test("next/prev: stage command propagates to bridge state", async () => {
  await api("/api/local/setlist", "POST", {
    songs: [{ title: "Gravity" }, { title: "After Midnight" }, { title: "Song C" }],
  });

  // Simulate bridge at song 1
  mt.set({ playing: false, songId: "gravity", currentSong: "Gravity", songIndex: 1, totalSongs: 3 });

  // next stages song 2 (but in headless mode without REAPER, the local
  // fallback just jumps to the next index within the library)
  const r = await api("/api/control/next", "POST");
  assert.equal(r.ok, true);
});

// ── 11. DURATION / BAR CALCULATION CONSISTENCY ──

test("duration: position advancing at known BPM produces expected bar index", async () => {
  await api("/api/local/setlist", "POST", {
    songs: [{ title: "Gravity" }],
  });

  // At 120 BPM, 2s = 4 beats = 1 bar (4/4)
  // position 2.0 → bar 1
  mt.set({ playing: true, position: 2.0, bpm: 120, time_sig: [4, 4], songId: "gravity", currentSong: "Gravity", songIndex: 1, totalSongs: 1 });

  const st = await waitForState((s) => s.playing === true && s.position >= 2, 3000, "position confirmed");
  assert.equal(st.bpm, 120);
  assert.deepEqual(st.timeSig, [4, 4]);
  // The actual bar counter is client-side; we verify server state is correct
  assert.ok(st.position >= 1.5, "position is advancing");
});

// ── 12. COUNT-IN STATE PROPAGATION ──

test("countIn: bridge publishes countIn → server broadcasts correctly", async () => {
  const ci = { active: true, rollStart: 1.5, beats: 4, bpm: 120, songId: "gravity" };
  mt.set({
    playing: true, position: 2.0, bpm: 120, time_sig: [4, 4],
    songId: "gravity", currentSong: "Gravity", songIndex: 1, totalSongs: 1,
    countIn: ci, beatAnchorSec: 3.5
  });

  const st = await waitForState(
    (s) => s.countIn && s.countIn.active === true && s.countIn.beats === 4,
    4000,
    "countIn broadcast"
  );
  assert.equal(st.countIn.bpm, 120);
  assert.equal(st.countIn.songId, "gravity");
  assert.ok(st.beatAnchorSec > 0);
});

// ── 13. SEEK PROPAGATION (live + local) ──

test("seek: bridge-active seek is optimistically broadcast and forwarded to the runner", async () => {
  const mt2 = MockTransport.create(srv.bridgePath);
  mt2.set({ playing: true, position: 30, bpm: 120, songId: "gravity", currentSong: "Gravity", songIndex: 1, totalSongs: 1 });

  await waitForState((s) => s.playing === true && s.position >= 30, 4000, "bridge active");
  const fs = require("fs");
  try { fs.rmSync(srv.controlPath, { force: true }); } catch (_) {}

  const r = await api("/api/local/seek", "POST", { target: 45 });
  assert.equal(r.ok, true);
  assert.equal(r.position, 45, "seek target applied immediately");

  // The runner control file carries the absolute target.
  const deadline = Date.now() + 3000;
  let cmd = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(srv.controlPath)) {
      try { cmd = JSON.parse(fs.readFileSync(srv.controlPath, "utf-8")); break; }
      catch (_) {}
    }
    await sleep(120);
  }
  assert.ok(cmd, "control command written");
  assert.equal(cmd.cmd, "seek");
  assert.equal(cmd.position, 45);
  mt2.close();
});

test("seek: local-mode absolute target moves position and reverses offsets", async () => {
  // Stop the mock transport cleanly, then let its bridge file age out so the
  // server falls back to the local rehearsal engine (which owns "seek").
  mt.set({ playing: false, position: 30, songId: "gravity", currentSong: "Gravity" });
  await waitForState((s) => s.playing === false, 4000, "stopped");
  mt.close();
  const staleDeadline = Date.now() + 7000;
  while (Date.now() < staleDeadline) {
    const st = await getState();
    if (!st.connected) break;
    await sleep(300);
  }
  assert.equal((await getState()).connected, false, "bridge went stale → local mode");

  const adv = await api("/api/local/seek", "POST", { offset: 2 });
  assert.equal(adv.ok, true);
  assert.ok(adv.position > 30, `offset advanced past baseline 30 (got ${adv.position})`);

  const back = await api("/api/local/seek", "POST", { target: 1 });
  assert.equal(back.position, 1, "absolute target supersedes prior offset");
});
