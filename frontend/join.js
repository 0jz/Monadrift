const el = (id) => document.getElementById(id);
const status = (msg, isError = false) => {
  const box = el("joinStatus");
  box.textContent = msg;
  box.classList.toggle("error", isError);
};

const params = new URLSearchParams(location.search);
const presetLobby = params.get("lobby"); // set by a per-lobby QR code, see backend GET /lobby/:id/qr

el("registerBtn").onclick = async () => {
  const playerId = el("playerId").value.trim() || `player-${Math.random().toString(36).slice(2, 6)}`;
  const btn = el("registerBtn");
  btn.disabled = true;
  status(presetLobby ? "Registering and joining lobby…" : "Registering…");

  try {
    const { address } = await api("/session/register", { method: "POST", body: JSON.stringify({ playerId }) });
    saveIdentity(playerId, address);

    if (presetLobby) {
      // Scanned a lobby-specific QR — skip lobby selection entirely and
      // join that exact race directly.
      const result = await api("/lobby/quickmatch", { method: "POST", body: JSON.stringify({ playerId, lobby: presetLobby }) });
      saveRace(result.raceId);
      location.href = "race.html";
      return;
    }

    el("identityAddress").textContent = address;
    el("registerView").classList.add("hidden");
    el("identityView").classList.remove("hidden");
  } catch (err) {
    status(`Failed: ${err.message}`, true);
    btn.disabled = false;
  }
};

el("continueBtn")?.addEventListener("click", () => {
  location.href = "lobby.html";
});

el("playerId").addEventListener("keydown", (evt) => {
  if (evt.key === "Enter") el("registerBtn").click();
});
