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
    const tx = await funder.sendTransaction({
      to: wallet.address,
      value: ethers.parseEther(SESSION_FUND_AMOUNT),
    });
    await tx.wait();
  }
  return wallet;
}

export function contractFor(wallet) {
  return contractAs(wallet);
}

export { abi };
