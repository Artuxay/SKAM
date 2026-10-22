'use strict';
// СКАМ для Windows — главный процесс.
// Окно открывает сайт https://skam-messenger.ru: интерфейс, шифрование и вход те же, что в браузере,
// и обновляются вместе с сайтом. Приложение добавляет то, чего не умеет вкладка браузера:
// значок в трее (СКАМ работает и с закрытым окном — сообщения и звонки приходят), уведомления Windows,
// число непрочитанных на панели задач, рацию в других окнах, свой выбор экрана со звуком компьютера,
// запуск вместе с Windows и проверку новых версий.
const {
  app, BrowserWindow, Tray, Menu, Notification, nativeImage, nativeTheme, shell, session,
  ipcMain, desktopCapturer, net, clipboard, screen,
} = require('electron');
const path = require('node:path');
const { Settings } = require('./settings');
const { PttWatcher } = require('./ptt');

const IS_WIN = process.platform === 'win32';
const APP_ID = 'ru.skam-messenger.desktop';
const ASSETS = path.join(__dirname, '..', 'assets');
const RELEASES = 'https://github.com/Artuxay/SKAM/releases/latest';

function argValue(name) {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : null;
}

// --url=… и --profile=… — для проверки приложения с тестовым сервером и отдельной папкой данных.
const APP_URL = new URL(argValue('url') || process.env.SKAM_URL || 'https://skam-messenger.ru/');
const ORIGIN = APP_URL.origin;
const UPDATE_URL = new URL('desktop.json', APP_URL).href;
const START_HIDDEN = process.argv.includes('--hidden');
const PROFILE = argValue('profile') || process.env.SKAM_PROFILE || null;

// Вход через Яндекс ID и VK ID идёт в этом же окне: провайдер возвращает на skam-messenger.ru.
const SIGN_IN_HOSTS = ['yandex.ru', 'yandex.com', 'ya.ru', 'vk.ru', 'vk.com', 'vkontakte.ru', 'mail.ru', 'ok.ru'];

// Что сайт СКАМ может попросить: микрофон и камера, уведомления, показ экрана, буфер обмена, полный экран.
const ALLOWED_PERMISSIONS = new Set([
  'media', 'notifications', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write',
  'fullscreen', 'pointerLock', 'speaker-selection', 'persistent-storage',
]);

app.setPath('userData', PROFILE ? path.resolve(PROFILE) : path.join(app.getPath('appData'), 'SKAM'));
if (IS_WIN) app.setAppUserModelId(APP_ID);
// Звонок должен звенеть, даже если СКАМ запустился вместе с Windows и окно ещё ни разу не открывали.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Обычный Chrome плюс «SKAM-Desktop/версия»: сайт узнаёт приложение, а Яндекс и VK видят обычный браузер.
{
  const chrome = (process.versions.chrome || '0').split('.')[0];
  const os = IS_WIN ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  app.userAgentFallback = `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36 SKAM-Desktop/${app.getVersion()}`;
}

/** @type {Settings} */
let settings;
/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
let pendingMaximize = false;
let unread = 0;
let ringing = false;
let update = null;
let pttCode = null;
let ptt = null;
const pickers = new Map();
const toasts = new Map();
const TEST = process.env.SKAM_TEST === '1';
const testLog = [];
let trayItems = [];

// ---------------------------------------------------------------------------
// Картинки
// ---------------------------------------------------------------------------

const imageCache = new Map();
function image(name) {
  if (!imageCache.has(name)) imageCache.set(name, nativeImage.createFromPath(path.join(ASSETS, name)));
  return imageCache.get(name);
}
const appIcon = () => image(IS_WIN ? 'icon.ico' : 'icon.png');
const trayIcon = (dot) => image(IS_WIN ? (dot ? 'tray-unread.ico' : 'tray.ico') : (dot ? 'tray-unread.png' : 'tray.png'));
const badgeIcon = (n) => image(`badge/${n > 9 ? '9plus' : n}.png`);

/** Цвет подложки окна до загрузки сайта — как фон СКАМ, чтобы не мигало белым. */
const paper = () => (nativeTheme.shouldUseDarkColors ? '#000000' : '#EEEEEE');

// ---------------------------------------------------------------------------
// Адреса
// ---------------------------------------------------------------------------

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function sameOrigin(url) {
  const u = typeof url === 'string' ? parse(url) : null;
  return !!u && u.origin === ORIGIN;
}

function isSignInHost(host) {
  return SIGN_IN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Страницы сайта, которые открываются отдельным окном: статьи, документы. Остальное — само приложение. */
function isSitePage(u) {
  const p = u.pathname;
  return p !== '/' && p !== '/index.html';
}

function openOutside(url) {
  const u = parse(url);
  if (!u || !['http:', 'https:', 'mailto:', 'tel:'].includes(u.protocol)) return;
  shell.openExternal(u.href).catch(() => {});
}

// ---------------------------------------------------------------------------
// Главное окно
// ---------------------------------------------------------------------------

function initialBounds() {
  const def = { width: 1180, height: 780 };
  const b = settings.get('bounds');
  if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return def;
  const size = { width: Math.max(360, b.width), height: Math.max(520, b.height) };
  // Окно должно хоть частью попасть на один из экранов (второй монитор могли отключить).
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y < a.y + a.height - 40 && b.y >= a.y - 20);
  return visible ? { ...size, x: b.x, y: b.y } : size;
}

function createWindow() {
  win = new BrowserWindow({
    ...initialBounds(),
    minWidth: 360,
    minHeight: 520,
    show: false,
    title: 'СКАМ',
    icon: appIcon(),
    backgroundColor: paper(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Звонок, рация и «печатает…» работают и в свёрнутом окне.
      backgroundThrottling: false,
      spellcheck: true,
      additionalArguments: [`--skam-version=${app.getVersion()}`],
    },
  });
  pendingMaximize = !!settings.get('maximized');

  win.once('ready-to-show', () => {
    if (!START_HIDDEN) showWindow();
  });

  const saveBounds = debounce(() => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    if (!win.isMaximized()) settings.set('bounds', win.getNormalBounds());
  }, 500);
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('maximize', () => settings.set('maximized', true));
  win.on('unmaximize', () => settings.set('maximized', false));

  win.on('focus', () => {
    win.flashFrame(false);
    updatePtt();
  });
  win.on('blur', updatePtt);
  win.on('show', updatePtt);
  win.on('hide', updatePtt);

  win.on('close', (e) => {
    if (quitting || !settings.get('closeToTray') || !tray) return;
    e.preventDefault();
    if (win.isFullScreen()) win.setFullScreen(false);
    win.hide();
    if (!settings.get('trayHintShown')) {
      settings.set('trayHintShown', true);
      toast('СКАМ работает в трее', 'Сообщения и звонки будут приходить. Закрыть полностью — правой кнопкой по значку СКАМ возле часов.', showWindow);
    }
  });
  win.on('closed', () => {
    win = null;
    if (!quitting) app.quit();
  });

  win.on('page-title-updated', (_e, title) => onTitle(title));

  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    // -3 — загрузку прервали (переход на другую страницу), это не ошибка.
    if (!isMain || code === -3 || !/^https?:/.test(url)) return;
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { u: url } }).catch(() => {});
  });
  wc.on('did-finish-load', () => {
    if (sameOrigin(wc.getURL())) wc.setZoomLevel(Number(settings.get('zoom')) || 0);
  });
  wc.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(APP_URL.href).catch(() => {}); }, 1000);
  });

  win.loadURL(APP_URL.href).catch(() => { /* did-fail-load покажет «Нет связи» */ });
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (pendingMaximize) {
    pendingMaximize = false;
    win.maximize();
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused() && !win.isMinimized()) win.hide();
  else showWindow();
}

// ---------------------------------------------------------------------------
// Непрочитанные и входящий звонок — сайт пишет их в заголовок: «(3) СКАМ», «📞 Входящий звонок — СКАМ»
// ---------------------------------------------------------------------------

function onTitle(title) {
  const ring = title.startsWith('📞');
  if (!ring) {
    const m = /^\((\d+)\)\s/.exec(title);
    const n = m ? Number(m[1]) : 0;
    if (n !== unread) {
      unread = n;
      updateBadge();
    }
  }
  if (ring !== ringing) {
    ringing = ring;
    if (ring) onRing();
    else if (win) win.flashFrame(false);
  }
}

function updateBadge() {
  if (win && !win.isDestroyed()) {
    if (IS_WIN) win.setOverlayIcon(unread ? badgeIcon(unread) : null, unread ? `Непрочитанных: ${unread}` : '');
    else app.setBadgeCount(unread);
  }
  if (tray) {
    tray.setImage(trayIcon(unread > 0));
    tray.setToolTip(unread ? `СКАМ — непрочитанных: ${unread}` : 'СКАМ');
  }
}

/** Входящий звонок: показываем окно, не отбирая фокус, и мигаем кнопкой на панели задач. */
function onRing() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) {
    if (pendingMaximize) {
      pendingMaximize = false;
      win.maximize();
    }
    win.showInactive();
  }
  if (!win.isFocused()) win.flashFrame(true);
}

// ---------------------------------------------------------------------------
// Трей
// ---------------------------------------------------------------------------

const LOGIN_ARGS = ['--hidden'];
function autostart() {
  try {
    return app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin;
  } catch {
    return false;
  }
}

function setAutostart(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: on, args: LOGIN_ARGS });
  } catch { /* нет прав — галочка просто не встанет */ }
  refreshTrayMenu();
}

function createTray() {
  try {
    tray = new Tray(trayIcon(false));
  } catch (e) {
    console.error('[tray]', e && e.message);
    tray = null;
    return;
  }
  tray.setToolTip('СКАМ');
  tray.on('click', toggleWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const items = [
    { label: 'Открыть СКАМ', click: showWindow },
    { type: 'separator' },
    { label: 'Запускать вместе с Windows', type: 'checkbox', checked: autostart(), click: (it) => setAutostart(it.checked) },
    {
      label: 'Сворачивать в трей при закрытии', type: 'checkbox', checked: !!settings.get('closeToTray'),
      click: (it) => { settings.set('closeToTray', it.checked); refreshTrayMenu(); },
    },
    { type: 'separator' },
    update
      ? { label: `Скачать СКАМ ${update.version}`, click: () => openOutside(update.url) }
      : { label: 'Проверить обновления', click: () => checkUpdates(true) },
    { label: `СКАМ для Windows ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Закрыть СКАМ', click: () => app.quit() },
  ];
  trayItems = items;
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------------------------------------------------------------------------
// Уведомления Windows
// ---------------------------------------------------------------------------

/** Уведомление от самого приложения (трей, обновления, загрузки). */
function toast(title, body, onClick) {
  if (TEST) testLog.push({ kind: 'toast', title, body });
  if (!Notification.isSupported() && !TEST) return;
  const n = new Notification({ title, body, icon: appIcon(), silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}

/** Уведомление о сообщении от сайта: сайт вызывает showNotification, preload присылает сюда. */
function showSiteNotification(sender, p) {
  if ((!Notification.isSupported() && !TEST) || !p || typeof p !== 'object') return false;
  const tag = typeof p.tag === 'string' ? p.tag.slice(0, 120) : '';
  const prev = tag && toasts.get(tag);
  if (prev) prev.close();
  let icon = appIcon();
  if (typeof p.icon === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(p.icon) && p.icon.length < 3e6) {
    const img = nativeImage.createFromDataURL(p.icon);
    if (!img.isEmpty()) icon = img.resize({ width: 96, height: 96, quality: 'best' });
  }
  const n = new Notification({
    title: String(p.title || 'СКАМ').slice(0, 200),
    body: String(p.body || '').slice(0, 600),
    icon,
    silent: !!p.silent,
  });
  const data = p.data && typeof p.data === 'object' && typeof p.data.chat === 'string' ? { chat: p.data.chat.slice(0, 64) } : null;
  n.on('click', () => {
    showWindow();
    if (!sender.isDestroyed()) sender.send('notification-click', data);
  });
  n.on('close', () => { if (toasts.get(tag) === n) toasts.delete(tag); });
  if (tag) toasts.set(tag, n);
  if (TEST) testLog.push({ kind: 'site', title: n.title, body: n.body, tag, silent: !!p.silent, icon: icon !== appIcon(), data });
  n.show();
  return true;
}

// ---------------------------------------------------------------------------
// Показ экрана: свой выбор экрана или окна, звук компьютера (Windows)
// ---------------------------------------------------------------------------

async function onDisplayMedia(request, callback) {
  let done = false;
  const reply = (v) => {
    if (done) return;
    done = true;
    try { callback(v); } catch (e) { console.error('[screen]', e && e.message); }
  };
  try {
    if (!sameOrigin(request.securityOrigin)) return reply(null);
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 300 },
      fetchWindowIcons: true,
    });
    // Своё окно не предлагаем — получится зеркало в зеркале.
    const own = new Set(BrowserWindow.getAllWindows().map((w) => { try { return w.getMediaSourceId(); } catch { return ''; } }));
    const screens = sources.filter((s) => s.id.startsWith('screen:'));
    const items = sources.filter((s) => !own.has(s.id)).map((s) => {
      const isScreen = s.id.startsWith('screen:');
      const thumb = s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '';
      return {
        id: s.id,
        kind: isScreen ? 'screen' : 'window',
        name: isScreen ? (screens.length > 1 ? `Экран ${screens.indexOf(s) + 1}` : 'Весь экран') : s.name,
        thumb,
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.resize({ width: 32, height: 32 }).toDataURL() : '',
      };
    }).filter((s) => s.kind === 'screen' || (s.thumb && s.name));
    const parent = win && !win.isDestroyed() ? win : null;
    const choice = await pickSource(items, { audio: !!request.audioRequested && IS_WIN, parent });
    const src = choice && sources.find((s) => s.id === choice.id);
    if (!src) return reply(null);
    reply(choice.audio ? { video: src, audio: 'loopback' } : { video: src });
  } catch (e) {
    console.error('[screen]', e && e.message);
    reply(null);
  }
}

function pickSource(items, { audio, parent }) {
  return new Promise((resolve) => {
    const pw = new BrowserWindow({
      parent: parent || undefined,
      modal: !!parent,
      width: 860,
      height: 640,
      minWidth: 520,
      minHeight: 420,
      show: false,
      title: 'Показать экран',
      icon: appIcon(),
      backgroundColor: paper(),
      autoHideMenuBar: true,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'picker-preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const id = pw.webContents.id;
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      pickers.delete(id);
      resolve(v);
      if (!pw.isDestroyed()) pw.close();
    };
    pickers.set(id, { items, audio, finish });
    pw.on('closed', () => finish(null));
    pw.once('ready-to-show', () => pw.show());
    pw.loadFile(path.join(__dirname, 'picker.html')).catch(() => finish(null));
  });
}

// ---------------------------------------------------------------------------
// Рация в других окнах и тема
// ---------------------------------------------------------------------------

function updatePtt() {
  if (!ptt) return;
  const active = !!win && !win.isDestroyed() && !win.isFocused();
  ptt.configure({ code: pttCode, active });
}

function applyState(s) {
  if (!s || typeof s !== 'object') return;
  // Клавишу рации слушаем только во время звонка и только в режиме «Рация».
  const code = s.mode === 'ptt' && s.call === true ? (typeof s.ptt === 'string' && s.ptt ? s.ptt : 'KeyV') : null;
  if (code !== pttCode) {
    pttCode = code;
    updatePtt();
  }
  const theme = s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system';
  if (nativeTheme.themeSource !== theme) {
    nativeTheme.themeSource = theme;
    for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(paper());
  }
}

// ---------------------------------------------------------------------------
// Новые версии: https://skam-messenger.ru/desktop.json → { version, url }
// ---------------------------------------------------------------------------

function newer(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function downloadUrl(u) {
  const x = parse(u);
  if (x && x.protocol === 'https:' && (x.hostname === 'github.com' || x.origin === ORIGIN)) return x.href;
  return RELEASES;
}

async function checkUpdates(manual) {
  try {
    const r = await net.fetch(`${UPDATE_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const v = typeof j.version === 'string' ? j.version : '';
    if (v && newer(v, app.getVersion())) {
      update = { version: v, url: downloadUrl(j.url) };
      refreshTrayMenu();
      if (manual || settings.get('notifiedVersion') !== v) {
        settings.set('notifiedVersion', v);
        toast(`Вышел СКАМ для Windows ${v}`, 'Нажмите, чтобы скачать новую версию.', () => openOutside(update.url));
      }
    } else if (manual) {
      toast('Обновлений нет', `У вас последняя версия — ${app.getVersion()}.`);
    }
  } catch {
    if (manual) toast('Не получилось проверить обновления', 'Нет связи с сервером СКАМ. Попробуйте позже.');
  }
}

// ---------------------------------------------------------------------------
// Все окна: ссылки, переходы, меню правой кнопки, клавиши
// ---------------------------------------------------------------------------

function childWindowOptions() {
  return {
    width: 980,
    height: 820,
    minWidth: 360,
    minHeight: 400,
    icon: appIcon(),
    backgroundColor: paper(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'page-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      additionalArguments: [`--skam-version=${app.getVersion()}`],
    },
  };
}

function onWindowOpen(url) {
  const u = parse(url);
  if (!u) return { action: 'deny' };
  if (u.protocol === 'blob:' && u.origin === ORIGIN) return { action: 'allow', overrideBrowserWindowOptions: childWindowOptions() };
  if (u.origin === ORIGIN) {
    if (isSitePage(u)) return { action: 'allow', overrideBrowserWindowOptions: childWindowOptions() };
    // Ссылка на само приложение (?join=…, ?stickers=…) — открываем в главном окне.
    if (win && !win.isDestroyed()) {
      showWindow();
      win.loadURL(u.href).catch(() => {});
    }
    return { action: 'deny' };
  }
  openOutside(u.href);
  return { action: 'deny' };
}

function navigationAllowed(url, contents) {
  const u = parse(url);
  if (!u) return false;
  if (u.origin === ORIGIN) return true;
  if (u.protocol === 'https:' && isSignInHost(u.hostname) && win && contents === win.webContents) return true;
  return false;
}

function contextMenu(contents, p) {
  const t = [];
  const sep = () => { if (t.length && t[t.length - 1].type !== 'separator') t.push({ type: 'separator' }); };
  if (p.misspelledWord) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) t.push({ label: s, click: () => contents.replaceMisspelling(s) });
    if (!p.dictionarySuggestions.length) t.push({ label: 'Нет вариантов', enabled: false });
    t.push({ label: 'Добавить в словарь', click: () => contents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    sep();
  }
  if (p.isEditable) {
    t.push(
      { label: 'Отменить', role: 'undo', enabled: p.editFlags.canUndo },
      { label: 'Повторить', role: 'redo', enabled: p.editFlags.canRedo },
      { type: 'separator' },
      { label: 'Вырезать', role: 'cut', enabled: p.editFlags.canCut },
      { label: 'Копировать', role: 'copy', enabled: p.editFlags.canCopy },
      { label: 'Вставить', role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Выделить всё', role: 'selectAll' },
    );
  } else if (p.selectionText && p.selectionText.trim()) {
    t.push({ label: 'Копировать', role: 'copy' });
  }
  if (p.linkURL && /^https?:/.test(p.linkURL)) {
    sep();
    t.push(
      { label: 'Открыть в браузере', click: () => openOutside(p.linkURL) },
      { label: 'Копировать ссылку', click: () => clipboard.writeText(p.linkURL) },
    );
  }
  if (!t.length) return;
  if (t[t.length - 1].type === 'separator') t.pop();
  Menu.buildFromTemplate(t).popup({ window: BrowserWindow.fromWebContents(contents) || undefined });
}

function setZoom(contents, level) {
  const z = Math.max(-3, Math.min(3, level));
  contents.setZoomLevel(z);
  if (win && contents === win.webContents) settings.set('zoom', z);
}

function shortcuts(e, input, contents) {
  if (input.type !== 'keyDown') return;
  const ctrl = input.control || input.meta;
  const c = input.code;
  const w = BrowserWindow.fromWebContents(contents);
  if (ctrl && !input.alt && (c === 'Equal' || c === 'NumpadAdd')) setZoom(contents, contents.getZoomLevel() + 0.5);
  else if (ctrl && !input.alt && (c === 'Minus' || c === 'NumpadSubtract')) setZoom(contents, contents.getZoomLevel() - 0.5);
  else if (ctrl && !input.alt && (c === 'Digit0' || c === 'Numpad0')) setZoom(contents, 0);
  else if (c === 'F5' || (ctrl && c === 'KeyR')) (input.shift || (ctrl && c === 'F5') ? contents.reloadIgnoringCache() : contents.reload());
  else if (c === 'F11' && w) w.setFullScreen(!w.isFullScreen());
  else if (c === 'F12' || (ctrl && input.shift && c === 'KeyI')) contents.toggleDevTools();
  else if (input.alt && !ctrl && c === 'ArrowLeft' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  else if (ctrl && !input.shift && c === 'KeyW' && w) w.close();
  else if (ctrl && c === 'KeyQ') app.quit();
  else return;
  e.preventDefault();
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => onWindowOpen(url));
  contents.on('will-navigate', (e, url) => {
    if (navigationAllowed(url, contents)) return;
    e.preventDefault();
    openOutside(url);
  });
  contents.on('will-redirect', (e, url) => {
    if (navigationAllowed(url, contents) || url.startsWith('file:')) return;
    e.preventDefault();
    openOutside(url);
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.on('context-menu', (_e, params) => contextMenu(contents, params));
  contents.on('before-input-event', (e, input) => shortcuts(e, input, contents));
});

// ---------------------------------------------------------------------------
// Сессия: разрешения, показ экрана, загрузки
// ---------------------------------------------------------------------------

function setupSession(ses) {
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(ALLOWED_PERMISSIONS.has(permission) && sameOrigin((details && details.requestingUrl) || (wc && wc.getURL())));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && sameOrigin(origin));
  ses.setDisplayMediaRequestHandler(onDisplayMedia);
  try { ses.setSpellCheckerLanguages(['ru', 'en-US']); } catch { /* проверка орфографии — как в системе */ }
  ses.on('will-download', (_e, item) => {
    item.once('done', (_ev, state) => {
      if (state !== 'completed') return;
      const file = item.getSavePath();
      if (file) toast('Файл сохранён', path.basename(file), () => shell.showItemInFolder(file));
    });
  });
}

// ---------------------------------------------------------------------------
// Связь с окнами
// ---------------------------------------------------------------------------

function fromApp(e) {
  return !!win && e.sender === win.webContents && sameOrigin(e.senderFrame && e.senderFrame.url);
}

ipcMain.handle('notify', (e, p) => (fromApp(e) ? showSiteNotification(e.sender, p) : false));
ipcMain.on('state', (e, s) => { if (fromApp(e)) applyState(s); });
ipcMain.handle('picker:data', (e) => {
  const p = pickers.get(e.sender.id);
  return p ? { items: p.items, audio: p.audio } : null;
});
ipcMain.on('picker:choose', (e, choice) => {
  const p = pickers.get(e.sender.id);
  if (!p) return;
  const ok = choice && typeof choice.id === 'string' && p.items.some((s) => s.id === choice.id);
  p.finish(ok ? { id: choice.id, audio: !!choice.audio && p.audio } : null);
});

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------

function debounce(fn, ms) {
  let t = null;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => {
    quitting = true;
    if (ptt) ptt.stop();
    if (settings) settings.flush();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(() => {
    settings = new Settings(app.getPath('userData'));
    Menu.setApplicationMenu(null);
    setupSession(session.defaultSession);
    ptt = new PttWatcher((down, code) => {
      if (win && !win.isDestroyed()) win.webContents.send('ptt', { down, code });
    });
    createWindow();
    createTray();
    setTimeout(() => checkUpdates(false), 20_000);
    setInterval(() => checkUpdates(false), 6 * 3600_000);
    // Для проверок (Playwright): состояние главного процесса.
    if (TEST) {
      globalThis.__skam = {
        get win() { return win; }, get tray() { return tray; }, get ptt() { return ptt; }, get pttCode() { return pttCode; },
        get unread() { return unread; }, get ringing() { return ringing; }, get update() { return update; }, settings,
        pickers, toasts, checkUpdates, newer, onWindowOpen, navigationAllowed, isSitePage: (u) => isSitePage(new URL(u)),
        testLog, trayMenu: () => trayItems.map((i) => ({ label: i.label, type: i.type, checked: i.checked, enabled: i.enabled })),
        clickTray: (label) => { const i = trayItems.find((x) => x.label === label); if (i && i.click) i.click({ checked: !i.checked }); },
        get autostart() { return autostart(); },
        updatePtt, showWindow,
      };
    }
  });
}
