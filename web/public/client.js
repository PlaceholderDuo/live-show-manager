// Live Show Manager — Shared Client Library
// ==========================================
// Shared helpers used by BOTH the iPhone controller (index.html)
// AND the stage display (display.html). Keep this file small and
// dependency-free — it's loaded before the page-specific scripts.
//
// Available functions:
//   formatTime(seconds)  → "3:42"  (converts seconds to mm:ss display)
//   sendAction(type, value) → emits 'action' WebSocket event via page socket
//
// Note: sendAction relies on the page having a global `socket` variable
// (created by the page's inline script after loading this file). If `socket`
// doesn't exist yet, we queue the message for when it does.

var _actionQueue = [];

function formatTime(seconds) {
  if (!seconds || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ":" + (s < 10 ? "0" : "") + s;
}

function sendAction(type, value) {
  if (typeof socket !== "undefined" && socket && socket.emit) {
    socket.emit("action", { type, value });
  } else {
    _actionQueue.push({ type, value });
  }
}

// Drain queue once socket is available — called by page scripts after io()
function drainActionQueue(sock) {
  while (_actionQueue.length > 0) {
    const a = _actionQueue.shift();
    sock.emit("action", a);
  }
}
