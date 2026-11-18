/**
 * Shared pacing for the autopilots (Journey and Loop).
 *
 * Keyframes are capped in size so very large or high-DPI screens don't
 * multiply the work (the compositor's 4× sampling hides the small upscale),
 * and the camera speed follows the rate keyframes are actually produced:
 * when rendering can't keep up, the zoom slows smoothly instead of racing
 * ahead and stopping.
 */
export const KEYFRAME_PIXELS = 4.2e6;

export function keyframeSize(w: number, h: number, scale: number): [number, number] {
  const W = w * scale;
  const H = h * scale;
  const k = Math.sqrt(Math.min(1, KEYFRAME_PIXELS / (W * H)));
  return [W * k, H * k];
}

export class Pacer {
  private rate = 0; // octaves the renderer can produce per second
  private lastFinished = 0;
  speed = 0;

  /**
   * A keyframe finished, extending what is ready by `span` octaves.
   * Only the time the renderer was actually busy counts: while it idles
   * waiting for the camera to catch up, production says nothing about
   * capacity (counting it made the speed shrink a little every keyframe).
   */
  produced(span: number, layer: { startedAt: number; finishedAt: number }) {
    if (span <= 0 || !layer.finishedAt) return;
    const busy = layer.finishedAt - Math.max(layer.startedAt, this.lastFinished);
    this.lastFinished = Math.max(this.lastFinished, layer.finishedAt);
    const r = span / Math.max(0.05, busy / 1000);
    this.rate = this.rate ? this.rate * 0.65 + r * 0.35 : r;
  }

  /** Speed to use this frame, given the requested speed and how far ahead frames are ready. */
  step(target: number, ahead: number, dt: number): number {
    const cap = this.rate ? Math.max(0.03, this.rate * 0.9) : target;
    const want = Math.min(target, cap);
    this.speed += (want - this.speed) * (1 - Math.exp(-dt / 1.2));
    return this.speed * smoothstep(0, 1, ahead);
  }
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
