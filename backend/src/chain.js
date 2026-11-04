import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// RPC_URL may be a comma-separated list; reconnect() rotates to the next one,
// so a throttled/dead endpoint fails over instead of being retried forever.
// Free options (docs.monad.xyz/developer-essentials/testnets): QuickNode
// testnet-rpc.monad.xyz, Ankr rpc.ankr.com/monad_testnet, Monad Foundation
// rpc-testnet.monadinfra.com (no batching, slowest � keep it last).
const RPC_URLS = (process.env.RPC_URL || "https://testnet-rpc.monad.xyz")
  .split(",").map((u) => u.trim()).filter(Boolean);
let rpcIndex = 0;
const CHAIN_ID = Number(process.env.CHAIN_ID || 10143);
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const FUNDER_PRIVATE_KEY = process.env.FUNDER_PRIVATE_KEY;
const SESSION_FUND_AMOUNT = process.env.SESSION_FUND_AMOUNT || "0.01";
const SESSION_SEED = process.env.SESSION_SEED || "insecure-dev-seed-change-me-in-production";

if (!CONTRACT_ADDRESS) console.warn("[chain] CONTRACT_ADDRESS not set yet — deploy the contract and set it in backend/.env");
if (!FUNDER_PRIVATE_KEY) console.warn("[chain] FUNDER_PRIVATE_KEY not set yet — sessions can't be funded until it is");
if (!process.env.SESSION_SEED) console.warn("[chain] SESSION_SEED not set — using an insecure default. Set a real secret in production (see .env.example).");

// ABI committed as a plain file inside backend/ (src/contract/Monadrift.abi.json)
// rather than read from Foundry's out/ directory: out/ is gitignored and lives
// outside backend/, so it never made it into a `railway up` deploy — the
// contract silently got an empty ABI, and every write call failed with
// "<method> is not a function". Re-extract this file after any contract
// change: `node -e "const fs=require('fs');fs.writeFileSync('backend/src/contract/Monadrift.abi.json',JSON.stringify(JSON.parse(fs.readFileSync('out/Monadrift.sol/Monadrift.json')).abi,null,2))"`
const artifactPath = path.join(__dirname, "contract", "Monadrift.abi.json");
let abi;
try {
  abi = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
} catch {
  console.warn(`[chain] Could not read ${artifactPath} — see the comment above for how to regenerate it. Falling back to empty ABI.`);
  abi = [];
}

// `let`, not `const` — see reconnect() below. ES module named imports are
// live bindings, so reassigning these here is visible to every file that
// did `import { provider } from "./chain.js"` without them needing to
// re-import anything.
function makeProvider() {
  // staticNetwork skips ethers' startup eth_chainId probe and batchMaxCount:1
  // disables JSON-RPC batching; the public testnet RPC answers batched/probe
  // calls with "403 Restricted JSON RPC method", which broke every write.
  const p = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex], CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
  // ethers' default polling interval (4000ms) is what's checking whether a
  // tx confirmed — completely unrelated to Monad's actual ~300ms block
  // time. A move landing on-chain in ~600ms was still taking 4+ seconds to
  // report back, because tx.wait() only re-checked every 4s. 100ms trades
  // more frequent eth_getTransactionReceipt polling for lower detection
  // latency — worth it since a move already landed is just waiting to be
  // noticed, not waiting on the chain itself.
  p.pollingInterval = 100;
  return p;
}

export let provider = makeProvider();
export let funder = FUNDER_PRIVATE_KEY ? new ethers.Wallet(FUNDER_PRIVATE_KEY, provider) : null;

// Roughly matches what `cast`'s own fee estimation used in a confirmed-
// successful test call, as a reasonable default — but see sendTx() below:
// this alone did NOT reliably fix testnet's flaky mempool admission
// (higher and lower values both failed inconsistently), so the real fix
// is retrying, not a specific fee number.
//
// gasLimit is set explicitly to skip ethers' separate eth_estimateGas
// round-trip before every write — BUT keep it TIGHT, not generous.
// Empirically confirmed via a real receipt (2026-08-22): Monad testnet
// charges for the ENTIRE declared gasLimit, not actual computation used —
// gasUsed in the receipt literally echoed back our gasLimit value, and the
// sender's balance dropped by gasLimit * effectiveGasPrice even though
// chooseLane() is a simple storage write needing nowhere near that. This
// is the opposite of standard Ethereum behavior (unused gas below the
// limit is normally never charged at all). A "generous safety margin"
// here is therefore a direct cost multiplier, not a safety net — it drained
// a funded session wallet in a single move when this was set to 1,000,000.
// 200,000 is ~35-50% headroom over the ~130-150k actually observed for
// join()/chooseLane(), tight enough to avoid overpaying, loose enough to
// not underestimate and revert.
export const TX_OVERRIDES = {
  maxFeePerGas: ethers.parseUnits("210", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("5", "gwei"),
  gasLimit: 200000n,
};

function contractAs(signerOrProvider) {
  // Falls back to the zero address so the server can boot (and serve the
  // static frontend) before a contract is deployed — any actual on-chain
  // call will just fail with a clear error instead of crashing at startup.
  return new ethers.Contract(CONTRACT_ADDRESS || ethers.ZeroAddress, abi, signerOrProvider);
}

export let readContract = contractAs(provider);

// playerId (arbitrary string from the client) -> ethers.Wallet
// This is the fix for the "shared relayer can't represent multiple players" problem:
// msg.sender must be distinct per player on-chain, so each session gets its own
// ephemeral key, auto-funded from the funder wallet. The human never sees it.
//
// This Map is just an in-process cache, NOT the source of truth for who a
// playerId is — the wallet itself is derived deterministically from
// (SESSION_SEED, playerId) below, so any backend instance regenerates the
// exact same address for the exact same playerId, restart or not. Without
// this, every deploy silently reassigned everyone a new address, and
// "You're not a participant in this race" started showing up for players
// who'd registered before the most recent deploy.
const sessions = new Map();

function deriveWalletFor(playerId) {
  const privateKey = ethers.keccak256(ethers.toUtf8Bytes(`${SESSION_SEED}:${playerId}`));
  return new ethers.Wallet(privateKey, provider);
}

/// Recreates the provider (and everything bound to it) from scratch. Node's
/// global fetch pools/reuses underlying connections; if Monad's RPC or an
/// intermediary closes one without cleanly signaling it, ethers can end up
/// stuck reusing a dead connection — symptoms are trivial read calls
/// (getPhase, a plain storage read with no possible revert) failing with
/// "missing revert data" repeatedly, even though a fresh `cast call`
/// against the same RPC works fine. Retrying on the SAME provider doesn't
/// help here (confirmed: it fails identically every time); a fresh
/// connection does. retryRpc/sendTx call this after repeated failures.
export function reconnect() {
  rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
  provider = makeProvider();
  if (FUNDER_PRIVATE_KEY) funder = new ethers.Wallet(FUNDER_PRIVATE_KEY, provider);
  readContract = contractAs(provider);
  for (const [playerId, wallet] of sessions) {
    sessions.set(playerId, wallet.connect(provider));
  }
  console.warn(`[chain] reconnected to RPC ${RPC_URLS[rpcIndex]} after repeated failures`);
}

const inflight = new Map(); // playerId -> Promise<Wallet> (dedupes concurrent first calls)

export function getOrCreateSession(playerId) {
  const cached = sessions.get(playerId);
  if (cached) return Promise.resolve(cached);
  if (inflight.has(playerId)) return inflight.get(playerId);
  const p = (async () => {
    const wallet = deriveWalletFor(playerId);
    if (funder) {
      const amount = ethers.parseEther(SESSION_FUND_AMOUNT);
      // The address is deterministic, so it may already be funded from
      // before a restart. Only top up if it's actually running low.
      const currentBalance = await retryRpc(() => provider.getBalance(wallet.address));
      if (currentBalance < amount / 2n) {
        // Funding goes through the funder's send queue (see sendTx): Monad's
        // reserve-balance rule reverts a second spend from an account under
        // 10 MON within ~3 blocks, so back-to-back funding txs must be spaced.
        await sendTx(
          () => funder.sendTransaction({ to: wallet.address, value: amount, ...TX_OVERRIDES }),
          { key: funder.address, retryReverts: 3 }
        );
        // tx.wait() confirming doesn't guarantee every node behind the RPC
        // has caught up — poll until the funded balance is visible.
        for (let i = 0; i < 15; i++) {
          const bal = await provider.getBalance(wallet.address);
          if (bal >= amount) break;
          await new Promise((r) => setTimeout(r, 400));
        }
      }
    }
    // Cache only after funding succeeded, so a failed attempt is retried
    // next call instead of handing back a permanently unfunded wallet.
    sessions.set(playerId, wallet);
    return wallet;
  })().finally(() => inflight.delete(playerId));
  inflight.set(playerId, p);
  return p;
}

export function contractFor(wallet) {
  return contractAs(wallet);
}

/// A CALL_EXCEPTION means the chain itself rejected the call (a require()
/// failed, e.g. "not active" for a broke/finished player) — that's a real,
/// deterministic answer, not a network blip. Retrying it 6 times just makes
/// a slow request slower (14-23s observed) before failing anyway with the
/// same result. Only retry error classes that are plausibly transient.
function isGenuineRevert(err) {
  return err?.code === "CALL_EXCEPTION";
}

/// Monad testnet's mempool has been observed rejecting well-funded,
/// correctly-priced transactions with a misleading "insufficient balance"
/// error — inconsistently, not correlated with fee level (see PROJECT.md
/// for the debugging trail). Identical retries have consistently succeeded
/// within a couple attempts, so retry rather than chase a moving target.
// Monad's reserve-balance rule: an account holding < 10 MON may only spend
// below the reserve with the first tx it sends in any ~3-block window; a
// second one reverts (and still burns the full gas limit). Every wallet here
// (funder, ~0.3 MON session wallets) is under 10 MON, so txs from the same
// sender are queued and spaced out. Different senders run in parallel.
const MIN_SPACING_MS = Number(process.env.TX_MIN_SPACING_MS || 1500);
const lanes = new Map(); // sender key -> { tail: Promise, last: number }

async function sendTxNow(fn, { retries = 6, delayMs = 1200, retryReverts = 0 } = {}) {
  let lastErr;
  let revertsLeft = retryReverts;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const tx = await fn();
      return await tx.wait();
    } catch (err) {
      lastErr = err;
      if (isGenuineRevert(err)) {
        // Real require() failures fail fast. Opt-in retry exists for plain
        // transfers that can revert on the reserve rule, not on logic.
        if (revertsLeft-- > 0) { await new Promise((r) => setTimeout(r, MIN_SPACING_MS * 2)); continue; }
        throw err;
      }
      if (attempt === 2) reconnect(); // a few same-connection retries first, then assume it's stuck
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export function sendTx(fn, opts = {}) {
  const key = opts.key;
  if (!key) return sendTxNow(fn, opts);
  const lane = lanes.get(key) || { tail: Promise.resolve(), last: 0 };
  lanes.set(key, lane);
  const run = async () => {
    const wait = lane.last + MIN_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await sendTxNow(fn, opts);
    } finally {
      lane.last = Date.now();
    }
  };
  const result = lane.tail.then(run, run);
  lane.tail = result.catch(() => {});
  return result;
}

/// Same reasoning as sendTx, for plain read (view) calls — /race/:id/state
/// and /race/:id/segment/:i make several of these per request, and none of
/// them were retried before, so a single flaky RPC response turned into a
/// 500 for the whole endpoint.
export async function retryRpc(fn, { retries = 4, delayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === 1) reconnect(); // fail fast into a reconnect — reads are called constantly (state polling), don't let them limp along on a dead connection
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export { abi };
