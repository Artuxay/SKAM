// Столбчатый график по дням для страницы /admin/: один ряд, своё SVG без библиотек.
// Столбик не толще 24 px, скруглён сверху на 4 px; подписи — цветом текста, не цветом данных.
// Наведение (или стрелки с клавиатуры) показывает подсказку: значение крупно, дата ниже.
// Подписано только самое большое значение — остальные видны в подсказке и в таблице под графиком.

export type Point = { day: string; value: number | null };

const NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** Круглые деления оси: 0, шаг 1/2/5 × 10ⁿ, не больше пяти делений. Счётчики — целые. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag);
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v));
  return ticks;
}

export function compact(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)} тыс.`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.', ',').replace(',0', '')} тыс.`;
  return String(n);
}

const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'short', timeZone: 'UTC' });
const shortFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });

export function dayLong(day: string): string {
  return dayFmt.format(new Date(`${day}T00:00:00Z`));
}
export function dayShort(day: string): string {
  return shortFmt.format(new Date(`${day}T00:00:00Z`));
}

/** Путь столбика: прямой низ, скруглённый верх. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Рисует график в host и перерисовывает при изменении ширины.
 * Возвращает функцию, которая снимает наблюдатель (при следующей отрисовке страницы).
 */
export function columnChart(
  host: HTMLElement,
  pts: Point[],
  o: { unit: (n: number) => string; label: string },
): () => void {
  host.classList.add('ch');
  host.tabIndex = 0;
  host.setAttribute('role', 'img');
  const total = pts.reduce((s, p) => s + (p.value ?? 0), 0);
  host.setAttribute('aria-label', `${o.label} по дням: всего ${total}. Стрелки влево и вправо — значения по дням.`);

  const tip = document.createElement('div');
  tip.className = 'ch-tip';
  tip.hidden = true;
  const tipV = document.createElement('strong');
  const tipD = document.createElement('span');
  tip.append(tipV, tipD);

  let active = -1;
  let layout: { x0: number; band: number; bw: number; top: number; baseY: number; scale: (v: number) => number } | null = null;
  let bars: SVGPathElement[] = [];

  function show(i: number): void {
    if (!layout || i < 0 || i >= pts.length) { hide(); return; }
    active = i;
    bars.forEach((b, j) => b.classList.toggle('on', j === i));
    const p = pts[i];
    tipV.textContent = p.value == null ? 'нет данных' : o.unit(p.value);
    tipD.textContent = dayLong(p.day);
    tip.hidden = false;
    const cx = layout.x0 + layout.band * i + layout.band / 2;
    const y = p.value == null ? layout.baseY : layout.scale(p.value);
    const w = tip.offsetWidth;
    const left = Math.max(0, Math.min(host.clientWidth - w, cx - w / 2));
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
  }

  function hide(): void {
    active = -1;
    tip.hidden = true;
    bars.forEach((b) => b.classList.remove('on'));
  }

  function draw(): void {
    const W = Math.max(240, host.clientWidth);
    const H = W < 520 ? 190 : 230;
    const padL = 34;
    const padR = 6;
    const padT = 22;
    const padB = 24;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const vals = pts.map((p) => p.value ?? 0);
    const max = Math.max(0, ...vals);
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const scale = (v: number) => padT + plotH - (v / top) * plotH;
    const band = plotW / Math.max(1, pts.length);
    const bw = Math.max(1, Math.min(24, band - 2));
    layout = { x0: padL, band, bw, top, baseY: padT + plotH, scale };

    const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
    // Сетка и деления оси Y
    for (const t of ticks) {
      const y = Math.round(scale(t)) + 0.5;
      s.append(svg('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: t === 0 ? 'ch-base' : 'ch-grid' }));
      const lab = svg('text', { x: padL - 8, y: y + 4, 'text-anchor': 'end', class: 'ch-axis' });
      lab.textContent = compact(t);
      s.append(lab);
    }
    // Подписи дат: первая, последняя и равномерно между ними, чтобы не налезали
    const every = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(plotW / 64))));
    pts.forEach((p, i) => {
      const last = i === pts.length - 1;
      if (i % every !== 0 && !last) return;
      if (!last && pts.length - 1 - i < every * 0.6) return; // не прижимать к последней
      const lab = svg('text', { x: padL + band * i + band / 2, y: H - 6, 'text-anchor': 'middle', class: 'ch-axis' });
      lab.textContent = last ? 'сегодня' : dayShort(p.day);
      s.append(lab);
    });
    // Столбики
    bars = pts.map((p, i) => {
      const v = p.value;
      const x = padL + band * i + (band - bw) / 2;
      if (v == null || v <= 0) {
        const path = svg('path', { d: '', class: 'ch-bar' });
        s.append(path);
        if (v == null) s.append(svg('circle', { cx: x + bw / 2, cy: padT + plotH - 3, r: Math.min(2, bw / 2 + 0.5), class: 'ch-none' }));
        return path;
      }
      const y = scale(v);
      const h = Math.max(1.5, padT + plotH - y);
      const path = svg('path', { d: barPath(x, padT + plotH - h, bw, h), class: 'ch-bar' });
      s.append(path);
      return path;
    });
    // Подпись максимума
    if (max > 0) {
      const i = vals.lastIndexOf(max);
      const lab = svg('text', { x: padL + band * i + band / 2, y: scale(max) - 7, 'text-anchor': 'middle', class: 'ch-max' });
      lab.textContent = compact(max);
      s.append(lab);
    }
    // Зоны наведения — вся полоса дня во всю высоту (больше самого столбика)
    pts.forEach((_, i) => {
      const hit = svg('rect', { x: padL + band * i, y: 0, width: band, height: H - padB + 4, class: 'ch-hit' });
      hit.addEventListener('pointerenter', () => show(i));
      hit.addEventListener('pointerdown', () => show(i));
      s.append(hit);
    });
    s.addEventListener('pointerleave', hide);

    host.replaceChildren(s, tip);
    if (active >= 0) show(active);
  }

  host.onkeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const last = pts.length - 1;
    let i = active < 0 ? last : active;
    if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    if (e.key === 'ArrowRight') i = Math.min(last, i + 1);
    if (e.key === 'Home') i = 0;
    if (e.key === 'End') i = last;
    show(i);
  };
  host.onfocus = () => { if (active < 0) show(pts.length - 1); };
  host.onblur = hide;

  draw();
  let lastW = host.clientWidth;
  const ro = new ResizeObserver(() => {
    if (Math.abs(host.clientWidth - lastW) < 2) return;
    lastW = host.clientWidth;
    draw();
  });
  ro.observe(host);
  return () => ro.disconnect();
}
