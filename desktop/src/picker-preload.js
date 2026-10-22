'use strict';
// Окно «Показать экран»: получить список экранов и окон, сообщить выбор.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', Object.freeze({
  data: () => ipcRenderer.invoke('picker:data'),
  choose: (id, audio) => ipcRenderer.send('picker:choose', { id: String(id), audio: !!audio }),
  cancel: () => ipcRenderer.send('picker:choose', null),
}));
