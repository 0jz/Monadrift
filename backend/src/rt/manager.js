// Owns all rooms. The loop calls tickAll(); listeners (websocket layer) get the
// per-room events it produced.

import { Room, RoomError } from "./room.js";

// Loaded lazily: chain.js needs .env and an RPC, which free-play and tests do not.
async function defaultPaidFactory(room, feeWei) {
  if (!process.env.RT_CONTRACT_ADDRESS) throw new RoomError("paid races are not enabled on this server", 503);
  const { PaidRace } = await import("./paid.js");
  const { rtChainEnabled, rtChain } = await import("./chain-rt.js");
  if (!rtChainEnabled()) throw new RoomError("paid races are not enabled on this server", 503);
  return new PaidRace(room, feeWei, rtChain);
}

const KEEP_FINISHED_MS = 10 * 60 * 1000;
const KEEP_FINISHED_MAX = 50;
const MAX_ROOMS = 200;

export class Manager {
  constructor({ allowShowcase = process.env.RT_ALLOW_SHOWCASE === "1", onEvents = () => {}, sections = 60, paidFactory = defaultPaidFactory } = {}) {
    this.paidFactory = paidFactory;
    this.rooms = new Map();
    this.nextId = 1;
    this.allowShowcase = allowShowcase;
    this.onEvents = onEvents;
    this.defaultSections = sections;
  }

  create({ mode = "HUMAN_ONLY", sections, creator } = {}) {
    if (mode === "SHOWCASE_MIXED" && !this.allowShowcase) throw new RoomError("showcase lobbies are disabled", 403);
    if (this.rooms.size >= MAX_ROOMS) throw new RoomError("server busy, try again shortly", 503);
    const room = new Room({ id: String(this.nextId++), mode, sections: sections ?? this.defaultSections, creator });
    this.rooms.set(room.id, room);
    return room;
  }

  /** Attach an entry fee: opens the on-chain race. Throws (and drops the room) if that fails. */
  async makePaid(room, feeWei) {
    const paid = await this.paidFactory(room, feeWei);
    room.chain = paid;
    room.startGuard = () => paid.guard();
    try { await paid.create(); } catch (e) { this.rooms.delete(room.id); throw new RoomError(`could not open on-chain race: ${e.shortMessage ?? e.message}`, 502); }
    return paid;
  }

  /** Manual start (routes). The loop's auto-start goes through tickAll(). */
  start(room) {
    const events = room.start();
    this.dispatch(room, events);
    return events;
  }

  dispatch(room, events) {
    room.chain?.onEvents(events);
    this.onEvents(room, events);
  }

  get(id) { return this.rooms.get(String(id)) ?? null; }

  /** Join the fullest open lobby of this mode, or open a new one. */
  quickmatch({ kind, playerId, name }) {
    const mode = kind === "agent" ? "AGENT_ONLY" : "HUMAN_ONLY";
    let best = null;
    for (const r of this.rooms.values()) {
      if (r.phase !== "lobby" || r.mode !== mode || r.full) continue;
      if (!best || r.players.length > best.players.length) best = r;
    }
    const room = best ?? this.create({ mode, creator: playerId });
    room.addPlayer({ playerId, name, kind });
    return room;
  }

  tickAll() {
    for (const room of this.rooms.values()) {
      if (room.phase === "finished") continue;
      const events = room.tick();
      if (events.length) this.dispatch(room, events);
    }
    this.sweep();
  }

  sweep(nowMs = Date.now()) {
    const finished = [...this.rooms.values()].filter((r) => r.phase === "finished").sort((a, b) => a.endedAt - b.endedAt);
    let excess = finished.length - KEEP_FINISHED_MAX;
    for (const r of finished) {
      if (excess > 0 || nowMs - r.endedAt > KEEP_FINISHED_MS) { this.rooms.delete(r.id); excess--; }
    }
    // Abandoned lobbies (nobody ever filled them) after 30 min.
    for (const r of this.rooms.values()) {
      if (r.phase === "lobby" && nowMs - r.createdAt > 30 * 60 * 1000) { r.chain?.cancel(); this.rooms.delete(r.id); }
    }
  }

  stats() {
    const by = { lobby: 0, countdown: 0, running: 0, finished: 0 };
    for (const r of this.rooms.values()) by[r.phase]++;
    return { rooms: this.rooms.size, ...by };
  }
}
