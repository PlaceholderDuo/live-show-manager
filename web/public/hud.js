// Live Stage HUD — Professional Conductor Stage Monitor (Version 2 Refined)
// ==========================================================================
// Pure flat high-contrast black/white design. Exactly matches the mockup.
// Left-aligned metadata, white-box bar & beat conductor.
// Center-aligned 3-Line rolling engine with bright yellow chords in brackets.
// Proportional block-based progress timeline. Next song key auto-lookup.

(function () {

  "use strict";

  // ── DOM refs ──
  var $ = function (id) { return document.getElementById(id); };

  var topTitle = $("topTitle");
  var topKey = $("topKey");
  var topBpm = $("topBpm");
  var topNextVal = $("topNextVal");

  var barCounter = $("barCounter");
  var metronomeDot = $("metronomeDot");
  var statusText = $("statusText");

  var currentSectionLabel = $("currentSectionLabel");
  var futureSectionLabel = $("futureSectionLabel");

  // 6-line rolling engine DOM elements
  var linePast3 = $("linePast3");
  var linePast2 = $("linePast2");
  var linePast1 = $("linePast1");
  var linePresent = $("linePresent");
  var lineFuture1 = $("lineFuture1");
  var lineFuture2 = $("lineFuture2");
  var lineEls = [linePast3, linePast2, linePast1, linePresent, lineFuture1, lineFuture2];

  var lyricEngine = $("lyricEngine");
  var soloEngine = $("soloEngine");
  var soloGrid = $("soloGrid");
  var soloProgressFill = $("soloProgressFill");

  var timelineNotches = $("timelineNotches");
  var progressFill = $("progressFill");

  var footerElapsed = $("footerElapsed");
  var footerTotal = $("footerTotal");
  var nextSong = $("nextSong");
  var footerSection = $("footerSection");

  var edgeFlashTop = $("edgeFlashTop");
  var edgeFlashBottom = $("edgeFlashBottom");
  var heartbeatBanner = $("heartbeatBanner");
  var meterRow = $("meterRow");
  var hudNotes = $("hudNotes");
  var notesTimeout = null;

  // ── State ──
  var currentSongId = null;
  var parsedLines = [];
  var parsedDirectives = {};
  var currentNextSongTitle = null;
  var nextSongKey = null;

  var lastBeat = 0;
  var flashTimeout = null;
  var loadingEl = null;

  // ═══════════════════════════════════════════════════════════
  // FIT HUD — Scale everything to fit the browser window
  // ═══════════════════════════════════════════════════════════

  function fitHud() {
    var winH = window.innerHeight;
    // Design target: 1080px viewport → scale 1.0
    var scale = Math.min(1, Math.max(0.35, winH / 1080));
    document.documentElement.style.setProperty('--hud-scale', scale);
  }

  window.addEventListener('resize', fitHud);

  // ═══════════════════════════════════════════════════════════
  // CHORDPRO PARSER → chord-word pairs
  // ═══════════════════════════════════════════════════════════

  function cleanLabel(text) {
    if (!text) return "";
    return text.replace(/^[^a-zA-Z0-9]+/, "").trim() || "Verse";
  }

  function stripEmoji(text) {
    if (!text) return "";
    return text.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}]/gu, "");
  }

  // Maps clean types and sequence counters to beautiful minimal tokens like [V1], [C1]
  // Note: server now precomputes tokens in sections[].token
  // This client-side function is a fallback for older data.
  function getShortToken(type, index) {
    var t = (type || "").toLowerCase();
    if (t === "intro") return "[I]";
    if (t === "verse") return "[V" + index + "]";
    if (t === "chorus") return "[C" + index + "]";
    if (t === "solo") return "[S]";
    if (t === "bridge") return "[B]";
    if (t === "outro" || t === "ending") return "[O]";
    if (t === "interlude") return "[INT]";
    return "[" + t.substring(0, 3).toUpperCase() + "]";
  }

  // Match a bare chord name (no brackets): root note + optional quality + optional bass
  var chordNameRe = /^[A-G][b#]?(?:m|dim|aug|sus[24]|add\d+|maj7|maj9|m6|m7|m9|7|9|11|13|6)*(?:\/[A-G][b#]?)?$/;

  // "I got my [D]first real six-[A]string"
  // → [{chord:"", word:"I got my "}, {chord:"D", word:"first real six-"}, {chord:"A", word:"string"}]
  function parseLinePairs(raw) {
    var pairs = [];
    var re = /\[([^\]]+)\]/g;
    var chords = [];
    var match;

    while ((match = re.exec(raw)) !== null) {
      chords.push({
        name: match[1],
        index: match.index,
        end: match.index + match[0].length,
      });
    }

    if (chords.length === 0) {
      var plain = stripEmoji(raw);
      if (plain) {
        // Check if this is a bare chord line: all tokens are chord names
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

    // Text before first chord
    if (chords[0].index > 0) {
      var pre = stripEmoji(raw.substring(0, chords[0].index));
      if (pre) pairs.push({ chord: "", word: pre });
    }

    // Each chord gets the text up to the next chord (or end of line)
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

    for (var i = 0; i < rawLines.length; i++) {
      var raw = rawLines[i].trim();
      if (!raw) continue;
      
      if (raw.charAt(0) === "{") {
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
        continue;
      }

      var barAnnot = null;
      var content = raw;
      var barMatch = raw.match(/^@bar\s*=\s*(\d+)\s*/i);
      if (barMatch) {
        barAnnot = parseInt(barMatch[1], 10);
        content = raw.substring(barMatch[0].length);
      }

      lines.push({
        pairs: parseLinePairs(content),
        type: currentType,
        label: currentLabel,
        _bar: barAnnot,
        _duration: currentDuration,
      });
    }

    // Post-process: distribute chord-only line chords across following lyric lines
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

    return { lines: lines, directives: directives };
  }

  // ═══════════════════════════════════════════════════════════
  // LINE → BAR ESTIMATOR
  // ═══════════════════════════════════════════════════════════

  function estimateLineBars(lines, sections) {
    if (!sections || sections.length === 0 || lines.length === 0) {
      return lines.map(function (_, i) { return i + 1; });
    }

    var sectionRanges = [];
    for (var i = 0; i < sections.length; i++) {
      var startBar = sections[i].bar;
      var endBar = (i + 1 < sections.length) ? sections[i + 1].bar : startBar + 16;
      sectionRanges.push({ startBar: startBar, endBar: endBar });
    }

    var linesPerSection = Math.max(1, Math.floor(lines.length / sectionRanges.length));
    var bars = [];

    for (var j = 0; j < lines.length; j++) {
      // Line has exact @bar annotation — use it
      if (lines[j]._bar !== null && lines[j]._bar !== undefined) {
        bars.push(lines[j]._bar);
        continue;
      }

      var secIdx = Math.min(Math.floor(j / linesPerSection), sectionRanges.length - 1);
      var sec = sectionRanges[secIdx];
      var secStart = secIdx * linesPerSection;
      var secEnd = Math.min(secStart + linesPerSection, lines.length);

      // Count un-annotated lines before this one in the same section
      var localIdx = 0;
      for (var k = secStart; k < j; k++) {
        if (lines[k] && (lines[k]._bar === null || lines[k]._bar === undefined)) localIdx++;
      }
      // Count total un-annotated lines in this section
      var totalLocal = 0;
      for (var k = secStart; k < secEnd; k++) {
        if (lines[k] && (lines[k]._bar === null || lines[k]._bar === undefined)) totalLocal++;
      }
      totalLocal = Math.max(1, totalLocal);

      var barsInSection = sec.endBar - sec.startBar;
      var bar = sec.startBar + Math.floor((localIdx / totalLocal) * barsInSection);
      bars.push(Math.max(1, bar));
    }

    return bars;
  }

  // ═══════════════════════════════════════════════════════════
  // CHORD-WORD PAIR HTML BUILDER
  // ═══════════════════════════════════════════════════════════

  function buildLinePairsHTML(line) {
    var container = document.createElement("div");
    container.className = "tp-line-content";

    for (var i = 0; i < line.pairs.length; i++) {
      var pair = line.pairs[i];
      var pairEl = document.createElement("span");
      pairEl.className = "chord-word-pair";

      var chordEl = document.createElement("span");
      chordEl.className = pair.chord ? "chord" : "chord empty";
      chordEl.textContent = pair.chord ? "[" + pair.chord + "]" : "\u00A0"; // brackets around chords!
      pairEl.appendChild(chordEl);

      var wordEl = document.createElement("span");
      wordEl.className = "word";
      wordEl.textContent = pair.word || "\u00A0";
      pairEl.appendChild(wordEl);

      container.appendChild(pairEl);
    }

    return container;
  }

  // Check if a line is pure chords (instrumental or bare chord names like "G", "Am", "D7")
  function isChordOnlyLine(line) {
    if (!line) return true;
    // Check if ALL pairs have either empty words or bare chord names
    for (var i = 0; i < line.pairs.length; i++) {
      var cleanWord = (line.pairs[i].word || "").trim();
      var chord = (line.pairs[i].chord || "").trim();
      // A pair with a chord name in the word field and no chord field is a bare chord
      if (cleanWord.length > 0) {
        if (!chord && chordNameRe.test(cleanWord)) {
          // Convert bare chord word to chord field, empty word
          line.pairs[i].chord = cleanWord;
          line.pairs[i].word = "";
          continue; // this pair is now chord-only
        }
        return false; // has real word content
      }
    }
    return true;
  }

  // Check if a line is harmony
  function isHarmonyLine(line) {
    if (!line) return false;
    for (var i = 0; i < line.pairs.length; i++) {
      var word = (line.pairs[i].word || "").toLowerCase();
      var chord = (line.pairs[i].chord || "").toLowerCase();
      if (word.indexOf("harmony") >= 0 || chord.indexOf("harmony") >= 0) return true;
      if (word.indexOf("backing") >= 0 || word.indexOf("bg") >= 0) return true;
      if (word.indexOf("(") >= 0 && word.indexOf(")") >= 0) return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // PREPARE SONG LINES (Fallback healing for legacy data)
  // ═══════════════════════════════════════════════════════════
  // Server now sends precomputed sections with accurate types,
  // labels, and tokens. This function is a safety net for older
  // server data that lacks the `token` field.

  function prepareSongLines(lines, sections) {
    if (!lines || lines.length === 0) return;

    // Compute bar estimates only for lines without exact @bar annotations
    var barEstimates = estimateLineBars(lines, sections || []);
    for (var i = 0; i < lines.length; i++) {
      if (lines[i]._bar === null || lines[i]._bar === undefined) {
        lines[i]._bar = barEstimates[i];
      }
    }

    // Heuristically map server sections to ChordPro-parsed types/labels
    // Only if server didn't send proper tokens
    var needsHealing = false;
    for (var j = 0; j < (sections || []).length; j++) {
      if (!sections[j].token) { needsHealing = true; break; }
    }
    if (!needsHealing || !sections) return;

    for (var j = 0; j < sections.length; j++) {
      var sec = sections[j];
      var bestLine = null;
      var minDiff = Infinity;
      for (var k = 0; k < lines.length; k++) {
        var diff = Math.abs(lines[k]._bar - sec.bar);
        if (diff < minDiff) {
          minDiff = diff;
          bestLine = lines[k];
        }
      }
      if (bestLine && bestLine.label) {
        sec.text = bestLine.label;
        sec.type = bestLine.type;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 3-LINE ROLLING ENGINE
  // ═══════════════════════════════════════════════════════════

  function renderRollingEngine(bar, lines, sections) {
    if (!lines || lines.length === 0) return;

    // Find current line by bar position using _bar annotations
    var currentIdx = 0;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i]._bar !== null && lines[i]._bar !== undefined) {
        if (lines[i]._bar <= bar) currentIdx = i;
      }
    }

    // Check for solo section: if the current line or any line in this
    // section has _duration set (from @duration) and the section is solo
    var inSolo = false;
    var soloRemaining = 0;
    for (var i = currentIdx; i < lines.length && (i === currentIdx || lines[i].type === lines[currentIdx].type); i++) {
      if (lines[i].type === "solo" || (lines[i]._duration && lines[i].type === "solo")) {
        inSolo = true;
        var soloStart = lines[i]._bar || 1;
        soloRemaining = (lines[i]._duration || 16) - (bar - soloStart);
        break;
      }
    }
    // Also check if current line is chord-only (legacy solo detection)
    if (!inSolo && lines[currentIdx] && isChordOnlyLine(lines[currentIdx])) {
      inSolo = true;
      soloRemaining = 8;
    }

    if (inSolo) {
      lyricEngine.style.display = "none";
      soloEngine.style.display = "flex";
      // Show chords from all lines in the solo section
      soloGrid.innerHTML = "";
      for (var i = currentIdx; i < lines.length; i++) {
        if (lines[i].type !== "solo" && lines[i].type !== lines[currentIdx].type) break;
        for (var ci = 0; ci < lines[i].pairs.length; ci++) {
          if (lines[i].pairs[ci].chord) {
            var span = document.createElement("span");
            span.className = "chord";
            span.textContent = "[" + lines[i].pairs[ci].chord + "]";
            soloGrid.appendChild(span);
          }
        }
      }
      var pct = Math.min(100, Math.max(0, 100 - (soloRemaining / Math.max(lines[currentIdx]._duration || 16, 1)) * 100));
      soloProgressFill.style.width = pct + "%";
      return;
    } else {
      lyricEngine.style.display = "block";
      soloEngine.style.display = "none";
    }

    // Build array of 6 lines: [past3, past2, past1, present, future1, future2]
    var indices = [
      currentIdx - 3,
      currentIdx - 2,
      currentIdx - 1,
      currentIdx,
      currentIdx + 1,
      currentIdx + 2
    ];
    var classNames = ["past-3", "past-2", "past-1", "present", "future-1", "future-2"];

    for (var li = 0; li < lineEls.length; li++) {
      var el = lineEls[li];
      var idx = indices[li];
      el.innerHTML = "";
      el.className = "tp-line " + classNames[li];
      if (idx >= 0 && idx < lines.length) {
        el.appendChild(buildLinePairsHTML(lines[idx]));
        if (idx === currentIdx && isHarmonyLine(lines[idx])) {
          el.classList.add("harmony");
        }
      } else {
        el.innerHTML = "\u2026";
      }
    }

    // Update section labels (e.g. [CHORUS])
    if (sections && sections.length > 0) {
      var secIdx = -1;
      for (var j = sections.length - 1; j >= 0; j--) {
        if (bar >= sections[j].bar) { secIdx = j; break; }
      }
      if (secIdx >= 0) {
        currentSectionLabel.textContent = "[" + cleanLabel(sections[secIdx].text).toUpperCase() + "]";
        
        // Next section preview
        if (secIdx + 1 < sections.length) {
          var nextSec = sections[secIdx + 1];
          var nextNextBar = (secIdx + 2 < sections.length) ? sections[secIdx + 2].bar : "End";
          var lengthStr = "";
          if (typeof nextNextBar === "number") {
            lengthStr = " - " + (nextNextBar - nextSec.bar) + " Bars";
          }
          futureSectionLabel.textContent = "[Next: " + cleanLabel(nextSec.text) + lengthStr + "]";
        } else {
          futureSectionLabel.textContent = "";
        }
      } else {
        currentSectionLabel.textContent = "";
        futureSectionLabel.textContent = "";
      }
    }
  }

  function renderSoloGrid(line) {
    soloGrid.innerHTML = "";
    for (var i = 0; i < line.pairs.length; i++) {
      if (line.pairs[i].chord) {
        var span = document.createElement("span");
        span.className = "chord";
        span.textContent = "[" + line.pairs[i].chord + "]";
        soloGrid.appendChild(span);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PROGRESS ANCHOR — Proportional Timeline
  // ═══════════════════════════════════════════════════════════

  function renderTimelineNotches(sections, currentBar, totalBars) {
    timelineNotches.innerHTML = "";
    if (!sections || sections.length === 0 || !totalBars) return;

    var verseCount = 0;
    var chorusCount = 0;

    for (var j = 0; j < sections.length; j++) {
      var sec = sections[j];
      var startBar = sec.bar;
      var endBar = (j + 1 < sections.length) ? sections[j + 1].bar : totalBars;
      var length = endBar - startBar;
      var pct = (length / totalBars) * 100;

      // Use server-precomputed token when available, fall back to client counting
      var token = sec.token;
      if (!token) {
        var type = (sec.type || "").toLowerCase();
        if (type === "verse") { verseCount++; token = getShortToken("verse", verseCount); }
        else if (type === "chorus") { chorusCount++; token = getShortToken("chorus", chorusCount); }
        else { token = getShortToken(type, 0); }
      }

      var block = document.createElement("div");
      block.className = "timeline-block";
      block.style.width = pct + "%";
      block.textContent = token;

      if (currentBar >= endBar) {
        block.classList.add("past");
      } else {
        block.classList.add("future");
      }

      timelineNotches.appendChild(block);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CONDUCER METRONOME (High Contrast Bar & Beat)
  // ═══════════════════════════════════════════════════════════

  function updateConductor(position, bpm) {
    if (!bpm || bpm <= 0) return;

    var totalBeats = (position * bpm) / 60;
    var bar = Math.floor(totalBeats / 4) + 1;
    var beat = Math.floor(totalBeats % 4) + 1;

    barCounter.textContent = "BAR: " + bar;

    // High contrast active beat numbering inside the card
    for (var i = 1; i <= 4; i++) {
      var el = $("beat" + i);
      if (el) {
        if (i === beat) {
          el.style.color = "#000000";
          el.style.fontWeight = "900";
          el.style.opacity = "1.0";
        } else {
          el.style.color = "#cccccc";
          el.style.fontWeight = "400";
          el.style.opacity = "0.25";
        }
      }
    }

    // Metronome flasher (bottom right corner)
    var metronome = $("metronomeDot");
    if (metronome) {
      if (beat === 1) {
        metronomeDot.className = "pulse";
      } else {
        metronomeDot.className = "";
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // NEXT SONG KEY AUTO LOOKUP
  // ═══════════════════════════════════════════════════════════

  function fetchNextSongKey(nextSongTitle) {
    if (!nextSongTitle || nextSongTitle === currentNextSongTitle) return;
    currentNextSongTitle = nextSongTitle;

    var slug = nextSongTitle.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

    var xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/song-data/" + encodeURIComponent(slug), true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          if (data && data.key) {
            nextSongKey = data.key;
          } else {
            nextSongKey = null;
          }
        } catch (e) {
          nextSongKey = null;
        }
      } else {
        nextSongKey = null;
      }
      updateNextSongDisplay(nextSongTitle);
    };
    xhr.onerror = function () {
      nextSongKey = null;
      updateNextSongDisplay(nextSongTitle);
    };
    xhr.send();
  }

  function updateNextSongDisplay(title) {
    var displayStr = title || "\u2014";
    if (nextSongKey) {
      displayStr += " \"" + nextSongKey + "\"";
    }
    nextSong.innerHTML = "<span>" + displayStr + "</span>";
    topNextVal.textContent = displayStr;
  }

  // ═══════════════════════════════════════════════════════════
  // DATA FETCHING
  // ═══════════════════════════════════════════════════════════

  function fetchAndRenderChords(songId) {
    if (!songId || songId === currentSongId) return;
    currentSongId = songId;
    loadingEl.style.display = "block";
    loadingEl.textContent = "Loading charts\u2026";

    var xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/chordpro/" + encodeURIComponent(songId), true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        var res = parseChordPro(xhr.responseText);
        parsedLines = res.lines;
        parsedDirectives = res.directives;
        loadingEl.style.display = "none";
        lyricEngine._prepared = false;
      } else {
        parsedLines = [];
        parsedDirectives = {};
        loadingEl.style.display = "block";
        loadingEl.textContent = "No chord charts";
      }
    };
    xhr.onerror = function () {
      parsedLines = [];
      parsedDirectives = {};
      loadingEl.style.display = "block";
      loadingEl.textContent = "Connection lost";
    };
    xhr.send();
  }

  // ═══════════════════════════════════════════════════════════
  // EDGE FLASH
  // ═══════════════════════════════════════════════════════════

  function triggerEdgeFlash() {
    if (flashTimeout) clearTimeout(flashTimeout);
    edgeFlashTop.classList.add("edge-flash-active");
    edgeFlashBottom.classList.add("edge-flash-active");
    flashTimeout = setTimeout(function () {
      edgeFlashTop.classList.remove("edge-flash-active");
      edgeFlashBottom.classList.remove("edge-flash-active");
    }, 200);
  }

  var lastSectionIdx = -1;

  function detectSectionChange(sections, currentBar) {
    if (!sections || sections.length === 0) return;
    var idx = -1;
    for (var i = sections.length - 1; i >= 0; i--) {
      if (currentBar >= sections[i].bar) { idx = i; break; }
    }
    if (idx !== lastSectionIdx) {
      lastSectionIdx = idx;
      if (idx >= 0) {
        triggerEdgeFlash();
        footerSection.textContent = cleanLabel(sections[idx].text) || "";
      }
    }
    if (idx >= 0 && idx + 1 < sections.length) {
      var nextBar = sections[idx + 1].bar;
      if (currentBar >= nextBar - 2 && currentBar < nextBar) {
        if (!document.querySelector(".edge-flash-active")) {
          triggerEdgeFlash();
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PERFORMANCE NOTES
  // ═══════════════════════════════════════════════════════════

  function showNotes(text) {
    if (notesTimeout) clearTimeout(notesTimeout);
    hudNotes.textContent = text || "";
    hudNotes.classList.add("visible");
    notesTimeout = setTimeout(function () {
      hudNotes.classList.remove("visible");
    }, 8000);
  }

  // ═══════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════

  function formatTime(seconds) {
    if (!seconds || seconds < 0) return "0:00";
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function updateMeters(levels) {
    meterRow.innerHTML = "";
    if (!levels || levels.length === 0) return;
    for (var i = 0; i < Math.min(levels.length, 8); i++) {
      var strip = document.createElement("div");
      strip.className = "meter-strip";
      var fill = document.createElement("div");
      fill.className = "meter-fill";
      var pct = Math.min((levels[i].level || 0) * 100, 100);
      fill.style.width = pct + "%";
      if (pct > 85) fill.classList.add("clip");
      else if (pct > 70) fill.classList.add("warn");
      strip.appendChild(fill);
      meterRow.appendChild(strip);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SOCKET INIT
  // ═══════════════════════════════════════════════════════════

  statusText.innerHTML = "&#9679; Connecting\u2026";
  statusText.className = "status-dot disconnected";

  // Loading message element (sibling to line elements, not a replacement)
  loadingEl = document.createElement("div");
  loadingEl.className = "waiting";
  loadingEl.textContent = "Waiting for show\u2026";
  lyricEngine.appendChild(loadingEl);

  // Scale HUD to fit the window
  fitHud();

  // ── Heartbeat: detect stale state updates ──
  var lastStateTime = 0;
  var heartbeatInterval = setInterval(function () {
    if (Date.now() - lastStateTime > 3500) {
      heartbeatBanner.style.display = "block";
    } else {
      heartbeatBanner.style.display = "none";
    }
  }, 1000);

  setTimeout(function () {
    var socket = io({
      transports: ["polling", "websocket"],
      timeout: 10000,
    });

    socket.on("connect", function () {
      statusText.innerHTML = "&#9679; Connected";
      statusText.className = "status-dot connected";
    });

    socket.on("disconnect", function () {
      statusText.innerHTML = "&#9679; Disconnected";
      statusText.className = "status-dot disconnected";
    });

    socket.on("connect_error", function () {
      statusText.innerHTML = "&#9679; Connection Error";
      statusText.className = "status-dot disconnected";
    });

    socket.on("state", function (s) {
      try {
      lastStateTime = Date.now();

      // Stacked Pro Metadata
      topTitle.textContent = s.currentSong || "\u2014";
      topKey.textContent = s.currentKey || "\u2014";
      topBpm.textContent = s.bpm || "\u2014";

      if (s.songId && s.songId !== currentSongId) {
        fetchAndRenderChords(s.songId);
        if (s.notes) showNotes(s.notes);
        lastSectionIdx = -1;
      }

      // Conductor Counter & Metronome
      updateConductor(s.position || 0, s.bpm || 0);

      // Playhead slide
      var pct = s.duration ? Math.min(100, ((s.position || 0) / s.duration) * 100) : 0;
      progressFill.style.left = pct + "%";
      footerElapsed.textContent = formatTime(s.position);
      footerTotal.textContent = formatTime(s.duration);

      // Auto next song key lookup
      if (s.nextSong) {
        fetchNextSongKey(s.nextSong);
      } else {
        updateNextSongDisplay("\u2014");
      }

      var barCalc = Math.floor((s.position || 0) * (s.bpm || 0) / (4 * 60)) + 1;

      // Section markers & playhead
      if (s.sections && s.sections.length > 0) {
        var totalBars = Math.floor((s.duration || 0) * (s.bpm || 0) / (4 * 60)) + 1;
        renderTimelineNotches(s.sections, barCalc, totalBars || 128);
      }

      detectSectionChange(s.sections, barCalc);

      // Debug overlay — always show current parsing state (AFTER barCalc)
      var _d = document.getElementById("hudDebug");
      if (_d) {
        var _word0 = parsedLines.length > 0 && parsedLines[0].pairs.length > 0 ? (parsedLines[0].pairs[0].word||"-").substring(0,30) : "-";
        _d.textContent = "song=" + (s.songId||"-") + " lines=" + parsedLines.length + " sec=" + (s.sections?s.sections.length:0) + " bar=" + barCalc + " prep=" + lyricEngine._prepared + " w0='" + _word0 + "'";
      }

      // 6-Line Engine Renderer — advance lines by bar position (@bar=N annotations)
      if (parsedLines.length > 0 && s.sections && s.sections.length > 0) {
        if (!lyricEngine._prepared) {
          lyricEngine._prepared = true;
          prepareSongLines(parsedLines, s.sections);
        }
        renderRollingEngine(barCalc, parsedLines, s.sections);
      }
      } catch (e) {
        console.error("HUD ERROR:", e.message, e.stack);
        document.getElementById("hudDebug") && (document.getElementById("hudDebug").textContent = "ERROR: " + e.message);
      }
    });

    socket.on("trackLevels", function (levels) {
      updateMeters(levels);
    });

  }, 0);
})();
