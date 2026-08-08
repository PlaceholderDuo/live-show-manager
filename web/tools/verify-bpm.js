#!/usr/bin/env node
// verify-bpm.js — Resolve a TRUSTED BPM for every song.
// =============================================================
// Ground truth discovery (non-circular): the raw LRCLIB synced-lyrics seconds
// (real wall-clock timestamps) matched against the chopro @bar structure give
// the true tempo: realBpm = 240 / secPerBar. This does NOT use meta.bpm, so
// it is independent of the (often wrong) aubio value that poisoned the earlier
// pipeline.
//
// Priority:
//   1. LRCLIB-derived BPM (synced lyrics + chopro bars)  → bpm_source="verified"
//   2. meta.bpm when gpif (proven reliable)               → bpm_source="gpif"
//   3. aubio on full.mp3 as fallback (stable-across-params) → bpm_source="aubio-verified"
//   4. nothing reliable → bpm_source stays, bpm_verified=false (flag it)
//
// Usage:
//   node tools/verify-bpm.js --dry-run      # preview only, no writes
//   node tools/verify-bpm.js --song "Name"  # single song
//   node tools/verify-bpm.js                # all songs (network ~1.1s/song)
//
// Writes to meta.json: bpm, bpm_source, bpm_verified, lrc_duration_sec.
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const SONGS_DIR = path.join(os.homedir(), "ReaperSongs");
const AUDIO_DIR = path.join(os.homedir(), "Music", "SongAudio");
const LRCLIB_BASE = "lrclib.net";
const REQ_DELAY_MS = 1100;
const isDryRun = process.argv.includes("--dry-run");
const singleIdx = process.argv.indexOf("--song");
const singleSong = singleIdx !== -1 && process.argv[singleIdx + 1] ? process.argv[singleIdx + 1] : null;

function httpGetJson(host, p, retries) {
  if (retries === undefined) retries = 2;
  return new Promise((resolve, reject) => {
    const opts = { hostname: host, path: p, method: "GET", headers: { "User-Agent": "LiveShowManager/1.0" } };
    const req = https.request(opts, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error("JSON parse error")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  }).catch((e) => {
    if (retries > 0) {
      const wait = 3000 * (3 - retries);
      return new Promise((r) => setTimeout(r, wait)).then(() => httpGetJson(host, p, retries - 1));
    }
    throw e;
  });
}

function parseLRC(text) {
  const out = [];
  if (!text) return out;
  const re = /^\[(\d+):(\d{2})[.:](\d{2,3})\]\s*(.*)/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const ms = parseInt(m[3].padEnd(3, "0"), 10);
    out.push({ time: +m[1] * 60 + +m[2] + ms / 1000, text: m[4].trim() });
  }
  return out;
}

function norm(s) {
  return (s || "").toLowerCase().replace(/['’"“”`]/g, "").replace(/[-–—]/g, "").replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const wa = na.split(/\s+/), wb = nb.split(/\s+/);
  const common = wa.filter((w) => wb.includes(w)).length;
  return common / Math.max(wa.length, wb.length);
}

// Extract chopro (bar, text) pairs.
function choproBarPairs(chopro) {
  const pairs = [];
  for (const raw of chopro.split("\n")) {
    const bm = raw.match(/@bar\s*=\s*(\d+)/);
    if (!bm) continue;
    const txt = raw
      .replace(/@time\s*=\s*[\d.]+/i, "")
      .replace(/@bar\s*=\s*\d+/i, "")
      .replace(/\[.*?\]/g, "")
      .replace(/\/[A-G][#b]?(?:m7?|dim|aug|sus[24]|add\d+|5|7b?9?|maj7?|min7?|dim7?|aug7?|6|9|11|13)?(?:\/[A-G][#b]?)?\//g, "")
      .replace(/\s@[\d.]+$/, "")
      .trim();
    if (txt && /^(song|artist|tuning|capo|tabbed|standard|no chords)[:\s]/i.test(txt) === false) {
      pairs.push({ bar: +bm[1], txt: norm(txt) });
    }
  }
  return pairs;
}

// Match chopro (bar,text) to LRC (time,text) → (bar, sec) pairs.
function matchPairs(choproPairs, lrcLines) {
  const out = [];
  let li = 0;
  for (const cp of choproPairs) {
    if (!cp.txt) continue;
    let best = null, bs = 0;
    for (let k = li; k < Math.min(lrcLines.length, li + 5); k++) {
      const sc = similarity(cp.txt, lrcLines[k].text);
      if (sc > bs) { bs = sc; best = lrcLines[k]; }
    }
    if (best && bs > 0.5) {
      out.push({ bar: cp.bar, sec: best.time });
      li = lrcLines.indexOf(best) + 1;
    }
  }
  return out;
}

// Derive BPM from matched (bar, sec) pairs: realBpm = 240 / secPerBar.
function deriveBpm(pairs) {
  if (pairs.length < 2) return null;
  // Use a robust linear fit of sec vs bar.
  const n = pairs.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const p of pairs) { sx += p.bar; sy += p.sec; sxy += p.bar * p.sec; sxx += p.bar * p.bar; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const m = (n * sxy - sx * sy) / denom; // sec per bar
  if (m <= 0) return null;
  const bpm = 240 / m;
  if (bpm < 30 || bpm > 280) return null;
  return Math.round(bpm * 10) / 10;
}

// Run aubio on a 60s sample; require stability across two parameter sets.
function aubioBpm(fullPath) {
  try {
    const wav = path.join(os.tmpdir(), "bpm_" + process.pid + "_" + Math.random().toString(36).slice(2) + ".wav");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", fullPath, "-t", "60", "-ac", "1", "-ar", "22050", wav], { timeout: 60000 });
    const read = (args) => {
      try {
        const out = execFileSync("aubio", ["tempo", ...args, "-i", wav], { encoding: "utf8", timeout: 60000 }).trim();
        const v = parseFloat(out.split("\n").pop());
        return isFinite(v) && v > 0 ? v : null;
      } catch (e) { return null; }
    };
    const a = read([]);
    const b = read(["-H", "1024"]);
    try { fs.unlinkSync(wav); } catch (e) {}
    if (a && b && Math.abs(a - b) / Math.max(a, b) < 0.05) return Math.round((a + b) / 2);
    return null; // unstable → don't trust
  } catch (e) { return null; }
}

function processSong(folder) {
  const songDir = path.join(SONGS_DIR, folder);
  const metaPath = path.join(songDir, "meta.json");
  const choproPath = path.join(songDir, "song.chopro");
  if (!fs.existsSync(metaPath) || !fs.existsSync(choproPath)) return { status: "skip", reason: "no meta/chopro" };
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch { return { status: "skip", reason: "bad meta" }; }

  const chopro = fs.readFileSync(choproPath, "utf-8");
  const verdict = { folder, metaBpm: meta.bpm, bpmSource: meta.bpm_source };

  // 1. LRCLIB-derived
  const artist = meta.artist || "";
  const title = meta.title || folder;
  return httpGetJson(LRCLIB_BASE, `/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`)
    .then((d) => {
      if (d && d.syncedLyrics) {
        const lrc = parseLRC(d.syncedLyrics);
        const pairs = matchPairs(choproBarPairs(chopro), lrc);
        const derived = deriveBpm(pairs);
        verdict.lrcDuration = d.duration;
        verdict.lrcBpm = derived;
        verdict.matchedPairs = pairs.length;
        if (derived) {
          // gpif is trusted; LRCLIB-derived beats meta when they disagree.
          const agreeWithMeta = meta.bpm && Math.abs(meta.bpm - derived) / derived <= 0.08;
          verdict.newBpm = derived;
          verdict.newSource = "verified";
          verdict.verified = true;
          if (!agreeWithMeta) verdict.note = `meta was ${meta.bpm} (${meta.bpm_source}) → corrected to ${derived}`;
          return writeMeta(metaPath, meta, derived, "verified", d.duration, true, { note: verdict.note, lrcBpm: derived, matchedPairs: pairs.length });
        }
      }
      // 2. gpif fallback
      if (meta.bpm_source === "gpif" && meta.bpm) {
        verdict.newBpm = meta.bpm;
        verdict.newSource = "gpif";
        verdict.verified = true;
        return writeMeta(metaPath, meta, meta.bpm, "gpif", d && d.duration, true, { note: "gpif trusted" });
      }
      // 3. aubio fallback
      const audio = path.join(AUDIO_DIR, folder, "full.mp3");
      if (fs.existsSync(audio)) {
        const abpm = aubioBpm(audio);
        verdict.aubioBpm = abpm;
        if (abpm) {
          verdict.newBpm = abpm;
          verdict.newSource = "aubio-verified";
          verdict.verified = true;
          return writeMeta(metaPath, meta, abpm, "aubio-verified", d && d.duration, true, { note: "aubio stable fallback", aubioBpm: abpm });
        }
      }
      verdict.verified = false;
      verdict.note = "no reliable BPM source";
      return writeMeta(metaPath, meta, meta.bpm, meta.bpm_source, d && d.duration, false, { note: "no reliable BPM source" });
    })
    .catch((e) => ({ status: "error", reason: e.message }));
}

function writeMeta(metaPath, meta, bpm, source, duration, verified, extra) {
  const res = Object.assign({ bpm, bpm_source: source, lrc_duration_sec: duration, bpm_verified: verified }, extra || {});
  if (isDryRun) return { status: "dry", ...res };
  meta.bpm = bpm;
  meta.bpm_source = source;
  meta.bpm_verified = verified;
  if (duration) meta.lrc_duration_sec = duration;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  return { status: "ok", ...res };
}

async function main() {
  let folders = fs.readdirSync(SONGS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  if (singleSong) {
    if (!folders.includes(singleSong)) { console.error(`Song "${singleSong}" not found`); process.exit(1); }
    folders = [singleSong];
  }

  let ok = 0, unverified = 0, skip = 0, dry = 0;
  const unverifiedList = [];
  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    const r = await processSong(folder);
    r.folder = folder;
    if (r.status === "ok") { ok++; }
    else if (r.status === "dry") { dry++; console.log(`  (dry) ${folder}: bpm=${r.bpm} src=${r.bpm_source} verified=${r.bpm_verified}${r.note ? " — " + r.note : ""}`); }
    else if (r.status === "skip") { skip++; }
    else { unverified++; unverifiedList.push({ folder, note: r.note || r.reason }); console.log(`  ✗ ${folder}: ${r.note || r.reason}`); }
    process.stdout.write(`\r\x1b[K  ${i + 1}/${folders.length} verified=${ok} unverified=${unverified}`);
    if (i < folders.length - 1) await new Promise((r) => setTimeout(r, REQ_DELAY_MS));
  }
  process.stdout.write("\n");
  console.log(`\nDone. verified=${ok}${isDryRun ? " (dry)" : ""} unverified=${unverified} skipped=${skip}`);
  if (unverifiedList.length) {
    console.log("\nUnverified songs (need manual attention):");
    unverifiedList.forEach((u) => console.log(`  - ${u.folder}: ${u.note || ""}`));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
