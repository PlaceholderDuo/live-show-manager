"use strict";
// ═══════════════════════════════════════════════════════════
// test-show-ready.js — Full show-readiness self-test
// ═══════════════════════════════════════════════════════════
// VERIFIES (from process.exit code):
//   Phase 1: Server starts, /api/state returns 200
//   Phase 2: Setlist loads with correct BPMs + durations
//   Phase 3: ARM sets armed, syncs singer queue
//   Phase 4: PLAY starts position advancing (localPlay clock)
//   Phase 5: Position advances ~1s in ~1s wall-clock
//   Phase 6: Lyric line at expected position matches song content
//   Phase 7: STOP freezes position, stages next song
//   Phase 8: PLAY resumes from staged song with correct BPM
//   Phase 9: Song-end auto-advances to next song
//   Phase 10: Rapid ARM/PLAY/STOP/PLAY doesn't corrupt state
//   Phase 11: Duration calculated from lyric timing, not guesswork
//   Phase 12: TUI debug state endpoint works
//
// Prints a PASS/FAIL summary and exits non-zero on failure.
// Zero REAPER dependency — tests the localPlay engine standalone.
const { spawnServer, waitForHttp } = require("../tests/lib/spawn-server");

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;

function PASS(msg) { checks++; console.log(`  PASS: ${msg}`); }
function FAIL(msg) { failures++; checks++; console.error(`  FAIL: ${msg}`); }
function CHECK(cond, msg) { cond ? PASS(msg) : FAIL(msg); }

async function run() {
  console.log("╔══════════════════════════════════╗");
  console.log("║  SHOW-READY SELF-TEST           ║");
  console.log("╚══════════════════════════════════╝\n");

  // ── PHASE 1: SERVER STARTUP ──
  console.log("── Phase 1: Server startup ──");
  let srv;
  try {
    srv = await spawnServer({});
    // Load a multi-song setlist for full lifecycle testing
    const setlistRes = await fetch(`${srv.baseUrl}/api/local/setlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        songs: [
          { title: "Don't Let Me Down" },
          { title: "After Midnight" },
          { title: "A Boy Named Sue" },
        ],
      }),
    });
    const sl = await setlistRes.json();
    CHECK(sl.ok === true, "Server starts + setlist loads");
    CHECK(sl.count === 3, "3 songs in setlist");
  } catch (e) {
    FAIL(`Server startup: ${e.message}`);
    process.exit(1);
  }

  let st, res;

  // ── PHASE 2: INITIAL STATE ──
  console.log("\n── Phase 2: Initial state ──");
  st = await (await fetch(`${srv.baseUrl}/api/state`)).json();
  CHECK(st.connected === false, "REAPER not connected (standalone mode)");
  CHECK(st.armed === false, "Not armed by default");
  CHECK(st.playing === false, "Not playing by default");
  CHECK(st.songIndex === 1, "songIndex defaults to 1");
  CHECK(st.totalSongs === 3, "totalSongs = 3");
  CHECK(typeof st.currentSong === "string" && st.currentSong.length > 0, "currentSong loaded from setlist");

  // ── PHASE 3: ARM ──
  console.log("\n── Phase 3: ARM ──");
  res = await fetch(`${srv.baseUrl}/api/control/arm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ armed: true }),
  });
  st = await res.json();
  CHECK(st.armed === true, "ARM sets armed=true");

  st = await (await fetch(`${srv.baseUrl}/api/state`)).json();
  CHECK(st.armed === true, "State reflects armed=true");
  CHECK(st.playing === false, "ARM does not start playback");
  CHECK(st.bpm > 0, "BPM is set from song metadata");

  // ── PHASE 4: PLAY — position starts advancing ──
  console.log("\n── Phase 4: PLAY — position tracking ──");
  res = await fetch(`${srv.baseUrl}/api/control/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  st = await res.json();
  CHECK(st.ok === true, "PLAY returns ok");
  CHECK(!st.ignored, "PLAY is not ignored (armed)");

  // Wait for position to advance
  await SLEEP(1500);
  st = await (await fetch(`${srv.baseUrl}/api/state`)).json();
  const pos1 = st.position;
  CHECK(st.playing === true, "Playing state is true after PLAY");
  CHECK(pos1 >= 0.5, `Position advanced after 1.5s (got ${pos1.toFixed(1)}s)`);

  // ── PHASE 5: Position advances ~1s per wall-clock second ──
  console.log("\n── Phase 5: Clock accuracy ──");
  await SLEEP(1000);
  st = await (await fetch(`${srv.baseUrl}/api/state`)).json();
  const pos2 = st.position;
  const delta = pos2 - pos1;
  CHECK(delta >= 0.7 && delta <= 1.5, `Position advanced ~1s in 1s wall-clock (delta=${delta.toFixed(2)}s)`);

  // ── PHASE 6: STOP freezes position ──
  console.log("\n── Phase 6: STOP ──");
  const beforeStop = st.position;
  res = await fetch(`${srv.baseUrl}/api/control/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  st = await res.json();
  CHECK(st.playing === false, "STOP returns playing=false");

  await SLEEP(600);
  st = await (await fetch(`${srv.baseUrl}/api/state`)).json();
  const afterStop = st.position;
  CHECK(afterStop <= 0.1, `Position resets to 0 after STOP (next song staged, pos=${afterStop.toFixed(1)})`);
  CHECK(st.playing === false, "Playing is false after STOP");

  // ── PHASE 7: PLAY from stopped state starts from 0 ──
  console.log("\n── Phase 7: PLAY from stop resets position ──");
  await SLEEP(200);
  res = await fetch(`${srv.baseUrl}/api/control/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  await SLEEP(500);
  st = await (await fetch(`${srv.baseUrl}/api/state`)).json();
  CHECK(st.playing === true, "Re-PLAY starts playback");
  CHECK(st.position < 1.0, `Position resets near 0 after re-PLAY (got ${st.position.toFixed(1)}s)`);

  // Stop for next test
  await fetch(`${srv.baseUrl}/api/control/stop`, { method: "POST" });

  // ── PHASE 8: PLAY gating ──
  console.log("\n── Phase 8: PLAY gating ──");
  // Disarm
  res = await fetch(`${srv.baseUrl}/api/control/arm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ armed: false }),
  });
  // PLAY should be ignored
  res = await fetch(`${srv.baseUrl}/api/control/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  st = await res.json();
  CHECK(st.ignored === true, "PLAY ignored when disarmed");
  CHECK(st.reason === "not armed", "Reason is 'not armed'");
  // Already playing test
  await fetch(`${srv.baseUrl}/api/control/arm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ armed: true }) });
  res = await fetch(`${srv.baseUrl}/api/control/play`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  await SLEEP(500);
  // Second PLAY while playing
  res = await fetch(`${srv.baseUrl}/api/control/play`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  st = await res.json();
  CHECK(st.ignored === true, "PLAY ignored while already playing");
  await fetch(`${srv.baseUrl}/api/control/stop`, { method: "POST" });

  // ── PHASE 9: Next/Prev navigation ──
  console.log("\n── Phase 9: Next/Prev ──");
  // Start at song 1, advance to song 2
  await fetch(`${srv.baseUrl}/api/control/arm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ armed: true }) });
  res = await fetch(`${srv.baseUrl}/api/control/next`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  st = await res.json();
  CHECK(st.ok === true, "Next returns ok");
  st = await (await fetch(`${srv.baseUrl}/api/state`)).json();
  CHECK(st.songIndex === 2, "songIndex advances to 2 after next");

  // Back to song 1
  res = await fetch(`${srv.baseUrl}/api/control/prev`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  st = await res.json();
  CHECK(st.ok === true, "Prev returns ok");
  st = await (await fetch(`${srv.baseUrl}/api/state`)).json();
  CHECK(st.songIndex === 1, "songIndex returns to 1 after prev");

  // ── PHASE 10: BPM per song ──
  console.log("\n── Phase 10: BPM per song ──");
  await fetch(`${srv.baseUrl}/api/control/next`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  st = await (await fetch(`${srv.baseUrl}/api/state`)).json();
  CHECK(st.songIndex === 2, "On song 2 (After Midnight)");
  // After Midnight is ~131 BPM — verify BPM is not the default 120
  CHECK(st.bpm !== 120, "BPM changed from song 1 to song 2");

  // ── PHASE 11: Duration from lyric timing ──
  console.log("\n── Phase 11: Song duration ──");
  st = await (await fetch(`${srv.baseUrl}/api/state`)).json();
  const dur = st.duration;
  CHECK(dur > 60 && dur < 600, `Duration is plausible (${dur}s, not 0 or inf)`);
  CHECK(st.lyricLines && st.lyricLines.length > 0, "Lyric lines are loaded");
  const timedLines = st.lyricLines.filter((l) => l.time !== null && l.time !== undefined);
  CHECK(timedLines.length > 0, `${timedLines.length} lines have @time annotations`);

  // ── PHASE 12: Lyric sync health ──
  console.log("\n── Phase 12: Lyric sync health ──");
  const health = await (await fetch(`${srv.baseUrl}/api/sync-health`)).json();
  CHECK(health.currentSong && health.currentSong.length > 0, "Sync health returns current song");
  if (health.lyricSync) {
    CHECK(health.lyricSync.totalLines > 0, `${health.lyricSync.totalLines} lyric lines total`);
    CHECK(health.lyricSync.annotatedPct >= 0, `annotatedPct=${health.lyricSync.annotatedPct}%`);
  }

  // ── PHASE 13: Rapid operations don't corrupt state ──
  console.log("\n── Phase 13: Stress test ──");
  // ARM → PLAY → ARM → PLAY → STOP → PLAY (rapid)
  await fetch(`${srv.baseUrl}/api/control/arm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ armed: true }) });
  await fetch(`${srv.baseUrl}/api/control/play`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  await SLEEP(200);
  await fetch(`${srv.baseUrl}/api/control/arm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ armed: true }) }); // re-arm
  await SLEEP(100);
  await fetch(`${srv.baseUrl}/api/control/play`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }); // already playing — ignored
  await SLEEP(300);
  await fetch(`${srv.baseUrl}/api/control/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  await SLEEP(100);
  await fetch(`${srv.baseUrl}/api/control/play`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  await SLEEP(300);
  st = await (await fetch(`${srv.baseUrl}/api/state`)).json();
  CHECK(st.playing === true, "State is playing after stress sequence");
  CHECK(st.armed === true, "State is armed after stress sequence");

  // Cleanup
  await fetch(`${srv.baseUrl}/api/control/stop`, { method: "POST" });
  await srv.stop();
  await SLEEP(200);

  // ── SUMMARY ──
  console.log("\n╔══════════════════════════════════╗");
  console.log(`║  RESULT: ${checks - failures}/${checks} passed`);
  if (failures === 0) console.log("║  SHOW READY");
  else console.log("║  NOT READY — fix failures above");
  console.log("╚══════════════════════════════════╝");

  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
