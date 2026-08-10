// ═══════════════════════════════════════════════════════════
// timing.js — Shared chopro timing parser (server + HUD)
// ═══════════════════════════════════════════════════════════
// Ground truth: @time=N is LRCLIB-derived real lyric time (seconds). The
// pipeline imported LRCLIB timestamps → @bar=N → @time=N (lossless when
// meta.bpm is correct). The trailing `@N.NN` in some exports is UG noise and
// is NOT trusted.
//
// Strategy:
//   1. @time=N → real lyric time (primary).
//   2. @bar=N (no @time) → convert at meta BPM (fallback).
//   3. Cap every line at a plausible maxTime (spurious late bars / wrong BPM).
//   4. If the song's last lyric time is implausible (> MAX_END), mark it
//      `estimated` so the sync-health UI can flag it (wrong meta BPM).
//   5. Enforce monotonic non-decreasing times (rolling engine requirement).
//
// Exports: Timing.analyze(choproText, metaBpm) →
//   { lines: [{text,time,bar,type,label}], bpm, maxBar, estimated }
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.Timing = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PAT_TIME = /@time\s*=\s*([\d]+\.?\d*)/i;
  var PAT_BAR = /@bar\s*=\s*(\d+)/i;

  // A plausible song never has lyrics past this (seconds). Wrong meta BPM
  // stretches bar-derived times far past this; we cap and flag instead.
  var MAX_END = 600;
  // Cap the effective bar count / duration for the timeline.
  var MAX_BARS = 300;

  function isBareChord(s) {
    var t = (s || "").trim();
    if (!t) return false;
    if (t.charAt(0) === "/" && t.lastIndexOf("/") === t.length - 1) {
      t = t.substring(1, t.length - 1).trim();
    }
    var words = t.split(/\s+/);
    var chordLike = words.filter(function (w) {
      return /^[A-G][#b]?(?:m7?|dim|aug|sus[24]|add\d+|5|7b?9?|maj7?|min7?|dim7?|aug7?|6|9|11|13)?(?:\/[A-G][#b]?)?$/.test(w);
    });
    return chordLike.length >= words.length * 0.7 && chordLike.length > 0;
  }

  function detectTypeFromLabel(label) {
    var lc = (label || "").toLowerCase();
    if (lc.indexOf("intro") >= 0) return "intro";
    if (lc.indexOf("outro") >= 0 || lc.indexOf("ending") >= 0) return "outro";
    if (lc.indexOf("bridge") >= 0) return "bridge";
    if (lc.indexOf("solo") >= 0) return "solo";
    if (lc.indexOf("pre-chorus") >= 0 || lc.indexOf("prechorus") >= 0) return "pre-chorus";
    if (lc.indexOf("interlude") >= 0) return "interlude";
    if (lc.indexOf("chorus") >= 0 || lc.indexOf("chords") >= 0) return "chorus";
    return "verse";
  }

  function parseRaw(choproText) {
    var text = (choproText || "").length > 1048576 ? choproText.substring(0, 1048576) : (choproText || "");
    var rawLines = text.split("\n");
    var currentType = "verse";
    var currentLabel = "";
    var inSection = false;
    var out = [];

    function stripAnnotations(s) {
      return s.replace(/@time\s*=\s*[\d]+\.?\d*/gi, "")
        .replace(/@bar\s*=\s*\d+/gi, "")
        .replace(/@\w+=\S+/g, "")
        .replace(/##\s+[^@]*?(?:\s*@[\d.]+)?$/, "")
        .trim();
    }

    for (var i = 0; i < rawLines.length; i++) {
      var raw = rawLines[i].trim();
      if (!raw) continue;

      if (/^##\s/.test(raw)) {
        inSection = true;
        var label = raw.replace(/^##\s+/, "").replace(/\s+@[\d.]+$/, "").trim() || "Section";
        currentLabel = label;
        currentType = detectTypeFromLabel(label);
        continue;
      }
      if (/^\{/.test(raw)) {
        if (/^\{end_of_/i.test(raw)) { inSection = false; continue; }
        var dm = raw.match(/^\{([^:]+)(?::\s*(.+))?\}$/);
        if (dm) {
          var dname = dm[1].trim().toLowerCase();
          if (dname.indexOf("start_of_") === 0) {
            inSection = true;
            currentType = detectTypeFromLabel(dm[1].replace(/^start_of_/i, "") + " " + (dm[2] || ""));
            currentLabel = (dm[2] || "").replace(/@\w+\s*=\s*\S+/g, "").trim() || currentType;
          }
        }
        continue;
      }
      if (!inSection) { inSection = true; currentLabel = currentLabel || "Section"; }

      var timeAnnot = null, barAnnot = null, m;
      m = raw.match(PAT_TIME); if (m) timeAnnot = parseFloat(m[1]);
      m = raw.match(PAT_BAR); if (m) barAnnot = parseInt(m[1], 10);

      var clean = stripAnnotations(raw);
      if (!clean) continue;
      var lower = clean.toLowerCase();
      if (/^(song|artist|tuning|capo|tabbed|standard|no chords|let ring|palm mute)[:\s]/i.test(lower)) continue;

      out.push({
        text: clean,
        type: currentType,
        label: currentLabel,
        time: timeAnnot,
        bar: barAnnot,
        chordOnly: isBareChord(clean)
      });
    }
    return out;
  }

  function analyze(choproText, metaBpm, durationHint) {
    var meta = (metaBpm && metaBpm > 0) ? metaBpm : 120;
    var raw = parseRaw(choproText);
    var lines = raw.filter(function (e) { return !e.chordOnly; });

    // maxBar: highest @bar (capped), else from last @time at bpm.
    var maxBar = 0;
    for (var n = 0; n < raw.length; n++) if (raw[n].bar && raw[n].bar > maxBar) maxBar = raw[n].bar;
    if (maxBar === 0) {
      var lt = -1;
      for (var n2 = 0; n2 < lines.length; n2++) if (lines[n2].time && lines[n2].time > lt) lt = lines[n2].time;
      if (lt > 0) maxBar = Math.floor(lt * meta / 240) + 1;
    }
    if (maxBar > MAX_BARS) maxBar = MAX_BARS;
    var barTime = Math.min(MAX_END, maxBar * 4 * 60 / meta);
    var maxTime = barTime;
    if (durationHint && durationHint > 0 && durationHint < MAX_END) {
      // lrc_duration_sec is the authoritative real track length from LRCLIB.
      // Trust it over the chopro's @bar values (which can be sparse or corrupt).
      // Allow a small margin (1.15x) for outro fade, but cap at MAX_END.
      maxTime = Math.min(MAX_END, Math.round(durationHint * 1.15));
    }

    // ── Outlier rejection ──
    // The LRCLIB fuzzy-match sometimes writes a few corrupt @time values (e.g.
    // `@time=931.53 reach` onto a line fragment, or onto a section header).
    // A handful of these inflate the "last time" and wrongly flag the whole
    // song as estimated. Drop values far beyond the median cluster so the rest
    // of the (correct) timing stands. Only kicks in when there's a real cluster
    // (>= 4 timed lines) to avoid nuking genuinely short songs.
    var timedLines = lines.filter(function (l) { return l.time !== null; });
    if (timedLines.length >= 4) {
      var timesSorted = timedLines.map(function (l) { return l.time; }).sort(function (a, b) { return a - b; });
      var median = timesSorted[Math.floor(timesSorted.length / 2)];
      var maxKeep = Math.max(MAX_END, median * 3);
      for (var o = 0; o < lines.length; o++) {
        if (lines[o].time !== null && lines[o].time > maxKeep) {
          lines[o].time = null; // corrupt outlier — drop it
          lines[o].bar = null;  // and don't re-derive from @bar either
        }
      }
    }

    // Resolve each line's real time. @time is LRCLIB ground truth; @bar is a
    // BPM-dependent fallback. Cap at maxTime; leave null if nothing.
    var estimated = false;
    var lastResolved = -1;
    for (var j = 0; j < lines.length; j++) {
      var ln = lines[j];
      var t = null;
      if (ln.time !== null && ln.time !== undefined) {
        t = ln.time;
      } else if (ln.bar !== null) {
        t = (ln.bar - 1) * 4 * 60 / meta;
      }
      if (t !== null && isFinite(t)) {
        if (t > maxTime) {
          t = maxTime;          // clamp spurious late bars
          estimated = true;     // something's off (wrong BPM / inflated bars)
        }
        ln.time = Math.round(t * 100) / 100;
        if (ln.time > lastResolved) lastResolved = ln.time;
      } else {
        ln.time = null;
      }
    }

    // A song whose lyrics run past a plausible end is mis-timed (wrong BPM).
    if (lastResolved > MAX_END) estimated = true;

    // Drop local forward spikes (a single line whose time is higher than subsequent valid times)
    for (var sp = 0; sp < lines.length - 1; sp++) {
      if (lines[sp].time !== null) {
        var nextValidTime = null;
        for (var nxt = sp + 1; nxt < lines.length; nxt++) {
          if (lines[nxt].time !== null) {
            nextValidTime = lines[nxt].time;
            break;
          }
        }
        if (nextValidTime !== null && lines[sp].time > nextValidTime + 5) {
          lines[sp].time = null; // drop forward spike
        }
      }
    }

    // Enforce monotonic non-decreasing times.
    var runMax = -Infinity;
    for (var k = 0; k < lines.length; k++) {
      if (lines[k].time === null) continue;
      if (lines[k].time < runMax) lines[k].time = runMax;
      runMax = lines[k].time;
    }

    return { lines: lines, bpm: meta, maxBar: maxBar, estimated: estimated };
  }

  return { analyze: analyze, isBareChord: isBareChord };
});
