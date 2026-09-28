import type { App } from '../app';
import { AUDIO_ACCEPT, type PlaylistApi, type RepeatMode } from '../audio/playlist';
import { h, icon } from './dom';
import { modal } from './dialogs';

export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

function pickFiles(pl: PlaylistApi): void {
  const input = h('input', { type: 'file', accept: AUDIO_ACCEPT, multiple: true, style: 'display:none' });
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    if (files.length) pl.addFiles(files);
    input.remove();
  });
  document.body.append(input);
  input.click();
}

/** Compact player in the generator bar: previous / next, the current song and its position. */
export class MusicControls {
  readonly el = h('div', { class: 'music-ctl' });
  private title = h('button', { class: 'music-title', title: 'Playlist', onclick: () => showPlaylist(this.app) });
  private time = h('span', { class: 'music-time' });

  constructor(private app: App) {
    const pl = app.playlist;
    this.el.append(
      h('button', { class: 'btn icon-btn small', title: 'Previous song', onclick: () => pl.act({ action: 'prev' }) }, icon('skipBack', 15)),
      h('button', { class: 'btn icon-btn small', title: 'Next song', onclick: () => pl.act({ action: 'next' }) }, icon('skipFwd', 15)),
      this.title,
      this.time,
      h('button', { class: 'btn icon-btn small', title: 'Playlist', onclick: () => showPlaylist(this.app) }, icon('list', 15)),
    );
    this.update();
  }

  update(): void {
    const st = this.app.playlist.state();
    const cur = st.tracks.find((t) => t.id === st.current);
    const text = st.loading ? 'Loading…' : cur ? cur.name : st.tracks.length ? 'Choose a song' : 'Add songs…';
    if (this.title.textContent !== text) this.title.textContent = text;
    this.title.classList.toggle('empty', !cur);
    const t = cur ? `${fmtTime(st.pos)} / ${fmtTime(cur.duration)}` : '';
    if (this.time.textContent !== t) this.time.textContent = t;
  }
}

/** Playlist window: add (or drop) song files, choose, reorder and remove them, repeat and shuffle. */
export function showPlaylist(app: App): void {
  const pl = app.playlist;
  const list = h('div', { class: 'pl-list' });
  const now = h('div', { class: 'pl-now' });
  const seek = h('input', { type: 'range', min: '0', max: '1', step: '0.1', value: '0', class: 'pl-seek', title: 'Position' });
  let seeking = false;
  seek.addEventListener('input', () => (seeking = true));
  seek.addEventListener('change', () => {
    seeking = false;
    pl.act({ action: 'seek', pos: +seek.value });
  });
  const repeatBtn = h('button', { class: 'btn small', title: 'Repeat' });
  const shuffleBtn = h('button', { class: 'btn small', title: 'Shuffle' }, icon('shuffle', 14), 'Shuffle');
  const note = h('p', { class: 'dim small' });
  const drop = h(
    'div',
    { class: 'pl-drop' },
    h('div', {}, icon('music', 18), h('span', {}, 'Drop MP3, WAV, FLAC, OGG or M4A files here, or ')),
    h('button', { class: 'btn small accent', onclick: () => pickFiles(pl) }, icon('plus', 14), 'Add songs…'),
  );
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) pl.addFiles(files);
  });
  const genBtn = h('button', { class: 'btn small', onclick: () => {
    const g = app.settings.generator;
    if (g.type === 'music') app.toggleGenerator();
    else app.setGenerator({ type: 'music' });
    app.renderGenControls();
    render();
  } });

  const body = h(
    'div',
    { class: 'playlist' },
    h('p', { class: 'dim small' }, 'Play music through the generator output. The music is also the reference for the transfer function, so you can measure the system with a song playing (use pink noise for the most reliable coherence). Songs are level-matched: the generator level sets their average level like the noise signals.'),
    now,
    h('div', { class: 'pl-bar' }, genBtn, h('button', { class: 'btn small', onclick: () => pl.act({ action: 'prev' }) }, icon('skipBack', 14)), h('button', { class: 'btn small', onclick: () => pl.act({ action: 'next' }) }, icon('skipFwd', 14)), seek, repeatBtn, shuffleBtn),
    list,
    drop,
    note,
  );
  const { close, el } = modal('Music playlist', body);
  el.classList.add('pl-modal');

  const repeatModes: RepeatMode[] = ['all', 'one', 'off'];
  repeatBtn.addEventListener('click', () => {
    const cur = pl.state().repeat;
    pl.act({ action: 'repeat', mode: repeatModes[(repeatModes.indexOf(cur) + 1) % 3] });
  });
  shuffleBtn.addEventListener('click', () => pl.act({ action: 'shuffle', on: !pl.state().shuffle }));

  let lastList = '';
  const render = () => {
    if (!el.isConnected) return;
    const st = pl.state();
    const g = app.settings.generator;
    const playing = g.type === 'music';
    genBtn.replaceChildren(icon(playing ? 'pause' : 'play', 14), playing ? 'Stop music' : 'Play music');
    genBtn.classList.toggle('accent', !playing);
    const cur = st.tracks.find((t) => t.id === st.current);
    now.replaceChildren(
      h('b', {}, cur ? cur.name : 'No song selected'),
      h('span', { class: 'dim' }, cur ? ` · ${fmtTime(st.pos)} / ${fmtTime(cur.duration)}${st.loading ? ' · loading…' : ''}` : ''),
    );
    seek.max = String(Math.max(1, cur?.duration ?? 1));
    if (!seeking) seek.value = String(st.pos);
    seek.disabled = !cur;
    repeatBtn.replaceChildren(icon('repeat', 14), st.repeat === 'all' ? 'Repeat all' : st.repeat === 'one' ? 'Repeat one' : 'No repeat');
    repeatBtn.classList.toggle('on', st.repeat !== 'off');
    shuffleBtn.classList.toggle('on', st.shuffle);
    const uploading = 'uploading' in pl ? (pl as { uploading: number }).uploading : 0;
    note.textContent = st.error || (uploading ? `Sending ${uploading} song${uploading > 1 ? 's' : ''} to the measurement host…` : app.remote ? 'Songs are stored and played on the measurement host.' : 'Songs are stored on this computer and stay in the playlist.');
    note.classList.toggle('warn-text', !!st.error);
    // Rebuild the list only when it changed (keeps hover and focus while the position updates)
    const key = JSON.stringify([st.tracks, st.current]);
    if (key === lastList) return;
    lastList = key;
    list.replaceChildren(
      ...st.tracks.map((t, i) =>
        h(
          'div',
          { class: `pl-row${t.id === st.current ? ' cur' : ''}`, dataset: { id: t.id } },
          h('button', { class: 'pl-name', title: 'Play this song', onclick: () => {
            pl.act({ action: 'select', id: t.id });
            if (app.settings.generator.type !== 'music') {
              app.setGenerator({ type: 'music' });
              app.renderGenControls();
            }
          } }, h('span', { class: 'pl-idx' }, t.id === st.current ? icon('music', 13) : String(i + 1)), h('span', {}, t.name)),
          h('span', { class: 'dim small' }, t.duration ? fmtTime(t.duration) : ''),
          h('button', { class: 'btn tiny ghost', title: 'Move up', disabled: i === 0, onclick: () => pl.act({ action: 'move', id: t.id, to: i - 1 }) }, icon('up', 13)),
          h('button', { class: 'btn tiny ghost', title: 'Move down', disabled: i === st.tracks.length - 1, onclick: () => pl.act({ action: 'move', id: t.id, to: i + 1 }) }, icon('down', 13)),
          h('button', { class: 'btn tiny ghost', title: 'Remove', onclick: () => pl.act({ action: 'remove', id: t.id }) }, icon('trash', 13)),
        ),
      ),
    );
    if (!st.tracks.length) list.append(h('div', { class: 'empty' }, 'The playlist is empty.'));
  };
  const unsubscribe = pl.onChange(render);
  const timer = window.setInterval(() => {
    if (el.isConnected) return render();
    clearInterval(timer);
    unsubscribe();
  }, 500);
  render();
  void close;
}
