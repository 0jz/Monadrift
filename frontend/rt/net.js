// Network layer for the real-time game: tiny fetch wrapper (player id in a
// header, never a URL) plus the /rt/ws socket.

export const rtApi = (playerId) => async (path, body, method) => {
  const res = await fetch(`${API}/rt${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", ...(playerId ? { "X-Player-Id": playerId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

/** Opens the socket and says hello. Handlers: {onMsg, onClose}. */
export function openSocket({ race, player, spectate, onMsg, onClose }) {
  const ws = new WebSocket(`${WS_BASE}/rt/ws`);
  ws.onopen = () => ws.send(JSON.stringify(spectate ? { t: "hello", race, spectate: true } : { t: "hello", race, player }));
  ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch { /* ignore junk */ } };
  ws.onclose = (e) => onClose?.(e);
  return {
    sendInput(i) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "in", i })); },
    close() { ws.close(); },
  };
}
