// Keyboard time-trial on the deterministic sim. Rendering uses floats and trig;
// the simulation itself (sim.js) never does, so replays stay bit-exact.
//
// Smoothness: the sim runs at a fixed 40 Hz, the screen at 60-144 Hz. Each frame
// draws the car interpolated between the last two sim states, so motion is
// continuous instead of jumping once per tick. Road geometry is built once per
// track into Path2D objects; a frame only transforms and fills them.
import { generateTrack, SECTION_LEN, HALF_WIDTH, CURVE_RAD } from "./track.js";
import { createState, step, encodeInput, runReplay, stateHash, trackEnd, TICK_MS, V_MAX, CAR_HALF_WIDTH } from "./sim.js";

const $ = (id) => document.getElementById(id);
const canvas = $("c");
const ctx = canvas.getContext("2d");
const MM_PER_PX = 130; // zoom at standstill; the camera pulls back with speed
const FOG_SECTIONS = 8; // how far ahead the road is drawn
const SAMPLE = 500; // mm between precomputed centre-line points
const SKIDS = 600; // skid-mark ring buffer size

let track, st, prev, log, acc, last, verified, best = null;
let cx, cy, cth, sections; // centre line samples + per-section Path2D
let skids, skidN;

function buildGeometry() {
  const n = Math.ceil(trackEnd(track) / SAMPLE) + 1;
  cx = new Float64Array(n); cy = new Float64Array(n); cth = new Float64Array(n);
  let x = 0, y = 0, th = -Math.PI / 2;
  for (let i = 0; i < n; i++) {
    cx[i] = x; cy[i] = y; cth[i] = th;
    const k = track.curv[Math.min(track.curv.length - 1, Math.floor((i * SAMPLE) / SECTION_LEN))];
    const dth = (k * CURVE_RAD * SAMPLE) / SECTION_LEN; // same road curvature the physics uses
    x += Math.cos(th + dth / 2) * SAMPLE;
    y += Math.sin(th + dth / 2) * SAMPLE;
    th += dth;
  }
  const per = SECTION_LEN / SAMPLE;
  sections = [];
  for (let i = 0; i < track.curv.length; i++) {
    const surf = new Path2D(), edges = new Path2D();
    const a = i * per, b = Math.min(n - 1, (i + 1) * per);
    for (let j = a; j <= b; j++) { const p = edgeAt(j, -HALF_WIDTH); j === a ? surf.moveTo(p.x, p.y) : surf.lineTo(p.x, p.y); }
    for (let j = b; j >= a; j--) { const p = edgeAt(j, HALF_WIDTH); surf.lineTo(p.x, p.y); }
    surf.closePath();
    for (const side of [-HALF_WIDTH, HALF_WIDTH])
      for (let j = a; j <= b; j++) { const p = edgeAt(j, side); j === a ? edges.moveTo(p.x, p.y) : edges.lineTo(p.x, p.y); }
    const bend = Math.min(1, Math.abs(track.curv[i]) / 4);
    sections.push({ surf, edges, fill: track.boost[i] ? "rgba(55,224,140,0.32)" : `rgb(${46 + 50 * bend},${46 - 8 * bend},${52 - 6 * bend})` }); // tighter bend = warmer
  }
}

// +d = right of the direction of travel
const edgeAt = (j, d) => ({ x: cx[j] - Math.sin(cth[j]) * d, y: cy[j] + Math.cos(cth[j]) * d });

function pose(s) {
  const f = Math.max(0, Math.min(cx.length - 1.001, s / SAMPLE));
  const j = Math.floor(f), t = f - j;
  return { x: cx[j] + (cx[j + 1] - cx[j]) * t, y: cy[j] + (cy[j + 1] - cy[j]) * t, th: cth[j] + (cth[j + 1] - cth[j]) * t };
}

function reset() {
  track = generateTrack(Number($("seed").value) >>> 0);
  buildGeometry();
  st = createState();
  prev = { ...st };
  log = [];
  acc = 0;
  last = performance.now();
  verified = null;
  skids = new Float64Array(SKIDS * 2); skidN = 0;
  document.activeElement?.blur(); // so Space/Enter don't re-press the restart button
}

const keys = new Set();
addEventListener("keydown", (e) => { keys.add(e.key.toLowerCase()); if (e.key.startsWith("Arrow") || e.key === " ") e.preventDefault(); });
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => keys.clear()); // no stuck throttle after alt-tab
const randomSeed = () => { $("seed").value = Math.floor(Math.random() * 100000); best = null; reset(); };
$("restart").onclick = reset;
$("random").onclick = randomSeed;
$("seed").onchange = () => { best = null; reset(); };

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
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
}
addEventListener("resize", resize);

function draw(alpha) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // interpolated car state between the last two ticks
  const s = prev.s + (st.s - prev.s) * alpha;
  const d = prev.d + (st.d - prev.d) * alpha;
  const yaw = (prev.h + (st.h - prev.h) * alpha) / 1e6;
  const v = prev.v + (st.v - prev.v) * alpha;
  const road = pose(s);
  const car = { x: road.x - Math.sin(road.th) * d, y: road.y + Math.cos(road.th) * d };
  const idx = Math.min(track.curv.length - 1, Math.floor(s / SECTION_LEN));

  const zoom = 1 / (MM_PER_PX * (1 + 0.45 * (v / V_MAX)));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(w / 2, h * 0.74);
  ctx.rotate(-road.th - Math.PI / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-car.x, -car.y);

  const first = Math.max(0, idx - 2), lastSec = Math.min(track.curv.length - 1, idx + FOG_SECTIONS);
  for (let i = first; i <= lastSec; i++) {
    ctx.globalAlpha = Math.max(0.12, 1 - Math.max(0, i - idx) / (FOG_SECTIONS + 1));
    ctx.fillStyle = sections[i].fill;
    ctx.fill(sections[i].surf);
  }
  ctx.strokeStyle = "#d7ff3f";
  ctx.lineWidth = 120;
  for (let i = first; i <= lastSec; i++) {
    ctx.globalAlpha = Math.max(0.12, 1 - Math.max(0, i - idx) / (FOG_SECTIONS + 1));
    ctx.stroke(sections[i].edges);
  }
  ctx.globalAlpha = 1;
  if (lastSec === track.curv.length - 1) { // finish line
    const j = cx.length - 1, l = edgeAt(j, -HALF_WIDTH), r = edgeAt(j, HALF_WIDTH);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 300; ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.stroke();
  }

  // skid marks
  ctx.fillStyle = "rgba(10,10,14,0.55)";
  for (let i = 0, m = Math.min(skidN, SKIDS); i < m; i++) ctx.fillRect(skids[i * 2] - 180, skids[i * 2 + 1] - 180, 360, 360);

  // car: road heading + its own yaw relative to the road
  ctx.translate(car.x, car.y);
  ctx.rotate(road.th + yaw + Math.PI / 2);
  ctx.fillStyle = st.finishTick >= 0 ? "#37e08c" : st.slide ? "#ff4d5e" : "#d7ff3f";
  ctx.beginPath();
  ctx.moveTo(0, -2200); ctx.lineTo(CAR_HALF_WIDTH, 1700); ctx.lineTo(-CAR_HALF_WIDTH, 1700);
  ctx.closePath(); ctx.fill();

  if (st.finishTick >= 0) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "rgba(13,13,15,0.88)";
    const bw = Math.min(460, w - 24); ctx.fillRect(w / 2 - bw / 2, h / 2 - 70, bw, 140);
    ctx.fillStyle = "#f4f4f2";
    ctx.textAlign = "center";
    ctx.font = "600 20px 'Space Grotesk', system-ui, sans-serif";
    ctx.fillText(`finished ${((st.finishTick * TICK_MS) / 1000).toFixed(2)}s · walls ${st.wallHits}`, w / 2, h / 2 - 20);
    ctx.font = "13px 'JetBrains Mono', ui-monospace, monospace";
    ctx.fillText(verified ? `replay verified · state hash ${verified.toString(16).padStart(8, "0")}` : "verifying…", w / 2, h / 2 + 8);
    ctx.fillText("Restart = same track · New track = random seed", w / 2, h / 2 + 40);
    ctx.textAlign = "start";
  }
}

// HUD: only touch the DOM when the text actually changes
const hud = {};
function setText(id, text) { if (hud[id] !== text) { hud[id] = text; $(id).textContent = text; } }

function addSkid() {
  const p = pose(st.s), i = skidN++ % SKIDS;
  skids[i * 2] = p.x - Math.sin(p.th) * st.d;
  skids[i * 2 + 1] = p.y + Math.cos(p.th) * st.d;
}

function frame(now) {
  acc += Math.min(250, now - last);
  last = now;
  while (acc >= TICK_MS && st.finishTick < 0) {
    prev = { ...st };
    const input = encodeInput(readInput());
    log.push(input);
    step(st, track, input);
    if (st.slide) addSkid();
    acc -= TICK_MS;
    if (st.finishTick >= 0) {
      const r = runReplay(track, log);
      verified = r.hash === stateHash(st) ? r.hash : null;
      const t = (st.finishTick * TICK_MS) / 1000;
      if (verified && (best === null || t < best)) best = t;
    }
  }
  const alpha = st.finishTick >= 0 ? 1 : acc / TICK_MS;
  setText("t", `${((st.tick * TICK_MS) / 1000).toFixed(1)}s`);
  setText("spd", `${Math.round((st.v * 3.6) / 1000)} km/h`);
  setText("walls", String(st.wallHits));
  setText("best", best === null ? "—" : `${best.toFixed(2)}s`);
  draw(alpha);
  requestAnimationFrame(frame);
}

resize();
randomSeed();
requestAnimationFrame(frame);
