// Keyboard + touch controls -> one packed int (steer+1 + 3*throttle + 6*brake).
// Re-sent every 150 ms while held: the server coasts a silent client after 0.5 s.

export function createInput(send, touchRoot) {
  const st = { left: false, right: false, up: false, down: false };
  let last = -1, lastSent = 0;
  const packed = () => (st.right - st.left) + 1 + (st.up ? 3 : 0) + (st.down ? 6 : 0);
  const map = { ArrowLeft: "left", a: "left", A: "left", ArrowRight: "right", d: "right", D: "right", ArrowUp: "up", w: "up", W: "up", ArrowDown: "down", s: "down", S: "down" };
  const flush = (force) => {
    const p = packed(), now = performance.now();
    if (force || p !== last || now - lastSent > 150) { send(p); last = p; lastSent = now; }
  };
  const key = (down) => (e) => {
    const k = map[e.key];
    if (!k) return;
    e.preventDefault();
    st[k] = down;
    flush(true);
  };
  addEventListener("keydown", key(true));
  addEventListener("keyup", key(false));
  addEventListener("blur", () => { for (const k in st) st[k] = false; flush(true); });

  touchRoot?.querySelectorAll("[data-ctl]").forEach((el) => {
    const k = el.dataset.ctl;
    const set = (v) => (e) => { e.preventDefault(); st[k] = v; flush(true); };
    el.addEventListener("pointerdown", set(true));
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(ev, set(false));
  });

  const timer = setInterval(() => flush(false), 50);
  return { stop() { clearInterval(timer); } };
}
