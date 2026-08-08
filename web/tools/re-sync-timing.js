#!/usr/bin/env node
// re-sync-timing.js — Re-fetch ground-truth timing from LRCLIB for songs whose
// current @time is untrustworthy (wrong meta BPM / inflated bars / estimated).
// =============================================================
// Background: the library was imported from LRCLIB (real synced lyric seconds)
// → @bar=N → @time=N. The @bar→@time conversion used meta.bpm, which is wrong
// for ~1/3 of songs (aubio auto-detection), stretching those timestamps.
//
// This script re-runs the same LRCLIB pipeline (lrc-to-bars.js --force) but
// ONLY for songs the audit flags, so it's fast and targeted. It overwrites
// each song's @time with LRCLIB's ground-truth timestamps.
//
// Usage:
//   node tools/re-sync-timing.js --dry-run    # preview which songs + counts
//   node tools/re-sync-timing.js              # re-fetch (1.1s/song between calls)
//   node tools/re-sync-timing.js --all        # re-fetch EVERY song (thorough)
//
// Safe: --dry-run writes nothing; each song.chopro is backed up to .bak.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SONGS_DIR = path.join(os.homedir(), "ReaperSongs");
const isDryRun = process.argv.includes("--dry-run");
const runAll = process.argv.includes("--all");

// Reproduce the audit's "needs re-fetch" decision (must match web/public/timing.js).
function needsRefetch(folder) {
  const fp = path.join(SONGS_DIR, folder);
  const chp = path.join(fp, "song.chopro");
  const mp = path.join(fp, "meta.json");
  if (!fs.existsSync(chp) || !fs.existsSync(mp)) return false;
  const ch = fs.readFileSync(chp, "utf-8");
  const meta = JSON.parse(fs.readFileSync(mp, "utf-8"));
  const times = [...ch.matchAll(/@time\s*=\s*([\d.]+)/g)].map((m) => +m[1]);
  if (times.length === 0) return true;
  const last = Math.max(...times);
  const badBpm = meta.bpm_source === "aubio" && (meta.bpm_confidence || 0) < 0.7;
  // estimated = capped at 600 (implausible) or last lyric > 600
  return last > 600 || last < 60 || badBpm || !meta.bpm;
}

const folders = fs.readdirSync(SONGS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("."))
  .map((d) => d.name);

const targets = runAll ? folders : folders.filter(needsRefetch);
const lrcTool = path.join(__dirname, "lrc-to-bars.js");

console.log(`\n${targets.length} song(s) to re-sync from LRCLIB${runAll ? " (--all)" : ""}.`);
if (isDryRun) {
  console.log("DRY RUN — no files will change. Targets:");
  targets.forEach((t) => console.log(`  - ${t}`));
  process.exit(0);
}

(async function run() {
  let ok = 0, skip = 0;
  for (let i = 0; i < targets.length; i++) {
    const name = targets[i];
    try {
      execFileSync("node", [lrcTool, "--song", name, "--force"], { stdio: ["ignore", "ignore", "inherit"] });
      ok++;
      process.stdout.write(`\r\x1b[K  ✓ ${String(i + 1).padStart(3)}/${targets.length} ${name.slice(0, 44)}`);
    } catch (e) {
      skip++;
      console.log(`\n  ✗ ${name} failed: ${(e.message || "").split("\n")[0]}`);
    }
    if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 1100));
  }

  console.log(`\n\nDone. Re-synced ${ok}, failed/skipped ${skip}.`);
  console.log("Re-run the timing audit to confirm the flags cleared.");
})();
