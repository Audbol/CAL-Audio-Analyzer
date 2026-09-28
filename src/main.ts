import './styles/app.css';
import { App } from './app';

const root = document.getElementById('app');
if (root) {
  const app = new App(root);
  (window as unknown as { calApp: App }).calApp = app;
}
