/**
 * A window of the app's own (a popped-out panel, the EQ board): emptied first (a window of that name may be left
 * over from before, e.g. after a reload), the app's styles brought along, and the main window's colour scheme
 * followed for as long as the window is open.
 */
export function prepareAppWindow(win: Window, title: string): void {
  const doc = win.document;
  doc.head.replaceChildren();
  doc.body.replaceChildren();
  doc.title = title;
  // The app's styles (inline <style> in development, <link> in production builds)
  for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
    if (node instanceof HTMLLinkElement) {
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = node.href;
      doc.head.append(link);
    } else doc.head.append(doc.importNode(node, true));
  }
  const meta = doc.createElement('meta');
  meta.name = 'color-scheme';
  meta.content = 'dark';
  doc.head.append(meta);
  // Day / night, and a custom theme's colours (properties on the root element)
  const syncTheme = () => {
    const t = document.documentElement.dataset.theme;
    if (t) doc.documentElement.dataset.theme = t;
    else delete doc.documentElement.dataset.theme;
    const style = document.documentElement.getAttribute('style');
    if (style) doc.documentElement.setAttribute('style', style);
    else doc.documentElement.removeAttribute('style');
  };
  syncTheme();
  const obs = new MutationObserver(syncTheme);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  win.addEventListener('pagehide', () => obs.disconnect());
}
