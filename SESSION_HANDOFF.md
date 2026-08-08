# SESSION HANDOFF — Live Show Manager Stage HUD

**Resume point:** `BUILD_LOG.md` (top entry) — but read THIS file first for the
critical requirement and the short version.

**⚠️ CRITICAL: This work MUST be resumed/continued by an IMAGE-CAPABLE model.**
The open items are RENDERING/VISUAL defects on the stage HUD. Text-only DOM
inspection cannot close them — you must take screenshots and LOOK at them.

---

## 1. The system (memorize — don't reinvent)

| Component | Path | Port | Role |
|-----------|------|------|------|
| REAPER | `~/Library/Application Support/REAPER/Scripts/Live Show Manager/` | — | Guitar FX chain only (delay needs BPM). Never touch transport. |
| LSM server | `web/server.js` | **:3000** | Show brain: localPlay, ARM/PLAY/STOP, count-in, lyric timing. launchd: `web/control.sh`. |
| Singer server + TUI | `~/Music/iPhoneLiveServer/` | **:3300** | Singer queue, band set, TUI (`scripts/tui.js`). |
| Stage HUD + phone | `~/Documents/projects/live-stage-hud/web/public/` | served by :3000 | `hud.html/css/js`, `controller.js`. **Symlinked** into :3000 public dir. |
| Songs | `~/ReaperSongs/<Song>/{meta.json,song.chopro}` | — | `@time=N` = LRCLIB lyric seconds. |

**Akai Force** = the real click/transport master (not yet integrated).

## 2. Show flow (final, working)

1. Song ends → next song's lyrics LOAD but do NOT start; BPM stays previous.
2. PLAY / NEXT → BPM switches to loaded song, **count-in 4→3→2→1** (position held
   at 0 during count-in), then position clock starts.
3. Lyrics scroll at `@time` seconds.

## 3. Proven working (don't re-debug)

- `cd web && npm test` → **27/27**
- `node tools/prove-it.js` → ~75 checks
- `node tools/test-show-ready.js` → 39 checks, exit 0
- Count-in fires from all play paths; position held at 0 during count-in.
- Metadata 3x @1080p: SONG/KEY/BPM = 60px, NEXT = 30px.
- Chords: clean (no `[brackets]`), per-root Circle-of-5ths colors. Requires
  config `chord_color_mode: circle` (was `flavor`=all-yellow = "chords gone").
- Sync warning in-flow (no overlap), heartbeat banner quiet (3s keepalive).
- Durations correct via `lrc_duration_sec`.

## 4. ⚠️ REMAINING WORK — RENDER/VISUAL (needs IMAGE EYES)

User reports the stage HUD still does not look right ON SCREEN. Confirmed DOM-level
progress (timeline C1 95%→32%, count-in present, ring removed, sync warn moved)
but **see it visually before declaring done**:

1. **Section bar / timeline** — suspected wrong proportions. Check
   `#hudSections` / `.timeline-block` while a song plays. Section data from
   `web/server.js computeSections()`; many songs have sparse `meta.lyrics`
   (≤2 entries) → `sectionsFromChordpro()` distributes badly.
2. **Layout/overlap @1080p** — metadata is now 3x huge; verify nothing overlaps,
   especially long song names vs the bar/conductor widgets.
3. **Count-in overlay** — confirm it actually appears on the real display.
4. **Full-frame sanity** — no clipping / blank / misaligned zones.

## 5. How to screenshot (image model must do this)

```bash
cd web
node -e '
const puppeteer = require("puppeteer");
(async()=>{
  const b=await puppeteer.launch({headless:true});
  const p=await b.newPage();
  await p.setViewport({width:1920,height:1080});
  await p.goto("http://localhost:3000/hud.html",{waitUntil:"networkidle0"});
  await fetch("http://localhost:3000/api/control/arm",{method:"POST",headers:{"content-type":"application/json"},body:"{\"armed\":true}"});
  await fetch("http://localhost:3000/api/control/play",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
  await new Promise(r=>setTimeout(r,5000));
  await p.screenshot({path:"/tmp/hud-live.png"});
  await b.close();
})();'
```

Then open `/tmp/hud-live.png` with a vision-capable tool and iterate.

## 6. Live state at handoff

- :3000 bridge up (launchd), :3300 singer up, TUI up in a real Terminal window
  (needs TTY; cannot be spawned headlessly).
- Bridge: After Midnight, armed=true, playing=false. Singer: A Boy Named Sue.
- Debug dashboard: `http://localhost:3000/debug.html` (Bridge/Singer/TUI + checks).
- Known WARNs (song-data, not code): some songs flagged "estimated" timing.

## 7. Git

Both pushed to GitHub `main`:
- `PlaceholderDuo/live-show-manager`
- `PlaceholderDuo/live-stage-hud`

## 8. Next-session TODO

1. Screenshot hud.html while playing → LOOK → fix visual/layout.
2. Optionally improve section detection to use real @bar positions for all songs.
3. Keep `chord_color_mode: circle`.
4. (Future) Akai Force MIDI-clock integration for click/transport.
5. Re-run the three test commands after any change.