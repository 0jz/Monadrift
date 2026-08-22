# Monadrift

An on-chain checkpoint racer on Monad testnet where the track is generated seconds before the race, humans and AI agents race under identical rules, and every steer is a real transaction confirmed in under a second.

Built at [Monad Blitz Belgrade](https://luma.com/blitz-belgrade-aug-2026), 2026-08-22.

**[▶ Play it live](https://monadrift.vercel.app)** · Contract: [`0xdD4A725BCb895c5B4392eE1ae7827b33aF92bB9A`](https://testnet.monadvision.com/address/0xdD4A725BCb895c5B4392eE1ae7827b33aF92bB9A) on Monad testnet (chain id `10143`)

---

## What it is

Racers pick a lane at each checkpoint on a straight, start-to-finish track nobody has seen — the seed is only revealed one block before the race starts, so no bot or human can pre-compute an optimal path. Every move costs a bit of staked MON, so the winner isn't whoever spams transactions fastest, it's whoever routes most efficiently. Cars sharing a lane collide: the faster car deals damage and steals stake, the loser respawns at their last checkpoint. Run out of stake — not HP — and you're out of the race for good.

Not a Mario Kart clone: no items, no laps, one straight race to the finish, where the only "weapon" is choosing to contest another racer's lane.

**Two ways to race**: a **Duel** (1v1, starts the instant a second player scans in) or a **Public lobby** (open field, starts whenever the creator's ready) — both shareable via a QR code.

## Why Monad

Monad runs at up to ~10,000 tps with ~300ms blocks and sub-second finality. That number isn't a footnote here — it's the actual game clock. The track reveals one checkpoint at a time (fog-of-war), so every racer, human or agent, has to decide, submit, and get on-chain confirmation before the next choice matters. On a slower chain this game is unplayable in real time; on Monad it's fast enough to feel like an actual race.

## How fairness works

1. The contract commits to `keccak256(seed, salt)` when a lobby is created — the seed itself stays hidden.
2. Starting the race reveals `seed`. Track segments are derived deterministically and cheaply on demand (`segmentAt(seed, i)`), never stored in full.
3. Only the *next* segment is ever exposed to a player or agent, gated by their own on-chain position — regardless of who already knows the seed, nobody can decode more than one step ahead. That's the actual fairness boundary, not the seed's secrecy.
4. Lane collisions resolve by transaction order, not physics: whichever `chooseLane` confirms first for a segment+lane claims it.

## Playing as an AI agent

No wallet, no ABI encoding, no web3 library — just HTTP. The backend holds a funded relayer wallet per session (derived deterministically from your `playerId`, so it's stable across restarts) and submits your moves as real on-chain transactions.

```bash
API=https://monadrift-backend-production.up.railway.app

# register (playerId is optional — omit it and the backend generates one)
curl -X POST $API/session/register -d '{"playerId":"agent-1"}'

# join or create an open public lobby
curl -X POST $API/lobby/create -d '{"playerId":"agent-1","type":"public"}'
# -> { "raceId": "...", ... }

# poll race state
curl $API/race/<raceId>/state

# read the next segment (only reveals what your position allows — see "How fairness works")
curl "$API/race/<raceId>/segment/<i>?playerId=agent-1"

# submit a move — response only returns once the tx is confirmed on-chain
curl -X POST $API/race/<raceId>/move -d '{"playerId":"agent-1","direction":"CENTER"}'

# live updates over WebSocket
wscat -c wss://monadrift-backend-production.up.railway.app/ws?raceId=<raceId>
```

A minimal reference bot (greedy-safe: always plays the best known odds, never sees further ahead than a human would) is in [`agent-example/bot.js`](./agent-example/bot.js).

## Architecture

```
  phone / web browser ──┐
                         ├──► Vercel (static frontend) ──► Railway (backend, HTTP + WS)
  AI agent (curl/bot)  ──┘         monadrift.vercel.app         relayer wallet ──► Monad testnet
```

- **Contract** ([`src/Monadrift.sol`](./src/Monadrift.sol), Foundry): commit-reveal seed, `segmentAt()`, `chooseLane()`, stake/HP/speed accounting, checkpoint respawn, 1% treasury fee.
- **Backend** ([`backend/`](./backend), Node/Express + WebSocket): wraps the contract behind per-session relayer wallets — every action is still a genuine individual on-chain transaction, the player just never touches a private key.
- **Frontend** ([`frontend/`](./frontend), plain HTML/CSS/JS, no build step): register → lobby select (Duel/Public + QR) → race, isometric track view, arrow-key controls.

## Monetization

Standard rake, same model as poker rooms or DFS platforms: `pot = (entryFee × lobbySize) + accumulated move fees`, a 1% service fee skims to a treasury address, the remainder splits across the top 3 finishers. Kept deliberately thin — the revenue story is race *frequency* (agents can race continuously with zero fatigue), not a big per-race cut.

## Running locally

```bash
# contract
foundryup --network monad
forge install
forge build
forge script script/Deploy.s.sol --account <your-keystore> --broadcast --rpc-url monad_testnet

# backend
cd backend
npm install
cp .env.example .env   # fill in FUNDER_PRIVATE_KEY, SESSION_SEED, CONTRACT_ADDRESS
npm start              # serves the frontend too, at http://localhost:8787

# fund the relayer wallet
# https://faucet.monad.xyz
```

The backend serves the frontend directly at `http://localhost:8787` in local dev — no separate frontend server needed.

## License

MIT
