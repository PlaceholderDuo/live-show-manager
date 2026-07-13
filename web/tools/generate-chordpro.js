#!/usr/bin/env node
// Generate song.chopro files from meta.json lyrics + section detection
// 
// Usage:
//   node tools/generate-chordpro.js                    # all songs missing song.chopro
//   node tools/generate-chordpro.js "Song Name"         # single song
//   node tools/generate-chordpro.js --dry-run           # preview only, no writes
//   node tools/generate-chordpro.js --force             # overwrite even existing with chords
//
// SAFE: will NOT overwrite a song.chopro that has real chord brackets [A] [G] etc.
// Use --force to override.

"use strict";

const fs = require("fs");
const path = require("path");

const REAPER_SONGS = path.join(require("os").homedir(), "ReaperSongs");

function detectType(text) {
  const lower = (text || "").toLowerCase();
  if (lower.includes("intro")) return "intro";
  if (lower.includes("solo")) return "solo";
  if (lower.includes("outro")) return "outro";
  if (lower.includes("chorus")) return "chorus";
  if (lower.includes("bridge")) return "bridge";
  if (lower.includes("pre-chorus")) return "pre-chorus";
  if (lower.includes("interlude")) return "interlude";
  if (lower.includes("verse")) return "verse";
  return "verse";
}

function hasRealChords(content) {
  // Check if chopro has inline chord brackets like [A] [G] [Dm] [F#m] etc
  // (not counting directive brackets {start_of_verse} or token brackets [Verse])
  return /\[[A-G][#bmM0-9\/]*\]/.test(content);
}

function cleanLyric(text) {
  return text.replace(/[🎸🗿👍]/gu, "").replace(/^[^a-zA-Z0-9'"\(\[]+/g, "").trim();
}

function isSectionLabel(text) {
  const clean = text.replace(/[🎸🗿👍]/gu, "").trim();
  return clean.length < 30 && (text.includes("🎸") || !clean.includes(" "));
}

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run") || args.includes("--dry");
const isForce = args.includes("--force");
const specificSong = args.find(a => !a.startsWith("--"));

const folders = fs.readdirSync(REAPER_SONGS, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

if (specificSong) {
  const slug = specificSong.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const found = folders.find(f => f.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") === slug);
  if (!found) { console.error("Not found:", specificSong); process.exit(1); }
  processFolder(found);
} else {
  let count = 0;
  for (const folder of folders) {
    if (processFolder(folder)) count++;
  }
  console.log(`\nDone. ${count} song.chopro files generated.`);
}

function processFolder(folder) {
  const folderPath = path.join(REAPER_SONGS, folder);
  const metaPath = path.join(folderPath, "meta.json");
  const choproPath = path.join(folderPath, "song.chopro");

  if (!fs.existsSync(metaPath)) { console.log(`[SKIP] ${folder}: no meta.json`); return false; }

  if (!isForce && fs.existsSync(choproPath)) {
    const existing = fs.readFileSync(choproPath, "utf-8");
    if (hasRealChords(existing)) {
      console.log(`[SKIP] ${folder}: has real chords, use --force to override`);
      return false;
    }
  }

  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); }
  catch { console.log(`[SKIP] ${folder}: invalid meta.json`); return false; }

  if (!meta.lyrics || meta.lyrics.length === 0) { console.log(`[SKIP] ${folder}: no lyrics`); return false; }

  const types = { verse: 0, chorus: 0, intro: 0, solo: 0, bridge: 0, outro: 0 };
  const lines = [];

  for (const entry of meta.lyrics) {
    const type = detectType(entry.text);
    types[type] = (types[type] || 0) + 1;

    if (isSectionLabel(entry.text)) continue;

    const directive = type === "chorus" ? "chorus" : "verse";
    const label = (entry.text.replace(/^[^a-zA-Z0-9]+/, "").trim() || "Verse").substring(0, 50);
    lines.push(`{start_of_${directive}: ${label} ${types[type]}}`);

    const lyric = cleanLyric(entry.text);
    if (lyric) {
      const subLines = lyric.split(/\s*\/\s*/);
      for (const sub of subLines) {
        if (sub.trim()) lines.push(sub.trim());
      }
    }

    lines.push(`{end_of_${directive}}`);
    lines.push("");
  }

  if (lines.length === 0) { console.log(`[SKIP] ${folder}: no lyric lines`); return false; }

  const header = [
    `{title: ${meta.title || folder}}`,
    `{artist: ${meta.artist || ""}}`,
    `{key: ${meta.key || ""}}`,
    "",
  ];
  const content = header.concat(lines).join("\n").trim() + "\n";

  if (isDryRun) {
    const lyricLineCount = lines.filter(l => !l.startsWith("{") && l !== "").length;
    console.log(`[DRY] ${folder} (${lyricLineCount} lyric lines)`);
    return true;
  }

  try {
    fs.writeFileSync(choproPath, content, "utf-8");
    const lyricLineCount = lines.filter(l => !l.startsWith("{") && l !== "").length;
    console.log(`[OK] ${folder} → ${lyricLineCount} lyric lines`);
    return true;
  } catch (e) {
    console.log(`[ERR] ${folder}: ${e.message}`);
    return false;
  }
}