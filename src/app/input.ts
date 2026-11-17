/**
 * Pointer, wheel, touch and keyboard handling for the canvas. Reports
 * gestures in view-relative units (fractions of the view width, y up).
 */
export interface InputHandlers {
  zoom(ax: number, ay: number, dlog2: number, smooth: boolean): void;
  pan(dx: number, dy: number): void;
  panEnd(vx: number, vy: number): void;
  tap(ax: number, ay: number): void;
  hover(ax: number, ay: number): void;
  interact(): void;
}

export function attachInput(el: HTMLElement, h: InputHandlers) {
  const rel = (cx: number, cy: number) => {
    const r = el.getBoundingClientRect();
    return [(cx - r.left) / r.width - 0.5, -((cy - r.top) / r.width - (0.5 * r.height) / r.width)] as const;
  };

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      h.interact();
      const [ax, ay] = rel(e.clientX, e.clientY);
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 32;
      else if (e.deltaMode === 2) dy *= 400;
      // Trackpad pinch arrives as ctrl+wheel with small deltas.
      const k = e.ctrlKey ? 0.012 : 0.0022;
      h.zoom(ax, ay, Math.max(-2, Math.min(2, dy * k)), !e.ctrlKey);
    },
    { passive: false },
  );

  const pts = new Map<number, { x: number; y: number }>();
  let last: { x: number; y: number; t: number } | null = null;
  let vel = { x: 0, y: 0 };
  let downAt = { x: 0, y: 0, t: 0 };
  let moved = false;
  let pinchD = 0;

  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    h.interact();
    if (pts.size === 1) {
      last = { x: e.clientX, y: e.clientY, t: performance.now() };
      downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      moved = false;
      vel = { x: 0, y: 0 };
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinchD = Math.hypot(a.x - b.x, a.y - b.y);
      moved = true;
    }
  });

  el.addEventListener('pointermove', (e) => {
    const [ax, ay] = rel(e.clientX, e.clientY);
    if (!pts.has(e.pointerId)) {
      if (e.pointerType === 'mouse') h.hover(ax, ay);
      return;
    }
    const prev = pts.get(e.pointerId)!;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = el.getBoundingClientRect();
    if (pts.size === 1) {
      const dx = (e.clientX - prev.x) / r.width;
      const dy = (e.clientY - prev.y) / r.width;
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) moved = true;
      if (moved) {
        h.pan(-dx, dy);
        const now = performance.now();
        if (last) {
          const dt = Math.max(1, now - last.t);
          vel = { x: vel.x * 0.6 + (-dx / dt) * 0.4 * 1000, y: vel.y * 0.6 + (dy / dt) * 0.4 * 1000 };
        }
        last = { x: e.clientX, y: e.clientY, t: now };
      }
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const pmx = mx - (e.clientX - prev.x) / 2;
      const pmy = my - (e.clientY - prev.y) / 2;
      h.pan(-(mx - pmx) / r.width, (my - pmy) / r.width);
      if (pinchD > 0 && d > 0) {
        const [ax2, ay2] = rel(mx, my);
        h.zoom(ax2, ay2, -Math.log2(d / pinchD), false);
      }
      pinchD = d;
    }
  });

  const up = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size === 0) {
      const now = performance.now();
      if (!moved && now - downAt.t < 300) {
        const [ax, ay] = rel(e.clientX, e.clientY);
        h.tap(ax, ay);
      } else if (last && now - last.t < 80) {
        h.panEnd(vel.x, vel.y);
      }
      last = null;
    } else if (pts.size === 1) {
      const [p] = [...pts.values()];
      last = { x: p.x, y: p.y, t: performance.now() };
    }
    pinchD = 0;
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);

  el.addEventListener('dblclick', (e) => {
    const [ax, ay] = rel(e.clientX, e.clientY);
    h.interact();
    h.zoom(ax, ay, e.shiftKey ? 1.5 : -1.5, true);
  });
}
