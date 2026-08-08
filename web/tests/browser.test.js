"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const puppeteer = require("puppeteer");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { io } = require("socket.io-client");
const { spawnServer } = require("./lib/spawn-server");
const MockTransport = require("./lib/mock-transport");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
let srv;      // mock LSM bridge server
let mt;       // mock REAPER transport
let tpServer; // tiny static server for the teleprompter page + its relative API
let pageErrors = [];

const TELEPROMPTER = "/Users/rdfx1/Music/iPhoneLiveServer/server/public/teleprompter.html";

function startTeleprompterServer() {
  const teleprompterHtml = fs.readFileSync(TELEPROMPTER, "utf-8");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (url.pathname === "/teleprompter.html") {
      res.setHeader("Content-Type", "text/html");
      return res.end(teleprompterHtml);
    }
    if (url.pathname === "/api/queue/current") {
      return res.end(JSON.stringify({
        status: "loaded",
        current_song: { slug: "sunset", title: "Sunset", bpm: 120, key: "G", artist: "Test Band" }
      }));
    }
    if (url.pathname === "/api/config/teleprompter") {
      return res.end(JSON.stringify({ count_in_display: "enabled" }));
    }
    if (url.pathname.startsWith("/api/songs/")) {
      return res.end(JSON.stringify({ meta: { bpm: 120, time_sig: [4, 4], lyrics: [{ time: 0, text: "one" }] } }));
    }
    if (url.pathname === "/api/queue/upcoming") {
      return res.end(JSON.stringify({ upcoming: [] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

before(async () => {
  srv = await spawnServer({});
  mt = MockTransport.create(srv.bridgePath);
  tpServer = await startTeleprompterServer();
  browser = await puppeteer.launch({ headless: true, args: ["--window-size=1024,768"] });
});

after(async () => {
  if (browser) await browser.close();
  if (tpServer) tpServer.close();
  if (mt) mt.close();
  if (srv) await srv.stop();
});

test("HUD conductor: WS state from mock REAPER drives the live bar/beat counter", async () => {
  const page = await browser.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.stack || String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });
  await page.goto(`${srv.baseUrl}/hud.html`, { waitUntil: "networkidle0" });
  await sleep(500);

  // Start "playing" and advance position ~2.5s → 5 beats → BAR should cross to 2.
  mt.set({ playing: true, position: 0, bpm: 120, songId: "sunset", currentSong: "Sunset" });
  mt.walk(2.5, 120);

  const barsSeen = new Set();
  const deadline = Date.now() + 5000;
  let lastBar = null;
  while (Date.now() < deadline) {
    const text = await page.$eval("#barCounter", (el) => el.textContent);
    barsSeen.add(text);
    lastBar = text;
    await sleep(120);
  }
  assert.match(lastBar || "", /^BAR:\s*\d+$/, `barCounter text (got "${lastBar}")`);
  assert.ok(barsSeen.size >= 2, `bar counter advanced across time (saw ${[...barsSeen].join(", ")})`);
  await page.close();
});

test("HUD conductor: a live 4-tap downbeat keeps the conductor alive (no UI errors)", async () => {
  const page = await browser.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.stack || String(e)));
  await page.goto(`${srv.baseUrl}/hud.html`, { waitUntil: "networkidle0" });
  await sleep(400);

  // Drive a real 4-tap run over WS (the exact action the controller button sends).
  const ws = io(srv.baseUrl, { transports: ["websocket", "polling"] });
  await new Promise((r) => ws.once("connect", r));
  mt.set({ playing: true, position: 0, bpm: 120, songId: "sunset" });
  for (let i = 0; i < 4; i++) { ws.emit("action", { type: "tap_tempo" }); await sleep(350); }
  await sleep(1200);

  const text = await page.$eval("#barCounter", (el) => el.textContent);
  assert.match(text, /^BAR:\s*\d+$/, `conductor alive after tap (got "${text}")`);
  ws.disconnect();
  await page.close();
});

test("Teleprompter count-in: REAPER play edge triggers 4→1 count-down from the mock", async () => {
  const page = await browser.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.stack || String(e)));
  const tpUrl = `http://127.0.0.1:${tpServer.address().port}/teleprompter.html?transportHost=127.0.0.1:${srv.apiPort}`;
  await page.goto(tpUrl, { waitUntil: "domcontentloaded" });
await sleep(2600); // let the page load count-in config (countEnabled=true) via its 2s poll

  // Fresh song id → server falls back to REAPER grid (source reaper, anchor
  // cleared) so the count uses a moving REAPER position, not stale tap state.
  mt.set({ playing: false, position: 0, bpm: 120, time_sig: [4, 4], songId: "countin_song", currentSong: "Count In" });
  const idleDeadline = Date.now() + 3000;
  while (Date.now() < idleDeadline) {
    const st = await (await fetch(`${srv.baseUrl}/api/state`)).json();
    if (st.playing === false && st.songId === "countin_song") break;
    await sleep(120);
  }
  await sleep(400);
  // Play like REAPER would: position advances at 120 BPM.
  mt.startPlayback(120);

  // Watch the count overlay for 4→1 then hide.
  const numsSeen = [];
  const deadline = Date.now() + 6000;
  let overlayVisible = false;
  while (Date.now() < deadline) {
    const r = await page.evaluate(() => {
      const ov = document.getElementById("countOverlay");
      const cn = document.getElementById("countNum");
      return { display: ov ? getComputedStyle(ov).display : null, num: cn ? cn.textContent : null };
    });
    if (r.display === "flex") { overlayVisible = true; if (r.num) numsSeen.push(r.num); }
    await sleep(80);
  }

  assert.ok(overlayVisible, "count-in overlay appeared on play edge");
  assert.ok(numsSeen.includes("4"), `counted down from 4 (saw: ${numsSeen.join(",")})`);
  assert.ok(numsSeen.includes("1"), `counted down to 1 (saw: ${numsSeen.join(",")})`);
  mt.stopPlayback();
  await page.close();
});

test("no uncaught page errors across UI tests", () => {
  // Filter out known-benign fetch errors to :3300 config endpoints the HUD pings.
  const real = pageErrors.filter((e) => !/config|tempo-sync|teleprompter|net::ERR|Failed to fetch|Failed to load resource|404|timeout/i.test(String(e)));
  assert.deepEqual(real, [], `unexpected page errors:\n${real.join("\n")}`);
});