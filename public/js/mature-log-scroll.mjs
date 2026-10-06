// Remember deliberate reading of older entries across polling DOM replacements.
// Layout-driven scroll events must never turn off the default newest-entry pin.
const positions = new Map();
const wired = new WeakMap();
const observers = new Map();
export function pinRecentLog(box, key, { reset } = {}) {
  if (!box) return;
  let state = positions.get(key) || { bottom: true, top: 0 };
  if (reset) state = { bottom: reset === 'bottom', top: 0 };
  positions.set(key, state);
  let binding = wired.get(box);
  if (!binding) {
    binding = { reading: false };
    wired.set(box, binding);
    const deliberate = () => { binding.reading = true; };
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) box.addEventListener(event, deliberate, { passive: true });
    box.addEventListener('scroll', () => {
      if (!binding.reading || !box.clientHeight) return;
      positions.set(key, { bottom: box.scrollHeight - box.scrollTop - box.clientHeight < 8, top: box.scrollTop });
    }, { passive: true });
    // Fonts/layout can settle after the first render. Observe the box and its
    // ancestor visibility without capturing a stale pre-layout scroll position.
    const observer = new ResizeObserver(() => {
      if (!box.isConnected) { observer.disconnect(); return; }
      if (positions.get(key)?.bottom) box.scrollTop = box.scrollHeight;
    });
    observers.get(key)?.disconnect();
    observers.set(key, observer);
    observer.observe(box);
  }
  binding.reading = false;
  const apply = () => {
    if (!box.isConnected || binding.reading) return;
    const current = positions.get(key);
    box.scrollTop = current?.bottom ? box.scrollHeight : current?.top || 0;
  };
  apply();
  requestAnimationFrame(apply);
}
