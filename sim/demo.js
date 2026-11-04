// Keyboard time-trial on the deterministic sim. Rendering uses floats and trig;
// the simulation itself (sim.js) never does, so replays stay bit-exact.
import { generateTrack, SECTION_LEN, SECTIONS, HALF_WIDTH } from "./track.js";
import { createState, step, encodeInput, observe, runReplay, stateHash, TICK_MS, V_MAX } from "./sim.js";

const $ = (id) => document.getElementById(id);
const canvas = $("c");
const ctx = canvas.getContext("2d");
const ANGLE_PER_CURVE = 0.12; // radians per section per curvature level (cosmetic)
const MM_PER_PX = 150;
const FOG_SECTIONS = 8; // how far ahead the road is drawn

let track, st, log, geom, acc, last, verified, best = null;

function buildGeometry() {
  geom = [];
  let x = 0, y = 0, th = -Math.PI / 2;
  for (let i = 0; i < SECTIONS; i++) {
    geom.push({ x, y, th });
    const dth = track.curv[i] * ANGLE_PER_CURVE;
    x += Math.cos(th + dth / 2) * SECTION_LEN;
    y += Math.sin(th + dth / 2) * SECTION_LEN;
    th += dth;
  }
  geom.push({ x, y, th });
}

function pose(s) {
  const i = Math.min(SECTIONS - 1, Math.floor(s / SECTION_LEN));
  const f = (s - i * SECTION_LEN) / SECTION_LEN;
  const g = geom[i];
  const dth = track.curv[i] * ANGLE_PER_CURVE;
  return {
    x: g.x + Math.cos(g.th + (dth * f) / 2) * SECTION_LEN * f,
    y: g.y + Math.sin(g.th + (dth * f) / 2) * SECTION_LEN * f,
    th: g.th + dth * f,
  };
}

const edge = (p, d) => ({ x: p.x - Math.sin(p.th) * d, y: p.y + Math.cos(p.th) * d }); // +d = right

function reset() {
  track = generateTrack(Number($("seed").value) >>> 0);
  buildGeometry();
  st = createState();
  log = [];
  acc = 0;
  last = performance.now();
  verified = null;
}

const keys = new Set();
addEventListener("keydown", (e) => { keys.add(e.key.toLowerCase()); if (e.key.startsWith("Arrow")) e.preventDefault(); });
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
$("restart").onclick = reset;
$("seed").onchange = reset;

function readInput() {
  const left = keys.has("arrowleft") || keys.has("a");
  const right = keys.has("arrowright") || keys.has("d");
  return {
    steer: (right ? 1 : 0) - (left ? 1 : 0),
    throttle: keys.has("arrowup") || keys.has("w") ? 1 : 0,
    brake: keys.has("arrowdown") || keys.has("s") ? 1 : 0,
  };
}

function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", resize);

function draw() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const car = pose(st.s);
  const idx = Math.min(SECTIONS - 1, Math.floor(st.s / SECTION_LEN));

  ctx.save();
  ctx.translate(w / 2, h * 0.72);
  ctx.rotate(-car.th - Math.PI / 2);
  ctx.scale(1 / MM_PER_PX, 1 / MM_PER_PX);
  ctx.translate(-car.x, -car.y);

  const first = Math.max(0, idx - 1), lastSec = Math.min(SECTIONS - 1, idx + FOG_SECTIONS);
  for (let i = first; i <= lastSec; i++) {
    const a = i * SECTION_LEN, SUB = 4;
    const fog = Math.max(0.12, 1 - Math.max(0, i - idx) / (FOG_SECTIONS + 1));
    for (let q = 0; q < SUB; q++) {
      const p0 = pose(a + (SECTION_LEN * q) / SUB), p1 = pose(a + (SECTION_LEN * (q + 1)) / SUB);
      const l0 = edge(p0, -HALF_WIDTH), r0 = edge(p0, HALF_WIDTH), l1 = edge(p1, -HALF_WIDTH), r1 = edge(p1, HALF_WIDTH);
      const bend = Math.min(1, Math.abs(track.curv[i]) / 4);
      ctx.fillStyle = track.boost[i] ? `rgba(67,224,201,${0.35 * fog})` : `rgba(${46 + 80 * bend},${51},${80 + 60 * bend},${fog})`;
      ctx.beginPath();
      ctx.moveTo(l0.x, l0.y); ctx.lineTo(r0.x, r0.y); ctx.lineTo(r1.x, r1.y); ctx.lineTo(l1.x, l1.y); ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = `rgba(217,255,63,${fog})`;
      ctx.lineWidth = 120;
      ctx.beginPath(); ctx.moveTo(l0.x, l0.y); ctx.lineTo(l1.x, l1.y); ctx.moveTo(r0.x, r0.y); ctx.lineTo(r1.x, r1.y); ctx.stroke();
    }
  }
  if (lastSec === SECTIONS - 1) { // finish line
    const e = pose(SECTIONS * SECTION_LEN - 1), l = edge(e, -HALF_WIDTH), r = edge(e, HALF_WIDTH);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 300; ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.stroke();
  }

  // car
  const c = edge(car, st.d);
  ctx.translate(c.x, c.y);
  ctx.rotate(car.th + Math.PI / 2);
  ctx.fillStyle = st.finishTick >= 0 ? "#43e0c9" : "#d9ff3f";
  ctx.beginPath(); ctx.moveTo(0, -1500); ctx.lineTo(900, 1100); ctx.lineTo(-900, 1100); ctx.closePath(); ctx.fill();
  ctx.restore();

  if (st.finishTick >= 0) {
    ctx.fillStyle = "rgba(13,14,18,0.8)";
    ctx.fillRect(w / 2 - 230, h / 2 - 70, 460, 140);
    ctx.fillStyle = "#e8e8ee";
    ctx.textAlign = "center";
    ctx.font = "20px ui-monospace, Consolas, monospace";
    ctx.fillText(`finished ${((st.finishTick * TICK_MS) / 1000).toFixed(2)}s · walls ${st.wallHits}`, w / 2, h / 2 - 20);
    ctx.font = "13px ui-monospace, Consolas, monospace";
    ctx.fillText(verified ? `replay verified · state hash ${verified.toString(16).padStart(8, "0")}` : "verifying…", w / 2, h / 2 + 8);
    ctx.fillText("press restart to go again", w / 2, h / 2 + 40);
    ctx.textAlign = "start";
  }
}

function frame(now) {
  acc += Math.min(250, now - last);
  last = now;
  while (acc >= TICK_MS && st.finishTick < 0) {
    const input = encodeInput(readInput());
    log.push(input);
    step(st, track, input);
    acc -= TICK_MS;
    if (st.finishTick >= 0) {
      const r = runReplay(track, log);
      verified = r.hash === stateHash(st) ? r.hash : null;
      const t = st.finishTick * TICK_MS / 1000;
      if (verified && (best === null || t < best)) best = t;
    }
  }
  if (st.finishTick >= 0) acc = 0;
  $("t").textContent = `${((st.tick * TICK_MS) / 1000).toFixed(2)}s`;
  $("spd").textContent = `${Math.round((st.v * 3.6) / 1000)} km/h (max ${Math.round((V_MAX * 3.6) / 1000)})`;
  $("walls").textContent = `walls ${st.wallHits}`;
  $("best").textContent = best === null ? "" : `best ${best.toFixed(2)}s`;
  draw();
  requestAnimationFrame(frame);
}

resize();
reset();
requestAnimationFrame(frame);
