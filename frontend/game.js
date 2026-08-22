const el = (id) => document.getElementById(id);
const log = (msg) => {
  const box = el("log");
  box.textContent += `${msg}\n`;
  box.scrollTop = box.scrollHeight;
};

const { playerId, address, raceId } = loadSession();
if (!playerId || !raceId) {
  location.href = "index.html";
}
el("playerPill").textContent = displayLabel();

let isActivePlayer = false; // gates sendMove — see validateActivePlayer()

let ws = null;

const SEGMENT_COLORS = {
  STRAIGHT: "#2e3350",
  TURN: "#7c5cff",
  OBSTACLE: "#ff5c7a",
  BOOST: "#43e0c9",
};
let knownSegments = []; // sparse, filled in as revealed
let myPosition = 0;

const canvas = el("track");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTrack();
}
window.addEventListener("resize", resizeCanvas);

// The road as a 2D array of points, not a straight line of tiles: each
// segment index maps to an (x, y) offset from three layered sine waves at
// different frequencies/amplitudes — a cheap, deterministic stand-in for
// Perlin noise. Purely cosmetic (not tied to the on-chain seed, since the
// actual gameplay path is still just LEFT/CENTER/RIGHT per segment) — this
// only changes how the same logical track is drawn.
function roadPoint(i, tileW, tileH) {
  const y =
    Math.sin(i * 0.22) * tileH * 1.4 +
    Math.sin(i * 0.07 + 1.7) * tileH * 2.2 +
    Math.sin(i * 0.5 + 0.4) * tileH * 0.35;
  const xJitter = Math.sin(i * 0.31 + 0.9) * tileW * 0.08;
  return { dx: tileW * 0.66 + xJitter, dy: y };
}

function drawTrack() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const tileW = Math.max(46, Math.min(72, w / 15));
  const tileH = tileW * 0.55;
  const originX = tileW * 0.7;
  const originY = h / 2;
  const laneWobble = tileH * 0.18;
  const visibleFrom = Math.max(0, myPosition - 2);
  const count = Math.ceil(w / (tileW * 0.66)) + 2;

  // Precompute the curved points for every visible segment first — the
  // road ribbon (drawn below, before the tiles) needs the full point list
  // to draw one continuous curve rather than per-tile straight hops.
  const points = [];
  let cx = originX, cy = originY;
  for (let i = visibleFrom; i < visibleFrom + count; i++) {
    if (i > visibleFrom) {
      const { dx, dy } = roadPoint(i, tileW, tileH);
      cx += dx;
      cy = originY + dy;
    }
    points.push({ i, x: cx, y: cy });
  }

  // The road surface itself — a soft ribbon threaded through the tile
  // centers via quadratic curves, so it reads as one winding road instead
  // of floating diamonds in a line.
  if (points.length > 1) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let k = 1; k < points.length - 1; k++) {
      const mx = (points[k].x + points[k + 1].x) / 2;
      const my = (points[k].y + points[k + 1].y) / 2;
      ctx.quadraticCurveTo(points[k].x, points[k].y, mx, my);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.strokeStyle = "#1c1e2a";
    ctx.lineWidth = tileH * 1.35;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }

  for (const p of points) {
    const { i, x } = p;
    const seg = knownSegments[i];
    const y = p.y + (i % 2 === 0 ? -laneWobble : laneWobble);

    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, -tileH / 2);
    ctx.lineTo(tileW / 2, 0);
    ctx.lineTo(0, tileH / 2);
    ctx.lineTo(-tileW / 2, 0);
    ctx.closePath();

    if (seg) {
      ctx.fillStyle = SEGMENT_COLORS[seg.type];
      ctx.shadowColor = SEGMENT_COLORS[seg.type];
      ctx.shadowBlur = 14;
    } else {
      ctx.fillStyle = "#171926";
      ctx.shadowBlur = 0;
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#05060a";
    ctx.lineWidth = 1;
    ctx.stroke();

    if (seg?.isCheckpoint) {
      ctx.beginPath();
      ctx.arc(0, 0, tileH * 0.14, 0, Math.PI * 2);
      ctx.strokeStyle = "#eef0fa";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (i === myPosition) {
      ctx.beginPath();
      ctx.arc(0, 0, tileH * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = "#eef0fa";
      ctx.fill();
    }

    ctx.restore();
  }
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
    if (msg.type === "started") {
      if (isActivePlayer) hideWaiting();
      return;
    }
    if (msg.type === "move" && msg.playerId === playerId) {
      myPosition = msg.position;
      el("hudPos").textContent = msg.position;
      el("hudHp").textContent = msg.hp;
      el("hudSpeed").textContent = msg.speed;
      el("hudStake").textContent = `${weiToMon(msg.stake)} MON`;
      el("hudLatency").textContent = `${msg.latencyMs}ms`;
      revealNext();
      drawTrack();
    }
    if (msg.type === "move") {
      log(`${msg.playerId} -> segment ${msg.position} (${msg.latencyMs}ms)`);
    }
  };
}

async function sendMove(direction, button) {
  if (!isActivePlayer) return; // validateActivePlayer() already explained why, in the log
  button?.classList.add("pressed");
  setTimeout(() => button?.classList.remove("pressed"), 120);
  try {
    await api(`/race/${raceId}/move`, {
      method: "POST",
      body: JSON.stringify({ playerId, direction }),
    });
  } catch (err) {
    log(`Move failed: ${err.message}`);
    // A move can fail because you're genuinely out (broke/wrecked past
    // recovery) — re-check instead of letting every further click/keypress
    // retry a call that can never succeed.
    await validateActivePlayer();
  }
}

/// Confirms this browser session is actually a live, alive participant in
/// `raceId` before letting it attempt moves. Without this, a stale raceId
/// left over from an earlier session (e.g. a join that ultimately failed
/// after this page already navigated here) just silently retries a doomed
/// "not active" contract revert on every keypress.
async function validateActivePlayer() {
  try {
    const state = await api(`/race/${raceId}/state`);
    const me = state.players.find((p) => p.address.toLowerCase() === address?.toLowerCase());
    if (!me || !me.alive) {
      isActivePlayer = false;
      document.body.classList.add("race-waiting");
      log(!me ? "You're not a participant in this race (stale link?)." : "You're no longer active in this race — out of stake.");
      const back = document.createElement("button");
      back.textContent = "Back to lobby";
      back.onclick = () => (location.href = "lobby.html");
      el("log").after(back);
      return false;
    }
    isActivePlayer = true;
    return true;
  } catch (err) {
    log(`Couldn't verify race participation: ${err.message}`);
    return false;
  }
}

const laneButtons = document.querySelectorAll("#lanes button");
laneButtons.forEach((btn) => {
  btn.onclick = () => sendMove(btn.dataset.lane, btn);
});

const KEY_TO_LANE = {
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
  ArrowUp: "CENTER",
  ArrowDown: "CENTER",
};

window.addEventListener("keydown", (evt) => {
  const lane = KEY_TO_LANE[evt.key];
  if (!lane) return;
  evt.preventDefault(); // don't scroll the page on arrow keys
  const button = [...laneButtons].find((b) => b.dataset.lane === lane);
  sendMove(lane, button);
});

function showWaiting() {
  document.body.classList.add("race-waiting");
  log("Waiting for the race to start…");
}
function hideWaiting() {
  document.body.classList.remove("race-waiting");
}

async function checkPhaseAndInit() {
  if (!(await validateActivePlayer())) return;
  const state = await api(`/race/${raceId}/state`);
  if (state.phase !== 2) {
    showWaiting();
    // "started" over the WS stream (below) is the primary trigger; this
    // poll is only a fallback in case the WS message is missed.
    const poll = setInterval(async () => {
      const s = await api(`/race/${raceId}/state`);
      if (s.phase === 2) {
        clearInterval(poll);
        hideWaiting();
      }
    }, 1500);
  }
}

resizeCanvas();
connectStream();
checkPhaseAndInit();
revealNext();
