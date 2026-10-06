// Bundled fonts (no network needed; the desktop app works offline)
import '@fontsource-variable/inter/wght.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './styles/app.css';
import { App } from './app';
import { Plot } from './ui/plot';

const root = document.getElementById('app');
const splash = document.getElementById('splash');
const splashVer = splash?.querySelector('.splash-ver');
if (splashVer) splashVer.textContent = `Version ${__APP_VERSION__}`;
if (root) {
  const app = new App(root);
  (window as unknown as { calApp: App }).calApp = app;
  // Graphs draw their labels on canvas: redraw once the bundled fonts are ready
  void document.fonts?.ready.then(() => {
    Plot.invalidateAll();
    for (const v of app.views) v.invalidate?.();
  });
}

// The splash shows the name for a moment (at least ~0.9 s from the start), then fades out; it never blocks input
if (splash) {
  const hide = () => {
    splash.classList.add('out');
    setTimeout(() => splash.remove(), 400);
  };
  setTimeout(hide, Math.max(0, 900 - performance.now()));
}
