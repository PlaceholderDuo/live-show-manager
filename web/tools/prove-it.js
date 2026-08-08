"use strict";
// ═══════════════════════════════════════════════════════════
// prove-it.js — Everything is broken until proven otherwise.
// Tests every system end-to-end. No assumptions allowed.
// ═══════════════════════════════════════════════════════════
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3000";
const SINGER = "http://127.0.0.1:3300";

let pass = 0;
let fail = 0;
const failures = [];

function PROVE(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`); failures.push(`✗ ${label}`); }
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts || {});
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { return { _raw: text, _status: res.status }; }
}

function httpPost(url, body) {
  return fetchJSON(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
}

async function main() {
  console.log("══════════════════════════════════════");
  console.log("  PROVE IT — Live System Verification");
  console.log("  Everything is broken until proven.");
  console.log("══════════════════════════════════════\n");

  // ═══════ 1. SERVERS ARE REACHABLE ═══════
  console.log("── 1. Servers reachable ──");
  try {
    const br = await fetchJSON(`${BASE}/api/state`);
    PROVE(br && typeof br === "object" && !br._status, ":3000 bridge responds with JSON");
    PROVE(br.connected !== undefined, "Bridge /api/state has 'connected' field");
    PROVE(br.armed !== undefined, "Bridge /api/state has 'armed' field");
    PROVE(br.playing !== undefined, "Bridge /api/state has 'playing' field");
  } catch (e) { PROVE(false, `:3000 bridge reachable (${e.message})`); }

  try {
    const sq = await fetchJSON(`${SINGER}/api/queue/current`);
    PROVE(sq && typeof sq === "object", ":3300 singer responds with JSON");
    PROVE(sq.status !== undefined, "Singer queue has 'status' field");
    PROVE(sq.current_song !== undefined, "Singer queue has 'current_song'");
  } catch (e) { PROVE(false, `:3300 singer reachable (${e.message})`); }

  try {
    const bh = await fetchJSON(`${SINGER}/api/health`);
    PROVE(bh && bh.status === "ok", "Singer /api/health returns ok");
  } catch (e) { PROVE(false, `:3300 health (${e.message})`); }

  // ═══════ 2. SETLIST PRESENT ═══════
  console.log("\n── 2. Setlist loaded ──");
  const s2 = await fetchJSON(`${BASE}/api/state`);
  PROVE(Array.isArray(s2.setlist), "Bridge has setlist array");
  PROVE(s2.setlist.length >= 3, `Setlist has ≥3 songs (got ${s2.setlist ? s2.setlist.length : 0})`);
  if (s2.setlist && s2.setlist.length > 0) {
    const s0 = s2.setlist[0];
    PROVE(typeof s0.title === "string" && s0.title.length > 0, `First song has title: "${s0.title}"`);
    PROVE(typeof s0.bpm === "number" && s0.bpm > 0, `First song has BPM > 0: ${s0.bpm}`);
    // Verify ALL songs have BPM
    let allHaveBpm = true;
    for (const s of s2.setlist) {
      if (typeof s.bpm !== "number" || s.bpm <= 0) { allHaveBpm = false; }
    }
    PROVE(allHaveBpm, "All setlist songs have BPM > 0");
  }

  // ═══════ 3. SETLIST SURVIVES RESTART ═══════
  console.log("\n── 3. Setlist persistence ──");
  // Read _last_session.json directly
  const sessionPath = path.join(
    os.homedir(), "Library", "Application Support", "REAPER", "Scripts",
    "Live Show Manager", "data", "setlists", "_last_session.json"
  );
  try {
    const raw = fs.readFileSync(sessionPath, "utf-8");
    const saved = JSON.parse(raw);
    PROVE(Array.isArray(saved.songs) && saved.songs.length > 0, `_last_session.json has ${saved.songs ? saved.songs.length : 0} songs`);
  } catch (e) { PROVE(false, `_last_session.json readable (${e.message})`); }

  // ═══════ 4. ARM SETS STATE ═══════
  console.log("\n── 4. ARM state transition ──");
  let res = await httpPost(`${BASE}/api/control/arm`, { armed: true });
  PROVE(res.ok === true, "POST /api/control/arm returns ok");
  PROVE(res.armed === true, "ARM response says armed=true");

  let st = await fetchJSON(`${BASE}/api/state`);
  PROVE(st.armed === true, "State reflects armed=true after ARM");
  PROVE(st.playing === false, "State reflects playing=false after ARM (not auto-played)");
  PROVE(st.position !== undefined, "Position field exists in state");

  // ═══════ 5. SINGER SYNC ON ARM ═══════
  console.log("\n── 5. Singer queue sync on ARM ──");
  const singerBq = await fetchJSON(`${SINGER}/api/band-queue`);
  PROVE(Array.isArray(singerBq.band_queue), "Singer band_queue is an array");
  PROVE(singerBq.band_queue.length >= 3, `Singer band_queue has ≥3 songs after ARM sync (got ${singerBq.band_queue.length})`);
  if (singerBq.band_queue && st.setlist) {
    const singerTitles = singerBq.band_queue.map(s => s.title).sort().join(",");
    const bridgeTitles = st.setlist.filter(s => s.title).map(s => s.title).sort().join(",");
    PROVE(singerTitles === bridgeTitles, "Singer band_queue matches bridge setlist exactly");
  }

  // ═══════ 6. PLAY STARTS CLOCK ═══════
  console.log("\n── 6. PLAY starts position tracking ──");
  res = await httpPost(`${BASE}/api/control/play`);
  PROVE(res.ok === true, "PLAY returns ok");
  PROVE(!res.ignored, "PLAY is not ignored (armed, not already playing)");

  await SLEEP(500);
  st = await fetchJSON(`${BASE}/api/state`);
  PROVE(st.playing === true, `Playing=true after PLAY (actual: ${st.playing})`);
  PROVE(st.position > 0, `Position > 0 after PLAY (actual: ${st.position.toFixed(2)}s)`);

  // ═══════ 7. POSITION ADVANCES OVER TIME ═══════
  console.log("\n── 7. Clock accuracy ──");
  const p1 = st.position;
  await SLEEP(2000);
  st = await fetchJSON(`${BASE}/api/state`);
  const p2 = st.position;
  const delta = p2 - p1;
  PROVE(delta >= 1.5 && delta <= 2.5, `Position advanced ~2s in 2s wall-clock (delta=${delta.toFixed(2)}s)`);
  PROVE(st.playing === true, "Still playing after 2s");

  // Take multiple samples to verify monotonic advance
  await SLEEP(1000);
  st = await fetchJSON(`${BASE}/api/state`);
  const p3 = st.position;
  PROVE(p3 > p2, `Position monotonic (p2=${p2.toFixed(1)} → p3=${p3.toFixed(1)})`);

  // ═══════ 8. BPM SET CORRECTLY ═══════
  console.log("\n── 8. BPM per song ──");
  st = await fetchJSON(`${BASE}/api/state`);
  PROVE(typeof st.bpm === "number" && st.bpm > 0 && st.bpm < 400, `BPM is valid: ${st.bpm}`);
  PROVE(st.bpm !== 120, `BPM is NOT default 120 (actual: ${st.bpm})`);

  // ═══════ 9. STOP FREEZES POSITION ═══════
  console.log("\n── 9. STOP behavior ──");
  const beforeStop = st.position;
  res = await httpPost(`${BASE}/api/control/stop`);
  PROVE(res.ok === true, "STOP returns ok");
  PROVE(res.playing === false, "STOP response says playing=false");

  await SLEEP(800);
  st = await fetchJSON(`${BASE}/api/state`);
  PROVE(st.playing === false, "Playing=false after STOP");
  PROVE(st.position <= 0.2, `Position reset near 0 after STOP (actual: ${st.position.toFixed(2)}s)`);

  // ═══════ 10. NEXT/PREV NAVIGATION ═══════
  console.log("\n── 10. Next/Prev navigation ──");
  let r1 = await httpPost(`${BASE}/api/control/next`);
  PROVE(r1.ok === true, "Next returns ok");
  st = await fetchJSON(`${BASE}/api/state`);
  PROVE(st.songIndex === 2, `songIndex=2 after next (actual: ${st.songIndex})`);
  if (st.setlist && st.setlist.length >= 2) {
    PROVE(st.currentSong === st.setlist[1].title, `currentSong matches setlist[1]: "${st.currentSong}"`);
  }

  let r2 = await httpPost(`${BASE}/api/control/prev`);
  PROVE(r2.ok === true, "Prev returns ok");
  st = await fetchJSON(`${BASE}/api/state`);
  PROVE(st.songIndex === 1, `songIndex=1 after prev (actual: ${st.songIndex})`);

  // ═══════ 11. BPM CHANGES PER SONG ═══════
  console.log("\n── 11. BPM changes per song ──");
  await httpPost(`${BASE}/api/control/next`); // song 2
  st = await fetchJSON(`${BASE}/api/state`);
  const bpm2 = st.bpm;
  PROVE(st.songIndex === 2, "On song 2");
  await httpPost(`${BASE}/api/control/next`); // song 3
  st = await fetchJSON(`${BASE}/api/state`);
  const bpm3 = st.bpm;
  PROVE(bpm2 !== bpm3, `BPM changes between songs (song2=${bpm2}, song3=${bpm3})`);
  await httpPost(`${BASE}/api/control/prev`); await httpPost(`${BASE}/api/control/prev`); // back to 1

  // ═══════ 12. PLAY GATING ═══════
  console.log("\n── 12. PLAY gating ──");
  // Disarm
  await httpPost(`${BASE}/api/control/arm`, { armed: false });
  res = await httpPost(`${BASE}/api/control/play`);
  PROVE(res.ignored === true, "PLAY ignored when disarmed");
  PROVE(res.reason === "not armed", `Reason is 'not armed' (actual: "${res.reason}")`);

  // Re-arm + play, then try double-play
  await httpPost(`${BASE}/api/control/arm`, { armed: true });
  await httpPost(`${BASE}/api/control/play`);
  await SLEEP(300);
  res = await httpPost(`${BASE}/api/control/play`);
  PROVE(res.ignored === true, "Second PLAY ignored while already playing");
  await httpPost(`${BASE}/api/control/stop`);

  // ═══════ 13. LYRIC TIMING PRESENT ═══════
  console.log("\n── 13. Lyric timing data ──");
  await httpPost(`${BASE}/api/control/next`); // song 2
  st = await fetchJSON(`${BASE}/api/state`);
  PROVE(Array.isArray(st.lyricLines), "lyricLines is an array");
  PROVE(st.lyricLines.length > 0, `${st.lyricLines.length} lyric lines loaded`);
  if (st.lyricLines && st.lyricLines.length > 0) {
    const timed = st.lyricLines.filter(l => l.time !== null && l.time !== undefined);
    PROVE(timed.length > 0, `${timed.length}/${st.lyricLines.length} lines have @time annotations`);
    // Verify times are monotonic
    let mono = true;
    let lastT = -1;
    for (const l of timed) {
      if (l.time < lastT) { mono = false; break; }
      lastT = l.time;
    }
    PROVE(mono, "Lyric @time values are monotonic (non-decreasing)");
    // Verify first line time
    PROVE(timed[0].time !== null, `First timed line has time=${timed[0].time}`);
  }

  // ═══════ 14. SONG DURATION ═══════
  console.log("\n── 14. Song duration ──");
  PROVE(st.duration > 30 && st.duration < 600, `Duration is plausible: ${st.duration}s (not 0 or inf)`);

  // ═══════ 15. SYNC HEALTH ═══════
  console.log("\n── 15. Lyric sync health ──");
  const health = await fetchJSON(`${BASE}/api/sync-health`);
  PROVE(health.currentSong && health.currentSong.length > 0, "sync-health returns current song");
  if (health.lyricSync) {
    PROVE(health.lyricSync.totalLines > 0, `${health.lyricSync.totalLines} total lines`);
    PROVE(health.lyricSync.annotatedPct >= 0, `annotatedPct=${health.lyricSync.annotatedPct}%`);
  }

  // ═══════ 16. SECTIONS PRESENT ═══════
  console.log("\n── 16. Song sections ──");
  PROVE(Array.isArray(st.sections), "sections is an array");
  PROVE(st.sections.length > 0, `${st.sections.length} sections computed`);

  // ═══════ 17. STRESS: RAPID OPERATIONS ═══════
  console.log("\n── 17. Stress test ──");
  const ops = [
    ["arm", { armed: true }], ["play", {}], ["stop", {}],
    ["play", {}], ["stop", {}],
    ["arm", { armed: true }], ["play", {}],
    ["stop", {}], ["play", {}], ["stop", {}]
  ];
  let stressOk = true;
  for (const [cmd, body] of ops) {
    try {
      const r = await httpPost(`${BASE}/api/control/${cmd}`, body);
      if (!r.ok) { stressOk = false; break; }
    } catch (e) { stressOk = false; break; }
    await SLEEP(30);
  }
  PROVE(stressOk, "10 rapid ARM/PLAY/STOP operations all return ok");
  st = await fetchJSON(`${BASE}/api/state`);
  PROVE(st.playing === false, "State is stopped after stress sequence");
  PROVE(st.armed !== undefined, "Armed field still present after stress");

  // ═══════ 18. NULL CURRENTSONG PROPAGATION (simulated) ═══════
  console.log("\n── 18. Null coalescing ──");
  // Can't directly set bridge state, but we can verify API endpoint behavior
  const snap = await fetchJSON(`${BASE}/api/debug/snapshot`);
  PROVE(snap.bridge !== undefined, "Debug snapshot has bridge data");
  PROVE(snap.singer !== undefined, "Debug snapshot has singer data");
  PROVE(snap.checks !== undefined, "Debug snapshot has checks");

  // ═══════ 19. TUI STATE POSTING ═══════
  console.log("\n── 19. TUI debug state ──");
  PROVE(snap.tui !== undefined, "Debug snapshot has TUI data");
  const tuiAge = snap.tui.ageMs;
  if (tuiAge !== null && tuiAge !== undefined) {
    PROVE(tuiAge < 15000, `TUI state is fresh (<15s, actual: ${Math.round(tuiAge/1000)}s)`);
  }
  PROVE(snap.tui.focus !== undefined, "TUI reports focus state");
  PROVE(snap.tui.queueView !== undefined, "TUI reports queueView state");
  PROVE(snap.tui.showMode !== undefined, "TUI reports showMode state");
  if (snap.tui.reaperState) {
    PROVE(snap.tui.reaperState.bpm !== undefined || snap.tui.reaperState.connected !== undefined, "TUI reports reaperState");
  }

  // ═══════ 20. DEBUG.HTML SERVES ═══════
  console.log("\n── 20. debug.html serves ──");
  try {
    const dh = await fetch(`${BASE}/debug.html`);
    PROVE(dh.status === 200, `debug.html returns 200 (got ${dh.status})`);
    const html = await dh.text();
    PROVE(html.includes("BRIDGE") || html.includes("SINGER") || html.includes("TUI"), "debug.html contains panel labels");
    PROVE(html.includes("fetch"), "debug.html contains JavaScript");
  } catch (e) { PROVE(false, `debug.html serves (${e.message})`); }

  // ═══════ 21. HUD HTML SERVES ═══════
  console.log("\n── 21. HUD serves ──");
  try {
    const hud = await fetch(`${BASE}/hud.html`);
    PROVE(hud.status === 200, `hud.html returns 200 (got ${hud.status})`);
    const html = await hud.text();
    PROVE(html.includes("hud.js") || html.includes("HUD") || html.includes("teleprompter"), "hud.html includes HUD references");
  } catch (e) { PROVE(false, `hud.html serves (${e.message})`); }

  // ═══════ 22. CHORD PRO ENDPOINT ═══════
  console.log("\n── 22. ChordPro endpoint ──");
  try {
    const cp = await fetch(`${BASE}/api/chordpro/don_t_let_me_down`);
    PROVE(cp.status === 200 || cp.status === 404, `ChordPro endpoint responds (${cp.status})`);
  } catch (e) { PROVE(false, `ChordPro endpoint (${e.message})`); }

  // ═══════ 23. PREFLIGHT CHECK ═══════
  console.log("\n── 23. Preflight check ──");
  const pf = await fetchJSON(`${BASE}/api/preflight`);
  PROVE(pf.server !== undefined, "Preflight has server status");
  PROVE(pf.reaper !== undefined, "Preflight has reaper status");

  // ═══════ 24. NOW TEST SHOW-READY SCRIPT ═══════
  console.log("\n── 24. test-show-ready.js runs ──");
  try {
    const result = spawn(process.execPath, [
      path.join(__dirname, "test-show-ready.js")
    ], { stdio: "pipe", cwd: __dirname });
    let out = "";
    result.stdout.on("data", d => out += d);
    result.stderr.on("data", d => out += d);
    await new Promise((resolve, reject) => {
      result.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(`exit code ${code}`));
      });
      setTimeout(() => reject(new Error("timeout")), 45000);
    });
    PROVE(true, "test-show-ready.js exits 0 (PASS)");
  } catch (e) { PROVE(false, `test-show-ready.js (${e.message})`); }

  // ═══════ 25. FINAL STATE CONSISTENCY ═══════
  console.log("\n── 25. Final state consistency ──");
  const fSnap = await fetchJSON(`${BASE}/api/debug/snapshot`);
  const checks = fSnap.checks || [];
  const errors = checks.filter(c => c.level === "ERROR");
  PROVE(errors.length === 0, `No cross-system ERRORS (${errors.length} errors, ${checks.length} total checks)`);
  for (const c of errors) {
    console.error(`    ERROR: ${c.msg}`);
  }

  // ═══════ CLEANUP ═══════
  await httpPost(`${BASE}/api/control/stop`);
  await httpPost(`${BASE}/api/control/arm`, { armed: false });

  // ═══════ SUMMARY ═══════
  console.log("\n══════════════════════════════════════");
  console.log(`  VERIFIED: ${pass}/${pass+fail} working`);
  if (fail > 0) {
    console.log(`  FAILURES:`);
    for (const f of failures) console.log(`    ${f}`);
  }
  console.log(`  VERDICT: ${fail === 0 ? "SHOW READY" : "NOT READY"}`);
  console.log("══════════════════════════════════════");

  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
