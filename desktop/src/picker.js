'use strict';
// Окно «Показать экран»: экраны и окна с миниатюрами, звук компьютера, «Показать» / «Отмена».
(async () => {
  const $ = (id) => document.getElementById(id);
  const grid = $('grid');
  const share = $('share');
  const audioBtn = $('audio');
  const data = (await window.picker.data()) || { items: [], audio: false };
  const items = data.items || [];
  const by = { screen: items.filter((s) => s.kind === 'screen'), window: items.filter((s) => s.kind === 'window') };
  let kind = 'screen';
  let selected = null;
  let audio = !!data.audio;

  $('nScreen').textContent = by.screen.length ? String(by.screen.length) : '';
  $('nWindow').textContent = by.window.length ? String(by.window.length) : '';
  if (data.audio) audioBtn.hidden = false;

  function paintAudio() {
    audioBtn.setAttribute('aria-checked', String(audio));
    audioBtn.querySelector('.sw').classList.toggle('on', audio);
  }

  function card(s) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'src';
    b.setAttribute('role', 'option');
    b.dataset.id = s.id;
    b.setAttribute('aria-selected', String(selected === s.id));
    b.title = s.name;
    const shot = document.createElement('span');
    shot.className = 'shot';
    if (s.thumb) {
      const img = document.createElement('img');
      img.src = s.thumb;
      img.alt = '';
      shot.append(img);
    }
    const cap = document.createElement('span');
    cap.className = 'cap';
    if (s.icon) {
      const ic = document.createElement('img');
      ic.src = s.icon;
      ic.alt = '';
      cap.append(ic);
    }
    const nm = document.createElement('span');
    nm.textContent = s.name;
    cap.append(nm);
    b.append(shot, cap);
    b.addEventListener('click', () => select(s.id));
    b.addEventListener('dblclick', () => { select(s.id); go(); });
    return b;
  }

  function render() {
    for (const t of document.querySelectorAll('.seg button')) t.setAttribute('aria-selected', String(t.dataset.kind === kind));
    const list = by[kind];
    grid.replaceChildren(...list.map(card));
    $('empty').hidden = list.length > 0;
    grid.hidden = list.length === 0;
    share.disabled = !selected;
  }

  function select(id) {
    selected = id;
    for (const b of grid.querySelectorAll('.src')) b.setAttribute('aria-selected', String(b.dataset.id === id));
    share.disabled = !selected;
    grid.querySelector(`.src[aria-selected="true"]`)?.focus();
  }

  function setKind(k) {
    if (k === kind) return;
    kind = k;
    // Экран — сразу первый (главный); окно — пусть выберут сами.
    selected = k === 'screen' && by.screen.length ? by.screen[0].id : by[k].length === 1 ? by[k][0].id : null;
    render();
  }

  function go() {
    if (selected) window.picker.choose(selected, audio);
  }

  for (const t of document.querySelectorAll('.seg button')) t.addEventListener('click', () => setKind(t.dataset.kind));
  audioBtn.addEventListener('click', () => { audio = !audio; paintAudio(); });
  $('cancel').addEventListener('click', () => window.picker.cancel());
  share.addEventListener('click', go);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); window.picker.cancel(); return; }
    if (e.key === 'Enter' && selected && !(e.target instanceof HTMLButtonElement && !e.target.classList.contains('src'))) { e.preventDefault(); go(); return; }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      const cards = [...grid.querySelectorAll('.src')];
      if (!cards.length) return;
      const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length);
      let i = cards.findIndex((c) => c.dataset.id === selected);
      if (i < 0) i = 0;
      else if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
      else if (e.key === 'ArrowRight') i = Math.min(cards.length - 1, i + 1);
      else if (e.key === 'ArrowUp') i = Math.max(0, i - cols);
      else i = Math.min(cards.length - 1, i + cols);
      e.preventDefault();
      select(cards[i].dataset.id);
    }
  });

  // Один экран — сразу выбран, можно жать «Показать». Экранов нет (так бывает в Linux) — открываем окна.
  if (!by.screen.length && by.window.length) kind = 'window';
  if (kind === 'screen' ? by.screen.length : by.window.length === 1) selected = by[kind][0].id;
  paintAudio();
  render();
  (grid.querySelector('.src[aria-selected="true"]') || share).focus();
})();
