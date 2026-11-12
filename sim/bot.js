// Reference driver: reads only what observe() exposes (fog of war), so a human,
// this bot and any third-party agent all race under the same information.

import { V_MAX, BRAKE, STEER_RATE, CENTER_RATE, safeSpeed, roadCurv, lockCurv } from "./sim.js";
import { SECTION_LEN, HALF_WIDTH } from "./track.js";

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const nextSa = (sa, steer) =>
  steer !== 0 ? clamp(sa + steer * STEER_RATE, -1000, 1000) : sa > 0 ? Math.max(0, sa - CENTER_RATE) : Math.min(0, sa + CENTER_RATE);

/** @returns {{steer:number, throttle:number, brake:number}} */
export function drive(obs, { margin = 1, lineBias = 0.35 } = {}) {
  const { v, d, h, sa, ahead, distToNextSection } = obs;

  // Highest speed we can carry now and still reach each upcoming section at
  // its safe speed, given our braking power.
  let target = V_MAX;
  for (let j = 0; j < ahead.length; j++) {
    const sec = ahead[j];
    if (!sec) break;
    const dist = j === 0 ? 0 : distToNextSection + (j - 1) * SECTION_LEN;
    const vt = safeSpeed(sec.curv) * margin;
    target = Math.min(target, Math.sqrt(vt * vt + 2 * BRAKE * dist));
  }
  const brake = v > target + 1500 ? 1 : 0;
  const throttle = !brake && v < target ? 1 : 0;

  // Line: hug the inside of the current bend a little, centre on straights.
  const k = ahead[0] ? ahead[0].curv : 0;
  const want = Math.sign(k) * Math.min(Math.abs(k), 3) * lineBias * (HALF_WIDTH / 3);
  // Point at the line some distance ahead, then ask for the curvature that
  // follows the road plus a correction toward that heading.
  const hWant = clamp((want - d) / Math.max(10000, v * 0.8), -0.3, 0.3);
  const cWant = roadCurv(k) + (hWant - h / 1e6) / Math.max(4000, v * 0.3);
  const saWant = clamp((cWant / lockCurv(v)) * 1000, -1000, 1000);
  let steer = 0;
  for (const s of [-1, 1]) if (Math.abs(nextSa(sa, s) - saWant) < Math.abs(nextSa(sa, steer) - saWant)) steer = s;

  return { steer, throttle, brake };
}
