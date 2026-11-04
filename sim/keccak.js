// Dependency-free Keccak-256 (the Ethereum hash, NOT NIST SHA3: padding byte is
// 0x01, not 0x06). BigInt lanes keep it short; it is only used at checkpoint
// rate (every ~5 s), so speed does not matter. Runs unchanged in the browser.

const M = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0n ? x : ((x << n) | (x >> (64n - n))) & M);

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];

function permute(a) {
  const c = new Array(5);
  const b = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1n);
      for (let y = 0; y < 5; y++) a[x + 5 * y] ^= d;
    }
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], BigInt(ROT[x][y]));
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        a[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & M & b[((x + 2) % 5) + 5 * y]);
    a[0] ^= RC[round];
  }
}

/** @param {Uint8Array} data @returns {Uint8Array} 32 bytes */
export function keccak256(data) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const a = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      a[i] ^= lane;
    }
    permute(a);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((a[i] >> BigInt(8 * j)) & 0xffn);
  return out;
}

export const toHex = (u8) => "0x" + Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
export function fromHex(h) {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2) throw new Error("odd hex length");
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}
