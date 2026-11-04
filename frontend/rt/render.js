// Top-down canvas renderer. Pure drawing: give it a scene, it paints a frame.
// Floats are fine here; rendering is not consensus.
//
// Geometry: the sim has no yaw, only a road frame (s along, d across, +d = right).
// We rebuild the road's picture by accumulating heading from per-section curvature
// and show it road-up: the camera rotates so the road under your car points up.

const SECTION_LEN = 20000; // mm, matches sim/track.js
const HALF_WIDTH = 6000;
const CAR_LEN = 4500, CAR_W = 2000;
const K = 0.05; // radians turned per curvature level per section (visual only)
const STEP = 2500; // mm between centre-line samples
export const COLORS = ["#ff5d73", "#ffb703", "#4cc9f0", "#80ed99", "#b388ff", "#ff8fab", "#f4f1de", "#2ec4b6", "#ff9f1c", "#9d4edd", "#90be6d", "#f72585"];

/** Remembers every section the client has been told about (the fog only reveals ahead). */
export class RoadCache {
  constructor() { this.sections = new Map(); this.total = 0; }
  set(i, curv, boost) { this.sections.set(i, { curv, boost }); }
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
 * scene = { road: RoadCache, camS: mm, cars: [{s,d,slot,name,me,done}], sections: number|0 }
 * `sections` (if known) draws the finish line.
 */
export function draw(ctx, w, h, scene) {
  const { road, camS, cars } = scene;
  ctx.fillStyle = "#0b0d12";
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

  if (pts.length < 2) return;

  // asphalt
  ctx.beginPath();
  pts.forEach((p, i) => { const [x, y] = edge(p, -HALF_WIDTH); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  for (let i = pts.length - 1; i >= 0; i--) { const [x, y] = edge(pts[i], HALF_WIDTH); ctx.lineTo(x, y); }
  ctx.closePath();
  ctx.fillStyle = "#23262f";
  ctx.fill();

  // boost pads (8 m long, centred in the section)
  for (let i = from; i < camIdx + 12; i++) {
    const sec = road.sections.get(i);
    if (!sec?.boost) continue;
    const a = poseAt(pts, i * SECTION_LEN + 6000), b = poseAt(pts, i * SECTION_LEN + 14000);
    if (!a || !b) continue;
    ctx.beginPath();
    for (const [p, side] of [[a, -1500], [b, -1500], [b, 1500], [a, 1500]]) { const [x, y] = edge(p, side); ctx.lineTo(x, y); }
    ctx.closePath();
    ctx.fillStyle = "rgba(128, 237, 153, 0.55)";
    ctx.fill();
  }

  // centre dashes
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = Math.max(1, ppm * 0.25);
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const [x1, y1] = edge(pts[i], 0), [x2, y2] = edge(pts[i + 1], 0);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  // walls
  for (const side of [-HALF_WIDTH, HALF_WIDTH]) {
    ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = edge(p, side + Math.sign(side) * 300); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = "#e8e8f0";
    ctx.lineWidth = Math.max(2, ppm * 0.6);
    ctx.stroke();
  }

  // start / finish chequers
  const lines = [0];
  if (scene.sections) lines.push(scene.sections * SECTION_LEN);
  for (const ls of lines) {
    const p = poseAt(pts, ls);
    if (!p || ls < pts[0].s || ls > pts[pts.length - 1].s) continue;
    const [x1, y1] = edge(p, -HALF_WIDTH), [x2, y2] = edge(p, HALF_WIDTH);
    ctx.strokeStyle = ls === 0 ? "rgba(255,255,255,0.6)" : "#fff";
    ctx.lineWidth = ppm * 1.6;
    ctx.setLineDash([ppm * 1.5, ppm * 1.5]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.setLineDash([]);
  }

  // fog edge: fade the far end so the cut-off does not look like a bug
  const fog = ctx.createLinearGradient(0, 0, 0, h * 0.35);
  fog.addColorStop(0, "#0b0d12"); fog.addColorStop(1, "rgba(11,13,18,0)");
  ctx.fillStyle = fog;
  ctx.fillRect(0, 0, w, h * 0.35);

  // cars, far to near so near ones overlap
  const sorted = [...cars].sort((a, b) => b.s - a.s);
  for (const c of sorted) {
    const p = poseAt(pts, c.s);
    if (!p || c.s < pts[0].s - 1) continue;
    const [cx, cy] = edge(p, c.d);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(p.th - cam.th);
    const L = (CAR_LEN / 1000) * ppm, W = (CAR_W / 1000) * ppm;
    ctx.globalAlpha = c.done ? 0.35 : 1;
    ctx.fillStyle = COLORS[c.slot % COLORS.length];
    ctx.fillRect(-W / 2, -L / 2, W, L);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(-W / 2 + W * 0.15, -L * 0.28, W * 0.7, L * 0.22); // windscreen
    if (c.me) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.strokeRect(-W / 2 - 2, -L / 2 - 2, W + 4, L + 4); }
    ctx.restore();
    if (c.name) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = c.me ? "#fff" : "rgba(255,255,255,0.7)";
      ctx.font = `${Math.max(10, ppm * 1.4)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(c.name, cx, cy - (CAR_LEN / 1000) * ppm * 0.7);
    }
  }
}
