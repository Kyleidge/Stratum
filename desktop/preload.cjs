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
  // AI assistant access: the user's switch, and calls an assistant makes
  // through the main process's private channel.
  assistant: {
    settings: () => invoke('assistant-settings'),
    setEnabled: (enabled) => invoke('assistant-set', enabled === true),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('stratum:assistant-status', listener);
      return () =>
        ipcRenderer.removeListener('stratum:assistant-status', listener);
    },
    onCall: (handler) => {
      const listener = async (_event, call) => {
        try {
          const result = await handler({
            method: call.method,
            params: call.params,
          });
          ipcRenderer.send('stratum:assistant-reply', call.id, { result });
        } catch (error) {
          ipcRenderer.send('stratum:assistant-reply', call.id, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      ipcRenderer.on('stratum:assistant-call', listener);
      ipcRenderer.send('stratum:assistant-ready');
      return () =>
        ipcRenderer.removeListener('stratum:assistant-call', listener);
    },
  },
});
