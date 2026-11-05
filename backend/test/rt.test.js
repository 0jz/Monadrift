import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { WebSocket } from "ws";
import { Room, RoomError, COUNTDOWN_TICKS, INPUT_STALE_TICKS } from "../src/rt/room.js";
import { createLoop } from "../src/rt/loop.js";
import { initRt } from "../src/rt/index.js";
import { verifyReplay, NEUTRAL_INPUT } from "../src/rt/sim.js";

const fixedRandom = () => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 255);

function runToEnd(room) {
  let guard = 0;
  while (room.phase !== "finished" && guard++ < 10000) room.tick();
  return guard;
}

test("12 bots race to the end and the replay verifies", () => {
  const room = new Room({ id: "t1", mode: "SHOWCASE_MIXED", randomBytes: fixedRandom });
  room.fillBots(12);
  room.start();
  runToEnd(room);
  assert.equal(room.phase, "finished");
  const replay = room.replay();
  const v = verifyReplay(replay, { checkpoints: replay.checkpoints, ranking: replay.ranking });
  assert.ok(v.ok, v.errors.join("; "));
  assert.equal(room.result().ranking.length, 12);
});

test("seed and replay stay hidden until the finish; views never leak playerIds", () => {
  const room = new Room({ id: "t2", randomBytes: fixedRandom });
  room.addPlayer({ playerId: "secret-player-1", name: "A" });
  room.addPlayer({ playerId: "secret-player-2", name: "B" });
  room.start();
  for (let i = 0; i < COUNTDOWN_TICKS + 5; i++) room.tick();
  assert.equal(room.replay(), null);
  const blob = JSON.stringify([room.snapFor("secret-player-1"), room.spectatorView(), room.lobbyView()]);
  assert.ok(!blob.includes("secret-player"));
  assert.ok(!blob.includes(room._seed.toString(16)));
});

test("input validation, countdown ignores nothing harmful, stale input decays", () => {
  const room = new Room({ id: "t3", randomBytes: fixedRandom });
  room.addPlayer({ playerId: "player-aaaa", name: "A" });
  room.addPlayer({ playerId: "player-bbbb", name: "B" });
  assert.equal(room.setInput("player-aaaa", 99), false);
  assert.equal(room.setInput("player-aaaa", { steer: 2 }), false);
  assert.equal(room.setInput("player-aaaa", "x"), false);
  assert.equal(room.setInput("nobody", 1), false);
  room.start();
  for (let i = 0; i < COUNTDOWN_TICKS; i++) room.tick();
  assert.equal(room.phase, "running");
  assert.equal(room.setInput("player-aaaa", { steer: 0, throttle: 1, brake: 0 }), true);
  const p = room.playerById("player-aaaa");
  assert.notEqual(room._inputFor(p), NEUTRAL_INPUT);
  for (let i = 0; i <= INPUT_STALE_TICKS + 1; i++) room.tick();
  assert.equal(room._inputFor(p), NEUTRAL_INPUT);
});

test("mode is enforced by player kind", () => {
  const h = new Room({ id: "t4", mode: "HUMAN_ONLY" });
  assert.throws(() => h.addPlayer({ playerId: "agent-12345", kind: "agent" }), RoomError);
  const a = new Room({ id: "t5", mode: "AGENT_ONLY" });
  assert.throws(() => a.addPlayer({ playerId: "human-12345", kind: "human" }), RoomError);
});

test("loop: catches up a few ticks then skips the backlog", () => {
  let t = 0;
  const due = [];
  let ticks = 0;
  const loop = createLoop({
    tickMs: 50, now: () => t, schedule: (fn, ms) => { due.push({ fn, at: t + ms }); return due.length; }, cancel() {},
    onTick: () => { ticks++; },
  });
  loop.start();
  t = 50; due.pop().fn();
  assert.equal(ticks, 1);
  t = 1000; due.pop().fn(); // 950 ms behind: 3 catch-up ticks, rest skipped
  assert.equal(ticks, 4);
  assert.ok(loop.stats().skipped > 10);
  const next = due.pop();
  assert.ok(next.at > t - 1 && next.at <= t + 50);
});

test("HTTP + WebSocket: two clients race against bots", async () => {
  const app = express();
  const rt = initRt(app, { tickMs: 5 });
  const server = http.createServer(app);
  server.on("upgrade", (req, s, h) => rt.handleUpgrade(req, s, h));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, pid) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(pid ? { "x-player-id": pid } : {}) }, body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const { body: s1 } = await post("/rt/session");
    const { body: s2 } = await post("/rt/session");
    const created = await post("/rt/lobby/create", { mode: "HUMAN_ONLY", name: "One" }, s1.playerId);
    const id = created.body.raceId;
    assert.equal((await post(`/rt/lobby/${id}/join`, { name: "Two" }, s2.playerId)).status, 200);
    assert.equal((await post(`/rt/race/${id}/start`, {}, s2.playerId)).status, 403); // not the creator
    assert.equal((await post(`/rt/race/${id}/start`, { fillBots: 6 }, s1.playerId)).status, 200);

    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/rt/ws`);
    const msgs = [];
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "hello", race: id, player: s1.playerId }));
    for (let i = 0; i < 400 && !msgs.some((m) => m.t === "snap"); i++) await new Promise((r) => setTimeout(r, 10));
    const snap = msgs.find((m) => m.t === "snap");
    assert.ok(snap, "got a snap");
    assert.ok(!JSON.stringify(msgs).includes(s2.playerId));
    for (let i = 0; i < 60; i++) ws.send(JSON.stringify({ t: "in", i: 7 })); // flood: must not crash
    assert.equal((await fetch(`${base}/rt/race/${id}/replay`)).status, 409);
    for (let i = 0; i < 1500; i++) { // wait for the end
      if (msgs.some((m) => m.t === "end")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(msgs.some((m) => m.t === "end"), "race ended");
    const rp = await (await fetch(`${base}/rt/race/${id}/replay`)).json();
    assert.ok(verifyReplay(rp, { checkpoints: rp.checkpoints, ranking: rp.ranking }).ok);
    ws.close();
  } finally {
    rt.stop();
    server.closeAllConnections?.();
    server.close();
  }
});
