'use strict';
// Отдельные окна со страницами сайта (статьи, документы): только сообщаем, что это приложение.
const { contextBridge } = require('electron');

const p = '--skam-version=';
const a = process.argv.find((x) => x.startsWith(p));

contextBridge.exposeInMainWorld('skamDesktop', Object.freeze({
  version: a ? a.slice(p.length) : '',
  platform: process.platform,
  pttEverywhere: process.platform === 'win32',
  systemAudio: process.platform === 'win32',
}));
