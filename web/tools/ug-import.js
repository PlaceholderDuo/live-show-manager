#!/usr/bin/env node
// Ultimate Guitar batch importer — downloads all your UG tabs via the mobile API
// and creates song.chopro + meta.json + REAPER song folders automatically.
//
// Usage:
//   node tools/ug-import.js                          # interactive: logs into UG, imports all My Tabs
//   node tools/ug-import.js --ids "12345,67890"       # import specific tabs by ID
//   node tools/ug-import.js --playlists               # import all tabs from all playlists (browser-based)
//   node tools/ug-import.js --playlist-id "31619387"  # import tabs from specific playlist(s)
//   node tools/ug-import.js --dry-run                 # preview only, no writes
//   node tools/ug-import.js --skip-meta               # create only song.chopro, skip meta.json
//
// What it does:
//   1. Opens a browser window — you log into UG manually (required for cookie-based API auth)
//   2. Fetches ALL saved tab IDs via web API (/user/list/tab-list)
//   3. For each tab: fetches content + metadata via mobile API (api.ultimate-guitar.com)
//      using your browser session cookie (bbsessionhash) as the auth token
//   4. Converts mobile API [ch]Chord[/ch] format to ChordPro [Chord]text format
//   5. Generates meta.json with key, tuning, capo, difficulty, section data
//   6. Creates ~/ReaperSongs/<Song Name>/ with song.chopro + meta.json
//
// Credentials: NOT stored. NOT sent anywhere. You log in once in the browser window.
// Cookies are saved to logs/ug-cookies.json for reuse on subsequent runs.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const { execSync } = require("child_process");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { gpifToChopro, loadGpif } = require("./gpif-to-chopro.js");
puppeteer.use(StealthPlugin());

const REAPER_SONGS = path.join(os.homedir(), "ReaperSongs");
const TOOLS_DIR = __dirname;
const LOG_DIR = path.join(TOOLS_DIR, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "ug-import.log");
const COOKIE_FILE = path.join(LOG_DIR, "ug-cookies.json");

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run") || args.includes("--dry");
const skipMeta = args.includes("--skip-meta");
const doPlaylists = args.includes("--playlists");
const manualIds = (() => {
  const idx = args.indexOf("--ids");
  if (idx >= 0 && args[idx + 1]) return args[idx + 1].split(",").map(s => s.trim()).filter(Boolean);
  return null;
})();
const manualPlaylistIds = (() => {
  const idx = args.indexOf("--playlist-id");
  if (idx >= 0 && args[idx + 1]) return args[idx + 1].split(",").map(s => s.trim()).filter(Boolean);
  return null;
})();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

function logError(msg) {
  const line = `[${new Date().toISOString()}] ERROR: ${msg}`;
  console.error(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

// ── Tab URL helpers ──
const TAB_BASE = "https://tabs.ultimate-guitar.com";

function toTabUrl(idOrUrl) {
  if (String(idOrUrl).startsWith("http")) return idOrUrl;
  return `${TAB_BASE}/tab/${idOrUrl}`;
}

function extractTabId(url) {
  const m = String(url).match(/(\d+)$/);
  return m ? m[1] : "";
}

// ── Mobile API client (no browser needed) ──
let _deviceId, _apiKey, _token;

function initMobileApi(token) {
  _token = token;
  _deviceId = crypto.randomBytes(8).toString("hex");
  refreshApiKey();
}

function refreshApiKey() {
  const now = new Date();
  const yyyymmddhh = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}-${String(now.getUTCDate()).padStart(2,"0")}:${String(now.getUTCHours()).padStart(2,"0")}`;
  _apiKey = crypto.createHash("md5").update(`${_deviceId}${yyyymmddhh}createLog()`).digest("hex");
}

function mobileApiRequest(path, isBinary) {
  return new Promise((resolve, reject) => {
    refreshApiKey();
    const opts = {
      hostname: "api.ultimate-guitar.com",
      path: `/api/v1${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(_token)}`,
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
          const data = Buffer.concat(chunks).toString("utf-8");
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, raw: data }); }
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Convert UG mobile API [ch] format to ChordPro inline ──
function ugMobileToChopro(mobileContent, title, artist, key) {
  let text = mobileContent || "";
  // Strip [tab], [/tab] markers
  text = text.replace(/\[\/?tab\]/g, "");
  // Convert [ch]Chord[/ch]Lyric → [Chord]Lyric
  // First, handle cases where chord tag is inline with lyrics
  text = text.replace(/\[ch\]([^\]]+)\[\/ch\]/g, (m, chord) => `[${chord}]`);
  // Remove empty bracket lines and clean up
  const lines = text.split("\n");
  const out = [];
  out.push(`{title: ${title || "Unknown"}}`);
  out.push(`{artist: ${artist || ""}}`);
  out.push(`{key: ${key || ""}}`);
  out.push("");

  let sectionCounters = { verse: 0, chorus: 0, intro: 0, solo: 0, bridge: 0, outro: 0 };
  let currentType = "verse";
  let inSection = false;

  function openSection(type) {
    sectionCounters[type] = (sectionCounters[type] || 0) + 1;
    currentType = type;
    const dir = type === "chorus" ? "chorus" : "verse";
    const label = type.charAt(0).toUpperCase() + type.slice(1) + " " + sectionCounters[type];
    out.push(`{start_of_${dir}: ${label}}`);
  }

  function closeSection() {
    const dir = currentType === "chorus" ? "chorus" : "verse";
    out.push(`{end_of_${dir}}`);
    out.push("");
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { continue; }

    // Section markers
    const secMatch = line.match(/^\[(Verse|Chorus|Solo|Bridge|Intro|Outro|Pre-Chorus|Interlude)\s*(\d*)\]/i);
    if (secMatch) {
      if (inSection) closeSection();
      currentType = secMatch[1].toLowerCase();
      openSection(currentType);
      inSection = true;
      continue;
    }

    // Chord-pro line with [Chord] tags
    if (line.includes("[") && line.includes("]")) {
      // Check if it's a chord-only line (all content is in brackets or whitespace)
      const stripped = line.replace(/\[[^\]]+\]/g, "").trim();
      if (!stripped) continue; // skip chord-only lines, inline format has chords with lyrics
      if (!inSection) { openSection("verse"); inSection = true; }
      out.push(line);
    } else {
      // Plain lyric line
      if (!inSection) { openSection("verse"); inSection = true; }
      out.push(line);
    }
  }

  if (inSection) closeSection();
  out.push("");
  return out.join("\n");
}

// Scan existing meta.jsons for already-imported UG tab IDs
function buildImportedTabIdSet() {
  const ids = new Set();
  try {
    const folders = fs.readdirSync(REAPER_SONGS, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const f of folders) {
      const metaPath = path.join(REAPER_SONGS, f.name, "meta.json");
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          if (meta.ug_tab_id) ids.add(meta.ug_tab_id);
        } catch {}
      }
    }
  } catch {}
  return ids;
}

// ── Detect ChordPro sections from chopro content ──
function detectChoproSections(text) {
  const sections = [];
  const rawLines = (text || "").split("\n");
  let currentType = "verse", currentLabel = "", currentLines = [], inSection = false;
  function flush() {
    if (!inSection) return;
    sections.push({ type: currentType, label: currentLabel, lines: currentLines });
    currentLines = []; inSection = false;
  }
  for (const line of rawLines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("{")) {
      if (/^\{end_of_/i.test(t)) { flush(); continue; }
      const m = t.match(/^\{([^:]+)(?::\s*(.+))?\}$/);
      if (m) {
        const n = m[1].trim().toLowerCase(), v = (m[2] || "").trim();
        if (n.includes("start_of_verse")) { flush(); currentType = "verse"; currentLabel = v || "Verse"; inSection = true; }
        else if (n.includes("start_of_chorus")) { flush(); currentType = "chorus"; currentLabel = v || "Chorus"; inSection = true; }
        else if (n.includes("start_of_solo")) { flush(); currentType = "solo"; currentLabel = v || "Solo"; inSection = true; }
        else if (n.includes("start_of_bridge")) { flush(); currentType = "bridge"; currentLabel = v || "Bridge"; inSection = true; }
        else if (n.includes("start_of_intro")) { flush(); currentType = "intro"; currentLabel = v || "Intro"; inSection = true; }
        else if (n.includes("start_of_outro")) { flush(); currentType = "outro"; currentLabel = v || "Outro"; inSection = true; }
        else if (n.includes("start_of_interlude")) { flush(); currentType = "interlude"; currentLabel = v || "Interlude"; inSection = true; }
      }
      continue;
    }
    if (inSection) currentLines.push(t.replace(/\[([^\]]+)\]/g, "").replace(/[🎸🗿👍]/gu, "").trim());
  }
  flush();
  for (const s of sections) {
    const ll = (s.label || "").toLowerCase();
    if (ll.includes("intro") && s.type === "verse") s.type = "intro";
    else if (ll.includes("outro") && s.type === "verse") s.type = "outro";
    else if (ll.includes("bridge") && s.type === "verse") s.type = "bridge";
    else if (ll.includes("solo") && s.type === "verse") s.type = "solo";
  }
  return sections;
}

function createMetaFromChopro(choproText, scrapeTitle, scrapeArtist, scrapeKey, extra = {}) {
  const sections = detectChoproSections(choproText);
  if (sections.length === 0) return null;

  const lyrics = [];
  let bar = 1;

  let title = "", artist = "", key = "";
  for (const line of choproText.split("\n")) {
    const t = line.trim();
    if (t.startsWith("{title:")) title = t.replace(/\{title:\s*/i, "").replace(/\}$/, "").trim();
    else if (t.startsWith("{artist:")) artist = t.replace(/\{artist:\s*/i, "").replace(/\}$/, "").trim();
    else if (t.startsWith("{key:")) key = t.replace(/\{key:\s*/i, "").replace(/\}$/, "").trim();
  }

  title = scrapeTitle || title || "Unknown Song";
  artist = scrapeArtist || artist || "";
  key = scrapeKey || key || "";

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const firstLine = sec.lines[0] || sec.label || "";
    lyrics.push({ bar, text: firstLine });
    bar += Math.max(sec.lines.length * 4, 8);
  }

  // Extra metadata from UG
  const { tuning = "", capo = "", difficulty = "", ug_tab_id = "" } = extra;

  return {
    ug_tab_id, title, artist, bpm: 120, key,
    tuning, capo, difficulty,
    duration_bars: bar + 8,
    time_sig: [4, 4],
    notes: `Imported from Ultimate Guitar. ${sections.length} sections`,
    lyrics,
    cue_events: [{ bar: 1, type: "program_change", channel: 1, value: 0 }],
  };
}

// ── Convert UG two-line format to ChordPro inline format ──
function ugToChopro(ugText, title, artist, key) {
  const lines = ugText.split("\n");
  const out = [];

  out.push(`{title: ${title || "Unknown"}}`);
  out.push(`{artist: ${artist || ""}}`);
  out.push(`{key: ${key || ""}}`);
  out.push("");

  let sectionCounters = { verse: 0, chorus: 0, intro: 0, solo: 0, bridge: 0, outro: 0 };
  let pendingChords = null;
  let currentType = "verse";
  let inSection = false;

  function openSection(type) {
    sectionCounters[type] = (sectionCounters[type] || 0) + 1;
    currentType = type;
    const dir = type === "chorus" ? "chorus" : "verse";
    const label = type.charAt(0).toUpperCase() + type.slice(1) + " " + sectionCounters[type];
    out.push(`{start_of_${dir}: ${label}}`);
  }

  function closeSection() {
    const dir = currentType === "chorus" ? "chorus" : "verse";
    out.push(`{end_of_${dir}}`);
    out.push("");
  }

  for (const line of lines) {
    const t = line.trim();
    if (!t) { pendingChords = null; continue; }

    const sectionMatch = t.match(/^\[(Verse|Chorus|Solo|Bridge|Intro|Outro|Pre-Chorus|Interlude)\s*(\d*)\]/i);
    if (sectionMatch) {
      if (inSection) closeSection();
      currentType = sectionMatch[1].toLowerCase();
      openSection(currentType);
      inSection = true;
      pendingChords = null;
      continue;
    }

    const words = t.split(/\s+/);
    const chords = words.filter(w => /^[A-G][#bmM0-9\/]*$/.test(w) && w.length <= 6);

    if (chords.length > 1 && chords.length === words.length) {
      pendingChords = chords;
      continue;
    }

    if (pendingChords) {
      const lyricWords = t.split(/\s+/);
      let merged = "";
      let ci = 0;
      for (let wi = 0; wi < lyricWords.length; wi++) {
        const w = lyricWords[wi];
        if (!w || /^[,.!?;:]+$/.test(w)) { merged += w + " "; continue; }
        if (ci < pendingChords.length) {
          merged += `[${pendingChords[ci]}]${w} `;
          ci++;
        } else {
          merged += w + " ";
        }
      }
      if (!inSection) { openSection("verse"); inSection = true; }
      out.push(merged.trim());
      pendingChords = null;
    } else {
      if (!inSection) { openSection("verse"); inSection = true; }
      out.push(t);
    }
  }

  if (inSection) closeSection();
  out.push("");
  return out.join("\n");
}

// ── Fetch all My Tabs IDs via UG internal web API ──
async function fetchMyTabsIds(page) {
  log("Fetching My Tabs via internal API...");
  const result = await page.evaluate(async () => {
    const res = await fetch("/user/list/tab-list");
    const data = await res.json();
    if (data.result !== "ok" || !data.info) throw new Error("API returned unexpected format");
    return data.info;
  });
  const allIds = result.favorites || [];
  log(`Found ${allIds.length} My Tabs via API.`);
  return allIds.map(String);
}

// ── Scrape tab URLs from a single UG playlist ──
async function scrapePlaylistTabUrls(page, playlistId) {
  const url = `https://www.ultimate-guitar.com/user/playlist/view?id=${playlistId}`;
  log(`  Fetching playlist ${playlistId}...`);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  const name = await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    return h1 ? h1.innerText.trim() : "";
  });

  const urls = await page.evaluate(() =>
    [...document.querySelectorAll("a")]
      .map(a => a.href)
      .filter(h => /\/tab\//.test(h))
  );

  log(`    "${name}": ${urls.length} tabs`);
  return { name, urls };
}

// ── Get all playlist IDs from the user's playlist listing ──
async function scrapePlaylistIds(page) {
  await page.goto("https://www.ultimate-guitar.com/user/playlist", {
    waitUntil: "networkidle2", timeout: 30000,
  });

  return await page.evaluate(() => {
    const seen = new Set();
    return [...document.querySelectorAll('a[href*="playlist/view?id="]')]
      .map(a => {
        const m = a.href.match(/id=(\d+)/);
        return m ? { id: m[1], name: a.innerText.trim() } : null;
      })
      .filter(Boolean)
      .filter(p => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });
  });
}

// ── Fetch a single tab via mobile API (fast, no browser) ──
async function fetchTabApi(tabId) {
  try {
    const result = await mobileApiRequest(`/tab/info?tab_id=${tabId}&tab_access_type=public`);
    if (result.status !== 200 || !result.data) {
      return { title: "", artist: "", key: "", content: "", tuning: "", capo: "", difficulty: "", ug_tab_id: tabId };
    }
    const d = result.data;
    // If no text content, try GP download for Official/Pro tabs
    if (!d.content && d.content_urls && d.content_urls.source) {
      log(`  Official/Pro tab — downloading GP file...`);
      const gpResult = await fetchTabApiGp(tabId, d);
      if (gpResult.content) return gpResult;
    }
    return {
      title: d.song_name || "",
      artist: d.artist_name || "",
      key: d.tonality_name || "",
      content: d.content || "",
      tuning: d.tuning || "",
      capo: String(d.capo || ""),
      difficulty: d.difficulty || d.ug_difficulty || "",
      ug_tab_id: tabId,
    };
  } catch (e) {
    logError(`fetchTabApi error for ${tabId}: ${e.message}`);
    return { title: "", artist: "", key: "", content: "", ug_tab_id: tabId };
  }
}

// ── Download and convert Official/Pro GP file → ChordPro ──
async function fetchTabApiGp(tabId, data) {
  try {
    const { content_urls } = data;
    const dlUrl = new URL(content_urls.source);
    // Strip /api/v1 prefix since mobileApiRequest adds it
    const dlPath = dlUrl.pathname.replace(/^\/api\/v1/, "") + dlUrl.search;
    const result = await mobileApiRequest(dlPath, true);
    if (result.status !== 200 || !result.raw) {
      return { title: "", artist: "", key: "", content: "", ug_tab_id: tabId };
    }
    // Save GP file to temp, extract gpif, convert to chopro
    const tmpFile = `/tmp/ug_gp_${tabId}.gp`;
    require("fs").writeFileSync(tmpFile, result.raw);
    const gpifXml = loadGpif(tmpFile);
    const converted = gpifToChopro(gpifXml);
    try { require("fs").unlinkSync(tmpFile); } catch {}
    return {
      title: converted.title || data.song_name || "",
      artist: converted.artist || data.artist_name || "",
      key: data.tonality_name || converted.key || "",
      content: converted.chopro || "",
      tuning: data.tuning || "",
      capo: String(data.capo || ""),
      difficulty: data.difficulty || data.ug_difficulty || "",
      ug_tab_id: tabId,
      _gpConverted: true,
    };
  } catch (e) {
    logError(`GP download/convert error for ${tabId}: ${e.message}`);
    return { title: "", artist: "", key: "", content: "", ug_tab_id: tabId };
  }
}

// ── Fetch a single tab from UG via browser (for playlists) ──
async function fetchTabBrowser(page, urlOrId) {
  const url = toTabUrl(urlOrId);
  try {
    await page.goto(url, {
      waitUntil: "networkidle2", timeout: 20000,
    });

    const title = await page.title();

    let content = await page.evaluate(() => {
      const pres = document.querySelectorAll("pre");
      let best = null;
      for (const p of pres) {
        if (p.innerText.length > 100) {
          if (!best || p.innerText.length > best.innerText.length) best = p;
        }
      }
      return best ? best.innerText : "";
    });

    if (!content) {
      const switched = await page.evaluate(() => {
        const all = document.querySelectorAll("button, a, span, div, [role=tab]");
        for (const el of all) {
          if (el.innerText.trim() === "Chords") { el.click(); return true; }
        }
        return false;
      });
      if (switched) {
        await new Promise(r => setTimeout(r, 2000));
        content = await page.evaluate(() => {
          const pres = document.querySelectorAll("pre");
          let best = null;
          for (const p of pres) {
            if (p.innerText.length > 100) {
              if (!best || p.innerText.length > best.innerText.length) best = p;
            }
          }
          return best ? best.innerText : "";
        });
      }
    }

    let key = "";
    let tuning = "";
    let capo = "";
    let difficulty = "";

    const bodyText = await page.evaluate(() => document.body?.innerText || "");

    const keyMatch = bodyText.match(/Key:\s*([A-G][#bm0-9\/]*)/i);
    if (keyMatch) key = keyMatch[1];

    const tuneMatch = bodyText.match(/Tuning:\s*([A-Z][a-z#\s\d]+?)(?:Key:|Capo:|$)/i);
    if (tuneMatch) tuning = tuneMatch[1].trim();

    const capoMatch = bodyText.match(/Capo:\s*(.+?)(?:\n|$)/i);
    if (capoMatch) capo = capoMatch[1].trim();

    const diffMatch = bodyText.match(/Difficulty:\s*(.+?)(?:\n|$)/i);
    if (diffMatch) difficulty = diffMatch[1].trim();

    let songTitle = title;
    let artist = "";
    songTitle = songTitle.replace(/^\(\d+\)\s*/, "");
    const byMatch = songTitle.match(/^(.+?)\s+by\s+(.+?)(?:\s+@|$)/i);
    if (byMatch) {
      songTitle = byMatch[1].replace(/\s+(chords|tab|lv|ver\s+\d+)$/i, "").trim();
      artist = byMatch[2].trim();
    }
    if (!byMatch) {
      const altMatch = title.match(/^(.+?)\s+by\s+(.+?)(?:\s+@|$)/i);
      if (altMatch) {
        songTitle = altMatch[1].replace(/\s+(chords|tab|lv|ver\s+\d+)$/i, "").trim();
        artist = altMatch[2].trim();
      }
    }

    return { content, title: songTitle, artist, key, tuning, capo, difficulty };
  } catch (e) {
    logError(`fetchTabBrowser error for ${url}: ${e.message}`);
    return { title: "", artist: "", key: "", content: "" };
  }
}

// ── Write song files to ReaperSongs/ ──
function saveSong(title, artist, key, content, extra = {}) {
  const cleanTitle = title.replace(/^(Tab|Chord)\s+/i, "").trim();
  const folderPath = path.join(REAPER_SONGS, cleanTitle);
  const choproPath = path.join(folderPath, "song.chopro");
  const metaPath = path.join(folderPath, "meta.json");

  // If meta.json already has a ug_tab_id, this song was imported before
  if (!isDryRun && fs.existsSync(metaPath)) {
    try {
      const existingMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (existingMeta.ug_tab_id) {
        return true; // already tracked
      }
    } catch {}
  }
  if (fs.existsSync(choproPath) && !isDryRun) {
    // Song exists but may be missing ug_tab_id — backfill it
    const { ug_tab_id: tabId, tuning = "", capo = "", difficulty = "" } = extra;
    if (tabId && fs.existsSync(metaPath)) {
      try {
        const existingMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        if (!existingMeta.ug_tab_id && tabId) {
          existingMeta.ug_tab_id = tabId;
          if (tuning && !existingMeta.tuning) existingMeta.tuning = tuning;
          if (capo && !existingMeta.capo) existingMeta.capo = capo;
          if (difficulty && !existingMeta.difficulty) existingMeta.difficulty = difficulty;
          fs.writeFileSync(metaPath, JSON.stringify(existingMeta, null, 2), "utf-8");
          log(`  Backfilled ug_tab_id: ${cleanTitle}`);
        }
      } catch {}
    }
    return true;
  }

  // Detect format: mobile API uses [ch]Chord[/ch], browser scrape uses two-line
  const isMobileFormat = /\[ch\]/.test(content);
  const choproContent = isMobileFormat
    ? ugMobileToChopro(content, cleanTitle, artist, key)
    : ugToChopro(content, cleanTitle, artist, key);

  if (isDryRun) {
    log(`[DRY] ${cleanTitle} (${artist || "?"})`);
    return true;
  }

  try {
    fs.mkdirSync(folderPath, { recursive: true });
    fs.writeFileSync(choproPath, choproContent, "utf-8");
    log(`  ✅ song.chopro (${choproContent.split("\n").length} lines)`);

    if (!skipMeta && !fs.existsSync(metaPath)) {
      const meta = createMetaFromChopro(choproContent, cleanTitle, artist, key, extra);
      if (meta) {
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
        log(`  ✅ meta.json (${meta.lyrics.length} sections)`);
      }
    }

    return true;
  } catch (e) {
    logError(`  Write error: ${e.message}`);
    return false;
  }
}

// ── Main ──
async function main() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  log("=== Ultimate Guitar Batch Import ===");

  if (manualIds) {
    // ── Manual IDs mode ──
    log(`Importing ${manualIds.length} specific tab IDs...`);

    // Init mobile API from saved cookies
    if (fs.existsSync(COOKIE_FILE)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
      const bbsession = cookies.find(c => c.name === "bbsessionhash");
      if (bbsession) {
        initMobileApi(bbsession.value);
        log("Mobile API initialized from saved cookies.");
      } else {
        logError("No bbsessionhash in saved cookies. Run interactive mode first.");
        return;
      }
    } else {
      logError("No saved cookies found. Run interactive mode first to log in.");
      return;
    }

    const importedIds = buildImportedTabIdSet();
    log(`Already have ${importedIds.size} tab IDs on disk.`);

    let success = 0, failed = 0;
    for (let i = 0; i < manualIds.length; i++) {
      const id = manualIds[i];
      if (importedIds.has(id)) { log(`[${i + 1}/${manualIds.length}] Tab ${id}... skipped (already imported)`); success++; continue; }
      log(`[${i + 1}/${manualIds.length}] Tab ${id}...`);
      try {
        const r = await fetchTabApi(id);
        if (r.content && r.title) {
          if (saveSong(r.title, r.artist, r.key, r.content, r)) success++;
          else failed++;
        } else {
          logError(`  Empty: ${id}`);
          failed++;
        }
      } catch (e) {
        logError(`  ${id}: ${e.message}`);
        failed++;
      }
    }

    log(`Done. ${success} imported, ${failed} failed.`);
    return;
  }

  // ── Interactive mode: scrape My Tabs ──
  log("Launching browser...");
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
  });

  // Try loading saved cookies first
  let loggedIn = false;
  if (fs.existsSync(COOKIE_FILE)) {
    log("Found saved cookies — restoring session...");
    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
    await page.setCookie(...cookies);
    try {
      await page.goto("https://www.ultimate-guitar.com/", {
        waitUntil: "networkidle2", timeout: 30000,
      });
      await new Promise(r => setTimeout(r, 2000));
      const text = await page.evaluate(() => document.body?.textContent || "");
      const hasLoginField = /(sign in|log in)/i.test(text);
      const hasUserMenu = /log\s*out|sign\s*out|my\s*tabs|my\s*profile/i.test(text);
      if (hasUserMenu || !hasLoginField) {
        loggedIn = true;
        log("Session restored from saved cookies!");
      } else {
        log("Cookies expired. Please log in again.");
      }
    } catch (e) {
      log(`Cookie restore check failed: ${e.message}. Will re-login.`);
    }
  }

  if (!loggedIn) {
    await page.goto("https://www.ultimate-guitar.com/", {
      waitUntil: "domcontentloaded", timeout: 60000,
    });
    log("Browser opened. Please:");
    log("  1. Log in to Ultimate Guitar in the browser window");
    log("  2. Navigate to your My Tabs page (https://www.ultimate-guitar.com/user/mytabs)");
    log("  3. In your terminal, run:  touch /tmp/ug-ready");
    log("Waiting for /tmp/ug-ready signal (300s timeout)...");
    let ready = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (fs.existsSync("/tmp/ug-ready")) { ready = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    try { fs.unlinkSync("/tmp/ug-ready"); } catch {}
    if (ready) log("Continuing...");
    else log("Timed out waiting for signal.");

    const cookies = await page.cookies();
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2), "utf-8");
    log(`Session cookies saved to ${COOKIE_FILE}`);
    loggedIn = true;
  }

  // ── Playlist mode ──
  if (doPlaylists || manualPlaylistIds) {
    let allPlaylists;

    if (manualPlaylistIds) {
      // Fetch specific playlists by ID
      allPlaylists = [];
      for (const id of manualPlaylistIds) {
        const result = await scrapePlaylistTabUrls(page, id);
        if (result) allPlaylists.push(result);
      }
    } else {
      // Scrape all playlists from the listing page
      const playlists = await scrapePlaylistIds(page);
      log(`Found ${playlists.length} playlists.`);
      allPlaylists = [];
      for (const p of playlists) {
        const result = await scrapePlaylistTabUrls(page, p.id);
        if (result) allPlaylists.push(result);
      }
    }

    // Collect unique tab URLs across all playlists
    const seen = new Set();
    const tabUrls = [];
    for (const pl of allPlaylists) {
      for (const url of pl.urls) {
        if (!seen.has(url)) {
          seen.add(url);
          tabUrls.push(url);
        }
      }
    }

    log(`\n${tabUrls.length} unique tabs across ${allPlaylists.length} playlists.\n`);

    if (tabUrls.length === 0) {
      log("No tabs to import. Exiting.");
      await browser.close();
      return;
    }

    log("Downloading and converting tabs...");
    const importedIds = buildImportedTabIdSet();
    let success = 0, failed = 0;

    for (let i = 0; i < tabUrls.length; i++) {
      const url = tabUrls[i];
      const id = extractTabId(url);
      if (importedIds.has(id)) { success++; continue; }
      log(`[${i + 1}/${tabUrls.length}] ${id}...`);
      try {
        const r = await fetchTabBrowser(page, url);  // browser-based for playlists
        r.ug_tab_id = id;
        if (r.content && r.title) {
          if (saveSong(r.title, r.artist, r.key, r.content, r)) success++;
          else failed++;
        } else {
          logError(`  No content for tab ${id}`);
          failed++;
        }
      } catch (e) {
        logError(`  ${id}: ${e.message}`);
        failed++;
      }
    }

    await browser.close();
    const skipped = tabUrls.length - (success + failed);
    log(`\nDone. ${success} imported, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""}.`);
    log(`Log: ${LOG_FILE}`);
    return;
  }

  // ── Init mobile API with session cookie ──
  const sessionCookies = await page.cookies();
  const bbsession = sessionCookies.find(c => c.name === "bbsessionhash");
  if (!bbsession) {
    logError("No bbsessionhash cookie found. Login may have failed.");
    await browser.close();
    return;
  }
  initMobileApi(bbsession.value);
  log("Mobile API initialized with session token.");

  // ── Fetch all tab IDs via web API (needs browser cookies) ──
  const tabIds = await fetchMyTabsIds(page);

  // ── Close browser — all further requests use mobile API ──
  await browser.close();
  log("Browser closed. Using mobile API for tab downloads.");

  if (tabIds.length === 0) {
    log("No tabs to import. Exiting.");
    return;
  }

  // ── Download tabs via mobile API ──
  log(`\n${tabIds.length} tabs to process.\n`);
  const importedIds = buildImportedTabIdSet();
  let success = 0, failed = 0;

  for (let i = 0; i < tabIds.length; i++) {
    const id = tabIds[i];
    if (importedIds.has(id)) { success++; continue; }
    log(`[${i + 1}/${tabIds.length}] ${id}...`);
    try {
      const r = await fetchTabApi(id);
      if (r.content && r.title) {
        if (saveSong(r.title, r.artist, r.key, r.content, r)) success++;
        else failed++;
      } else {
        logError(`  No content for tab ${id}`);
        failed++;
      }
    } catch (e) {
      logError(`  ${id}: ${e.message}`);
      failed++;
    }
  }

  const skipped = tabIds.length - (success + failed);
  log(`\nDone. ${success} imported, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""}.`);
  log(`Log: ${LOG_FILE}`);
}

main().catch(e => {
  logError(`Fatal: ${e.stack || e.message}`);
  process.exit(1);
});