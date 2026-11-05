// Real-time soak: N concurrent 12-bot races at the true 50 ms tick, then print jitter.
//   node backend/scripts/rt-soak.js [rooms=4]
import { Manager } from "../src/rt/manager.js";
import { createLoop } from "../src/rt/loop.js";

const rooms = Number(process.argv[2] ?? 4);
const manager = new Manager({ allowShowcase: true });
for (let i = 0; i < rooms; i++) {
  const r = manager.create({ mode: "SHOWCASE_MIXED" });
  r.fillBots(12);
  r.start();
}
const loop = createLoop({
  onTick: () => {
    manager.tickAll();
    if ([...manager.rooms.values()].every((r) => r.phase === "finished")) { loop.stop(); report(); }
  },
});
const t0 = Date.now();
loop.start();

function report() {
  const s = loop.stats();
  console.log(`${rooms} rooms x 12 bots finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`ticks ${s.ticks}, skipped ${s.skipped}, p99 lag ${s.p99LagMs.toFixed(2)} ms, max lag ${s.maxLagMs.toFixed(2)} ms, max tick work ${s.maxWorkMs.toFixed(2)} ms`);
  for (const r of manager.rooms.values()) console.log(`room ${r.id}: ${r.result().ticks} ticks, ${r.result().ranking.filter((x) => x.finishTick !== null).length}/12 finished`);
}
