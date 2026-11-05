// One real-time race. Pure state machine: no timers, no sockets, no chain. The
// loop calls tick() every TICK_MS; everything else (routes, websockets) only reads
// or sets inputs. Sim time is the tick count, so a late timer slows a race down
// but can never change its result.
//
// Phases: lobby -> countdown -> running -> finished

import crypto from "node:crypto";
import {
  generateTrack, TRACK_VERSION, SECTION_LEN, createWorld, stepWorld, observeWorld, ranking, worldDone,
  hashWorld, chainHash, ZERO_HASH, trackSeedFrom, encodeInput, decodeInput, NEUTRAL_INPUT, MAX_CARS,
  CHECKPOINT_EVERY, REPLAY_VERSION, TICK_MS,
} from "./sim.js";
import { botInput } from "./bots.js";

export const MODES = ["HUMAN_ONLY", "AGENT_ONLY", "SHOWCASE_MIXED"];
export const MIN_PLAYERS = 2;
export const COUNTDOWN_TICKS = 60; // 3 s
export const LOBBY_WAIT_TICKS = 300; // 15 s after the lobby has MIN_PLAYERS
export const INPUT_STALE_TICKS = 10; // a silent client coasts after 0.5 s instead of holding its last steer into a wall
export const FINISH_GRACE_TICKS = 300; // 15 s after the first car finishes, everyone still racing is DNF

export class RoomError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const clampName = (n, fallback) => String(n ?? "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 20) || fallback;

export class Room {
  /**
   * @param {object} o
   * @param {string} o.id
   * @param {string} o.mode             HUMAN_ONLY | AGENT_ONLY | SHOWCASE_MIXED
   * @param {number} [o.sections]       race length (default 60)
   * @param {string} [o.creator]        playerId allowed to start the race
   * @param {() => Uint8Array} [o.randomBytes]  injectable for tests
   */
  constructor({ id, mode = "HUMAN_ONLY", sections = 60, creator = null, randomBytes = () => crypto.randomBytes(32), maxTicks } = {}) {
    if (!MODES.includes(mode)) throw new RoomError(`mode must be one of ${MODES.join(", ")}`);
    if (!Number.isInteger(sections) || sections < 20 || sections > 300) throw new RoomError("sections must be 20..300");
    this.id = String(id);
    this.mode = mode;
    this.sections = sections;
    this.creator = creator;
    this.phase = "lobby";
    this.players = []; // {playerId, name, kind, isBot, strategy, input, inputTick, slot}
    this.lobbyTicks = 0;
    this.countdown = COUNTDOWN_TICKS;
    this.maxTicks = maxTicks ?? sections * 30; // 60 sections = 90 s hard cap
    this.firstFinishTick = -1;
    this.createdAt = Date.now();
    this.endedAt = 0;
    this._random = randomBytes;
    this._seed = null; // secret until the race ends
    this._track = null;
    this.world = null;
    this.log = []; // ticks[t][slot]
    this.checkpoints = [];
    this._chained = ZERO_HASH;
    this._result = null;
    this.chain = null; // PaidRace (rt/paid.js) when the lobby has an entry fee
    this.startGuard = null;
  }

  // ---- roster ----
  get humans() { return this.players.filter((p) => !p.isBot); }
  get full() { return this.players.length >= MAX_CARS; }
  playerById(playerId) { return this.players.find((p) => p.playerId === playerId) ?? null; }

  /** kind: "human" | "agent". House bots are added with addBot(). */
  addPlayer({ playerId, name, kind = "human" }) {
    if (this.phase !== "lobby") throw new RoomError("race already started", 409);
    if (typeof playerId !== "string" || playerId.length < 8 || playerId.length > 64) throw new RoomError("playerId must be 8..64 chars");
    if (!["human", "agent"].includes(kind)) throw new RoomError("kind must be human or agent");
    if (this.mode === "HUMAN_ONLY" && kind !== "human") throw new RoomError("this lobby is humans only", 403);
    if (this.mode === "AGENT_ONLY" && kind !== "agent") throw new RoomError("this lobby is agents only", 403);
    if (this.playerById(playerId)) return this.playerById(playerId); // idempotent re-join
    if (this.full) throw new RoomError("lobby is full", 409);
    const p = { playerId, name: clampName(name, `Racer ${this.players.length + 1}`), kind, isBot: false, strategy: null, input: NEUTRAL_INPUT, inputTick: -1, slot: -1 };
    this.players.push(p);
    return p;
  }

  /** Lobby only. Used to undo a seat when its on-chain join failed. */
  removePlayer(playerId) {
    if (this.phase !== "lobby") return false;
    const i = this.players.findIndex((p) => p.playerId === playerId);
    if (i < 0) return false;
    this.players.splice(i, 1);
    return true;
  }

  addBot(strategy = "safe") {
    if (this.phase !== "lobby") throw new RoomError("race already started", 409);
    if (this.full) throw new RoomError("lobby is full", 409);
    const n = this.players.filter((p) => p.isBot).length + 1;
    const p = { playerId: `bot-${this.id}-${n}`, name: `Bot ${n}`, kind: "bot", isBot: true, strategy, input: NEUTRAL_INPUT, inputTick: -1, slot: -1 };
    this.players.push(p);
    return p;
  }

  fillBots(total) {
    const target = Math.min(total, MAX_CARS);
    while (this.players.length < target) this.addBot(this.players.length % 2 ? "aggressive" : "safe");
  }

  // ---- lifecycle ----
  start() {
    if (this.phase !== "lobby") throw new RoomError("race already started", 409);
    if (this.players.length < 1) throw new RoomError("no players");
    this.startGuard?.(this); // paid rooms: needs 2+ on-chain players, else commitSeed would revert
    this._seed = BigInt("0x" + Buffer.from(this._random()).toString("hex"));
    this._track = generateTrack(trackSeedFrom(this._seed), { sections: this.sections });
    // Shuffle the grid so joining first is not pole. The shuffle uses the same
    // random source as the seed, and slots are all the replay needs.
    const order = [...this.players];
    for (let i = order.length - 1; i > 0; i--) {
      const j = this._random()[0] % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    order.forEach((p, slot) => { p.slot = slot; });
    this.players = order;
    this.world = createWorld(this.players.length);
    this.phase = "countdown";
    return [{ type: "phase", phase: "countdown" }];
  }

  /** Accepts a packed int (0..11) or {steer, throttle, brake}. Returns false if invalid. */
  setInput(playerId, input) {
    const p = this.playerById(playerId);
    if (!p || p.isBot) return false;
    let packed;
    if (typeof input === "number") {
      if (!Number.isInteger(input) || input < 0 || input > 11) return false;
      packed = input;
    } else if (input && typeof input === "object") {
      const s = Number(input.steer ?? 0);
      if (![-1, 0, 1].includes(s)) return false;
      packed = encodeInput({ steer: s, throttle: input.throttle ? 1 : 0, brake: input.brake ? 1 : 0 });
    } else return false;
    p.input = packed;
    p.inputTick = this.world ? this.world.tick : -1;
    return true;
  }

  _inputFor(p) {
    return this.world.tick - p.inputTick <= INPUT_STALE_TICKS && p.inputTick >= 0 ? p.input : NEUTRAL_INPUT;
  }

  /** Advance one tick. Returns events for the websocket layer. */
  tick() {
    if (this.phase === "lobby") {
      this.lobbyTicks++;
      if (this.players.length >= MIN_PLAYERS && this.lobbyTicks >= LOBBY_WAIT_TICKS && this.mode !== "SHOWCASE_MIXED") {
        try { return this.start(); } catch (e) {
          if (!(e instanceof RoomError)) throw e;
          this.lobbyTicks = 0; // e.g. a paid lobby still short of paying players: wait another round
        }
      }
      return [];
    }
    if (this.phase === "countdown") {
      this.countdown--;
      if (this.countdown > 0) return [{ type: "countdown", ticksLeft: this.countdown }];
      this.phase = "running";
      return [{ type: "phase", phase: "running" }];
    }
    if (this.phase !== "running") return [];

    const events = [];
    const w = this.world;
    const row = new Array(this.players.length);
    for (const p of this.players) {
      row[p.slot] = p.isBot ? botInput(p.strategy, observeWorld(w, this._track, p.slot)) : this._inputFor(p);
    }
    this.log.push(row);
    const before = w.cars.map((c) => c.finishTick);
    stepWorld(w, this._track, row);
    w.cars.forEach((c, slot) => {
      if (before[slot] < 0 && c.finishTick >= 0) {
        events.push({ type: "finish", slot, tick: c.finishTick });
        if (this.firstFinishTick < 0) this.firstFinishTick = w.tick;
      }
    });

    if (w.tick % CHECKPOINT_EVERY === 0) {
      const worldHash = hashWorld(w);
      this._chained = chainHash(this._chained, worldHash);
      const cp = { index: this.checkpoints.length, tick: w.tick, worldHash, chained: this._chained };
      this.checkpoints.push(cp);
      events.push({ type: "checkpoint", ...cp });
    }

    const timedOut = w.tick >= this.maxTicks;
    const graceOver = this.firstFinishTick >= 0 && w.tick - this.firstFinishTick >= FINISH_GRACE_TICKS;
    if (worldDone(w) || timedOut || graceOver) events.push(...this._finish());
    return events;
  }

  _finish() {
    this.phase = "finished";
    this.endedAt = Date.now();
    const w = this.world;
    const order = ranking(w);
    const bySlot = (slot) => this.players.find((p) => p.slot === slot);
    this._result = {
      ticks: w.tick,
      finalHash: hashWorld(w),
      ranking: order.map((slot, i) => ({
        place: i + 1, slot, name: bySlot(slot).name, isBot: bySlot(slot).isBot,
        finishTick: w.cars[slot].finishTick >= 0 ? w.cars[slot].finishTick : null,
      })),
    };
    return [{ type: "phase", phase: "finished" }, { type: "end", result: this._result }];
  }

  // ---- views ----
  lobbyView() {
    return {
      id: this.id, phase: this.phase, mode: this.mode, sections: this.sections, max: MAX_CARS, min: MIN_PLAYERS,
      players: this.players.map((p) => ({ name: p.name, kind: p.kind })),
      startsInTicks: this.phase === "lobby" && this.players.length >= MIN_PLAYERS ? Math.max(0, LOBBY_WAIT_TICKS - this.lobbyTicks) : null,
      countdown: this.phase === "countdown" ? this.countdown : null,
      paid: this.chain ? this.chain.publicView() : null,
    };
  }

  /** A driver's whole world: their fogged observation. Never contains playerIds, the seed or the full track. */
  snapFor(playerId) {
    const p = this.playerById(playerId);
    if (!p || p.slot < 0 || !this.world) return null;
    return {
      t: "snap", tick: this.world.tick, phase: this.phase,
      countdown: this.phase === "countdown" ? this.countdown : null,
      you: p.slot, obs: observeWorld(this.world, this._track, p.slot),
    };
  }

  /** Projector view: every car, but road only around the leader (drivers watching the screen learn little). */
  spectatorView() {
    if (!this.world) return null;
    const w = this.world;
    const order = ranking(w);
    const leader = w.cars[order[0]];
    const idx = Math.min(this.sections - 1, Math.floor(leader.s / SECTION_LEN));
    const from = Math.max(0, idx - 2);
    const to = Math.min(this.sections, idx + 9);
    return {
      t: "view", tick: w.tick, phase: this.phase, sections: this.sections,
      cars: w.cars.map((c, slot) => ({ slot, name: this.players.find((p) => p.slot === slot).name, s: c.s, d: c.d, v: c.v, lv: c.lv, fin: c.finishTick >= 0 })),
      order,
      window: { from, curv: Array.from(this._track.curv.slice(from, to)), boost: Array.from(this._track.boost.slice(from, to)) },
    };
  }

  result() { return this._result; }

  /** For the on-chain bridge ONLY (never routes/ws): the seed before the race, to commit to it. */
  _secretSeed() { return this._seed; }

  /** Finishing order of non-bot players, as playerIds (for settlement). Only after the race. */
  finishers() {
    if (this.phase !== "finished") return [];
    return this._result.ranking
      .filter((r) => r.finishTick !== null)
      .map((r) => this.players.find((p) => p.slot === r.slot))
      .filter((p) => p && !p.isBot);
  }

  /** Only after the race: it contains the seed, which would hand the whole track to a cheater. */
  replay() {
    if (this.phase !== "finished") return null;
    return {
      version: REPLAY_VERSION, trackVersion: TRACK_VERSION, seed: "0x" + this._seed.toString(16).padStart(64, "0"),
      sections: this.sections, nCars: this.players.length, checkpointEvery: CHECKPOINT_EVERY, tickMs: TICK_MS,
      roster: this.players.slice().sort((a, b) => a.slot - b.slot).map((p) => ({ slot: p.slot, name: p.name, isBot: p.isBot })),
      checkpoints: this.checkpoints.map((c) => c.chained), ranking: this._result.ranking.map((r) => r.slot),
      ticks: this.log,
    };
  }
}

export { decodeInput };
