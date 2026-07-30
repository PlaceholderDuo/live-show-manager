#!/usr/bin/env node
// verify-lyric-sync.js — Validate lyric-to-bar alignment for the teleprompter
// ========================================================================
// Checks every song in ~/ReaperSongs for timing accuracy:
//   - BPM sanity (valid range)
//   - @bar=N annotation coverage
//   - Bar monotonic progression (no backward jumps)
//   - Bar range validity (within song duration)
//   - Section alignment (chopro bars vs meta.json section boundaries)
//   - Gap detection (missing annotations between lines)
//
// Usage:
//   node tools/verify-lyric-sync.js                   # all songs
//   node tools/verify-lyric-sync.js --song "Name"      # single song
//   node tools/verify-lyric-sync.js --errors-only      # only songs with problems
//   node tools/verify-lyric-sync.js --missing          # only songs WITHOUT @bar=N
//   node tools/verify-lyric-sync.js --json             # JSON output for automation
//   node tools/verify-lyric-sync.js --summary          # summary only, no per-song detail
//
// Exit code: 0 = all pass, 1 = warnings found, 2 = errors found

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const REAPER_SONGS = path.join(os.homedir(), "ReaperSongs");
const args = process.argv.slice(2);

const FLAGS = {
  json: args.includes("--json"),
  errorsOnly: args.includes("--errors-only"),
  missingOnly: args.includes("--missing"),
  summary: args.includes("--summary"),
  verbose: args.includes("--verbose") || args.includes("-v"),
};
const specificSong = (() => {
  const idx = args.indexOf("--song");
  if (idx < 0 || !args[idx + 1]) return null;
  const nameParts = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith("-")) break;
    nameParts.push(args[i]);
  }
  return nameParts.length > 0 ? nameParts.join(" ") : null;
})();

// ── ANSI ──
const R = "\x1b[31m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const B = "\x1b[34m";
const M = "\x1b[35m";
const W = "\x1b[1m";
const X = "\x1b[0m";
const DIM = "\x1b[2m";

const CHECK = G + "✓" + X;
const WARN = Y + "⚠" + X;
const ERR = R + "✗" + X;
const SKIP = DIM + "–" + X;

// ── Utils ──
function slugify(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function isDirective(line) { return /^\{/.test(line.trimStart()); }

function isBareChord(s) {
  const t = s.trim();
  if (!t) return false;
  const words = t.split(/\s+/);
  const chordLike = words.filter(w =>
    /^[A-G][#b]?(?:m|dim|aug|sus[24]|add\d+|7b?9?|maj7?|dim7?|aug7?|6|9|11|13)?(?:\/[A-G][#b]?)?$/.test(w)
  );
  return chordLike.length >= words.length * 0.7 && chordLike.length > 0;
}

function stripChords(s) { return s.replace(/\[[^\]]+\]/g, "").replace(/@\w+=\S+/g, "").trim(); }

function stripEmoji(s) { return (s || "").replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, ""); }

function similarity(a, b) {
  const na = (a || "").toLowerCase().replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  const nb = (b || "").toLowerCase().replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const wa = na.split(/\s+/), wb = nb.split(/\s+/);
  const common = wa.filter(w => wb.includes(w)).length;
  return common / Math.max(wa.length, wb.length);
}

// ── Parse chopro: extract lyric lines with @time=N / @bar=N ──
function parseChoproLines(text) {
  const lines = text.split("\n");
  const lyricLines = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || isDirective(trimmed)) continue;
    if (isBareChord(trimmed)) continue;

    // Extract @time=N (preferred) and @bar=N (legacy)
    let time = null;
    let bar = null;

    const timeMatch = trimmed.match(/@time\s*=\s*([\d]+\.?\d*)/i);
    if (timeMatch) {
      time = parseFloat(timeMatch[1]);
    }

    const barMatch = trimmed.match(/@bar\s*=\s*(\d+)/i);
    if (barMatch) {
      bar = parseInt(barMatch[1], 10);
    }

    let clean = stripChords(trimmed);
    clean = stripEmoji(clean).trim();
    if (!clean) continue;
    if (/^(song|artist|tuning|capo|tabbed|standard|no chords|let ring|palm mute)[:\s]/i.test(clean.toLowerCase())) continue;

    lyricLines.push({ time, bar, text: clean, raw: trimmed });
  }
  return lyricLines;
}

// ── Parse chopro section boundaries from directives ──
function parseChoproSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let currentType = "verse";
  let currentLabel = "";
  let currentLines = [];
  let inSection = false;

  function flush() {
    if (!inSection || currentLines.length === 0) return;
    sections.push({ type: currentType, label: currentLabel, lineCount: currentLines.length });
    currentLines = [];
    inSection = false;
  }

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith("{")) {
      if (/^\{end_of_/i.test(t)) { flush(); continue; }
      const m = t.match(/^\{([^:]+)(?::\s*(.+))?\}$/);
      if (!m) continue;
      const name = m[1].trim().toLowerCase(), val = (m[2] || "").trim();

      if (name.includes("start_of_verse")) { flush(); currentType = "verse"; currentLabel = val || "Verse"; inSection = true; }
      else if (name.includes("start_of_chorus")) { flush(); currentType = "chorus"; currentLabel = val || "Chorus"; inSection = true; }
      else if (name.includes("start_of_solo")) { flush(); currentType = "solo"; currentLabel = val || "Solo"; inSection = true; }
      else if (name.includes("start_of_bridge")) { flush(); currentType = "bridge"; currentLabel = val || "Bridge"; inSection = true; }
      else if (name.includes("start_of_intro")) { flush(); currentType = "intro"; currentLabel = val || "Intro"; inSection = true; }
      else if (name.includes("start_of_outro")) { flush(); currentType = "outro"; currentLabel = val || "Outro"; inSection = true; }
      else if (name.includes("start_of_pre-chorus") || name.includes("start_of_prechorus")) { flush(); currentType = "pre-chorus"; currentLabel = val || "Pre-Chorus"; inSection = true; }
      else if (name.includes("start_of_interlude")) { flush(); currentType = "interlude"; currentLabel = val || "Interlude"; inSection = true; }
      continue;
    }
    if (inSection) {
      const cleaned = stripEmoji(stripChords(t)).trim();
      if (cleaned) currentLines.push(cleaned);
    }
  }
  flush();

  // Refine types from labels
  for (const s of sections) {
    const ll = (s.label || "").toLowerCase();
    if (ll.includes("intro") && s.type === "verse") s.type = "intro";
    else if (ll.includes("outro") && s.type === "verse") s.type = "outro";
    else if (ll.includes("bridge") && s.type === "verse") s.type = "bridge";
    else if (ll.includes("solo") && s.type === "verse") s.type = "solo";
    else if ((ll.includes("pre-chorus") || ll.includes("prechorus")) && s.type === "verse") s.type = "pre-chorus";
  }

  return sections;
}

// ── Verification result types ──
const OK = "ok";
const WARNING = "warn";
const ERROR = "err";

// ── Verify a single song ──
function verifySong(folderName) {
  const folderPath = path.join(REAPER_SONGS, folderName);
  const metaPath = path.join(folderPath, "meta.json");
  const choproPath = path.join(folderPath, "song.chopro");

  if (!fs.existsSync(metaPath)) {
    return { song: folderName, status: ERROR, checks: [], errors: ["No meta.json"], warnings: [] };
  }
  if (!fs.existsSync(choproPath)) {
    return { song: folderName, status: ERROR, checks: [], errors: ["No song.chopro"], warnings: [] };
  }

  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); }
  catch { return { song: folderName, status: ERROR, checks: [], errors: ["Invalid meta.json"], warnings: [] }; }

  let choproText;
  try { choproText = fs.readFileSync(choproPath, "utf-8"); }
  catch { return { song: folderName, status: ERROR, checks: [], errors: ["Cannot read song.chopro"], warnings: [] }; }

  const checks = [];
  const errors = [];
  const warnings = [];

  const bpm = meta.bpm || 120;
  const timeSig = (meta.time_sig && meta.time_sig[0]) || 4;
  const durationBars = meta.duration_bars || 128;
  const metaLyrics = meta.lyrics || [];
  const metaSectionBars = metaLyrics.filter(e => e.bar != null).map(e => e.bar);

  const lyricLines = parseChoproLines(choproText);
  const choproSections = parseChoproSections(choproText);

  // Count lines with @time=N (gold standard), @bar=N (legacy), or neither
  const hasTime = lyricLines.filter(l => l.time !== null).length;
  const hasBar = lyricLines.filter(l => l.bar !== null).length;
  const annotated = lyricLines.filter(l => l.time !== null || l.bar !== null);
  const annotatedBars = annotated.filter(l => l.bar !== null).map(l => l.bar);
  const annotatedTimes = annotated.filter(l => l.time !== null).map(l => l.time);
  const unannotated = lyricLines.filter(l => l.time === null && l.bar === null);
  const timingFormat = hasTime > 0 ? "@time" : (hasBar > 0 ? "@bar" : "none");

  // ══ 1. BPM sanity ══
  if (bpm < 30 || bpm > 300) {
    errors.push(`BPM=${bpm} — out of range (30–300)`);
    checks.push({ id: "bpm", status: ERROR, detail: `BPM=${bpm} (out of range)` });
  } else if (bpm === 120 && lyricLines.length > 0 && annotatedBars.length >= 3) {
    // 120 is the default placeholder — flag if lyrics exist and it's still 120
    warnings.push("BPM=120 (default placeholder — may be inaccurate)");
    checks.push({ id: "bpm", status: WARNING, detail: "BPM=120 (default)" });
  } else {
    checks.push({ id: "bpm", status: OK, detail: `BPM=${bpm}` });
  }

  // ══ 2. Annotation coverage ══
  const coveragePct = lyricLines.length > 0 ? (annotated.length / lyricLines.length * 100).toFixed(1) : 100;
  const fmtStr = timingFormat === "@time" ? `@time=N (${hasTime} lines)` : timingFormat === "@bar" ? `@bar=N (${hasBar} lines)` : "none";
  if (lyricLines.length === 0) {
    checks.push({ id: "coverage", status: OK, detail: "no lyric lines" });
  } else if (annotated.length === 0) {
    errors.push(`0/${lyricLines.length} lines have timing — lyrics will be estimated, likely out of sync`);
    checks.push({ id: "coverage", status: ERROR, detail: `0/${lyricLines.length} annotated (0%)` });
  } else if (unannotated.length > 0) {
    const pct = parseFloat(coveragePct);
    if (pct < 80) {
      errors.push(`${annotated.length}/${lyricLines.length} lines timed (${coveragePct}%) via ${fmtStr} — significant gaps`);
      checks.push({ id: "coverage", status: ERROR, detail: `${annotated.length}/${lyricLines.length} annotated (${coveragePct}%)` });
    } else {
      warnings.push(`${unannotated.length} lines without timing (${coveragePct}% covered, ${fmtStr})`);
      checks.push({ id: "coverage", status: WARNING, detail: `${annotated.length}/${lyricLines.length} annotated (${coveragePct}%)` });
    }
  } else {
    checks.push({ id: "coverage", status: OK, detail: `${annotated.length}/${lyricLines.length} annotated (100%, ${fmtStr})` });
  }

  // ══ 3. Bar monotonicity ══
  if (annotatedBars.length > 1) {
    let monotonicOk = true;
    const reversals = [];
    for (let i = 1; i < annotatedBars.length; i++) {
      if (annotatedBars[i] < annotatedBars[i - 1]) {
        monotonicOk = false;
        reversals.push(`bar ${annotatedBars[i - 1]}→${annotatedBars[i]} at line ${annotated[i - 1].text.substring(0, 30)}`);
      }
    }
    if (!monotonicOk) {
      errors.push(`Bar values decrease: ${reversals.slice(0, 3).join(", ")}${reversals.length > 3 ? " (+" + (reversals.length - 3) + " more)" : ""}`);
      checks.push({ id: "monotonic", status: ERROR, detail: `${reversals.length} reversals` });
    } else {
      checks.push({ id: "monotonic", status: OK, detail: "increasing" });
    }
  } else {
    checks.push({ id: "monotonic", status: OK, detail: "N/A (< 2 annotations)" });
  }

  // ══ 4. Bar range validity ══
  const maxExpectedBar = durationBars + 16;
  if (annotatedBars.length > 0) {
    const minBar = Math.min(...annotatedBars);
    const maxBar = Math.max(...annotatedBars);
    const outOfRange = annotatedBars.filter(b => b > maxExpectedBar || b < 1);
    if (outOfRange.length > 0) {
      errors.push(`${outOfRange.length} @bar values outside 1–${maxExpectedBar} (song is ${durationBars} bars)`);
      checks.push({ id: "range", status: ERROR, detail: `min=${minBar}, max=${maxBar}, out-of-range: ${outOfRange.length}` });
    } else if (maxBar > durationBars * 1.5 && durationBars > 0) {
      warnings.push(`Last @bar=${maxBar} extends far past duration (${durationBars} bars)`);
      checks.push({ id: "range", status: WARNING, detail: `min=${minBar}, max=${maxBar}, duration=${durationBars}` });
    } else {
      checks.push({ id: "range", status: OK, detail: `min=${minBar}, max=${maxBar}, duration=${durationBars}` });
    }
  } else {
    checks.push({ id: "range", status: OK, detail: "N/A (no annotations)" });
  }

  // ══ 5. First/last bar proximity ══
  if (annotatedBars.length > 0) {
    const firstBar = annotatedBars[0];
    const lastBar = annotatedBars[annotatedBars.length - 1];

    if (firstBar > 10) {
      warnings.push(`First @bar=${firstBar} — missing bars 1–${firstBar - 1} (intro not annotated)`);
      checks.push({ id: "first-bar", status: WARNING, detail: `first=bar ${firstBar} (>10)` });
    } else {
      checks.push({ id: "first-bar", status: OK, detail: `first=bar ${firstBar}` });
    }

    if (durationBars > 0 && lastBar < durationBars - 16) {
      warnings.push(`Last @bar=${lastBar} vs duration ${durationBars} bars — ending may not be annotated`);
      checks.push({ id: "last-bar", status: WARNING, detail: `last=bar ${lastBar} vs ${durationBars}` });
    } else {
      checks.push({ id: "last-bar", status: OK, detail: `last=bar ${lastBar}` });
    }
  } else {
    checks.push({ id: "first-bar", status: OK, detail: "N/A" });
    checks.push({ id: "last-bar", status: OK, detail: "N/A" });
  }

  // ══ 6. Gap detection — unannotated gaps inside annotated sections ══
  if (annotated.length > 0 && unannotated.length > 0) {
    const gaps = [];
    let consecutiveUnannotated = 0;
    let gapStartIdx = -1;
    for (let i = 0; i < lyricLines.length; i++) {
      if (lyricLines[i].time === null && lyricLines[i].bar === null) {
        if (consecutiveUnannotated === 0) gapStartIdx = i;
        consecutiveUnannotated++;
      } else {
        if (consecutiveUnannotated >= 5) {
          const gapLines = lyricLines.slice(gapStartIdx, gapStartIdx + Math.min(consecutiveUnannotated, 3));
          gaps.push(`${consecutiveUnannotated} lines (starts: "${gapLines.map(l => l.text.substring(0, 20)).join(" | ")}")`);
        }
        consecutiveUnannotated = 0;
      }
    }
    if (gaps.length > 0) {
      warnings.push(`Large annotation gaps: ${gaps.slice(0, 2).join("; ")}${gaps.length > 2 ? " (+" + (gaps.length - 2) + " more)" : ""}`);
      checks.push({ id: "gaps", status: WARNING, detail: `${gaps.length} gaps ≥5 lines` });
    } else {
      checks.push({ id: "gaps", status: OK, detail: "no large gaps" });
    }
  } else {
    checks.push({ id: "gaps", status: OK, detail: "N/A" });
  }

  // ══ 7. Section alignment — chopro bar annotations vs meta.json section boundaries ══
  if (metaSectionBars.length > 0 && annotatedBars.length > 0) {
    const misalignments = [];
    for (let si = 0; si < metaSectionBars.length; si++) {
      const metaBar = metaSectionBars[si];
      // Find closest @bar annotation
      let closestDist = Infinity;
      let closestBar = null;
      for (const ab of annotatedBars) {
        const dist = Math.abs(ab - metaBar);
        if (dist < closestDist) { closestDist = dist; closestBar = ab; }
      }
      if (closestDist > 16) {
        misalignments.push(`Section at bar ${metaBar}: nearest @bar=${closestBar} (off by ${closestDist})`);
      }
    }
    if (misalignments.length > 2) {
      errors.push(`Section misalignment: ${misalignments.length} sections >16 bars from nearest annotation`);
      checks.push({ id: "section-alignment", status: ERROR, detail: `${misalignments.length} misaligned sections` });
    } else if (misalignments.length > 0) {
      warnings.push(`Section misalignment: ${misalignments.join("; ")}`);
      checks.push({ id: "section-alignment", status: WARNING, detail: `${misalignments.length} misaligned sections` });
    } else {
      checks.push({ id: "section-alignment", status: OK, detail: `all ${metaSectionBars.length} aligned` });
    }
  } else {
    checks.push({ id: "section-alignment", status: OK, detail: "N/A" });
  }

  // ══ 8. Duplicate @bar values ══
  if (annotatedBars.length > 0) {
    const seen = new Map();
    const dups = [];
    for (const b of annotatedBars) {
      seen.set(b, (seen.get(b) || 0) + 1);
    }
    for (const [b, count] of seen) {
      if (count > 2) dups.push(`bar ${b} ×${count}`);
    }
    if (dups.length > 0) {
      warnings.push(`Duplicate bar values: ${dups.slice(0, 5).join(", ")}`);
      checks.push({ id: "duplicates", status: WARNING, detail: `${dups.length} bars repeated >2 times` });
    } else {
      checks.push({ id: "duplicates", status: OK, detail: "no excessive duplicates" });
    }
  } else {
    checks.push({ id: "duplicates", status: OK, detail: "N/A" });
  }

  // ══ 9. Section count mismatch ══
  if (metaLyrics.length > 0 && choproSections.length > 0) {
    const ratio = choproSections.length / metaLyrics.length;
    if (ratio < 0.4 || ratio > 2.5) {
      warnings.push(`Section mismatch: meta has ${metaLyrics.length} entries, chopro has ${choproSections.length} sections`);
      checks.push({ id: "section-count", status: WARNING, detail: `meta:${metaLyrics.length} vs chopro:${choproSections.length}` });
    } else {
      checks.push({ id: "section-count", status: OK, detail: `meta:${metaLyrics.length}, chopro:${choproSections.length}` });
    }
  } else {
    checks.push({ id: "section-count", status: OK, detail: "N/A" });
  }

  // ══ 10. BPM-bar-annotation self-consistency ══
  // If there are @bar annotations with >3 bars between them, check that the
  // implied lyric density matches the BPM × section structure
  if (annotatedBars.length >= 4) {
    const barDeltas = [];
    for (let i = 1; i < annotatedBars.length; i++) {
      barDeltas.push(annotatedBars[i] - annotatedBars[i - 1]);
    }
    const avgGap = barDeltas.reduce((a, b) => a + b, 0) / barDeltas.length;
    const maxGap = Math.max(...barDeltas);
    if (avgGap > 12) {
      warnings.push(`Sparse annotations: avg ${avgGap.toFixed(1)} bars between annotated lines`);
      checks.push({ id: "density", status: WARNING, detail: `avg gap ${avgGap.toFixed(1)} bars` });
    } else {
      checks.push({ id: "density", status: OK, detail: `avg gap ${avgGap.toFixed(1)} bars` });
    }
    if (maxGap > 30) {
      errors.push(`Annotation gap of ${maxGap} bars — lyrics may jump`);
      checks.push({ id: "max-gap", status: ERROR, detail: `max gap ${maxGap} bars` });
    }
  }

  // Determine overall status
  const hasErrors = errors.length > 0;
  const hasWarnings = warnings.length > 0;
  const status = hasErrors ? ERROR : hasWarnings ? WARNING : OK;

  return {
    song: folderName,
    title: meta.title || folderName,
    artist: meta.artist || "",
    bpm,
    durationBars,
    lyricLineCount: lyricLines.length,
    annotatedCount: annotated.length,
    coveragePct: lyricLines.length > 0 ? parseFloat(coveragePct) : 100,
    timingFormat,
    hasTimeCount: hasTime,
    hasBarCount: hasBar,
    status,
    checks,
    errors,
    warnings,
  };
}

// ── Output formatters ──
function formatJSON(results) {
  console.log(JSON.stringify(results, null, 2));
}

function formatText(results) {
  const total = results.length;
  const errors = results.filter(r => r.status === ERROR);
  const warnings = results.filter(r => r.status === WARNING);
  const ok = results.filter(r => r.status === OK);
  const noAnnotations = results.filter(r => r.annotatedCount === 0 && r.lyricLineCount > 0);
  const withTime = results.filter(r => r.timingFormat === "@time");
  const withBarOnly = results.filter(r => r.timingFormat === "@bar");

  console.log("");
  console.log(`${W}═══ Lyric Sync Verification ═══${X}`);
  console.log(`Songs: ${W}${total}${X}  |  ${G}${ok.length} OK${X}  |  ${Y}${warnings.length} Warn${X}  |  ${R}${errors.length} Err${X}  |  ${M}${noAnnotations.length} No timing${X}`);
  console.log(`Format: ${G}${withTime.length} @time=N${X}  |  ${Y}${withBarOnly.length} @bar=N only${X}  |  ${R}${noAnnotations.length} none${X}`);
  console.log("");

  if (noAnnotations.length > 0 && !FLAGS.errorsOnly) {
    console.log(`${M}${W}── Songs WITHOUT timing annotations (will use estimates — likely out of sync) ──${X}`);
    for (const r of noAnnotations) {
      console.log(`  ${ERR} ${W}${r.song}${X}  ${DIM}${r.bpm} BPM  ${r.lyricLineCount} lines  ${r.durationBars} bars${X}`);
    }
    console.log("");
  }

  if (FLAGS.summary && !FLAGS.errorsOnly) return;

  const showList = FLAGS.errorsOnly
    ? results.filter(r => r.status === ERROR || r.status === WARNING)
    : results.filter(r => r.status === ERROR || r.status === WARNING || r.annotatedCount > 0);

  for (const r of showList) {
    const statusIcon = r.status === ERROR ? ERR : r.status === WARNING ? WARN : CHECK;

    if (FLAGS.missingOnly && r.annotatedCount > 0) continue;

    console.log(`${statusIcon} ${W}${r.song}${X}  ${DIM}${r.artist}${X}`);
    const covPct = r.coveragePct != null ? r.coveragePct.toFixed(0) : "—";
    console.log(`   BPM=${r.bpm}  bars=${r.durationBars}  lines=${r.lyricLineCount}  annotated=${r.annotatedCount}/${r.lyricLineCount} (${covPct}%)`);

    for (const e of r.errors) {
      console.log(`   ${ERR} ${R}${e}${X}`);
    }
    for (const w of r.warnings) {
      console.log(`   ${WARN} ${Y}${w}${X}`);
    }

    if (FLAGS.verbose) {
      for (const c of r.checks) {
        const icon = c.status === ERROR ? ERR : c.status === WARNING ? WARN : CHECK;
        console.log(`       ${icon} ${DIM}${c.id.padEnd(20)} ${c.status.padEnd(5)} ${c.detail}${X}`);
      }
    }

    console.log("");
  }
}

// ── Main ──
function main() {
  let folders;
  try {
    folders = fs.readdirSync(REAPER_SONGS, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map(d => d.name);
  } catch (e) {
    console.error(`${ERR} Cannot read ${REAPER_SONGS}: ${e.message}`);
    process.exit(2);
  }

  if (specificSong) {
    const slug = slugify(specificSong);
    const found = folders.find(f => slugify(f) === slug);
    if (!found) {
      console.error(`${ERR} Song "${specificSong}" not found in ${REAPER_SONGS}`);
      process.exit(1);
    }
    folders = [found];
  }

  const results = [];

  for (const folder of folders) {
    const result = verifySong(folder);
    results.push(result);

    if (!FLAGS.json && !FLAGS.summary && !specificSong) {
      // Show progress for full runs
      const icon = result.status === ERROR ? ERR : result.status === WARNING ? WARN : CHECK;
      if (!FLAGS.errorsOnly || result.status === ERROR || result.status === WARNING) {
        process.stdout.write(`\r${icon} ${result.song.padEnd(50).substring(0, 50)} ${result.annotatedCount}/${result.lyricLineCount} annotated`);
      }
    }
  }

  if (!FLAGS.json) process.stdout.write("\r\x1b[K"); // clear progress line

  if (FLAGS.json) {
    formatJSON(results);
  } else {
    formatText(results);
  }

  // Exit code
  const hasErrors = results.some(r => r.status === ERROR);
  const hasWarnings = results.some(r => r.status === WARNING);
  if (hasErrors) process.exit(2);
  if (hasWarnings) process.exit(1);
  process.exit(0);
}

main();
