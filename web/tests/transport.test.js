"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const { io } = require("socket.io-client");
const { spawnServer } = require("./lib/spawn-server");
const MockTransport = require("./lib/mock-transport");

let srv;
let mt;
let socket;
let seen = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  srv = await spawnServer({});
  mt = MockTransport.create(srv.bridgePath);
  socket = io(srv.baseUrl, { transports: ["websocket", "polling"] });
  socket.on("state", (s) => { seen.push(s); });
  await new Promise((r) => socket.once("connect", r));
});

beforeEach(() => { seen = []; });

after(async () => {
  try { socket.disconnect(); } catch (_) {}
  if (mt) mt.close();
  if (srv) await srv.stop();
});

// Wait for a broadcast that matches pred. Only scans broadcasts pushed AFTER
// `after` arg (default: test start) so stale matches can't leak in.
async function waitForBroadcast(pred, timeout = 4000, label = "condition") {
  const deadline = Date.now() + timeout;
  const seenAfter = seen; // capture the live array
  while (Date.now() < deadline) {
    const hit = seenAfter.find(pred);
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error(`timed out waiting for broadcast: ${label}`);
}

test("/api/state: returns tempo authority + CORS (cross-origin allowed)", async () => {
  const res = await fetch(`${srv.baseUrl}/api/state`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const st = await res.json();
  assert.ok(st.tempo, "tempo block present");
  assert.equal(st.tempo.source, "reaper");
  assert.deepEqual(st.timeSig, [4, 4]);
});

test("POST /api/tempo: external clock (link/force) writes the one shared tempo", async () => {
  const res = await fetch(`${srv.baseUrl}/api/tempo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bpm: 132.5, source: "link" })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.tempo.source, "link");
  assert.equal(body.tempo.bpm, 132.5);

  const st = await waitForBroadcast(
    (s) => s.tempo && s.tempo.source === "link" && s.tempo.bpm === 132.5,
    3000, "link tempo broadcast");
  assert.equal(st.tempo.downbeatAt, 0);

  // restore
  await fetch(`${srv.baseUrl}/api/tempo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bpm: 120, source: "reaper" })
  });
});

test("WS action set_tempo routes an external clock", async () => {
  socket.emit("action", { type: "set_tempo", value: { bpm: 144, source: "link" } });
  const st = await waitForBroadcast(
    (s) => s.tempo && s.tempo.source === "link" && s.tempo.bpm === 144,
    3000, "set_tempo broadcast");
  assert.equal(st.tempo.bpm, 144);
});

test("bridge (mock REAPER): live bpm + time_sig are ingested into shared state", async () => {
  mt.set({ playing: true, position: 5.0, bpm: 128, time_sig: [3, 4], songId: "three_quarter" });
  const st = await waitForBroadcast(
    (s) => s.timeSig && s.timeSig[0] === 3 && s.playing === true && s.songId === "three_quarter",
    4000, "bridge ingest");
  assert.equal(st.bpm, 128);
  assert.equal(st.tempo.source, "reaper");
});

test("tap_tempo: 4-tap run locks Beat-1 (Force-style) at the first tap", async () => {
  seen = [];
  const firstTap = Date.now();
  for (let i = 0; i < 4; i++) {
    socket.emit("action", { type: "tap_tempo" });
    await sleep(400);
  }

  const st = await waitForBroadcast(
    (s) => s.tempo && s.tempo.source === "tap" && s.tempo.downbeatAt > 0,
    3000, "tap downbeat lock");
  assert.equal(st.tempo.source, "tap");
  assert.ok(st.tempo.bpm > 90 && st.tempo.bpm < 220, `bpm sane (~150): got ${st.tempo.bpm}`);
  assert.equal(st.tempo.downbeatRev, 1, "first completed run re-anchors → rev 1");
  assert.ok(Math.abs(st.tempo.downbeatAt - firstTap) < 300,
    `downbeat ~ first tap (off by ${st.tempo.downbeatAt - firstTap}ms)`);
});

test("tap_tempo: more taps in the same run refine BPM but never re-anchor", async () => {
  await sleep(50);
  socket.emit("action", { type: "tap_tempo" });
  await sleep(400);
  socket.emit("action", { type: "tap_tempo" });
  const st = await waitForBroadcast(
    (s) => s.tempo && s.tempo.source === "tap" && s.tempo.downbeatRev === 1,
    3000, "refined tap");
  assert.equal(st.tempo.downbeatRev, 1, "refinement must not bump the down-beat revision");
});

test("tap_tempo: long pause starts a fresh run → re-anchors (rev 2)", async () => {
  await sleep(1700); // exceed the 1500ms run separator
  for (let i = 0; i < 4; i++) {
    socket.emit("action", { type: "tap_tempo" });
    await sleep(400);
  }
  const st = await waitForBroadcast(
    (s) => s.tempo && s.tempo.source === "tap" && s.tempo.downbeatRev === 2,
    4000, "rev 2");
  assert.ok(st.tempo.downbeatRev >= 2, "fresh run re-anchored");
});

test("song change via bridge: tempo falls back to REAPER grid, tap anchor cleared", async () => {
  mt.set({ songId: "new_song", currentSong: "New Song", bpm: 110, position: 20, playing: true });
  const st = await waitForBroadcast(
    (s) => s.songId === "new_song" && s.tempo && s.tempo.source === "reaper" && s.tempo.downbeatAt === 0,
    4000, "song-change fallback");
  assert.equal(st.tempo.source, "reaper");
  assert.equal(st.tempo.downbeatAt, 0);
});

test("bridge play/stop edges propagate through state broadcasts", async () => {
  mt.set({ playing: false, position: 0, songId: "new_song" });
  await waitForBroadcast((s) => s.playing === false && s.songId === "new_song", 3000, "stopped");
  mt.set({ playing: true, position: 10 });
  const st = await waitForBroadcast((s) => s.playing === true && s.position >= 10, 3000, "playing");
  assert.equal(st.playing, true);
});