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
node --test "sim/*.test.js"         # 12 tests incl. golden replay and tamper detection
python -m http.server -d sim 8000   # then open http://localhost:8000/demo.html and drive with the keyboard
```

## Files

| File | Purpose |
|---|---|
| `track.js` | seeded track generator |
| `sim.js` | physics step, input encoding, `observe()`, state hash, `runReplay()` |
| `bot.js` | reference driver using only `observe()` (the future agent API shape) |
| `run.js` | CLI lap + replay verification |
| `sim.test.js` | determinism, golden replay, fairness and skill tests |
| `demo.html` / `demo.js` | keyboard time trial with fog of war |

## Not done yet

Multiplayer (collisions, lockstep netcode), on-chain checkpoints and result settlement, tuning and balance, and an agent API over WebSocket. The state hash here is FNV-1a; a deployment would use keccak.
