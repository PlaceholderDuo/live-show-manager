#!/usr/bin/env node
// migrate-to-atime.js — Convert @bar=N annotations to @time=N
// =============================================================
// For songs that have @bar=N but no @time=N, computes @time from bar position
// using the song's BPM:  time = (bar - 1) * beatsPerBar * 60 / bpm
//
// This maintains the SAME accuracy as the existing @bar=N format, but eliminates
// the BPM dependency on the HUD side (the HUD compares position seconds directly
// against @time seconds). When lrc-to-bars.js --force is run later (after LRCLIB
// comes back up), the @time values will be replaced with ground-truth LRC timestamps.
//
// Usage:
//   node tools/migrate-to-atime.js                   # all @bar-only songs
//   node tools/migrate-to-atime.js --song "Name"      # single song
//   node tools/migrate-to-atime.js --dry-run          # preview only
//   node tools/migrate-to-atime.js --limit 5          # test first N songs
//
// SAFE: will NOT overwrite existing @time=N values.
// SAFE: backs up each song.chopro as song.chopro.bak before writing.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const SONGS_DIR = path.join(os.homedir(), "ReaperSongs");
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
  return parts.length > 0 ? parts.join(" ") : null;
})();
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : null;

function slugify(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function processSong(folderName) {
  const folderPath = path.join(SONGS_DIR, folderName);
  const metaPath = path.join(folderPath, "meta.json");
  const choproPath = path.join(folderPath, "song.chopro");

  if (!fs.existsSync(metaPath)) return { status: "skip", reason: "no meta.json" };
  if (!fs.existsSync(choproPath)) return { status: "skip", reason: "no song.chopro" };

  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); }
  catch { return { status: "skip", reason: "invalid meta.json" }; }

  let content = fs.readFileSync(choproPath, "utf-8");

  if (content.includes("@time=")) return { status: "skip", reason: "already has @time=N" };
  if (!content.includes("@bar=")) return { status: "skip", reason: "no @bar=N to migrate" };

  const bpm = meta.bpm || 120;
  const beatsPerBar = (meta.time_sig && meta.time_sig[0]) || 4;
  const lines = content.split("\n");
  let modified = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const barMatch = raw.match(/@bar\s*=\s*(\d+)/i);
    if (!barMatch) continue;

    const bar = parseInt(barMatch[1], 10);
    if (bar <= 0) continue;

    const time = ((bar - 1) * beatsPerBar * 60) / bpm;
    const timeStr = time.toFixed(2);

    // Skip if the line is a directive
    if (/^\{/.test(raw.trimStart())) continue;

    // Prepend @time=N, replace old @bar location
    const indent = raw.match(/^\s*/)[0];
    const contentLine = raw.trim().replace(/^@bar\s*=\s*\d+\s*/i, "").trim();

    if (contentLine) {
      lines[i] = `${indent}@time=${timeStr} @bar=${bar}  ${contentLine}`;
      modified++;
    }
  }

  if (modified === 0) return { status: "skip", reason: "no matching lines found" };

  if (isDryRun) {
    return { status: "dry", modified };
  }

  // Backup original
  try { fs.copyFileSync(choproPath, choproPath + ".bak"); } catch {}

  fs.writeFileSync(choproPath, lines.join("\n"), "utf-8");
  return { status: "ok", modified, bpm };
}

function main() {
  let folders;
  try {
    folders = fs.readdirSync(SONGS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith("."))
      .map(d => d.name);
  } catch (e) {
    console.error("Cannot read", SONGS_DIR, ":", e.message);
    process.exit(1);
  }

  if (specificSong) {
    const slug = slugify(specificSong);
    const found = folders.find(f => slugify(f) === slug);
    if (!found) { console.error("Not found:", specificSong); process.exit(1); }
    folders = [found];
  }

  let total = 0, migrated = 0, skipped = 0;
  const results = [];

  for (const folder of folders) {
    const result = processSong(folder);
    results.push({ song: folder, ...result });
    total++;

    if (result.status === "ok") {
      migrated++;
      process.stdout.write(`\r\x1b[K  ✓ ${folder.padEnd(45).substring(0, 45)} @time=N ×${result.modified} lines (BPM=${result.bpm})`);
    } else if (result.status === "dry") {
      migrated++;
      process.stdout.write(`\r\x1b[K  ○ ${folder.padEnd(45).substring(0, 45)} would add ×${result.modified} @time=N (dry)`);
    } else {
      skipped++;
    }

    if (limit && total >= limit) break;
  }

  process.stdout.write("\r\x1b[K\n");
  console.log(`${migrated} migrated${isDryRun ? " (dry-run)" : ""}, ${skipped} skipped, ${total} total.\n`);

  if (isDryRun && migrated > 0) {
    console.log("DRY RUN — no files written. Remove --dry-run to apply.");
  }

  const noBar = results.filter(r => r.reason === "no @bar=N to migrate");
  if (noBar.length > 0 && noBar.length <= 20) {
    console.log("Songs without @bar=N to migrate:");
    noBar.forEach(r => console.log(`  - ${r.song}`));
  }
}

main();
