// Replay verifier. Anyone can re-run a published race and compare it with what
// the operator committed.
//
//   node sim/verify.js replay.json [expected.json]
//
// replay.json  { version:1, trackVersion, seed:"0x…uint256", sections, nCars,
//                checkpointEvery, ticks:[[packedInput per slot] per tick] }
// expected.json (optional) { checkpoints:["0x…chained"…], ranking:[slot…] }
//   P4 fills this from the contract's Checkpoint events and the settled winners.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateTrack, TRACK_VERSION } from "./track.js";
import { replayWorld, trackSeedFrom, CHECKPOINT_EVERY } from "./world.js";

export const REPLAY_VERSION = 1;

export function verifyReplay(replay, expected = {}) {
  const errors = [];
  if (replay.version !== REPLAY_VERSION) errors.push(`unsupported replay version ${replay.version}`);
  if (replay.trackVersion !== TRACK_VERSION) errors.push(`track generator v${replay.trackVersion}, this verifier has v${TRACK_VERSION}`);
  if (errors.length) return { ok: false, errors };

  const track = generateTrack(trackSeedFrom(replay.seed), { sections: replay.sections });
  const r = replayWorld(track, replay.nCars, replay.ticks, { checkpointEvery: replay.checkpointEvery ?? CHECKPOINT_EVERY });

  if (expected.checkpoints) {
    const got = r.checkpoints.map((c) => c.chained);
    if (got.length !== expected.checkpoints.length) errors.push(`checkpoint count: replay ${got.length}, expected ${expected.checkpoints.length}`);
    got.forEach((h, i) => {
      if (expected.checkpoints[i] !== undefined && h !== expected.checkpoints[i]) errors.push(`checkpoint ${i} differs`);
    });
  }
  if (expected.ranking && JSON.stringify(expected.ranking) !== JSON.stringify(r.ranking.slice(0, expected.ranking.length))) {
    errors.push(`ranking: replay ${JSON.stringify(r.ranking)}, expected prefix ${JSON.stringify(expected.ranking)}`);
  }
  return { ok: errors.length === 0, errors, checkpoints: r.checkpoints, ranking: r.ranking, finalHash: r.finalHash, ticks: r.world.tick };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , replayPath, expectedPath] = process.argv;
  if (!replayPath) { console.error("usage: node sim/verify.js replay.json [expected.json]"); process.exit(2); }
  const out = verifyReplay(JSON.parse(readFileSync(replayPath, "utf8")), expectedPath ? JSON.parse(readFileSync(expectedPath, "utf8")) : {});
  console.log(out.ok ? "OK" : "MISMATCH");
  for (const e of out.errors) console.log("  " + e);
  if (out.ranking) console.log(`ticks ${out.ticks}, ranking ${JSON.stringify(out.ranking)}, final ${out.finalHash}`);
  process.exit(out.ok ? 0 : 1);
}
