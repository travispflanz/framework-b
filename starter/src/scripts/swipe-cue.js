// The scroll cue under a sideways strip on phones (SwipeCue.astro): a bar in the accent colour as long as the share
// of the strip on screen, with an arrow head pointing the way there is more to see. On phones the browser's own
// scrollbar is an overlay drawn only while scrolling, so it can't be the cue (docs/SPEC.md section 12).
// It moves with transform only (no layout shift) and has no transition, so nothing animates on its own.

/** Where the cue's bar sits for a strip's scroll position. All values in px. */
export function cueState({ scrollLeft, scrollWidth, clientWidth, track, min = 32 }) {
  const room = scrollWidth - clientWidth;
  if (!(room > 1) || !(track > 0)) return { overflow: false, atEnd: false, width: Math.max(0, track || 0), x: 0, progress: 0 };
  const progress = Math.min(1, Math.max(0, scrollLeft / room));
  const width = Math.min(track, Math.max(min, Math.round((track * clientWidth) / scrollWidth)));
  return { overflow: true, atEnd: scrollLeft >= room - 1, width, x: Math.round((track - width) * progress), progress };
}

function wire(cue) {
  const strip = cue.previousElementSibling;
  const bar = cue.firstElementChild;
  if (!strip || !bar) return;
  let queued = false;
  const update = () => {
    queued = false;
    const s = cueState({ scrollLeft: Math.abs(strip.scrollLeft), scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth, track: cue.clientWidth });
    cue.toggleAttribute("data-idle", !s.overflow);
    cue.toggleAttribute("data-end", s.atEnd);
    bar.style.width = `${s.width}px`;
    bar.style.transform = `translateX(${s.x}px)`;
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  strip.addEventListener("scroll", queue, { passive: true });
  if ("ResizeObserver" in window) new ResizeObserver(queue).observe(strip);
  update();
}

if (typeof document !== "undefined") for (const cue of document.querySelectorAll(".swipe-cue")) wire(cue);
