import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";
import crypto from "node:crypto";
import { readContract, getOrCreateSession, contractFor, provider, funder, TX_OVERRIDES, sendTx, retryRpc } from "./chain.js";

// A single unexpected RPC error (rate limit, transient network blip, an
// ethers internal poll rejecting outside the normal call chain) previously
// crashed this entire process — taking down every connected player mid-
// race. This is the last line of defense: log it, keep serving. Individual
// requests still fail cleanly via their own try/catch; this only stops a
// stray rejection from ending the whole server.
process.on("unhandledRejection", (err) => console.error("[unhandled rejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaught exception]", err));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
// Single server for the demo laptop — see PROJECT.md §8. Phones only need
// to reach this one process; it's the only thing that needs internet.
app.use(express.static(path.join(__dirname, "..", "..", "frontend")));

// ethers' default err.message for a contract revert is a multi-hundred-
// character dump of the raw tx/payload — the actual human-readable reason
// (e.g. "not active") is usually sitting in err.reason. Prefer that.
function cleanErrorMessage(err) {
  return err?.reason || err?.shortMessage || String(err?.message || err);
}

const PORT = process.env.PORT || 8787;
const LANES = ["FAR_LEFT", "LEFT", "CENTER", "RIGHT", "FAR_RIGHT"]; // order must match the Lane enum in Monadrift.sol exactly
const DUEL_MAX_PLAYERS = 2;

// The funder wallet pays real (test)MON per new session — a public URL
// with no auth on /session/register is otherwise a straightforward drain
// vector once it's reachable off localhost (e.g. tunneled for Vercel).
// New playerIds only: an existing session's repeat registration is free
// (getOrCreateSession just returns the cached wallet), so this only
// throttles actual new-wallet funding, not normal reconnects.
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many new sessions from this IP — try again shortly." },
});
// Looser general limiter on every other route as defense-in-depth.
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded — slow down." },
});
app.use("/session", generalLimiter);
app.use("/lobby", generalLimiter);
app.use("/race", generalLimiter);

// mode -> open raceId waiting for players (in-memory matchmaking; the
// contract itself doesn't track "open" lobbies, this is just routing)
const openLobbies = { HUMAN_ONLY: null, AGENT_ONLY: null, SHOWCASE_MIXED: null };
const DEFAULT_ENTRY_FEE = "0.001"; // ether, matches PROJECT.md placeholder economics

// raceId -> { type: "duel" | "public", createdBy }. Only tracks the bits the
// contract itself has no concept of (capacity, who's allowed to auto-start).
const lobbyMeta = new Map();

// raceId -> Set<ws> for the live stream
const streams = new Map();
function broadcast(raceId, payload) {
  const set = streams.get(String(raceId));
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === 1) ws.send(msg);
}

/// Commits and reveals a seed back-to-back to actually start a race — see
/// PROJECT.md §4. This was a genuine gap: nothing previously called this,
/// which means `chooseLane` would always have reverted with "not running".
/// Two operator (funder-paid) transactions, not a player cost.
async function startRace(raceId) {
  const { ethers } = await import("ethers");
  const c = contractFor(funder);
  const seed = BigInt(ethers.hexlify(ethers.randomBytes(32)));
  const salt = BigInt(ethers.hexlify(ethers.randomBytes(32)));
  const commitHash = ethers.keccak256(ethers.solidityPacked(["uint256", "uint256"], [seed, salt]));

  await sendTx(() => c.commitSeed(raceId, commitHash, TX_OVERRIDES));
  await sendTx(() => c.startRace(raceId, seed, salt, TX_OVERRIDES));

  broadcast(raceId, { type: "started", raceId });
}

// --- lobby / matchmaking ---

app.post("/session/register", registerLimiter, async (req, res) => {
  try {
    // playerId can be a self-chosen address/handle, or omitted entirely —
    // "wallets or generated" per PROJECT.md. It's a lookup key for the
    // backend-managed session wallet either way, never a real signer's key.
    let { playerId } = req.body;
    if (!playerId) playerId = `p-${crypto.randomBytes(6).toString("hex")}`;
    const wallet = await getOrCreateSession(playerId);
    res.json({ playerId, address: wallet.address });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

/// Explicit lobby creation for the register -> lobby-select -> race flow
/// (PROJECT.md §10). "duel" caps at 2 players and auto-starts the instant
/// the second player joins; "public" has no cap and starts when the
/// creator calls /race/:id/start.
app.post("/lobby/create", async (req, res) => {
  try {
    const { playerId, type = "public", entryFee = DEFAULT_ENTRY_FEE } = req.body;
    if (!playerId) return res.status(400).json({ error: "playerId required" });
    if (!["duel", "public"].includes(type)) return res.status(400).json({ error: "type must be duel or public" });

    const { ethers } = await import("ethers");
    const feeWei = ethers.parseEther(String(entryFee));
    const operatorContract = contractFor(funder);
    const receipt = await sendTx(() => operatorContract.createLobby(0, feeWei, TX_OVERRIDES)); // HUMAN_ONLY
    const raceId = readContract.interface.parseLog(receipt.logs[0]).args.raceId.toString();
    lobbyMeta.set(raceId, { type, createdBy: playerId });

    const wallet = await getOrCreateSession(playerId);
    await sendTx(() => contractFor(wallet).join(raceId, { value: feeWei, ...TX_OVERRIDES }));

    res.json({ raceId, playerAddress: wallet.address, type });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

/// Manual start for "public" lobbies — the creator decides when enough
/// people have joined. "duel" lobbies never need this, they auto-start.
app.post("/race/:id/start", async (req, res) => {
  try {
    await startRace(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

app.post("/lobby/quickmatch", async (req, res) => {
  try {
    const { playerId, mode = "HUMAN_ONLY", entryFee = DEFAULT_ENTRY_FEE, lobby } = req.body;
    if (!playerId) return res.status(400).json({ error: "playerId required" });

    const wallet = await getOrCreateSession(playerId);
    const { ethers } = await import("ethers");
    const c = contractFor(wallet);

    let raceId, feeWei;

    if (lobby) {
      // Joining a specific lobby via its QR code (PROJECT.md §10) — bypasses
      // mode-pool matchmaking entirely. Whoever generated this QR (via
      // GET /lobby/:id/qr or POST /lobby/showcase) already decided who's
      // allowed to scan it; SHOWCASE_MIXED is reachable this way on purpose.
      raceId = lobby;
      const phase = await retryRpc(() => readContract.getPhase(raceId));
      if (Number(phase) !== 0) {
        return res.status(409).json({ error: "lobby is no longer open" });
      }
      const meta = lobbyMeta.get(raceId);
      if (meta?.type === "duel") {
        const current = await retryRpc(() => readContract.getPlayers(raceId));
        if (current.length >= DUEL_MAX_PLAYERS) {
          return res.status(409).json({ error: "duel lobby is full" });
        }
      }
      // Trust the chain for the required fee, not the client-supplied one —
      // a specific lobby was already created with its own entryFee.
      feeWei = await retryRpc(() => readContract.getEntryFee(raceId));
    } else {
      if (mode === "SHOWCASE_MIXED") {
        return res.status(403).json({ error: "SHOWCASE_MIXED lobbies are operator-only, not reachable via quickmatch — see PROJECT.md §11" });
      }
      feeWei = ethers.parseEther(String(entryFee));
      raceId = openLobbies[mode];
      if (raceId === null) {
        // Lobby creation is an operator cost, not something the first
        // player to arrive should pay gas for — use the funder wallet,
        // not the player's session wallet.
        const modeIdx = mode === "AGENT_ONLY" ? 1 : 0;
        const operatorContract = contractFor(funder);
        const receipt = await sendTx(() => operatorContract.createLobby(modeIdx, feeWei, TX_OVERRIDES));
        raceId = readContract.interface.parseLog(receipt.logs[0]).args.raceId.toString();
        openLobbies[mode] = raceId;
      }
    }

    await sendTx(() => c.join(raceId, { value: feeWei, ...TX_OVERRIDES }));

    const meta = lobbyMeta.get(raceId);
    if (meta?.type === "duel") {
      const current = await retryRpc(() => readContract.getPlayers(raceId));
      if (current.length >= DUEL_MAX_PLAYERS) {
        startRace(raceId).catch((err) => console.error(`[start] duel ${raceId} failed to auto-start:`, err));
      }
    }

    res.json({ raceId, playerAddress: wallet.address, mode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

/// Operator-only escape hatch for the one live "human vs agent" demo moment.
app.post("/lobby/showcase", async (req, res) => {
  try {
    const { entryFee = DEFAULT_ENTRY_FEE } = req.body;
    const { ethers } = await import("ethers");
    const c = contractFor(funder);
    const receipt = await sendTx(() => c.createLobby(2, ethers.parseEther(String(entryFee)), TX_OVERRIDES)); // SHOWCASE_MIXED = 2
    const raceId = readContract.interface.parseLog(receipt.logs[0]).args.raceId.toString();
    res.json({ raceId });
  } catch (err) {
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

// Backend and frontend are on different origins now (Railway vs Vercel) —
// req.protocol/req.get("host") would build a QR pointing at the *backend's*
// own domain, not the actual site people should land on. FRONTEND_URL is
// the one place that needs updating if the frontend's URL ever changes.
const FRONTEND_URL = process.env.FRONTEND_URL || "https://monadrift.vercel.app";

app.get("/lobby/:id/qr", async (req, res) => {
  const base = req.query.base || FRONTEND_URL;
  const url = `${base}/?lobby=${req.params.id}`;
  const png = await QRCode.toBuffer(url, { width: 512 });
  res.set("Content-Type", "image/png");
  res.send(png);
});

// --- race state ---

app.get("/race/:id/state", async (req, res) => {
  try {
    const raceId = req.params.id;
    const phase = await retryRpc(() => readContract.getPhase(raceId));
    const addrs = await retryRpc(() => readContract.getPlayers(raceId));
    const pot = await retryRpc(() => readContract.getPot(raceId));
    const players = await Promise.all(
      addrs.map(async (a) => {
        const p = await retryRpc(() => readContract.getPlayer(raceId, a));
        return {
          address: a,
          stake: p.stake.toString(),
          position: Number(p.position),
          lastCheckpoint: Number(p.lastCheckpoint),
          hp: Number(p.hp),
          speed: Number(p.speed),
          alive: p.alive,
          finished: p.finished,
        };
      })
    );
    res.json({ raceId, phase: Number(phase), pot: pot.toString(), players });
  } catch (err) {
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

/// Fog-of-war gate: only reveal segment i if the requesting player has
/// already reached i-1. See PROJECT.md §4 — this endpoint, not the seed's
/// secrecy, is the actual fairness boundary.
app.get("/race/:id/segment/:i", async (req, res) => {
  try {
    const raceId = req.params.id;
    const i = Number(req.params.i);
    const playerId = req.query.playerId;
    if (!playerId) return res.status(400).json({ error: "playerId query param required" });

    const wallet = await getOrCreateSession(playerId);
    const p = await retryRpc(() => readContract.getPlayer(raceId, wallet.address));
    if (i > Number(p.position) + 1) {
      return res.status(403).json({ error: "segment not revealed yet" });
    }

    const seed = await retryRpc(() => readContract.getSeed(raceId));
    const segType = await retryRpc(() => readContract.segmentAt(seed, i));
    const isCheckpoint = await retryRpc(() => readContract.isCheckpoint(i));
    let correctLane = null;
    if (Number(segType) === 1 || Number(segType) === 2) {
      // TURN or OBSTACLE — only these have a meaningful "correct" lane
      correctLane = LANES[Number(await retryRpc(() => readContract.correctLaneAt(seed, i)))];
    }
    res.json({ index: i, type: ["STRAIGHT", "TURN", "OBSTACLE", "BOOST"][Number(segType)], correctLane, isCheckpoint });
  } catch (err) {
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

app.post("/race/:id/move", async (req, res) => {
  try {
    const raceId = req.params.id;
    const { playerId, direction } = req.body;
    const laneIdx = LANES.indexOf(direction);
    if (laneIdx === -1) return res.status(400).json({ error: `direction must be one of ${LANES.join(", ")}` });

    const wallet = await getOrCreateSession(playerId);
    const c = contractFor(wallet);

    const started = Date.now();
    const receipt = await sendTx(() => c.chooseLane(raceId, laneIdx, TX_OVERRIDES));
    const latencyMs = Date.now() - started;

    const p = await retryRpc(() => readContract.getPlayer(raceId, wallet.address));
    const payload = {
      type: "move",
      playerId,
      address: wallet.address,
      txHash: receipt.hash,
      latencyMs,
      position: Number(p.position),
      hp: Number(p.hp),
      speed: Number(p.speed),
      stake: p.stake.toString(),
      alive: p.alive,
      finished: p.finished,
    };
    broadcast(raceId, payload);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

/// The tx log IS the race proof — see PROJECT.md §12. Reconstructs the
/// full move-by-move history for a race directly from chain events, so
/// it's independently verifiable without trusting this backend.
app.get("/race/:id/proof", async (req, res) => {
  try {
    const raceId = req.params.id;
    const filter = {
      address: readContract.target,
      fromBlock: 0,
      toBlock: "latest",
    };
    const logs = await provider.getLogs(filter);
    const events = [];
    for (const log of logs) {
      let parsed;
      try {
        parsed = readContract.interface.parseLog(log);
      } catch {
        continue;
      }
      if (!parsed || !parsed.args.raceId || parsed.args.raceId.toString() !== String(raceId)) continue;
      const block = await provider.getBlock(log.blockNumber);
      events.push({
        txHash: log.transactionHash,
        block: log.blockNumber,
        timestamp: block.timestamp,
        event: parsed.name,
        args: Object.fromEntries(
          parsed.fragment.inputs.map((inp, idx) => [inp.name, parsed.args[idx]?.toString?.() ?? parsed.args[idx]])
        ),
      });
    }
    events.sort((a, b) => a.block - b.block);
    res.json({ raceId, events });
  } catch (err) {
    res.status(500).json({ error: cleanErrorMessage(err) });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const server = app.listen(PORT, () => console.log(`[monadrift-backend] listening on :${PORT}`));

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const raceId = url.searchParams.get("raceId");
  if (!raceId) return ws.close();
  if (!streams.has(raceId)) streams.set(raceId, new Set());
  streams.get(raceId).add(ws);
  ws.on("close", () => streams.get(raceId)?.delete(ws));
});
