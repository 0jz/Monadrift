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

// Identity: set once at registration (index.html), persists across lobby
// selection and into the race — this is "who you are", separate from
// "which race you're currently in".
function saveIdentity(playerId, address) {
  sessionStorage.setItem("monadrift.playerId", playerId);
  sessionStorage.setItem("monadrift.address", address);
}

function loadIdentity() {
  return {
    playerId: sessionStorage.getItem("monadrift.playerId"),
    address: sessionStorage.getItem("monadrift.address"),
  };
}

// Race session: set once a lobby is created/joined (lobby.html or a QR join).
function saveRace(raceId) {
  sessionStorage.setItem("monadrift.raceId", raceId);
}

function loadSession() {
  return {
    ...loadIdentity(),
    raceId: sessionStorage.getItem("monadrift.raceId"),
  };
}
