// Окна-«листы» в стиле СКАМ 0.3.1: шапка с крестиком, группы строк со значками, плитки действий.
// Из них собраны «Мой профиль», карточка человека и «Новый чат».
import { ICONS, button, closeDialog, el, html } from '../lib/dom';

export type IconName = keyof typeof ICONS;

/** Шапка: «назад» (если есть), заголовок и крестик. */
export function sheetHead(dlg: HTMLDialogElement, title: string | null, back?: () => void): HTMLElement {
  const h = el('header', `sh-head${title ? '' : ' bare'}`);
  if (back) {
    const b = button('sh-btn', null, back);
    b.append(html(ICONS.back));
    b.setAttribute('aria-label', 'Назад');
    h.append(b);
  }
  h.append(title ? el('h2', 'sh-title', title) : el('span', 'sh-title'));
  const x = button('sh-btn sh-x', null, () => closeDialog(dlg));
  x.append(html(ICONS.close));
  x.setAttribute('aria-label', 'Закрыть');
  h.append(x);
  return h;
}

/** Группа строк на подложке. Пустые места (null/false) пропускаются; без строк группы нет. */
export function grp(...rows: (HTMLElement | null | false | undefined)[]): HTMLElement {
  const g = el('div', 'grp');
  rows.forEach((r) => { if (r) g.append(r); });
  if (!g.childElementCount) g.hidden = true;
  return g;
}

export type RowOpts = {
  icon?: IconName;
  label: string | Node;
  /** Подпись мелко под текстом («Имя пользователя», «О себе»). */
  sub?: string | null;
  /** Справа серым: число, версия, «Добавить». */
  em?: string | Node | null;
  fn?: () => void;
  danger?: boolean;
  /** Значок в цвете акцента (как в «Новом чате»). */
  accent?: boolean;
  /** Стрелка справа — откроется следующий экран. */
  chev?: boolean;
  /** Опасное действие: первое нажатие спрашивает это, второе — делает. */
  confirm?: string;
  disabled?: boolean;
  title?: string;
};

/** Строка группы: значок, текст (и подпись), справа — значение или стрелка. */
export function row(o: RowOpts): HTMLElement {
  const r = o.fn ? button('lr', null, () => {}) : el('div', 'lr');
  if (o.danger) r.classList.add('danger');
  if (o.icon) {
    const ic = el('span', `lr-ic${o.accent ? ' acc' : ''}`);
    ic.append(html(ICONS[o.icon]));
    r.append(ic);
  }
  const text = el('span', 'lr-t');
  const label = el('span', 'lr-l');
  label.append(o.label);
  text.append(label);
  if (o.sub) text.append(el('span', 'lr-sub', o.sub));
  r.append(text);
  if (o.em !== undefined && o.em !== null && o.em !== '') {
    const em = el('span', 'lr-em');
    em.append(o.em);
    r.append(em);
  }
  if (o.chev) {
    const ch = el('span', 'lr-chev');
    ch.append(html(ICONS.chev));
    r.append(ch);
  }
  if (o.title) r.title = o.title;
  if (o.fn && r instanceof HTMLButtonElement) {
    r.disabled = !!o.disabled;
    let armed = 0;
    const original = typeof o.label === 'string' ? o.label : null;
    r.addEventListener('click', () => {
      if (o.confirm && !armed) {
        armed = window.setTimeout(() => {
          armed = 0;
          r.classList.remove('armed');
          if (original !== null) label.textContent = original;
        }, 4000);
        r.classList.add('armed');
        label.textContent = o.confirm;
        return;
      }
      clearTimeout(armed);
      armed = 0;
      o.fn!();
    });
  }
  return r;
}

/** Переключатель в строке (вкл/выкл). */
export function toggleRow(icon: IconName, label: string, sub: string | null, on: boolean, fn: (next: boolean) => void,
  disabled = false): HTMLButtonElement {
  const r = button('lr sw-row', null, () => fn(!on));
  r.setAttribute('role', 'switch');
  r.setAttribute('aria-checked', String(on));
  r.disabled = disabled;
  const ic = el('span', 'lr-ic');
  ic.append(html(ICONS[icon]));
  const text = el('span', 'lr-t');
  text.append(el('span', 'lr-l', label));
  if (sub) text.append(el('span', 'lr-sub', sub));
  r.append(ic, text, el('span', `sw${on ? ' on' : ''}`));
  return r;
}

/** Плитка действия в карточке: «Чат», «Звонок», «Видео», «Без звука». */
export function actionTile(icon: IconName, label: string, fn: (b: HTMLButtonElement) => void,
  o: { disabled?: boolean; title?: string; on?: boolean } = {}): HTMLButtonElement {
  const b = button(`sh-tile${o.on ? ' on' : ''}`, null, () => fn(b));
  b.append(html(ICONS[icon]), el('span', null, label));
  b.disabled = !!o.disabled;
  if (o.title) b.title = o.title;
  return b;
}

/** Подпись над группой. */
export function grpLabel(text: string): HTMLElement {
  return el('p', 'grp-label', text);
}

/** Пояснение под группой. */
export function grpNote(text: string | Node): HTMLElement {
  const p = el('p', 'grp-note');
  p.append(text);
  return p;
}

// ---------------------------------------------------------------------------
// Строки с полями: список устройств, ползунок, выбор из нескольких
// ---------------------------------------------------------------------------

export type Opt<T> = { value: T; label: string; sub?: string };

/** Подпись и выпадающий список на всю ширину строки (устройства ввода и вывода). */
export function selectRow(label: string, opts: Opt<string>[], value: string, fn: (v: string) => void,
  o: { icon?: IconName; id?: string; disabled?: boolean } = {}): HTMLElement {
  const r = el('div', 'lr fld');
  if (o.icon) {
    const ic = el('span', 'lr-ic');
    ic.append(html(ICONS[o.icon]));
    r.append(ic);
  }
  const box = el('div', 'fld-box');
  const l = el('label', 'fld-l', label);
  const sel = el('select', 'fld-sel');
  if (o.id) { sel.id = o.id; l.htmlFor = o.id; }
  opts.forEach((x) => {
    const op = el('option', null, x.label);
    op.value = x.value;
    sel.append(op);
  });
  sel.value = opts.some((x) => x.value === value) ? value : opts[0]?.value ?? '';
  sel.disabled = !!o.disabled || !opts.length;
  sel.addEventListener('change', () => fn(sel.value));
  box.append(l, sel);
  r.append(box);
  return r;
}

/** Ползунок с подписью и значением справа. */
export function rangeRow(label: string, min: number, max: number, value: number, fmt: (v: number) => string,
  fn: (v: number) => void, o: { icon?: IconName; id?: string; step?: number } = {}): HTMLElement {
  const r = el('div', 'lr fld');
  if (o.icon) {
    const ic = el('span', 'lr-ic');
    ic.append(html(ICONS[o.icon]));
    r.append(ic);
  }
  const box = el('div', 'fld-box');
  const top = el('div', 'fld-top');
  const l = el('label', 'fld-l', label);
  const val = el('span', 'fld-val', fmt(value));
  top.append(l, val);
  const range = el('input', 'fld-range');
  range.type = 'range';
  range.min = String(min);
  range.max = String(max);
  range.step = String(o.step ?? 1);
  range.value = String(value);
  if (o.id) { range.id = o.id; l.htmlFor = o.id; }
  range.addEventListener('input', () => {
    val.textContent = fmt(Number(range.value));
    fn(Number(range.value));
  });
  box.append(top, range);
  r.append(box);
  return r;
}

/** Выбор одного из нескольких вариантов в ряд («720p · 1080p · Исходное»). */
export function choiceRow<T extends string | number>(label: string, opts: Opt<T>[], value: T, fn: (v: T) => void): HTMLElement {
  const r = el('div', 'lr fld');
  const box = el('div', 'fld-box');
  box.append(el('span', 'fld-l', label));
  const seg = el('div', 'choice');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', label);
  opts.forEach((x) => {
    const b = button('opt', x.label, () => {
      seg.querySelectorAll('.opt').forEach((n) => n.setAttribute('aria-checked', 'false'));
      b.setAttribute('aria-checked', 'true');
      fn(x.value);
    });
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(x.value === value));
    if (x.sub) b.title = x.sub;
    seg.append(b);
  });
  box.append(seg);
  r.append(box);
  return r;
}

/** Строка-«радиокнопка»: один из режимов (голосовая активность / рация). */
export function radioRow(label: string, sub: string | null, on: boolean, fn: () => void, icon?: IconName): HTMLButtonElement {
  const r = button('lr rd-row', null, fn);
  r.setAttribute('role', 'radio');
  r.setAttribute('aria-checked', String(on));
  if (icon) {
    const ic = el('span', 'lr-ic');
    ic.append(html(ICONS[icon]));
    r.append(ic);
  }
  const text = el('span', 'lr-t');
  text.append(el('span', 'lr-l', label));
  if (sub) text.append(el('span', 'lr-sub', sub));
  r.append(text, el('span', `rd${on ? ' on' : ''}`));
  return r;
}
