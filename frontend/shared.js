// Shared between index.html (join) and race.html (gameplay) — no bundler,
// so this is just a plain script both pages include. See PROJECT.md §8.

const API = location.origin; // backend serves these pages too, see backend/src/index.js static mount
const WS_BASE = API.replace(/^http/, "ws");

async function api(path, opts) {
  const res = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function saveSession(playerId, raceId, mode) {
  sessionStorage.setItem("monadrift.playerId", playerId);
  sessionStorage.setItem("monadrift.raceId", raceId);
  sessionStorage.setItem("monadrift.mode", mode);
}

function loadSession() {
  return {
    playerId: sessionStorage.getItem("monadrift.playerId"),
    raceId: sessionStorage.getItem("monadrift.raceId"),
    mode: sessionStorage.getItem("monadrift.mode"),
  };
}
