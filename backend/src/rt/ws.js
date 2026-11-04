// WebSocket layer for /rt/ws. First message must be a hello (auth never rides in
// the URL). Drivers get their fogged snap every tick; spectators get the
// projector view. Inputs are rate-limited with a token bucket.

import { WebSocketServer } from "ws";

const HELLO_TIMEOUT_MS = 3000;
const MAX_BUFFERED = 64 * 1024;
const INPUT_RATE = 40; // msgs per second
const LOBBY_EVERY = 10; // ticks

export function createWs({ manager }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256, perMessageDeflate: false });
  const byRoom = new Map(); // roomId -> Set<ws>

  const send = (ws, obj) => {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_BUFFERED) return; // slow client: drop this frame, never queue up
    ws.send(JSON.stringify(obj));
  };

  wss.on("connection", (ws) => {
    let bound = false;
    let tokens = INPUT_RATE;
    let refill = Date.now();
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    const timer = setTimeout(() => { if (!bound) ws.close(4401, "hello timeout"); }, HELLO_TIMEOUT_MS);
    ws.on("error", () => {});
    ws.on("close", () => {
      clearTimeout(timer);
      if (ws.roomId) byRoom.get(ws.roomId)?.delete(ws);
    });

    ws.on("message", (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return ws.close(4400, "bad json"); }
      if (!m || typeof m !== "object") return;

      if (!bound) {
        if (m.t !== "hello") return ws.close(4400, "hello first");
        const room = manager.get(m.race);
        if (!room) return ws.close(4404, "no such race");
        if (m.spectate) { ws.spectator = true; }
        else {
          const p = room.playerById(String(m.player ?? ""));
          if (!p) return ws.close(4403, "not in this race");
          ws.playerId = p.playerId;
        }
        bound = true;
        clearTimeout(timer);
        ws.roomId = room.id;
        if (!byRoom.has(room.id)) byRoom.set(room.id, new Set());
        byRoom.get(room.id).add(ws);
        send(ws, { t: "ready", lobby: room.lobbyView() });
        return;
      }

      if (m.t === "in" && ws.playerId) {
        const now = Date.now();
        tokens = Math.min(INPUT_RATE, tokens + ((now - refill) / 1000) * INPUT_RATE);
        refill = now;
        if (tokens < 1) return; // flood: silently ignore
        tokens -= 1;
        manager.get(ws.roomId)?.setInput(ws.playerId, m.i !== undefined ? m.i : { steer: m.steer, throttle: m.throttle, brake: m.brake });
      }
    });
  });

  /** Called by the manager after each room tick with that tick's events. */
  function onEvents(room, events) {
    const set = byRoom.get(room.id);
    if (!set || !set.size) return;
    for (const ev of events) {
      if (ev.type === "checkpoint") for (const ws of set) send(ws, { t: "cp", index: ev.index, tick: ev.tick, hash: ev.chained });
      else if (ev.type === "end") for (const ws of set) send(ws, { t: "end", result: ev.result });
      else if (ev.type === "phase") for (const ws of set) send(ws, { t: "phase", phase: ev.phase });
    }
  }

  /** Called once per loop tick, after manager.tickAll(). */
  function broadcast() {
    for (const [id, set] of byRoom) {
      const room = manager.get(id);
      if (!room) { for (const ws of set) ws.close(1001, "room gone"); byRoom.delete(id); continue; }
      if (!set.size) continue;
      const active = room.phase === "countdown" || room.phase === "running";
      const view = active && [...set].some((w) => w.spectator) ? room.spectatorView() : null;
      for (const ws of set) {
        if (active) {
          if (ws.spectator) send(ws, view);
          else { const s = room.snapFor(ws.playerId); if (s) send(ws, s); }
        } else if (room.phase === "lobby" && (room.lobbyTicks % LOBBY_EVERY === 0)) {
          send(ws, { t: "lobby", lobby: room.lobbyView() });
        }
      }
    }
  }

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }, 20000);
  pinger.unref();

  return {
    onEvents, broadcast,
    handleUpgrade(req, socket, head) { wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)); },
    close() { clearInterval(pinger); wss.close(); },
  };
}
