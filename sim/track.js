// Deterministic track generation. Integer-only: the same seed yields the same
// track in every JS engine, which is what lets a replay be verified later.

export const SECTION_LEN = 20000; // mm (20 m)
export const SECTIONS = 60; // 1.2 km lap (default; see generateTrack opts.sections)
// Bump when the generator output changes for an existing (seed, sections), so
// old replays can say which generator they were recorded with.
export const TRACK_VERSION = 6; // 6: no constant bend drift, only over-speed slide (bendSlide). 5: gentler bend push (DRIFT_DIV 600, GRIP_DIV 40). 4: steering authority floor (STEER_MIN_SPEED) so slow cars can leave a wall. 3: wall hit is one-off, sliding costs 3%/tick. 2: DRIFT_DIV 250 -> 360 (P5 balance). Physics is versioned with the track so old replays fail loudly.
export const HALF_WIDTH = 6000; // mm from centre line to each wall
export const MAX_CURVE = 4; // curvature levels -4..4 (sign = left/right)

// splitmix32: tiny, fast, integer-only PRNG.
export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/**
 * @param {number} seed  uint32
 * @param {{sections?:number}} opts  race length in sections (default 60)
 * @returns {{ seed:number, version:number, curv:Int8Array, boost:Uint8Array }}
 * curv[i]  signed curvature of section i (positive = bends right)
 * boost[i] 1 if section i has a centre-line boost pad
 */
export function generateTrack(seed, { sections = SECTIONS } = {}) {
  const rng = makeRng(seed);
  const curv = new Int8Array(sections);
  const boost = new Uint8Array(sections);
  let k = 0;
  for (let i = 0; i < sections; i++) {
    const inOpening = i < 3;
    const inFinish = i >= sections - 2;
    if (inOpening || inFinish) {
      k = 0;
    } else if (rng() % 100 < 45) {
      // change the bend: usually a step, sometimes a sharp switch
      const step = (rng() % 3) - 1 + (rng() % 100 < 15 ? (rng() % 2 ? 2 : -2) : 0);
      k = Math.max(-MAX_CURVE, Math.min(MAX_CURVE, k + step));
    }
    curv[i] = k;
    boost[i] = !inOpening && !inFinish && Math.abs(k) <= 1 && rng() % 100 < 12 ? 1 : 0;
  }
  return { seed: seed >>> 0, version: TRACK_VERSION, curv, boost };
}
