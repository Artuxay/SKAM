// Приложение СКАМ для Windows (папка desktop/, Electron) открывает этот же сайт в своём окне и
// сообщает о себе через window.skamDesktop. Здесь — узнать, что мы в приложении, и ссылка на установщик.

export type DesktopInfo = {
  /** Версия приложения (может отставать от версии сайта — сайт обновляется сам). */
  version: string;
  platform: string;
  /** Рация работает и когда окно СКАМ не в фокусе. */
  pttEverywhere: boolean;
  /** При показе экрана можно передать звук всего компьютера. */
  systemAudio: boolean;
};

export const desktop: DesktopInfo | null =
  (globalThis as { skamDesktop?: DesktopInfo }).skamDesktop ?? null;

/** Установщик последней версии — его собирает GitHub Actions (.github/workflows/desktop.yml). */
export const WINDOWS_APP_URL = 'https://github.com/Artuxay/SKAM/releases/latest/download/SKAM-Setup.exe';

/** Предлагать скачать приложение: открыто в браузере на компьютере с Windows. */
export function offerWindowsApp(): boolean {
  if (desktop || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Windows NT/.test(ua) && !/Mobile|Phone|Xbox/.test(ua);
}

/** Ссылка «Скачать СКАМ для Windows». */
export function windowsAppLink(text = 'СКАМ для Windows'): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = WINDOWS_APP_URL;
  a.rel = 'noopener';
  a.textContent = text;
  a.title = 'Скачать установщик (около 90 МБ)';
  return a;
}
