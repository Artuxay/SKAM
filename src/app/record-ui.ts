// Кнопка записи в композере — как в Telegram:
//  • удерживайте — идёт запись, отпустите — сообщение уходит;
//  • уведите палец влево — отмена, вверх — запись «закрепится» и руки свободны;
//  • короткое нажатие переключает голосовое ↔ кружочек;
//  • с клавиатуры (Enter/пробел) запись сразу закреплена: «Отправить» или «Отмена».
import { ICONS, el, html, lsGet, lsSet, toast } from '../lib/dom';
import { REC_MIN_MS, RecError, Recorder, type RecKind } from './recorder';
import { pauseNotes, stopVoice } from './media';
import type { Recorded } from './store';

type State = 'idle' | 'pressing' | 'opening' | 'recording' | 'locked' | 'sending';

export type RecordUI = {
  /** Отменить запись (например, открыли другой чат). */
  cancel(): void;
  busy(): boolean;
  destroy(): void;
};

type Opts = {
  btn: HTMLButtonElement;
  composer: HTMLElement;
  bar: HTMLElement;
  stage: HTMLElement;
  /** Чат, в который сейчас можно писать, или null. */
  chat: () => string | null;
  send: (chatId: string, kind: RecKind, rec: Recorded) => void;
  /** «записывает голосовое…» для собеседников. */
  activity: (kind: RecKind | null) => void;
};

const HOLD_MS = 220;
const CANCEL_DX = -110;
const LOCK_DY = -64;
const RING = 2 * Math.PI * 48;

const LABEL: Record<RecKind, string> = {
  voice: 'Голосовое: удерживайте, чтобы записать. Нажмите — переключиться на кружочек',
  video_note: 'Кружочек: удерживайте, чтобы записать. Нажмите — переключиться на голосовое',
};

function fmtRec(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')},${Math.floor((ms % 1000) / 100)}`;
}

export function mountRecorder(o: Opts): RecordUI {
  let mode: RecKind = lsGet('skam:rec-mode') === 'video_note' ? 'video_note' : 'voice';
  let state: State = 'idle';
  let rec: Recorder | null = null;
  let chatId: string | null = null;
  let pressTimer: number | undefined;
  let releasedEarly = false;
  let start = { x: 0, y: 0 };
  /** Где палец сейчас: жест мог начаться, пока браузер ещё включал микрофон. */
  let last = { x: 0, y: 0 };
  let raf = 0;
  let hintTimer: number | undefined;
  let pointerId: number | null = null;
  /** Нажатие, с которого началась запись: его «клик» при отпускании не должен ничего отправлять. */
  let holdPress = false;
  let eatClick = false;

  // Полоска записи (вместо поля ввода)
  const cancelBtn = el('button', 'rec-cancel');
  cancelBtn.type = 'button';
  cancelBtn.setAttribute('aria-label', 'Отменить запись');
  cancelBtn.append(html(ICONS.trash));
  const dot = el('span', 'rec-dot');
  const time = el('span', 'rec-time', '0:00,0');
  time.setAttribute('role', 'timer');
  const slide = el('span', 'rec-slide');
  const level = el('span', 'rec-level');
  o.bar.replaceChildren(cancelBtn, dot, time, slide, level);

  // Замок над кнопкой
  const lockPill = el('div', 'rec-lock');
  lockPill.append(html(ICONS.lock), html(ICONS.up));
  lockPill.setAttribute('aria-hidden', 'true');
  o.btn.after(lockPill);

  // Подсказка после короткого нажатия
  const tip = el('div', 'rec-tip');
  tip.setAttribute('role', 'status');
  o.btn.after(tip);

  // Круг с камерой для кружочка
  const circle = el('div', 'rec-circle');
  const ring = html(`<svg class="rec-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="48" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/></svg>`);
  const ringCircle = ring.querySelector('circle') as SVGCircleElement;
  circle.append(ring);
  o.stage.replaceChildren(circle);

  function paintBtn(): void {
    const recording = state === 'recording' || state === 'opening';
    const locked = state === 'locked';
    o.btn.classList.toggle('recording', recording);
    o.btn.classList.toggle('locked', locked);
    o.btn.replaceChildren(html(locked ? ICONS.send : mode === 'voice' ? ICONS.mic : ICONS.circle));
    o.btn.setAttribute('aria-label', locked ? 'Отправить запись' : LABEL[mode]);
    o.btn.title = locked ? 'Отправить' : mode === 'voice' ? 'Голосовое' : 'Кружочек';
  }

  function showTip(text: string): void {
    tip.textContent = text;
    tip.classList.add('on');
    clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => tip.classList.remove('on'), 2600);
  }

  function setUi(): void {
    const active = state === 'recording' || state === 'locked' || state === 'opening' || state === 'sending';
    o.composer.classList.toggle('recording', active);
    o.composer.classList.toggle('rec-locked', state === 'locked');
    o.bar.hidden = !active;
    lockPill.classList.toggle('on', state === 'recording');
    slide.textContent = state === 'locked'
      ? (mode === 'voice' ? 'Запись голосового' : 'Запись кружочка')
      : 'Влево — отмена';
    cancelBtn.hidden = state !== 'locked';
    const showStage = mode === 'video_note' && active && !!rec?.preview;
    o.stage.hidden = !showStage;
    if (showStage && rec?.preview && !circle.contains(rec.preview)) {
      rec.preview.className = 'rec-preview';
      circle.prepend(rec.preview);
    }
    paintBtn();
  }

  function tick(): void {
    cancelAnimationFrame(raf);
    if (!rec || (state !== 'recording' && state !== 'locked')) return;
    const t = rec.elapsed;
    time.textContent = fmtRec(t);
    const lv = rec.level;
    o.btn.style.setProperty('--lv', lv.toFixed(3));
    level.style.setProperty('--lv', lv.toFixed(3));
    ringCircle.style.strokeDashoffset = String(RING * (1 - Math.min(1, t / rec.limit)));
    o.activity(mode);
    if (t >= rec.limit) { void finish(true); return; }
    raf = requestAnimationFrame(tick);
  }

  /** keyboard — запись с клавиатуры: сразу закреплена. */
  async function begin(keyboard: boolean): Promise<void> {
    const cid = o.chat();
    if (!cid) { state = 'idle'; return; }
    chatId = cid;
    state = 'opening';
    releasedEarly = false;
    stopVoice();
    pauseNotes();
    tip.classList.remove('on');
    setUi();
    const openedAt = performance.now();
    let r: Recorder;
    try {
      r = await Recorder.open(mode);
    } catch (e) {
      state = 'idle';
      setUi();
      toast(e instanceof RecError ? e.message : 'Не получилось начать запись.');
      return;
    }
    // Пока спрашивали разрешение, запись отменили (другой чат, выход).
    if (state !== 'opening' || o.chat() !== chatId) {
      r.cancel();
      return;
    }
    rec = r;
    try {
      r.start();
    } catch {
      r.cancel();
      rec = null;
      state = 'idle';
      setUi();
      toast('Не получилось начать запись.');
      return;
    }
    o.bar.style.removeProperty('--dx');
    if (releasedEarly && !keyboard) {
      // Отпустили, пока браузер спрашивал разрешение (долго) — закрепляем запись, чтобы не пропала.
      // Отпустили почти сразу — это было короткое нажатие: подскажем, что кнопку нужно держать.
      if (performance.now() - openedAt > 900) {
        state = 'locked';
      } else {
        state = 'recording';
        void finish(true);
        return;
      }
    } else {
      state = keyboard ? 'locked' : 'recording';
    }
    setUi();
    tick();
    // Палец уже увели вверх или влево, пока включался микрофон.
    if (state === 'recording') gesture(last.x, last.y);
  }

  function gesture(x: number, y: number): void {
    if (state !== 'recording') return;
    const dx = Math.min(0, x - start.x);
    const dy = y - start.y;
    o.bar.style.setProperty('--dx', `${dx}px`);
    lockPill.style.setProperty('--dy', `${Math.max(-40, Math.min(0, dy))}px`);
    if (dx < CANCEL_DX) void finish(false);
    else if (dy < LOCK_DY) lock();
  }

  async function finish(send: boolean): Promise<void> {
    if (state === 'opening') { state = 'idle'; setUi(); o.activity(null); return; }
    const r = rec;
    if (!r || (state !== 'recording' && state !== 'locked')) return;
    state = 'sending';
    cancelAnimationFrame(raf);
    o.activity(null);
    const kind = r.kind;
    const cid = chatId;
    const tooShort = r.elapsed < REC_MIN_MS;
    if (!send || tooShort || !cid) {
      r.cancel();
      reset();
      if (send && tooShort) {
        showTip(kind === 'voice' ? 'Удерживайте кнопку, чтобы записать голосовое' : 'Удерживайте кнопку, чтобы записать кружочек');
      }
      return;
    }
    try {
      const out = await r.stop();
      reset();
      o.send(cid, kind, out);
    } catch (e) {
      reset();
      toast(e instanceof RecError ? e.message : 'Не получилось сохранить запись.');
    }
  }

  function reset(): void {
    rec = null;
    chatId = null;
    state = 'idle';
    pointerId = null;
    o.bar.style.removeProperty('--dx');
    o.btn.style.removeProperty('--lv');
    ringCircle.style.strokeDashoffset = String(RING);
    circle.querySelector('video')?.remove();
    setUi();
  }

  function lock(): void {
    if (state !== 'recording') return;
    state = 'locked';
    o.bar.style.removeProperty('--dx');
    setUi();
  }

  function toggleMode(): void {
    mode = mode === 'voice' ? 'video_note' : 'voice';
    lsSet('skam:rec-mode', mode);
    paintBtn();
    showTip(mode === 'voice'
      ? 'Голосовое: удерживайте кнопку, чтобы записать'
      : 'Кружочек: удерживайте кнопку, чтобы записать видео');
  }

  // --- указатель ---
  const onDown = (e: PointerEvent) => {
    eatClick = false;
    if (e.button !== 0 || state !== 'idle') return;
    e.preventDefault();
    pointerId = e.pointerId;
    try { o.btn.setPointerCapture(e.pointerId); } catch { /* ок */ }
    start = { x: e.clientX, y: e.clientY };
    last = { ...start };
    state = 'pressing';
    releasedEarly = false;
    pressTimer = window.setTimeout(() => { if (state === 'pressing') { holdPress = true; void begin(false); } }, HOLD_MS);
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    last = { x: e.clientX, y: e.clientY };
    gesture(e.clientX, e.clientY);
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    lockPill.style.removeProperty('--dy');
    if (holdPress) { holdPress = false; eatClick = true; }
    if (state === 'pressing') {
      clearTimeout(pressTimer);
      state = 'idle';
      toggleMode();
    } else if (state === 'opening') {
      releasedEarly = true;
    } else if (state === 'recording') {
      void finish(true);
    }
    if (state !== 'locked' && state !== 'opening') pointerId = null;
  };
  const onCancel = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    lockPill.style.removeProperty('--dy');
    holdPress = false;
    // Система забрала жест (звонок, прокрутка) — не теряем запись, а закрепляем её.
    if (state === 'pressing') { clearTimeout(pressTimer); state = 'idle'; }
    else if (state === 'recording') lock();
    else if (state === 'opening') releasedEarly = true;
  };
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    // Отпустили кнопку после записи (или после того, как закрепили её жестом вверх).
    if (eatClick) { eatClick = false; return; }
    if (state === 'locked') { void finish(true); return; }
    // Enter или пробел на кнопке: сразу закреплённая запись.
    if (e.detail === 0 && state === 'idle') void begin(true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && (state === 'locked' || state === 'recording')) { e.preventDefault(); void finish(false); }
  };
  const noMenu = (e: Event) => e.preventDefault();

  o.btn.addEventListener('pointerdown', onDown);
  o.btn.addEventListener('pointermove', onMove);
  o.btn.addEventListener('pointerup', onUp);
  o.btn.addEventListener('pointercancel', onCancel);
  o.btn.addEventListener('click', onClick);
  o.btn.addEventListener('contextmenu', noMenu);
  cancelBtn.addEventListener('click', () => void finish(false));
  document.addEventListener('keydown', onKey);
  paintBtn();
  setUi();

  return {
    cancel: () => {
      clearTimeout(pressTimer);
      if (state === 'pressing') state = 'idle';
      void finish(false);
    },
    busy: () => state !== 'idle' && state !== 'pressing',
    destroy: () => {
      clearTimeout(pressTimer);
      clearTimeout(hintTimer);
      cancelAnimationFrame(raf);
      rec?.cancel();
      rec = null;
      state = 'idle';
      document.removeEventListener('keydown', onKey);
      lockPill.remove();
      tip.remove();
    },
  };
}
