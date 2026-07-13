// Live Stage HUD — Professional Stage Teleprompter
// =================================================
// Consumes WebSocket state, renders ChordPro as left-aligned
// chord-word pairs in a scrolling teleprompter window.
// Single chord color (amber). No emoji. High density.

(function () {

  "use strict";

  var RING_CIRCUMFERENCE = 2 * Math.PI * 90;
  var SCROLL_LINES_BEFORE = 3;

  // ── DOM refs ──
  var $ = function (id) { return document.getElementById(id); };

  var hudTitle = $("hudTitle");
  var hudArtist = $("hudArtist");
  var hudKey = $("hudKey");
  var hudBpm = $("hudBpm");
  var hudCounter = $("hudCounter");

  var sectionBar = $("sectionBar");
  var lyricsScroll = $("lyricsScroll");
  var lyricsContent = $("lyricsContent");
  var hudNotes = $("hudNotes");

  var ringProgress = $("ringProgress");
  var ringTime = $("ringTime");
  var ringRemaining = $("ringRemaining");
  var ringBpm = $("ringBpm");
  var ringTicks = $("ringTicks");
  var footerLeft = $("footerLeft");

  var progressFill = $("progressFill");
  var footerElapsed = $("footerElapsed");
  var footerTotal = $("footerTotal");
  var nextSong = $("nextSong");
  var footerStatus = $("footerStatus");
  var footerSection = $("footerSection");

  var edgeFlashTop = $("edgeFlashTop");
  var edgeFlashBottom = $("edgeFlashBottom");
  var meterRow = $("meterRow");

  // ── State ──
  var currentSongId = null;
  var parsedLines = [];
  var notesTimeout = null;
  var flashTimeout = null;

  // ═══════════════════════════════════════════════════════════
  // CHORDPRO PARSER → chord-word pairs
  // ═══════════════════════════════════════════════════════════

  // Strips emoji / non-alpha prefix from section text for clean labels
  function cleanLabel(text) {
    if (!text) return "";
    return text.replace(/^[^a-zA-Z0-9]+/, "").trim() || "Verse";
  }

  // Parse a single ChordPro line into chord-word pairs
  // "I got my [D]first real six-[A]string"
  // → [{chord:"", word:"I got my "}, {chord:"D", word:"first real six-"}, {chord:"A", word:"string"}]
  function parseLinePairs(raw) {
    var pairs = [];
    var re = /\[([^\]]+)\]/g;
    var chords = [];
    var match;

    // Collect all chord positions
    while ((match = re.exec(raw)) !== null) {
      chords.push({
        name: match[1],
        index: match.index,
        end: match.index + match[0].length,
      });
    }

    if (chords.length === 0) {
      // No chords — whole line is one pair
      var plain = stripEmoji(raw);
      if (plain) pairs.push({ chord: "", word: plain });
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
      var end = (i + 1 < chords.length) ? chords[i + 1].bar : start + 16;
      var wordText = raw.substring(start, end);
      pairs.push({
        chord: chords[i].name,
        word: wordText,
      });
    }

    return pairs;
  }

  function parseChordPro(text) {
    var lines = [];
    var rawLines = text.split("\n");

    for (var i = 0; i < rawLines.length; i++) {
      var raw = rawLines[i].trim();
      if (!raw) continue;
      if (raw.charAt(0) === "{") continue;

      lines.push({
        pairs: parseLinePairs(raw),
      });
    }

    return lines;
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

    var bars = [];
    var linesPerSection = Math.max(1, Math.floor(lines.length / sectionRanges.length));

    for (var j = 0; j < lines.length; j++) {
      var secIdx = Math.min(Math.floor(j / linesPerSection), sectionRanges.length - 1);
      var sec = sectionRanges[secIdx];
      var lineInSection = j - secIdx * linesPerSection;
      var barsInSection = sec.endBar - sec.startBar;
      var bar = sec.startBar + Math.floor((lineInSection / linesPerSection) * barsInSection);
      bars.push(Math.max(1, bar));
    }

    return bars;
  }

  // ═══════════════════════════════════════════════════════════
  // TELEPROMPTER RENDERER — chord-word pairs, left-aligned
  // ═══════════════════════════════════════════════════════════

  function renderAllLines(lines, sections) {
    lyricsScroll.innerHTML = "";

    if (!lines || lines.length === 0) {
      lyricsScroll.innerHTML = "<div class='waiting'>Waiting for show\u2026</div>";
      return;
    }

    var barEstimates = estimateLineBars(lines, sections);

    for (var i = 0; i < lines.length; i++) {
      lines[i]._bar = barEstimates[i];
    }

    // Build section label map
    var sectionLabels = {};
    if (sections) {
      for (var j = 0; j < sections.length; j++) {
        sectionLabels[sections[j].bar] = cleanLabel(sections[j].text);
      }
    }

    for (var k = 0; k < lines.length; k++) {
      var line = lines[k];

      // Section label
      if (sectionLabels[barEstimates[k]]) {
        var label = document.createElement("div");
        label.className = "tp-section-label";
        label.textContent = "\u2014 " + sectionLabels[barEstimates[k]] + " \u2014";
        lyricsScroll.appendChild(label);
      }

      var lineEl = document.createElement("div");
      lineEl.className = "tp-line";

      // Check if line has any chords
      var hasChord = false;
      for (var p = 0; p < line.pairs.length; p++) {
        if (line.pairs[p].chord) { hasChord = true; break; }
      }

      for (var q = 0; q < line.pairs.length; q++) {
        var pair = line.pairs[q];
        var pairEl = document.createElement("span");
        pairEl.className = "chord-word-pair";

        var chordEl = document.createElement("span");
        chordEl.className = pair.chord ? "chord" : "chord empty";
        chordEl.textContent = pair.chord || "\u00A0";
        pairEl.appendChild(chordEl);

        var wordEl = document.createElement("span");
        wordEl.className = "word";
        wordEl.textContent = pair.word || "\u00A0";
        pairEl.appendChild(wordEl);

        lineEl.appendChild(pairEl);
      }

      lyricsScroll.appendChild(lineEl);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SCROLL CONTROLLER
  // ═══════════════════════════════════════════════════════════

  function updateTeleprompter(bar, lines) {
    if (!lines || lines.length === 0) return;

    var currentIdx = 0;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i]._bar <= bar) currentIdx = i;
    }

    var children = lyricsScroll.children;
    for (var j = 0; j < children.length; j++) {
      var child = children[j];
      if (child.classList.contains("tp-section-label")) continue;
      if (!child.classList.contains("tp-line")) continue;

      var lineIdx = -1;
      var count = 0;
      for (var k = 0; k < children.length; k++) {
        if (children[k].classList.contains("tp-line")) {
          if (children[k] === child) { lineIdx = count; break; }
          count++;
        }
      }

      var dist = lineIdx - currentIdx;
      child.className = "tp-line";
      if (dist === 0) {
        child.classList.add("current");
      } else if (Math.abs(dist) <= 1) {
        child.classList.add("near");
      } else if (Math.abs(dist) <= 3) {
        child.classList.add("adjacent");
      }
    }

    // Calculate scroll position
    var domIdx = 0;
    var lineCount = 0;
    for (var m = 0; m < children.length; m++) {
      if (children[m].classList.contains("tp-line")) {
        if (lineCount === currentIdx) { domIdx = m; break; }
        lineCount++;
      }
    }

    var firstLine = lyricsScroll.querySelector(".tp-line");
    if (!firstLine) return;
    var lineHeight = firstLine.offsetHeight || 70;

    var viewH = lyricsContent.clientHeight;
    var targetScroll = domIdx * lineHeight - (SCROLL_LINES_BEFORE * lineHeight);
    var maxScroll = lyricsScroll.scrollHeight - viewH;
    if (maxScroll < 0) maxScroll = 0;
    targetScroll = Math.max(0, Math.min(targetScroll, maxScroll));

    lyricsScroll.style.transform = "translateY(-" + targetScroll + "px)";
  }

  // ═══════════════════════════════════════════════════════════
  // DATA FETCHING
  // ═══════════════════════════════════════════════════════════

  function currentBarFromPosition(position, bpm) {
    if (!position || !bpm || bpm <= 0) return 0;
    return Math.floor(position * bpm / (4 * 60)) + 1;
  }

  function fetchAndRenderChords(songId) {
    if (!songId || songId === currentSongId) return;
    currentSongId = songId;
    lyricsScroll._rendered = false;

    var xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/chordpro/" + encodeURIComponent(songId), true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        parsedLines = parseChordPro(xhr.responseText);
      } else {
        parsedLines = [];
      }
    };
    xhr.onerror = function () {
      parsedLines = [];
    };
    xhr.send();
  }

  // ═══════════════════════════════════════════════════════════
  // COUNTDOWN RING
  // ═══════════════════════════════════════════════════════════

  function updateRing(position, duration) {
    if (!duration || duration <= 0) {
      ringProgress.setAttribute("stroke-dashoffset", RING_CIRCUMFERENCE);
      ringTime.textContent = "0:00";
      ringRemaining.textContent = "0:00";
      return;
    }

    var fraction = Math.min(1, Math.max(0, position / duration));
    var offset = RING_CIRCUMFERENCE * (1 - fraction);
    ringProgress.setAttribute("stroke-dashoffset", offset);

    var remaining = Math.max(0, duration - position);
    ringTime.textContent = formatTime(remaining);
    ringRemaining.textContent = "-" + formatTime(remaining);

    var pct = fraction * 100;
    footerLeft.className = "";
    if (pct >= 90) {
      footerLeft.classList.add("ring-red");
      if (pct >= 95) footerLeft.classList.add("pulse");
    } else if (pct >= 75) {
      footerLeft.classList.add("ring-yellow");
    } else {
      footerLeft.classList.add("ring-green");
    }
  }

  function updateRingTicks(sections, totalBars) {
    ringTicks.innerHTML = "";
    if (!sections || sections.length === 0 || !totalBars) return;

    var cx = 110, cy = 110, r = 100;
    for (var i = 1; i < sections.length; i++) {
      var barPos = sections[i].bar;
      var angle = ((barPos - 1) / totalBars) * 360 - 90;
      var rad = angle * Math.PI / 180;
      var x1 = cx + r * Math.cos(rad);
      var y1 = cy + r * Math.sin(rad);
      var x2 = cx + (r - 8) * Math.cos(rad);
      var y2 = cy + (r - 8) * Math.sin(rad);
      var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", x1);
      line.setAttribute("y1", y1);
      line.setAttribute("x2", x2);
      line.setAttribute("y2", y2);
      line.classList.add("section-start");
      ringTicks.appendChild(line);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION BAR — clean text tokens
  // ═══════════════════════════════════════════════════════════

  function updateSectionBar(sections, currentBar) {
    sectionBar.innerHTML = "";
    if (!sections || sections.length === 0) {
      sectionBar.innerHTML = "<span style='color:#222;font-size:12px'>\u2014</span>";
      return;
    }

    for (var i = 0; i < sections.length; i++) {
      var token = document.createElement("span");
      token.className = "section-token";
      token.textContent = cleanLabel(sections[i].text);

      var nextBar = (i + 1 < sections.length) ? sections[i + 1].bar : Infinity;
      if (currentBar >= sections[i].bar && currentBar < nextBar) {
        token.classList.add("current");
      } else if (currentBar >= nextBar) {
        token.classList.add("past");
      } else if (currentBar >= sections[i].bar - 2 && currentBar < sections[i].bar) {
        token.classList.add("upcoming");
      } else {
        token.classList.add("future");
      }

      sectionBar.appendChild(token);
    }
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

  footerStatus.textContent = "\u25CF Connecting\u2026";
  footerStatus.className = "status-dot disconnected";
  lyricsScroll.innerHTML = "<div class='waiting'>Waiting for show\u2026</div>";

  setTimeout(function () {
    var socket = io({
      transports: ["polling", "websocket"],
      timeout: 10000,
    });

    socket.on("connect", function () {
      footerStatus.textContent = "\u25CF Connected";
      footerStatus.className = "status-dot connected";
    });

    socket.on("disconnect", function () {
      footerStatus.textContent = "\u25CF Disconnected";
      footerStatus.className = "status-dot disconnected";
    });

    socket.on("connect_error", function () {
      footerStatus.textContent = "\u25CF Connection Error";
      footerStatus.className = "status-dot disconnected";
    });

    socket.on("state", function (s) {
      hudTitle.textContent = s.currentSong || "\u2014";
      hudArtist.textContent = s.currentArtist || "";
      hudKey.textContent = s.currentKey || "";
      hudBpm.textContent = s.bpm ? "\u2669=" + s.bpm : "";
      hudCounter.textContent = s.totalSongs ? s.songIndex + "/" + s.totalSongs : "";

      if (s.songId && s.songId !== currentSongId) {
        fetchAndRenderChords(s.songId);
        if (s.notes) showNotes(s.notes);
        lastSectionIdx = -1;
      }

      updateRing(s.position || 0, s.duration || 0);

      var pct = s.duration ? Math.min(100, ((s.position || 0) / s.duration) * 100) : 0;
      progressFill.style.width = pct + "%";
      footerElapsed.textContent = formatTime(s.position);
      footerTotal.textContent = formatTime(s.duration);

      ringBpm.textContent = s.bpm ? "\u2669=" + s.bpm : "";
      nextSong.textContent = s.nextSong || "\u2014";

      var bar = currentBarFromPosition(s.position, s.bpm);
      updateSectionBar(s.sections, bar);

      if (s.sections && s.sections.length > 0) {
        var secIdx = -1;
        for (var i = s.sections.length - 1; i >= 0; i--) {
          if (bar >= s.sections[i].bar) { secIdx = i; break; }
        }
        if (secIdx >= 0) {
          footerSection.textContent = cleanLabel(s.sections[secIdx].text) || "";
        }
      }

      detectSectionChange(s.sections, bar);

      if (s.sections && s.sections.length > 0) {
        var totalBars = 0;
        for (var j = 0; j < s.sections.length; j++) {
          if (s.sections[j].bar > totalBars) totalBars = s.sections[j].bar;
        }
        updateRingTicks(s.sections, totalBars + 8);
      }

      // Teleprompter
      if (parsedLines.length > 0 && s.sections && s.sections.length > 0) {
        if (!lyricsScroll._rendered) {
          lyricsScroll._rendered = true;
          renderAllLines(parsedLines, s.sections);
        }
        updateTeleprompter(bar, parsedLines);
      }
    });

    socket.on("trackLevels", function (levels) {
      updateMeters(levels);
    });

  }, 0);
})();
