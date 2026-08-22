// No build step on purpose — this is the demo laptop's frontend, it needs
// to just work when opened, not need a bundler installed under time pressure.
// See PROJECT.md §8 "Local hosting for the demo".

const API = location.origin; // backend serves this file too, see backend/src/index.js static mount
const WS_BASE = API.replace(/^http/, "ws");

const params = new URLSearchParams(location.search);
const presetLobby = params.get("lobby");

const el = (id) => document.getElementById(id);
const log = (msg) => {
  const box = el("log");
  box.textContent += `${msg}\n`;
  box.scrollTop = box.scrollHeight;
};

let raceId = presetLobby || null;
let playerId = null;
let ws = null;

const SEGMENT_COLORS = { STRAIGHT: "#2e3350", TURN: "#8be9fd", OBSTACLE: "#ff6188", BOOST: "#a9dc76" };
let knownSegments = []; // sparse, filled in as revealed
let myPosition = 0;

function drawTrack() {
  const canvas = el("track");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const tileW = 60, tileH = 30;
  const originX = 40, originY = canvas.height / 2;
  const visibleFrom = Math.max(0, myPosition - 2);

  for (let i = visibleFrom; i < visibleFrom + 14; i++) {
    const seg = knownSegments[i];
    const x = originX + (i - visibleFrom) * (tileW * 0.65);
    const y = originY + ((i % 2 === 0) ? -tileH * 0.15 : tileH * 0.15); // slight iso wobble
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, -tileH / 2);
    ctx.lineTo(tileW / 2, 0);
    ctx.lineTo(0, tileH / 2);
    ctx.lineTo(-tileW / 2, 0);
    ctx.closePath();
    ctx.fillStyle = seg ? SEGMENT_COLORS[seg.type] : "#1c2030";
    ctx.fill();
    ctx.strokeStyle = "#05060a";
    ctx.stroke();
    if (i === myPosition) {
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#eaeaf0";
      ctx.fill();
    }
    ctx.restore();
  }
}
drawTrack();

async function api(path, opts) {
  const res = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function revealNext() {
  const next = myPosition + 1;
  try {
    const seg = await api(`/race/${raceId}/segment/${next}?playerId=${encodeURIComponent(playerId)}`);
    knownSegments[next] = seg;
    drawTrack();
  } catch {
    // not revealed yet — fine, happens if we're behind
  }
}

function connectStream() {
  ws = new WebSocket(`${WS_BASE}/ws?raceId=${raceId}`);
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "move" && msg.playerId === playerId) {
      myPosition = msg.position;
      el("hudPos").textContent = msg.position;
      el("hudHp").textContent = msg.hp;
      el("hudSpeed").textContent = msg.speed;
      el("hudStake").textContent = msg.stake;
      el("hudLatency").textContent = `${msg.latencyMs}ms`;
      revealNext();
    }
    if (msg.type === "move") {
      log(`${msg.playerId} -> segment ${msg.position} (${msg.latencyMs}ms)`);
    }
  };
}

el("joinBtn").onclick = async () => {
  playerId = el("playerId").value.trim() || `player-${Math.random().toString(36).slice(2, 6)}`;
  const mode = el("mode").value;
  try {
    if (raceId) {
      // joining a specific lobby via QR (?lobby=) still goes through quickmatch
      // for now — a dedicated /lobby/:id/join endpoint is a natural next step.
    }
    const result = await api("/lobby/quickmatch", { method: "POST", body: JSON.stringify({ playerId, mode }) });
    raceId = result.raceId;
    log(`Joined race ${raceId} as ${playerId} (${result.playerAddress})`);
    connectStream();
    revealNext();
  } catch (err) {
    log(`Join failed: ${err.message}`);
  }
};

document.querySelectorAll("#lanes button").forEach((btn) => {
  btn.onclick = async () => {
    if (!raceId || !playerId) return log("Join a race first.");
    try {
      await api(`/race/${raceId}/move`, {
        method: "POST",
        body: JSON.stringify({ playerId, direction: btn.dataset.lane }),
      });
    } catch (err) {
      log(`Move failed: ${err.message}`);
    }
  };
});
