// Top-down canvas renderer. Pure drawing: give it a scene, it paints a frame.
// Floats are fine here; rendering is not consensus.
//
// Geometry: the sim has no yaw, only a road frame (s along, d across, +d = right).
// We rebuild the road's picture by accumulating heading from per-section curvature
// and show it road-up: the camera rotates so the road under your car points up.

const SECTION_LEN = 20000; // mm, matches sim/track.js
const HALF_WIDTH = 7000; // sim wall is at +-6000 for the car CENTRE; the kerb is drawn half a car width further out so a car touches it instead of overlapping it
const CAR_LEN = 4500, CAR_W = 2000;
const K = 0.05; // radians turned per curvature level per section (visual only)
const STEP = 2500; // mm between centre-line samples
// Visual-only copies of sim constants (sim/sim.js): the car's nose points along its real path
// over the ground, i.e. road heading + atan(sideways mm per tick / forward mm per tick).
const GRIP_DIV = 8, V_MAX = 70000, CORNER_STEP = 12000, MAX_YAW = 0.6;
/** Sideways travel in road frame, mm/tick: steering velocity plus the bend (and over-speed) slide. */
export function lateralRate(lv, v, k) {
  const over = v - (V_MAX - Math.abs(k) * CORNER_STEP);
  const drift = k !== 0 && over > 0 ? -Math.sign(k) * Math.trunc(over / GRIP_DIV) : 0;
  return lv + drift;
}
/** Nose angle relative to the road, radians; + = pointing right. */
export function yawOf(lv, v, k) {
  const fwd = Math.max(v / 20, 200); // mm per tick along the road (floor avoids spinning when stopped)
  return Math.max(-MAX_YAW, Math.min(MAX_YAW, Math.atan2(lateralRate(lv, v, k), fwd)));
}
// Site theme tokens (style.css :root). Cars keep distinct hues so 12 of them can be told apart;
// your own car is always the accent lime.
const T = { bg: "#0d0d0f", surface: "#17171a", surface2: "#1e1e22", line: "#313136", ink: "#f4f4f2", dim: "#8f8f96", accent: "#d7ff3f", danger: "#ff4d5e" };
export const COLORS = ["#ff5d73", "#ffb703", "#4cc9f0", "#80ed99", "#b388ff", "#ff8fab", "#f4f1de", "#2ec4b6", "#ff9f1c", "#9d4edd", "#90be6d", "#f72585"];
const MONO = '"JetBrains Mono", ui-monospace, monospace';

/** Remembers every section the client has been told about (the fog only reveals ahead). */
export class RoadCache {
  constructor() { this.sections = new Map(); this.total = 0; }
  set(i, curv, boost) { this.sections.set(i, { curv, boost }); }
  curvAt(s) { return this.sections.get(Math.floor(s / SECTION_LEN))?.curv ?? 0; }
  /** Feed a driver observation (obs.ahead starts at obs.sectionIndex). */
  fromObs(obs) { obs.ahead.forEach((a, j) => { if (a) this.set(obs.sectionIndex + j, a.curv, a.boost); }); }
  /** Feed a spectator view window. */
  fromView(v) {
    this.total = v.sections;
    v.window.curv.forEach((c, j) => this.set(v.window.from + j, c, v.window.boost[j]));
  }
}

/** Centre-line samples [{s,x,y,th}] from section `a` to `b` (exclusive), in metres. */
function buildPath(road, a, b) {
  const pts = [];
  let x = 0, y = 0, th = 0;
  for (let i = a; i < b; i++) {
    const sec = road.sections.get(i);
    if (!sec) break;
    for (let m = 0; m < SECTION_LEN; m += STEP) {
      pts.push({ s: i * SECTION_LEN + m, x, y, th });
      const ds = STEP / 1000;
      th += (sec.curv * K * STEP) / SECTION_LEN;
      x += Math.sin(th) * ds;
      y -= Math.cos(th) * ds;
    }
  }
  return pts;
}

function poseAt(pts, s) {
  if (!pts.length) return null;
  if (s <= pts[0].s) return pts[0];
  const last = pts[pts.length - 1];
  if (s >= last.s) return { ...last, s };
  const i = Math.min(pts.length - 2, Math.floor((s - pts[0].s) / STEP));
  const p = pts[i], q = pts[i + 1], t = (s - p.s) / STEP;
  return { s, x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, th: p.th + (q.th - p.th) * t };
}

/**
 * scene = { road: RoadCache, camS: mm, cars: [{s,d,slot,name,me,done,yaw}], sections: number|0 }
 * `sections` (if known) draws the finish line. `yaw` (radians, + = right) turns the car's nose.
 */
export function draw(ctx, w, h, scene) {
  const { road, camS, cars } = scene;
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, w, h);

  const camIdx = Math.floor(camS / SECTION_LEN);
  const from = Math.max(0, camIdx - 3);
  const pts = buildPath(road, from, camIdx + 12);
  const cam = poseAt(pts, camS);
  if (!cam) return;

  const ppm = h / 80; // pixels per metre: ~80 m of road visible top to bottom
  const ox = w / 2, oy = h * 0.72;
  const fx = Math.sin(cam.th), fy = -Math.cos(cam.th), rx = Math.cos(cam.th), ry = Math.sin(cam.th);
  // world (metres) -> screen
  const tx = (x, y) => ox + ((x - cam.x) * rx + (y - cam.y) * ry) * ppm;
  const ty = (x, y) => oy - ((x - cam.x) * fx + (y - cam.y) * fy) * ppm;
  const edge = (p, dmm) => {
    const d = dmm / 1000;
    const x = p.x + Math.cos(p.th) * d, y = p.y + Math.sin(p.th) * d;
    return [tx(x, y), ty(x, y)];
  };

  // The site's blueprint grid, pinned to the world so it slides and turns with the camera.
  const G = 10, R = 70;
  ctx.strokeStyle = "rgba(255,255,255,0.045)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = Math.floor((cam.x - R) / G) * G; gx <= cam.x + R; gx += G) { ctx.moveTo(tx(gx, cam.y - R), ty(gx, cam.y - R)); ctx.lineTo(tx(gx, cam.y + R), ty(gx, cam.y + R)); }
  for (let gy = Math.floor((cam.y - R) / G) * G; gy <= cam.y + R; gy += G) { ctx.moveTo(tx(cam.x - R, gy), ty(cam.x - R, gy)); ctx.lineTo(tx(cam.x + R, gy), ty(cam.x + R, gy)); }
  ctx.stroke();

  if (pts.length < 2) return;

  // asphalt
  ctx.beginPath();
  pts.forEach((p, i) => { const [x, y] = edge(p, -HALF_WIDTH); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  for (let i = pts.length - 1; i >= 0; i--) { const [x, y] = edge(pts[i], HALF_WIDTH); ctx.lineTo(x, y); }
  ctx.closePath();
  ctx.fillStyle = T.surface2;
  ctx.fill();

  // section ticks across the road: the track-tile motif from the logo, and a speed cue
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for (let i = from; i < camIdx + 12; i++) {
    const p = poseAt(pts, i * SECTION_LEN);
    if (!p || i * SECTION_LEN < pts[0].s) continue;
    const [x1, y1] = edge(p, -HALF_WIDTH), [x2, y2] = edge(p, HALF_WIDTH);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  // boost pads (8 m long, centred in the section): lime chevrons
  for (let i = from; i < camIdx + 12; i++) {
    const sec = road.sections.get(i);
    if (!sec?.boost) continue;
    const a = poseAt(pts, i * SECTION_LEN + 6000), b = poseAt(pts, i * SECTION_LEN + 14000);
    if (!a || !b) continue;
    ctx.beginPath();
    for (const [p, side] of [[a, -1500], [b, -1500], [b, 1500], [a, 1500]]) { const [x, y] = edge(p, side); ctx.lineTo(x, y); }
    ctx.closePath();
    ctx.fillStyle = "rgba(215, 255, 63, 0.16)";
    ctx.fill();
    ctx.strokeStyle = T.accent;
    ctx.lineWidth = Math.max(1.5, ppm * 0.3);
    for (let m = 6500; m < 14000; m += 2500) {
      const p = poseAt(pts, i * SECTION_LEN + m), q = poseAt(pts, i * SECTION_LEN + m + 1200);
      const [lx, ly] = edge(p, -1100), [mx, my] = edge(q, 0), [rx2, ry2] = edge(p, 1100);
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(mx, my); ctx.lineTo(rx2, ry2); ctx.stroke();
    }
  }

  // centre dashes
  ctx.strokeStyle = "rgba(244,244,242,0.22)";
  ctx.lineWidth = Math.max(1, ppm * 0.22);
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const [x1, y1] = edge(pts[i], 0), [x2, y2] = edge(pts[i + 1], 0);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  // walls: accent-lime kerb on a dark apron, like the card corner ticks
  for (const side of [-HALF_WIDTH, HALF_WIDTH]) {
    const wall = (off, colour, width) => {
      ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = edge(p, side + Math.sign(side) * off); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.stroke();
    };
    wall(700, T.bg, Math.max(3, ppm * 1.2));
    wall(300, T.accent, Math.max(2, ppm * 0.45));
  }

  // start / finish chequers
  const lines = [0];
  if (scene.sections) lines.push(scene.sections * SECTION_LEN);
  for (const ls of lines) {
    const p = poseAt(pts, ls);
    if (!p || ls < pts[0].s || ls > pts[pts.length - 1].s) continue;
    const [x1, y1] = edge(p, -HALF_WIDTH), [x2, y2] = edge(p, HALF_WIDTH);
    ctx.strokeStyle = ls === 0 ? "rgba(244,244,242,0.55)" : T.ink;
    ctx.lineWidth = ppm * 1.6;
    ctx.setLineDash([ppm * 1.5, ppm * 1.5]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.setLineDash([]);
  }

  // fog edge: fade the far end so the cut-off does not look like a bug
  const fog = ctx.createLinearGradient(0, 0, 0, h * 0.35);
  fog.addColorStop(0, T.bg); fog.addColorStop(1, "rgba(13,13,15,0)");
  ctx.fillStyle = fog;
  ctx.fillRect(0, 0, w, h * 0.35);

  // cars, far to near so near ones overlap
  const sorted = [...cars].sort((a, b) => b.s - a.s);
  for (const c of sorted) {
    const p = poseAt(pts, c.s);
    if (!p || c.s < pts[0].s - 1) continue;
    const [cx, cy] = edge(p, c.d);
    const L = (CAR_LEN / 1000) * ppm, W = (CAR_W / 1000) * ppm;
    const body = c.me ? T.accent : COLORS[c.slot % COLORS.length];
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(p.th - cam.th + (c.yaw || 0)); // road heading + the car's own yaw
    ctx.globalAlpha = c.done ? 0.35 : 1;
    // wheels
    ctx.fillStyle = "#050506";
    for (const [wx, wy] of [[-1, -0.28], [1, -0.28], [-1, 0.3], [1, 0.3]]) ctx.fillRect(wx * W * 0.5 - W * 0.12, wy * L - L * 0.1, W * 0.24, L * 0.2);
    // hull: pointed nose, square tail (the logo diamond, stretched)
    ctx.beginPath();
    ctx.moveTo(0, -L / 2);
    ctx.lineTo(W * 0.46, -L * 0.18);
    ctx.lineTo(W * 0.46, L / 2);
    ctx.lineTo(-W * 0.46, L / 2);
    ctx.lineTo(-W * 0.46, -L * 0.18);
    ctx.closePath();
    ctx.fillStyle = body; ctx.fill();
    ctx.lineWidth = Math.max(1, ppm * 0.14); ctx.strokeStyle = c.me ? T.ink : "rgba(0,0,0,0.55)"; ctx.stroke();
    // cockpit and tail lights
    ctx.fillStyle = "rgba(13,13,15,0.85)";
    ctx.fillRect(-W * 0.26, -L * 0.1, W * 0.52, L * 0.28);
    ctx.fillStyle = T.danger;
    ctx.fillRect(-W * 0.4, L / 2 - L * 0.06, W * 0.22, L * 0.06);
    ctx.fillRect(W * 0.18, L / 2 - L * 0.06, W * 0.22, L * 0.06);
    ctx.restore();
    if (c.name) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = c.me ? T.accent : "rgba(244,244,242,0.7)";
      ctx.font = `600 ${Math.max(10, ppm * 1.3)}px ${MONO}`;
      ctx.textAlign = "center";
      ctx.fillText(c.name.toUpperCase(), cx, cy - L * 0.75);
    }
  }
}
