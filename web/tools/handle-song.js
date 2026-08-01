#!/usr/bin/env node
// handle-song.js — One-command song lifecycle management
// ========================================================
// Usage:
//   node tools/handle-song.js "Song Name"
//   node tools/handle-song.js --fix          (fix all songs with issues)
//   node tools/handle-song.js --status       (show status of all songs)
//   node tools/handle-song.js --import       (interactive UG import)
//
// Flow:
//   1. Check meta.json + song.chopro exist
//   2. If missing @time=N: run lrc-to-bars
//   3. Verify with verify-lyric-sync
//   4. Show song-status entry
//
// Called from TUI via: child_process.spawn

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TOOLS_DIR = __dirname;
const REAPER_SONGS = path.join(os.homedir(), "ReaperSongs");

const args = process.argv.slice(2);
const showStatus = args.includes("--status");
const fixAll = args.includes("--fix");
const doImport = args.includes("--import");
const specificSong = args.filter(a => !a.startsWith("-")).join(" ");

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", X = "\x1b[0m", B = "\x1b[1m", D = "\x1b[2m";
const CHECK = G + "✓" + X, FAIL = R + "✗" + X;

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function findSong(name) {
  const slug = slugify(name);
  const dirs = fs.readdirSync(REAPER_SONGS, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"));
  return dirs.find(d => slugify(d.name) === slug)?.name || null;
}

function checkSong(folderName) {
  const dir = path.join(REAPER_SONGS, folderName);
  const meta = fs.existsSync(path.join(dir, "meta.json"));
  const chopro = fs.existsSync(path.join(dir, "song.chopro"));
  let hasTiming = false;
  if (chopro) {
    const content = fs.readFileSync(path.join(dir, "song.chopro"), "utf-8");
    hasTiming = /@time\s*=\s*[\d.]+/i.test(content) || /\s@[\d]+\.?\d{1,2}\s*$/.test(content.split("\n")[0]);
  }
  return { meta, chopro, hasTiming };
}

function runLrcToBars(songName) {
  const script = path.join(TOOLS_DIR, "lrc-to-bars.js");
  process.stdout.write(`  Running lrc-to-bars... `);
  try {
    const out = execSync(`node "${script}" --song "${songName}"`, {
      encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"]
    });
    if (out.includes("WROTE @time=") || out.includes("WROTE @time=N")) {
      console.log(CHECK + " Got LRCLIB timing");
      return true;
    }
    console.log(Y + "No matches" + X + " — " + out.split("\n").filter(l => l.includes("SKIP") || l.includes("No LRCLIB") || l.includes("no LRC")).join(" | ").substring(0, 120));
    return false;
  } catch (e) {
    console.log(FAIL + " Error: " + (e.stderr || e.message).toString().substring(0, 80));
    return false;
  }
}

function verifySong(songName) {
  const script = path.join(TOOLS_DIR, "verify-lyric-sync.js");
  try {
    const out = execSync(`node "${script}" --song "${songName}" 2>/dev/null`, {
      encoding: "utf-8", timeout: 5000
    });
    // Parse the coverage line
    const covMatch = out.match(/(\d+)\/(\d+)\s+annotated/);
    if (covMatch) {
      const timed = parseInt(covMatch[1]);
      const total = parseInt(covMatch[2]);
      const pct = total > 0 ? Math.round(timed / total * 100) : 0;
      return { timed, total, pct };
    }
  } catch {}
  return null;
}

function handleSong(name) {
  const found = findSong(name);
  if (!found) {
    console.log(`${FAIL} Song "${name}" not found in ReaperSongs.`);
    return false;
  }

  console.log(`\n${B}════ ${found} ════${X}`);
  
  const status = checkSong(found);
  console.log(`  meta.json: ${status.meta ? CHECK : FAIL}`);
  console.log(`  song.chopro: ${status.chopro ? CHECK : FAIL}`);
  console.log(`  @time=N: ${status.hasTiming ? CHECK : FAIL}`);

  if (!status.meta) {
    console.log(`\n  ${Y}No meta.json — need to import this song first.${X}`);
    console.log(`  ${D}Run: node tools/ug-import.js --ids "TAB_ID"${X}`);
    return false;
  }

  if (!status.hasTiming) {
    console.log(`\n  ${B}Fetching timing from LRCLIB...${X}`);
    const ok = runLrcToBars(found);
    if (ok) {
      // Verify after fetch
      const v = verifySong(found);
      if (v) {
        console.log(`  Verify: ${v.pct >= 80 ? CHECK : Y + "⚠" + X} ${v.timed}/${v.total} lines (${v.pct}%)`);
      }
    }
  } else {
    const v = verifySong(found);
    if (v) {
      console.log(`  Verify: ${v.pct >= 80 ? CHECK : Y + "⚠" + X} ${v.timed}/${v.total} lines (${v.pct}%)`);
    }
  }

  return true;
}

// ── Main ──
if (showStatus) {
  // Print compact status table
  const { execSync: es } = require("child_process");
  try {
    const script = path.join(TOOLS_DIR, "song-status.py");
    es(`python3 "${script}"`, { encoding: "utf-8", stdio: "inherit", timeout: 10000 });
  } catch {}
  process.exit(0);
}

if (doImport) {
  console.log(`${B}Launching UG import...${X}`);
  console.log(`${D}Run manually: node tools/ug-import.js${X}`);
  process.exit(0);
}

if (fixAll) {
  const script = path.join(TOOLS_DIR, "lrc-to-bars.js");
  console.log(`${B}Running lrc-to-bars --all...${X}`);
  try {
    execSync(`node "${script}" --all`, { encoding: "utf-8", stdio: "inherit", timeout: 600000 });
  } catch (e) {
    console.error(`${FAIL} Error: ${e.message}`);
  }
  process.exit(0);
}

if (specificSong) {
  handleSong(specificSong);
} else {
  console.log("Usage: node tools/handle-song.js \"Song Name\"");
  console.log("       node tools/handle-song.js --status");
  console.log("       node tools/handle-song.js --fix");
}
