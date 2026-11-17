import { DEFAULT_SETTINGS, type FraxApp, type Settings } from '../app/app';
import { magnification } from '../app/camera';
import { FRACTALS } from '../app/fractals';
import { fromDecimal, toDecimal } from '../core/hp';
import { PALETTES, paletteCss } from '../engine/palettes';
import { hydrateIcons, icon } from './icons';
import { download, Recorder, recordingMime } from './recorder';
import { encodeState } from './share';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const JULIA_PRESETS: [string, number, number][] = [
  ['Spiral', -0.7746806106269039, -0.1374168856037867],
  ['Rabbit', -0.123, 0.745],
  ['Dendrite', 0, 1],
  ['San Marco', -0.75, 0.0],
  ['Siegel', -0.390540870218399, -0.586787907346969],
  ['Lightning', -0.8, 0.156],
  ['Galaxy', 0.285, 0.01],
];

export class UI {
  private toastTimer = 0;
  private idleTimer = 0;
  private hashTimer = 0;
  private recorder: Recorder | null = null;
  private hintGone = false;

  constructor(private app: FraxApp) {
    hydrateIcons();
    this.buildFractals();
    this.buildPalettes();
    this.buildJuliaPresets();
    this.bindDock();
    this.bindPanel();
    this.bindKeys();
    this.bindIdle();

    app.onChange(() => this.sync());
    app.onView(() => this.onView());
    this.sync();
    this.onView();
    setInterval(() => this.updateStatus(), 200);

    if (matchMedia('(pointer: coarse)').matches) {
      document.querySelector('.hint-body')!.innerHTML = 'Tap <b>Journey</b> to start an endless, hands-free zoom.<br />Pinch to zoom, drag to look around.';
    }
    try {
      if (localStorage.getItem('frax.hint') === '1') this.dismissHint();
    } catch {
      /* storage unavailable */
    }
  }

  // ------------------------------------------------------------ building

  private buildFractals() {
    const box = $('fractals');
    box.setAttribute('role', 'radiogroup');
    for (const f of FRACTALS) {
      const b = document.createElement('button');
      b.className = 'fcard';
      b.setAttribute('role', 'radio');
      b.dataset.id = f.id;
      b.title = f.blurb;
      b.innerHTML = `<b>${f.name}</b><span>${f.formulaTex}</span>`;
      b.onclick = () => this.app.set('formula', f.id);
      box.appendChild(b);
    }
  }

  private buildPalettes() {
    const box = $('palettes');
    box.setAttribute('role', 'radiogroup');
    for (const p of PALETTES) {
      const b = document.createElement('button');
      b.className = 'pal';
      b.setAttribute('role', 'radio');
      b.dataset.id = p.id;
      b.title = p.name;
      b.innerHTML = `<i style="background:${paletteCss(p)}"></i><span>${p.name}</span>`;
      b.onclick = () => this.app.set('palette', p.id);
      box.appendChild(b);
    }
  }

  private buildJuliaPresets() {
    const box = $('juliaPresets');
    for (const [name, x, y] of JULIA_PRESETS) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = name;
      b.onclick = () => {
        this.app.setJulia(x, y);
        this.app.home();
      };
      box.appendChild(b);
    }
    const commit = () => {
      try {
        const x = fromDecimal(($('juliaRe') as HTMLInputElement).value, 80);
        const y = fromDecimal(($('juliaIm') as HTMLInputElement).value, 80);
        this.app.setJulia(x, y);
      } catch {
        this.toast('That doesn’t look like a number');
        this.sync();
      }
    };
    for (const id of ['juliaRe', 'juliaIm']) {
      const el = $<HTMLInputElement>(id);
      el.addEventListener('change', commit);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') el.blur();
        e.stopPropagation();
      });
    }
    $('btnPickJulia').onclick = () => {
      const v = this.app.view;
      this.app.setJulia(v.cx, v.cy);
      this.app.set('formula', 'julia');
      this.toast('Julia set for c at the centre of the view');
    };
  }

  // ------------------------------------------------------------ dock

  private bindDock() {
    const app = this.app;
    $('btnJourney').onclick = () => {
      app.toggleJourney();
      this.dismissHint();
    };
    const speed = $<HTMLInputElement>('speed');
    speed.oninput = () => app.set('speed', parseFloat(speed.value));
    $('btnHome').onclick = () => app.home();
    $('btnShot').onclick = () => this.screenshot();
    $('btnShare').onclick = () => this.share();
    $('btnFull').onclick = () => this.fullscreen();
    $('btnPanel').onclick = () => this.togglePanel();
    $('btnClose').onclick = () => this.togglePanel(false);
    document.addEventListener('fullscreenchange', () => {
      $('btnFull').innerHTML = icon(document.fullscreenElement ? 'shrink' : 'expand');
    });

    const mime = recordingMime(app.canvas);
    const rec = $('btnRec');
    if (mime) {
      rec.hidden = false;
      this.recorder = new Recorder(app.canvas, mime);
      rec.onclick = () => this.toggleRecording();
    }
  }

  private bindPanel() {
    const app = this.app;
    const slider = (id: keyof Settings) => {
      const el = $<HTMLInputElement>(id);
      el.oninput = () => app.set(id, parseFloat(el.value) as never);
    };
    slider('density');
    slider('cycle');
    slider('shade');
    // Double-click a slider to put it back to its default.
    for (const id of ['density', 'cycle', 'shade'] as const) {
      $(id).addEventListener('dblclick', () => app.set(id, DEFAULT_SETTINGS[id]));
    }
    $('btnResetColour').onclick = () => {
      app.set('density', DEFAULT_SETTINGS.density);
      app.set('cycle', DEFAULT_SETTINGS.cycle);
      app.set('shade', DEFAULT_SETTINGS.shade);
      this.toast('Colour settings reset');
    };
    $('quality')
      .querySelectorAll<HTMLButtonElement>('button')
      .forEach((b) => {
        b.setAttribute('role', 'radio');
        b.onclick = () => app.set('quality', parseFloat(b.dataset.v!));
      });
  }

  private bindKeys() {
    const app = this.app;
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === ' ') {
        e.preventDefault();
        app.toggleJourney();
        this.dismissHint();
      } else if (k === 'h' || k === 'H') app.home();
      else if (k === 's' || k === 'S') this.screenshot();
      else if (k === 'f' || k === 'F') this.fullscreen();
      else if ((k === 'r' || k === 'R') && this.recorder) this.toggleRecording();
      else if (k === '[' || k === ']') {
        const i = PALETTES.findIndex((p) => p.id === app.settings.palette);
        const n = PALETTES.length;
        app.set('palette', PALETTES[(i + (k === ']' ? 1 : -1) + n) % n].id);
        this.toast(app.palette.name);
      } else if (k === 'Tab') {
        e.preventDefault();
        this.togglePanel();
      } else if (k === 'Escape') this.togglePanel(false);
      else if (k === '+' || k === '=') app.zoomBy(0, 0, -1);
      else if (k === '-' || k === '_') app.zoomBy(0, 0, 1);
      else return;
      this.wake();
    });
  }

  private bindIdle() {
    const wake = () => this.wake();
    window.addEventListener('pointermove', wake, { passive: true });
    window.addEventListener('pointerdown', wake, { passive: true });
    window.addEventListener('wheel', wake, { passive: true });
    window.addEventListener('pointerdown', () => this.dismissHint(), { passive: true });
    window.addEventListener('wheel', () => this.dismissHint(), { passive: true });
  }

  private wake() {
    document.body.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      // Only fade the interface away while watching a journey.
      if (this.app.isJourney && $('panel').hidden) document.body.classList.add('idle');
    }, 2800);
  }

  // ------------------------------------------------------------ state → DOM

  private sync() {
    const s = this.app.settings;
    const j = this.app.isJourney;
    const jb = $('btnJourney');
    jb.setAttribute('aria-pressed', String(j));
    jb.querySelector('.journey-label')!.textContent = j ? 'Pause' : 'Journey';
    if (j) this.wake();
    else if (this.wasJourney) {
      document.body.classList.remove('idle');
      this.onView();
    }
    this.wasJourney = j;

    const speed = $<HTMLInputElement>('speed');
    speed.value = String(s.speed);
    $('speedVal').textContent = `${s.speed.toFixed(2)}×`;
    this.fill(speed);

    for (const id of ['density', 'cycle', 'shade'] as const) {
      const el = $<HTMLInputElement>(id);
      if (document.activeElement !== el) el.value = String(s[id]);
      this.fill(el);
    }
    $('fractals')
      .querySelectorAll<HTMLElement>('.fcard')
      .forEach((b) => b.setAttribute('aria-checked', String(b.dataset.id === s.formula)));
    $('palettes')
      .querySelectorAll<HTMLElement>('.pal')
      .forEach((b) => b.setAttribute('aria-checked', String(b.dataset.id === s.palette)));
    $('quality')
      .querySelectorAll<HTMLElement>('button')
      .forEach((b) => b.setAttribute('aria-checked', String(parseFloat(b.dataset.v!) === s.quality)));

    const isJulia = s.formula === 'julia';
    $('juliaBox').hidden = !isJulia;
    $('btnPickJulia').hidden = s.formula !== 'mandelbrot';
    if (isJulia) {
      const re = $<HTMLInputElement>('juliaRe');
      const im = $<HTMLInputElement>('juliaIm');
      if (document.activeElement !== re) re.value = toDecimal(this.app.julia.x, 12);
      if (document.activeElement !== im) im.value = toDecimal(this.app.julia.y, 12);
    }
  }

  private fill(el: HTMLInputElement) {
    const min = parseFloat(el.min);
    const max = parseFloat(el.max);
    el.style.setProperty('--p', `${((parseFloat(el.value) - min) / (max - min)) * 100}%`);
  }

  private lastDepthText = '';
  private onView() {
    const v = this.app.view;
    const m = magnification(v.log2w, this.app.homeLog2w);
    const html = m.exp ? `${m.mant}<span class="depth-e"> × 10<sup>${m.exp}</sup></span>` : m.plain.replace('×', '');
    if (html !== this.lastDepthText) {
      this.lastDepthText = html;
      $('depthM').innerHTML = html;
    }
    if (!this.app.isJourney) {
      clearTimeout(this.hashTimer);
      this.hashTimer = window.setTimeout(() => history.replaceState(null, '', encodeState(this.app)), 700);
    }
  }
  private wasJourney = false;

  private updateStatus() {
    const st = this.app.status;
    const el = $('status');
    const deep = -this.app.view.log2w > 40;
    let text = '';
    if (this.app.isJourney && st.stalled) text = 'Rendering ahead…';
    else if (!this.app.isJourney && st.rendering) text = st.orbit && deep ? 'Computing reference orbit…' : 'Rendering…';
    el.classList.toggle('on', !!text);
    if (text) el.title = text;
    if (this.recorder?.active) {
      const s = Math.floor((performance.now() - this.recorder.startedAt) / 1000);
      $('btnRec').title = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} — click to stop`;
    }
  }

  // ------------------------------------------------------------ actions

  togglePanel(force?: boolean) {
    const p = $('panel');
    const open = force ?? p.hidden === true;
    p.hidden = !open;
    $('btnPanel').setAttribute('aria-expanded', String(open));
    $('btnPanel').classList.toggle('on', open);
  }

  private dismissHint() {
    if (this.hintGone) return;
    this.hintGone = true;
    $('hint').classList.add('gone');
    try {
      localStorage.setItem('frax.hint', '1');
    } catch {
      /* ignore */
    }
  }

  private fileStem() {
    const m = magnification(this.app.view.log2w, this.app.homeLog2w);
    const z = m.exp ? `1e${m.exp}` : m.plain.replace(/[×,]/g, '');
    return `frax-${this.app.settings.formula}-${z}`;
  }

  screenshot() {
    this.app.capture((c) => {
      c.toBlob((b) => {
        if (!b) return this.toast('Couldn’t capture the image');
        download(b, `${this.fileStem()}.png`);
        this.toast('Image saved');
      }, 'image/png');
    });
  }

  private async toggleRecording() {
    const r = this.recorder!;
    const btn = $('btnRec');
    if (r.active) {
      btn.classList.remove('on');
      const { blob, ext } = await r.stop();
      download(blob, `${this.fileStem()}.${ext}`);
      this.toast('Video saved');
    } else {
      r.start();
      btn.classList.add('on');
      this.toast('Recording — press R or the button again to stop');
    }
  }

  private share() {
    const url = location.origin + location.pathname + encodeState(this.app);
    history.replaceState(null, '', encodeState(this.app));
    this.copy(url, 'Link copied — it opens right here');
  }

  private copy(text: string, msg: string) {
    navigator.clipboard?.writeText(text).then(
      () => this.toast(msg),
      () => this.toast('Copy failed — your browser blocked the clipboard'),
    );
  }

  private fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => this.toast('Full screen isn’t available here'));
  }

  toast(msg: string) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), 2200);
  }
}

export function showFatal(err: unknown) {
  const el = $('error');
  el.hidden = false;
  const msg = err instanceof Error ? err.message : String(err);
  el.innerHTML = `<div><b>Frax can’t start here</b>${escapeHtml(msg)}<br/><br/>Frax needs a browser with WebGL2 and float render targets — recent Chrome, Edge, Firefox or Safari.</div>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
