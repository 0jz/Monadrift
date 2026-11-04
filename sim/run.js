// node sim/run.js [seed]  — drive one lap with the reference bot and print a
// summary, checkpoint hashes and the replay-log digest.
import { createHash } from "node:crypto";
import { generateTrack } from "./track.js";
import { createState, step, observe, encodeInput, runReplay, stateHash, TICK_MS } from "./sim.js";
import { drive } from "./bot.js";

const seed = Number(process.argv[2] ?? 1) >>> 0;
const track = generateTrack(seed);

const st = createState();
const log = [];
while (st.finishTick < 0 && st.tick < 20000) {
  const input = encodeInput(drive(observe(st, track)));
  log.push(input);
  step(st, track, input);
}

const replay = runReplay(track, log);
const digest = createHash("sha256").update(Uint8Array.from(log)).digest("hex");

console.log(`seed ${seed}`);
console.log("track  " + Array.from(track.curv, (k) => (k === 0 ? "." : k > 0 ? String(k) : String.fromCharCode(96 - k))).join(""));
console.log("       (digit = right bend, letter a-d = left bend, . = straight)");
console.log(`finish ${(st.finishTick * TICK_MS) / 1000}s  (${st.finishTick} ticks), wall hits ${st.wallHits}`);
console.log(`replay verifies: ${replay.hash === stateHash(st)}`);
console.log(`checkpoints (every 100 ticks): ${replay.checkpoints.map((h) => h.toString(16).padStart(8, "0")).join(" ")}`);
console.log(`input log sha256: ${digest}`);
