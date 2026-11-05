// HTTP API for the real-time game, mounted at /rt. The playerId is a bearer
// secret: it travels in the X-Player-Id header (or a JSON body), never in a URL
// and never in any response about other players.

import crypto from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import QRCode from "qrcode";
import { ethers } from "ethers";
import { RoomError, MIN_PLAYERS } from "./room.js";
import { MAX_ENTRY_FEE } from "./fee.js";
import { TICK_MS, MAX_CARS } from "./sim.js";

export function createRoutes({ manager, loop }) {
  const r = express.Router();
  r.use(express.json({ limit: "4kb" }));
  r.use(rateLimit({
    windowMs: 10 * 1000, limit: 400, standardHeaders: true, legacyHeaders: false,
    message: { error: "Rate limit exceeded — slow down." },
  }));

  const wrap = (fn) => (req, res) => {
    try { fn(req, res); } catch (e) {
      if (e instanceof RoomError) return res.status(e.status).json({ error: e.message });
      console.error("[rt] route error:", e);
      res.status(500).json({ error: "internal error" });
    }
  };
  const wrapAsync = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof RoomError) return res.status(e.status).json({ error: e.message });
      console.error("[rt] route error:", e);
      res.status(500).json({ error: "internal error" });
    }
  };
  // Entry fee in MON ("0.01"); 0 / absent = free lobby with no chain involvement.
  const parseFee = (v) => {
    if (v === undefined || v === null || Number(v) === 0) return 0n;
    let wei;
    try { wei = ethers.parseEther(String(v)); } catch { throw new RoomError("entryFee must be a decimal number of MON"); }
    if (wei < 0n || wei > MAX_ENTRY_FEE) throw new RoomError("entryFee must be between 0 and 0.5 MON");
    return wei;
  };
  // Join the on-chain race with this player's session wallet; undo the seat if it fails.
  const payIn = async (rm, p, payoutTo) => {
    if (!rm.chain || rm.chain.joined.has(p.playerId)) return;
    if (payoutTo !== undefined && !ethers.isAddress(payoutTo)) { rm.removePlayer(p.playerId); throw new RoomError("payoutTo is not an address"); }
    try { await rm.chain.join(p, payoutTo); } catch (e) {
      rm.removePlayer(p.playerId);
      throw new RoomError(`entry fee payment failed: ${e.shortMessage ?? e.message}`, 402);
    }
  };
  const pid = (req) => String(req.get("x-player-id") ?? req.body?.playerId ?? "");
  const room = (req) => {
    const rm = manager.get(req.params.id);
    if (!rm) throw new RoomError("no such race", 404);
    return rm;
  };
  const member = (req) => {
    const rm = room(req);
    const p = rm.playerById(pid(req));
    if (!p) throw new RoomError("not in this race", 403);
    return { rm, p };
  };

  r.get("/config", wrap((_req, res) => res.json({
    tickMs: TICK_MS, maxPlayers: MAX_CARS, minPlayers: MIN_PLAYERS,
    paid: { enabled: !!process.env.RT_CONTRACT_ADDRESS, maxEntryFeeMon: ethers.formatEther(MAX_ENTRY_FEE) },
    modes: manager.allowShowcase ? ["HUMAN_ONLY", "AGENT_ONLY", "SHOWCASE_MIXED"] : ["HUMAN_ONLY", "AGENT_ONLY"],
    input: "packed int 0..11 = (steer+1) + 3*throttle + 6*brake, or {steer:-1|0|1, throttle:0|1, brake:0|1}",
  })));

  r.get("/stats", wrap((_req, res) => res.json({ ...manager.stats(), loop: loop.stats() })));

  // Private identity. Chain wallets arrive with the contract phase (P4).
  r.post("/session", wrap((_req, res) => res.json({ playerId: crypto.randomBytes(16).toString("hex") })));

  r.post("/lobby/create", wrapAsync(async (req, res) => {
    const { mode = "HUMAN_ONLY", sections, kind = "human", name, entryFee, payoutTo } = req.body ?? {};
    const id = pid(req);
    const fee = parseFee(entryFee);
    if (fee > 0n && !id) throw new RoomError("a paid lobby needs a player id (X-Player-Id)");
    const rm = manager.create({ mode, sections: sections === undefined ? undefined : Number(sections), creator: id });
    if (fee > 0n) await manager.makePaid(rm, fee);
    if (id) { const p = rm.addPlayer({ playerId: id, name, kind }); await payIn(rm, p, payoutTo); }
    res.json({ raceId: rm.id, lobby: rm.lobbyView() });
  }));

  r.post("/lobby/quickmatch", wrap((req, res) => {
    const { kind = "human", name } = req.body ?? {};
    const rm = manager.quickmatch({ kind, playerId: pid(req), name });
    res.json({ raceId: rm.id, lobby: rm.lobbyView() });
  }));

  r.post("/lobby/:id/join", wrapAsync(async (req, res) => {
    const rm = room(req);
    const { kind = "human", name, payoutTo } = req.body ?? {};
    const p = rm.addPlayer({ playerId: pid(req), name, kind });
    await payIn(rm, p, payoutTo);
    res.json({ raceId: rm.id, lobby: rm.lobbyView() });
  }));

  r.get("/lobby/:id", wrap((req, res) => res.json(room(req).lobbyView())));

  // QR for joining from a phone; carries game=rt so the page knows which game to open.
  r.get("/lobby/:id/qr", wrap(async (req, res) => {
    const rm = room(req);
    const base = (process.env.FRONTEND_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    const url = `${base}/race-rt.html?lobby=${encodeURIComponent(rm.id)}`;
    res.json({ url, svg: await QRCode.toString(url, { type: "svg", margin: 1 }) });
  }));

  // Creator may start early; fillBots tops the grid up with house bots.
  r.post("/race/:id/start", wrap((req, res) => {
    const { rm, p } = member(req);
    if (rm.creator && rm.creator !== p.playerId) throw new RoomError("only the lobby creator can start", 403);
    if (req.body?.fillBots) rm.fillBots(Math.max(2, Math.min(MAX_CARS, Number(req.body.fillBots) || MIN_PLAYERS)));
    if (rm.players.length < MIN_PLAYERS) throw new RoomError(`need at least ${MIN_PLAYERS} players`, 409);
    manager.start(rm);
    res.json({ ok: true, lobby: rm.lobbyView() });
  }));

  r.get("/race/:id/observe", wrap((req, res) => {
    const { rm, p } = member(req);
    const snap = rm.snapFor(p.playerId);
    if (!snap) return res.json({ phase: rm.phase, lobby: rm.lobbyView() });
    res.json(snap);
  }));

  r.post("/race/:id/input", wrap((req, res) => {
    const { rm, p } = member(req);
    const b = req.body ?? {};
    const input = b.i !== undefined ? b.i : { steer: b.steer, throttle: b.throttle, brake: b.brake };
    if (!rm.setInput(p.playerId, input)) throw new RoomError("invalid input");
    res.json({ ok: true, tick: rm.world?.tick ?? null });
  }));

  r.get("/race/:id/view", wrap((req, res) => {
    const v = room(req).spectatorView();
    res.json(v ?? { phase: room(req).phase });
  }));

  r.get("/race/:id/result", wrap((req, res) => {
    const rm = room(req);
    if (!rm.result()) return res.status(409).json({ error: "race not finished" });
    res.json({ ...rm.result(), paid: rm.chain?.publicView() ?? null });
  }));

  // On-chain evidence for a paid race: commit, every checkpoint, the reveal. Compare with
  // `node sim/verify.js` on the replay. Chunked getLogs from the race's creation block.
  r.get("/race/:id/proof", wrapAsync(async (req, res) => {
    const rm = room(req);
    if (!rm.chain) throw new RoomError("not a paid race", 404);
    const { rtChain } = await import("./chain-rt.js");
    const events = await rtChain.events(rm.chain.raceId, rm.chain.createdBlock, rm.chain.settleBlock ?? undefined);
    res.json({ contract: rtChain.address(), raceId: rm.chain.raceId, events });
  }));

  // Seed + every input: replayable with sim/verify.js. Only after the finish.
  r.get("/race/:id/replay", wrap((req, res) => {
    const rp = room(req).replay();
    if (!rp) return res.status(409).json({ error: "race not finished" });
    res.json(rp);
  }));

  return r;
}
