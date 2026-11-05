import { RoadCache, draw, lateralRate, yawOf } from "./render.js";
import { rtApi, openSocket } from "./net.js";
import { createInput } from "./input.js";

const $ = (id) => document.getElementById(id);
const show = (name) => { for (const s of ["menu", "lobby", "race", "end"]) $(s).classList.toggle("hidden", s !== name); };
const params = new URLSearchParams(location.search);

// Identity: a private bearer id from the server, kept in this browser only.
async function identity() {
  let id = localStorage.getItem("monadrift.rt.playerId");
  if (!id) {
    id = (await rtApi(null)("/session", {})).playerId;
    localStorage.setItem("monadrift.rt.playerId", id);
  }
  return id;
}

let playerId, api, raceId, sock, input, spectate = false;
let road = new RoadCache();
let latest = null; // {msg, at}
let sectionsTotal = 0;
let lastCp = null;
let creator = false;

const name = () => $("name").value.trim() || localStorage.getItem("monadrift.rt.name") || "";
$("name").value = localStorage.getItem("monadrift.rt.name") || "";
$("name").addEventListener("change", () => localStorage.setItem("monadrift.rt.name", $("name").value.trim()));

function status(el, text) { $(el).textContent = text ?? ""; }

async function enterRace(id, isCreator) {
  raceId = id; creator = isCreator;
  road = new RoadCache(); latest = null; lastCp = null; $("cp").textContent = "";
  sock?.close();
  sock = openSocket({ race: id, player: playerId, spectate, onMsg, onClose: () => { if (!ended) status("lobbyStatus", "Connection closed."); } });
  ended = false;
  if (!spectate) input = createInput((i) => sock?.sendInput(i), $("touch"));
  $("lobbyId").textContent = "#" + id;
  show("lobby");
  try {
    const qr = await api(`/lobby/${id}/qr`);
    $("qr").innerHTML = qr.svg;
  } catch { /* QR is a nicety */ }
}

let ended = false;
function onMsg(m) {
  if (m.t === "ready" || m.t === "lobby") renderLobby(m.lobby);
  else if (m.t === "snap" || m.t === "view") {
    if (m.t === "snap") road.fromObs(m.obs); else road.fromView(m);
    latest = { msg: m, at: performance.now() };
    if (m.phase === "countdown" || m.phase === "running") { if ($("race").classList.contains("hidden") && !ended) startRaceView(); }
  } else if (m.t === "cp") {
    lastCp = m;
    $("cp").textContent = `CP ${m.index + 1} · tick ${m.tick} · ${m.hash.slice(0, 10)}…${m.hash.slice(-4)}`;
  } else if (m.t === "end") showEnd(m.result);
}

function renderLobby(l) {
  sectionsTotal = l.sections;
  $("players").innerHTML = l.players.map((p) => `<li><span>${esc(p.name)}</span><span>${p.kind === "bot" ? "BOT" : "DRIVER"}</span></li>`).join("");
  $("lobbyTimer").textContent = l.startsInTicks === null ? "when 2+ players are in" : `in ${Math.ceil(l.startsInTicks / 20)} s`;
  $("startBtn").classList.toggle("hidden", !creator);
  $("botsBtn").classList.toggle("hidden", !creator);
}
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function startRaceView() { show("race"); resize(); }

function showEnd(result) {
  ended = true;
  input?.stop();
  $("results").innerHTML = result.ranking.map((r) =>
    `<li class="${r.place === 1 ? "first" : ""}"><span>${r.place}. ${esc(r.name)}${r.isBot ? " · BOT" : ""}</span><span>${r.finishTick === null ? "DNF" : (r.finishTick / 20).toFixed(1) + " s"}</span></li>`).join("");
  $("replayLink").href = `${API}/rt/race/${raceId}/replay`;
  $("end").classList.remove("hidden");
}

// ---- menu actions ----
async function guarded(fn) {
  try { status("menuStatus", ""); await fn(); } catch (e) { status("menuStatus", e.message); }
}
$("vsBots").onclick = () => guarded(async () => {
  const r = await api("/lobby/create", { mode: "HUMAN_ONLY", name: name() });
  await enterRace(r.raceId, true);
  await api(`/race/${r.raceId}/start`, { fillBots: 8 });
});
$("quick").onclick = () => guarded(async () => {
  const r = await api("/lobby/quickmatch", { name: name() });
  await enterRace(r.raceId, false);
});
$("create").onclick = () => guarded(async () => {
  const r = await api("/lobby/create", { mode: "HUMAN_ONLY", name: name() });
  await enterRace(r.raceId, true);
});
$("startBtn").onclick = () => api(`/race/${raceId}/start`, {}).catch((e) => status("lobbyStatus", e.message));
$("botsBtn").onclick = () => api(`/race/${raceId}/start`, { fillBots: 8 }).catch((e) => status("lobbyStatus", e.message));
$("again").onclick = () => { $("end").classList.add("hidden"); sock?.close(); show("menu"); history.replaceState(null, "", location.pathname); };

// ---- render loop ----
const cv = $("cv"), ctx = cv.getContext("2d");
function resize() {
  const dpr = devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
}
addEventListener("resize", resize);

let myYaw = 0, lastFrame = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const frameDt = Math.min(100, now - (lastFrame || now)); lastFrame = now;
  if (!latest || $("race").classList.contains("hidden")) return;
  const { msg, at } = latest;
  const dt = Math.min(100, now - at);
  let cars, camS, hud;
  if (msg.t === "snap") {
    const o = msg.obs;
    const meS = o.s + (o.v * dt) / 1000;
    // Smooth my own nose (frame-rate independent); the 20 Hz lv steps would otherwise twitch it.
    const k = road.curvAt(o.s), target = yawOf(o.lv, o.v, k);
    myYaw += (target - myYaw) * (1 - Math.exp(-frameDt / 90));
    cars = [{ s: meS, d: o.d + (lateralRate(o.lv, o.v, k) * dt) / 50, slot: msg.you, name: "You", me: true, yaw: myYaw }];
    for (const x of o.others) {
      const ov = o.v + x.dv, olv = o.lv + (x.dlv ?? 0), ok = road.curvAt(o.s + x.ds);
      cars.push({ s: o.s + x.ds + (ov * dt) / 1000, d: o.d + x.dd + (lateralRate(olv, ov, ok) * dt) / 50, slot: 6, yaw: yawOf(olv, ov, ok) });
    }
    camS = meS;
    hud = { speed: o.v, place: `${o.place}/${o.field}`, tick: msg.tick, progress: cars.map((c) => ({ s: c.s, me: c.me })) };
  } else {
    cars = msg.cars.map((c) => {
      const k = road.curvAt(c.s);
      return { s: c.s + (c.v * dt) / 1000, d: c.d + (lateralRate(c.lv ?? 0, c.v, k) * dt) / 50, slot: c.slot, name: c.name, done: c.fin, yaw: yawOf(c.lv ?? 0, c.v, k) };
    });
    camS = cars[msg.order[0]].s;
    hud = { speed: msg.cars[msg.order[0]].v ?? 0, place: "spectating", tick: msg.tick, progress: cars.map((c) => ({ s: c.s })) };
  }
  draw(ctx, cv.width, cv.height, { road, camS, cars, sections: msg.t === "view" ? msg.sections : sectionsTotal });

  $("speed").textContent = Math.round((hud.speed * 3.6) / 1000);
  $("place").textContent = hud.place;
  $("clock").textContent = (hud.tick / 20).toFixed(1) + " s";
  const end = (msg.t === "view" ? msg.sections : sectionsTotal) * 20000 || 1;
  $("progress").innerHTML = hud.progress.map((p) => `<i style="left:${Math.min(100, (p.s / end) * 100)}%;background:${p.me ? "#d7ff3f" : "#8f8f96"}"></i>`).join("");
  $("count").textContent = msg.phase === "countdown" && msg.countdown !== null ? Math.ceil(msg.countdown / 20) : "";
}
requestAnimationFrame(frame);

// ---- boot ----
(async function boot() {
  try {
    playerId = await identity();
    api = rtApi(playerId);
    const lobby = params.get("lobby");
    if (params.get("spectate") && lobby) { spectate = true; await enterRace(lobby, false); return; }
    if (lobby) { // scanned QR
      const r = await api(`/lobby/${encodeURIComponent(lobby)}/join`, { name: name() });
      await enterRace(r.raceId, false);
    }
  } catch (e) { status("menuStatus", e.message); }
})();
