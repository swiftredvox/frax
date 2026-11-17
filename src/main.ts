import './styles.css';
import { FraxApp } from './app/app';
import { applyState, decodeState } from './ui/share';
import { showFatal, UI } from './ui/ui';

function boot() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  let app: FraxApp;
  try {
    app = new FraxApp(canvas);
  } catch (e) {
    showFatal(e);
    return;
  }
  const state = decodeState(location.hash);
  applyState(app, state);
  new UI(app);
  // Pasting a Frax link into the address bar of an open tab only changes the hash.
  window.addEventListener('hashchange', () => applyState(app, decodeState(location.hash)));

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    showFatal(new Error('The graphics context was lost. Reload the page to continue.'));
  });

  if (import.meta.env.DEV) (window as unknown as { frax: FraxApp }).frax = app;
}

boot();
