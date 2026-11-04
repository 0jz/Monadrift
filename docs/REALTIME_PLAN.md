# Monadrift real-time: plan

Status: proposal, no code written. The lane game (`src/Monadrift.sol`, `/race/*`, `race.html`) stays untouched and deployed until cutover (§7).

## 0. What the repo has today

| Piece | State | Consequence for the plan |
|---|---|---|
| `sim/` | Deterministic, integer-only, one car in road frame `(s, d, v, lv)`. 20 Hz, 12 tests pass. `observe()` shows 8 sections ahead. Reference lap is 505 ticks (25 s). | No multiplayer, no collisions, no opponent info in `observe()`. Hash is FNV-1a 32-bit (fine for tests, not for on-chain). Track seed is `uint32`, contract seed is `uint256`. |
| `src/Monadrift.sol` | Lane game, one tx per move, deployed at `0x052d…9851`. | Not extended. A new contract is added beside it. |
| `backend/src/index.js` | Lane routes, one `WebSocketServer({server, path:"/ws"})`. | New code goes under `/rt/*` and a second WS path. See the `ws` gotcha in §1. |
| `backend/src/chain.js` | Per-sender tx queue (1.5 s spacing for Monad's reserve rule), `reconnect()` on RPC errors. | Never call it from the tick loop. File is not valid UTF-8 (one stray byte in a comment), so it can only be edited with shell tools. Plan avoids editing it. |
| `frontend/` | `race.html`/`game.js` lane view, `lobby.*`, `join.js`, `shared.js` (`API`, `WS_BASE`). | Lobby, QR and identity code is reused as is. |

Two defects in the deployed lane game that affect settlement design (found while reading, not yet reproduced on chain):
1. `settle()` pays 50/30/20 of the pool to `min(finishers, 3)` winners. With 1 finisher, 50% of the pool stays in the contract forever; with 2, 20%.
2. No refund path. If nobody finishes, every stake is stuck.
`backend` also broadcasts `playerId` in every `move` event, and `playerId` is the only credential for `/race/:id/move`. Anyone watching the stream can move for someone else. The RT design below must not repeat that.

## 1. Multiplayer tick loop (backend)

New code in `backend/src/rt/`, additive:

- `world.js` (pure): `stepWorld(world, track, inputs)`. Calls the existing `step()` for each car in fixed slot order, then resolves car-vs-car overlaps. Existing single-car tests and golden replay stay valid.
- `room.js`: lobby, countdown, running, finished. Holds the world, latest input per slot, the input matrix log, and bots.
- `loop.js`: one global scheduler for all running rooms, not one timer per room.
- `routes.js`: HTTP routes. `ws.js`: WebSocket handler.
- `settle.js`, `chain-rt.js`: chain I/O, off the tick path.

### Tick mechanics
- Fixed 50 ms tick, drift-corrected: schedule against `start + n * 50` with `process.hrtime`, not `setInterval`. If late, run up to 3 catch-up ticks, then skip and log lag. Sim time stays authoritative, wall-clock only drives pacing.
- Each tick: read the last input per slot (hold-last if none arrived), `stepWorld`, push one snapshot to each connection. No awaits in this path. Chain calls are queued and fire-and-forget; a stuck RPC must never stall a race.
- Server authoritative. Clients send only `{steer, throttle, brake}` as the existing packed int (0..11). Nothing about position is trusted.
- Input rules: last write wins per tick, per-connection rate cap (say 40 msg/s), 16-byte message cap, `perMessageDeflate: false`.

### Multiplayer changes to the sim (the real work)
- `world = { tick, cars: [carState…] }`. A car is today's state plus `slot`.
- Overlap test in the road frame: `|Δs| < CAR_LEN && |Δd| < CAR_WIDTH`. Resolution is deterministic: process pairs in slot order, push apart laterally, the rear car loses speed (`v = min(v, front.v * k)`), the front car loses less. Rear-ending must cost the rammer, otherwise ramming is free.
- Start grid: `ceil(n/3)` rows, 3 abreast, 6 m row spacing. The opening is only 3 straight sections (60 m), so cap a race at 12 cars.
- Finish order: by `finishTick`, then by overshoot past the line, then slot. No ties.
- Fog: `observe(world, slot)` adds `others: [{ds, dd, dv}]` within ±60 m. `ahead` is unchanged so `bot.js` keeps working.
- Make `SECTIONS` a track parameter with a `trackVersion` byte. 25 s is short for a paid race. Suggest 150 sections (about 60 to 70 s) for RT races. Changing the generator breaks golden vectors, so it is versioned, not edited in place.
- Swap `stateHash` for keccak256 over a canonical int32 encoding of the world (new `hashWorld`), keep FNV for the old tests.

### Transport
- Add `/rt/ws` as a second WS endpoint. Gotcha: two `WebSocketServer({server, path})` instances on one HTTP server abort each other's handshake with a 400. Switch both to `noServer: true` and route in one `server.on("upgrade")` (about 6 lines in `index.js` tail, the only edit to existing backend code).
- Messages server to client: `lobby` (players, countdown), `snap` (tick, your observe window, other cars), `cp` (checkpoint confirmed on chain, hash, tx), `end` (ranking, replay link).
- Spectator socket: gets all cars every tick, but only the road window around the leader, so the projector does not leak the whole track to drivers watching it.
- Persistence: append the input matrix to `backend/data/replays/<raceId>.ndjson` as the race runs. A crash aborts the race and the contract's timeout refunds it (§3). No resume logic.

### Auth
`playerId` stays the bearer secret (random 48-bit ids from `/session/register`), but it is never emitted. Broadcasts use slot and display name only. WS auth is `?race=…&player=<id>` checked against the room's roster.

### Ops
Oracle E2.1.Micro is 1/8 OCPU; GC pauses will show as tick jitter. Prefer an Ampere A1 shape and a Frankfurt region for Belgrade players. Caddy proxies `wss`; send a ws ping every 20 s.

## 2. Frontend: top-down canvas race page

New files, old ones kept until cutover:
`frontend/race-rt.html`, `frontend/rt/net.js` (WS), `rt/render.js`, `rt/input.js`, `rt/hud.js`, `rt/sim/*` (copy of `sim/` core).

- **Sim copy for the browser:** Vercel serves `frontend/` only, so `sim/` cannot be imported across roots. Add `npm run sync-sim` (copies `sim/{sim,track,world}.js` to `frontend/rt/sim/`) and a CI step that fails on diff. Used for client prediction of your own car and for the replay viewer. Browser pages load it as `<script type="module">`.
- **Camera:** road-up, centred on your car, not car-up. Steering in the sim is lateral only (no yaw), so car-up would swing the view for no reason.
- **Road drawing:** accumulate heading from curvature per section (`θ += k·κ0·ds`, floats are fine, rendering is not consensus), subdivide each section into about 8 slices, fill the ribbon, draw walls, boost pads, start/finish and checkpoint lines. Only sections inside the fog window are drawn; past sections are cached as they reveal. Risk: a strongly curved seed can draw the road over itself. Tune `κ0` first; a generator bias is a last resort (it needs a `trackVersion` bump).
- **Cars:** rotated rects, colour per slot, name tag. Own car predicted locally at 60 fps and reconciled to snapshots; other cars interpolated about 100 ms behind.
- **HUD:** speed, position, time, mini progress strip with all cars, and the Monad moment: "CP 3 on-chain ✓ 0xab12… 430 ms".
- **Controls:** keyboard (arrows/WASD), phone buttons (left/right under thumbs, throttle, brake). Tilt steering later.
- **Lobby and QR kept:** `index.html` (join), `lobby.html`, `join.js` stay. Add a game selector (lanes / real-time) gated by `GET /rt/config`. After join, route to `race.html` or `race-rt.html`.
- **Id collision trap:** RT race ids come from a different contract, so they start at 0 like lane ids. QR and `?lobby=` links must carry `&game=rt` (new `/rt/lobby/:id/qr`); otherwise a scan joins a lane lobby with the same number.
- **Cutover:** `race.html` becomes `race-lanes.html` (reachable with `?game=lanes`), `race-rt.html` becomes `race.html`.

## 3. On-chain: entry fees, checkpoint hashes, settlement

The driving is off-chain. 20 Hz inputs cannot be transactions on a chain with ~400 ms blocks. Be explicit in the pitch: "every steer is a transaction" (PROJECT.md §1, §3) becomes "entry, tamper-evident checkpoints every ~5 s, and settlement are on Monad; the replay is public and re-runnable". The Monad story is cheap frequent commitments and 24/7 agent races at a 1% rake.

### New contract `MonadriftRT.sol` (separate file, separate deploy)
The lane contract has no proxy, so changes mean a redeploy anyway. A new contract also keeps the lane game alive.

State per race: `mode`, `phase {LOBBY, COMMITTED, RUNNING, SETTLED, CANCELLED}`, `entryFee`, `maxPlayers`, `players[]`, `payoutTo[player]`, `commitHash`, `createdAt`, `startedAt`, `pot`.

| Function | Who | Does |
|---|---|---|
| `createRace(mode, entryFee, maxPlayers)` | operator | opens lobby |
| `join(raceId, payoutTo)` payable | player | exact fee, one join per address, `maxPlayers` cap. `payoutTo` lets winners be paid to a real wallet instead of a backend-derived session key |
| `commitSeed(raceId, commitHash)` | operator | closes lobby. Starts the race clock |
| `checkpoint(raceId, index, worldHash)` | operator | emits `Checkpoint(raceId, index, worldHash)` only. No storage write, so it stays cheap |
| `settle(raceId, seed, salt, winners[≤3], replayRoot)` | operator | checks `keccak(seed,salt)==commit`, winners are players, pays fee + split, emits seed and `replayRoot` |
| `cancel(raceId)` | anyone | refunds all, once `LOBBY_TIMEOUT` passed in LOBBY/COMMITTED or `RESULT_TIMEOUT` (say 10 min) after start with no `settle` |
| `claim()` | anyone | withdraw credited balance |

Design decisions:
- **Seed revealed at settle, not at start.** The lane game reveals at start because the contract computes segments. Here the contract never needs the track, and revealing at start would publish the whole track to every bot before the green light, defeating fog of war. Commit-before-join means the operator cannot pick a track after seeing the roster.
- **Fixing the remainder bug:** the 50/30/20 split renormalises over actual winners (1 → 100%, 2 → 62.5/37.5). Zero finishers: `settle` with an empty list refunds everyone (no fee).
- **Pull payments:** `settle` credits `owed[addr]` instead of pushing `call{value}`. Settle gas is then a fixed few SSTOREs, and a reverting payout address cannot block a race. Backend auto-claims for session wallets so the demo still shows "payout hit your wallet".
- **Trust model, stated plainly:** the operator posts the result. The chain does not re-run the sim. What it gives you is: fees locked on chain, no token custody by the operator, a track fixed before the roster, checkpoint hashes timestamped during the race, the whole replay published, and refunds if the operator disappears. A mismatch is provable off chain by anyone with `node sim/verify.js <raceId>` (replays inputs, compares every `Checkpoint` and the final ranking). On-chain fraud proofs are out of scope.
- **Drop stake/HP/penalty mechanics** from the RT game. Collisions are physical (speed loss). PROJECT.md §2 needs a rewrite for RT.

### Backend wiring (`rt/chain-rt.js`, no edit to `chain.js`)
- Reuses `provider`, `funder`, `sendTx` through live bindings; new `RT_CONTRACT_ADDRESS` and a separate ABI file `contract/MonadriftRT.abi.json` (regenerate from `out/` after contract changes, as for the lane ABI).
- Flow: `createRace` (operator) → players `join` from session wallets (parallel, different senders) → `commitSeed` → countdown overlaps the confirmation → race → `checkpoint` every 100 ticks (5 s) via a queue → finish/timeout → `settle` → auto-`claim`.
- Checkpoint hash chains: `h_i = keccak(h_{i-1} ‖ worldHash_i)`, so one late checkpoint still pins the whole history.
- **Gas, without touching `TX_OVERRIDES`:** Monad bills the full declared limit. Each RT call gets its own constant limit from `forge test --gas-report`, plus 25%. The shared 200,000 default is not raised. If `settle` with 3 winners measures near 200k, switch to credit-only (already planned) before considering any change, and ask first.
- **Reserve rule and the funder queue:** the funder lane spaces sends 1.5 s. One race posts a checkpoint every 5 s, so about 3 concurrent races saturate it, together with funding and `createRace`. Options: a dedicated `RT_OPERATOR_PRIVATE_KEY` (you add it to `backend/.env`; I will not touch that file), or `checkpointBatch(raceIds[], …)`. Start with the dedicated key.
- Proof endpoint `GET /rt/race/:id/proof`: `getLogs` filtered by the indexed `raceId` topic and chunked by block range from the race's `createdBlock`. The lane `/race/:id/proof` failure is likely `getLogs` from block 0 on a public RPC; the RT version avoids that by design.

### Foundry
`test/MonadriftRT.t.sol` (join caps, exact fee, wrong reveal, 1/2/3/0 winners, rounding, refund timeouts, reentrancy on `claim`), `script/DeployRT.s.sol`. Existing contract tests untouched.

## 4. Bots on the same `observe()` API

- **Contract of the API:** a bot receives exactly what the human client renders: `observe(world, slot)` (own state, 8 sections ahead, nearby cars). It returns `{steer, throttle, brake}` or the packed int.
- **External agents:** WebSocket `/rt/ws`. Each tick the server sends `{type:"obs", tick, obs}` and the agent replies `{type:"in", i}`. HTTP fallback for scripts that cannot hold a socket: `GET /rt/race/:id/observe?playerId=` and `POST /rt/race/:id/input`. Same no-wallet ethos as `/lobby/quickmatch`. Late inputs are not lockstep-waited; hold-last applies, so a slow bot just drives worse.
- **Reference bots:** `agent-example/rt-bot.js` wraps `sim/bot.js` `drive()` (safe) and adds `aggressive` (uses `others` to sit in the leader's line and block, not ram). Same `STRATEGY=safe|aggressive` switch and `AGENT_ONLY|HUMAN_ONLY` mode argument as `agent-example/bot.js`.
- **House bots in a room:** run in-process through the same `observe` call, flagged `isBot` in the lobby. Lobby modes from PROJECT.md §11 carry over unchanged (`HUMAN_ONLY` quickmatch never mixes with agents).
- **Fairness note:** latency differs between a phone and a VM-local bot. Server applies inputs on its own tick clock for everyone; nothing else is done in this plan to equalise it.

## 5. Phases (each shippable, lane game untouched throughout)

| # | Deliverable | Verified by |
|---|---|---|
| P0 (optional, small) | Lane game: `POST /race/:id/settle` and auto-trigger, `/proof` log-range fix, stop broadcasting `playerId`. The `settle` remainder bug needs a redeploy, so only document it | one real settled lane race on testnet |
| P1 | `sim/` multiplayer: `stepWorld`, collisions, grid, finish order, `observe` with others, keccak `hashWorld`, `trackVersion`/`SECTIONS`, `sim/verify.js` | `node --test sim/*.test.js`, new golden vectors for a 4-car race |
| P2 | `backend/src/rt/` rooms, tick loop, `/rt/ws`, HTTP agent API, replay files, in-process bots, no chain | 12 bots for a full race, measured tick jitter, no input flood stall |
| P3 | `race-rt.html` canvas, input, HUD, lobby selector, QR `game=rt`, sim sync script + CI diff | playable locally vs bots on desktop and phone width |
| P4 | `MonadriftRT.sol`, Foundry tests, deploy script, `chain-rt.js`, checkpoints, settle, auto-claim, cancel path | testnet race end to end: entry, checkpoints on explorer, payout received, forced refund |
| P5 | Balance (accel, grip, collision, race length), 24/7 bot-only soak, PROJECT.md/README/DEPLOY.md updates, cutover | soak with zero stuck races |

P1 → P2 → P3 is one thread. P4's contract and tests only touch `src/`, `test/`, `script/`, so it can run in parallel with P1 to P3; only the backend wiring waits for P2.

## 6. Open decisions (defaults chosen, change any before P1)

1. **Pitch shift:** per-steer transactions go away (above). Default: accept.
2. **Seed reveal:** at settle (default) or at start.
3. **House bots and the pot:** default is bots race for free and are ineligible for prizes, so they cannot take winnings from humans or drain the funder.
4. **Race size:** default max 12 cars, about 60 s. The "40 people off one QR" idea from PROJECT.md §10 does not fit a 12 m road. Options: several parallel lobbies (per-lobby QR already exists), or heats and a final.
5. **Payout destination:** default `join(raceId, payoutTo)` with the session address as fallback, so a connected wallet can be added later without a contract change.
6. **Free-roam physics (yaw, drifting, spin-outs):** out of scope. It means a new sim and fixed-point trig to stay deterministic. The current model is lateral-only steering, which suits top-down and replays.

## 7. Constraints honoured

- `backend/.env` not read or edited. New variables the user must add: `RT_CONTRACT_ADDRESS`, `RT_OPERATOR_PRIVATE_KEY` (optional), `RT_ENABLED`. `.env.example` is already modified in the working tree, so entries are proposed, not applied, until you say so.
- `TX_OVERRIDES` unchanged. RT calls use their own measured limits.
- Existing lane routes, `/ws`, `race.html`, `Monadrift.sol` and its ABI unchanged until P5 cutover.

## Status notes

- **P2 (done):** `backend/src/rt/`; replays are held in memory (disk files not written); no chain wallet yet.
- **P3 (done, server-driven):** `frontend/race-rt.html` + `frontend/rt/{app,render,net,input}.js`. The client draws what the server sends (extrapolated between 20 Hz snaps); **no client-side prediction and no `sim/` copy yet**, so there is no `sync-sim` script or CI diff. Lobby and QR live inside `race-rt.html` (QR → `race-rt.html?lobby=<id>`); the lanes pages and `index.html` are untouched and there is no game selector yet. Dev without chain: `node backend/scripts/rt-dev.js` then open `/race-rt.html`.
- **P4 (code done, not deployed):** `src/MonadriftRT.sol` (21 Foundry tests), `script/DeployRT.s.sol`, `backend/src/rt/{chain-rt,paid,fee}.js`, `/rt` routes. Paid lobbies: `POST /rt/lobby/create {entryFee:"0.01", payoutTo?}` (max 0.5 MON), joins pay from the player's session wallet, `commitSeed` at countdown, a `checkpoint` tx every 5 s, `settle` (top 3 renormalised) at the end, auto-claim for session-wallet payouts, `GET /rt/race/:id/proof` for on-chain events. Chain calls never block the tick loop; failures are recorded in `paid.error`. Trust model: the operator posts the result; the chain does not re-run the sim; anyone can check the replay with `node sim/verify.js`.
  - Gas limits are per call (`GAS` in `chain-rt.js`), `TX_OVERRIDES` itself is untouched. Measured warm: settle(3 winners, 12 players) 110k, cancel(12) 282k, join <=143k. Cold-storage cost may be higher, hence the margins.
  - To enable: `forge script script/DeployRT.s.sol --account <keystore> --broadcast --rpc-url monad_testnet`, then set `RT_CONTRACT_ADDRESS` (and optionally `RT_OPERATOR_PRIVATE_KEY`, default is the funder) in `backend/.env`. Not yet run against a live chain or anvil; only against a fake chain in `backend/test/rt-paid.test.js`.
  - No frontend entry-fee UI yet.
- **P5 (done, except live-chain soak):** Balance. 12-bot races had ~22% DNFs: bumps shove cars onto the outer wall of tight bends, where the bend drift (`k*v/DRIFT_DIV`) beats steering authority at every speed, so they stay pinned. Fix: `DRIFT_DIV` 250 -> 360 in `sim/sim.js` (DNF about 1%, wall hits per car 35 -> 7), `sim/bot.js` now uses the constant, and house bots no longer lift below 15 m/s when a car is ahead. `TRACK_VERSION` is now 2 (physics is versioned with the track, so v1 replays fail verification loudly); golden vectors regenerated (reference lap 504 ticks, new 4-car hash). Soak: 6 parallel 12-bot rooms at the true tick, 12/12 finished in every room, zero skipped ticks, p99 lag 16 ms. Cutover: `race.html` -> `race-lanes.html`, `index.html` gets a "Play real-time" card above the lane join. README/PROJECT.md/DEPLOY.md not edited (README has your uncommitted changes).
- **Post-P5 polish (physics v4, themed UI):**
  - Cars now rotate: yaw is `atan2(lateralRate, v/20)` clamped to ±0.6 rad, taken from `lv` (observations gained `dlv` for other cars, spectator view gained `lv`), smoothed for your own car. The menu, lobby, HUD and track use the site theme (`frontend/rt/rt.css`, lime kerbs, angular cars).
  - Wall rule: the 30% speed loss is a one-off impact; a car already on the wall pays 3%/tick sliding friction (`WALL_SLIDE_PCT`). Before, clipping the outside of a bend pinned a human at ~10 km/h.
  - Steering floor: `STEER_MIN_SPEED` 24 m/s, so a slow car can always turn off a wall. With only the wall rule, 12-bot DNF rose to ~10%; with the floor it is 0% (8 and 12 bots, 30 races each), 0.7 wall hits per car. `TRACK_VERSION` is 4; goldens regenerated.
  - Not verified: a steered human lap and the phone layout.
