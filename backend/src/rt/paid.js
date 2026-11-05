// Per-room on-chain lifecycle for lobbies with an entry fee. The tick loop never
// waits on any of this: every chain call is fire-and-forget behind a promise
// chain, and failures are recorded, not thrown into the race.
//
//   createRace -> join (per player) -> commitSeed @countdown -> checkpoint* -> settle -> claim

import crypto from "node:crypto";
import { RoomError } from "./room.js";
import { commitHashFor, replayRootFor } from "./fee.js";

export { MAX_ENTRY_FEE } from "./fee.js";

export class PaidRace {
  constructor(room, feeWei, chain) {
    this.room = room;
    this.feeWei = feeWei;
    this.chain = chain;
    this.raceId = null;
    this.createdBlock = null;
    this.joined = new Map(); // playerId -> { address, payout }
    this.log = {}; // tx hashes: create, commit, settle, claims...
    this.error = null;
    this._q = Promise.resolve(); // serial queue: commit -> checkpoints -> settle keep their order
    this.settled = null; // resolves when settle (or a recorded failure) is done
  }

  async create() {
    const r = await this.chain.createRace(this.room.mode, this.feeWei, 12);
    this.raceId = r.raceId; this.createdBlock = r.block; this.log.create = r.tx;
  }

  async join(player, payout) {
    const r = await this.chain.join(player.playerId, this.raceId, this.feeWei, payout ?? undefined);
    this.joined.set(player.playerId, { address: r.address, payout: payout ?? r.address });
    this.log[`join:${r.address}`] = r.tx;
  }

  /** Room.startGuard: commitSeed reverts with fewer than 2 paying players. */
  guard() {
    if (this.joined.size < 2) throw new RoomError("a paid race needs at least 2 paying players", 409);
  }

  _enqueue(label, fn) {
    this._q = this._q.then(fn).catch((e) => { this.error = this.error ?? `${label}: ${e.shortMessage ?? e.message}`; console.error(`[rt-chain] ${label} failed:`, e.shortMessage ?? e.message); });
    return this._q;
  }

  /** Called with every batch of room events. */
  onEvents(events) {
    for (const ev of events) {
      if (ev.type === "phase" && ev.phase === "countdown") this._commit();
      else if (ev.type === "checkpoint") this._enqueue(`checkpoint ${ev.index}`, async () => {
        if (!this.committed) return; // commit failed: the race plays on, settle will refund via timeout
        this.log[`cp:${ev.index}`] = await this.chain.checkpoint(this.raceId, ev.index, ev.chained);
      });
      else if (ev.type === "end") this.settled = this._settle();
    }
  }

  _commit() {
    this.salt = BigInt("0x" + crypto.randomBytes(32).toString("hex"));
    const hash = commitHashFor(this.room._secretSeed(), this.salt);
    this._enqueue("commitSeed", async () => { this.log.commit = await this.chain.commitSeed(this.raceId, hash); this.committed = true; });
  }

  _settle() {
    return this._enqueue("settle", async () => {
      if (!this.committed) return;
      const winners = this.room.finishers().filter((p) => this.joined.has(p.playerId)).slice(0, 3);
      const rp = this.room.replay();
      const r = await this.chain.settle(this.raceId, this.room._secretSeed(), this.salt, winners.map((p) => this.joined.get(p.playerId).address), replayRootFor(rp));
      this.log.settle = r.tx; this.settleBlock = r.block;
      for (const [playerId, j] of this.joined) { // auto-claim where the payout is the session wallet itself
        if (j.payout !== j.address) continue;
        try { const c = await this.chain.claim(playerId); if (c) this.log[`claim:${j.address}`] = c.tx; } catch (e) { console.error("[rt-chain] claim failed:", e.shortMessage ?? e.message); }
      }
    });
  }

  /** An abandoned lobby: refund immediately instead of waiting out the on-chain timeout. */
  cancel() {
    if (!this.joined.size) return Promise.resolve();
    return this._enqueue("cancel", async () => { this.log.cancel = await this.chain.cancel(this.raceId); });
  }

  publicView() {
    return {
      contract: this.chain.address?.() ?? null, raceId: this.raceId, entryFee: this.feeWei.toString(),
      payingPlayers: this.joined.size, tx: this.log, error: this.error,
      createdBlock: this.createdBlock, settleBlock: this.settleBlock ?? null,
    };
  }
}
