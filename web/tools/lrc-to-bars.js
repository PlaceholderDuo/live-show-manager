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
const isForce = process.argv.includes("--force");

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
  if (content.includes("@time=")) { console.log("  SKIP: already has @time=N"); return false; }

  const lines = content.split("\n");

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
  if (matches.length === 0) {
    // No lyric lines matched — chopro may be empty (e.g., failed UG import).
    // Fallback: use LRCLIB lyrics directly as the chopro content.
    if (lrcLines.length >= 6) {
      console.log(`  No lyric matches — building chopro from LRCLIB lyrics (${lrcLines.length} lines)`);
      return buildChoproFromLRC(songDir, meta, lrcLines);
    }
    console.log("  SKIP: no LRC matches");
    return false;
  }

  // Build per-line timing from LRC matches
  // @time=N stores the LRC timestamp in seconds (ground truth, no BPM dependency)
  // @bar=N also written as legacy fallback for clients that don't support @time yet
  const timePerLine = {};
  const beatsPerBar = (meta.time_sig && meta.time_sig[0]) || 4;
  const bpm = meta.bpm || 120;
  for (const m of matches) {
    const lrcTime = m.lrcLine.time; // seconds from LRC (ground truth)
    const bar = timeToBar(lrcTime, bpm, beatsPerBar);
    timePerLine[m.chordproIdx] = { time: lrcTime, bar: bar, text: m.lrcLine.text };
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    if (timePerLine[i]) {
      const info = timePerLine[i];
      const indent = lines[i].match(/^\s*/)[0];
      let contentLine = lines[i].trim();
      if (contentLine && !isDirective(contentLine)) {
        // Strip existing annotations to replace with fresh ones
        contentLine = contentLine.replace(/^@time\s*=\s*[\d]+\.?\d*\s*/i, "").trim();
        contentLine = contentLine.replace(/^@bar\s*=\s*\d+\s*/i, "").trim();
        if (contentLine) {
          lines[i] = `${indent}@time=${info.time.toFixed(2)} @bar=${info.bar}  ${contentLine}`;
        }
      }
    }
  }

  const newContent = lines.join("\n");
  fs.writeFileSync(choproPath, newContent, "utf-8");
  console.log(`  WROTE @time=N for ${matches.length} lines (${Object.keys(timePerLine).length} unique)`);
  return true;
}

// Build chopro from LRCLIB lyrics when existing chopro is empty or has no lyrics.
// Groups LRC lines into stanzas at blank-line boundaries, labels sections
// heuristically (Verse 1, Chorus 1, etc.), and writes @time=N annotations.
function buildChoproFromLRC(songDir, meta, lrcLines) {
  const choproPath = path.join(songDir, "song.chopro");
  const bpm = meta.bpm || 120;
  const beatsPerBar = (meta.time_sig && meta.time_sig[0]) || 4;
  
  // Group LRC lines into stanzas — split on blank lines or every ~8 lines
  const stanzas = [];
  let current = [];
  for (const lrc of lrcLines) {
    const text = lrc.text.trim();
    // Filter out LRC timestamp artifacts like [02:24.76]
    const cleanText = text.replace(/^\[?\d{2}:\d{2}[.:]\d{2}\]?\s*/, "").trim();
    lrc.text = cleanText || text; // fallback to original if regex clears everything
    
    if (!cleanText) {
      if (current.length > 0) { stanzas.push(current); current = []; }
    } else {
      current.push(lrc);
    }
  }
  if (current.length > 0) stanzas.push(current);
  
  // Split large stanzas on repeated first lines
  const splitStanzas = [];
  for (const stanza of stanzas) {
    if (stanza.length <= 12) { splitStanzas.push(stanza); continue; }
    // Split large stanzas every ~8 lines
    for (let i = 0; i < stanza.length; i += 8) {
      splitStanzas.push(stanza.slice(i, Math.min(i + 8, stanza.length)));
    }
  }
  
  // Heuristic section labeling
  const stanzaSigs = splitStanzas.map(s => s.map(l => l.text.substring(0, 30).toLowerCase()).join("|"));
  const sigCounts = {};
  for (const sig of stanzaSigs) sigCounts[sig] = (sigCounts[sig] || 0) + 1;
  
  const output = [];
  output.push(`{title: ${meta.title || "Unknown"}}`);
  output.push(`{artist: ${meta.artist || ""}}`);
  output.push(`{key: ${meta.key || ""}}`);
  output.push(`{bpm: ${bpm}}`);
  output.push("");
  
  let verseCount = 0, chorusCount = 0;
  
  for (let si = 0; si < splitStanzas.length; si++) {
    const stanza = splitStanzas[si];
    const sig = stanzaSigs[si];
    const repeatCount = sigCounts[sig] || 1;
    
    let type, label;
    if (si === 0) { type = "verse"; verseCount++; label = `Verse ${verseCount}`; }
    else if (repeatCount > 1) { type = "chorus"; chorusCount++; label = `Chorus ${chorusCount}`; }
    else if (si === stanzas.length - 1 && stanza.length <= 2) { type = "outro"; label = "Outro"; }
    else { type = "verse"; verseCount++; label = `Verse ${verseCount}`; }
    
    output.push(`## ${label} @${stanza[0].time.toFixed(2)}`);
    
    for (const lrc of stanza) {
      const bar = timeToBar(lrc.time, bpm, beatsPerBar);
      output.push(`  @time=${lrc.time.toFixed(2)} @bar=${bar}  ${lrc.text}`);
    }
    output.push("");
  }
  
  // Backup existing
  if (fs.existsSync(choproPath)) {
    try { fs.copyFileSync(choproPath, choproPath + ".lrcbak"); } catch {}
  }
  
  fs.writeFileSync(choproPath, output.join("\n"), "utf-8");
  console.log(`  WROTE chopro from LRCLIB: ${stanzas.length} sections, ${lrcLines.length} timed lines`);
  return true;
}

async function processSong(folderName) {
  const songDir = path.join(SONGS_DIR, folderName);
  const metaPath = path.join(songDir, "meta.json");
  if (!fs.existsSync(metaPath)) { console.log(`SKIP ${folderName}: no meta.json`); return; }

  // Skip if already annotated (avoid wasted API call)
  const choproPath = path.join(songDir, "song.chopro");
  if (fs.existsSync(choproPath)) {
    const c = fs.readFileSync(choproPath, "utf-8");
    if (c.includes("@time=")) { console.log(`SKIP ${folderName}: already has @time=N`); return; }
    if (c.includes("@bar=") && !isForce) { console.log(`SKIP ${folderName}: has @bar=N (pass --force to upgrade to @time=N)`); return; }
    if (c.includes("@bar=") && isForce) { console.log(`  Upgrading @bar→@time for ${folderName}...`); }
  }

  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch { console.log(`SKIP ${folderName}: bad meta.json`); return; }
  if (!meta.title && !meta.artist) { console.log(`SKIP ${folderName}: no title/artist in meta`); return; }

  // Normalize title — strip import artifacts like "OFFICIAL ... TABS", "CHORDS (ver N)"
  const rawTitle = meta.title || folderName;
  const cleanTitle = rawTitle
    .replace(/^OFFICIAL\s+/i, "")
    .replace(/\s+TABS$/i, "")
    .replace(/\s+CHORDS\s*\(\s*ver\s+\d+\s*\)$/i, "")
    .replace(/\s+\(ver\s+\d+\)$/i, "")
    .replace(/\s+ver\s+\d+$/i, "")
    .trim();
  const useCleaned = cleanTitle !== rawTitle;

  const artist = encodeURIComponent((meta.artist || "").trim());

  async function tryFetchLRC(titleStr) {
    const titleEnc = encodeURIComponent(titleStr.trim());
    const apiPath = `/api/get?artist_name=${artist}&track_name=${titleEnc}`;
    let data = await httpGetJson(LRCLIB_BASE, apiPath);
    if (!data) {
      const searchQ = encodeURIComponent(`${meta.artist || ""} ${titleStr}`);
      console.log(`  No direct match, searching...`);
      let searchData;
      try {
        searchData = await httpGetJson(LRCLIB_BASE, `/api/search?q=${searchQ}`);
      } catch (e) { return null; }
      if (!searchData || !Array.isArray(searchData) || searchData.length === 0) return null;
      try {
        data = await httpGetJson(LRCLIB_BASE, `/api/get/${searchData[0].id}`);
      } catch (e) { return null; }
    }
    return data;
  }

  console.log(`\n${folderName} — ${meta.artist} "${rawTitle}"`);
  console.log(`  Fetching LRCLIB...`);

  let data = await tryFetchLRC(rawTitle);
  if (!data && useCleaned) {
    console.log(`  Trying cleaned title "${cleanTitle}"...`);
    data = await tryFetchLRC(cleanTitle);
  }
  if (!data) { console.log(`  No LRCLIB entry (direct + search)`); return; }
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
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : null;

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
      return !c.includes("@time=") && !c.includes("@bar=");
    });
    const hasBarsOnly = songs.filter(s => {
      const cp = path.join(SONGS_DIR, s, "song.chopro");
      if (!fs.existsSync(cp)) return false;
      const c = fs.readFileSync(cp, "utf-8");
      return !c.includes("@time=") && c.includes("@bar=");
    });
    const hasTime = songs.filter(s => {
      const cp = path.join(SONGS_DIR, s, "song.chopro");
      if (!fs.existsSync(cp)) return false;
      const c = fs.readFileSync(cp, "utf-8");
      return c.includes("@time=");
    });
    console.log(`\n${hasTime.length} with @time=N (accurate, BPM-independent)`);
    console.log(`${hasBarsOnly.length} with @bar=N only (BPM-dependent, needs upgrade)`);
    console.log(`${unannotated.length} without any timing annotations.`);
    console.log("\nUsage: node tools/lrc-to-bars.js --song \"Folder Name\"");
    console.log("       node tools/lrc-to-bars.js --all              # process un-annotated");
    console.log("       node tools/lrc-to-bars.js --all --force      # also upgrade @bar→@time");
    console.log("       node tools/lrc-to-bars.js [no flags = this help]\n");
    if (hasBarsOnly.length > 0) {
      console.log(`Run with --force to upgrade ${hasBarsOnly.length} @bar-only songs to @time=N.\n`);
    }
    if (unannotated.length > 0) {
      console.log("First 10 un-annotated:");
      unannotated.slice(0, 10).forEach(s => console.log(`  "${s}"`));
    }
    return;
  }

  for (let i = 0; i < songs.length; i++) {
    await processSong(songs[i]);
    if (i < songs.length - 1) await new Promise(r => setTimeout(r, REQ_DELAY_MS));
    if (limit && i + 1 >= limit) { console.log(`\nReached --limit ${limit}. Stopping.`); break; }
  }

  console.log(`\nDone. Processed ${songs.length} songs.`);
}

main().catch(e => { console.error(e); process.exit(1); });
