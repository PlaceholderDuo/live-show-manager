# Test harness — Live Show Manager bridge

Headless test suite that lets you (and Claude) drive the full transport/tempo
stack exactly like a live show, without REAPER. It runs real Chrome UI tests too.

Run everything:

```bash
npm test
# or
node --test tests/transport.test.js tests/browser.test.js
```

## How it works

```
MockTransport (writes bridge_state.json)   ← stands in for REAPER + bridge.lua
        │  (position, playing, bpm, time_sig, songId, …)
        ▼
LSM server (spawned on a random port, temp bridge file)  ← server.js
        │  polls every 500ms, broadcasts via Socket.IO
        ▼
Test assertions: REST (/api/state, /api/tempo), WS broadcasts
Real browser: puppeteer + Chrome renders hud.html / teleprompter.html
```

Key pieces:

- **`tests/lib/mock-transport.js`** — writes `bridge_state.json` (via the
  `BRIDGE_STATE_PATH` env override) on a 200ms heartbeat so the server's
  5s-active check passes. `set({…})` updates fields, `walk(secs, bpm)`
  advances position like playback, `close()` stops it.
- **`tests/lib/spawn-server.js`** — boots a fresh `server.js` child on random
  ports (`--port/--oscIn/--oscOut`) with a temp bridge file, waits until
  `/api/state` responds, and returns `getState()`, `readLog()`, `stop()`.
  Uses the `BRIDGE_STATE_PATH` env override so tests never touch the live
  `data/bridge_state.json`.
- **`tests/transport.test.js`** — tempo/transport authority, headless:
  - `/api/state` returns the `tempo` block + `timeSig` with CORS `*`
  - `POST /api/tempo` + WS `set_tempo` accept an external clock (link/Force)
  - mock REAPER `bpm`/`time_sig`/`playing`/`songId` are ingested
  - 4-tap run locks Beat-1 at the first tap (Force-style), rev 1
  - extra taps refine BPM but never re-anchor; long pause → fresh run → rev 2
  - song change falls back to REAPER grid and clears the tap anchor
- **`tests/browser.test.js`** — real-UI UX, via puppeteer + Chrome:
  - **HUD conductor** updates BAR/BEAT live from mock-driven state
  - a real WS 4-tap run keeps the conductor alive (no page errors)
  - **teleprompter count-in** starts on the REAPER play edge and counts 4→1,
    using a tiny static server that serves `teleprompter.html` and stubs its
    relative `/api/*` endpoints; the page is pointed at the mock transport with
    `?transportHost=127.0.0.1:<port>`.

## Be more in the loop — how to observe / extend

- **See current state** at any moment: `curl localhost:<port>/api/state`.
- **Watch broadcasts**: connect a socket.io client and log every `state` event
  (see the `seen` pattern in `transport.test.js`).
- **Drive a fake show**: `mt.set({ playing:true, bpm:146, … })` then assert
  whatever a client renders.
- **New server seams**: `BRIDGE_STATE_PATH` env override; random-port boot;
  `readLog()` for server stdout. Follow the same pattern for new endpoints.
- **New UI flows**: copy the puppeteer pattern — `page.goto`, drive the mock or
  WS actions, then assert DOM. `page.on("pageerror")` catches real bugs.

- **`tests/live-check.js`** — *manual* live-rig check (not in `npm test`). Requires
  the real singer (:3300) + live bridge (:3000); writes a synthetic
  `bridge_state.json` to the live path briefly to simulate REAPER playback, verifies
  the teleprompter counts 4→1 in a real browser, then removes the file.
  ```bash
  npm start &          # real bridge (or launchd as usual)
  node server/index.js # singer (:3300), in ~/Music/iPhoneLiveServer
  node tests/live-check.js
  ```

## Conventions / gotchas

- Tests spawn their own servers on random ports; the live `:3000` server is
  never touched.
- `waitForBroadcast` only scans broadcasts after the current test's `beforeEach`
  reset, so stale state can't satisfy an assertion.
- Keep taps within the 1.5s run window for anchoring tests; sleep >1.6s to start
  a fresh run.
- The teleprompter's `?transportHost=` override is a production query param
  (defaults to `location.hostname:3000`), so tests can point it anywhere.
