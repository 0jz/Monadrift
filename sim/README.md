# Monadrift real-time sim (prototype)

Phase 1 of turning Monadrift from "pick the highlighted lane" into a real racing game. This folder is a **deterministic driving simulation** with no chain and no network yet. The existing contract and backend are untouched.

## Idea

A race is fully described by `(seed, input log)`. Every tick (50 ms) each driver sends one input: steer `-1/0/1`, throttle, brake. The sim is pure and integer-only, so any client, server or verifier replays it bit for bit. Later phases put the seed commit-reveal, entry fees, payouts and state-hash checkpoints on Monad, and keep the driving off-chain.

## Model

- The car lives in the road's frame: distance along the road `s`, lateral offset `d`, speed `v`. No trigonometry, so results are identical in every JS engine.
- Each section has a curvature from -4 to 4. The road bends away from a straight line, and above the corner's safe speed the car also slides wide, so you brake before a bend and steer through it.
- The inside of a bend is the shorter way round, so the racing line is worth taking.
- Walls cost speed. Centre-line boost pads reward a tidy line.
- Fog of war: `observe()` shows only the next 8 sections, never the whole track and never a "correct lane" hint.

## Run it

```bash
node sim/run.js 1        # reference bot drives one lap, prints checkpoint hashes + log digest
node --test sim/*.test.js         # 12 tests incl. golden replay and tamper detection
python -m http.server -d sim 8000   # then open http://localhost:8000/demo.html and drive with the keyboard
```

## Files

| File | Purpose |
|---|---|
| `track.js` | seeded track generator |
| `sim.js` | physics step, input encoding, `observe()`, state hash, `runReplay()` |
| `world.js` | multiplayer: `createWorld`, `stepWorld` (collisions), `observeWorld` (adds nearby cars), `ranking`, keccak `hashWorld`/`chainHash`, `replayWorld`, `trackSeedFrom` |
| `keccak.js` | dependency-free Keccak-256 (cross-checked against ethers), runs in the browser |
| `verify.js` | `node sim/verify.js replay.json [expected.json]`: re-run a published race and compare checkpoints and ranking |
| `bot.js` | reference driver using only `observe()` (the future agent API shape) |
| `run.js` | CLI lap + replay verification |
| `sim.test.js` | determinism, golden replay, fairness and skill tests |
| `world.test.js` | keccak vectors, grid, collisions, ranking, fog, 12-car races, tamper detection, golden 4-car race |
| `demo.html` / `demo.js` | keyboard time trial with fog of war |

## Multiplayer (P1)

- 1 to 12 cars, grid of 3 abreast, slot 0 on pole. A one-car world is bit-identical to the single-car sim.
- Contact: cars overlapping in `(s, d)` are pushed apart sideways; the rear car drops to 90% of the front car's speed, the front car keeps 97%. Finished cars are ghosts.
- Race length is a track parameter: `generateTrack(seed, { sections: 150 })`. Default stays 60. `TRACK_VERSION` goes in every replay.
- `observeWorld()` returns the usual `ahead` window plus `others` (`ds, dd, dv` within 60 m, no identity), `place` and `field`.
- Checkpoints: `hashWorld` is keccak256 of a canonical int32 encoding; `chainHash(prev, h)` chains them so one late checkpoint pins all history. `ticks[t][slot]` is the whole replay.
- Race seed (uint256) to track seed (uint32): `trackSeedFrom`.
- Wall fix: contact only costs speed when pushed more than 40 mm past the wall, and only lateral velocity pointing into the wall is cancelled. Before, bumped cars could sit pinned at about 2 m/s on the outside of a hard bend for ever (18 of 60 bot races in a 30-seed sweep never finished or took over 75 s).

## Not done yet

The tick loop and netcode (backend), the canvas client, on-chain checkpoints and settlement, an agent API over WebSocket, and balance. A pack of 12 reference bots still bumps a lot (they all chase the same line), which is expected until bots use `others`.
