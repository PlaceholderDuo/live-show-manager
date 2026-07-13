#!/usr/bin/env node
// Fetch time-synced lyrics from LRCLIB, convert timestamps to @bar=N
// annotations in song.chopro files. Bar = time_s * bpm / (beatsPerBar * 60) + 1.
//
// Usage: node tools/lrc-to-bars.js [--all] [--song "Song Name"]
//   --all          Process every song in ~/ReaperSongs (with 1.1s delay between)
//   --song "Name"  Process a single song by folder name
//   (no flags)     Interactive picker for un-annotated songs

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SONGS_DIR = path.join(os.homedir(), "ReaperSongs");
const LRCLIB_BASE = "lrclib.net";
const REQ_DELAY_MS = 1500;

function httpGetJson(host, path, retries) {
  if (retries === undefined) retries = 2;
  return new Promise((resolve, reject) => {
    const opts = { hostname: host, path, method: "GET", headers: { "User-Agent": "LiveShowManager/1.0" } };
    const req = https.request(opts, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error("JSON parse error: " + body.slice(0, 100))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  }).catch(e => {
    if (retries > 0) {
      const wait = 3000 * (3 - retries);
      console.log(`    Retry in ${wait}ms (${retries} left, ${e.message})`);
      return new Promise(r => setTimeout(r, wait)).then(() => httpGetJson(host, path, retries - 1));
    }
    throw e;
  });
}

function parseLRC(text) {
  if (!text) return [];
  const re = /^\[(\d{2}):(\d{2})[.:](\d{2,3})\]\s*(.*)/gm;
  const lines = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const mins = parseInt(m[1], 10);
    const secs = parseInt(m[2], 10);
    const ms = parseInt(m[3].padEnd(3, "0"), 10);
    const time = mins * 60 + secs + ms / 1000;
    const raw = m[4].trim();
    if (raw) lines.push({ time, text: raw });
  }
  return lines;
}

function stripChords(line) {
  return line
    .replace(/\[.*?\]/g, "")
    .replace(/@\w+=\S+/g, "")
    .replace(/\s*\(keep strumming\)\s*/gi, "")
    .replace(/\s*\(x\s*\d+\)\s*/gi, "")
    .trim();
}

function isDirective(line) {
  return /^\{/.test(line.trimStart());
}

function isBareChord(line) {
  const s = line.trim();
  if (!s) return false;
  if (/^[A-Za-z0-9#bm]+(?:\s*\/[A-Za-z0-9#b]+)?(?:\s+[A-Za-z0-9#bm]+(?:\s*\/[A-Za-z0-9#b]+)?)*$/.test(s)) {
    // Heuristic: if every "word" looks like a chord name, it's a bare chord line
    const words = s.split(/\s+/);
    const chordLike = words.filter(w => /^[A-G][#b]?(?:m|dim|aug|sus[24]|add\d+|7b?9?|maj7?|dim7?|aug7?|6|9|11|13)?(?:\/[A-G][#b]?)?$/.test(w));
    return chordLike.length >= words.length * 0.7;
  }
  return false;
}

function isNonLyric(line) {
  const s = stripChords(line).toLowerCase();
  const nonLyric = [
    "song:", "artist:", "tuning:", "capo", "tabbed by",
    "standard", "no chords", "let ring", "palm mute",
    "slide", "bend", "hammer", "pull-off", "riff",
    "intro", "interlude", "outro", "instrumental",
    "solo:", "lead:", "fill",
  ];
  return nonLyric.some(k => s.startsWith(k)) || /^[xX✕✗]+$/.test(s) || isDirective(line);
}

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/['’"“”`]/g, "")
    .replace(/[-–—]/g, "")        // remove hyphens — syllable-joins fragments
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  // Condensed — strip all spaces for syllable-fragment matching
  const condensedA = na.replace(/\s+/g, "");
  const condensedB = nb.replace(/\s+/g, "");
  if (condensedA.length > 4 && condensedB.length > 4) {
    if (condensedA.includes(condensedB) || condensedB.includes(condensedA)) return 0.85;
  }
  // Word overlap
  const wa = na.split(/\s+/);
  const wb = nb.split(/\s+/);
  const common = wa.filter(w => wb.includes(w)).length;
  return common / Math.max(wa.length, wb.length);
}

function timeToBar(timeS, bpm, beatsPerBar) {
  if (!bpm || bpm <= 0) return null;
  if (!beatsPerBar || beatsPerBar <= 0) beatsPerBar = 4;
  return Math.floor(timeS * bpm / (beatsPerBar * 60)) + 1;
}

function tryMatch(chordproPlain, chordproOrig, lrcLines) {
  const matches = [];
  let lrcIdx = 0;
  for (let ci = 0; ci < chordproPlain.length; ci++) {
    const cpText = chordproPlain[ci].text;
    if (!cpText) continue;
    if (isNonLyric(chordproOrig[ci].line) || isBareChord(chordproOrig[ci].line)) continue;
    let bestScore = 0.5;
    let bestLrc = null;
    let bestOffset = 0;
    for (let li = lrcIdx; li < Math.min(lrcLines.length, lrcIdx + 5); li++) {
      const score = similarity(cpText, lrcLines[li].text);
      if (score > bestScore) {
        bestScore = score;
        bestLrc = lrcLines[li];
        bestOffset = li - lrcIdx;
      }
    }
    if (bestLrc) {
      matches.push({ chordproIdx: chordproPlain[ci].origIndex, lrcLine: bestLrc });
      lrcIdx = lrcLines.indexOf(bestLrc) + 1;
    }
  }
  return matches;
}

function processSongChopro(songDir, meta, lrcLines) {
  const choproPath = path.join(songDir, "song.chopro");
  if (!fs.existsSync(choproPath)) { console.log("  SKIP: no song.chopro"); return false; }
  let content = fs.readFileSync(choproPath, "utf-8");
  if (content.includes("@bar=")) { console.log("  SKIP: already has @bar=N"); return false; }

  const lines = content.split("\n");
  const bpm = meta.bpm || 120;
  const beatsPerBar = (meta.time_sig && meta.time_sig[0]) || 4;

  // Build chordpro plain text array
  const chordproPlain = [];
  const chordproOrig = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const plain = stripChords(raw);
    chordproPlain.push({ text: plain, origIndex: i });
    chordproOrig.push({ line: raw, origIndex: i });
  }

  const matches = tryMatch(chordproPlain, chordproOrig, lrcLines);
  if (matches.length === 0) { console.log("  SKIP: no LRC matches"); return false; }

  // Apply @bar=N from back to front to preserve line indices
  const barPerLine = {};
  for (const m of matches) {
    const bar = timeToBar(m.lrcLine.time, bpm, beatsPerBar);
    if (bar !== null) barPerLine[m.chordproIdx] = { bar, time: m.lrcLine.time, text: m.lrcLine.text };
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    if (barPerLine[i]) {
      const info = barPerLine[i];
      const indent = lines[i].match(/^\s*/)[0];
      const contentLine = lines[i].trim();
      if (contentLine && !isDirective(contentLine) && !contentLine.startsWith("@bar=")) {
        lines[i] = `${indent}@bar=${info.bar}  ${contentLine}`;
      }
    }
  }

  const newContent = lines.join("\n");
  fs.writeFileSync(choproPath, newContent, "utf-8");
  console.log(`  WROTE @bar=N for ${matches.length} lines (${Object.keys(barPerLine).length} unique)`);
  return true;
}

async function processSong(folderName) {
  const songDir = path.join(SONGS_DIR, folderName);
  const metaPath = path.join(songDir, "meta.json");
  if (!fs.existsSync(metaPath)) { console.log(`SKIP ${folderName}: no meta.json`); return; }

  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch { console.log(`SKIP ${folderName}: bad meta.json`); return; }
  if (!meta.title && !meta.artist) { console.log(`SKIP ${folderName}: no title/artist in meta`); return; }

  const artist = encodeURIComponent((meta.artist || "").trim());
  const title = encodeURIComponent((meta.title || folderName).trim());
  const apiPath = `/api/get?artist_name=${artist}&track_name=${title}`;

  console.log(`\n${folderName} — ${meta.artist} "${meta.title}"`);
  console.log(`  Fetching LRCLIB...`);

  let data;
  try {
    data = await httpGetJson(LRCLIB_BASE, apiPath);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    return;
  }
  if (!data) {
    // Fallback: search by query (handles case mismatches, parenthetical notes, etc.)
    const searchQ = encodeURIComponent(`${meta.artist || ""} ${meta.title || folderName}`);
    console.log(`  No direct match, searching...`);
    let searchData;
    try {
      searchData = await httpGetJson(LRCLIB_BASE, `/api/search?q=${searchQ}`);
    } catch (e) { console.log(`  Search error: ${e.message}`); return; }
    if (!searchData || !Array.isArray(searchData) || searchData.length === 0) {
      console.log(`  No LRCLIB entry (direct + search)`);
      return;
    }
    data = searchData[0];
    // Re-fetch by ID to get synced lyrics (search results don't include syncedLyrics)
    try {
      data = await httpGetJson(LRCLIB_BASE, `/api/get/${data.id}`);
    } catch (e) { console.log(`  Fetch by ID error: ${e.message}`); return; }
  }
  if (!data) { console.log(`  No LRCLIB entry`); return; }
  if (!data.syncedLyrics) { console.log(`  No synced lyrics (plain lyrics only)`); return; }

  const lrcLines = parseLRC(data.syncedLyrics);
  if (lrcLines.length < 2) { console.log(`  Too few timed lines (${lrcLines.length})`); return; }
  console.log(`  Got ${lrcLines.length} timed lines`);

  processSongChopro(songDir, meta, lrcLines);
}

async function main() {
  const args = process.argv.slice(2);
  const runAll = args.includes("--all");
  const singleIdx = args.indexOf("--song");
  const singleSong = singleIdx !== -1 && args[singleIdx + 1] ? args.slice(singleIdx + 1).join(" ") : null;

  let songs = fs.readdirSync(SONGS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  if (singleSong) {
    if (!songs.includes(singleSong)) { console.error(`Song "${singleSong}" not found`); process.exit(1); }
    songs = [singleSong];
  } else if (!runAll) {
    // Interactive: show un-annotated songs and ask
    const unannotated = songs.filter(s => {
      const cp = path.join(SONGS_DIR, s, "song.chopro");
      if (!fs.existsSync(cp)) return false;
      const c = fs.readFileSync(cp, "utf-8");
      return !c.includes("@bar=");
    });
    console.log(`\n${unannotated.length} songs without @bar=N annotations.`);
    console.log("Usage: node tools/lrc-to-bars.js --song \"Folder Name\"");
    console.log("       node tools/lrc-to-bars.js --all");
    console.log("       node tools/lrc-to-bars.js [no flags = this help]\n");
    console.log("First 10 un-annotated:");
    unannotated.slice(0, 10).forEach(s => console.log(`  "${s}"`));
    return;
  }

  for (let i = 0; i < songs.length; i++) {
    await processSong(songs[i]);
    if (i < songs.length - 1) await new Promise(r => setTimeout(r, REQ_DELAY_MS));
  }

  console.log(`\nDone. Processed ${songs.length} songs.`);
}

main().catch(e => { console.error(e); process.exit(1); });
