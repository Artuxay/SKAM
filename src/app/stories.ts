// Истории в интерфейсе: лента кружков над списком чатов, просмотр, публикация, кто смотрел, истории в профиле.
import { $, ICONS, button, closeDialog, el, errText, html, openDialog, plural, toast } from '../lib/dom';
import type { Story } from '../lib/database.types';
import {
  ST, STORY_BGS, STORY_CAPTION_MAX, STORY_SHOW_MS, STORY_TEXT_MAX, StoryError, type StoryAuthor, type StoryFile,
  cachedStoryUrl, deleteStory, likeStory, loadStoryFeed, markSeen, pinStory, prepareStoryFile, publishStory,
  releaseStoryFile, storyAge, storyState, storyUrl, storyViewers, userStories,
} from '../lib/stories';

type Env = {
  me: () => string;
  /** Имя (с ником) и короткое имя для подписи под кружком. */
  name: (uid: string) => string;
  short: (uid: string) => string;
  avatar: (uid: string, cls?: string) => HTMLElement;
  verified: (uid: string) => boolean;
  /** Запомнить профили авторов из ленты (имя, фото, галочка). */
  remember: (list: StoryAuthor[]) => void;
  searching: () => boolean;
  /** Перерисовать то, где видны кольца историй (список, шапка, профиль). */
  changed: () => void;
};
let env: Env;

export function mountStories(e: Env): () => void {
  env = e;
  const onVis = () => { if (document.visibilityState === 'visible') void refreshStories(); else pauseViewer(true); };
  document.addEventListener('visibilitychange', onVis);
  const t = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshStories(); }, 60_000);
  const dlg = $<HTMLDialogElement>('storyDlg');
  const onKey = (ev: KeyboardEvent) => viewerKey(ev);
  dlg.addEventListener('keydown', onKey);
  dlg.addEventListener('close', stopViewer);
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) closeDialog(dlg); });
  const nd = $<HTMLDialogElement>('storyNewDlg');
  nd.addEventListener('close', resetComposer);
  nd.addEventListener('click', (ev) => { if (ev.target === nd && !C.busy) closeDialog(nd); });
  return () => {
    document.removeEventListener('visibilitychange', onVis);
    clearInterval(t);
    dlg.removeEventListener('keydown', onKey);
    stopViewer();
    resetComposer();
  };
}

let refreshing: Promise<void> | null = null;
export function refreshStories(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      if (await loadStoryFeed()) {
        env.remember(ST.feed);
        env.changed();
      }
    } catch { /* нет связи — попробуем позже */ } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ---------------------------------------------------------------------------
// Кружки
// ---------------------------------------------------------------------------

/** Класс кольца вокруг аватарки человека: новые истории — градиент, просмотренные — серое. */
export function ringClass(uid: string | null | undefined): string {
  const st = storyState(uid);
  return st === 'new' ? 'st-ring st-new' : st === 'seen' ? 'st-ring st-seen' : '';
}

/** Аватарка в кольце; по нажатию открываются истории. */
function ringAvatar(uid: string, size: 'big' | 'mid'): HTMLElement {
  const st = storyState(uid);
  const r = el('span', `st-ring ${st === 'new' ? 'st-new' : st === 'seen' ? 'st-seen' : 'st-none'} ${size}`);
  r.append(env.avatar(uid));
  return r;
}

export function renderStoryStrip(): void {
  const box = document.getElementById('stories');
  const mini = document.getElementById('storyMini');
  if (!box || !mini) return;
  const me = env.me();
  box.classList.toggle('off', env.searching());
  const frag = document.createDocumentFragment();
  const mine = ST.byAuthor.get(me);
  // Я: есть истории — кружок открывает их, плюсик — новая; нет — сразу новая.
  const meBtn = el('div', 'st-item me');
  const ring = button('st-open', null, () => (mine ? openStoriesOf(me) : openComposer()));
  ring.append(ringAvatar(me, 'big'));
  ring.setAttribute('aria-label', mine ? 'Мои истории' : 'Новая история');
  const add = button('st-add', null, (ev) => { ev.stopPropagation(); openComposer(); });
  add.append(html(ICONS.plus));
  add.setAttribute('aria-label', 'Новая история');
  add.title = 'Новая история';
  meBtn.append(ring, add, el('span', 'st-name', mine ? 'Вы' : 'История'));
  frag.append(meBtn);
  const others = ST.feed.filter((a) => a.id !== me && a.stories.length);
  for (const a of others) {
    const b = button(`st-item${a.unseen ? ' new' : ''}`, null, () => openStoriesOf(a.id));
    b.append(ringAvatar(a.id, 'big'), el('span', 'st-name', env.short(a.id)));
    b.setAttribute('aria-label', `Истории: ${env.name(a.id)}${a.unseen ? ', есть новые' : ''}`);
    b.title = env.name(a.id);
    frag.append(b);
  }
  if (!others.length) {
    frag.append(el('p', 'st-hint', ST.loaded
      ? 'Поделитесь моментом: фото, видео или текст. История исчезнет через сутки.'
      : ''));
  }
  box.replaceChildren(frag);

  // Свёрнутый список: один кружок — ближайшие непросмотренные (или свои).
  const first = others.find((a) => a.unseen) ?? (mine ? ST.byAuthor.get(me) : others[0]);
  const m = document.createDocumentFragment();
  if (first) {
    const b = button('st-open', null, () => openStoriesOf(first.id));
    b.append(ringAvatar(first.id, 'mid'));
    const n = others.filter((a) => a.unseen).length;
    if (n) b.append(el('span', 'st-count', String(n)));
    b.setAttribute('aria-label', n ? `Истории: ${plural(n, 'человек', 'человека', 'человек')} с новыми` : 'Истории');
    b.title = 'Истории';
    m.append(b);
  } else {
    const b = button('st-open st-new-one', null, () => openComposer());
    b.append(html(ICONS.plus));
    b.setAttribute('aria-label', 'Новая история');
    b.title = 'Новая история';
    m.append(b);
  }
  mini.replaceChildren(m);
}

/** Открыть истории человека: из ленты (дальше — следующие люди) или из профиля (закреплённые). */
export function openStoriesOf(uid: string): void {
  const tracks = ST.feed.filter((a) => a.stories.length).map((a) => ({ uid: a.id, stories: a.stories }));
  const ai = tracks.findIndex((t) => t.uid === uid);
  if (ai >= 0) { openViewer(tracks, ai, -1); return; }
  void userStories(uid).then((list) => {
    if (list.length) openViewer([{ uid, stories: list }], 0, 0);
    else toast('Историй пока нет');
  }, (e) => toast(errText(e, 'Не получилось открыть истории.')));
}

// ---------------------------------------------------------------------------
// Просмотр
// ---------------------------------------------------------------------------

type Track = { uid: string; stories: Story[] };
const V = {
  tracks: [] as Track[],
  ai: 0,
  si: 0,
  dur: STORY_SHOW_MS,
  elapsed: 0,
  startAt: 0,
  ready: false,
  paused: false,
  /** Пауза по причине: удержание, панель, вкладка скрыта, меню. */
  holds: new Set<string>(),
  raf: 0,
  video: null as HTMLVideoElement | null,
  muted: false,
  seq: 0,
};

function cur(): Story | null {
  return V.tracks[V.ai]?.stories[V.si] ?? null;
}

function openViewer(tracks: Track[], ai: number, si: number): void {
  V.tracks = tracks;
  V.ai = ai;
  // С первой непросмотренной, как в Telegram.
  const list = tracks[ai].stories;
  V.si = si >= 0 ? si : Math.max(0, list.findIndex((s) => !s.seen));
  if (V.si >= list.length) V.si = 0;
  V.holds.clear();
  const dlg = $<HTMLDialogElement>('storyDlg');
  openDialog(dlg);
  show();
}

function stopViewer(): void {
  cancelAnimationFrame(V.raf);
  V.seq++;
  if (V.video) { V.video.pause(); V.video.removeAttribute('src'); V.video.load(); V.video = null; }
  V.holds.clear();
  env?.changed();
}

function pauseViewer(on: boolean, why = 'tab'): void {
  if (on) V.holds.add(why); else V.holds.delete(why);
  const paused = V.holds.size > 0;
  if (paused === V.paused) return;
  V.paused = paused;
  if (paused) {
    V.elapsed += V.ready && V.startAt ? performance.now() - V.startAt : 0;
    V.startAt = 0;
    V.video?.pause();
  } else if (V.ready) {
    V.startAt = performance.now();
    void V.video?.play().catch(() => {});
  }
  const pb = document.getElementById('svPause');
  if (pb) {
    pb.replaceChildren(html(V.paused ? ICONS.play : ICONS.pause));
    pb.setAttribute('aria-label', V.paused ? 'Продолжить' : 'Пауза');
  }
}

function step(d: 1 | -1): void {
  const t = V.tracks[V.ai];
  if (!t) return;
  if (d > 0) {
    if (V.si + 1 < t.stories.length) V.si++;
    else if (V.ai + 1 < V.tracks.length) {
      V.ai++;
      const l = V.tracks[V.ai].stories;
      V.si = Math.max(0, l.findIndex((s) => !s.seen));
    } else { closeDialog($<HTMLDialogElement>('storyDlg')); return; }
  } else {
    if (V.si > 0) V.si--;
    else if (V.ai > 0) { V.ai--; V.si = V.tracks[V.ai].stories.length - 1; } else { V.elapsed = 0; V.startAt = V.ready ? performance.now() : 0; return; }
  }
  show();
}

function jumpAuthor(d: 1 | -1): void {
  const n = V.ai + d;
  if (n < 0 || n >= V.tracks.length) { if (d > 0) closeDialog($<HTMLDialogElement>('storyDlg')); return; }
  V.ai = n;
  V.si = Math.max(0, V.tracks[n].stories.findIndex((s) => !s.seen));
  show();
}

function viewerKey(e: KeyboardEvent): void {
  if ((e.target as HTMLElement).closest('input,textarea')) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === ' ') { e.preventDefault(); pauseViewer(!V.holds.has('key'), 'key'); }
}

function textSize(t: string): number {
  const n = t.length;
  return n <= 40 ? 34 : n <= 90 ? 28 : n <= 180 ? 23 : n <= 360 ? 19 : 16;
}

/** Текстовая история (и превью в сетке профиля). */
export function textStoryEl(s: Pick<Story, 'body' | 'bg'>, cls = 'sv-text'): HTMLElement {
  const bg = STORY_BGS[s.bg ?? 0] ?? STORY_BGS[0];
  const box = el('div', cls);
  box.style.background = bg.bg;
  box.style.color = bg.ink;
  const p = el('p', null, s.body ?? '');
  p.style.fontSize = `${textSize(s.body ?? '')}px`;
  box.append(p);
  return box;
}

function show(): void {
  const s = cur();
  const t = V.tracks[V.ai];
  if (!s || !t) { closeDialog($<HTMLDialogElement>('storyDlg')); return; }
  const seq = ++V.seq;
  cancelAnimationFrame(V.raf);
  if (V.video) { V.video.pause(); V.video.removeAttribute('src'); V.video.load(); V.video = null; }
  V.ready = false;
  V.elapsed = 0;
  V.startAt = 0;
  V.holds.delete('panel');
  V.holds.delete('menu');
  V.paused = V.holds.size > 0;
  const me = env.me();
  const mine = s.author_id === me;

  const card = el('div', 'sv-card');
  // Полоски прогресса
  const bars = el('div', 'sv-bars');
  t.stories.forEach((_, i) => {
    const b = el('span', 'sv-bar');
    const f = el('i');
    f.style.transform = `scaleX(${i < V.si ? 1 : 0})`;
    if (i === V.si) f.id = 'svFill';
    b.append(f);
    bars.append(b);
  });
  // Шапка
  const head = el('div', 'sv-head');
  const who = el('div', 'sv-who');
  const nm = el('b', null, env.name(t.uid));
  if (env.verified(t.uid)) nm.append(html('<span class="vmark">' + ICONS.verified + '</span>'));
  const sub = el('span', null, storyAge(s));
  if (s.pinned) sub.append(' · ', el('span', 'sv-pin', 'в профиле'));
  who.append(nm, sub);
  head.append(env.avatar(t.uid, 'sv-av'), who);
  const pauseBtn = button('sv-btn', null, () => pauseViewer(!V.holds.has('key'), 'key'));
  pauseBtn.id = 'svPause';
  pauseBtn.append(html(V.paused ? ICONS.play : ICONS.pause));
  pauseBtn.setAttribute('aria-label', V.paused ? 'Продолжить' : 'Пауза');
  head.append(pauseBtn);
  if (s.kind === 'video') {
    const mute = button('sv-btn', null, () => {
      V.muted = !V.muted;
      if (V.video) V.video.muted = V.muted;
      mute.replaceChildren(html(V.muted ? ICONS.soundOff : ICONS.sound));
      mute.setAttribute('aria-label', V.muted ? 'Включить звук' : 'Выключить звук');
    });
    mute.append(html(V.muted ? ICONS.soundOff : ICONS.sound));
    mute.setAttribute('aria-label', V.muted ? 'Включить звук' : 'Выключить звук');
    head.append(mute);
  }
  if (mine) {
    const more = button('sv-btn', null, () => authorMenu(s, card));
    more.append(html(ICONS.dots));
    more.setAttribute('aria-label', 'Действия с историей');
    head.append(more);
  }
  const x = button('sv-btn sv-x', null, () => closeDialog($<HTMLDialogElement>('storyDlg')));
  x.append(html(ICONS.close));
  x.setAttribute('aria-label', 'Закрыть');
  head.append(x);

  // Содержимое
  const stage = el('div', 'sv-stage');
  const begin = (ms: number) => {
    if (seq !== V.seq) return;
    V.dur = Math.max(1000, ms);
    V.ready = true;
    stage.classList.remove('loading');
    if (!V.paused) V.startAt = performance.now();
    markSeen(s, me);
    tick();
  };
  if (s.kind === 'text') {
    stage.append(textStoryEl(s));
    queueMicrotask(() => begin(Math.max(STORY_SHOW_MS, Math.min(15_000, (s.body?.length ?? 0) * 45))));
  } else {
    stage.classList.add('loading');
    const back = el('div', 'sv-back');
    stage.append(back);
    if (s.thumb_path) {
      const hit = cachedStoryUrl(s.thumb_path);
      if (hit) back.style.backgroundImage = `url("${hit}")`;
      else void storyUrl(s.thumb_path).then((u) => { back.style.backgroundImage = `url("${u}")`; }, () => {});
    }
    stage.append(el('span', 'sv-spin'));
    void storyUrl(s.media_path!).then((url) => {
      if (seq !== V.seq) return;
      if (s.kind === 'photo') {
        const img = el('img', 'sv-media');
        img.alt = s.body ?? 'Фото';
        img.src = url;
        img.decode().then(() => { stage.append(img); begin(STORY_SHOW_MS); }, () => fail(stage));
      } else {
        const v = el('video', 'sv-media');
        v.playsInline = true;
        v.preload = 'auto';
        v.muted = V.muted;
        v.src = url;
        V.video = v;
        v.addEventListener('ended', () => { if (seq === V.seq) step(1); });
        v.addEventListener('waiting', () => { if (seq === V.seq) pauseViewer(true, 'buffer'); });
        v.addEventListener('playing', () => { if (seq === V.seq) pauseViewer(false, 'buffer'); });
        v.addEventListener('loadeddata', () => {
          if (seq !== V.seq) return;
          stage.append(v);
          const d = Number.isFinite(v.duration) ? v.duration * 1000 : (s.duration_ms ?? STORY_SHOW_MS);
          if (!V.paused) {
            v.play().catch(() => {
              // Без жеста браузер не даёт звук — тогда без звука.
              v.muted = true;
              V.muted = true;
              void v.play().catch(() => {});
            });
          }
          begin(d);
        }, { once: true });
        v.addEventListener('error', () => fail(stage), { once: true });
      }
    }, () => fail(stage));
  }
  if (s.body && s.kind !== 'text') stage.append(el('p', 'sv-caption', s.body));

  // Касания: слева — назад, справа — вперёд, удерживать — пауза.
  const tap = el('div', 'sv-tap');
  let downAt = 0;
  let downX = 0;
  let downY = 0;
  tap.addEventListener('pointerdown', (e) => {
    downAt = performance.now();
    downX = e.clientX;
    downY = e.clientY;
    pauseViewer(true, 'hold');
  });
  const up = (e: PointerEvent) => {
    if (!downAt) return;
    const held = performance.now() - downAt;
    downAt = 0;
    pauseViewer(false, 'hold');
    // Смахнули вниз — закрыть (телефон).
    if (e.clientY - downY > 90 && Math.abs(e.clientX - downX) < 80) { closeDialog($<HTMLDialogElement>('storyDlg')); return; }
    if (Math.abs(e.clientX - downX) > 60) { jumpAuthor(e.clientX < downX ? 1 : -1); return; }
    if (held > 280) return;
    const r = tap.getBoundingClientRect();
    step(e.clientX - r.left < r.width * 0.3 ? -1 : 1);
  };
  tap.addEventListener('pointerup', up);
  tap.addEventListener('pointercancel', () => { downAt = 0; pauseViewer(false, 'hold'); });
  tap.addEventListener('contextmenu', (e) => e.preventDefault());

  // Низ: автору — кто смотрел, остальным — сердечко.
  const foot = el('div', 'sv-foot');
  if (mine) {
    const views = button('sv-views', null, () => openViewers(s, card));
    views.append(html(ICONS.eye), el('span', null, plural(s.views ?? 0, 'просмотр', 'просмотра', 'просмотров')));
    if (s.likes) views.append(el('span', 'sv-likes-n', ''), html(ICONS.heartFill), el('span', null, String(s.likes)));
    foot.append(views);
  } else {
    const heart = button(`sv-heart${s.liked ? ' on' : ''}`, null, async () => {
      const on = !s.liked;
      heart.classList.toggle('on', on);
      heart.replaceChildren(html(on ? ICONS.heartFill : ICONS.heart));
      heart.setAttribute('aria-pressed', String(on));
      if (on) { heart.classList.remove('pop'); void heart.offsetWidth; heart.classList.add('pop'); }
      try { await likeStory(s, on); } catch (e) {
        heart.classList.toggle('on', s.liked);
        heart.replaceChildren(html(s.liked ? ICONS.heartFill : ICONS.heart));
        toast(errText(e, 'Не получилось.'));
      }
    });
    heart.append(html(s.liked ? ICONS.heartFill : ICONS.heart));
    heart.setAttribute('aria-label', 'Нравится');
    heart.setAttribute('aria-pressed', String(s.liked));
    foot.append(heart);
  }

  card.append(stage, tap, bars, head, foot);
  const wrap = el('div', 'sv-wrap');
  const prev = button('sv-nav prev', null, () => step(-1));
  prev.append(html(ICONS.prev));
  prev.setAttribute('aria-label', 'Предыдущая');
  prev.disabled = V.ai === 0 && V.si === 0;
  const next = button('sv-nav next', null, () => step(1));
  next.append(html(ICONS.next));
  next.setAttribute('aria-label', 'Следующая');
  wrap.append(prev, card, next);
  const dlg = $<HTMLDialogElement>('storyDlg');
  dlg.replaceChildren(wrap);
  dlg.setAttribute('aria-label', `История: ${env.name(t.uid)}`);
  x.focus({ preventScroll: true });
}

function fail(stage: HTMLElement): void {
  stage.classList.remove('loading');
  stage.querySelector('.sv-spin')?.remove();
  stage.append(el('p', 'sv-gone', 'История недоступна — возможно, её удалили.'));
}

function tick(): void {
  cancelAnimationFrame(V.raf);
  const f = document.getElementById('svFill');
  const run = () => {
    if (!V.ready) return;
    let p: number;
    if (V.video && Number.isFinite(V.video.duration) && V.video.duration > 0) p = V.video.currentTime / V.video.duration;
    else p = (V.elapsed + (V.startAt && !V.paused ? performance.now() - V.startAt : 0)) / V.dur;
    if (f) f.style.transform = `scaleX(${Math.min(1, p)})`;
    if (!V.video && p >= 1) { step(1); return; }
    V.raf = requestAnimationFrame(run);
  };
  V.raf = requestAnimationFrame(run);
}

/** Меню автора: закрепить в профиле, удалить. */
function authorMenu(s: Story, card: HTMLElement): void {
  card.querySelector('.sv-menu')?.remove();
  pauseViewer(true, 'menu');
  const m = el('div', 'sv-menu');
  m.setAttribute('role', 'menu');
  const close = () => { m.remove(); pauseViewer(false, 'menu'); };
  const pin = button('sv-mi', null, async () => {
    close();
    try {
      await pinStory(s, !s.pinned);
      toast(s.pinned ? 'История закреплена в профиле — она не исчезнет' : 'Откреплена: история исчезнет через сутки после публикации');
      show();
      env.changed();
    } catch (e) { toast(errText(e, 'Не получилось.')); }
  });
  pin.append(html(s.pinned ? ICONS.unpin : ICONS.pin), s.pinned ? 'Открепить из профиля' : 'Закрепить в профиле');
  const del = button('sv-mi danger', null, () => {
    del.replaceChildren(html(ICONS.trash), 'Точно удалить?');
    del.onclick = async () => {
      close();
      try {
        await deleteStory(s);
        const t = V.tracks[V.ai];
        t.stories = t.stories.filter((x) => x.id !== s.id);
        toast('История удалена');
        env.changed();
        if (!t.stories.length) {
          V.tracks.splice(V.ai, 1);
          if (!V.tracks.length) { closeDialog($<HTMLDialogElement>('storyDlg')); return; }
          V.ai = Math.min(V.ai, V.tracks.length - 1);
          V.si = 0;
        } else V.si = Math.min(V.si, t.stories.length - 1);
        show();
      } catch (e) { toast(errText(e, 'Не получилось удалить.')); }
    };
  });
  del.append(html(ICONS.trash), 'Удалить историю');
  const cancel = button('sv-mi', 'Отмена', close);
  m.append(pin, del, cancel);
  card.append(m);
  (pin as HTMLButtonElement).focus();
}

/** Кто смотрел: панель снизу. */
function openViewers(s: Story, card: HTMLElement): void {
  card.querySelector('.sv-panel')?.remove();
  pauseViewer(true, 'panel');
  const p = el('div', 'sv-panel');
  const head = el('div', 'sv-panel-head');
  const x = button('sv-btn', null, () => { p.remove(); pauseViewer(false, 'panel'); });
  x.append(html(ICONS.close));
  x.setAttribute('aria-label', 'Закрыть');
  head.append(el('b', null, 'Просмотры'), x);
  const list = el('div', 'sv-panel-list');
  list.append(el('p', 'hint', 'Загружаем…'));
  p.append(head, list);
  card.append(p);
  void storyViewers(s.id).then((rows) => {
    if (!rows.length) { list.replaceChildren(el('p', 'hint', 'Пока никто не посмотрел.')); return; }
    list.replaceChildren(...rows.map((r) => {
      const row = el('div', 'sv-viewer');
      const t = el('span', 'sv-viewer-t');
      t.append(el('b', null, env.name(r.user_id) || r.name || 'Участник'),
        el('span', null, new Date(r.viewed_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })));
      row.append(env.avatar(r.user_id), t);
      if (r.liked) {
        const h = el('span', 'sv-viewer-heart');
        h.append(html(ICONS.heartFill));
        h.setAttribute('aria-label', 'нравится');
        row.append(h);
      }
      return row;
    }));
  }, (e) => list.replaceChildren(el('p', 'err', errText(e))));
}

// ---------------------------------------------------------------------------
// Истории в профиле
// ---------------------------------------------------------------------------

/** Сетка историй человека в профиле: закреплённые и живые. Своим — плитка «Добавить». */
export function storyGrid(uid: string): HTMLElement {
  const box = el('div', 'st-grid-box');
  box.hidden = true;
  const mine = uid === env.me();
  void userStories(uid).then((list) => {
    if (!list.length && !mine) return;
    box.hidden = false;
    const grid = el('div', 'st-grid');
    if (mine) {
      const add = button('st-tile add', null, () => openComposer());
      add.append(html(ICONS.plus), el('span', null, 'Новая'));
      grid.append(add);
    }
    list.forEach((s, i) => {
      const b = button('st-tile', null, () => openViewer([{ uid, stories: list }], 0, i));
      if (s.kind === 'text') b.append(textStoryEl(s, 'st-tile-text'));
      else if (s.thumb_path) {
        const img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        const hit = cachedStoryUrl(s.thumb_path);
        if (hit) img.src = hit; else void storyUrl(s.thumb_path).then((u) => { img.src = u; }, () => {});
        b.append(img);
        if (s.kind === 'video') b.append(el('span', 'st-tile-play'));
      }
      if (s.pinned) {
        const pin = el('span', 'st-tile-pin');
        pin.append(html(ICONS.pinMark));
        b.append(pin);
      }
      b.setAttribute('aria-label', `${s.kind === 'video' ? 'Видео' : s.kind === 'photo' ? 'Фото' : 'Текст'}, ${storyAge(s)}${s.pinned ? ', закреплена' : ''}`);
      grid.append(b);
    });
    box.replaceChildren(el('span', 'fld', mine ? 'Мои истории' : 'Истории'), grid);
    if (mine) box.append(el('p', 'hint', 'Истории видят все, с кем у вас личный чат. Через сутки они исчезают — кроме закреплённых в профиле.'));
  }, () => {});
  return box;
}

// ---------------------------------------------------------------------------
// Новая история
// ---------------------------------------------------------------------------

const C = {
  mode: 'media' as 'media' | 'text',
  file: null as StoryFile | null,
  bg: 0,
  busy: false,
  ctrl: null as AbortController | null,
};

function resetComposer(): void {
  C.ctrl?.abort();
  C.ctrl = null;
  C.busy = false;
  releaseStoryFile(C.file);
  C.file = null;
}

export function openComposer(file?: File): void {
  const dlg = $<HTMLDialogElement>('storyNewDlg');
  resetComposer();
  C.mode = 'media';
  renderComposer();
  openDialog(dlg);
  if (file) void pick(file);
}

async function pick(f: File): Promise<void> {
  const err = document.getElementById('snErr');
  if (err) err.textContent = '';
  const stage = document.getElementById('snStage');
  stage?.classList.add('loading');
  try {
    const prepared = await prepareStoryFile(f);
    releaseStoryFile(C.file);
    C.file = prepared;
    C.mode = 'media';
    renderComposer();
  } catch (e) {
    stage?.classList.remove('loading');
    const t = document.getElementById('snErr');
    if (t) t.textContent = e instanceof StoryError ? e.message : 'Не получилось открыть файл.';
  }
}

function renderComposer(): void {
  const dlg = $<HTMLDialogElement>('storyNewDlg');
  const head = el('div', 'dlg-head');
  head.append(el('h2', null, 'Новая история'));
  const x = button('icon-btn', null, () => { if (!C.busy) closeDialog(dlg); else C.ctrl?.abort(); });
  x.append(html(ICONS.close));
  x.setAttribute('aria-label', 'Закрыть');
  head.append(x);

  const seg = el('div', 'seg two');
  seg.setAttribute('role', 'group');
  ([['media', 'Фото или видео'], ['text', 'Текст']] as const).forEach(([m, label]) => {
    const b = button(null, label, () => { if (C.busy || C.mode === m) return; C.mode = m; renderComposer(); });
    b.setAttribute('aria-pressed', String(C.mode === m));
    seg.append(b);
  });

  const stage = el('div', `sn-stage ${C.mode}`);
  stage.id = 'snStage';
  const file = el('input');
  Object.assign(file, { type: 'file', accept: 'image/*,video/*', hidden: true });
  file.addEventListener('change', () => { const f = file.files?.[0]; file.value = ''; if (f) void pick(f); });
  let caption: HTMLInputElement | null = null;
  let text: HTMLTextAreaElement | null = null;

  if (C.mode === 'media') {
    if (C.file) {
      if (C.file.kind === 'photo') {
        const img = el('img', 'sn-media');
        img.src = C.file.preview;
        img.alt = '';
        stage.append(img);
      } else {
        const v = el('video', 'sn-media');
        v.src = C.file.preview;
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.autoplay = true;
        stage.append(v);
        stage.append(el('span', 'sn-dur', `${Math.round((C.file.durMs ?? 0) / 1000)} с`));
      }
      const change = button('sn-change', null, () => file.click());
      change.append(html(ICONS.edit), 'Другой файл');
      stage.append(change);
    } else {
      const pickBtn = button('sn-pick', null, () => file.click());
      pickBtn.append(html(ICONS.photo), el('b', null, 'Выбрать фото или видео'), el('span', null, `Видео — до 60 секунд, файл — до 50 МБ`));
      stage.append(pickBtn);
    }
    stage.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); stage.classList.add('drag'); } });
    stage.addEventListener('dragleave', () => stage.classList.remove('drag'));
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      stage.classList.remove('drag');
      const f = e.dataTransfer?.files?.[0];
      if (f) void pick(f);
    });
    caption = el('input', 'txt');
    Object.assign(caption, { id: 'snCaption', maxLength: STORY_CAPTION_MAX, placeholder: 'Подпись — необязательно', autocomplete: 'off' });
  } else {
    const bg = STORY_BGS[C.bg];
    stage.style.background = bg.bg;
    stage.style.color = bg.ink;
    text = el('textarea', 'sn-text');
    Object.assign(text, { id: 'snText', maxLength: STORY_TEXT_MAX, placeholder: 'Напишите что-нибудь', rows: 4 });
    text.style.color = bg.ink;
    const fit = () => { text!.style.fontSize = `${textSize(text!.value || 'Напишите что-нибудь')}px`; };
    text.addEventListener('input', fit);
    fit();
    stage.append(text);
  }

  const err = el('p', 'err');
  err.id = 'snErr';
  const bar = el('div', 'sn-progress');
  bar.hidden = true;
  bar.append(el('i'));
  const note = el('p', 'hint', 'Увидят все, с кем у вас личный чат. Исчезнет через 24 часа — если не закрепить её в профиле.');
  const actions = el('div', 'dlg-actions');
  const cancel = button('btn ghost', 'Отмена', () => { if (C.busy) C.ctrl?.abort(); else closeDialog(dlg); });
  const go = button('btn primary', 'Выложить', () => void submit());
  go.id = 'snGo';
  actions.append(cancel, go);

  const body = el('div', 'sn');
  body.append(seg, stage, file);
  if (C.mode === 'text') {
    const sw = el('div', 'sn-bgs');
    sw.setAttribute('role', 'radiogroup');
    sw.setAttribute('aria-label', 'Фон');
    STORY_BGS.forEach((b, i) => {
      const s = button('sn-bg', null, () => {
        C.bg = i;
        const keep = (document.getElementById('snText') as HTMLTextAreaElement | null)?.value ?? '';
        renderComposer();
        const t = document.getElementById('snText') as HTMLTextAreaElement | null;
        if (t) { t.value = keep; t.dispatchEvent(new Event('input')); t.focus(); }
      });
      s.style.background = b.bg;
      s.setAttribute('role', 'radio');
      s.setAttribute('aria-checked', String(i === C.bg));
      s.setAttribute('aria-label', b.name);
      s.title = b.name;
      sw.append(s);
    });
    body.append(sw);
  }
  if (caption) body.append(caption);
  body.append(bar, err, note, actions);
  dlg.replaceChildren(head, body);

  async function submit(): Promise<void> {
    if (C.busy) return;
    err.textContent = '';
    const t = (document.getElementById('snText') as HTMLTextAreaElement | null)?.value.trim() ?? '';
    if (C.mode === 'text' && !t) { err.textContent = 'Напишите текст истории.'; return; }
    if (C.mode === 'media' && !C.file) { err.textContent = 'Выберите фото или видео.'; file.click(); return; }
    C.busy = true;
    C.ctrl = new AbortController();
    go.disabled = true;
    go.textContent = C.mode === 'media' ? 'Загружаем…' : 'Публикуем…';
    bar.hidden = C.mode !== 'media';
    const fill = bar.firstElementChild as HTMLElement;
    try {
      await publishStory(env.me(), C.mode === 'text'
        ? { kind: 'text', body: t, bg: C.bg }
        : { kind: 'media', file: C.file!, caption: (document.getElementById('snCaption') as HTMLInputElement | null)?.value ?? '' },
      (p) => { fill.style.transform = `scaleX(${p})`; }, C.ctrl.signal);
      C.busy = false;
      // Файл уже не нужен: предпросмотр освобождаем, свои файлы история покажет из памяти.
      closeDialog(dlg);
      toast('История выложена');
      await refreshStories();
    } catch (e) {
      C.busy = false;
      go.disabled = false;
      go.textContent = 'Выложить';
      bar.hidden = true;
      if ((e as Error).name === 'AbortError') { err.textContent = 'Загрузка отменена.'; return; }
      err.textContent = e instanceof StoryError ? e.message : errText(e, 'Не получилось выложить историю.');
    }
  }
}
