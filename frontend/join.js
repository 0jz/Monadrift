const el = (id) => document.getElementById(id);
const status = (msg, isError = false) => {
  const box = el("joinStatus");
  box.textContent = msg;
  box.classList.toggle("error", isError);
};

const params = new URLSearchParams(location.search);
const presetLobby = params.get("lobby"); // set by a per-lobby QR code, see backend GET /lobby/:id/qr

// "remembers me": identity lives in localStorage (see shared.js), so a
// returning visitor never has to see this form again unless they've
// explicitly cleared it (lobby.html has a "switch identity" link for that).
const existing = loadIdentity();
if (existing.playerId && existing.address) {
  if (presetLobby) {
    joinPresetLobby(existing.playerId);
  } else {
    location.href = "lobby.html";
  }
}

async function joinPresetLobby(playerId) {
  try {
    const result = await api("/lobby/quickmatch", { method: "POST", body: JSON.stringify({ playerId, lobby: presetLobby }) });
    saveRace(result.raceId);
    location.href = "race.html";
  } catch (err) {
    status(`Couldn't join that lobby: ${err.message}`, true);
  }
}

el("registerBtn").onclick = async () => {
  // Blank is valid on purpose — the backend generates a playerId if none is
  // given (PROJECT.md: "wallets or generated"). Whatever's typed here is
  // just a lookup key, never an actual signer — the real funded wallet is
  // the one the backend returns as `address` below.
  const typedAddress = el("addressInput").value.trim();
  const btn = el("registerBtn");
  btn.disabled = true;
  status(presetLobby ? "Registering and joining lobby…" : "Registering…");

  try {
    const body = typedAddress ? { playerId: typedAddress } : {};
    const { playerId, address } = await api("/session/register", { method: "POST", body: JSON.stringify(body) });
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

el("addressInput").addEventListener("keydown", (evt) => {
  if (evt.key === "Enter") el("registerBtn").click();
});
