// Shared between index.html (join) and race.html (gameplay) — no bundler,
// so this is just a plain script both pages include. See PROJECT.md §8.

// Locally, the backend serves these pages itself (same origin). Deployed
// to Vercel, there's no backend at that origin at all — this points the
// deployed frontend at the Railway-hosted backend instead. Stable URL,
// no tunnel involved (previously this was a localtunnel URL that had to
// be updated by hand every time the tunnel dropped — see git history if
// curious how much of a problem that was).
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const REMOTE_BACKEND = "https://monadrift-backend-production.up.railway.app";
const API = LOCAL_HOSTS.includes(location.hostname) ? location.origin : REMOTE_BACKEND;
const WS_BASE = API.replace(/^http/, "ws");

// The free tunnel backing the deployed frontend drops individual requests
// occasionally (shows up as "NetworkError"/"Failed to fetch" — the request
// never reaches the server at all). Retrying only when fetch() itself
// throws is the safe scope: a request that got a real response (even an
// error one) is never retried here, so this can't double-submit a move
// that actually landed.
async function api(path, opts, retriesLeft = 2) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      headers: {
        "Content-Type": "application/json",
        "bypass-tunnel-reminder": "true", // avoids localtunnel's interstitial warning page on first visit
      },
      ...opts,
    });
  } catch (networkErr) {
    if (retriesLeft > 0) {
      await new Promise((r) => setTimeout(r, 600));
      return api(path, opts, retriesLeft - 1);
    }
    throw networkErr;
  }
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
