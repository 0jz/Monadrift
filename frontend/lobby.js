const el = (id) => document.getElementById(id);

const { playerId } = loadIdentity();
if (!playerId) location.href = "index.html";
el("playerPill").textContent = playerId;

let raceId = null;
let lobbyType = null;
let pollTimer = null;

document.querySelectorAll(".lobby-create").forEach((btn) => {
  btn.onclick = async () => {
    lobbyType = btn.dataset.type;
    document.querySelectorAll(".lobby-create").forEach((b) => (b.disabled = true));
    try {
      const result = await api("/lobby/create", { method: "POST", body: JSON.stringify({ playerId, type: lobbyType }) });
      raceId = result.raceId;
      saveRace(raceId);
      showWaiting();
    } catch (err) {
      document.querySelectorAll(".lobby-create").forEach((b) => (b.disabled = false));
      alert(`Couldn't create lobby: ${err.message}`);
    }
  };
});

function showWaiting() {
  el("pickerView").classList.add("hidden");
  el("waitingView").classList.remove("hidden");
  el("waitingTitle").textContent = lobbyType === "duel" ? "Duel lobby" : "Public lobby";
  el("waitingRaceId").textContent = raceId;
  el("qrImage").src = `/lobby/${raceId}/qr`;
  if (lobbyType === "public") el("startBtn").classList.remove("hidden");
  pollTimer = setInterval(pollState, 1000);
  pollState();
}

el("startBtn").onclick = async () => {
  el("startBtn").disabled = true;
  el("waitingStatus").textContent = "Starting…";
  try {
    await api(`/race/${raceId}/start`, { method: "POST" });
  } catch (err) {
    el("waitingStatus").textContent = `Failed: ${err.message}`;
    el("waitingStatus").classList.add("error");
    el("startBtn").disabled = false;
  }
};

async function pollState() {
  try {
    const state = await api(`/race/${raceId}/state`);
    el("waitingCount").textContent = `${state.players.length} joined`;
    if (state.phase === 2) {
      // RUNNING — everyone in the lobby (creator included) heads to the race.
      clearInterval(pollTimer);
      location.href = "race.html";
    }
  } catch {
    // transient — next poll will retry
  }
}
