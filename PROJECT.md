# Monadrift

Monad Blitz Belgrade — 2026-08-22. On-chain checkpoint racer where the track is generated seconds before the race, humans and AI agents race on identical rules, and every steer is a real Monad transaction settled in ~600ms.

---

## 1. The pitch, one paragraph

Racers pick a lane at each checkpoint on a straight point-to-point track nobody has seen — the seed is only revealed one block before the race starts, so no bot or human can pre-compute an optimal path. Every move costs a bit of your staked points, so the winner isn't whoever spams transactions fastest, it's whoever routes most efficiently. Cars sharing a lane on the same segment collide — one gets destroyed and pays a stake penalty to the survivor. Run out of stake (from moves or from being destroyed) and you're out, regardless of position. It's playable by humans (tap buttons, watch an isometric track) and by AI agents (same HTTP API, no wallet/web3 boilerplate needed) side by side, PvP or agent-vs-agent — which only works because Monad confirms fast enough that "wait for finality" doesn't kill the pacing. On any slower chain this game literally isn't playable in real time.

Not a Mario Kart clone: no items, no rubber-banding, no laps — pure start-to-finish point race with checkpoints, where the only "weapon" is choosing to contest another racer's lane.

---

## 2. Core gameplay loop

1. Lobby opens. Contract commits to `keccak256(seed)` (seed itself hidden).
2. Players join, put down a fixed stake of virtual points.
3. Race start tx reveals `seed`. Track is generated deterministically from it (see §4). Segment 0 is shown; rest stay hidden until reached (fog-of-war, one segment ahead max).
4. Each tick, every player picks a lane (`LEFT` / `CENTER` / `RIGHT`) for the next segment. Picking a lane = one on-chain tx, costs `MOVE_COST` points from their stake.
   - Wrong lane on an obstacle segment = stake penalty (keep it to one penalty type, not two — see open decisions).
   - Correct lane = advance one segment.
5. **Collision:** if two cars are in the same lane on the same segment, they collide. Resolution is by tx order, not physics — whichever `chooseLane` tx confirms first for that segment+lane "claims" it and is the attacker; the car whose tx confirms into an already-claimed segment+lane is the target. Damage dealt = `max(1, attacker.speed)` HP off the target, and the target's `speed` resets to 0. The target also pays a fixed `COLLISION_PENALTY` from its stake directly to the attacker's stake (steals, doesn't burn — rewards contesting lanes as a real strategy, not just a griefing option).
6. **Speed:** each player has a `speed` stat, 0–3. +1 for every consecutive clean segment cleared (no collision, no obstacle penalty), capped at 3; resets to 0 on any hit taken. BOOST segments can bump it further. This is what "speed at the moment of a hit" means in a track with no continuous physics — a small bounded integer, not a velocity vector.
7. **Wrecked vs. broke — only one of these ends your race:**
   - **Wrecked:** `hp` hits 0 (starts at `HP_MAX`, e.g. 3, only loses HP from being the target of a collision) — respawn at your last passed checkpoint, `hp` and `speed` reset, position rolled back. Not eliminated — the lost track progress plus the stake already paid out during the collision (§loop item 5) is the penalty. Keeps everyone in the race for the whole demo window instead of getting knocked out in minute two.
   - **Broke:** stake hits 0 (from move costs, obstacle penalties, or paying out collisions) — this is the only true elimination, out immediately regardless of track position or hp.
8. First to the final checkpoint (or most segments cleared when the clock runs out) wins the rank. Top 3 finishers split the pot (see §11 for the exact formula) — payout scales with lobby size, so a 40-racer lobby pays out more than a 4-racer one.
9. Live leaderboard + track visualization updates in real time on the projector as segments/positions confirm.

Flat `MOVE_COST`/`COLLISION_PENALTY` for everyone, funded from the same fixed entrance stake — deliberately **not** scaled to a player's outside wallet balance. Reading "how rich is this player" and pricing moves off it turns into a fairness argument you'd have to defend on stage instead of a mechanic you can explain in one sentence; skip it.

---

## 3. Why this is "pushing Monad to its limits"

- Every single lane choice is an individual, real, confirmed transaction — not a batched/optimistic move applied off-chain. With N players making a choice every ~1-2s, that's real concurrent write load on the same race's state.
- Fog-of-war (one segment revealed at a time) forces reaction speed: a player/agent has to decide, submit, and get confirmation before the next segment matters. This is only fun/fair because Monad's ~600ms total transaction time keeps the loop tight — on a chain with multi-second finality this degenerates into "guess blind and wait."
- Live projector display of confirmation latency per move ("your steer landed in 480ms") is the single best "why Monad" visual for the audience vote.

---

## 4. Seeded track generation

**Fairness goal:** nobody — human or agent — can precompute a winning input sequence before the race starts.

**Mechanism: commit-reveal, revealed one block before go.**

```
// at lobby creation
commitHash = keccak256(abi.encodePacked(seed, salt))   // seed kept off-chain by organizer/contract owner
contract.commit(commitHash)

// at race start (T-0)
contract.startRace(seed, salt)
  require(keccak256(abi.encodePacked(seed, salt)) == commitHash)
  emit RaceStarted(seed)
```

Track segments are derived deterministically and cheaply from `seed` — no storage needed for the full track, just compute segment `i` on demand:

```solidity
function segmentAt(uint256 seed, uint256 i) public pure returns (SegmentType) {
    uint256 h = uint256(keccak256(abi.encodePacked(seed, i)));
    uint256 r = h % 100;
    if (r < 55) return SegmentType.STRAIGHT;      // 55% straight
    if (r < 80) return SegmentType.TURN;          // 25% turn (one lane wrong)
    if (r < 95) return SegmentType.OBSTACLE;       // 15% obstacle (two lanes wrong)
    return SegmentType.BOOST;                      // 5% boost (refunds MOVE_COST)
}
```

Which lane is "correct" on a TURN/OBSTACLE segment is itself derived from `keccak256(seed, i, "lane")` — so it's not just segment *type* that's unknown in advance, it's which choice is right.

Frontend/agents only ever learn segment `i`'s type+correct-lane-requirement when segment `i-1` is cleared (fog-of-war) — the contract or off-chain indexer simply doesn't expose `segmentAt(i)` for `i > currentPosition + 1`. This is what actually blocks pre-computation, not the seed's secrecy after reveal — the seed becomes public the instant the race starts, but the *decoding one step ahead* is the fairness boundary that matters.

**Why one block before go:** with 300–600ms blocks, even an agent that instantly decodes the whole track the moment the seed is public has essentially zero head start over a human clicking a button — the race clock and the reveal happen close enough together that raw compute speed isn't the deciding edge. Route efficiency and stake management are.

---

## 5. Data model (state, not physics)

Keep the track a **flat 1D array of discrete segments**, not a 2D/3D coordinate space. This is the single decision that makes both isometric rendering *and* agent-friendliness easy simultaneously.

```
Segment { index: uint16, type: STRAIGHT | TURN | OBSTACLE | BOOST, correctLane: LEFT | CENTER | RIGHT | null, isCheckpoint: bool }
PlayerState { addr/id, position: uint16, lastCheckpoint: uint16, stake: uint256, hp: uint8, speed: uint8, alive: bool }
RaceState { seed, startBlock, segmentsTotal, checkpointIndices: uint16[], players: PlayerState[] }
```

No physics, no vectors, no collision geometry. A "move" is `chooseLane(raceId, direction)`. This is exactly as easy for a Python/JS bot to reason about as it is for a Solidity contract to store.

**Boundary and checkpoint-gating come for free from this model, no extra mechanic needed:** lane choice is a fixed 3-value enum, so there's no continuous position to leave the map from — "cutting the track a bit" is exactly what picking a different lane already is. Position only ever advances one segment at a time (fog-of-war forbids skipping), so a player physically cannot reach checkpoint N without having passed every segment up to it. `isCheckpoint` segments just update `lastCheckpoint` on arrival, which is what a wreck respawn (§2) rolls back to. Finishing is reaching the final segment, which by construction already implies every checkpoint before it was cleared — "all checkpoints" and "the last one" are the same win condition, not two.

---

## 6. Rendering: isometric visual, 2D-discrete state

You asked 2D vs 3D — **do isometric, but only as a rendering layer on top of the flat segment array above, not a real 3D world.**

- Real 3D (Three.js + physics/collision) is a build-time trap for the hours you have left, and it's actively bad for agents (continuous state is harder to reason about than an array index).
- Isometric-over-discrete-segments is a solved, cheap pattern: draw each `Segment` as a diamond/tile at a fixed offset along an iso axis, players are sprites that lerp between tile centers on confirmation. Looks like a "real" racing game on the projector, costs you almost nothing over building flat 2D, because the underlying data you're drawing from is identical either way.
- Practical implementation: HTML canvas or a lightweight lib (PixiJS) drawing a scrolling column of tiles; no game engine needed.
- **Fallback if time runs out:** flat top-down 2D (lanes as vertical columns, segments scroll upward). Same data model, same code paths minus the iso transform — cut this only if isometric is eating your last hour.

---

## 7. Agent accessibility — yes, build a thin HTTP/WS API

Don't make agents speak raw JSON-RPC/ABI-encoding — that's friction nobody wants to write against in a few hours, and it privileges whoever already has web3 tooling ready (not fair, not fun to build against). **Wrap the contract in a small HTTP + WebSocket API** that both your own frontend and any third-party agent script hit identically:

```
POST /lobby/join              { playerId, entryFee }   -> joins open lobby, or...
POST /lobby/quickmatch        { playerId, entryFee }   -> auto-matches into any open lobby (this is what makes agent-vs-agent self-serve — an agent script never needs a human to click "join" for it)
GET  /race/:id/state          -> current segment index, per-player position/stake, race phase
GET  /race/:id/segment/:i     -> segment i's type + correct lane (only if i <= yourPosition+1, else 403)
POST /race/:id/move           { playerId, direction }  -> relayed as on-chain tx, responds once confirmed (~600ms)
WS   /race/:id/stream         -> live push: SegmentRevealed, PlayerMoved, PlayerEliminated, RaceEnded
```

`quickmatch` is what lets you claim "agents can autonomously enter and play Monadrift with zero human involvement" — an agent script polling `/lobby/quickmatch` then `/race/:id/state` and POSTing `/move` never touches a UI. Worth saying explicitly in the pitch.

This is also where the relayer pattern from [monad-hackathon skill](../../../.claude/skills/monad-hackathon/SKILL.md) plugs in: `/move` accepts a simple JSON body (no signature required for the fun/no-wallet path), the backend's single funded relayer wallet submits the real on-chain tx, and the response only returns after the tx is confirmed — so an agent's HTTP call latency *is* Monad's finality latency, which is the whole point you're demonstrating.

Publish a 10-line example bot (Python or JS, just polls `/state` and POSTs `/move`) as your agent-onboarding doc — this is your "look, an AI agent can play this in 10 lines" audience moment.

---

## 8. Local hosting for the demo

Two layers, don't conflate them:

**Chain:** run against real **Monad testnet** for authenticity (chain ID `10143`, RPC `https://testnet-rpc.monad.xyz` — see [monad-hackathon skill](../../../.claude/skills/monad-hackathon/SKILL.md)). This is what makes "600ms finality" a true claim on stage, not a simulated one.

**App stack, run locally on the demo laptop:**
- Contract already deployed to testnet ahead of time (don't redeploy live).
- Backend (Node/Express or FastAPI) running locally, holding the funded relayer wallet, serving the HTTP/WS API from §7, talking to testnet RPC.
- Frontend (static Vite/Next build) served locally, connects to `localhost:PORT` backend via WS.
- Expose the local backend to phones in the room via the venue wifi (laptop's LAN IP) or a portable hotspot you control — **do not depend on venue wifi reaching the actual Monad RPC from 80 phones**; only your one backend laptop needs internet, phones only need to reach your laptop's local server.

**Fallback (wifi dies entirely):** a `--offline` flag on the backend that points at a local Monad devnet/solonet instance (see Monad Solonet in the skill doc) instead of testnet, so the demo still runs end-to-end on stage even with zero internet — narrate honestly that you've switched to a local node if this happens, don't pretend it's still testnet.

---

## 9. Monetization — the hackathon's business-model requirement

Standard rake model, same as poker rooms / DFS platforms — easy to explain in one sentence to judges, no novel mechanism needed:

```
pot = entryFee * lobbySize
serviceFee = pot * FEE_RATE        // e.g. 8%
payoutPool = pot - serviceFee
```

`payoutPool` splits across the top 3 finishers (e.g. 50% / 30% / 20%). `serviceFee` accrues to a protocol treasury address in the contract — that's your literal answer to "how does this make money": every race, regardless of who wins, skims a fixed percentage off the top before payout. Bigger lobbies (more players, or agent-heavy lobbies racing 24/7 with no human fatigue) mean more races per hour means more fee volume — that's the actual scaling story if a judge asks "how does this grow."

## 10. Phone client — PvP-only, QR entry

Separate, simpler client from the main demo screen:

- Projector shows a QR code linking straight to the mobile join page (plain web page, no app install — same frontend stack, phone-sized layout). Works identically on laptop — same page, same lobby, just a wider layout, not a separate client.
- Scan → session id generated client-side (no wallet) → lands directly in `/lobby/quickmatch` for a human-only PvP lobby. **Multiplayer by default, not duels** — a lobby holds however many players join within its countdown window (see QoL below), same as the main demo lobby. 1v1 can happen if only two people scan in time, but it's not the designed mode.
- UI is just the lane buttons + your car's position on a simplified track strip — skip the full isometric view on phone, that's the projector's job. Phone shows just enough to make the decision (next segment type) and confirm your move landed.
- This is also your large-lobby moment: run one big PvP-only lobby off the QR code with everyone in the room simultaneously, payout top 3 per §9 — gives you both the "look how many people are transacting on Monad right now" spectacle and a concrete demonstration of the lobby-size-scales-payout mechanic in the same beat.
- **Per-lobby QR codes:** `GET /lobby/:id/qr` returns a QR encoding that specific lobby's join URL (`?lobby=<id>`), not just a generic "go to the site" link. Lets you run several lobbies in parallel — e.g. one big open room off the main projector QR, plus smaller side-table lobbies people start themselves and share their own QR for — without any of them colliding into the same pool.

---

## 11. Lobby modes — keeping agents off real players by default

The fairness angle cuts both ways: fog-of-war stops anyone pre-computing a path, but nothing so far stops a script from quietly farming a room full of humans in every lobby, which is a bad look for a "fair racing" pitch the moment someone notices. Fix: lobbies have an explicit `mode`, and `quickmatch` never mixes pools on its own.

```
mode: HUMAN_ONLY | AGENT_ONLY | SHOWCASE_MIXED
```

- `/lobby/quickmatch` from the phone/web client only ever matches into `HUMAN_ONLY` lobbies.
- `/lobby/quickmatch` from an agent session only ever matches into `AGENT_ONLY` lobbies — agents can race each other freely, all day, unattended.
- `SHOWCASE_MIXED` is not reachable through quickmatch at all — it's created explicitly (an operator/demo flag), used for the one live "watch a human race an agent" pitch moment, and torn down after. Mixed racing is a deliberate demo feature, not a default anyone can stumble into.

This is also a cheap, honest answer if a judge asks "how do you stop bots exploiting human players" — the answer isn't a detection system, it's that they're never in the same pool unless you explicitly put them there.

---

## 12. On-chain race proof — the tx log *is* the replay

Every move is already its own confirmed transaction (§2), which means a full, tamper-proof race replay is sitting in the chain's history for free — you don't need to build a separate "prove this race was fair" system.

- `GET /race/:id/proof` — pulls every `chooseLane`/`CellClaimed`-equivalent event for that race id directly from chain logs, returns an ordered list: `{txHash, block, timestamp, playerId, action, resultingPosition}`.
- Anyone — a judge, a skeptical audience member, another team — can independently reconstruct exactly what happened in a race from public chain data alone, with no need to trust your backend or frontend. This is a genuinely strong claim for a hackathon judged partly on "why blockchain, not just a fast server."
- Free QoL feature that falls out of this: a **replay viewer** — feed `/proof`'s output back into the same isometric renderer used live, and you get a "watch this race again" screen for the post-race/victory beat, built from the same rendering code, no separate replay system to write.

---

## 13. QoL features worth adding if time allows (roughly priority order)

1. **Lobby countdown + minimum players:** a visible "race starts in Ns / needs N more players" state so latecomers scanning the QR know whether they'll make it in, and lobbies don't hang open forever waiting.
2. **Reconnect/session persistence:** if a phone drops wifi mid-race, rejoining with the same session id should resume at current position/stake, not restart — venue wifi *will* drop someone.
3. **Live rank indicator:** your current placement among all racers, updated on the phone UI in real time, not just the projector leaderboard — the single cheapest "feels alive" addition.
4. **Post-race stat card:** finish rank, tx count, avg confirmation time, damage dealt/taken — shareable, and doubles as pitch material ("here's what Monad just did for you in 90 seconds").
5. **Replay viewer** (falls out of §12 almost free — do this after the above, not before).

Cut anything below #3 first if the clock runs out — the game working reliably beats any of these.

---

## 14. Demo strategy: bot opponent & map seed

Two separate questions, don't conflate them:

**"Who races if not enough humans show up?"** — build the example agent bot from §7 anyway (you need it as an integration test regardless), and give it a genuinely simple heuristic so it's not a pushover or an unbeatable optimum:
- **Greedy-safe bot:** always picks the lane with the best known odds given revealed-so-far segment stats (it doesn't get to see ahead — same fog-of-war rules as everyone). Simple, beatable by a human paying attention, loses realistically to collisions since it won't contest lanes aggressively.
- Optionally a second **aggressive bot** that deliberately contests the lane a leading player is likely in, to show off the collision mechanic live without relying on two humans doing it on cue. This is worth building specifically because "watch two bots crash into each other" is a great unscripted-looking demo beat that's actually fully scripted and safe to rely on.
- Run these as two more clients hitting your own HTTP API (§7) — no special-casing in the contract or backend, they're just more players. That consistency is itself worth saying out loud during the pitch.

**"Random seed or premade map for the demo?"** — don't build two systems. Use the one seeded-generation mechanism (§4) for everything, and just control *which seed* depending on context:
- During build/rehearsal: use a fixed, known dev seed so you get reproducible tracks to debug and practice against.
- For the actual live race: let the commit-reveal produce a genuinely fresh seed, exactly as designed. This is the moment your fairness pitch has to be real, not staged — don't fake it with a "premade" track dressed up as random, the whole point collapses if someone asks and it turns out predetermined.
- If you're worried about an unlucky/degenerate track (e.g. an obstacle-heavy opening segment killing the pacing), bias the segment-type distribution in `segmentAt()` (§4) rather than pre-selecting a specific seed — keep the randomness real, just tune the odds.

---

## 15. Build order (re-check against actual hours remaining before starting)

1. Contract: commit-reveal + `segmentAt()` + `chooseLane()` + stake/hp/speed accounting + checkpoint respawn + `serviceFee` treasury cut (§9). (Highest priority — everything depends on this.)
2. Backend API wrapping it (§7), including `/lobby/quickmatch` with mode separation (§11), + relayer wallet funded from faucet.
3. Minimal frontend: isometric or flat-2D track view + lane buttons, wired to WS stream. Phone-sized variant per §10 once desktop view works.
4. Example agent script (greedy-safe bot, then aggressive bot if time allows) — doubles as your own integration test and demo filler (§14).
5. Polish: live confirmation-latency readout, leaderboard, victory screen with stats. QoL from §13 only if time remains.
6. Rehearse with the offline fallback path, and with the fixed dev seed (§14), at least once before demo time.

## 16. Open decisions to lock before coding

- Exact `MOVE_COST` / `COLLISION_PENALTY` / `FEE_RATE` / `HP_MAX` / stake economics numbers (needs a couple minutes of math, not guessing live).
- Isometric vs flat-2D — pick based on time remaining when frontend work starts, not upfront.
- Top-3 payout split ratio (e.g. 50/30/20) — pick a number now, don't leave it open.
- Confirmed: **path-like (start-to-finish) track, not a closed loop** — no lap counter, no wraparound indexing, matches the "not Mario Kart" framing and needs zero changes to the fog-of-war segment-array design already in §4–5.
