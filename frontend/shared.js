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

// Identity: set once at registration (index.html). Uses localStorage, not
// sessionStorage, so returning later (new tab, browser restart) doesn't
// force re-registering — the whole point of "remembers me". Race progress
// (below) stays in sessionStorage on purpose: a race is ephemeral, your
// identity isn't.
function saveIdentity(playerId, address) {
  localStorage.setItem("monadrift.playerId", playerId);
  localStorage.setItem("monadrift.address", address);
}

function loadIdentity() {
  return {
    playerId: localStorage.getItem("monadrift.playerId"),
    address: localStorage.getItem("monadrift.address"),
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

// Display name: cosmetic only, set at the lobby screen (not registration).
// Local to this browser session — it's a label, not part of the on-chain
// identity, so it's never sent to the backend or other players.
function saveDisplayName(name) {
  localStorage.setItem("monadrift.displayName", name);
}
function loadDisplayName() {
  return localStorage.getItem("monadrift.displayName") || "";
}

function clearIdentity() {
  localStorage.removeItem("monadrift.playerId");
  localStorage.removeItem("monadrift.address");
  localStorage.removeItem("monadrift.displayName");
  sessionStorage.removeItem("monadrift.raceId");
}

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—";
}

function displayLabel() {
  const name = loadDisplayName();
  if (name) return name;
  const { address, playerId } = loadIdentity();
  return address ? shortAddress(address) : playerId || "—";
}
