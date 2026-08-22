const el = (id) => document.getElementById(id);
const status = (msg, isError = false) => {
  const box = el("joinStatus");
  box.textContent = msg;
  box.classList.toggle("error", isError);
};

const params = new URLSearchParams(location.search);
const presetLobby = params.get("lobby"); // set by the per-lobby QR code, see backend GET /lobby/:id/qr

if (presetLobby) status(`Joining lobby ${presetLobby}…`);

el("joinBtn").onclick = async () => {
  const playerId = el("playerId").value.trim() || `player-${Math.random().toString(36).slice(2, 6)}`;
  const mode = el("mode").value;
  const btn = el("joinBtn");

  btn.disabled = true;
  status("Joining…");
  try {
    const body = { playerId, mode };
    if (presetLobby) body.lobby = presetLobby;
    const result = await api("/lobby/quickmatch", { method: "POST", body: JSON.stringify(body) });
    saveSession(playerId, result.raceId, mode);
    location.href = "race.html";
  } catch (err) {
    status(`Join failed: ${err.message}`, true);
    btn.disabled = false;
  }
};

el("playerId").addEventListener("keydown", (evt) => {
  if (evt.key === "Enter") el("joinBtn").click();
});
