// House bots. They see exactly what an external agent or a human client sees:
// the observeWorld() result for their slot, nothing else.
import { drive, encodeInput, CAR_LEN, CAR_WIDTH } from "./sim.js";

const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/**
 * "safe": the reference driver plus plain traffic manners. Without the manners a
 * pack of identical bots all chase one line and bump hundreds of times a race.
 * "aggressive": same, but sits in front of the nearest car behind to block it.
 * @returns {number} packed input
 */
export function botInput(strategy, obs) {
  const inp = drive(obs);

  // Car just ahead in our way: lift, and slide to the side with more room.
  const ahead = obs.others
    .filter((o) => o.ds > 0 && o.ds < CAR_LEN * 3 && Math.abs(o.dd) < CAR_WIDTH * 1.3)
    .sort((a, b) => a.ds - b.ds)[0];
  if (ahead) {
    if (ahead.ds < CAR_LEN * 2 && ahead.dv < 0) { inp.throttle = 0; }
    inp.steer = Math.abs(obs.d) > 4000 ? -sign(obs.d) : ahead.dd === 0 ? (obs.d > 0 ? -1 : 1) : -sign(ahead.dd);
    return encodeInput(inp);
  }

  if (strategy === "aggressive") {
    const chaser = obs.others
      .filter((o) => o.ds < 0 && o.ds > -CAR_LEN * 4 && Math.abs(o.dd) < CAR_WIDTH * 2.5)
      .sort((a, b) => b.ds - a.ds)[0];
    if (chaser && Math.abs(obs.d) < 4500) inp.steer = sign(chaser.dd); // move across to meet it
  }
  return encodeInput(inp);
}
