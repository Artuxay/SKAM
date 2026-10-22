'use strict';
// Рация в других окнах (Windows). Браузер отдаёт нажатия клавиш, только пока вкладка в фокусе, поэтому
// в приложении, пока окно СКАМ не в фокусе (свёрнуто, в трее, вы в игре), мы раз в 20 мс спрашиваем
// у Windows, зажата ли выбранная клавиша рации (GetAsyncKeyState из user32.dll).
// Смотрим ровно одну клавишу и только «нажата / отпущена»: ввод не перехватывается, другие программы
// получают клавишу как обычно, ничего не записывается.
const IS_WIN = process.platform === 'win32';
const POLL_MS = 20;

// KeyboardEvent.code (физическая клавиша, так её хранит сайт) → виртуальный код Windows.
// Буквы и знаки — по раскладке США; у русской ЙЦУКЕН коды те же, поэтому «V» = «М».
const VK = {
  Space: 0x20, Tab: 0x09, CapsLock: 0x14, Enter: 0x0d, NumpadEnter: 0x0d, Backspace: 0x08, Escape: 0x1b,
  ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3, AltLeft: 0xa4, AltRight: 0xa5,
  MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d,
  Backquote: 0xc0, Minus: 0xbd, Equal: 0xbb, BracketLeft: 0xdb, BracketRight: 0xdd, Backslash: 0xdc,
  Semicolon: 0xba, Quote: 0xde, Comma: 0xbc, Period: 0xbe, Slash: 0xbf, IntlBackslash: 0xe2,
  Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Pause: 0x13, ScrollLock: 0x91, PrintScreen: 0x2c, NumLock: 0x90,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
};

/** Виртуальный код Windows для KeyboardEvent.code; 0 — такую клавишу не знаем. */
function vkOf(code) {
  if (typeof code !== 'string') return 0;
  if (VK[code]) return VK[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].charCodeAt(0);
  m = /^Digit(\d)$/.exec(code);
  if (m) return 0x30 + Number(m[1]);
  m = /^Numpad(\d)$/.exec(code);
  if (m) return 0x60 + Number(m[1]);
  m = /^F(\d{1,2})$/.exec(code);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 24) return 0x6f + Number(m[1]);
  return 0;
}

let keyState = null;
/**
 * Функция «зажата ли клавиша vk» (ответ — в callback) или null, если спросить Windows нельзя.
 * Вызов идёт в фоновом потоке (koffi async): главный поток приложения никогда не ждёт Windows.
 */
function windowsProbe() {
  if (keyState !== null) return keyState || null;
  keyState = false;
  if (!IS_WIN) return null;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
    keyState = (vk, cb) => GetAsyncKeyState.async(vk, (err, r) => cb(!err && (r & 0x8000) !== 0));
  } catch (e) {
    console.error('[ptt] user32 недоступна:', e && e.message);
  }
  return keyState || null;
}

class PttWatcher {
  /**
   * onChange(down, code) — клавишу нажали (true) или отпустили (false), пока окно не в фокусе.
   * probe(vk, cb) — спросить, зажата ли клавиша; по умолчанию — Windows.
   */
  constructor(onChange, probe = windowsProbe()) {
    this.onChange = onChange;
    this.probe = probe;
    this.vk = 0;
    this.code = null;
    this.active = false;
    this.down = false;
    this.timer = null;
    this.asking = false;
    this.epoch = 0;
  }

  get supported() {
    return !!this.probe;
  }

  /** code — клавиша рации (null — рация выключена); active — окно СКАМ не в фокусе. */
  configure({ code, active }) {
    const vk = vkOf(code);
    if (vk !== this.vk || code !== this.code) {
      this.epoch++;
      this.release();
      this.vk = vk;
      this.code = vk ? code : null;
    }
    const on = !!active && !!this.vk && !!this.probe;
    if (on === this.active) return;
    this.active = on;
    if (on) {
      this.timer = setInterval(() => this.tick(), POLL_MS);
      this.tick();
    } else {
      clearInterval(this.timer);
      this.timer = null;
      this.epoch++;
      // Окно снова в фокусе — дальше нажатия ловит сам сайт. Отпускаем, чтобы микрофон не залип.
      this.release();
    }
  }

  tick() {
    if (this.asking) return;
    this.asking = true;
    const epoch = this.epoch;
    const vk = this.vk;
    const done = (down) => {
      this.asking = false;
      // Пока ждали ответ, рацию выключили или сменили клавишу — ответ уже не нужен.
      if (epoch !== this.epoch || !this.active || vk !== this.vk) return;
      down = !!down;
      if (down === this.down) return;
      this.down = down;
      this.onChange(down, this.code);
    };
    try {
      this.probe(vk, done);
    } catch {
      done(false);
    }
  }

  release() {
    if (!this.down) return;
    this.down = false;
    this.onChange(false, this.code);
  }

  stop() {
    this.configure({ code: null, active: false });
  }
}

module.exports = { PttWatcher, vkOf };
