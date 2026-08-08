"use strict";
// MANUAL live-rig check — NOT part of `npm test`.
// Requires the REAL singer server (:3300) and LSM bridge (:3000). Writes a
// synthetic bridge_state.json to the LIVE data path (fake REAPER), so only
// run when REAPER's Lua bridge is NOT writing. Removes the file on exit.
//   node tests/live-check.js
const puppeteer = require("puppeteer");
const fs = require("fs");

const BRIDGE = process.env.HOME + "/Library/Application Support/REAPER/Scripts/Live Show Manager/data/bridge_state.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

function writeBridge(o) {
  fs.writeFileSync(BRIDGE, JSON.stringify({ ...o, connected: true }, null, 2));
}
function startLiveTransport() {
  // Emulate bridge.lua's playing throttle: advance position at 120 BPM ~30ms.
  return setInterval(() => {
    livePos += (0.03 * 120) / 60;
    fs.writeFileSync(BRIDGE, JSON.stringify({
      connected: true, playing: true, position: livePos, bpm: 120,
      time_sig: [4, 4], songId: "live_test", duration: 180, showName: "Live", regions: []
    }, null, 2));
  }, 30);
}

let livePos = 0;

(async () => {
  // Clean slate: idle first so the teleprompter's init poll anchors to playing=false.
  writeBridge({ playing: false, position: 0, bpm: 120, time_sig: [4, 4], songId: "live_test",
    currentArtist: "", duration: 180, showName: "Live", regions: [] });

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));

  // Singer server serves the teleprompter; transport default = hostname:3000
  await page.goto("http://127.0.0.1:3300/teleprompter.html", { waitUntil: "domcontentloaded" });
  await sleep(3000);

  // Hit play: position advances like REAPER playback at 120 BPM.
  const transport = startLiveTransport();

  const seen = [];
  const deadline = Date.now() + 6000;
  let appeared = false;
  while (Date.now() < deadline) {
    const r = await page.evaluate(() => {
      const ov = document.getElementById("countOverlay");
      return { d: ov ? getComputedStyle(ov).display : null, n: document.getElementById("countNum")?.textContent };
    });
    if (r.d === "flex") { appeared = true; if (r.n) seen.push(r.n); }
    await sleep(80);
  }

  const real = errors.filter((e) => !/queue|config|songs|404|ERR|Failed/i.test(e));
  // Report the true display progression (dedupe consecutive repeated samples).
  const seq = [];
  for (const n of seen) if (seq[seq.length - 1] !== n) seq.push(n);
  console.log("count-in appeared:", appeared);
  console.log("progression:", JSON.stringify(seq));
  console.log("result:", (appeared && seq.includes("4") && seq.includes("1") && seq.indexOf("4") < seq.indexOf("1")) ? "PASS" : "FAIL");
  if (real.length) console.log("page errors:", real.join(" | "));

  await browser.close();
  if (transport) clearInterval(transport);
  fs.rmSync(BRIDGE, { force: true });
  console.log("cleanup: synthetic bridge file removed");
  process.exit(appeared && seen.includes("4") && seen.includes("1") ? 0 : 1);
})().catch((e) => {
  console.error("SCRIPT ERROR:", e.message);
  try { fs.rmSync(BRIDGE, { force: true }); } catch (_) {}
  process.exit(1);
});