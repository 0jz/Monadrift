// Fixed-rate tick loop with drift correction. setInterval drifts and bunches up
// under load; instead we keep an absolute schedule (start + n * tickMs) and, if
// we fall behind, run a few catch-up ticks and then skip the rest rather than
// spiral. Sim time is the tick count, so skipping only slows the race, it never
// changes its outcome.

export function createLoop({
  tickMs = 50,
  now = () => performance.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (h) => clearTimeout(h),
  onTick,
  maxCatchUp = 3,
} = {}) {
  let handle = null;
  let running = false;
  let next = 0; // absolute due time of the next tick
  const stats = { ticks: 0, skipped: 0, maxLagMs: 0, maxWorkMs: 0, lags: [] };

  function step() {
    handle = null;
    if (!running) return;
    let t = now();
    let ran = 0;
    while (t >= next && ran < maxCatchUp) {
      const lag = t - next;
      stats.maxLagMs = Math.max(stats.maxLagMs, lag);
      stats.lags.push(lag);
      if (stats.lags.length > 2000) stats.lags.shift();
      const w0 = now();
      try { onTick(); } catch (e) { console.error("[rt] tick error:", e); }
      stats.maxWorkMs = Math.max(stats.maxWorkMs, now() - w0);
      stats.ticks++;
      ran++;
      next += tickMs;
      t = now();
    }
    if (t >= next) { // still behind after the catch-up budget: drop the backlog
      const dropped = Math.floor((t - next) / tickMs) + 1;
      stats.skipped += dropped;
      next += dropped * tickMs;
    }
    handle = schedule(step, Math.max(0, next - now()));
  }

  return {
    start() {
      if (running) return;
      running = true;
      next = now() + tickMs;
      handle = schedule(step, tickMs);
    },
    stop() {
      running = false;
      if (handle !== null) cancel(handle);
      handle = null;
    },
    get running() { return running; },
    stats() {
      const s = [...stats.lags].sort((a, b) => a - b);
      const p99 = s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.99))] : 0;
      return { ticks: stats.ticks, skipped: stats.skipped, maxLagMs: stats.maxLagMs, p99LagMs: p99, maxWorkMs: stats.maxWorkMs };
    },
  };
}
