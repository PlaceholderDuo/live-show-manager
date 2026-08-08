"use strict";
// Spawns a fresh LSM server child process on temp ports with a temp bridge
// file, and waits until it is serving. Returns helpers to stop it and read
// current /api/state.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVER = path.join(__dirname, "..", "..", "server.js");

function freeish(base) {
  return base + Math.floor(Math.random() * 1000);
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not come up at ${url}`);
}

async function spawnServer(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsm-test-"));
  const bridgePath = path.join(tmpDir, "bridge_state.json");
  const setlistPath = path.join(tmpDir, "_last_session.json");
  // Create the temp setlists dir so the server doesn't write to production
  fs.mkdirSync(path.join(tmpDir, "setlists"), { recursive: true });

  const apiPort = opts.apiPort || freeish(3310);
  const oscIn = opts.oscIn || freeish(9150);
  const oscOut = opts.oscOut || freeish(8150);

  const proc = spawn(process.execPath, [
    SERVER,
    "--port", String(apiPort),
    "--oscIn", String(oscIn),
    "--oscOut", String(oscOut)
  ], {
    env: { ...process.env, BRIDGE_STATE_PATH: bridgePath, SESSION_SETLIST_PATH: setlistPath },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let log = "";
  let logAppended = "";
  proc.stdout.on("data", (d) => { log += d; logAppended += d; });
  proc.stderr.on("data", (d) => { log += d; logAppended += d; });

  const baseUrl = `http://127.0.0.1:${apiPort}`;

  try {
    await waitForHttp(`${baseUrl}/api/state`);
  } catch (err) {
    try { proc.kill("SIGKILL"); } catch (_) {}
    throw new Error(`${err.message}\n--- server log ---\n${log}`);
  }

  return {
    apiPort,
    baseUrl,
    bridgePath,
    proc,
    log,
    readLog() {
      const d = logAppended; logAppended = ""; return d;
    },
    getState: async () => {
      const res = await fetch(`${baseUrl}/api/state`);
      return res.json();
    },
    async stop() {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await new Promise((resolve) => {
          const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} resolve(); }, 3000);
          proc.on("exit", () => { clearTimeout(t); resolve(); });
        });
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  };
}

module.exports = { spawnServer, waitForHttp };