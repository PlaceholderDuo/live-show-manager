#!/usr/bin/env node
// dedupe-songs.js — Song library cleanup & deduplication
// Run: node dedupe-songs.js [--dry-run] [--verbose]
// Identifies OFFICIAL/TABS/CHORDS duplicates and slug-named songs.
// In dry-run mode, reports only. Without, performs renames + deletions.

const fs = require("fs");
const path = require("path");
const os = require("os");

const REAPER_SONGS = path.join(os.homedir(), "ReaperSongs");
const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");

if (!fs.existsSync(REAPER_SONGS)) {
  console.error("ReaperSongs not found:", REAPER_SONGS);
  process.exit(1);
}

const allDirs = fs.readdirSync(REAPER_SONGS, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"));

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function loadMeta(dirName) {
  const p = path.join(REAPER_SONGS, dirName, "meta.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function loadChopro(dirName) {
  const p = path.join(REAPER_SONGS, dirName, "song.chopro");
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf-8");
}

function countAnnotatedLines(chopro) {
  const lines = chopro.split("\n").filter(l => {
    const t = l.trim();
    return t && !/^\{/.test(t);
  });
  return {
    total: lines.length,
    withTime: lines.filter(l => /@time=/.test(l)).length,
    withBar: lines.filter(l => /@bar=/.test(l)).length,
    withChord: lines.filter(l => /\[[A-G]/.test(l)).length,
  };
}

function scoreQuality(dirName) {
  const meta = loadMeta(dirName);
  const chopro = loadChopro(dirName);
  let score = 0;
  if (!meta) return score;

  if (chopro) {
    const counts = countAnnotatedLines(chopro);
    score += counts.total * 1;
    score += counts.withTime * 10;
    score += counts.withBar * 5;
    score += counts.withChord * 3;
  }

  if (meta.bpm && meta.bpm !== 120) score += 20;
  if (meta.title && !/OFFICIAL|TABS|CHORDS/i.test(meta.title)) score += 30;
  if (meta.artist && meta.artist !== "Unknown") score += 10;
  if (meta.duration_bars && meta.duration_bars > 20) score += 5;
  if (meta.sections && meta.sections.length > 0) score += 5;

  return score;
}

function cleanFolderName(name) {
  return name
    .replace(/\bOFFICIAL\s*/gi, "")
    .replace(/\s*TABS\s*/gi, " ")
    .replace(/\s*CHORDS\s*(\(ver\s*\d+\))?\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findDuplicates() {
  const pairs = [];
  const seen = new Set();

  for (const dir of allDirs) {
    const original = dir.name;
    const slug = slugify(original);
    if (seen.has(slug)) continue;

    // Find all directories with the same slug base
    const variants = allDirs.filter(d => {
      const dSlug = slugify(d.name);
      // Strip OFFICIAL/TABS/CHORDS/ver suffixes for comparison
      const cleaned = slugify(cleanFolderName(d.name));
      const baseCleaned = slugify(cleanFolderName(original));
      return d.name !== original && cleaned === baseCleaned;
    });

    if (variants.length > 0) {
      pairs.push({ original, variants: variants.map(v => v.name) });
      seen.add(slug);
      for (const v of variants) seen.add(slugify(v.name));
    }
  }
  return pairs;
}

function findSlugNamed() {
  return allDirs.filter(d => {
    const name = d.name;
    return /^[a-z0-9_]+$/.test(name) && name.includes("_") && name === name.toLowerCase();
  });
}

// Find slug-named songs that have clean-named counterparts
function findSlugDuplicates(slugs) {
  const result = [];
  for (const slugDir of slugs) {
    const cleanTitle = cleanFolderName(slugDir.name.replace(/_/g, " "));
    const matching = allDirs.filter(d => {
      const dClean = cleanFolderName(d.name).toLowerCase();
      return d.name !== slugDir.name && dClean === cleanTitle.toLowerCase();
    });
    if (matching.length > 0) {
      result.push({ slug: slugDir.name, counterparts: matching.map(m => m.name) });
    }
  }
  return result;
}

function separateWordyName(name) {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

let actions = [];
let stats = { kept: 0, merged: 0, deleted: 0, renamed: 0, skipped: 0 };

console.log("=".repeat(60));
console.log("SONG LIBRARY DEDUPLICATION");
console.log("=".repeat(60));
console.log("Mode:", DRY_RUN ? "DRY RUN (no changes)" : "LIVE (will modify files)");
console.log("Songs:", allDirs.length);
console.log();

// ── Phase 1: OFFICIAL/TABS/CHORDS duplicates ──
console.log("PHASE 1: OFFICIAL/TABS/CHORDS duplicates");
console.log("-".repeat(40));

const dupes = findDuplicates();
for (const { original, variants } of dupes) {
  const all = [original, ...variants];
  const scored = all.map(f => ({ name: f, score: scoreQuality(f) }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const rest = scored.slice(1);

  console.log(`\n  Group: "${cleanFolderName(original)}"`);
  for (const s of scored) {
    const marker = s.name === best.name ? "KEEP" : "DEL";
    console.log(`    ${marker}  ${s.name}  (score: ${s.score})`);
    if (VERBOSE) {
      const chopro = loadChopro(s.name);
      if (chopro) {
        const counts = countAnnotatedLines(chopro);
        console.log(`         lines=${counts.total} timed=${counts.withTime} chords=${counts.withChord}`);
      }
    }
  }

  stats.kept++;
  for (const del of rest) {
    actions.push({ type: "delete", dir: del.name, reason: "duplicate of " + best.name });
    stats.deleted++;
  }
}

// ── Phase 2: Slug-named songs ──
console.log("\n\nPHASE 2: Slug-named songs (underscore_separated)");
console.log("-".repeat(40));

const slugs = findSlugNamed();
const slugDupes = findSlugDuplicates(slugs);

for (const { slug, counterparts } of slugDupes) {
  const slugScore = scoreQuality(slug);
  const bestCounterpart = counterparts.map(c => ({ name: c, score: scoreQuality(c) }))
    .sort((a, b) => b.score - a.score)[0];
  
  console.log(`\n  "${slug}" has clean counterpart: "${bestCounterpart.name}"`);
  console.log(`    Slug score: ${slugScore}  |  Clean score: ${bestCounterpart.score}`);
  
  if (bestCounterpart.score >= slugScore) {
    console.log(`    DEL  ${slug}  (clean version is better or equal)`);
    actions.push({ type: "delete", dir: slug, reason: `clean counterpart ${bestCounterpart.name} is better` });
    stats.deleted++;
  } else {
    const cleanTitle = separateWordyName(slug);
    console.log(`    RENAME  ${slug} → "${cleanTitle}"`);
    actions.push({ type: "rename", dir: slug, newName: cleanTitle, reason: "slug → clean name" });
    stats.renamed++;
  }
}

// Lone slugs (no clean counterpart)
const loneSlugs = slugs.filter(s => !slugDupes.find(d => d.slug === s.name));
for (const s of loneSlugs) {
  const cleanTitle = separateWordyName(s.name);
  console.log(`\n  "${s.name}" → "${cleanTitle}"  (no counterpart, rename only)`);
  actions.push({ type: "rename", dir: s.name, newName: cleanTitle, reason: "slug → clean name" });
  stats.renamed++;
}

// ── Phase 3: Standardize remaining folder names ──
console.log("\n\nPHASE 3: Standardize remaining names");
console.log("-".repeat(40));

for (const dir of allDirs) {
  const cleaned = cleanFolderName(dir.name);
  if (cleaned !== dir.name && cleaned.length > 0) {
    // Skip ones already handled in phase 1/2
    if (actions.some(a => a.dir === dir.name)) continue;
    console.log(`  "${dir.name}" → "${cleaned}"`);
    actions.push({ type: "rename", dir: dir.name, newName: cleaned, reason: "standardize name" });
    stats.renamed++;
  }
}

  // ── Execute (or report) ──
console.log("\n\n" + "=".repeat(60));
console.log("SUMMARY");
console.log("=".repeat(60));
console.log(`  Kept:    ${stats.kept}`);
console.log(`  Archived: ${stats.deleted}`);
console.log(`  Renamed: ${stats.renamed}`);
console.log(`  Total actions: ${actions.length}`);
console.log();

if (DRY_RUN) {
  console.log("DRY RUN — no changes made. Run without --dry-run to execute.");
} else {
  console.log("EXECUTING changes...\n");

  const archiveDir = path.join(REAPER_SONGS, "_duplicates");
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  let renamed = 0, archived = 0, errors = 0;

  for (const action of actions) {
    const src = path.join(REAPER_SONGS, action.dir);
    try {
      if (action.type === "rename") {
        const dst = path.join(REAPER_SONGS, action.newName);
        if (fs.existsSync(dst)) {
          console.log(`  SKIP: "${action.dir}" → "${action.newName}" (target exists)`);
          stats.skipped++;
          continue;
        }
        // Update meta.json title
        const metaPath = path.join(src, "meta.json");
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
            meta.title = action.newName;
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
          } catch {}
        }
        fs.renameSync(src, dst);
        console.log(`  RENAMED: "${action.dir}" → "${action.newName}"`);
        renamed++;
      } else if (action.type === "delete") {
        // Archive to _duplicates/ instead of deleting
        const archivePath = path.join(archiveDir, action.dir);
        if (fs.existsSync(archivePath)) {
          // Append timestamp to avoid collision
          const ts = Date.now();
          fs.renameSync(src, path.join(archiveDir, action.dir + "_" + ts));
          console.log(`  ARCHIVED: "${action.dir}" (target existed, appended timestamp)`);
        } else {
          fs.renameSync(src, archivePath);
          console.log(`  ARCHIVED: "${action.dir}" → _duplicates/`);
        }
        archived++;
      }
    } catch (err) {
      console.error(`  ERROR: "${action.dir}": ${err.message}`);
      errors++;
    }
  }

  console.log(`\nDone: ${renamed} renamed, ${archived} archived to _duplicates/, ${errors} errors, ${stats.skipped} skipped`);
}
