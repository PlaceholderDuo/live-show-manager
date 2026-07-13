#!/usr/bin/env node
// Clean up UG import folder names and meta.json titles.
// Removes: OFFICIAL/CHORDS/TABS/ (ver N) /lv prefixes and suffixes
// Converts ALL CAPS to Title Case with proper contractions

const fs = require("fs");
const path = require("path");
const os = require("os");

const REAPER_SONGS = path.join(os.homedir(), "ReaperSongs");

// Words that genuinely have "n't" contractions
const CONTRACTIONS = new Set([
  "can't", "won't", "don't", "ain't",
  "couldn't", "wouldn't", "shouldn't",
  "hasn't", "haven't", "hadn't",
  "wasn't", "weren't",
  "doesn't", "didn't",
  "isn't", "aren't",
  "mightn't", "mustn't", "needn't", "daren't",
]);

function fixMangledContractions(s) {
  // Fix "Urgen't" → "Urgent", etc — words where previous script
  // wrongly inserted an apostrophe before "t"
  return s.replace(/\b(\w+)n't\b/gi, (match, prefix) => {
    const lower = match.toLowerCase();
    if (CONTRACTIONS.has(lower)) return match; // keep real contractions
    return prefix + "nt"; // revert: urgEn't → Urgent
  });
}

function toTitleCase(s) {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map(w => {
      if (w.endsWith("n't") && w.length > 3) {
        // Already handled by fixMangled, but keep as safety
        return w[0].toUpperCase() + w.slice(1, -3) + "n't";
      }
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function cleanTitle(name) {
  let t = name;
  // Undo previous mangling first
  t = fixMangledContractions(t);
  // Remove leading numbering
  t = t.replace(/^\(\d+\)\s*/, "");
  // Remove OFFICIAL prefix
  t = t.replace(/^OFFICIAL\s+/i, "");
  // Remove CHORDS/TABS when they appear before (ver N) or at end
  t = t.replace(/\s+(CHORDS|TABS|LV)\s*(\(ver\s+\d+\))?$/i, (m, p1, p2) => p2 ? " " + p2 : "");
  // Remove trailing (ver N) — might remain after CHORDS removal
  t = t.replace(/\s+\(ver\s+\d+\)$/i, "");
  // Second pass: remove any remaining CHORDS/TABS/LV at end (after version cleanup)
  t = t.replace(/\s+(CHORDS|TABS|LV)$/i, "");
  // Convert to title case
  t = toTitleCase(t);
  // Lowercase articles/prepositions (not first/last)
  const words = t.split(" ");
  for (let i = 1; i < words.length - 1; i++) {
    if (/^(And|Or|The|A|An|In|On|At|To|For|Of|By|With|Without|From)$/i.test(words[i])) {
      words[i] = words[i].toLowerCase();
    }
  }
  t = words.join(" ");
  // Fix standalone "i" → "I"
  t = t.replace(/\bi\b/g, "I");
  return t.trim();
}

const dirs = fs.readdirSync(REAPER_SONGS, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

let renamed = 0;
for (const oldName of dirs) {
  const newName = cleanTitle(oldName);
  if (newName !== oldName) {
    const oldPath = path.join(REAPER_SONGS, oldName);
    const newPath = path.join(REAPER_SONGS, newName);
    if (fs.existsSync(newPath)) {
      console.log(`SKIP: "${oldName}" → "${newName}" (exists)`);
      continue;
    }
    fs.renameSync(oldPath, newPath);
    console.log(`RENAMED: "${oldName}" → "${newName}"`);
    const metaPath = path.join(newPath, "meta.json");
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        if (meta.title !== newName) {
          meta.title = newName;
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
        }
      } catch {}
    }
    renamed++;
  }
}

console.log(`\nDone. ${renamed} renamed.`);
