import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";
import { readContract, getOrCreateSession, contractFor, provider } from "./chain.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
// Single server for the demo laptop — see PROJECT.md §8. Phones only need
// to reach this one process; it's the only thing that needs internet.
app.use(express.static(path.join(__dirname, "..", "..", "frontend")));

const PORT = process.env.PORT || 8787;
const LANES = ["LEFT", "CENTER", "RIGHT"];

// mode -> open raceId waiting for players (in-memory matchmaking; the
// contract itself doesn't track "open" lobbies, this is just routing)
const openLobbies = { HUMAN_ONLY: null, AGENT_ONLY: null, SHOWCASE_MIXED: null };
const DEFAULT_ENTRY_FEE = "0.001"; // ether, matches PROJECT.md placeholder economics

// raceId -> Set<ws> for the live stream
const streams = new Map();
function broadcast(raceId, payload) {
  const set = streams.get(String(raceId));
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === 1) ws.send(msg);
}

// --- lobby / matchmaking ---

app.post("/lobby/quickmatch", async (req, res) => {
  try {
    const { playerId, mode = "HUMAN_ONLY", entryFee = DEFAULT_ENTRY_FEE } = req.body;
    if (!playerId) return res.status(400).json({ error: "playerId required" });
    if (mode === "SHOWCASE_MIXED") {
      return res.status(403).json({ error: "SHOWCASE_MIXED lobbies are operator-only, not reachable via quickmatch — see PROJECT.md §11" });
    }

    const wallet = await getOrCreateSession(playerId);
    const { ethers } = await import("ethers");
    const feeWei = ethers.parseEther(String(entryFee));

    let raceId = openLobbies[mode];
    if (raceId === null) {
      const c = contractFor(wallet);
      const modeIdx = mode === "AGENT_ONLY" ? 1 : 0;
      const tx = await c.createLobby(modeIdx, feeWei);
      const receipt = await tx.wait();
      raceId = readContract.interface.parseLog(receipt.logs[0]).args.raceId.toString();
      openLobbies[mode] = raceId;
    }

    const c = contractFor(wallet);
    const joinTx = await c.join(raceId, { value: feeWei });
    await joinTx.wait();

    res.json({ raceId, playerAddress: wallet.address, mode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

/// Operator-only escape hatch for the one live "human vs agent" demo moment.
app.post("/lobby/showcase", async (req, res) => {
  try {
    const { entryFee = DEFAULT_ENTRY_FEE } = req.body;
    const { ethers } = await import("ethers");
    const c = contractFor(await getOrCreateSession("__operator__"));
    const tx = await c.createLobby(2, ethers.parseEther(String(entryFee))); // SHOWCASE_MIXED = 2
    const receipt = await tx.wait();
    const raceId = readContract.interface.parseLog(receipt.logs[0]).args.raceId.toString();
    res.json({ raceId });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/lobby/:id/qr", async (req, res) => {
  const base = req.query.base || `${req.protocol}://${req.get("host")}`;
  const url = `${base}/?lobby=${req.params.id}`;
  const png = await QRCode.toBuffer(url, { width: 512 });
  res.set("Content-Type", "image/png");
  res.send(png);
});

// --- race state ---

app.get("/race/:id/state", async (req, res) => {
  try {
    const raceId = req.params.id;
    const phase = await readContract.getPhase(raceId);
    const addrs = await readContract.getPlayers(raceId);
    const pot = await readContract.getPot(raceId);
    const players = await Promise.all(
      addrs.map(async (a) => {
        const p = await readContract.getPlayer(raceId, a);
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
    res.status(500).json({ error: String(err.message || err) });
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
    const p = await readContract.getPlayer(raceId, wallet.address);
    if (i > Number(p.position) + 1) {
      return res.status(403).json({ error: "segment not revealed yet" });
    }

    const seed = await readContract.getSeed(raceId);
    const segType = await readContract.segmentAt(seed, i);
    const isCheckpoint = await readContract.isCheckpoint(i);
    let correctLane = null;
    if (Number(segType) === 1 || Number(segType) === 2) {
      // TURN or OBSTACLE — only these have a meaningful "correct" lane
      correctLane = LANES[Number(await readContract.correctLaneAt(seed, i))];
    }
    res.json({ index: i, type: ["STRAIGHT", "TURN", "OBSTACLE", "BOOST"][Number(segType)], correctLane, isCheckpoint });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
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
    const tx = await c.chooseLane(raceId, laneIdx);
    const receipt = await tx.wait();
    const latencyMs = Date.now() - started;

    const p = await readContract.getPlayer(raceId, wallet.address);
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
    res.status(500).json({ error: String(err.message || err) });
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
    res.status(500).json({ error: String(err.message || err) });
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
