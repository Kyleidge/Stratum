// Sandboxed preload: CommonJS, and it may only require 'electron'.
// It exposes a small file API; every path stays in the main process.
// oxlint-disable-next-line typescript/no-require-imports -- sandboxed preloads cannot use ES modules.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) =>
  ipcRenderer.invoke(`stratum:${channel}`, ...args);

contextBridge.exposeInMainWorld('stratumDesktop', {
  version: 1,
  saveFile: (options) => invoke('save-file', options),
  openFile: (options) => invoke('open-file', options),
  write: (handle, bytes) => invoke('write', handle, bytes),
  read: (handle, length) => invoke('read', handle, length),
  finish: (handle) => invoke('finish', handle),
  abort: (handle) => invoke('abort', handle),
  autoBackup: {
    settings: () => invoke('auto-backup-settings'),
    chooseFolder: () => invoke('auto-backup-choose'),
    disable: () => invoke('auto-backup-disable'),
    openFolder: () => invoke('auto-backup-open-folder'),
    begin: () => invoke('auto-backup-begin'),
    report: (result) => invoke('auto-backup-report', result),
    changed: (revision, recordings) =>
      ipcRenderer.send('stratum:auto-backup-changed', revision, recordings),
    dismissNotice: () => invoke('auto-backup-dismiss'),
    onRequest: (callback) => {
      const listener = (_event, request) => callback(request);
      ipcRenderer.on('stratum:auto-backup-request', listener);
      return () =>
        ipcRenderer.removeListener('stratum:auto-backup-request', listener);
    },
  },
});
