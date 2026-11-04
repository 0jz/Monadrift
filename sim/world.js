// Multiplayer layer on top of the single-car sim (P1 of docs/REALTIME_PLAN.md).
//
// A world is N cars sharing one track. Each car is exactly the state `step()`
// already advances; `stepWorld` calls `step()` per car in slot order and then
// resolves car-vs-car overlaps. Everything is integer-only and slot-ordered, so
// (seed, sections, nCars, input matrix) replays bit for bit anywhere.

import { SECTION_LEN, HALF_WIDTH, generateTrack, TRACK_VERSION } from "./track.js";
import { createState, step, observe, encodeInput } from "./sim.js";
import { keccak256, toHex, fromHex } from "./keccak.js";

export const MAX_CARS = 12; // the opening straight (60 m) holds 4 rows of 3
export const CAR_LEN = 4500; // mm, bumper to bumper
export const CAR_WIDTH = 2000; // mm, side to side
export const GRID_COLS = 3;
export const GRID_COL_GAP = 3000; // mm between car centres in a row
export const GRID_ROW_GAP = 6000; // mm between rows
export const REAR_KEEP_PCT = 90; // rear car keeps this % of the front car's speed on contact
export const FRONT_KEEP_PCT = 97; // front car keeps this % of its own speed
export const OBSERVE_RADIUS = 60000; // mm, how far opponents are visible
export const NEUTRAL_INPUT = encodeInput({}); // missing input = coast straight (NOT 0, which is steer left)
export const CHECKPOINT_EVERY = 100; // ticks (5 s)

/** Slot 0 is pole. Rows of up to 3, centred. One car sits exactly at createState(). */
export function createWorld(nCars) {
  if (!Number.isInteger(nCars) || nCars < 1 || nCars > MAX_CARS) throw new Error(`nCars must be 1..${MAX_CARS}`);
  const rows = Math.ceil(nCars / GRID_COLS);
  const cars = [];
  for (let slot = 0; slot < nCars; slot++) {
    const row = Math.floor(slot / GRID_COLS);
    const inRow = Math.min(GRID_COLS, nCars - row * GRID_COLS);
    const col = slot % GRID_COLS;
    const car = createState();
    car.s = (rows - 1 - row) * GRID_ROW_GAP;
    car.d = ((2 * col - (inRow - 1)) * GRID_COL_GAP) / 2;
    car.bumps = 0;
    cars.push(car);
  }
  return { tick: 0, cars };
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// Move cars i (left) and j (right) apart laterally to exactly CAR_WIDTH. If one
// hits a wall the leftover is pushed onto the other.
function separate(a, b) {
  const overlap = CAR_WIDTH - Math.abs(a.d - b.d);
  const left = a.d <= b.d ? a : b;
  const right = left === a ? b : a;
  const half = Math.trunc(overlap / 2);
  left.d -= half;
  right.d += overlap - half;
  if (left.d < -HALF_WIDTH) { right.d += -HALF_WIDTH - left.d; left.d = -HALF_WIDTH; }
  if (right.d > HALF_WIDTH) { left.d -= right.d - HALF_WIDTH; right.d = HALF_WIDTH; }
  left.d = clamp(left.d, -HALF_WIDTH, HALF_WIDTH);
  right.d = clamp(right.d, -HALF_WIDTH, HALF_WIDTH);
  left.lv = Math.trunc(left.lv / 2);
  right.lv = Math.trunc(right.lv / 2);
}

function resolveCollisions(cars) {
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i], b = cars[j];
        if (a.finishTick >= 0 || b.finishTick >= 0) continue; // finished cars are ghosts
        if (Math.abs(a.s - b.s) >= CAR_LEN || Math.abs(a.d - b.d) >= CAR_WIDTH) continue;
        // Front = further along; exact tie goes to the lower slot, so it is deterministic.
        const [front, rear] = b.s > a.s ? [b, a] : [a, b];
        const hadContact = pass === 0;
        if (hadContact) {
          rear.v = Math.min(rear.v, Math.trunc((front.v * REAR_KEEP_PCT) / 100));
          front.v = Math.trunc((front.v * FRONT_KEEP_PCT) / 100);
          a.bumps++; b.bumps++;
        }
        separate(a, b);
      }
    }
  }
}

/**
 * Advance the whole world one tick. `inputs[slot]` is a packed int or an input
 * object; a missing entry coasts straight. Mutates and returns `world`.
 */
export function stepWorld(world, track, inputs = []) {
  const cars = world.cars;
  for (let i = 0; i < cars.length; i++) {
    step(cars[i], track, inputs[i] === undefined || inputs[i] === null ? NEUTRAL_INPUT : inputs[i]);
  }
  resolveCollisions(cars);
  world.tick++;
  return world;
}

export const worldDone = (world) => world.cars.every((c) => c.finishTick >= 0);

/**
 * Slots in race order: finished first (earlier tick, then further past the line,
 * then lower slot), then unfinished by distance, then slot. No ties.
 */
export function ranking(world) {
  const order = world.cars.map((c, slot) => ({ c, slot }));
  order.sort((x, y) => {
    const fx = x.c.finishTick >= 0, fy = y.c.finishTick >= 0;
    if (fx !== fy) return fx ? -1 : 1;
    if (fx && x.c.finishTick !== y.c.finishTick) return x.c.finishTick - y.c.finishTick;
    if (x.c.s !== y.c.s) return y.c.s - x.c.s;
    return x.slot - y.slot;
  });
  return order.map((o) => o.slot);
}

/**
 * What one driver may see. Same fields as the single-car observe() (so bot.js
 * works unchanged) plus nearby opponents. Opponents carry no slot or identity.
 */
export function observeWorld(world, track, slot, lookahead = 8) {
  const me = world.cars[slot];
  const obs = observe(me, track, lookahead);
  const others = [];
  world.cars.forEach((o, i) => {
    if (i === slot || o.finishTick >= 0) return;
    const ds = o.s - me.s;
    if (Math.abs(ds) > OBSERVE_RADIUS) return;
    others.push({ ds, dd: o.d - me.d, dv: o.v - me.v });
  });
  others.sort((x, y) => y.ds - x.ds || x.dd - y.dd || x.dv - y.dv);
  obs.others = others;
  obs.place = ranking(world).indexOf(slot) + 1;
  obs.field = world.cars.length;
  return obs;
}

// ---- hashing -------------------------------------------------------------

const i32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** keccak256 over a canonical big-endian int32 encoding. Returns 0x-hex. */
export function hashWorld(world) {
  const words = [1, world.tick, world.cars.length];
  for (const c of world.cars) words.push(c.s, c.d, c.v, c.lv, c.wallHits, c.finishTick, c.boostSection, c.bumps);
  return toHex(keccak256(Uint8Array.from(words.flatMap((w) => i32(w | 0)))));
}

/** h_i = keccak(h_{i-1} || worldHash_i): one late checkpoint pins all earlier history. */
export function chainHash(prev, worldHash) {
  const a = fromHex(prev), b = fromHex(worldHash);
  const buf = new Uint8Array(a.length + b.length);
  buf.set(a); buf.set(b, a.length);
  return toHex(keccak256(buf));
}
export const ZERO_HASH = "0x" + "00".repeat(32);

/** uint256 race seed -> uint32 track seed: low 32 bits of keccak256(seed as 32 bytes). */
export function trackSeedFrom(seed256) {
  const hex = BigInt(seed256).toString(16).padStart(64, "0");
  const h = keccak256(fromHex(hex));
  return ((h[28] << 24) | (h[29] << 16) | (h[30] << 8) | h[31]) >>> 0;
}

/**
 * Replay a full input matrix (`ticks[t][slot]`) from scratch.
 * @returns {{world, checkpoints:{index:number,tick:number,worldHash:string,chained:string}[], finalHash:string, ranking:number[]}}
 */
export function replayWorld(track, nCars, ticks, { checkpointEvery = CHECKPOINT_EVERY } = {}) {
  const world = createWorld(nCars);
  const checkpoints = [];
  let chained = ZERO_HASH;
  for (let t = 0; t < ticks.length && !worldDone(world); t++) {
    stepWorld(world, track, ticks[t]);
    if (world.tick % checkpointEvery === 0) {
      const worldHash = hashWorld(world);
      chained = chainHash(chained, worldHash);
      checkpoints.push({ index: checkpoints.length, tick: world.tick, worldHash, chained });
    }
  }
  return { world, checkpoints, finalHash: hashWorld(world), ranking: ranking(world) };
}

export { generateTrack, TRACK_VERSION, SECTION_LEN };
