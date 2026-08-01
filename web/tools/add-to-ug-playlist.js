#!/usr/bin/env node
// add-to-ug-playlist.js — Chrome automation: bulk-add songs to a UG playlist
// ======================================================================
// Takes a text file of "Artist — Title" lines, opens Chrome, searches UG,
// and adds each song to a playlist. Uses saved UG cookies for auth.
//
// Usage:
//   node tools/add-to-ug-playlist.js --file songs.txt
//   node tools/add-to-ug-playlist.js --file songs.txt --list "My Covers"
//   echo "Eagles — Hotel California" | node tools/add-to-ug-playlist.js
//
// Flow:
//   1. Opens visible Chrome (you watch it work)
//   2. For each song: searches UG, picks best match, adds to playlist
//   3. Prints playlist ID at the end (for ug-import.js --playlist-id)

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const COOKIE_FILE = path.join(__dirname, "..", "logs", "ug-cookies.json");
const args = process.argv.slice(2);

const FILE = (() => {
  const idx = args.indexOf("--file");
  return idx >= 0 ? args[idx + 1] : null;
})();
const PLAYLIST = (() => {
  const idx = args.indexOf("--list");
  return idx >= 0 ? args[idx + 1] : "Bulk Import";
})();
const DRY_RUN = args.includes("--dry-run");

function parseSongs(text) {
  const songs = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const sep = t.includes(" — ") ? " — " : t.includes(" - ") ? " - " : null;
    if (!sep) continue;
    const [artist, title] = t.split(sep);
    songs.push({ artist: artist.trim(), title: title.trim() });
  }
  return songs;
}

async function main() {
  let songs = [];

  if (FILE) {
    songs = parseSongs(fs.readFileSync(FILE, "utf-8"));
  } else if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    songs = parseSongs(Buffer.concat(chunks).toString());
  }

  if (songs.length === 0) {
    console.log("No songs specified. Use --file songs.txt or pipe input.");
    console.log('Example: echo "Eagles — Hotel California" | node tools/add-to-ug-playlist.js');
    process.exit(1);
  }

  console.log(`Songs to add: ${songs.length}`);
  console.log(`Playlist: "${PLAYLIST}"`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);

  // Launch browser
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();

  // Restore session
  if (fs.existsSync(COOKIE_FILE)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
    await page.setCookie(...cookies);
  }

  // Navigate to UG and check login
  await page.goto("https://www.ultimate-guitar.com/", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  const body = await page.evaluate(() => document.body?.textContent || "");
  if (/sign in|log in/i.test(body)) {
    console.log("NOT LOGGED IN — please log in to Ultimate Guitar, then type 'ok' here:");
    await new Promise(r => {
      process.stdin.once("data", () => r());
    });
    const newCookies = await page.cookies();
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(newCookies, null, 2));
    console.log("Cookies saved.");
  } else {
    console.log("Already logged in.");
  }

  let added = 0, failed = 0;

  for (const [i, song] of songs.entries()) {
    const { artist, title } = song;
    const query = `${artist} ${title}`;
    console.log(`\n[${i + 1}/${songs.length}] ${artist} — ${title}`);

    if (DRY_RUN) {
      console.log("  (dry run) would search and add");
      added++;
      continue;
    }

    try {
      // Search
      await page.goto(`https://www.ultimate-guitar.com/search.php?search_type=title&value=${encodeURIComponent(query)}`, {
        waitUntil: "networkidle2", timeout: 20000,
      });
      await new Promise(r => setTimeout(r, 1500));

      // Click first chord/tab result
      const clicked = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/tab/"]');
        for (const link of links) {
          const text = link.textContent?.toLowerCase() || "";
          if (text.includes("chords") || text.includes("tab")) {
            link.click();
            return true;
          }
        }
        return false;
      });

      if (!clicked) {
        console.log("  ✗ No results found");
        failed++;
        continue;
      }

      await new Promise(r => setTimeout(r, 2000));

      // Click "Add to playlist" button
      const addBtn = await page.$('[class*="add-to-playlist"], [class*="AddToPlaylist"], button:has-text("Add to")');
      if (addBtn) {
        await addBtn.click();
        await new Promise(r => setTimeout(r, 1000));

        // Type playlist name and select/create
        const inputSelector = 'input[placeholder*="playlist"], [class*="playlist"] input';
        await page.type(inputSelector, PLAYLIST);
        await new Promise(r => setTimeout(r, 500));

        // Click the playlist option or create button
        const saved = await page.evaluate((name) => {
          // Try clicking a playlist option
          const items = document.querySelectorAll('[class*="playlist"] li, [class*="playlist"] [role="option"]');
          for (const item of items) {
            if (item.textContent.toLowerCase().includes(name.toLowerCase())) {
              item.click();
              return true;
            }
          }
          // Try create button
          const createBtn = document.querySelector('[class*="create"], button:has-text("Create")');
          if (createBtn) { createBtn.click(); return true; }
          return false;
        }, PLAYLIST);

        if (saved) {
          console.log(`  ✓ Added to "${PLAYLIST}"`);
          added++;
        } else {
          console.log("  ✗ Could not save to playlist");
          failed++;
        }
      } else {
        console.log("  ✗ No add-to-playlist button found");
        failed++;
      }
    } catch (e) {
      console.log(`  ✗ Error: ${e.message}`);
      failed++;
    }

    // Brief pause between songs
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\nDone: ${added} added, ${failed} failed.`);
  console.log(`Playlist: "${PLAYLIST}" on Ultimate Guitar`);
  console.log(`\nNext step — import into library:`);
  console.log(`  node tools/ug-import.js --playlist-id <ID>`);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
