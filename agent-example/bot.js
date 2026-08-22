#!/usr/bin/env node
// Reference "greedy-safe" agent — see PROJECT.md §14 and README "Playing as an AI agent".
// Plain HTTP, no wallet, no web3 library. This is the whole point: an agent
// needs nothing more than fetch() to play Monadrift.
//
// Usage: node bot.js <backend-url> <player-id> [mode]
//   node bot.js http://localhost:8787 agent-1 HUMAN_ONLY

const BASE = process.argv[2] || "http://localhost:8787";
const PLAYER_ID = process.argv[3] || `bot-${Math.random().toString(36).slice(2, 8)}`;
const MODE = process.argv[4] || "AGENT_ONLY";
const STRATEGY = process.env.STRATEGY || "safe"; // "safe" or "aggressive" — see PROJECT.md §14

async function api(path, opts) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`[${PLAYER_ID}] joining a ${MODE} lobby...`);
  const { raceId } = await api("/lobby/quickmatch", {
    method: "POST",
    body: JSON.stringify({ playerId: PLAYER_ID, mode: MODE }),
  });
  console.log(`[${PLAYER_ID}] in race ${raceId}, waiting for start...`);

  // wait for RUNNING (phase 2)
  let state;
  do {
    await sleep(500);
    state = await api(`/race/${raceId}/state`);
  } while (state.phase !== 2);

  console.log(`[${PLAYER_ID}] race started — greedy-safe strategy engaged`);

  let position = 0;
  let alive = true;
  let finished = false;

  while (alive && !finished) {
    const nextIndex = position + 1;

    // Fog-of-war: this only ever returns the segment one step ahead —
    // that's true for a human clicking a button too, not a special
    // restriction on bots. See PROJECT.md §4.
    const segment = await api(`/race/${raceId}/segment/${nextIndex}?playerId=${PLAYER_ID}`);

    // On TURN/OBSTACLE there's a real correct lane, both strategies play it safe there —
    // getting wrecked to make a demo point isn't the goal. The only difference is on
    // STRAIGHT/BOOST segments, where lane genuinely doesn't matter for progress, so an
    // "aggressive" bot uses that free choice to sit in the statistically most contested
    // lane (CENTER) instead of avoiding traffic. This is what produces the "two bots
    // collide live and it looks unscripted" demo beat from PROJECT.md §14.
    const direction = segment.correctLane ?? (STRATEGY === "aggressive" ? "CENTER" : ["LEFT", "RIGHT"][nextIndex % 2]);

    const move = await api(`/race/${raceId}/move`, {
      method: "POST",
      body: JSON.stringify({ playerId: PLAYER_ID, direction }),
    });

    position = move.position;
    alive = move.alive;
    finished = move.finished;

    console.log(
      `[${PLAYER_ID}] seg ${nextIndex} -> ${direction} | pos=${position} hp=${move.hp} speed=${move.speed} stake=${move.stake} (${move.latencyMs}ms)`
    );
  }

  console.log(`[${PLAYER_ID}] ${finished ? "finished the race" : "eliminated"}.`);
}

main().catch((err) => {
  console.error(`[${PLAYER_ID}] error:`, err.message);
  process.exit(1);
});
