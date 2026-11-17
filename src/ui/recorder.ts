/**
 * Canvas video recording. MediaRecorder on a WebGL canvas is dependable in
 * Chromium browsers and Safari; Firefox produces broken or empty files, so
 * the feature is hidden there.
 */
export function recordingMime(canvas: HTMLCanvasElement): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') return null;
  if (/firefox|fxios/i.test(navigator.userAgent)) return null;
  const types = [
    'video/mp4;codecs=avc1.640033',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const t of types) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  startedAt = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private mime: string,
  ) {}

  get active() {
    return this.rec !== null;
  }

  start() {
    const stream = this.canvas.captureStream(60);
    const px = this.canvas.width * this.canvas.height;
    this.chunks = [];
    this.rec = new MediaRecorder(stream, {
      mimeType: this.mime,
      videoBitsPerSecond: Math.round(Math.min(40e6, Math.max(8e6, px * 6))),
    });
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(1000);
    this.startedAt = performance.now();
  }

  stop(): Promise<{ blob: Blob; ext: string }> {
    return new Promise((resolve) => {
      const r = this.rec;
      if (!r) return;
      r.onstop = () => {
        const type = this.mime.split(';')[0];
        resolve({ blob: new Blob(this.chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' });
        this.chunks = [];
      };
      r.stop();
      r.stream.getTracks().forEach((t) => t.stop());
      this.rec = null;
    });
  }
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
