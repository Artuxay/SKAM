'use strict';
// Настройки приложения на этом компьютере: размер и место окна, «сворачивать в трей», масштаб.
// Хранятся в settings.json в папке данных (%APPDATA%\SKAM). Сообщения, ключи и вход — не здесь:
// их хранит сам сайт СКАМ, как в браузере.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  closeToTray: true,
  bounds: null,
  maximized: false,
  zoom: 0,
  trayHintShown: false,
  notifiedVersion: null,
});

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    this.timer = null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(DEFAULTS)) if (k in raw) this.data[k] = raw[k];
      }
    } catch {
      /* первый запуск или файл испорчен — берём настройки по умолчанию */
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    if (this.data[key] === value) return;
    this.data[key] = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch {
      /* не записалось — в следующий раз попробуем снова */
    }
  }
}

module.exports = { Settings, DEFAULTS };
