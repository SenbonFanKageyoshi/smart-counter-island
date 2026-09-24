'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  ask: (q) => ipcRenderer.invoke('pet:ask', q),
  hit: (over) => ipcRenderer.invoke('pet:hit', over),
  move: (dx, dy) => ipcRenderer.invoke('pet:move', { dx, dy }),
  interact: () => ipcRenderer.invoke('pet:interact'),
  env: () => ipcRenderer.invoke('pet:env'),
  stats: () => ipcRenderer.invoke('pet:stats'),
  check: () => ipcRenderer.invoke('pet:check'),
  say: (t) => ipcRenderer.invoke('pet:say', t),
  onState: (cb) => ipcRenderer.on('pet:state', (_e, d) => cb(d)),
  onPack: (cb) => ipcRenderer.on('pet:pack', (_e, d) => cb(d)),
  onConfig: (cb) => ipcRenderer.on('pet:config', (_e, d) => cb(d)),
  onSay: (cb) => ipcRenderer.on('pet:say', (_e, d) => cb(d)),
  onAskStart: (cb) => ipcRenderer.on('pet:ask-start', (_e, d) => cb(d)),
  onDelta: (cb) => ipcRenderer.on('pet:delta', (_e, d) => cb(d)),
  onAskEnd: (cb) => ipcRenderer.on('pet:ask-end', (_e, d) => cb(d)),
});
