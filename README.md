# Monadrift

An on-chain checkpoint racer on Monad testnet where the track is generated seconds before the race, humans and AI agents race on identical rules, and every steer is a real transaction settled in ~600ms.

Built at [Monad Blitz Belgrade](https://luma.com/blitz-belgrade-aug-2026), 2026-08-22.

[ LIVE DEMO LINK ] · [ SCAN TO PLAY (QR) ] · [ DEMO VIDEO/GIF ]

---

## What it is

Racers pick a lane at each checkpoint on a straight, start-to-finish track nobody has seen — the seed is only revealed one block before the race starts, so no bot or human can pre-compute an optimal path. Every move costs staked points, so the winner isn't whoever spams transactions fastest, it's whoever routes most efficiently. Cars sharing a lane collide: the faster car deals damage, the loser respawns at their last checkpoint. Run out of stake — not hp — and you're out for good.

Not Mario Kart: no items, no laps, one straight race to the finish, where the only "weapon" is choosing to contest another racer's lane.

## Why Monad

Monad does ~10,000 tps with ~300ms blocks and ~600ms finality. That number isn't a footnote here — it's the actual game clock. The track reveals one checkpoint at a time (fog-of-war), so every racer, human or agent, has to decide, submit, and get on-chain confirmation before the next choice matters. On a slower chain this game is unplayable in real time; on Monad it's fast enough to feel like an actual race.

## How fairness works

1. Contract commits to `keccak256(seed)` when the lobby opens — seed itself stays hidden.
2. The race-start transaction reveals `seed`. Track segments are derived deterministically and cheaply on demand (`segmentAt(seed, i)`), not stored in full.
3. Only the *next* segment is ever exposed to a player/agent — regardless of who already knows the seed, nobody can decode more than one step ahead. That's the actual fairness boundary, not the seed's secrecy.
4. Because blocks land in ~300–600ms, even an agent that instantly decodes a revealed segment gets essentially zero head start over a human tapping a button. Route efficiency and stake management decide the race, not compute speed.

## Playing as an AI agent

No wallet, no ABI encoding, no web3 library required — just HTTP.

```bash
# join any open lobby automatically
curl -X POST https://<host>/lobby/quickmatch -d '{"playerId":"agent-1","entryFee":100}'

# poll race state
curl https://<host>/race/<id>/state

# submit a move — response only returns once the tx is confirmed on-chain (~600ms)
curl -X POST https://<host>/race/<id>/move -d '{"playerId":"agent-1","direction":"LEFT"}'

# live updates
wscat -c wss://<host>/race/<id>/stream
```

A minimal reference bot (greedy-safe: always plays the best odds from what's been revealed so far, same fog-of-war rules as everyone) is in [`/agent-example`](./agent-example).

## Architecture

```
                 ┌──────────────┐
  phone / web ───│              │
  browser        │   Backend    │──── relayer wallet ──── Monad testnet
                 │  (HTTP + WS) │                          (chain id 10143)
  AI agent  ─────│              │
  (curl/script)  └──────────────┘
```

- **Contract** (Solidity, Foundry): commit-reveal seed, `segmentAt()`, `chooseLane()`, stake/hp/speed accounting, checkpoint respawn, treasury fee cut.
- **Backend**: thin HTTP/WebSocket API wrapping the contract behind a single funded relayer wallet — no per-player wallet required, every action is still a genuine individual on-chain transaction.
- **Frontend**: isometric track view for the projector, a simplified phone-sized client for QR-code PvP entry.

## Monetization

Standard rake, same model as poker rooms / DFS platforms: `pot = entryFee × lobbySize`, a fixed service fee is skimmed to a treasury address, the remainder splits across the top 3 finishers. Payout scales with lobby size — bigger lobbies (or agents racing continuously with no fatigue) mean more fee volume per hour.

## Running locally

```bash
foundryup --network monad
git clone <this repo> && cd monadrift
forge install && forge build
forge create src/Monadrift.sol:Monadrift --account monad-deployer --broadcast   # testnet
cd backend && npm install && npm start
cd frontend && npm install && npm run dev
```

Faucet: https://faucet.monad.xyz — fund the relayer wallet before demoing, gas adds up across a room full of players.

## Team

<!-- names / roles -->

## License

MIT
