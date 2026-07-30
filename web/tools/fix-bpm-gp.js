#!/usr/bin/env node
// fix-bpm-gp.js — Extract real BPM from UG GPIF files for songs with ug_tab_id
// ===================================================================
// Opens a browser for UG login (if cookies expired), then re-downloads
// GP files for all songs with ug_tab_id and extracts BPM from the GPIF XML.
//
// Usage:
//   node tools/fix-bpm-gp.js                  # all ug_tab_id songs (opens browser if needed)
//   node tools/fix-bpm-gp.js --dry-run        # preview only, no writes
//   node tools/fix-bpm-gp.js --song "Name"    # single song
//   node tools/fix-bpm-gp.js --limit 5        # test first N

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const { execSync } = require("child_process");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const SONGS_DIR = path.join(os.homedir(), "ReaperSongs");
const TOOLS_DIR = __dirname;
const COOKIE_FILE = path.join(TOOLS_DIR, "..", "logs", "ug-cookies.json");

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run") || args.includes("--dry");
const specificSong = (() => {
  const idx = args.indexOf("--song");
  if (idx < 0 || !args[idx + 1]) return null;
  const parts = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith("-")) break;
    parts.push(args[i]);
  }
  return parts.join(" ");
})();
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null;
const REQ_DELAY = 800;

// ═══════════════════════════════════════════════════════════
// AUTH — Browser-based UG login (reused from ug-import.js)
// ═══════════════════════════════════════════════════════════

let _token, _deviceId, _apiKey;

function refreshApiKey() {
  const now = new Date();
  const yyyymmddhh = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}:${String(now.getUTCHours()).padStart(2, "0")}`;
  _apiKey = crypto.createHash("md5").update(`${_deviceId}${yyyymmddhh}createLog()`).digest("hex");
}

function mobileApiRequest(urlPath, isBinary) {
  return new Promise((resolve, reject) => {
    refreshApiKey();
    const opts = {
      hostname: "api.ultimate-guitar.com",
      path: `/api/v1${urlPath}${urlPath.includes("?") ? "&" : "?"}token=${encodeURIComponent(_token)}`,
      method: "GET",
      headers: {
        "X-UG-CLIENT-ID": _deviceId,
        "X-UG-API-KEY": _apiKey,
        "User-Agent": "UGT_ANDROID/4.11.1 (Pixel; 8.1.0)",
        "Accept": isBinary ? "application/octet-stream" : "application/json",
      },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        if (isBinary) {
          resolve({ status: res.statusCode, raw: Buffer.concat(chunks) });
        } else {
          const body = Buffer.concat(chunks).toString("utf-8");
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, raw: body }); }
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

async function authenticate() {
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
  });

  let loggedIn = false;

  if (fs.existsSync(COOKIE_FILE)) {
    console.log("Trying saved cookies...");
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
      await page.setCookie(...cookies);
      await page.goto("https://www.ultimate-guitar.com/", { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(r => setTimeout(r, 2000));
      const text = await page.evaluate(() => document.body?.textContent || "");
      if (!/sign in|log in/i.test(text)) {
        loggedIn = true;
        console.log("Session restored!");
      } else {
        console.log("Cookies expired — need fresh login.");
      }
    } catch (e) {
      console.log("Cookie check failed:", e.message);
    }
  }

  if (!loggedIn) {
    await page.goto("https://www.ultimate-guitar.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log("\n=== BROWSER OPENED ===");
    console.log("  Log in to Ultimate Guitar — script auto-detects when you're done.\n");

    // Auto-detect login by polling for cookie or UI change (no terminal command needed)
    let ready = false;
    for (let i = 0; i < 300; i++) {
      const currentCookies = await page.cookies();
      const hasSession = currentCookies.some(c => c.name === "bbsessionhash" && c.value.length > 10);
      if (hasSession) {
        // Double-check by looking at page content
        try {
          const body = await page.evaluate(() => document.body?.textContent || "");
          if (!/(sign in|log in)/i.test(body)) {
            ready = true;
            break;
          }
        } catch { ready = true; break; }
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!ready) { console.log("Timed out waiting for login."); await browser.close(); return false; }

    console.log("Login detected!\n");
    loggedIn = true;
  }

  const cookies = await page.cookies();
  const bbsession = cookies.find(c => c.name === "bbsessionhash");
  if (!bbsession) {
    console.error("No bbsessionhash cookie found. Login failed.");
    await browser.close();
    return false;
  }

  _token = bbsession.value;
  _deviceId = crypto.randomBytes(8).toString("hex");
  refreshApiKey();

  await browser.close();
  return true;
}

// ═══════════════════════════════════════════════════════════
// GPIF BPM extraction
// ═══════════════════════════════════════════════════════════

function parseBpmFromXml(xml) {
  const m = xml.match(/<Automation[^>]*>\s*<Type>Tempo<\/Type>[\s\S]*?<Value>(\d+)/);
  return m ? parseInt(m[1]) : null;
}

async function downloadAndExtractBpm(tabId) {
  const info = await mobileApiRequest(`/tab/info?tab_id=${tabId}&tab_access_type=public`);
  if (!info || info.status !== 200 || !info.data) return null;

  const d = info.data;
  if (!d.content_urls || !d.content_urls.source) return null;

  try {
    const dlUrl = new URL(d.content_urls.source);
    const dlPath = dlUrl.pathname.replace(/^\/api\/v1/, "") + dlUrl.search;
    const result = await mobileApiRequest(dlPath, true);
    if (result.status !== 200 || !result.raw) return null;

    const tmpFile = `/tmp/ug_bpm_${tabId}.gp`;
    fs.writeFileSync(tmpFile, result.raw);

    let gpifXml = null;
    const header = result.raw.slice(0, 4).toString();

    if (header === "PK\u0003\u0004") {
      // GP7 (ZIP with score.gpif inside)
      try {
        gpifXml = execSync(`unzip -p "${tmpFile}" Content/score.gpif`, {
          maxBuffer: 50 * 1024 * 1024,
          stdio: ["pipe", "pipe", "ignore"],
        }).toString();
      } catch {}
    } else if (header.slice(0, 4).toString("ascii") === "BCFZ") {
      // GP6 (BCFZ compressed)
      try {
        const { loadGpif } = require("./gpif-to-chopro.js");
        gpifXml = loadGpif(tmpFile);
      } catch {}
    }

    try { fs.unlinkSync(tmpFile); } catch {}

    if (gpifXml) {
      const bpm = parseBpmFromXml(gpifXml);
      if (bpm && bpm > 30 && bpm < 300) return bpm;
    }
  } catch (e) {
    if (process.env.DEBUG) console.error(`  GP download error for ${tabId}:`, e.message);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  const authed = await authenticate();
  if (!authed) process.exit(1);

  console.log("\nScanning for songs with ug_tab_id + BPM=120...");

  let folders;
  try {
    folders = fs.readdirSync(SONGS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
      .map(d => d.name);
  } catch (e) {
    console.error("Cannot read", SONGS_DIR, e.message);
    process.exit(1);
  }

  const targets = [];
  for (const folder of folders) {
    const metaPath = path.join(SONGS_DIR, folder, "meta.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (meta.ug_tab_id && (meta.bpm === 120 || !meta.bpm || meta.bpm < 1)) {
        targets.push({ folder, tabId: meta.ug_tab_id, metaPath, meta });
      }
    } catch {}
  }

  if (specificSong) {
    const slug = specificSong.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const f = targets.find(t => t.folder.toLowerCase().replace(/[^a-z0-9]+/g, "_") === slug);
    if (!f) { console.error("Not found or no ug_tab_id:", specificSong); process.exit(1); }
    targets.length = 0;
    targets.push(f);
  }

  console.log(`Found ${targets.length} songs to fix.`);
  console.log(`Mode: ${isDryRun ? "DRY RUN" : "LIVE"} | Delay: ${REQ_DELAY}ms`);
  console.log();

  let fixed = 0, failed = 0, total = 0;
  const startTime = Date.now();

  for (const { folder, tabId, metaPath, meta } of targets) {
    total++;
    const eta = total > 0 ? ((targets.length - total) * REQ_DELAY / 1000) : 0;
    process.stdout.write(`\r  [${String(total).padStart(3)}/${targets.length}] ${folder.padEnd(40).substring(0, 40)} ETA ${Math.ceil(eta)}s`);

    try {
      const bpm = await downloadAndExtractBpm(tabId);
      if (bpm) {
        if (isDryRun) {
          process.stdout.write(` → BPM=${bpm}\n`);
        } else {
          meta.bpm = bpm;
          meta.bpm_source = "gpif";
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
        }
        fixed++;
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
    }

    if (limit && total >= limit) break;
    await new Promise(r => setTimeout(r, REQ_DELAY));
  }

  process.stdout.write("\r\x1b[K\n");
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nDone in ${elapsed}m: ${fixed} fixed${isDryRun ? " (dry-run)" : ""}, ${failed} failed, ${total} total.`);

  if (isDryRun && fixed > 0) {
    console.log("DRY RUN — no files written. Remove --dry-run to apply.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
