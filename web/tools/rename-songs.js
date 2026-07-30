#!/usr/bin/env node
// rename-songs.js — Convert slug-named folders to Title Case
// =============================================================
// Detects folders with slug names (lowercase_underscore_separated),
// converts to Title Case, handles contractions.
//
// Also detects ALL_CAPS folders and converts them to Title Case.
//
// Usage:
//   node tools/rename-songs.js                   # all songs
//   node tools/rename-songs.js --dry-run         # preview only
//   node tools/rename-songs.js --limit 5          # test first N

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const SONGS_DIR = path.join(os.homedir(), "ReaperSongs");
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run") || args.includes("--dry");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null;

// ── Contraction map ──
const CONTRACTION_MAP = {
  "aint": "Ain't",
  "cant": "Can't",
  "dont": "Don't",
  "wont": "Won't",
  "couldnt": "Couldn't",
  "wouldnt": "Wouldn't",
  "shouldnt": "Shouldn't",
  "hasnt": "Hasn't",
  "havent": "Haven't",
  "hadnt": "Hadn't",
  "wasnt": "Wasn't",
  "werent": "Weren't",
  "doesnt": "Doesn't",
  "didnt": "Didn't",
  "isnt": "Isn't",
  "arent": "Aren't",
  "mightnt": "Mightn't",
  "mustnt": "Mustn't",
  "neednt": "Needn't",
};

const SMALL_WORDS = new Set([
  "and", "or", "the", "a", "an", "in", "on", "at", "to", "for",
  "of", "by", "with", "without", "from", "as", "if", "is", "it",
  "no", "my", "me", "up", "so", "go", "be", "we", "he", "she",
  "not", "but", "nor", "yet", "thru", "into", "onto", "upon",
]);

function slugToTitle(slug) {
  const words = slug.split("_").filter(Boolean);
  if (words.length === 0) return slug;

  const titled = words.map((w, i) => {
    const lower = w.toLowerCase();
    // Handle contractions
    if (CONTRACTION_MAP[lower]) return CONTRACTION_MAP[lower];
    // Capitalize first letter
    if (lower.length <= 2 && i > 0 && i < words.length - 1 && SMALL_WORDS.has(lower)) {
      return lower;
    }
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });

  // Always capitalize first and last word
  if (titled.length > 0) {
    titled[0] = titled[0].charAt(0).toUpperCase() + titled[0].slice(1);
  }
  if (titled.length > 1) {
    const last = titled[titled.length - 1];
    titled[titled.length - 1] = last.charAt(0).toUpperCase() + last.slice(1);
  }

  let result = titled.join(" ");
  // Fix standalone "i" → "I"
  result = result.replace(/\bi\b/g, "I");
  return result.trim();
}

function isSlugNamed(name) {
  return /^[a-z0-9_]+$/.test(name) && name.includes("_") && name === name.toLowerCase();
}

function isAllCaps(name) {
  return name === name.toUpperCase() && /[A-Z]{3,}/.test(name) && name.includes(" ");
}

function allCapsToTitle(name) {
  const words = name.split(" ");
  return words.map((w, i) => {
    const lower = w.toLowerCase();
    if (CONTRACTION_MAP[lower]) return CONTRACTION_MAP[lower];
    if (lower.length <= 2 && i > 0 && i < words.length - 1 && SMALL_WORDS.has(lower)) {
      return lower;
    }
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(" ");
}

// ── Main ──

const dirs = fs.readdirSync(SONGS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
  .map(d => d.name);

let slugCount = 0, capsCount = 0, renamed = 0, skipped = 0;
console.log(`Total song folders: ${dirs.length}`);
console.log("Mode:", isDryRun ? "DRY RUN" : "LIVE");
console.log();

for (const oldName of dirs) {
  let newName = null;
  let reason = "";

  if (isSlugNamed(oldName)) {
    slugCount++;
    newName = slugToTitle(oldName);
    reason = "slug → Title Case";
  } else if (isAllCaps(oldName)) {
    capsCount++;
    newName = allCapsToTitle(oldName);
    reason = "ALL CAPS → Title Case";
  }

  if (!newName) continue;

  if (newName === oldName) {
    skipped++;
    if (isDryRun) console.log(`  KEEP: "${oldName}" (no change needed)`);
    continue;
  }

  const oldPath = path.join(SONGS_DIR, oldName);
  const newPath = path.join(SONGS_DIR, newName);

  if (fs.existsSync(newPath)) {
    console.log(`  SKIP: "${oldName}" → "${newName}" (target exists)`);
    skipped++;
    continue;
  }

  if (isDryRun) {
    console.log(`  RENAME: "${oldName}" → "${newName}"  [${reason}]`);
    renamed++;
  } else {
    try {
      fs.renameSync(oldPath, newPath);
      console.log(`  RENAMED: "${oldName}" → "${newName}"  [${reason}]`);

      // Update meta.json title
      const metaPath = path.join(newPath, "meta.json");
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          if (meta.title !== newName) {
            meta.title = newName;
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
            console.log(`    ↳ meta.json title updated: "${meta.title || oldName}" → "${newName}"`);
          }
        } catch (e) {
          console.log(`    ↳ Could not update meta.json: ${e.message}`);
        }
      }
      renamed++;
    } catch (e) {
      console.error(`  ERROR: "${oldName}" → "${newName}": ${e.message}`);
      skipped++;
    }
  }

  if (limit && renamed >= limit) break;
}

console.log(`\nDone. ${slugCount} slug-named, ${capsCount} ALL CAPS. ${renamed} renamed${isDryRun ? " (dry-run)" : ""}, ${skipped} skipped.`);

if (isDryRun && renamed > 0) {
  console.log("DRY RUN — no changes made. Run without --dry-run to apply.");
}
