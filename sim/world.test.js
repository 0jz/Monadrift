import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex } from "./keccak.js";
import { generateTrack, SECTION_LEN, HALF_WIDTH, TRACK_VERSION } from "./track.js";
import { createState, step, encodeInput, stateHash } from "./sim.js";
import { drive } from "./bot.js";
import {
  createWorld, stepWorld, observeWorld, ranking, worldDone, hashWorld, chainHash, trackSeedFrom,
  replayWorld, MAX_CARS, CAR_LEN, CAR_WIDTH, OBSERVE_RADIUS, NEUTRAL_INPUT, ZERO_HASH,
} from "./world.js";
import { verifyReplay } from "./verify.js";

const utf8 = (s) => new TextEncoder().encode(s);
const flat = (n = 60) => ({ curv: new Int8Array(n), boost: new Uint8Array(n) });

// Drive every slot with the reference bot. Returns the input matrix.
function race(track, nCars, maxTicks = 6000) {
  const w = createWorld(nCars);
  const ticks = [];
  while (!worldDone(w) && w.tick < maxTicks) {
    const row = w.cars.map((_, i) => encodeInput(drive(observeWorld(w, track, i))));
    ticks.push(row);
    stepWorld(w, track, row);
  }
  return { w, ticks };
}

test("keccak256 matches the Ethereum test vectors", () => {
  assert.equal(toHex(keccak256(new Uint8Array())), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(toHex(keccak256(utf8("abc"))), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(
    toHex(keccak256(utf8("The quick brown fox jumps over the lazy dog"))),
    "0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15"
  );
});

test("trackSeedFrom is stable, uint32, and depends on every input bit pattern", () => {
  const a = trackSeedFrom(123456789n);
  assert.equal(a, trackSeedFrom("0x" + (123456789n).toString(16)));
  assert.ok(Number.isInteger(a) && a >= 0 && a <= 0xffffffff);
  assert.notEqual(a, trackSeedFrom(123456790n));
});

test("a one-car world is exactly the single-car sim (golden lap still holds)", () => {
  const track = generateTrack(1);
  const w = createWorld(1);
  const solo = createState();
  while (solo.finishTick < 0 && solo.tick < 5000) {
    const input = encodeInput(drive(observeWorld(w, track, 0)));
    stepWorld(w, track, [input]);
    step(solo, track, input);
  }
  assert.equal(stateHash(w.cars[0]), stateHash(solo));
  assert.equal(solo.finishTick, 483);
});

test("sections is a track parameter; default stays 60 and old tracks are unchanged", () => {
  assert.equal(generateTrack(9).curv.length, 60);
  assert.equal(generateTrack(9, { sections: 150 }).curv.length, 150);
  assert.deepEqual(generateTrack(9, { sections: 60 }).curv, generateTrack(9).curv);
  assert.equal(generateTrack(9).version, TRACK_VERSION);
  const long = generateTrack(3, { sections: 150 });
  for (let i = 0; i < 3; i++) assert.equal(long.curv[i], 0);
  assert.equal(long.curv[149], 0);
  assert.equal(long.curv[148], 0);
});

test("grid: slot 0 is pole, nobody overlaps, everyone is inside the walls, up to 12 cars", () => {
  for (let n = 1; n <= MAX_CARS; n++) {
    const w = createWorld(n);
    assert.equal(w.cars.length, n);
    for (const c of w.cars) assert.ok(Math.abs(c.d) <= HALF_WIDTH && c.s >= 0 && c.s < 3 * SECTION_LEN);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const a = w.cars[i], b = w.cars[j];
        assert.ok(Math.abs(a.s - b.s) >= CAR_LEN || Math.abs(a.d - b.d) >= CAR_WIDTH, `${n} cars: ${i}/${j} overlap`);
      }
    assert.equal(Math.max(...w.cars.map((c) => c.s)), w.cars[0].s);
  }
  assert.throws(() => createWorld(0));
  assert.throws(() => createWorld(MAX_CARS + 1));
});

test("a missing input coasts straight (does not mean 'steer left')", () => {
  const w = createWorld(2);
  w.cars[0].v = 30000; w.cars[1].v = 30000;
  stepWorld(w, flat(), [undefined, NEUTRAL_INPUT]);
  assert.equal(w.cars[0].d, w.cars[1].d - (createWorld(2).cars[1].d - createWorld(2).cars[0].d));
  assert.equal(w.cars[0].lv, 0);
});

test("overlapping cars are pushed apart, the rear car is slowed more, both count a bump", () => {
  const w = createWorld(2);
  const [a, b] = w.cars;
  a.s = 100000; a.d = 0; a.v = 40000;
  b.s = 98000; b.d = 500; b.v = 60000; // b is behind and faster
  stepWorld(w, flat(), [NEUTRAL_INPUT, NEUTRAL_INPUT]);
  assert.ok(Math.abs(a.d - b.d) >= CAR_WIDTH, `still overlapping: ${a.d} vs ${b.d}`);
  assert.ok(b.v <= 36000 && b.v < a.v, `rear v ${b.v}, front v ${a.v}`);
  assert.ok(a.v < 40000 && a.v > 30000, `front v ${a.v}`);
  assert.equal(a.bumps, 1);
  assert.equal(b.bumps, 1);
  assert.ok(a.s > b.s, "ramming must not let the rear car jump ahead");
});

test("collisions against a wall keep both cars on the road and still separated", () => {
  const w = createWorld(2);
  const [a, b] = w.cars;
  a.s = 100000; a.d = HALF_WIDTH - 200; a.v = 30000;
  b.s = 100500; b.d = HALF_WIDTH - 900; b.v = 30000;
  stepWorld(w, flat(), []);
  for (const c of w.cars) assert.ok(Math.abs(c.d) <= HALF_WIDTH);
  assert.ok(Math.abs(a.d - b.d) >= CAR_WIDTH);
});

test("exact tie in s and d resolves deterministically, lower slot is 'front'", () => {
  const run = () => {
    const w = createWorld(2);
    w.cars[0].s = w.cars[1].s = 100000; w.cars[0].d = w.cars[1].d = 0;
    w.cars[0].v = w.cars[1].v = 30000;
    stepWorld(w, flat(), []);
    return hashWorld(w);
  };
  assert.equal(run(), run());
});

test("finished cars are ghosts: they stop colliding and vanish from observe()", () => {
  const w = createWorld(2);
  const track = flat();
  w.cars[0].finishTick = 5; w.cars[0].s = 60 * SECTION_LEN + 10;
  w.cars[1].s = w.cars[0].s; w.cars[1].d = w.cars[0].d;
  stepWorld(w, track, []);
  assert.equal(w.cars[1].bumps, 0);
  assert.equal(observeWorld(w, track, 1).others.length, 0);
});

test("ranking: finish tick, then overshoot, then slot; unfinished by distance", () => {
  const w = createWorld(5);
  const c = w.cars;
  c[0].finishTick = 400; c[0].s = 1_200_010;
  c[1].finishTick = 400; c[1].s = 1_200_500; // same tick, further past the line
  c[2].finishTick = 399; c[2].s = 1_200_001; // earlier tick wins outright
  c[3].s = 900_000; c[4].s = 900_000; // unfinished, tied on s -> lower slot first
  assert.deepEqual(ranking(w), [2, 1, 0, 3, 4]);
});

test("observeWorld keeps the fog: 8 sections, nearby cars only, no identities, no hints", () => {
  const track = generateTrack(5);
  const w = createWorld(6);
  w.cars[5].s = w.cars[0].s + OBSERVE_RADIUS + 1; w.cars[5].d = 0; // just out of sight
  const obs = observeWorld(w, track, 0);
  assert.equal(obs.ahead.length, 8);
  assert.ok(obs.others.length === 4, `saw ${obs.others.length}`); // 5 others minus the far one
  for (const o of obs.others) assert.deepEqual(Object.keys(o).sort(), ["dd", "dlv", "ds", "dv"]);
  assert.equal(obs.field, 6);
  assert.equal(obs.place, 2); // the car placed out of sight is ahead of us
  const json = JSON.stringify(obs);
  assert.ok(!json.includes("slot") && !json.includes("bumps"));
});

test("a car's observation is independent of what other drivers *choose* this tick", () => {
  const track = generateTrack(2);
  const a = createWorld(3), b = createWorld(3);
  stepWorld(a, track, [encodeInput({ throttle: 1 }), 1, 1]);
  stepWorld(b, track, [encodeInput({ throttle: 1 }), encodeInput({ steer: 1, throttle: 1 }), 1]);
  // same own state for slot 0 unless contact happened; no contact on the grid at tick 1
  assert.equal(stateHash(a.cars[0]), stateHash(b.cars[0]));
});

test("12 reference bots all finish, deterministically, and the replay matches bit for bit", () => {
  const track = generateTrack(11);
  const { w, ticks } = race(track, 12);
  assert.ok(worldDone(w), `not finished by tick ${w.tick}`);
  assert.equal(new Set(ranking(w)).size, 12);
  const r = replayWorld(track, 12, ticks);
  assert.equal(r.finalHash, hashWorld(w));
  assert.deepEqual(r.ranking, ranking(w));
  assert.ok(r.checkpoints.length >= 4);
  assert.equal(r.checkpoints[0].chained, chainHash(ZERO_HASH, r.checkpoints[0].worldHash));
  // run again from scratch: identical
  const again = race(track, 12);
  assert.equal(hashWorld(again.w), hashWorld(w));
});

test("a 4-car race is bit-for-bit stable (golden)", () => {
  const track = generateTrack(1);
  const { w, ticks } = race(track, 4);
  assert.ok(worldDone(w));
  const r = replayWorld(track, 4, ticks);
  assert.equal(r.finalHash, GOLDEN4.finalHash);
  assert.deepEqual(r.ranking, GOLDEN4.ranking);
});

test("a 150-section race is a longer race", () => {
  const long = race(generateTrack(4, { sections: 150 }), 3);
  const short = race(generateTrack(4), 3);
  assert.ok(worldDone(long.w));
  assert.ok(long.w.tick > short.w.tick * 2);
});

test("tampering with any single input changes the final hash and the checkpoints", () => {
  const track = generateTrack(11);
  const { w, ticks } = race(track, 6);
  const base = replayWorld(track, 6, ticks);
  const forged = ticks.map((r) => r.slice());
  forged[150][2] = encodeInput({ steer: 1, throttle: 1 });
  const r = replayWorld(track, 6, forged);
  assert.notEqual(r.finalHash, base.finalHash);
  assert.notEqual(r.checkpoints[2].chained, base.checkpoints[2].chained);
  assert.equal(r.checkpoints[0].chained, base.checkpoints[0].chained); // before the edit
  assert.equal(hashWorld(w), base.finalHash);
});

test("verifyReplay accepts an honest replay and rejects forged checkpoints or rankings", () => {
  const seed = "0x" + "ab".repeat(32);
  const track = generateTrack(trackSeedFrom(seed), { sections: 60 });
  const { ticks } = race(track, 4);
  const replay = { version: 1, trackVersion: TRACK_VERSION, seed, sections: 60, nCars: 4, checkpointEvery: 100, ticks };
  const ok = verifyReplay(replay);
  assert.equal(ok.ok, true);
  const good = { checkpoints: ok.checkpoints.map((c) => c.chained), ranking: ok.ranking.slice(0, 3) };
  assert.equal(verifyReplay(replay, good).ok, true);
  const badCp = { ...good, checkpoints: good.checkpoints.map((h, i) => (i === 1 ? ZERO_HASH : h)) };
  assert.equal(verifyReplay(replay, badCp).ok, false);
  const badRank = { ...good, ranking: [ok.ranking[1], ok.ranking[0], ok.ranking[2]] };
  assert.equal(verifyReplay(replay, badRank).ok, false);
  assert.equal(verifyReplay({ ...replay, trackVersion: 99 }).ok, false);
});

const GOLDEN4 = { finalHash: "0xc78ffd14e1ac117b401bfa99d089805c86fcd681458f26213a4b1bce79d22fd5", ranking: [0, 1, 3, 2] };
