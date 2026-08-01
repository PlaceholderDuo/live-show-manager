#!/usr/bin/env node
// tui.js — Song Library Manager TUI
// ================================================================
// Terminal UI for managing the ReaperSongs library.
// Esc = go back | Tab/Arrows = navigate | Enter = select | q = quit
//
// Usage: node tools/tui.js
//
// Views (stack-based, Esc pops back):
//   DASHBOARD  — All songs with status icons, summary stats
//   SONG       — Detail view for one song, edit metadata, run actions
//   ADD        — Paste artist/title pairs, bulk import
//   DEMUCS     — Run stem separation on selected songs
//   IMPORT     — Import from UG playlist ID

"use strict";

const blessed = require("blessed");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const SONGS_DIR = path.join(os.homedir(), "ReaperSongs");
const AUDIO_DIR = path.join(os.homedir(), "Music", "SongAudio");
const TOOLS_DIR = __dirname;

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function loadSongs() {
  const songs = [];
  try {
    for (const d of fs.readdirSync(SONGS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".") || d.name.startsWith("_")) continue;
      const metaPath = path.join(SONGS_DIR, d.name, "meta.json");
      const choproPath = path.join(SONGS_DIR, d.name, "song.chopro");
      const audioPath = path.join(AUDIO_DIR, d.name, "full.mp3");
      const stemsPath = path.join(AUDIO_DIR, d.name, "stems", "vocals.mp3");

      let meta = {};
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch {}
      }

      const hasChopro = fs.existsSync(choproPath);
      const choproSize = hasChopro ? fs.statSync(choproPath).size : 0;
      const hasChords = hasChopro && choproSize > 200; // tiny = placeholder
      const hasAudio = fs.existsSync(audioPath);
      const hasStems = fs.existsSync(stemsPath);
      const bpm = meta.bpm || 120;
      const hasRealBPM = bpm !== 120 || meta.bpm_source === "aubio" || meta.bpm_source === "gpif";
      const hasKey = !!(meta.key && meta.key.trim());

      songs.push({
        name: d.name,
        title: meta.title || d.name,
        artist: meta.artist || "",
        key: meta.key || "",
        bpm,
        bpmSource: meta.bpm_source || "unknown",
        hasChords,
        hasAudio,
        hasStems,
        hasRealBPM,
        hasKey,
        ugTabId: meta.ug_tab_id || null,
        meta,
      });
    }
  } catch (e) {
    // directory might not exist
  }
  return songs.sort((a, b) => a.name.localeCompare(b.name));
}

function statusIcon(song) {
  const issues = [];
  if (!song.hasChords) issues.push("C");  // chords
  if (!song.hasAudio) issues.push("A");   // audio
  if (!song.hasStems) issues.push("S");   // stems
  if (!song.hasRealBPM) issues.push("B"); // bpm
  if (!song.hasKey) issues.push("K");     // key

  if (issues.length === 0) return "{green-fg}✓{/}";
  return `{red-fg}${issues.join("")}{/}`;
}

// ═══════════════════════════════════════════════════════════
// TUI SETUP
// ═══════════════════════════════════════════════════════════

const screen = blessed.screen({
  smartCSR: true,
  title: "Song Library Manager",
  dockBorders: false,
  fullUnicode: true,
});

const navStack = [];
let songs = [];
let selectedIdx = 0;
let scrollOffset = 0;

function pushView(name, renderFn) {
  navStack.push({ name, render: renderFn });
  render();
}

function popView() {
  if (navStack.length <= 1) {
    showQuitDialog();
  } else {
    navStack.pop();
    selectedIdx = 0;
    scrollOffset = 0;
    render();
  }
}

function render() {
  if (navStack.length === 0) return;
  const top = navStack[navStack.length - 1];
  top.render();
  screen.render();
}

function showQuitDialog() {
  const dialog = blessed.question({
    parent: screen,
    border: "line",
    height: "shrink",
    width: "half",
    top: "center",
    left: "center",
    label: " Quit ",
    keys: true,
    vi: true,
  });
  dialog.ask("Quit? (y/n)", (err, value) => {
    if (value && value.toLowerCase() === "y") {
      screen.destroy();
      process.exit(0);
    }
    dialog.destroy();
    screen.render();
  });
}

// ═══════════════════════════════════════════════════════════
// KEY BINDINGS
// ═══════════════════════════════════════════════════════════

screen.key(["escape"], () => popView());
screen.key(["q"], () => showQuitDialog());
screen.key(["C-c"], () => { screen.destroy(); process.exit(0); });

// ═══════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ═══════════════════════════════════════════════════════════

function clearScreen() {
  while (screen.children.length > 0) {
    screen.children[0].destroy();
  }
}

function header(text) {
  const h = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    content: `{bold}{cyan-fg} Song Library Manager{/}  {white-fg}${text}{/}`,
    border: { type: "line", fg: "cyan" },
    style: { fg: "white", bg: "black" },
  });
  return h;
}

function helpBar(text) {
  const h = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    content: text || " Esc: back  |  ↑↓: navigate  |  Enter: select  |  q: quit",
    style: { fg: "gray", bg: "black" },
  });
  return h;
}

function backLabel() {
  const current = navStack[navStack.length - 1];
  const prev = navStack.length > 1 ? navStack[navStack.length - 2].name : "quit";
  return `Esc → ${prev}`;
}

// ═══════════════════════════════════════════════════════════
// VIEW: DASHBOARD
// ═══════════════════════════════════════════════════════════

function dashboardView() {
  clearScreen();
  songs = loadSongs();
  selectedIdx = Math.min(selectedIdx, songs.length - 1);
  scrollOffset = Math.min(scrollOffset, Math.max(0, songs.length - 20));

  // Stats
  const total = songs.length;
  const allChords = songs.filter(s => s.hasChords).length;
  const allAudio = songs.filter(s => s.hasAudio).length;
  const allStems = songs.filter(s => s.hasStems).length;
  const allBPM = songs.filter(s => s.hasRealBPM).length;
  const allKey = songs.filter(s => s.hasKey).length;
  const disk = (() => {
    try { return execSync(`du -sh "${AUDIO_DIR}" 2>/dev/null | cut -f1`, { encoding: "utf-8" }).trim(); } catch { return "?"; }
  })();

  header("Dashboard");
  helpBar(" a: add songs  |  u: UG import  |  d: demucs  |  ↑↓: nav  |  Enter: detail  |  r: refresh  |  q: quit");

  // Stats bar
  const stats = blessed.box({
    parent: screen,
    top: 3, left: 0, width: "100%", height: 3,
    content: [
      `{bold}Songs:{/} ${total}  `,
      `{green-fg}Chords:{/} ${allChords}  `,
      `{green-fg}Audio:{/} ${allAudio}  `,
      `{green-fg}Stems:{/} ${allStems}  `,
      `{green-fg}BPM:{/} ${allBPM}  `,
      `{green-fg}Key:{/} ${allKey}  `,
      `{cyan-fg}Disk:{/} ${disk}`,
    ].join(""),
    border: { type: "line", fg: "cyan" },
    style: { fg: "white" },
  });

  // Song list
  const visible = 20;
  const listContent = [];
  for (let i = scrollOffset; i < Math.min(songs.length, scrollOffset + visible); i++) {
    const s = songs[i];
    const cursor = i === selectedIdx ? "{black-fg}{cyan-bg}" : "";
    const end = i === selectedIdx ? "{/}" : "";
    const status = statusIcon(s);
    const line = `${cursor} ${status} ${s.name.substring(0, 45).padEnd(45)} BPM:${String(s.bpm).padStart(3)} ${s.key || "  "} ${end}`;
    listContent.push(line);
  }

  const list = blessed.box({
    parent: screen,
    top: 6, left: 0, width: "100%", height: visible + 2,
    content: listContent.join("\n") || "No songs found.",
    border: { type: "line", fg: "white" },
    style: { fg: "white" },
    scrollable: false,
    keys: true,
    vi: true,
  });

  // Legend
  const legend = blessed.box({
    parent: screen,
    bottom: 1, left: 0, width: "100%", height: 1,
    content: " {red-fg}C{/}=chords {red-fg}A{/}=audio {red-fg}S{/}=stems {red-fg}B{/}=bpm {red-fg}K{/}=key  |  {green-fg}✓{/}=complete",
    style: { fg: "gray" },
  });

  // Navigation
  list.key(["up", "k"], () => {
    if (selectedIdx > 0) selectedIdx--;
    if (selectedIdx < scrollOffset) scrollOffset = selectedIdx;
    dashboardView();
  });
  list.key(["down", "j"], () => {
    if (selectedIdx < songs.length - 1) selectedIdx++;
    if (selectedIdx >= scrollOffset + visible) scrollOffset = selectedIdx - visible + 1;
    dashboardView();
  });
  list.key(["enter", "space"], () => {
    if (songs[selectedIdx]) pushView("Song", () => songView(songs[selectedIdx]));
  });
  list.key(["home"], () => { selectedIdx = 0; scrollOffset = 0; dashboardView(); });
  list.key(["end"], () => { selectedIdx = songs.length - 1; scrollOffset = Math.max(0, songs.length - visible); dashboardView(); });
  list.key(["a"], () => pushView("Add Songs", addSongsView));
  list.key(["d"], () => pushView("Demucs", demucsView));
  list.key(["r"], () => { songs = loadSongs(); dashboardView(); });
  list.key(["u"], () => pushView("UG Import", ugImportView));
  list.key(["i"], () => pushView("Quick Import", addSongsView));

  list.focus();
}

// ═══════════════════════════════════════════════════════════
// VIEW: SONG DETAIL
// ═══════════════════════════════════════════════════════════

function songView(song) {
  clearScreen();
  header(`Song: ${song.name}`);

  const content = [
    `{bold}Title:{/}  ${song.title}`,
    `{bold}Artist:{/} ${song.artist}`,
    `{bold}Key:{/}    ${song.key || "{red-fg}missing{/}"}`,
    `{bold}BPM:{/}    ${song.bpm} {gray-fg}(${song.bpmSource}){/}`,
    `{bold}UG Tab:{/} ${song.ugTabId || "{red-fg}none{/}"}`,
    ``,
    `{bold}Chords:{/}  ${song.hasChords ? "{green-fg}✓{/}" : "{red-fg}✗ missing — import from UG{/}"}`,
    `{bold}Audio:{/}   ${song.hasAudio ? "{green-fg}✓{/}" : "{red-fg}✗ missing — download{/}"}`,
    `{bold}Stems:{/}   ${song.hasStems ? "{green-fg}✓{/}" : "{red-fg}✗ missing — run demucs{/}"}`,
    `{bold}BPM:{/}     ${song.hasRealBPM ? "{green-fg}✓{/}" : "{red-fg}✗ 120 (default){/}"}`,
    ``,
    `{cyan-fg}Actions:{/}`,
    `  {bold}s{/} — Run demucs stems`,
    `  {bold}b{/} — Detect BPM from audio`,
    `  {bold}d{/} — Re-download audio`,
    `  {bold}Enter{/} — Edit key`,
  ].join("\n");

  // Show first few lines of chopro
  const choproPath = path.join(SONGS_DIR, song.name, "song.chopro");
  if (fs.existsSync(choproPath)) {
    const lines = fs.readFileSync(choproPath, "utf-8").split("\n").slice(0, 8).join("\n");
    content += `\n\n{cyan-fg}ChordPro preview:{/}\n{gray-fg}${lines}{/}`;
  }

  const box = blessed.box({
    parent: screen,
    top: 3, left: 0, width: "100%", height: "100%-5",
    content,
    border: { type: "line", fg: "white" },
    scrollable: true,
    keys: true,
    vi: true,
    style: { fg: "white" },
    padding: { left: 2, top: 1 },
  });

  helpBar();

  box.key(["s"], () => {
    runDemucs([song.name]);
    box.setContent(content + "\n\n{yellow-fg}Running demucs in background...{/}");
    screen.render();
  });
  box.key(["b"], () => {
    runBPM(song.name);
    box.setContent(content + "\n\n{yellow-fg}Detecting BPM...{/}");
    screen.render();
  });
  box.key(["d"], () => {
    runDownload(song.name, song.artist, song.title);
    box.setContent(content + "\n\n{yellow-fg}Downloading audio...{/}");
    screen.render();
  });
  box.key(["enter"], () => {
    editKey(song);
  });

  box.focus();
}

function editKey(song) {
  const prompt = blessed.textbox({
    parent: screen,
    border: "line",
    height: 3,
    width: 30,
    top: "center",
    left: "center",
    label: " Edit Key ",
    value: song.key || "",
    keys: true,
    vi: true,
    inputOnFocus: true,
  });
  prompt.readInput((err, value) => {
    if (value !== undefined) {
      const p = path.join(SONGS_DIR, song.name, "meta.json");
      if (fs.existsSync(p)) {
        const meta = JSON.parse(fs.readFileSync(p, "utf-8"));
        meta.key = value.trim();
        fs.writeFileSync(p, JSON.stringify(meta, null, 2));
      }
    }
    prompt.destroy();
    pushView("Song", () => songView(song));
  });
  prompt.focus();
}

// ═══════════════════════════════════════════════════════════
// VIEW: ADD SONGS
// ═══════════════════════════════════════════════════════════

function addSongsView() {
  clearScreen();
  header("Add Songs");

  const textarea = blessed.textarea({
    parent: screen,
    top: 3, left: 0, width: "100%", height: "60%",
    border: { type: "line", fg: "white" },
    label: " Paste songs (one per line: Artist — Title) ",
    keys: true,
    vi: true,
    inputOnFocus: true,
    style: { fg: "white" },
  });

  const status = blessed.box({
    parent: screen,
    top: "60%+1", left: 0, width: "100%", height: 3,
    content: "{gray-fg}Paste one song per line:  Artist — Title{/}\nPress {bold}Enter{/} to start import",
    style: { fg: "white" },
  });

  const btn = blessed.button({
    parent: screen,
    bottom: 1, left: "center", width: 20, height: 3,
    content: " Import ",
    border: { type: "line", fg: "green" },
    style: { fg: "green", focus: { fg: "black", bg: "green" } },
    keys: true,
    vi: true,
  });

  helpBar();

  btn.on("press", () => {
    const text = textarea.getValue();
    if (!text.trim()) return;

    const tmpFile = "/tmp/tui-import-songs.txt";
    fs.writeFileSync(tmpFile, text);
    status.setContent("{yellow-fg}Importing... (check terminal output){/}");
    screen.render();

    const proc = spawn("python3", [path.join(TOOLS_DIR, "import-songs.py"), "--file", tmpFile], {
      stdio: "inherit",
      cwd: path.join(TOOLS_DIR, ".."),
    });
    proc.on("close", () => {
      status.setContent("{green-fg}Done! Press r in dashboard to refresh.{/}");
      screen.render();
    });
  });

  textarea.key(["escape"], () => popView());
  btn.key(["escape"], () => popView());
  textarea.focus();
}

// ═══════════════════════════════════════════════════════════
// VIEW: DEMUCS (stem separation)
// ═══════════════════════════════════════════════════════════

function demucsView() {
  clearScreen();
  songs = loadSongs();
  header("Run Demucs — Stem Separation");

  const needStems = songs.filter(s => s.hasAudio && !s.hasStems);
  const haveStems = songs.filter(s => s.hasStems);

  const content = [
    `{bold}Songs needing stems:{/} {yellow-fg}${needStems.length}{/}`,
    `{bold}Songs with stems:{/}    {green-fg}${haveStems.length}{/}`,
    ``,
    `{cyan-fg}Options:{/}`,
    `  {bold}a{/} — Run demucs on ALL songs needing stems (${needStems.length})`,
    `  {bold}s{/} — Run demucs on SELECTED songs only (press s then pick)`,
  ].join("\n");

  if (needStems.length > 0) {
    content += `\n\n{yellow-fg}First 10 needing stems:{/}\n`;
    for (const s of needStems.slice(0, 10)) {
      content += `  ${s.name}\n`;
    }
    if (needStems.length > 10) content += `  ... and ${needStems.length - 10} more\n`;
  }

  const box = blessed.box({
    parent: screen,
    top: 3, left: 0, width: "100%", height: "100%-5",
    content,
    border: { type: "line", fg: "white" },
    scrollable: true,
    keys: true,
    vi: true,
    style: { fg: "white" },
    padding: { left: 2, top: 1 },
  });

  helpBar();

  box.key(["a"], () => {
    box.setContent(content + "\n\n{yellow-fg}Starting demucs for all {/}{bold}" + needStems.length + "{/}{yellow-fg} songs...{/}");
    screen.render();
    runDemucs(needStems.map(s => s.name));
    box.setContent(content + "\n\n{green-fg}Demucs running in background. Check terminal for progress.{/}");
    screen.render();
  });

  box.focus();
}

// ═══════════════════════════════════════════════════════════
// VIEW: UG IMPORT
// ═══════════════════════════════════════════════════════════

function ugImportView() {
  clearScreen();
  header("Import from Ultimate Guitar");

  const content = [
    `{cyan-fg}UPCOMING: Pulls chord charts for songs you've liked/favorited on UG.{/}`,
    ``,
    `This will:`,
    `  1. Open your browser (uses saved UG session)`,
    `  2. Find ALL songs in your UG "My Tabs"`,
    `  3. Download chord charts + metadata for any NEW songs`,
    `  4. Create song.chopro + meta.json in your library`,
    `  5. Skip songs already in your library (by ug_tab_id)`,
    ``,
    `{bold}Tip:{/} Before running, go to ultimate-guitar.com and like/favorite`,
    `any songs you want to import. Then come back here and run.`,
    ``,
    `  {bold}Enter{/} — Start import   {bold}p{/} — Import by playlist ID`,
    `  {bold}b{/} — Add songs to UG playlist first (Chrome automation)`,
  ].join("\n");

  const box = blessed.box({
    parent: screen,
    top: 3, left: 0, width: "100%", height: "100%-5",
    content,
    border: { type: "line", fg: "white" },
    keys: true, vi: true,
    style: { fg: "white" },
    padding: { left: 2, top: 1 },
  });

  helpBar();

  box.key(["enter"], () => {
    box.setContent(content + "\n\n{yellow-fg}Launching UG import... check browser window.\nThis scans your My Tabs and imports new songs.{/}");
    screen.render();

    const proc = spawn("node", [path.join(TOOLS_DIR, "ug-import.js")], {
      stdio: "inherit",
      cwd: path.join(TOOLS_DIR, ".."),
    });
    proc.on("close", (code) => {
      const msg = code === 0 ? "{green-fg}Import complete! Press r on dashboard to refresh.{/}" : `{red-fg}Import exited with code ${code}. Check logs.{/}`;
      box.setContent(content + `\n\n${msg}`);
      screen.render();
    });
  });

  box.key(["p"], () => {
    const prompt = blessed.textbox({
      parent: screen, border: "line", height: 3, width: 30,
      top: "center", left: "center", label: " Playlist ID ",
      keys: true, vi: true, inputOnFocus: true,
    });
    prompt.readInput((err, value) => {
      prompt.destroy();
      if (value && value.trim()) {
        box.setContent(content + "\n\n{yellow-fg}Importing playlist...{/}");
        screen.render();
        const proc = spawn("node", [path.join(TOOLS_DIR, "ug-import.js"), "--playlist-id", value.trim()], {
          stdio: "inherit", cwd: path.join(TOOLS_DIR, ".."),
        });
        proc.on("close", (code) => {
          const msg = code === 0 ? "{green-fg}Done!{/}" : `{red-fg}Exit ${code}{/}`;
          box.setContent(content + `\n\n${msg}`);
          screen.render();
        });
      } else {
        screen.render();
      }
    });
    prompt.focus();
  });

  box.key(["b"], () => {
    box.setContent(content + "\n\n{yellow-fg}Opening Chrome to add songs to UG playlist...{/}\n{gray-fg}(Paste songs in the format: Artist — Title){/}");
    screen.render();

    const tempFile = "/tmp/tui-ug-add.txt";
    const defaultSongs = [
      "# Paste songs below (Artist — Title), one per line, then save",
      "# The script will search UG and add each to your playlist",
      "# Example:",
      "# Eagles — Hotel California",
      "# The Beatles — Hey Jude",
      "",
    ].join("\n");
    fs.writeFileSync(tempFile, defaultSongs);

    const proc = spawn("open", ["-a", "TextEdit", tempFile], { stdio: "inherit" });
    setTimeout(() => {
      const prompt = blessed.textbox({
        parent: screen, border: "line", height: 3, width: 40,
        top: "center", left: "center",
        label: " Type 'go' when ready ",
        keys: true, vi: true, inputOnFocus: true,
      });
      prompt.readInput((err, value) => {
        prompt.destroy();
        if (value && value.trim().toLowerCase() === "go") {
          box.setContent(content + "\n\n{yellow-fg}Adding songs to UG playlist...{/}");
          screen.render();
          const proc2 = spawn("node", [path.join(TOOLS_DIR, "add-to-ug-playlist.js"), "--file", tempFile], {
            stdio: "inherit", cwd: path.join(TOOLS_DIR, ".."),
          });
          proc2.on("close", (code) => {
            const msg = code === 0 ? "{green-fg}Done! Now run import (press Enter).{/}" : `{red-fg}Exit ${code}{/}`;
            box.setContent(content + `\n\n${msg}`);
            screen.render();
          });
        } else {
          screen.render();
        }
      });
      prompt.focus();
    }, 1000);
  });

  box.focus();
}

// ═══════════════════════════════════════════════════════════
// BACKGROUND TASKS
// ═══════════════════════════════════════════════════════════

function runDemucs(songNames) {
  const tmp = "/tmp/tui-demucs-list.txt";
  fs.writeFileSync(tmp, songNames.join("\n"));
  // Use the audio pipeline with stems, just for these songs
  const proc = spawn("python3", [path.join(TOOLS_DIR, "audio-pipeline.py"), "--stems"], {
    stdio: "inherit",
    cwd: path.join(TOOLS_DIR, ".."),
  });
}

function runBPM(songName) {
  const proc = spawn("python3", [path.join(TOOLS_DIR, "audio-pipeline.py"), "--bpm-only", "--song", songName], {
    stdio: "inherit",
    cwd: path.join(TOOLS_DIR, ".."),
  });
}

function runDownload(songName, artist, title) {
  const proc = spawn("python3", [path.join(TOOLS_DIR, "audio-pipeline.py"), "--song", songName], {
    stdio: "inherit",
    cwd: path.join(TOOLS_DIR, ".."),
  });
}

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════

pushView("Dashboard", dashboardView);
screen.render();
