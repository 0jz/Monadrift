// Monadrift real-time simulation core.
//
// A car with a heading, in the road's own frame:
//   s  distance along the centre line (mm)
//   d  lateral offset from the centre line (mm, + = right)
//   h  heading relative to the road tangent (µrad, + = pointing right)
//   v  speed along the heading (mm/s)
//   sa steering position -1000..1000; the keyboard ramps it, so a tap steers gently
//
// The road turns under the car at the track's curvature; the car turns at the
// curvature its steering asks for, capped by tyre grip (v² · c ≤ grip). Ask for
// more than the tyres give — too fast for the bend, or braking/accelerating hard
// while turning (friction circle) — and the car runs wide and scrubs speed.
// That is the whole reason to brake before a corner; there is no fake sideways pull.
//
// Determinism: state is integers; intermediate maths uses only + - * / and
// Math.sqrt, which IEEE-754 makes bit-exact in every JS engine. Math.sin/cos are
// implementation-defined, so sin/cos below are fixed polynomials.
//
// One tick = TICK_MS. A race is fully described by (seed, input log).

import { SECTION_LEN, HALF_WIDTH, CURVE_RAD } from "./track.js";

export const TICK_MS = 25; // 40 Hz
const DT = TICK_MS / 1000;

export const V_MAX = 70000; // mm/s (252 km/h), terminal speed on throttle
export const BOOST_CAP = V_MAX + 10000;
export const BOOST_KICK = 8000; // mm/s added by a pad
export const ENGINE = 9000; // mm/s² at standstill, falls linearly to 0 at V_MAX
export const COAST = 2500; // mm/s² rolling + engine braking off throttle
export const BRAKE = 12000; // mm/s²
export const GRIP = 14000; // mm/s² total tyre grip (~1.4 g)
export const MIN_RADIUS = 5000; // mm, tightest turn at walking pace
export const LOCK_GRIP = 1.15; // full lock asks for this much of the grip at speed (speed-sensitive steering)
export const STEER_RATE = 110; // sa units per tick toward full lock (~0.23 s to full lock)
export const CENTER_RATE = 180; // sa units per tick back to centre when released
export const MAX_YAW = 1200000; // µrad: the car never points more than ~70° off the road
export const CAR_HALF_WIDTH = 900; // mm
export const WALL_HIT_SPEED = 3000; // mm/s of sideways speed into a wall that counts as a hit
export const WALL_HIT_KEEP = 0.8; // speed kept after a real hit
export const WALL_SCRAPE_KEEP = 0.98; // speed kept per tick while scraping along a wall

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
// |x| ≤ 1.3 rad here; truncation error < 1e-6.
function sin(x) { const q = x * x; return x * (1 - (q / 6) * (1 - (q / 20) * (1 - (q / 42) * (1 - q / 72)))); }
function cos(x) { const q = x * x; return 1 - (q / 2) * (1 - (q / 12) * (1 - (q / 30) * (1 - (q / 56) * (1 - q / 90)))); }

/** Road curvature (1/mm, + = bends right) of a section with curvature level k. */
export const roadCurv = (k) => (k * CURVE_RAD) / SECTION_LEN;
/** Fastest speed (mm/s) that holds the centre line through a bend of level k on grip alone. */
export const safeSpeed = (k) => (k === 0 ? V_MAX : Math.min(V_MAX, Math.trunc(Math.sqrt(GRIP / Math.abs(roadCurv(k))))));
/** Path curvature (1/mm) at full steering lock for speed v. */
export const lockCurv = (v) => (v <= 0 ? 1 / MIN_RADIUS : Math.min(1 / MIN_RADIUS, (LOCK_GRIP * GRIP) / (v * v)));

// Inputs: steer -1|0|1, throttle 0|1, brake 0|1, packed in one small int so a
// race log is a plain array of bytes (cheap to sign, hash and commit on-chain).
export const encodeInput = ({ steer = 0, throttle = 0, brake = 0 }) =>
  steer + 1 + 3 * (throttle ? 1 : 0) + 6 * (brake ? 1 : 0);
export function decodeInput(n) {
  const x = n | 0;
  return { steer: (x % 3) - 1, throttle: Math.floor(x / 3) % 2, brake: Math.floor(x / 6) % 2 };
}

export function createState() {
  return { tick: 0, s: 0, d: 0, h: 0, v: 0, sa: 0, slide: 0, wallHits: 0, finishTick: -1, boostSection: -1 };
}

const section = (s, n) => clamp(Math.floor(s / SECTION_LEN), 0, n - 1);
export const trackEnd = (track) => track.curv.length * SECTION_LEN;

/** Advance one tick. Mutates and returns `st`. */
export function step(st, track, input) {
  if (st.finishTick >= 0) return st;
  const inp = typeof input === "number" ? decodeInput(input) : input;
  const steer = clamp(inp.steer | 0, -1, 1);
  const throttle = inp.throttle ? 1 : 0;
  const brake = inp.brake ? 1 : 0;

  const n = track.curv.length;
  const idx = section(st.s, n);
  const kr = roadCurv(track.curv[idx]);

  // steering wheel: ramps toward the key, springs back faster when released
  if (steer !== 0) st.sa = clamp(st.sa + steer * STEER_RATE, -1000, 1000);
  else st.sa = st.sa > 0 ? Math.max(0, st.sa - CENTER_RATE) : Math.min(0, st.sa + CENTER_RATE);

  // longitudinal
  const v = st.v;
  let along = brake ? -BRAKE : throttle ? (ENGINE * (V_MAX - v)) / V_MAX : -COAST;
  if (v <= 0 && along < 0) along = 0;

  // lateral: what the wheel asks for vs what the tyres can give after the longitudinal load
  const load = Math.min(Math.abs(along), 0.9 * GRIP); // no `**`: exponentiation is implementation-approximated
  const latGrip = Math.sqrt(GRIP * GRIP - load * load);
  const want = (st.sa / 1000) * lockCurv(v);
  const cap = v > 0 ? latGrip / (v * v) : 1 / MIN_RADIUS;
  let c = want;
  let scrub = 0;
  st.slide = 0;
  if (Math.abs(want) > cap) {
    c = Math.sign(want) * cap;
    scrub = Math.min(12000, (Math.abs(want) - cap) * v * v); // tyres sliding cost speed
    st.slide = 1;
  }

  const nv = clamp(v + (along - scrub) * DT, 0, BOOST_CAP);
  const dist = ((v + nv) / 2) * DT; // mm travelled along the heading this tick

  // move in the road frame; the inside of a bend is genuinely shorter
  const hr = st.h / 1e6;
  const ds = (dist * cos(hr)) / Math.max(0.5, 1 - kr * st.d);
  let d = st.d + dist * sin(hr);
  let h = st.h + (c * dist - kr * ds) * 1e6; // car turns by c, the road turns by kr under it
  let vOut = nv;

  // walls: keep the speed along the wall, lose the part going into it, glance off
  const lim = HALF_WIDTH - CAR_HALF_WIDTH;
  if (d > lim || d < -lim) {
    const side = d > 0 ? 1 : -1;
    d = side * lim;
    if (h * side > 0) {
      const hh = h / 1e6;
      const into = Math.abs(vOut * sin(hh));
      const hit = into > WALL_HIT_SPEED;
      vOut = vOut * cos(hh) * (hit ? WALL_HIT_KEEP : WALL_SCRAPE_KEEP);
      h = hit ? -h * 0.2 : 0;
      if (hit) st.wallHits++;
    } else {
      vOut *= WALL_SCRAPE_KEEP;
    }
  }

  st.v = Math.trunc(vOut);
  st.d = Math.trunc(d);
  st.h = Math.trunc(clamp(h, -MAX_YAW, MAX_YAW));
  st.s += Math.trunc(ds);

  // boost pad: centre line only, once per section
  const nIdx = section(st.s, n);
  if (nIdx !== idx && track.boost[nIdx] && Math.abs(st.d) < 2500 && st.boostSection !== nIdx) {
    st.v = Math.min(st.v + BOOST_KICK, BOOST_CAP);
    st.boostSection = nIdx;
  }

  st.tick++;
  if (st.s >= n * SECTION_LEN) st.finishTick = st.tick;
  return st;
}

/** What a driver (human or agent) may see: fog of war, not the whole track. */
export function observe(st, track, lookahead = 8) {
  const n = track.curv.length;
  const idx = section(st.s, n);
  const ahead = [];
  for (let j = 0; j < lookahead; j++) {
    const i = idx + j;
    ahead.push(i < n ? { curv: track.curv[i], boost: track.boost[i] } : null);
  }
  return {
    tick: st.tick,
    s: st.s,
    d: st.d,
    h: st.h,
    v: st.v,
    sa: st.sa,
    slide: st.slide,
    sectionIndex: idx,
    distToNextSection: (idx + 1) * SECTION_LEN - st.s,
    ahead,
  };
}

// FNV-1a 32-bit over the state's integers. A real deployment would use keccak
// for the on-chain checkpoint; this keeps the core dependency-free.
export function stateHash(st) {
  let h = 0x811c9dc5;
  for (const n of [st.tick, st.s, st.d, st.h, st.v, st.sa, st.wallHits, st.finishTick]) {
    const x = n | 0;
    for (let b = 0; b < 4; b++) {
      h ^= (x >>> (b * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

/** Replay an input log from scratch. Returns the final state and checkpoints. */
export function runReplay(track, inputs, { checkpointEvery = 100, maxTicks = 40000 } = {}) {
  const st = createState();
  const checkpoints = [];
  for (let i = 0; i < inputs.length && i < maxTicks && st.finishTick < 0; i++) {
    step(st, track, inputs[i]);
    if (st.tick % checkpointEvery === 0) checkpoints.push(stateHash(st));
  }
  return { state: st, checkpoints, hash: stateHash(st) };
}
