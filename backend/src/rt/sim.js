// The one place the backend imports the driving sim from. sim/ lives at the repo
// root so it is tested and shared with the frontend; deploys that clone the whole
// repo (Oracle VM, docs/DEPLOY.md Option B) just work. A deploy that only ships
// backend/ (Render with rootDir: backend) must vendor sim/ here instead: change
// only this file.
export * from "../../../sim/world.js";
export { generateTrack, TRACK_VERSION, SECTION_LEN, HALF_WIDTH } from "../../../sim/track.js";
export { encodeInput, decodeInput, TICK_MS, V_MAX } from "../../../sim/sim.js";
export { drive } from "../../../sim/bot.js";
export { verifyReplay, REPLAY_VERSION } from "../../../sim/verify.js";
