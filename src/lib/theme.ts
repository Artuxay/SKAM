// Светлая / тёмная тема: «Авто» следует системе, выбор хранится в localStorage.
import { lsGet, lsSet } from './dom';

export type Theme = 'auto' | 'light' | 'dark';
const KEY = 'skam:theme';
const PAPER = { light: '#E9E2D5', dark: '#070708' };

export function getTheme(): Theme {
  const t = lsGet(KEY);
  return t === 'light' || t === 'dark' ? t : 'auto';
}

export function applyTheme(t: Theme = getTheme()): void {
  const root = document.documentElement;
  if (t === 'auto') delete root.dataset.theme;
  else root.dataset.theme = t;
  // Цвет строки состояния на телефоне.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const media = m.getAttribute('media') ?? '';
    const sys = media.includes('dark') ? 'dark' : 'light';
    m.content = PAPER[t === 'auto' ? sys : t];
  });
}

export function setTheme(t: Theme): void {
  lsSet(KEY, t === 'auto' ? null : t);
  applyTheme(t);
}
