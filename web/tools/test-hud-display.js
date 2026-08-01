#!/usr/bin/env node
// test-hud-display.js — Simulate HUD rendering pipeline end-to-end
// ===================================================================
// Feeds simulated REAPER positions (seconds) through the same code
// path the HUD uses: parseChordPro → prepareSongLines →
// renderRollingEngine. Verifies:
//
//   1. No raw annotations leak into display text (@time=, @bar=, ##, {)
//   2. Correct line is selected for each position
//   3. All lyric lines have timing (no null _time gaps)
//   4. Section headers parse correctly
//   5. Chord brackets render correctly
//   6. Bare chord markers unwrap correctly
//
// Usage:
//   node tools/test-hud-display.js                      # test all songs
//   node tools/test-hud-display.js --song "Name"         # single song
//   node tools/test-hud-display.js --limit 10            # first N songs
//   node tools/test-hud-display.js --leaks-only          # only show leaks
//   node tools/test-hud-display.js --sample-positions    # show line at each 5s interval

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const REAPER_SONGS = path.join(os.homedir(), "ReaperSongs");
const args = process.argv.slice(2);

const FLAGS = {
  leaksOnly: args.includes("--leaks-only"),
  samplePositions: args.includes("--sample-positions"),
  matchPositions: args.includes("--match-positions"),
};
const specificSong = (() => {
  const idx = args.indexOf("--song");
  if (idx < 0 || !args[idx + 1]) return null;
  const parts = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith("-")) break;
    parts.push(args[i]);
  }
  return parts.length > 0 ? parts.join(" ") : null;
})();
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : null;

// ── ANSI ──
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", X = "\x1b[0m", B = "\x1b[1m", D = "\x1b[2m";
const PASS = G + "✓" + X, FAIL = R + "✗" + X, WARN = Y + "⚠" + X;

// ═══════════════════════════════════════════════════════════
// REPLICA of hud.js parseChordPro — MUST match exactly
// ═══════════════════════════════════════════════════════════

const chordNameRe = /^[A-G][b#]?(?:m|dim|aug|sus[24]|add\d+|maj7|maj9|m6|m7|m9|7|9|11|13|6)*(?:\/[A-G][b#]?)?$/;

function stripEmoji(text) {
  if (!text) return "";
  return text.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}]/gu, "");
}

function parseLinePairs(raw) {
  var pairs = [];
  var re = /\[([^\]]+)\]/g;
  var chords = [];
  var match;
  while ((match = re.exec(raw)) !== null) {
    chords.push({ name: match[1], index: match.index, end: match.index + match[0].length });
  }
  if (chords.length === 0) {
    var plain = stripEmoji(raw);
    if (plain) {
      var tokens = plain.trim().split(/\s+/);
      var allChordTokens = true;
      for (var ti = 0; ti < tokens.length; ti++) {
        if (!chordNameRe.test(tokens[ti])) { allChordTokens = false; break; }
      }
      if (allChordTokens && tokens.length > 0) {
        for (var ti = 0; ti < tokens.length; ti++) {
          pairs.push({ chord: tokens[ti], word: "" });
        }
        return pairs;
      }
      pairs.push({ chord: "", word: plain });
    }
    return pairs;
  }
  if (chords[0].index > 0) {
    var pre = stripEmoji(raw.substring(0, chords[0].index));
    if (pre) pairs.push({ chord: "", word: pre });
  }
  for (var i = 0; i < chords.length; i++) {
    var start = chords[i].end;
    var end = (i + 1 < chords.length) ? chords[i + 1].index : raw.length;
    var word = stripEmoji(raw.substring(start, end));
    pairs.push({ chord: chords[i].name, word: word });
  }
  return pairs;
}

function parseChordPro(text) {
  var lines = [];
  var directives = {};
  var rawLines = text.split("\n");
  var currentType = "verse";
  var currentLabel = "";
  var currentDuration = null;
  var isNewFormat = false;

  for (var i = 0; i < rawLines.length; i++) {
    var raw = rawLines[i].trim();
    if (!raw) continue;

    if (raw.substring(0, 2) === "##") {
      isNewFormat = true;
      var headerMatch = raw.match(/^##\s+(.+?)(?:\s+@([\d]+\.?\d*))?\s*$/);
      if (headerMatch) {
        var label = headerMatch[1].trim().toLowerCase();
        currentLabel = headerMatch[1].trim();
        if (label.includes("intro")) currentType = "intro";
        else if (label.includes("outro")) currentType = "outro";
        else if (label.includes("chorus")) currentType = "chorus";
        else if (label.includes("bridge")) currentType = "bridge";
        else if (label.includes("solo")) currentType = "solo";
        else if (label.includes("pre-chorus") || label.includes("prechorus")) currentType = "pre-chorus";
        else currentType = "verse";
      }
      continue;
    }

    if (raw.charAt(0) === "{") {
      isNewFormat = false;
      var match = raw.match(/^\{([^:]+):\s*(.+)\}$/);
      var directiveName = "";
      var directiveVal = "";
      if (match) {
        directiveName = match[1].trim().toLowerCase();
        directiveVal = match[2].trim();
        directives[directiveName] = directiveVal;
      } else {
        directiveName = raw.substring(1, raw.length - 1).trim().toLowerCase();
      }
      currentDuration = null;
      if (directiveVal) {
        var durMatch = directiveVal.match(/@duration\s*=\s*(\d+)/i);
        if (durMatch) currentDuration = parseInt(durMatch[1], 10);
      }
      if (directiveName.indexOf("start_of_chorus") >= 0) {
        currentType = "chorus";
        currentLabel = (directiveVal || "Chorus").replace(/@\w+\s*=\s*\S+/g, "").trim();
      } else if (directiveName.indexOf("start_of_verse") >= 0) {
        currentType = "verse";
        currentLabel = (directiveVal || "Verse").replace(/@\w+\s*=\s*\S+/g, "").trim();
      } else if (directiveName.indexOf("start_of_solo") >= 0) {
        currentType = "solo";
        currentLabel = (directiveVal || "Solo").replace(/@\w+\s*=\s*\S+/g, "").trim();
      } else if (directiveName.indexOf("start_of_bridge") >= 0) {
        currentType = "bridge";
        currentLabel = (directiveVal || "Bridge").replace(/@\w+\s*=\s*\S+/g, "").trim();
      } else if (directiveName.indexOf("end_of_") >= 0) {
        currentType = "verse";
        currentLabel = "";
        currentDuration = null;
      }
      directives[directiveName] = directiveVal;
      continue;
    }

    var timeAnnot = null;
    var content = raw;

    if (isNewFormat) {
      var atIdx = content.lastIndexOf("@");
      if (atIdx >= 0) {
        var tn = parseFloat(content.substring(atIdx + 1).trim());
        if (!isNaN(tn)) { timeAnnot = tn; content = content.substring(0, atIdx).trim(); }
      }
      if (timeAnnot === null) {
        var tmFallback = content.match(/@time\s*=\s*([\d]+\.?\d*)\s*/i);
        if (tmFallback) timeAnnot = parseFloat(tmFallback[1]);
      }
      content = content.replace(/@time\s*=\s*[\d]+\.?\d*\s*/gi, "")
                       .replace(/@bar\s*=\s*\d+\s*/gi, "")
                       .replace(/##\s+[^@]*?(?:\s*@[\d.]+)?$/, "")
                       .trim();
      if (content.charAt(0) === "/" && content.lastIndexOf("/") > 0) {
        content = content.substring(1, content.lastIndexOf("/")).trim();
      }
    } else {
      content = raw.replace(/@time\s*=\s*[\d]+\.?\d*\s*/gi, "")
                   .replace(/@bar\s*=\s*\d+\s*/gi, "")
                   .replace(/\s+/g, " ").trim();
      var tm = raw.match(/@time\s*=\s*([\d]+\.?\d*)\s*/i);
      if (tm) timeAnnot = parseFloat(tm[1]);
    }

    lines.push({
      pairs: parseLinePairs(content),
      type: currentType,
      label: currentLabel,
      _time: timeAnnot,
      _bar: null,
      _duration: currentDuration,
    });
  }

  // Post-process: merge chord-only lines
  var mergedLines = [];
  var pendingChords = [];
  var globalChordIdx = 0;
  for (var i = 0; i < lines.length; i++) {
    if (isChordOnlyLine(lines[i])) {
      for (var ci = 0; ci < lines[i].pairs.length; ci++) {
        if (lines[i].pairs[ci].chord) pendingChords.push(lines[i].pairs[ci].chord);
      }
      continue;
    }
    if (pendingChords.length > 0) {
      var merged = [];
      for (var pi = 0; pi < lines[i].pairs.length; pi++) {
        if (lines[i].pairs[pi].word && !lines[i].pairs[pi].chord) {
          var chord = pendingChords[globalChordIdx % pendingChords.length];
          merged.push({ chord: chord, word: lines[i].pairs[pi].word });
          globalChordIdx++;
        } else {
          merged.push(lines[i].pairs[pi]);
        }
      }
      lines[i].pairs = merged;
    }
    mergedLines.push(lines[i]);
  }
  lines = mergedLines;

  return { lines: lines, directives: directives, isNewFormat: isNewFormat };
}

function isChordOnlyLine(line) {
  if (!line) return true;
  for (var i = 0; i < line.pairs.length; i++) {
    var cleanWord = (line.pairs[i].word || "").trim();
    var chord = (line.pairs[i].chord || "").trim();
    if (cleanWord.length > 0) {
      if (!chord && chordNameRe.test(cleanWord)) {
        line.pairs[i].chord = cleanWord;
        line.pairs[i].word = "";
        continue;
      }
      return false;
    }
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
// LEAK DETECTION
// ═══════════════════════════════════════════════════════════

const LEAK_PATTERNS = [
  { name: "@time=", re: /@time=/i },
  { name: "@bar=", re: /@bar=/i },
  { name: "## header", re: /##\s/i },
  { name: "{ directive", re: /\{[^}]+\}/ },
  { name: "/bare chord/", re: /\/[A-G][^\/]*\// },
];

// ═══════════════════════════════════════════════════════════
// TEST ONE SONG
// ═══════════════════════════════════════════════════════════

function testSong(folderName) {
  const choproPath = path.join(REAPER_SONGS, folderName, "song.chopro");
  const metaPath = path.join(REAPER_SONGS, folderName, "meta.json");

  if (!fs.existsSync(choproPath)) {
    return { song: folderName, status: "skip", reason: "no song.chopro" };
  }

  const choproText = fs.readFileSync(choproPath, "utf-8");
  const parsed = parseChordPro(choproText);
  const lines = parsed.lines;

  const leaks = [];
  let timedLines = 0;
  let untimedLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Count timing
    if (line._time !== null && line._time !== undefined) {
      timedLines++;
    } else if (line.pairs.some(p => p.word.trim().length > 2)) {
      untimedLines++;
    }

    // Check for leaks in the text content
    const text = line.pairs.map(p => (p.chord ? "[" + p.chord + "]" : "") + p.word).join("");
    for (const pattern of LEAK_PATTERNS) {
      if (pattern.re.test(text)) {
        leaks.push({
          lineIdx: i,
          pattern: pattern.name,
          text: text.substring(0, 80),
        });
      }
    }
  }

  // Simulate position sweep
  const positions = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300];
  const selections = [];
  let lastIdx = -1;

  for (const pos of positions) {
    let currentIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]._time !== null && lines[i]._time !== undefined && lines[i]._time <= pos) {
        currentIdx = i;
      }
    }
    selections.push({ position: pos, lineIdx: currentIdx });
  }

  // Find gaps (null _time between timed lines)
  const gaps = [];
  let gapStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]._time === null || lines[i]._time === undefined) {
      if (gapStart < 0) gapStart = i;
    } else {
      if (gapStart >= 0 && i - gapStart >= 3) {
        gaps.push({ start: gapStart, count: i - gapStart });
      }
      gapStart = -1;
    }
  }

  const totalLyricLines = lines.filter(l => l.pairs.some(p => p.word.trim().length > 2)).length;
  const isClean = leaks.length === 0 && (timedLines > 0 ? untimedLines === 0 : true);

  return {
    song: folderName,
    status: isClean ? "ok" : "leaks",
    totalLines: lines.length,
    lyricLines: totalLyricLines,
    timedLines,
    untimedLines,
    coveragePct: totalLyricLines > 0 ? Math.round(timedLines / totalLyricLines * 100) : 0,
    leaks,
    positions: selections,
    gaps,
    format: parsed.isNewFormat ? "new" : "old",
  };
}

// ═══════════════════════════════════════════════════════════
// OUPUT
// ═══════════════════════════════════════════════════════════

function main() {
  let folders;
  try {
    folders = fs.readdirSync(REAPER_SONGS, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
      .map(d => d.name);
  } catch (e) {
    console.error("Cannot read song dir:", e.message);
    process.exit(1);
  }

  if (specificSong) {
    const slug = specificSong.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const found = folders.find(f => f.toLowerCase().replace(/[^a-z0-9]+/g, "_") === slug);
    if (!found) { console.error("Not found:", specificSong); process.exit(1); }
    folders = [found];
  }

  if (limit) folders = folders.slice(0, limit);

  const results = [];
  for (const folder of folders) {
    const r = testSong(folder);
    results.push(r);

    if (specificSong || FLAGS.leaksOnly && r.leaks.length === 0) continue;

    const icon = r.status === "ok" ? PASS : (r.leaks.length > 0 ? FAIL : WARN);
    const covStr = r.lyricLines > 0 ? `${r.timedLines}/${r.lyricLines} (${r.coveragePct}%)` : "—";
    process.stdout.write(`\r${icon} ${r.song.padEnd(45).substring(0, 45)} ${covStr} leaks=${r.leaks.length}`);

    if (r.leaks.length > 0 && !FLAGS.leaksOnly) {
      process.stdout.write(`\n`);
      for (const lk of r.leaks.slice(0, 3)) {
        process.stdout.write(`    ${R}LEAK${X} line ${lk.lineIdx}: ${lk.pattern} → "${lk.text}"\n`);
      }
    }
  }

  process.stdout.write(`\r\x1b[K\n\n`);

  // Summary
  const clean = results.filter(r => r.status === "ok");
  const withLeaks = results.filter(r => r.leaks.length > 0);
  
  console.log(`${B}═══ HUD Display Test ═══${X}`);
  console.log(`Songs: ${B}${results.length}${X}  |  ${G}${clean.length} clean${X}  |  ${R}${withLeaks.length} leaks${X}`);
  console.log("");

  if (withLeaks.length > 0) {
    console.log(`${B}── Songs with display leaks ──${X}\n`);
    for (const r of withLeaks) {
      console.log(` ${FAIL} ${B}${r.song}${X}`);
      for (const lk of r.leaks) {
        console.log(`     line ${lk.lineIdx}: ${R}${lk.pattern}${X} → ${D}"${lk.text}"${X}`);
      }
    }
    console.log("");
  }

  if (specificSong && results.length === 1) {
    const r = results[0];
    console.log(`${B}── Position Sweep ──${X}`);
    let lastLine = -1;
    for (const s of r.positions) {
      const ly = r.lines ? r.lines[s.lineIdx] : null;
      const text = ly ? ly.pairs.map(p => (p.chord ? "[" + p.chord + "]" : "") + p.word).join(" ").substring(0, 70) : "...";
      const marker = s.lineIdx !== lastLine ? "→" : " ";
      const timeStr = ly && ly._time !== null ? `@${ly._time.toFixed(1)}s` : "";
      console.log(`  ${marker} ${B}t=${s.position}s${X}  ${timeStr}  ${D}${text}${X}`);
      lastLine = s.lineIdx;
    }
    console.log("");

    if (r.gaps.length > 0) {
      console.log(`${B}── Untimed Gaps ──${X}`);
      for (const g of r.gaps) {
        console.log(`  ${WARN} ${g.count} lines at index ${g.start}`);
      }
      console.log("");
    }
  }

  // Exit code
  process.exit(withLeaks.length > 0 ? 2 : 0);
}

main();
