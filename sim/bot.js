// Reference driver: reads only what observe() exposes (fog of war), so a human,
// this bot and any third-party agent all race under the same information.

import { V_MAX, BRAKE, TICK_MS, safeSpeed } from "./sim.js";
import { SECTION_LEN, HALF_WIDTH } from "./track.js";

const BRAKE_MM_S2 = (BRAKE * 1000) / TICK_MS; // deceleration in mm/s^2

/** @returns {{steer:number, throttle:number, brake:number}} */
export function drive(obs, { margin = 0.92, lineBias = 0.35 } = {}) {
  const { v, d, lv, ahead, distToNextSection } = obs;

  // Highest speed we can carry now and still reach each upcoming section at
  // its safe speed, given our braking power.
  let target = V_MAX;
  for (let j = 0; j < ahead.length; j++) {
    const sec = ahead[j];
    if (!sec) break;
    const dist = j === 0 ? 0 : distToNextSection + (j - 1) * SECTION_LEN;
    const vt = safeSpeed(sec.curv) * margin;
    const allowed = Math.sqrt(vt * vt + 2 * BRAKE_MM_S2 * dist);
    if (allowed < target) target = allowed;
  }
  const throttle = v < target ? 1 : 0;
  const brake = v > target + 1500 ? 1 : 0;

  // Line: hug the inside of the current bend a little, centre on straights.
  const k = ahead[0] ? ahead[0].curv : 0;
  const want = Math.trunc(Math.sign(k) * Math.min(Math.abs(k), 3) * lineBias * (HALF_WIDTH / 3));
  const drift = -Math.trunc((k * v) / 250);
  const predicted = d + lv * 3 + drift * 3;
  const err = want - predicted;
  const dead = 150;
  const steer = err > dead ? 1 : err < -dead ? -1 : 0;

  return { steer, throttle: brake ? 0 : throttle, brake };
}
