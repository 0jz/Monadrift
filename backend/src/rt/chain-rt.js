// MonadriftRT contract access. Imports the provider/funder/send-queue from
// chain.js through live bindings (chain.js swaps them on reconnect) and never
// edits it. Disabled unless RT_CONTRACT_ADDRESS is set.
//
// Gas: Monad bills the FULL declared gas limit, so each call gets its own limit
// (measured with `forge test --match-test test_gasWorstCases -vv`, cold-storage
// margin added). TX_OVERRIDES itself, and its shared 200k default, is untouched:
// we only spread it and replace gasLimit per call.

import fs from "node:fs";
import { ethers } from "ethers";
import { provider, funder, sendTx, retryRpc, getOrCreateSession, TX_OVERRIDES } from "../chain.js";

const abi = JSON.parse(fs.readFileSync(new URL("../contract/MonadriftRT.abi.json", import.meta.url), "utf8"));
const iface = new ethers.Interface(abi);

// Measured warm: settle(3 winners, 12 players) 110k, cancel(12 players) 282k, checkpoint ~29k,
// join <=143k, commitSeed 56k, createRace 92k, claim 34k. Zero-winner settle refunds 12 players
// (~280k), so it gets the larger limit.
export const GAS = {
  createRace: 130_000n, join: 170_000n, commitSeed: 90_000n, checkpoint: 60_000n,
  settle: 190_000n, settleRefund: 450_000n, cancel: 450_000n, claim: 70_000n,
};
const over = (gasLimit) => ({ ...TX_OVERRIDES, gasLimit });
const MODE = { HUMAN_ONLY: 0, AGENT_ONLY: 1, SHOWCASE_MIXED: 2 };

export function rtChainEnabled() {
  return ethers.isAddress(process.env.RT_CONTRACT_ADDRESS ?? "") && !!(process.env.RT_OPERATOR_PRIVATE_KEY || funder);
}

const opWallet = () => (process.env.RT_OPERATOR_PRIVATE_KEY ? new ethers.Wallet(process.env.RT_OPERATOR_PRIVATE_KEY, provider) : funder);
const at = (runner) => new ethers.Contract(process.env.RT_CONTRACT_ADDRESS, abi, runner);
const opTx = (fn) => sendTx(fn, { key: opWallet().address });

export { commitHashFor, replayRootFor } from "./fee.js";

export const rtChain = {
  address: () => process.env.RT_CONTRACT_ADDRESS,
  operator: () => opWallet().address,

  async createRace(mode, feeWei, maxPlayers) {
    const c = at(opWallet());
    const rc = await opTx(() => c.createRace(MODE[mode], feeWei, maxPlayers, over(GAS.createRace)));
    const ev = rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "RaceCreated");
    return { raceId: Number(ev.args.raceId), block: rc.blockNumber, tx: rc.hash };
  },

  /** The player's backend-derived session wallet pays the fee; winnings are credited to `payout`. */
  async join(playerId, raceId, feeWei, payout) {
    const w = await getOrCreateSession(playerId);
    const c = at(w);
    const rc = await sendTx(() => c.join(raceId, payout, { ...over(GAS.join), value: feeWei }), { key: w.address });
    return { address: w.address, tx: rc.hash };
  },

  async commitSeed(raceId, commitHash) {
    const c = at(opWallet());
    return (await opTx(() => c.commitSeed(raceId, commitHash, over(GAS.commitSeed)))).hash;
  },

  async checkpoint(raceId, index, hash) {
    const c = at(opWallet());
    return (await opTx(() => c.checkpoint(raceId, index, hash, over(GAS.checkpoint)))).hash;
  },

  async settle(raceId, seed, salt, winners, replayRoot) {
    const c = at(opWallet());
    const gas = winners.length ? GAS.settle : GAS.settleRefund;
    const rc = await opTx(() => c.settle(raceId, seed, salt, winners, replayRoot, over(gas)));
    return { tx: rc.hash, block: rc.blockNumber };
  },

  async cancel(raceId) {
    const c = at(opWallet());
    return (await opTx(() => c.cancel(raceId, over(GAS.cancel)))).hash;
  },

  /** Auto-claim for a session wallet whose payout address is itself. Returns null if nothing owed. */
  async claim(playerId) {
    const w = await getOrCreateSession(playerId);
    const c = at(w);
    const owed = await retryRpc(() => c.owed(w.address));
    if (owed === 0n) return null;
    return { amount: owed, tx: (await sendTx(() => c.claim(over(GAS.claim)), { key: w.address })).hash };
  },

  /** Events for a race, in <=100-block chunks (public RPCs reject wide getLogs ranges). */
  async events(raceId, fromBlock, toBlock) {
    const c = at(provider);
    const filters = [c.filters.Committed(raceId), c.filters.Checkpoint(raceId), c.filters.Settled(raceId), c.filters.Cancelled(raceId)];
    const end = toBlock ?? (await retryRpc(() => provider.getBlockNumber()));
    const out = [];
    for (let a = fromBlock; a <= end; a += 100) {
      const b = Math.min(end, a + 99);
      for (const f of filters) {
        for (const l of await retryRpc(() => c.queryFilter(f, a, b))) {
          out.push({ name: l.fragment.name, block: l.blockNumber, tx: l.transactionHash, args: Object.fromEntries(l.fragment.inputs.map((i, k) => [i.name, typeof l.args[k] === "bigint" ? l.args[k].toString() : Array.isArray(l.args[k]) ? [...l.args[k]] : l.args[k]])) });
        }
      }
    }
    return out.sort((x, y) => x.block - y.block);
  },
};
