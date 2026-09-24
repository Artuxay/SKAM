// Интерфейс вложений: альбомы в ленте, карточки файлов, просмотрщик и окно отправки — как в Telegram.
import type { Attachment } from '../lib/database.types';
import { $, ICONS, button, closeDialog, el, html, openDialog, plural, timeLabel, toast } from '../lib/dom';
import {
  MAX_ALBUM, MAX_FILE, type Prepared, cachedUrl, fileExt, fmtDur, fmtSize, fullUrl, isVisual, prepareFiles,
  saveFile, thumbUrl,
} from './attach';
import { discardMessage, ts, type Msg } from './store';

const isVisualAtt = (a: Attachment) => a.kind === 'photo' || a.kind === 'video';

// ---------------------------------------------------------------------------
// Подписи для списка чатов
// ---------------------------------------------------------------------------

/** «🖼 Фото», «🎬 2 видео», «📎 отчёт.pdf», «🖼 Альбом». */
export function filesLabel(files: { kind?: unknown; name?: unknown }[]): string {
  const n = files.length;
  const photos = files.filter((f) => f.kind === 'photo').length;
  const videos = files.filter((f) => f.kind === 'video').length;
  if (photos === n) return n === 1 ? '🖼 Фото' : `🖼 ${n} фото`;
  if (videos === n) return n === 1 ? '🎬 Видео' : `🎬 ${n} видео`;
  if (photos + videos === 0) {
    const name = typeof files[0]?.name === 'string' ? files[0].name : 'Файл';
    return n === 1 ? `📎 ${name}` : `📎 ${plural(n, 'файл', 'файла', 'файлов')}`;
  }
  return `🖼 Альбом · ${plural(n, 'вложение', 'вложения', 'вложений')}`;
}

// ---------------------------------------------------------------------------
// Лента: альбом и файлы внутри пузыря
// ---------------------------------------------------------------------------

function ring(pct: number): HTMLElement {
  const r = el('span', 'ring');
  r.style.setProperty('--p', String(Math.max(0.02, Math.min(1, pct))));
  return r;
}

function setImg(img: HTMLImageElement, path: string, load: () => Promise<string>): void {
  img.dataset.path = path;
  const have = cachedUrl(path);
  if (have) { img.src = have; return; }
  img.classList.add('loading');
  load().then((url) => {
    document.querySelectorAll<HTMLImageElement>(`img[data-path="${CSS.escape(path)}"]`).forEach((x) => {
      x.src = url;
      x.classList.remove('loading');
    });
  }).catch(() => {
    document.querySelectorAll<HTMLImageElement>(`img[data-path="${CSS.escape(path)}"]`).forEach((x) => x.classList.add('broken'));
  });
}

function tile(m: Msg, a: Attachment, idx: number, single: boolean, onOpen: (i: number) => void): HTMLElement {
  const t = el('button', `tile-m ${a.kind}`);
  t.type = 'button';
  t.setAttribute('aria-label', a.kind === 'video' ? `Видео ${fmtDur(a.dur)}` : 'Фото');
  if (single && a.w && a.h) {
    // Одиночное фото — в своих пропорциях, но не выше 420 px и не уже 140 px.
    const ratio = Math.min(2.4, Math.max(0.42, a.w / a.h));
    t.style.aspectRatio = String(ratio);
    t.style.width = `min(100%, ${Math.round(Math.max(200, Math.min(400, 400 * Math.min(1, ratio * 1.05))))}px)`;
  }
  if (a.mini) t.style.backgroundImage = `url("${a.mini}")`;
  const local = m.local?.get(a.id);
  const img = el('img');
  img.alt = '';
  img.decoding = 'async';
  if (local) img.src = local;
  else if (a.path) setImg(img, a.thumb?.path ?? a.path, () => thumbUrl(a));
  t.append(img);
  if (a.kind === 'video') {
    const play = el('span', 'play');
    play.append(html(ICONS.play));
    t.append(play);
    if (a.dur) t.append(el('span', 'dur', fmtDur(a.dur)));
  }
  if (!m.pending && !m.failed) t.addEventListener('click', (ev) => { ev.stopPropagation(); onOpen(idx); });
  return t;
}

function docRow(m: Msg, a: Attachment): HTMLElement {
  const row = el('button', 'doc');
  row.type = 'button';
  const icon = el('span', 'doc-ic');
  icon.append(el('span', 'ext', fileExt(a.name)));
  const text = el('span', 'doc-text');
  const size = el('span', 'doc-size', fmtSize(a.size));
  text.append(el('span', 'doc-name', a.name), size);
  row.append(icon, text);
  row.title = `Скачать «${a.name}»`;
  if (m.pending || m.failed || !a.path) return row;
  row.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (row.classList.contains('busy')) return;
    row.classList.add('busy');
    icon.replaceChildren(ring(0));
    try {
      await saveFile(a, (loaded, total) => {
        const pct = total ? loaded / total : 0;
        icon.replaceChildren(ring(pct));
        size.textContent = `${fmtSize(loaded)} из ${fmtSize(total || a.size)}`;
      });
    } catch (e) {
      toast((e as Error).message || 'Не получилось скачать файл.');
    } finally {
      row.classList.remove('busy');
      icon.replaceChildren(el('span', 'ext', fileExt(a.name)));
      size.textContent = fmtSize(a.size);
    }
  });
  return row;
}

function uploadOverlay(m: Msg): HTMLElement {
  const o = el('div', 'up');
  o.dataset.up = m.id;
  const up = m.upload!;
  const pct = up.total ? up.loaded / up.total : 0;
  const cancel = button('up-x', null, (ev) => { ev.stopPropagation(); discardMessage(m); });
  cancel.setAttribute('aria-label', 'Отменить отправку');
  cancel.append(ring(pct), html(ICONS.close));
  o.append(cancel, el('span', 'up-t', up.total ? `${fmtSize(up.loaded)} из ${fmtSize(up.total)}` : 'Шифруем…'));
  return o;
}

/** Прогресс загрузки обновляем точечно, без перерисовки всей ленты. */
export function updateProgress(m: Msg): void {
  const up = m.upload;
  if (!up) return;
  document.querySelectorAll<HTMLElement>(`[data-up="${m.id}"]`).forEach((o) => {
    o.querySelector('.ring')?.replaceWith(ring(up.total ? up.loaded / up.total : 0));
    const t = o.querySelector('.up-t');
    if (t) t.textContent = `${fmtSize(up.loaded)} из ${fmtSize(up.total)}`;
  });
}

export function renderAttachments(m: Msg, files: Attachment[], authorName: string): HTMLElement {
  const box = el('div', 'atts');
  const visual = files.filter(isVisualAtt);
  const docs = files.filter((a) => !isVisualAtt(a));
  if (visual.length) {
    const n = visual.length;
    const album = el('div', `album n${Math.min(n, 10)}`);
    visual.forEach((a, i) => album.append(tile(m, a, i, n === 1, (idx) => openViewer(m, visual, idx, authorName))));
    if (m.pending && m.upload) album.append(uploadOverlay(m));
    box.append(album);
  }
  if (docs.length) {
    const list = el('div', 'docs');
    docs.forEach((a) => list.append(docRow(m, a)));
    if (m.pending && m.upload && !visual.length) list.append(uploadOverlay(m));
    box.append(list);
  }
  return box;
}

// ---------------------------------------------------------------------------
// Просмотрщик фото и видео
// ---------------------------------------------------------------------------

let view: { m: Msg; list: Attachment[]; i: number; author: string } | null = null;
let viewSeq = 0;

export function openViewer(m: Msg, list: Attachment[], i: number, author: string): void {
  view = { m, list, i, author };
  const dlg = $<HTMLDialogElement>('viewer');
  renderViewer();
  openDialog(dlg);
}

function step(d: number): void {
  if (!view || view.list.length < 2) return;
  view.i = (view.i + d + view.list.length) % view.list.length;
  renderViewer();
}

function renderViewer(): void {
  const dlg = $<HTMLDialogElement>('viewer');
  if (!view) return;
  const seq = ++viewSeq;
  const { m, list, i, author } = view;
  const a = list[i];

  const top = el('div', 'v-top');
  const who = el('div', 'v-who');
  who.append(el('b', null, author), el('span', null, `${timeLabel(ts(m.created_at))}${list.length > 1 ? ` · ${i + 1} из ${list.length}` : ''}`));
  const dl = button('v-btn', null, () => {
    saveFile(a).catch((e) => toast((e as Error).message || 'Не получилось скачать.'));
  });
  dl.setAttribute('aria-label', 'Скачать');
  dl.title = 'Скачать';
  dl.append(html(ICONS.download));
  const x = button('v-btn', null, () => closeDialog(dlg));
  x.setAttribute('aria-label', 'Закрыть');
  x.append(html(ICONS.close));
  top.append(who, dl, x);

  const stage = el('div', 'v-stage');
  stage.addEventListener('click', (ev) => { if (ev.target === stage) closeDialog(dlg); });
  const holder = el('div', 'v-media');
  // Пока грузится оригинал — показываем уменьшенную копию.
  const prev = cachedUrl(a.thumb?.path ?? '') ?? m.local?.get(a.id) ?? a.mini;
  if (prev) {
    const ph = el('img', 'v-ph');
    ph.src = prev;
    ph.alt = '';
    holder.append(ph);
  }
  const prog = el('div', 'v-prog');
  prog.append(ring(0), el('span', null, a.size ? fmtSize(a.size) : ''));
  holder.append(prog);
  stage.append(holder);
  if (list.length > 1) {
    const p = button('v-nav prev', null, (ev) => { ev.stopPropagation(); step(-1); });
    p.setAttribute('aria-label', 'Предыдущее');
    p.append(html(ICONS.prev));
    const n = button('v-nav next', null, (ev) => { ev.stopPropagation(); step(1); });
    n.setAttribute('aria-label', 'Следующее');
    n.append(html(ICONS.next));
    stage.append(p, n);
  }

  const caption = m.content?.text ? el('div', 'v-cap', m.content.text) : null;
  dlg.replaceChildren(top, stage, ...(caption ? [caption] : []));

  if (m.pending || !a.path) { prog.remove(); return; }
  fullUrl(a, (loaded, total) => {
    if (seq !== viewSeq) return;
    prog.querySelector('.ring')?.replaceWith(ring(total ? loaded / total : 0));
  }).then((url) => {
    if (seq !== viewSeq) return;
    let media: HTMLElement;
    if (a.kind === 'video') {
      const v = el('video');
      Object.assign(v, { src: url, controls: true, autoplay: true, playsInline: true });
      media = v;
    } else {
      const img = el('img');
      img.src = url;
      img.alt = a.name;
      media = img;
    }
    media.classList.add('v-full');
    holder.replaceChildren(media);
  }).catch((e) => {
    if (seq !== viewSeq) return;
    prog.replaceChildren(el('span', null, (e as Error).message || 'Не получилось загрузить.'));
  });
}

export function wireViewer(): () => void {
  const dlg = $<HTMLDialogElement>('viewer');
  const onKey = (e: KeyboardEvent) => {
    if (!dlg.open) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  };
  let sx = 0;
  const onTouchStart = (e: TouchEvent) => { sx = e.touches[0]?.clientX ?? 0; };
  const onTouchEnd = (e: TouchEvent) => {
    const dx = (e.changedTouches[0]?.clientX ?? 0) - sx;
    if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
  };
  const onClose = () => {
    viewSeq++;
    view = null;
    dlg.replaceChildren();
  };
  document.addEventListener('keydown', onKey);
  dlg.addEventListener('touchstart', onTouchStart, { passive: true });
  dlg.addEventListener('touchend', onTouchEnd);
  dlg.addEventListener('close', onClose);
  return () => {
    document.removeEventListener('keydown', onKey);
    dlg.removeEventListener('touchstart', onTouchStart);
    dlg.removeEventListener('touchend', onTouchEnd);
    dlg.removeEventListener('close', onClose);
  };
}

// ---------------------------------------------------------------------------
// Окно отправки: предпросмотр, «Сжать фото», подпись
// ---------------------------------------------------------------------------

type SendCtx = { caption: string; send: (caption: string, prepared: Prepared[]) => void; onCancel: (caption: string) => void };
let draft: { files: File[]; urls: Map<File, string>; compress: boolean; ctx: SendCtx } | null = null;

export function openSendDialog(files: File[], ctx: SendCtx): void {
  const ok: File[] = [];
  const big: string[] = [];
  for (const f of files) {
    if (f.size > MAX_FILE) big.push(f.name);
    else if (f.size === 0) big.push(f.name);
    else ok.push(f);
  }
  if (big.length) {
    toast(big.length === 1 ? `«${big[0]}» не отправить: файл пустой или больше 50 МБ.` : `${plural(big.length, 'файл', 'файла', 'файлов')} не отправить: пустые или больше 50 МБ.`);
  }
  if (!ok.length) return;
  if (draft) {
    draft.files.push(...ok);
  } else {
    // Новое окно: от прошлого не должно остаться ни подписи, ни превью.
    $<HTMLDialogElement>('mediaDlg').replaceChildren();
    draft = { files: ok, urls: new Map(), compress: true, ctx };
  }
  renderSendDialog();
  openDialog($<HTMLDialogElement>('mediaDlg'));
  ($('mediaCaption') as HTMLTextAreaElement | null)?.focus();
}

function previewUrl(f: File): string {
  let u = draft!.urls.get(f);
  if (!u) { u = URL.createObjectURL(f); draft!.urls.set(f, u); }
  return u;
}

function sendTitle(files: File[], compress: boolean): string {
  const n = files.length;
  if (compress) {
    const img = files.filter((f) => f.type.startsWith('image/') && f.type !== 'image/svg+xml').length;
    const vid = files.filter((f) => f.type.startsWith('video/')).length;
    if (img === n) return n === 1 ? 'Отправить фото' : `Отправить ${n} фото`;
    if (vid === n) return n === 1 ? 'Отправить видео' : `Отправить ${n} видео`;
    if (img + vid === n) return `Отправить альбом · ${n}`;
  }
  return n === 1 ? 'Отправить файл' : `Отправить ${plural(n, 'файл', 'файла', 'файлов')}`;
}

function renderSendDialog(): void {
  const dlg = $<HTMLDialogElement>('mediaDlg');
  if (!draft) return;
  const d = draft;
  const typed = (document.getElementById('mediaCaption') as HTMLTextAreaElement | null)?.value;
  const anyVisual = d.files.some(isVisual);

  const head = el('div', 'dlg-head');
  head.append(el('h2', null, sendTitle(d.files, d.compress && anyVisual)));
  const x = button('icon-btn', null, () => cancel());
  x.setAttribute('aria-label', 'Закрыть');
  x.append(html(ICONS.close));
  head.append(x);

  const grid = el('div', 'send-grid');
  d.files.forEach((f, i) => {
    const item = el('div', `send-item${d.compress && isVisual(f) ? ' visual' : ''}`);
    if (d.compress && isVisual(f)) {
      if (f.type.startsWith('video/')) {
        const v = el('video');
        Object.assign(v, { src: previewUrl(f), muted: true, preload: 'metadata', playsInline: true });
        item.append(v, el('span', 'badge-v', 'видео'));
      } else {
        const img = el('img');
        img.src = previewUrl(f);
        img.alt = '';
        item.append(img);
      }
    } else {
      const ic = el('span', 'doc-ic');
      ic.append(el('span', 'ext', fileExt(f.name)));
      const t = el('span', 'doc-text');
      t.append(el('span', 'doc-name', f.name), el('span', 'doc-size', fmtSize(f.size)));
      item.append(ic, t);
    }
    const rm = button('send-rm', null, () => {
      const u = d.urls.get(f);
      if (u) URL.revokeObjectURL(u);
      d.urls.delete(f);
      d.files.splice(i, 1);
      if (!d.files.length) { cancel(); return; }
      renderSendDialog();
    });
    rm.setAttribute('aria-label', `Убрать ${f.name}`);
    rm.append(html(ICONS.close));
    item.append(rm);
    grid.append(item);
  });

  const stack = el('div', 'stack');
  stack.append(grid);
  if (anyVisual) {
    const lbl = el('label', 'check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = d.compress;
    cb.addEventListener('change', () => { d.compress = cb.checked; renderSendDialog(); });
    lbl.append(cb, el('span', null, 'Сжать фото и видео'));
    const hint = el('p', 'hint', d.compress
      ? 'Фото уменьшатся до 2048 px, а данные вроде геометки сотрутся. Снимите галочку, чтобы отправить оригиналы файлами.'
      : 'Файлы уйдут как есть, в исходном качестве.');
    hint.style.margin = '2px 0 0';
    const wrap = el('div');
    wrap.append(lbl, hint);
    stack.append(wrap);
  }
  if (d.files.length > MAX_ALBUM) {
    stack.append(el('p', 'hint', `В одном сообщении до ${MAX_ALBUM} вложений — отправим ${plural(Math.ceil(d.files.length / MAX_ALBUM), 'сообщением', 'сообщениями', 'сообщениями')}.`));
  }
  const cap = el('textarea', 'txt caption');
  Object.assign(cap, { id: 'mediaCaption', rows: 2, maxLength: 4000, placeholder: 'Подпись', value: typed ?? d.ctx.caption });
  cap.setAttribute('aria-label', 'Подпись');
  cap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); }
  });
  stack.append(cap);
  stack.append(el('p', 'hint e2e-hint', '🔒 В личных чатах и группах файлы шифруются на этом устройстве.'));

  const actions = el('div', 'dlg-actions');
  const add = button('btn ghost', 'Добавить', () => $<HTMLInputElement>('fileInput').click());
  add.style.marginRight = 'auto';
  const go = button('btn primary', 'Отправить', () => void submit());
  go.id = 'mediaSend';
  actions.append(add, button('btn ghost', 'Отмена', () => cancel()), go);
  dlg.replaceChildren(head, stack, actions);
}

function cleanup(): void {
  draft?.urls.forEach((u) => URL.revokeObjectURL(u));
  draft = null;
  document.getElementById('mediaDlg')?.replaceChildren();
}

function cancel(): void {
  const cap = (document.getElementById('mediaCaption') as HTMLTextAreaElement | null)?.value ?? '';
  const ctx = draft?.ctx;
  cleanup();
  closeDialog($<HTMLDialogElement>('mediaDlg'));
  ctx?.onCancel(cap);
}

async function submit(): Promise<void> {
  if (!draft) return;
  const d = draft;
  const go = $<HTMLButtonElement>('mediaSend');
  if (go.disabled) return;
  const caption = ($('mediaCaption') as HTMLTextAreaElement).value.trim();
  go.disabled = true;
  go.textContent = 'Готовим…';
  let prepared: Prepared[];
  try {
    prepared = await prepareFiles(d.files, d.compress);
  } catch {
    toast('Не получилось подготовить файлы.');
    go.disabled = false;
    go.textContent = 'Отправить';
    return;
  }
  const ctx = d.ctx;
  cleanup();
  closeDialog($<HTMLDialogElement>('mediaDlg'));
  ctx.send(caption, prepared);
}

export function wireSendDialog(): () => void {
  const dlg = $<HTMLDialogElement>('mediaDlg');
  const onCancel = (e: Event) => { e.preventDefault(); cancel(); };
  const onClick = (e: MouseEvent) => { if (e.target === dlg) cancel(); };
  dlg.addEventListener('cancel', onCancel);
  dlg.addEventListener('click', onClick);
  return () => {
    dlg.removeEventListener('cancel', onCancel);
    dlg.removeEventListener('click', onClick);
    cleanup();
  };
}

export function sendDialogOpen(): boolean {
  return !!draft;
}
