// Monadrift real-time simulation core (prototype).
//
// Pure, deterministic, integer-only. A car lives in the road's own frame:
//   s  distance along the centre line (mm)
//   d  lateral offset from the centre line (mm, positive = right)
//   v  speed (mm/s)
//   lv lateral velocity (mm/tick)
// so no trigonometry is needed and every engine computes identical results.
//
// One tick = TICK_MS. A race is fully described by (seed, input log).

import { SECTION_LEN, SECTIONS, HALF_WIDTH } from "./track.js";

export const TICK_MS = 50; // 20 Hz
export const V_MAX = 70000; // 70 m/s
export const BOOST_CAP = V_MAX + 8000;
export const ACCEL = 900; // mm/s gained per tick on throttle
export const BRAKE = 2000; // mm/s lost per tick on brake
export const COAST = 200; // mm/s lost per tick with no input
export const CORNER_STEP = 12000; // safe speed drops this much per curvature level
export const STEER_ACCEL = 80; // mm/tick lateral velocity per tick
export const STEER_FULL_SPEED = 30000; // below this speed steering is weaker
export const DRIFT_DIV = 250; // road bends away: drift = -k*v / DRIFT_DIV
export const GRIP_DIV = 20; // extra outward slide when over the safe speed
export const WALL_SPEED_PCT = 70; // speed kept after touching a wall
export const TRACK_END = SECTIONS * SECTION_LEN;

export const safeSpeed = (k) => V_MAX - Math.abs(k) * CORNER_STEP;

// Inputs: steer -1|0|1, throttle 0|1, brake 0|1, packed in one small int so a
// race log is a plain array of bytes (cheap to sign, hash and commit on-chain).
export const encodeInput = ({ steer = 0, throttle = 0, brake = 0 }) =>
  steer + 1 + 3 * (throttle ? 1 : 0) + 6 * (brake ? 1 : 0);
export function decodeInput(n) {
  const x = n | 0;
  return { steer: (x % 3) - 1, throttle: Math.floor(x / 3) % 2, brake: Math.floor(x / 6) % 2 };
}

export function createState() {
  return { tick: 0, s: 0, d: 0, v: 0, lv: 0, wallHits: 0, finishTick: -1, boostSection: -1 };
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const section = (s) => Math.min(SECTIONS - 1, Math.floor(s / SECTION_LEN));

/** Advance one tick. Mutates and returns `st`. */
export function step(st, track, input) {
  if (st.finishTick >= 0) return st;
  const inp = typeof input === "number" ? decodeInput(input) : input;
  const steer = clamp(inp.steer | 0, -1, 1);
  const throttle = inp.throttle ? 1 : 0;
  const brake = inp.brake ? 1 : 0;

  const idx = section(st.s);
  const k = track.curv[idx];

  // speed
  if (brake) st.v -= BRAKE;
  else if (throttle) st.v += ACCEL;
  else st.v -= COAST;
  st.v = clamp(st.v, 0, st.v > V_MAX ? BOOST_CAP : V_MAX);
  if (st.v > V_MAX && !throttle) st.v = Math.max(V_MAX, st.v - 400); // boost bleeds off

  // lateral motion: steering authority grows with speed
  const authority = Math.trunc((STEER_ACCEL * Math.min(st.v, STEER_FULL_SPEED)) / STEER_FULL_SPEED);
  st.lv = Math.trunc((st.lv * 85) / 100) + steer * authority;

  // the road bends away from a straight line; over the safe speed you also slide
  let drift = -Math.trunc((k * st.v) / DRIFT_DIV);
  const over = st.v - safeSpeed(k);
  if (k !== 0 && over > 0) drift -= Math.sign(k) * Math.trunc(over / GRIP_DIV);
  st.d += st.lv + drift;

  // walls
  if (st.d > HALF_WIDTH || st.d < -HALF_WIDTH) {
    st.d = clamp(st.d, -HALF_WIDTH, HALF_WIDTH);
    st.lv = 0;
    st.v = Math.trunc((st.v * WALL_SPEED_PCT) / 100);
    st.wallHits++;
  }

  // progress: the inside of a bend is the shorter way round
  const factor = Math.max(600, 1000 + Math.trunc((k * st.d) / 100));
  st.s += Math.trunc((st.v * factor) / 20000);

  // boost pad: centre line only, once per section
  const nIdx = section(st.s);
  if (nIdx !== idx && track.boost[nIdx] && Math.abs(st.d) < 2500 && st.boostSection !== nIdx) {
    st.v = Math.min(st.v + 8000, BOOST_CAP);
    st.boostSection = nIdx;
  }

  st.tick++;
  if (st.s >= TRACK_END) st.finishTick = st.tick;
  return st;
}

/** What a driver (human or agent) may see: fog of war, not the whole track. */
export function observe(st, track, lookahead = 8) {
  const idx = section(st.s);
  const ahead = [];
  for (let j = 0; j < lookahead; j++) {
    const i = idx + j;
    ahead.push(i < SECTIONS ? { curv: track.curv[i], boost: track.boost[i] } : null);
  }
  return {
    tick: st.tick,
    s: st.s,
    d: st.d,
    v: st.v,
    lv: st.lv,
    sectionIndex: idx,
    distToNextSection: (idx + 1) * SECTION_LEN - st.s,
    ahead,
  };
}

// FNV-1a 32-bit over the state's integers. A real deployment would use keccak
// for the on-chain checkpoint; this keeps the core dependency-free.
export function stateHash(st) {
  let h = 0x811c9dc5;
  for (const n of [st.tick, st.s, st.d, st.v, st.lv, st.wallHits, st.finishTick]) {
    const x = n | 0;
    for (let b = 0; b < 4; b++) {
      h ^= (x >>> (b * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

/** Replay an input log from scratch. Returns the final state and checkpoints. */
export function runReplay(track, inputs, { checkpointEvery = 100, maxTicks = 20000 } = {}) {
  const st = createState();
  const checkpoints = [];
  for (let i = 0; i < inputs.length && i < maxTicks && st.finishTick < 0; i++) {
    step(st, track, inputs[i]);
    if (st.tick % checkpointEvery === 0) checkpoints.push(stateHash(st));
  }
  return { state: st, checkpoints, hash: stateHash(st) };
}
