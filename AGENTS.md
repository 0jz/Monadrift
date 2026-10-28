# AGENTS.md — Monadrift

On-chain checkpoint racer on Monad testnet: Solidity contract (Foundry) + Node/Express/WS relayer backend + static vanilla-JS frontend.

## Commands
- Contract: `forge install` (populates `lib/forge-std`), `forge build`
- Deploy: `forge script script/Deploy.s.sol --account <keystore> --broadcast --rpc-url monad_testnet` (optional `TREASURY` env)
- Backend: `cd backend && npm install && npm start` → http://localhost:8787 (also serves `frontend/`)
- Reference bot: `node agent-example/bot.js http://localhost:8787 agent-1 [AGENT_ONLY|HUMAN_ONLY]`, `STRATEGY=safe|aggressive`
- Frontend: no build step. Tests / lint: none (no `test/` dir, no lint config).

## Where logic lives
- `src/Monadrift.sol` — game rules: commit-reveal seed, `segmentAt`, `chooseLane`, stake/HP, respawn, `FEE_BPS = 100` (1%), payouts.
- `backend/src/index.js` — all HTTP routes, rate limits, lobby metadata, WebSocket `/ws`, `LANES` array.
- `backend/src/chain.js` — provider, funder, per-player session wallets `keccak256(SESSION_SEED:playerId)`, `TX_OVERRIDES` gas settings.
- `backend/src/contract/Monadrift.abi.json` — committed ABI; re-extract from `out/` after any contract change (`out/` is gitignored and not deployed).
- `frontend/shared.js` — picks backend: localhost when served locally, else the Railway URL.
- `PROJECT.md` — design doc; code comments reference its sections (§10, §14…).

## Conventions
- Backend is ESM JavaScript, ethers v6. Contract is Solidity 0.8.24, chain id 10143.
- `LANES` order in `index.js` must match the `Lane` enum in `Monadrift.sol` exactly.
- Comments explain *why* (often a past production bug) — preserve them.

## Do not touch / commit
- `backend/.env` (`FUNDER_PRIVATE_KEY`, `SESSION_SEED` — the seed derives every player's private key).
- Foundry keystores, `broadcast/`, `out/`, `cache/` (gitignored).
- Don't raise the gas limit in `TX_OVERRIDES` "for safety": Monad testnet bills the full declared limit.

## Gotchas
- POST bodies need `Content-Type: application/json` (`express.json()`).
- `CHAIN_ID` in `.env.example` is unused; `FRONTEND_URL` is used (QR links) but missing from `.env.example`.
- Changing `SESSION_SEED` reassigns every player a new wallet.

Humans: see README.md
