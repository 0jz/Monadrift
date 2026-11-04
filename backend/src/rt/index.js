// Real-time game entry point. initRt(app) mounts /rt and starts the tick loop;
// the caller routes WebSocket upgrades for /rt/ws to the returned handleUpgrade.
// Gate with RT_ENABLED=0. The legacy lane game is untouched.

import { Manager } from "./manager.js";
import { createLoop } from "./loop.js";
import { createRoutes } from "./routes.js";
import { createWs } from "./ws.js";
import { TICK_MS } from "./sim.js";

export function initRt(app, opts = {}) {
  if (process.env.RT_ENABLED === "0") return { enabled: false, handleUpgrade: null, stop() {} };

  let ws;
  const manager = new Manager({ onEvents: (room, events) => ws.onEvents(room, events), ...opts.manager });
  ws = createWs({ manager });
  const loop = createLoop({
    tickMs: opts.tickMs ?? TICK_MS,
    onTick: () => { manager.tickAll(); ws.broadcast(); },
  });
  app.use("/rt", createRoutes({ manager, loop }));
  loop.start();
  console.log(`[rt] real-time game on /rt (tick ${opts.tickMs ?? TICK_MS} ms)`);

  return {
    enabled: true, manager, loop,
    handleUpgrade: ws.handleUpgrade,
    stop() { loop.stop(); ws.close(); },
  };
}
