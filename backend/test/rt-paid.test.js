import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { initRt } from "../src/rt/index.js";
import { PaidRace } from "../src/rt/paid.js";
import { commitHashFor } from "../src/rt/fee.js";

// A chain that records calls instead of sending transactions.
function fakeChain() {
  const calls = [];
  const rec = (name, ret) => async (...a) => { calls.push({ name, a }); return typeof ret === "function" ? ret(...a) : ret; };
  return {
    calls,
    address: () => "0xFake",
    createRace: rec("createRace", { raceId: 7, block: 100, tx: "0xcreate" }),
    join: rec("join", (playerId) => ({ address: "0xW" + playerId.slice(0, 4), tx: "0xjoin" })),
    commitSeed: rec("commitSeed", "0xcommit"),
    checkpoint: rec("checkpoint", "0xcp"),
    settle: rec("settle", { tx: "0xsettle", block: 150 }),
    cancel: rec("cancel", "0xcancel"),
    claim: rec("claim", null),
  };
}

async function setup(chain) {
  const app = express();
  const rt = initRt(app, { tickMs: 3, manager: { paidFactory: async (room, fee) => new PaidRace(room, fee, chain) } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, pid) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(pid ? { "x-player-id": pid } : {}) }, body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json() };
  };
  return { rt, server, base, post, close: () => { rt.stop(); server.close(); } };
}

test("paid race: guard, commit before reveal, checkpoints, settle with finishers", async () => {
  const chain = fakeChain();
  const t = await setup(chain);
  try {
    const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    assert.equal((await t.post("/rt/lobby/create", { entryFee: "0.9" }, A)).status, 400); // over the cap
    assert.equal((await t.post("/rt/lobby/create", { entryFee: "abc" }, A)).status, 400);
    const c = await t.post("/rt/lobby/create", { entryFee: "0.01", name: "A" }, A);
    assert.equal(c.status, 200);
    const id = c.body.raceId;
    assert.equal(c.body.lobby.paid.raceId, 7);
    // One paying player cannot start (commitSeed would revert on chain).
    assert.equal((await t.post(`/rt/race/${id}/start`, { fillBots: 6 }, A)).status, 409);
    assert.equal((await t.post(`/rt/lobby/${id}/join`, { name: "B", payoutTo: "nope" }, B)).status, 400);
    assert.equal((await t.post(`/rt/lobby/${id}/join`, { name: "B" }, B)).status, 200);
    assert.equal((await t.post(`/rt/race/${id}/start`, { fillBots: 6 }, A)).status, 200);

    const room = t.rt.manager.get(id);
    for (let i = 0; i < 3000 && !room.chain.settled; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(room.chain.settled, "race ended");
    await room.chain.settled;
    await room.chain._q;

    const names = chain.calls.map((c) => c.name);
    assert.equal(names.filter((n) => n === "commitSeed").length, 1);
    assert.ok(names.indexOf("commitSeed") < names.indexOf("checkpoint") || !names.includes("checkpoint"));
    assert.equal(names.at(names.lastIndexOf("settle")), "settle");
    const commit = chain.calls.find((c) => c.name === "commitSeed");
    const settle = chain.calls.find((c) => c.name === "settle");
    const [raceId, seed, salt, winners] = settle.a;
    assert.equal(raceId, 7);
    assert.equal(commitHashFor(seed, salt), commit.a[1]); // reveal matches commit
    assert.ok(winners.length <= 3 && winners.every((w) => w.startsWith("0xW")));

    const res = await (await fetch(`${t.base}/rt/race/${id}/result`)).json();
    assert.equal(res.paid.raceId, 7);
    assert.ok(res.paid.tx.settle);
    assert.ok(!JSON.stringify(res).includes(A));
  } finally { t.close(); }
});

test("paid race: failed entry payment frees the seat; unpaid lobby has no chain", async () => {
  const chain = fakeChain();
  chain.join = async () => { throw new Error("insufficient funds"); };
  const t = await setup(chain);
  try {
    const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const c = await t.post("/rt/lobby/create", { entryFee: "0.01" }, A);
    assert.equal(c.status, 402);
    const free = await t.post("/rt/lobby/create", {}, A);
    assert.equal(free.status, 200);
    assert.equal(free.body.lobby.paid, null);
    assert.equal((await fetch(`${t.base}/rt/race/${free.body.raceId}/proof`)).status, 404);
  } finally { t.close(); }
});
