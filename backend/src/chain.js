import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC_URL = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const FUNDER_PRIVATE_KEY = process.env.FUNDER_PRIVATE_KEY;
const SESSION_FUND_AMOUNT = process.env.SESSION_FUND_AMOUNT || "0.01";

if (!CONTRACT_ADDRESS) console.warn("[chain] CONTRACT_ADDRESS not set yet — deploy the contract and set it in backend/.env");
if (!FUNDER_PRIVATE_KEY) console.warn("[chain] FUNDER_PRIVATE_KEY not set yet — sessions can't be funded until it is");

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
export let provider = new ethers.JsonRpcProvider(RPC_URL);
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
const sessions = new Map();

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
  provider = new ethers.JsonRpcProvider(RPC_URL);
  if (FUNDER_PRIVATE_KEY) funder = new ethers.Wallet(FUNDER_PRIVATE_KEY, provider);
  readContract = contractAs(provider);
  for (const [playerId, wallet] of sessions) {
    sessions.set(playerId, wallet.connect(provider));
  }
  console.warn("[chain] reconnected to RPC after repeated failures");
}

export async function getOrCreateSession(playerId) {
  let wallet = sessions.get(playerId);
  if (wallet) return wallet;

  wallet = ethers.Wallet.createRandom().connect(provider);
  sessions.set(playerId, wallet);

  if (funder) {
    const amount = ethers.parseEther(SESSION_FUND_AMOUNT);
    await sendTx(() =>
      funder.sendTransaction({
        to: wallet.address,
        value: amount,
        ...TX_OVERRIDES,
      })
    );
    // tx.wait() confirming doesn't guarantee every node behind this RPC
    // endpoint has caught up yet — a spend attempted immediately after can
    // hit a node that still sees the pre-funding balance and reject it.
    // Poll until the funded balance is actually visible before handing
    // the wallet back. This is very likely the real cause of the
    // "insufficient balance on a well-funded wallet" failures seen so far.
    for (let i = 0; i < 15; i++) {
      const bal = await provider.getBalance(wallet.address);
      if (bal >= amount) break;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return wallet;
}

export function contractFor(wallet) {
  return contractAs(wallet);
}

/// Monad testnet's mempool has been observed rejecting well-funded,
/// correctly-priced transactions with a misleading "insufficient balance"
/// error — inconsistently, not correlated with fee level (see PROJECT.md
/// for the debugging trail). Identical retries have consistently succeeded
/// within a couple attempts, so retry rather than chase a moving target.
export async function sendTx(fn, { retries = 6, delayMs = 1200 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const tx = await fn();
      return await tx.wait();
    } catch (err) {
      lastErr = err;
      if (attempt === 2) reconnect(); // a few same-connection retries first, then assume it's stuck
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
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
