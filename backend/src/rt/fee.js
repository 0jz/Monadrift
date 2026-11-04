// Kept apart from paid.js so routes can validate fees without importing chain.js
// (which needs .env and an RPC) on free-play servers and in tests.
import { ethers } from "ethers";
export const MAX_ENTRY_FEE = ethers.parseEther("0.5");

// Pure hashing helpers (no chain.js import) so PaidRace is testable with a fake chain.
export const commitHashFor = (seed, salt) => ethers.solidityPackedKeccak256(["uint256", "uint256"], [seed, salt]);
export const replayRootFor = (replay) => ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(replay)));
