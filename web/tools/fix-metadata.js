#!/usr/bin/env node
// fix-metadata.js — BPM + Key completion for all songs
// ========================================================
// Sources for BPM:
//   A) Spotify API (if credentials in data/spotify-credentials.json)
//   B) Existing in meta.json (keep if not default 120)
//   C) Mark as "needs_bpm" if all sources fail
//
// Sources for Key:
//   1) Spotify API (same call)
//   2) key-fallback.json (75 manual entries)
//   3) song.chopro {key: Am} directive
//   4) Chord frequency analysis (most common root = likely key)
//
// Usage:
//   node tools/fix-metadata.js                    # all songs
//   node tools/fix-metadata.js --dry-run          # preview only
//   node tools/fix-metadata.js --song "Name"       # single song
//   node tools/fix-metadata.js --spotify           # force Spotify API
//   node tools/fix-metadata.js --limit 5           # test first N

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

const SONGS_DIR = path.join(os.homedir(), "ReaperSongs");
const KEY_FALLBACK_PATH = path.join(os.homedir(), "Music", "iPhoneLiveServer", "data", "key-fallback.json");
const CREDS_PATH = path.join(__dirname, "..", "..", "data", "spotify-credentials.json");
const args = process.argv.slice(2);

const isDryRun = args.includes("--dry-run") || args.includes("--dry");
const useSpotify = args.includes("--spotify");
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

// ── Spotify auth ──
let spotifyToken = null;
let spotifyTokenExpiry = 0;

function getSpotifyCreds() {
  if (!fs.existsSync(CREDS_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(CREDS_PATH, "utf-8")); } catch { return null; }
}

async function spotifyAuth() {
  const creds = getSpotifyCreds();
  if (!creds || !creds.client_id || !creds.client_secret) return false;

  return new Promise((resolve) => {
    const auth = Buffer.from(creds.client_id + ":" + creds.client_secret).toString("base64");
    const opts = {
      hostname: "accounts.spotify.com",
      path: "/api/token",
      method: "POST",
      headers: {
        "Authorization": "Basic " + auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };
    const req = https.request(opts, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        if (res.statusCode !== 200) { resolve(false); return; }
        try {
          const j = JSON.parse(body);
          spotifyToken = j.access_token;
          spotifyTokenExpiry = Date.now() + (j.expires_in || 3600) * 1000;
          resolve(true);
        } catch { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.write("grant_type=client_credentials");
    req.end();
  });
}

async function spotifySearch(artist, title) {
  if (!spotifyToken || Date.now() > spotifyTokenExpiry) {
    const ok = await spotifyAuth();
    if (!ok) return null;
  }

  const q = encodeURIComponent(`track:${title} artist:${artist}`);
  return new Promise((resolve) => {
    https.get({
      hostname: "api.spotify.com",
      path: `/v1/search?q=${q}&type=track&limit=3`,
      headers: { "Authorization": "Bearer " + spotifyToken },
    }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        try {
          const j = JSON.parse(body);
          const tracks = (j.tracks && j.tracks.items) || [];
          if (tracks.length === 0) { resolve(null); return; }
          // Pick best match by name similarity
          const best = tracks[0];
          resolve({ name: best.name, artist: best.artists[0].name, id: best.id });
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

async function spotifyAudioFeatures(trackId) {
  if (!spotifyToken || Date.now() > spotifyTokenExpiry) return null;
  return new Promise((resolve) => {
    https.get({
      hostname: "api.spotify.com",
      path: `/v1/audio-features/${trackId}`,
      headers: { "Authorization": "Bearer " + spotifyToken },
    }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

// ── Key sources ──

function loadKeyFallback() {
  if (!fs.existsSync(KEY_FALLBACK_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(KEY_FALLBACK_PATH, "utf-8"));
    const normalized = {};
    for (const [k, v] of Object.entries(raw)) {
      const idx = k.indexOf("||");
      const title = idx >= 0 ? k.substring(0, idx) : k;
      const artist = idx >= 0 ? k.substring(idx + 2) : "";
      normalized[normalizeKeyMatch(title, artist)] = v;
    }
    return normalized;
  } catch { return {}; }
}

function normalizeKeyMatch(title, artist) {
  const t = (title || "").toUpperCase().replace(/[^A-Z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  const a = (artist || "").toUpperCase().replace(/[^A-Z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  return t + "||" + a;
}

function keyFromFallback(title, artist, fallback) {
  const key = normalizeKeyMatch(title, artist);
  // Exact match
  if (fallback[key]) return fallback[key];
  // Try partial match (title only)
  const titleOnly = (title || "").toUpperCase().replace(/[^A-Z0-9\s]/g, "").replace(/\s+/g, " ").trim() + "||";
  for (const k of Object.keys(fallback)) {
    if (k.startsWith(titleOnly)) return fallback[k];
  }
  return null;
}

function keyFromChopro(folderPath) {
  const choproPath = path.join(folderPath, "song.chopro");
  if (!fs.existsSync(choproPath)) return null;
  try {
    const text = fs.readFileSync(choproPath, "utf-8");
    const m = text.match(/^\{key:\s*(.+?)\}/im);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

function keyFromChords(folderPath) {
  const choproPath = path.join(folderPath, "song.chopro");
  if (!fs.existsSync(choproPath)) return null;
  try {
    const text = fs.readFileSync(choproPath, "utf-8");
    const chordRe = /\[([A-G][b#]?(?:m|dim|aug|sus[24]|add\d+|maj7|maj9|m6|m7|m9|7|9|11|13|6)*(?:\/[A-G][b#]?)?)\]/g;
    const rootCounts = {};
    let match, total = 0;
    while ((match = chordRe.exec(text)) !== null) {
      const root = match[1].match(/^[A-G][b#]?/)[0];
      rootCounts[root] = (rootCounts[root] || 0) + 1;
      total++;
    }
    if (total < 5) return null;
    let bestRoot = null, bestCount = 0;
    for (const [root, count] of Object.entries(rootCounts)) {
      if (count > bestCount) { bestCount = count; bestRoot = root; }
    }
    if (!bestRoot) return null;
    // Heuristic: if minor chords (m) are common, it's likely a minor key
    let minorCount = 0;
    const minorRe = /\[([A-G][b#]?)m/gi;
    while (minorRe.exec(text) !== null) minorCount++;
    if (minorCount > total * 0.25) return bestRoot + "m";
    return bestRoot;
  } catch {}
  return null;
}

// ── Main processor ──

async function fixSong(folderName, fallback) {
  const folderPath = path.join(SONGS_DIR, folderName);
  const metaPath = path.join(folderPath, "meta.json");

  if (!fs.existsSync(metaPath)) return { song: folderName, status: "skip", reason: "no meta.json" };

  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); }
  catch { return { song: folderName, status: "skip", reason: "invalid meta.json" }; }

  const changes = [];
  const original = { bpm: meta.bpm, key: meta.key };

  // ── BPM fix ──
  if (meta.bpm === 120 || !meta.bpm || meta.bpm < 1) {
    let newBpm = null;
    let source = null;

    // Try Spotify
    if (useSpotify && meta.artist && meta.title) {
      const result = await spotifySearch(meta.artist, meta.title);
      if (result && result.id) {
        const features = await spotifyAudioFeatures(result.id);
        if (features && features.tempo > 0) {
          newBpm = Math.round(features.tempo);
          source = "spotify";
        }
      }
    }

    if (newBpm) {
      changes.push({ field: "bpm", from: meta.bpm, to: newBpm, source });
      meta.bpm = newBpm;
      meta.bpm_source = source;
    } else if (meta.bpm === 120) {
      changes.push({ field: "bpm", from: 120, to: "needs_fix", source: null });
      meta.bpm_source = "default";
    }
  } else {
    meta.bpm_source = meta.bpm_source || "existing";
  }

  // ── Key fix ──
  if (!meta.key || meta.key.trim() === "") {
    let newKey = null;
    let keySource = null;

    // 1. key-fallback.json
    newKey = keyFromFallback(meta.title, meta.artist, fallback);
    if (newKey) { keySource = "fallback"; }
    else {
      // 2. chopro directive
      newKey = keyFromChopro(folderPath);
      if (newKey) { keySource = "chopro"; }
      else {
        // 3. Chord analysis
        newKey = keyFromChords(folderPath);
        if (newKey) { keySource = "detected"; }
        else if (useSpotify && meta.artist && meta.title) {
          // 4. Spotify (if not already tried for BPM)
          const result = await spotifySearch(meta.artist, meta.title);
          if (result && result.id) {
            const features = await spotifyAudioFeatures(result.id);
            if (features && features.key >= 0) {
              const pitchMap = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
              newKey = pitchMap[features.key];
              if (features.mode === 0) newKey += "m";
              keySource = "spotify";
            }
          }
        }
      }
    }

    if (newKey) {
      changes.push({ field: "key", from: "\"\"", to: newKey, source: keySource });
      meta.key = newKey;
      meta.key_source = keySource;
    }
  } else {
    meta.key_source = meta.key_source || "existing";
  }

  if (changes.length === 0) return { song: folderName, status: "ok", changes: 0 };

  if (!isDryRun) {
    try {
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    } catch (e) {
      return { song: folderName, status: "error", reason: e.message };
    }
  }

  return { song: folderName, status: isDryRun ? "dry" : "fixed", changes };
}

async function main() {
  const fallback = loadKeyFallback();
  console.log(`Key fallback: ${Object.keys(fallback).length} entries`);

  let folders;
  try {
    folders = fs.readdirSync(SONGS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
      .map(d => d.name);
  } catch (e) {
    console.error("Cannot read", SONGS_DIR, ":", e.message);
    process.exit(1);
  }

  if (specificSong) {
    const slug = specificSong.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const found = folders.find(f => f.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") === slug);
    if (!found) { console.error("Not found:", specificSong); process.exit(1); }
    folders = [found];
  }

  let total = 0, fixed = 0, skipped = 0;
  let bpmFixed = 0, keyFixed = 0;

  for (const folder of folders) {
    const result = await fixSong(folder, fallback);
    total++;

    if (result.status === "fixed" || result.status === "dry") {
      fixed++;
      if (Array.isArray(result.changes)) {
        for (const c of result.changes) {
          if (c.field === "bpm") bpmFixed++;
          if (c.field === "key") keyFixed++;
        }
      }
      const detail = Array.isArray(result.changes)
        ? result.changes.map(c => `${c.field}: ${c.from}→${c.to} (${c.source || "?"})`).join(", ")
        : `${result.changes} changes`;
      const icon = result.status === "dry" ? "○" : "✓";
      process.stdout.write(`\r\x1b[K  ${icon} ${folder.padEnd(45).substring(0, 45)} ${detail}`);
    } else {
      skipped++;
    }

    if (limit && total >= limit) break;
  }

  process.stdout.write("\r\x1b[K\n");
  console.log(`\n${fixed} fixed${isDryRun ? " (dry-run)" : ""}, ${skipped} skipped, ${total} total.`);
  console.log(`  BPM fixes: ${bpmFixed}  |  Key fixes: ${keyFixed}`);

  if (isDryRun && fixed > 0) {
    console.log("\nDRY RUN — no files written. Remove --dry-run to apply.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
