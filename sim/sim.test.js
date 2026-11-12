import test from "node:test";
import assert from "node:assert/strict";
import { generateTrack, SECTION_LEN, SECTIONS, HALF_WIDTH } from "./track.js";
import {
  createState, step, observe, encodeInput, decodeInput, runReplay, stateHash, safeSpeed, V_MAX, CAR_HALF_WIDTH, roadCurv, lockCurv, STEER_RATE,
} from "./sim.js";
import { drive } from "./bot.js";

function lap(track, policy, maxTicks = 5000) {
  const st = createState();
  const log = [];
  while (st.finishTick < 0 && st.tick < maxTicks) {
    const input = encodeInput(policy(observe(st, track), st));
    log.push(input);
    step(st, track, input);
  }
  return { st, log };
}

test("input encoding round-trips", () => {
  for (let steer = -1; steer <= 1; steer++)
    for (const throttle of [0, 1])
      for (const brake of [0, 1]) {
        assert.deepEqual(decodeInput(encodeInput({ steer, throttle, brake })), { steer, throttle, brake });
      }
});

test("same seed gives the same track, different seeds differ", () => {
  assert.deepEqual(generateTrack(42).curv, generateTrack(42).curv);
  assert.notDeepEqual(generateTrack(42).curv, generateTrack(43).curv);
});

test("tracks start and end straight and stay within curvature limits", () => {
  for (let seed = 0; seed < 50; seed++) {
    const t = generateTrack(seed);
    assert.equal(t.curv.length, SECTIONS);
    for (let i = 0; i < 3; i++) assert.equal(t.curv[i], 0);
    assert.equal(t.curv[SECTIONS - 1], 0);
    assert.ok(t.curv.every((k) => Math.abs(k) <= 4));
  }
});

test("replaying an input log reproduces the exact final state and checkpoints", () => {
  const track = generateTrack(1);
  const { st, log } = lap(track, drive);
  const r1 = runReplay(track, log);
  const r2 = runReplay(track, log);
  assert.equal(r1.hash, stateHash(st));
  assert.equal(r1.hash, r2.hash);
  assert.deepEqual(r1.checkpoints, r2.checkpoints);
  assert.deepEqual(r1.state, st);
});

test("golden replay: seed 1 reference lap is bit-for-bit stable", () => {
  const { st, log } = lap(generateTrack(1), drive);
  const r = runReplay(generateTrack(1), log);
  // If physics or the bot change on purpose, regenerate these with `node run.js 1`.
  assert.equal(st.finishTick, GOLDEN.finishTick);
  assert.equal(r.hash, GOLDEN.hash);
});

test("a tampered input log no longer verifies against the original hash", () => {
  const track = generateTrack(1);
  const { st, log } = lap(track, drive);
  const forged = log.slice();
  forged[200] = encodeInput({ steer: 1, throttle: 1, brake: 0 });
  assert.notEqual(runReplay(track, forged).hash, stateHash(st));
});

test("flat-out throttle with no steering is punished: walls and a slow lap", () => {
  const track = generateTrack(7);
  const naive = lap(track, () => ({ steer: 0, throttle: 1, brake: 0 }));
  const smart = lap(track, drive);
  assert.ok(naive.st.wallHits >= 1, `naive wall hits ${naive.st.wallHits}`);
  assert.ok(smart.st.finishTick >= 0);
  assert.ok(naive.st.finishTick < 0 || naive.st.finishTick > smart.st.finishTick);
});

test("braking for corners beats ignoring them even when steering well", () => {
  const track = generateTrack(7);
  const steerOnly = (obs) => ({ ...drive(obs), throttle: 1, brake: 0 });
  const careless = lap(track, steerOnly);
  const smart = lap(track, drive);
  assert.ok(smart.st.finishTick >= 0);
  assert.ok(smart.st.wallHits < careless.st.wallHits || smart.st.finishTick < careless.st.finishTick);
});

test("the inside of a bend is the shorter way: same speed, more progress", () => {
  const track = { curv: new Int8Array(SECTIONS).fill(2), boost: new Uint8Array(SECTIONS) };
  const run = (d) => {
    const st = createState();
    st.s = 5 * SECTION_LEN; st.v = 30000; st.d = d;
    const before = st.s;
    step(st, track, { steer: 0, throttle: 0, brake: 0 });
    return st.s - before;
  };
  assert.ok(run(3000) > run(-3000), "inside (same side as bend) must progress more");
});

test("walls clamp the car, cost speed and count a hit", () => {
  const track = { curv: new Int8Array(SECTIONS), boost: new Uint8Array(SECTIONS) }; // dead straight
  const st = createState();
  st.s = 10 * SECTION_LEN; st.v = 50000; st.d = HALF_WIDTH - CAR_HALF_WIDTH - 10; st.h = 300000; // ~17° into the right wall
  step(st, track, { steer: 1, throttle: 1, brake: 0 });
  assert.equal(st.d, HALF_WIDTH - CAR_HALF_WIDTH);
  assert.ok(st.h <= 0, "glances off, no longer pointing into the wall");
  assert.equal(st.wallHits, 1);
  assert.ok(st.v < 50000);
});

test("observe() only reveals the next few sections (fog of war)", () => {
  const track = generateTrack(5);
  const obs = observe(createState(), track, 8);
  assert.equal(obs.ahead.length, 8);
  assert.equal(JSON.stringify(obs).includes('"curv"'), true);
  const far = observe({ ...createState(), s: (SECTIONS - 2) * SECTION_LEN }, track, 8);
  assert.equal(far.ahead[2], null); // nothing past the finish
});

test("safe speed falls with curvature and never exceeds top speed", () => {
  for (let k = -4; k <= 4; k++) assert.ok(safeSpeed(k) <= V_MAX && safeSpeed(k) > 0);
  assert.ok(safeSpeed(4) < safeSpeed(1));
});

const GOLDEN = { finishTick: 1292, hash: 4038725972 };

test("over-driving a bend slides wide and scrubs speed; a sane speed holds the line", () => {
  const track = { curv: new Int8Array(SECTIONS).fill(4), boost: new Uint8Array(SECTIONS) };
  const run = (v0) => {
    const st = createState();
    st.s = 5 * SECTION_LEN; st.v = v0;
    let slid = 0;
    for (let i = 0; i < 20; i++) {
      // hold the wheel exactly where the road's curvature needs it (capped at full lock)
      st.sa = Math.min(1000, Math.round((roadCurv(4) / lockCurv(st.v)) * 1000)) - STEER_RATE;
      step(st, track, { steer: 1, throttle: 0, brake: 0 });
      slid += st.slide;
    }
    return { st, slid };
  };
  const fast = run(safeSpeed(4) + 15000), sane = run(safeSpeed(4) - 3000);
  assert.ok(fast.slid > 0 && sane.slid === 0, `fast slid ${fast.slid}, sane slid ${sane.slid}`);
  assert.ok(fast.st.d < sane.st.d - 1000, "the fast car runs wide (left, in a right-hander)");
});
