// Папки с чатами: вкладки над списком чатов, редактор папки,
// выбор чатов и «Папки с чатами» (порядок, рекомендуемые) — как в Telegram.
import type { ChatFolder, FolderKind, MyChat } from '../lib/database.types';
import {
  $, ICONS, button, closeDialog, dlgHead, el, errText, html, openDialog, plural, toast, touchMQ, wideMQ,
} from '../lib/dom';
import { S, markRead, searchNorm } from './store';
import {
  FOLDER_ICONS, FOLDER_KINDS, FOLDER_TITLE_MAX, KIND_TABS, L, MAX_FOLDER_CHATS, MAX_FOLDERS, deleteFolder, folderById, folderIcon,
  folderSummary, listChats, reorderFolders, saveFolder, setFolder, setKind, unreadIn, type FolderDraft, type KindTab,
} from './layout';

export type MenuItem =
  | { icon: keyof typeof ICONS; emoji?: string; label: string; fn: () => void; danger?: boolean; confirm?: string; checked?: boolean }
  | { head: string; back?: () => void };

type Env = {
  chatTile: (c: MyChat, cls?: string) => HTMLElement;
  chatTitle: (c: MyChat) => string;
  menu: (items: MenuItem[], x: number, y: number) => void;
  /** Сбросить поиск (переход в папку показывает её чаты). */
  clearSearch: () => void;
  searching: () => boolean;
};
let env: Env;

export function mountFolders(e: Env): void {
  env = e;
  tabsSig = '';
  tabsCur = undefined;
}

// ---------------------------------------------------------------------------
// Вкладки папок
// ---------------------------------------------------------------------------

function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

function pick(id: string | null): void {
  if (env.searching()) env.clearSearch();
  if (L.cur !== id) setFolder(id);
  else if (!wideMQ.matches) document.getElementById('chatList')?.scrollTo({ top: 0, behavior: 'smooth' });
}

function pickKind(k: KindTab): void {
  if (env.searching()) env.clearSearch();
  if (L.kind !== k) setKind(k);
  else document.getElementById('chatList')?.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Меню папки (или вкладки по типу): изменить, прочитать всё, удалить. */
function folderMenu(f: ChatFolder | null, x: number, y: number, kind: KindTab = 'all'): void {
  const items: MenuItem[] = [];
  const unread = listChats(f?.id ?? null, f ? 'all' : kind).filter((c) => c.unread);
  if (f) items.push({ icon: 'edit', label: 'Изменить папку', fn: () => openFolderEditor(f.id) });
  if (unread.length) {
    items.push({ icon: 'read', label: 'Отметить всё прочитанным', fn: () => { unread.forEach((c) => markRead(c.id)); } });
  }
  if (!L.folders.length) items.push({ icon: 'plus', label: 'Новая папка', fn: () => openFolderEditor(null) });
  items.push({ icon: 'sliders', label: 'Настроить папки', fn: () => openFolderSettings() });
  if (f) {
    items.push({
      icon: 'trash', label: 'Удалить папку', danger: true, confirm: 'Точно удалить папку?',
      fn: () => {
        deleteFolder(f.id).then(() => toast(`Папка «${f.title}» удалена. Чаты остались на месте.`),
          (e) => toast(errText(e, 'Не получилось удалить папку.')));
      },
    });
  }
  env.menu(items, x, y);
}

function withMenu(node: HTMLElement, f: ChatFolder | null, kind: KindTab = 'all'): void {
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const r = node.getBoundingClientRect();
    const kb = !e.clientX && !e.clientY;
    folderMenu(f, kb ? r.left + 12 : e.clientX, kb ? r.bottom : e.clientY, kind);
  });
  // Долгое нажатие на телефоне.
  let timer = 0;
  let fired = false;
  let at = { x: 0, y: 0 };
  node.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    fired = false;
    at = { x: e.clientX, y: e.clientY };
    timer = window.setTimeout(() => { fired = true; navigator.vibrate?.(8); folderMenu(f, at.x, at.y, kind); }, 450);
  });
  const stop = () => clearTimeout(timer);
  node.addEventListener('pointerup', stop);
  node.addEventListener('pointercancel', stop);
  node.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > 10) stop(); });
  node.addEventListener('click', (e) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}

/** Перетаскивание вкладок папок мышью — новый порядок сразу на сервер. */
let dragId: string | null = null;
function draggableFolder(node: HTMLElement, id: string): void {
  node.draggable = true;
  node.addEventListener('dragstart', (e) => {
    dragId = id;
    e.dataTransfer?.setData('text/plain', '');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => {
    dragId = null;
    node.classList.remove('dragging');
    document.querySelectorAll('.ft-item.drop-before,.ft-item.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  });
  node.addEventListener('dragover', (e) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    const r = node.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    node.classList.toggle('drop-after', after);
    node.classList.toggle('drop-before', !after);
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-before', 'drop-after'));
  node.addEventListener('drop', (e) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    const after = node.classList.contains('drop-after');
    node.classList.remove('drop-before', 'drop-after');
    const ids = L.folders.map((f) => f.id).filter((x) => x !== dragId);
    ids.splice(ids.indexOf(id) + (after ? 1 : 0), 0, dragId);
    reorderFolders(ids).catch((err) => toast(errText(err, 'Не получилось поменять порядок папок.')));
  });
}

/** Что нарисовано сейчас: одинаковое не перерисовываем (не сбиваем прокрутку вкладок и наведение). */
let tabsSig = '';
let tabsCur: string | null | undefined;

function barSig(): string {
  const parts = [String(L.loaded), String(L.cur), L.kind, String(env.searching()), String(unreadIn(null))];
  if (!L.folders.length) KIND_TABS.forEach((t) => parts.push(String(unreadIn(null, t.k))));
  L.folders.forEach((f) => parts.push(f.id, f.title, f.emoji ?? '', folderIcon(f), String(unreadIn(f.id))));
  return parts.join('\u0001');
}

/** Вкладки над списком чатов: свои папки, а пока их нет — «Все», «Личные», «Группы», «Каналы». */
export function renderFolderBar(): void {
  const sig = barSig();
  if (sig !== tabsSig) { tabsSig = sig; renderTabs(); }
  document.querySelector('.side')?.classList.toggle('has-folders', L.folders.length > 0);
}

function renderTabs(): void {
  const tabs = document.getElementById('folderTabs');
  if (!tabs) return;
  tabs.hidden = env.searching() || !L.loaded;
  if (tabs.hidden) { tabs.replaceChildren(); return; }
  const keep = tabs.scrollLeft;
  const frag = document.createDocumentFragment();
  if (!L.folders.length) {
    // Пока своих папок нет — вкладки по типу. Непрочитанные — числом рядом (у открытой вкладки не показываем).
    KIND_TABS.forEach(({ k, label }) => {
      const b = button('ft-item', null, () => pickKind(k));
      b.setAttribute('role', 'tab');
      const on = L.kind === k;
      b.setAttribute('aria-selected', String(on));
      if (on) b.setAttribute('aria-current', 'true');
      b.append(el('span', 'ft-t', label));
      const n = unreadIn(null, k);
      if (n && !on) {
        const c = el('span', 'ft-n', badgeText(n));
        c.setAttribute('aria-label', `непрочитанных: ${n}`);
        b.append(c);
      }
      withMenu(b, null, k);
      frag.append(b);
    });
    tabs.replaceChildren(frag);
    tabs.scrollLeft = keep;
    tabsCur = undefined;
    return;
  }
  const tab = (f: ChatFolder | null) => {
    const id = f?.id ?? null;
    const b = button('ft-item', null, () => pick(id));
    b.setAttribute('role', 'tab');
    const on = L.cur === id;
    b.setAttribute('aria-selected', String(on));
    if (on) b.setAttribute('aria-current', 'true');
    b.append(el('span', 'ft-t', f ? f.title : 'Все'));
    const n = unreadIn(id);
    if (n && !on) b.append(el('span', 'ft-n', badgeText(n)));
    b.title = f ? f.title : 'Все чаты';
    withMenu(b, f);
    if (f && !touchMQ.matches) draggableFolder(b, f.id);
    return b;
  };
  frag.append(tab(null));
  L.folders.forEach((f) => frag.append(tab(f)));
  const edit = button('ft-item ft-edit', null, () => openFolderSettings());
  edit.append(html(ICONS.sliders));
  edit.setAttribute('aria-label', 'Папки с чатами');
  edit.title = 'Папки с чатами';
  frag.append(edit);
  tabs.replaceChildren(frag);
  tabs.scrollLeft = keep;
  // Сменили папку — выбранная вкладка должна быть видна. Иначе прокрутку, которую сделал человек, не трогаем.
  if (tabsCur !== L.cur) {
    tabsCur = L.cur;
    const cur = tabs.querySelector<HTMLElement>('[aria-current="true"]');
    if (cur && (cur.offsetLeft < tabs.scrollLeft || cur.offsetLeft + cur.offsetWidth > tabs.scrollLeft + tabs.clientWidth)) {
      tabs.scrollLeft = cur.offsetLeft - 12;
    }
  }
}

/** Пустая папка в списке чатов. */
export function emptyFolderNote(f: ChatFolder): HTMLElement {
  const box = el('div', 'folder-empty');
  const ic = el('span', 'folder-empty-ic', folderIcon(f));
  ic.setAttribute('aria-hidden', 'true');
  box.append(ic, el('b', null, f.no_read ? 'Всё прочитано' : 'В папке пока нет чатов'),
    el('p', null, f.no_read ? 'Здесь появятся чаты с новыми сообщениями.' : 'Добавьте чаты или типы чатов в настройках папки.'));
  box.append(button('btn ghost small', 'Изменить папку', () => openFolderEditor(f.id)));
  return box;
}

// ---------------------------------------------------------------------------
// Редактор папки
// ---------------------------------------------------------------------------

type Draft = FolderDraft & { titleTouched: boolean };

/** Название по содержимому — пока его не ввели сами (как в Telegram). */
function autoTitle(d: Draft): string {
  if (d.include.length || !d.kinds.length) return d.no_read ? 'Непрочитанные' : '';
  if (d.kinds.length === 1) return FOLDER_KINDS.find((k) => k.k === d.kinds[0])!.label.replace('Личные чаты', 'Личные');
  if (d.kinds.length === FOLDER_KINDS.length && d.no_read) return 'Непрочитанные';
  return '';
}

/**
 * Создать папку (id = null) или изменить существующую.
 * preset — чаты, которые сразу положить в новую папку (из меню чата «Новая папка»).
 */
export function openFolderEditor(id: string | null, preset: Partial<FolderDraft> = {}): void {
  const f = folderById(id);
  if (!f && L.folders.length >= MAX_FOLDERS) { toast(`Можно создать не больше ${MAX_FOLDERS} папок`); return; }
  const d: Draft = f
    ? { id: f.id, title: f.title, emoji: f.emoji, kinds: [...f.kinds], include: [...f.include], exclude: [...f.exclude], no_read: f.no_read, titleTouched: true }
    : { id: null, title: '', emoji: null, kinds: [], include: [], exclude: [], no_read: false, titleTouched: false, ...preset };
  if (!d.titleTouched && !d.title) d.title = autoTitle(d);
  const dlg = $<HTMLDialogElement>('folderDlg');
  let iconsOpen = false;

  const draw = () => {
    const scroll = dlg.scrollTop;
    const head = dlgHead(f ? 'Изменить папку' : 'Новая папка', dlg);
    const form = el('form', 'fe');
    form.noValidate = true;

    // Значок и название
    const top = el('div', 'fe-top');
    const icBtn = button('fe-icon', null, () => { iconsOpen = !iconsOpen; draw(); });
    icBtn.dataset.k = 'icon';
    icBtn.textContent = folderIcon({ ...d, id: '', pinned: [] } as ChatFolder);
    icBtn.setAttribute('aria-label', 'Значок папки');
    icBtn.setAttribute('aria-expanded', String(iconsOpen));
    icBtn.title = 'Значок папки';
    const title = el('input', 'txt fe-title');
    title.id = 'folderTitle';
    title.maxLength = FOLDER_TITLE_MAX;
    title.placeholder = 'Название папки';
    title.setAttribute('aria-label', 'Название папки');
    title.autocomplete = 'off';
    title.value = d.title;
    title.addEventListener('input', () => { d.title = title.value; d.titleTouched = !!title.value.trim(); });
    top.append(icBtn, title);
    form.append(top);
    if (iconsOpen) {
      const grid = el('div', 'fe-icons');
      grid.setAttribute('role', 'listbox');
      grid.setAttribute('aria-label', 'Значок папки');
      const auto = button(`fe-ic auto${d.emoji ? '' : ' on'}`, 'Авто', () => { d.emoji = null; iconsOpen = false; draw(); });
      auto.title = 'Подобрать по содержимому';
      grid.append(auto);
      FOLDER_ICONS.forEach((e) => {
        const b = button(`fe-ic${d.emoji === e ? ' on' : ''}`, e, () => { d.emoji = e; iconsOpen = false; draw(); });
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(d.emoji === e));
        grid.append(b);
      });
      form.append(grid);
    }

    // Что в папке
    form.append(el('span', 'fld fe-fld', 'Чаты в папке'));
    const inc = el('div', 'ci-list');
    FOLDER_KINDS.forEach((k) => {
      const on = d.kinds.includes(k.k);
      inc.append(switchRow(`kind-${k.k}`, k.icon, k.label, on, () => {
        d.kinds = on ? d.kinds.filter((x) => x !== k.k) : [...d.kinds, k.k];
        if (!d.titleTouched) d.title = autoTitle(d);
        draw();
      }));
    });
    inc.append(addRow('inc', 'Выбрать чаты', d.include.length, () => openChatPicker('include', d, draw)));
    form.append(inc);
    if (d.include.length) form.append(chipList(d.include, (cid) => { d.include = d.include.filter((x) => x !== cid); draw(); }));

    // Исключения
    form.append(el('span', 'fld fe-fld', 'Исключить'));
    const exc = el('div', 'ci-list');
    exc.append(switchRow('noread', '✅', 'Прочитанные', d.no_read, () => {
      d.no_read = !d.no_read;
      if (!d.titleTouched) d.title = autoTitle(d);
      draw();
    }));
    exc.append(addRow('exc', 'Исключить чаты', d.exclude.length, () => openChatPicker('exclude', d, draw)));
    form.append(exc);
    if (d.exclude.length) form.append(chipList(d.exclude, (cid) => { d.exclude = d.exclude.filter((x) => x !== cid); draw(); }));

    form.append(el('p', 'hint fe-note', 'Папки видите только вы. Они одинаковые на телефоне и компьютере.'));

    const err = el('p', 'err');
    err.setAttribute('role', 'alert');
    const actions = el('div', 'dlg-actions fe-actions');
    if (f) {
      let armed = false;
      const del = button('btn danger fe-del', 'Удалить папку', async () => {
        if (!armed) { armed = true; del.textContent = 'Точно удалить?'; return; }
        del.disabled = true;
        try {
          await deleteFolder(f.id);
          closeDialog(dlg);
          toast(`Папка «${f.title}» удалена. Чаты остались на месте.`);
        } catch (e) {
          err.textContent = errText(e, 'Не получилось удалить папку.');
          del.disabled = false;
        }
      });
      actions.append(del);
    }
    const save = el('button', 'btn primary', f ? 'Сохранить' : 'Создать папку');
    save.type = 'submit';
    actions.append(button('btn ghost', 'Отмена', () => closeDialog(dlg)), save);
    form.append(err, actions);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      d.title = title.value.trim();
      if (!d.title) { err.textContent = 'Введите название папки.'; title.focus(); return; }
      if (!d.kinds.length && !d.include.length) { err.textContent = 'Добавьте в папку хотя бы один чат или тип чатов.'; return; }
      save.disabled = true;
      try {
        const newId = await saveFolder(d);
        closeDialog(dlg);
        if (!f) {
          setFolder(newId);
          toast(`Папка «${d.title}» создана`);
        }
      } catch (e) {
        err.textContent = errText(e, 'Не получилось сохранить папку.');
        save.disabled = false;
      }
    });
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.k;
    dlg.replaceChildren(head, form);
    dlg.scrollTop = scroll;
    if (focusKey) dlg.querySelector<HTMLElement>(`[data-k="${focusKey}"]`)?.focus({ preventScroll: true });
    return title;
  };
  const title = draw();
  openDialog(dlg);
  if (!touchMQ.matches && !d.title) title.focus();
}

function switchRow(key: string, icon: string, title: string, on: boolean, fn: () => void): HTMLButtonElement {
  const b = button('ci-row', null, fn);
  b.dataset.k = key;
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(on));
  const ic = el('span', 'ci-ic', icon);
  ic.setAttribute('aria-hidden', 'true');
  b.append(ic, el('span', 'ci-title', title), el('span', `ci-switch${on ? ' on' : ''}`));
  return b;
}

function addRow(key: string, title: string, count: number, fn: () => void): HTMLButtonElement {
  const b = button('ci-row fe-add', null, fn);
  b.dataset.k = key;
  const ic = el('span', 'ci-ic fe-add-ic');
  ic.append(html(ICONS.plus));
  ic.setAttribute('aria-hidden', 'true');
  b.append(ic, el('span', 'ci-title', title));
  if (count) b.append(el('span', 'ci-val', String(count)));
  const chev = el('span', 'ci-chev');
  chev.append(html(ICONS.next));
  b.append(chev);
  return b;
}

/** Выбранные (или исключённые) чаты — плашками с крестиком. */
function chipList(ids: string[], remove: (id: string) => void): HTMLElement {
  const box = el('div', 'fe-chips');
  ids.forEach((id) => {
    const c = S.chats.get(id);
    if (!c) return;
    const chip = el('span', 'fe-chip');
    chip.append(env.chatTile(c, 'mini'), el('span', 'fe-chip-t', env.chatTitle(c)));
    const x = button('fe-chip-x', null, () => remove(id));
    x.append(html(ICONS.close));
    x.setAttribute('aria-label', `Убрать: ${env.chatTitle(c)}`);
    chip.append(x);
    box.append(chip);
  });
  return box;
}

// ---------------------------------------------------------------------------
// Выбор чатов для папки
// ---------------------------------------------------------------------------

function kindLabel(c: MyChat): string {
  return c.kind === 'direct' ? 'личный чат' : c.kind === 'bot' ? 'бот' : c.kind === 'channel' ? 'канал'
    : plural(c.member_count, 'участник', 'участника', 'участников');
}

function openChatPicker(mode: 'include' | 'exclude', d: Draft, done: () => void): void {
  const dlg = $<HTMLDialogElement>('folderPickDlg');
  const picked = new Set(mode === 'include' ? d.include : d.exclude);
  const head = dlgHead(mode === 'include' ? 'Выбрать чаты' : 'Исключить чаты', dlg);
  const q = el('input', 'txt pick-q');
  q.type = 'search';
  q.placeholder = 'Поиск чата';
  q.setAttribute('aria-label', 'Поиск чата');
  q.autocomplete = 'off';
  const list = el('div', 'pick-list');
  const count = el('span', 'fe-pick-count');
  const ok = el('button', 'btn primary', 'Готово');
  ok.type = 'button';
  const all = listChats(null);
  const fill = () => {
    const needle = searchNorm(q.value);
    const rows = all.filter((c) => !needle || searchNorm(env.chatTitle(c)).includes(needle));
    if (!rows.length) { list.replaceChildren(el('p', 'list-empty', 'Такого чата нет')); return; }
    list.replaceChildren(...rows.map((c) => {
      const row = el('label', 'pick-row');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = picked.has(c.id);
      box.addEventListener('change', () => {
        if (box.checked) {
          if (picked.size >= MAX_FOLDER_CHATS) { box.checked = false; toast(`Не больше ${MAX_FOLDER_CHATS} чатов`); return; }
          picked.add(c.id);
        } else picked.delete(c.id);
        renderCount();
      });
      const text = el('span', 'pr-text');
      text.append(el('span', 'nm', env.chatTitle(c)), el('span', 'st', kindLabel(c)));
      row.append(env.chatTile(c, 'small'), text, box);
      return row;
    }));
  };
  const renderCount = () => { count.textContent = picked.size ? plural(picked.size, 'чат выбран', 'чата выбрано', 'чатов выбрано') : ''; };
  q.addEventListener('input', fill);
  ok.addEventListener('click', () => {
    const ids = all.map((c) => c.id).filter((id) => picked.has(id));
    if (mode === 'include') {
      d.include = ids;
      d.exclude = d.exclude.filter((x) => !picked.has(x));
    } else {
      d.exclude = ids;
      d.include = d.include.filter((x) => !picked.has(x));
    }
    if (!d.titleTouched) d.title = autoTitle(d);
    closeDialog(dlg);
    done();
  });
  fill();
  renderCount();
  const actions = el('div', 'dlg-actions fe-pick-actions');
  actions.append(count, button('btn ghost', 'Отмена', () => closeDialog(dlg)), ok);
  dlg.replaceChildren(head, q, list, actions);
  openDialog(dlg);
  if (!touchMQ.matches) q.focus();
}

// ---------------------------------------------------------------------------
// «Папки с чатами»: мои папки, порядок, рекомендуемые
// ---------------------------------------------------------------------------

type Suggest = { title: string; emoji: string | null; kinds: FolderKind[]; no_read: boolean; text: string };
const SUGGESTED: Suggest[] = [
  { title: 'Непрочитанные', emoji: null, kinds: ['direct', 'group', 'channel', 'bot'], no_read: true, text: 'Новые сообщения из всех чатов' },
  { title: 'Личные', emoji: '👤', kinds: ['direct', 'bot'], no_read: false, text: 'Только переписка с людьми и ботом' },
  { title: 'Группы', emoji: null, kinds: ['group'], no_read: false, text: 'Все группы' },
  { title: 'Каналы', emoji: null, kinds: ['channel'], no_read: false, text: 'Все каналы' },
];

function sameAs(f: ChatFolder, s: Suggest): boolean {
  return !f.include.length && f.no_read === s.no_read && f.kinds.length === s.kinds.length && s.kinds.every((k) => f.kinds.includes(k));
}

export function openFolderSettings(): void {
  const dlg = $<HTMLDialogElement>('foldersDlg');
  const draw = () => {
    const head = dlgHead('Папки с чатами', dlg);
    const lead = el('p', 'hint fs-lead',
      'Раскладывайте чаты по папкам, чтобы быстрее находить нужное. На компьютере папки — слева от списка чатов, на телефоне — вкладками сверху.');
    const create = button('btn primary btn-ic fs-create', null, () => openFolderEditor(null));
    create.append(html(ICONS.folderAdd), 'Создать папку');
    create.disabled = L.folders.length >= MAX_FOLDERS;
    const body = el('div', 'fs-body');
    body.append(lead, create);
    if (L.folders.length) {
      body.append(el('span', 'fld fe-fld', `Мои папки · ${L.folders.length}`));
      const list = el('div', 'ci-list fs-list');
      L.folders.forEach((f, i) => {
        const row = el('div', 'fs-row');
        const open = button('fs-open', null, () => openFolderEditor(f.id));
        const ic = el('span', 'ci-ic', folderIcon(f));
        ic.setAttribute('aria-hidden', 'true');
        const text = el('span', 'fs-text');
        text.append(el('span', 'fs-t', f.title), el('span', 'fs-sub', folderSummary(f)));
        open.append(ic, text);
        open.setAttribute('aria-label', `Изменить папку «${f.title}»`);
        const move = (dir: -1 | 1) => {
          const ids = L.folders.map((x) => x.id);
          const j = i + dir;
          [ids[i], ids[j]] = [ids[j], ids[i]];
          reorderFolders(ids).then(draw, (e) => toast(errText(e, 'Не получилось поменять порядок папок.')));
          draw();
        };
        const up = button('icon-btn fs-move', null, () => move(-1));
        up.append(html(ICONS.up));
        up.setAttribute('aria-label', `Выше: ${f.title}`);
        up.disabled = i === 0;
        const down = button('icon-btn fs-move', null, () => move(1));
        down.append(html(ICONS.down));
        down.setAttribute('aria-label', `Ниже: ${f.title}`);
        down.disabled = i === L.folders.length - 1;
        row.append(open, up, down);
        list.append(row);
      });
      body.append(list);
    }
    const sugg = SUGGESTED.filter((s) => !L.folders.some((f) => sameAs(f, s)));
    if (sugg.length && L.folders.length < MAX_FOLDERS) {
      body.append(el('span', 'fld fe-fld', 'Рекомендуемые'));
      const list = el('div', 'ci-list fs-list');
      sugg.forEach((s) => {
        const row = el('div', 'fs-row');
        const ic = el('span', 'ci-ic', s.emoji ?? folderIcon({ ...s, id: '', include: [], exclude: [], pinned: [] } as ChatFolder));
        ic.setAttribute('aria-hidden', 'true');
        const text = el('span', 'fs-text');
        text.append(el('span', 'fs-t', s.title), el('span', 'fs-sub', s.text));
        const add = button('btn ghost small', 'Добавить', async () => {
          add.disabled = true;
          try {
            await saveFolder({ id: null, title: s.title, emoji: s.emoji, kinds: s.kinds, include: [], exclude: [], no_read: s.no_read });
            toast(`Папка «${s.title}» добавлена`);
            draw();
          } catch (e) {
            toast(errText(e, 'Не получилось добавить папку.'));
            add.disabled = false;
          }
        });
        add.setAttribute('aria-label', `Добавить папку «${s.title}»`);
        const wrap = el('div', 'fs-open static');
        wrap.append(ic, text);
        row.append(wrap, add);
        list.append(row);
      });
      body.append(list);
    }
    if (wideMQ.matches && L.folders.length > 1) body.append(el('p', 'hint', 'Порядок папок можно менять и перетаскиванием в полосе слева.'));
    dlg.replaceChildren(head, body);
  };
  draw();
  openDialog(dlg);
  // Пока окно открыто, изменения (создали папку в редакторе) сразу видны.
  const redraw = () => { if (dlg.open) draw(); };
  document.addEventListener('skam:layout', redraw);
  dlg.addEventListener('close', () => document.removeEventListener('skam:layout', redraw), { once: true });
}

/** Папки поменялись: обновить открытое окно «Папки с чатами». */
export function layoutChanged(): void {
  document.dispatchEvent(new Event('skam:layout'));
}

/** В каких папках чат (для меню чата «Добавить в папку»). */
export function foldersOf(c: MyChat): { f: ChatFolder; on: boolean }[] {
  return L.folders.map((f) => ({ f, on: f.pinned.includes(c.id) || (!f.exclude.includes(c.id) && (f.include.includes(c.id) || f.kinds.includes(c.kind as FolderKind))) }));
}

