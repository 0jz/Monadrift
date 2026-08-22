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

// ABI loaded from Foundry's build output so it's always in sync with src/Monadrift.sol
// after `forge build`. Run `forge build` from the repo root before starting the backend.
const artifactPath = path.join(__dirname, "..", "..", "out", "Monadrift.sol", "Monadrift.json");
let abi;
try {
  abi = JSON.parse(fs.readFileSync(artifactPath, "utf8")).abi;
} catch {
  console.warn(`[chain] Could not read ${artifactPath} — run "forge build" first. Falling back to empty ABI.`);
  abi = [];
}

export const provider = new ethers.JsonRpcProvider(RPC_URL);
export const funder = FUNDER_PRIVATE_KEY ? new ethers.Wallet(FUNDER_PRIVATE_KEY, provider) : null;

// Roughly matches what `cast`'s own fee estimation used in a confirmed-
// successful test call, as a reasonable default — but see sendTx() below:
// this alone did NOT reliably fix testnet's flaky mempool admission
// (higher and lower values both failed inconsistently), so the real fix
// is retrying, not a specific fee number.
//
// gasLimit is set explicitly for the same reason: without it, ethers
// calls eth_estimateGas as a *separate* RPC round-trip before every write.
// If that specific call hits a flaky/rate-limited RPC response, ethers
// can't decode a revert reason and throws "missing revert data" — even
// though the actual transaction might have been perfectly valid. All our
// writes are cheap (~130k gas observed for join()); 1,000,000 is a generous
// fixed cap, well under what a player could ever be charged for actual
// gas used (you only pay for gas actually consumed), and it removes the
// estimateGas call from the picture entirely. Don't set this near the
// 32-bit max or anything huge: Monad's mempool admission reserves
// gasLimit * maxFeePerGas against the sender's balance just to accept the
// tx (see SESSION_FUND_AMOUNT in .env) — an oversized gasLimit forces
// proportionally oversized session funding for no real benefit, and risks
// exceeding the chain's actual per-block gas limit outright.
export const TX_OVERRIDES = {
  maxFeePerGas: ethers.parseUnits("210", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("5", "gwei"),
  gasLimit: 1000000n,
};

function contractAs(signerOrProvider) {
  // Falls back to the zero address so the server can boot (and serve the
  // static frontend) before a contract is deployed — any actual on-chain
  // call will just fail with a clear error instead of crashing at startup.
  return new ethers.Contract(CONTRACT_ADDRESS || ethers.ZeroAddress, abi, signerOrProvider);
}

export const readContract = contractAs(provider);

// playerId (arbitrary string from the client) -> ethers.Wallet
// This is the fix for the "shared relayer can't represent multiple players" problem:
// msg.sender must be distinct per player on-chain, so each session gets its own
// ephemeral key, auto-funded from the funder wallet. The human never sees it.
const sessions = new Map();

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
export async function sendTx(fn, { retries = 3, delayMs = 1200 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const tx = await fn();
      return await tx.wait();
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/// Same reasoning as sendTx, for plain read (view) calls — /race/:id/state
/// and /race/:id/segment/:i make several of these per request, and none of
/// them were retried before, so a single flaky RPC response turned into a
/// 500 for the whole endpoint.
export async function retryRpc(fn, { retries = 3, delayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export { abi };
