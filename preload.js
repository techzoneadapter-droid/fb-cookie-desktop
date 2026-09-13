const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  loginAndGetToken: (cookies) => ipcRenderer.invoke('login-and-get-token', cookies),
  clearFacebookCookies: () => ipcRenderer.invoke('clear-facebook-cookies'),
  getCookieAndUid: () => ipcRenderer.invoke('get-cookie-and-uid'),
  openFacebookExternal: () => ipcRenderer.invoke('open-facebook-external'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  selectCookieFile: () => ipcRenderer.invoke('select-cookie-file'),
  parseCookieFile: (path) => ipcRenderer.invoke('parse-cookie-file', path),
  startBatch: (path) => ipcRenderer.invoke('start-batch', path),
  stopBatch: () => ipcRenderer.invoke('stop-batch'),

  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  onStatusUpdate: (cb) => ipcRenderer.on('status-update', (e, d) => cb(d)),
  onBatchStart: (cb) => ipcRenderer.on('batch-start', (e, d) => cb(d)),
  onBatchProgress: (cb) => ipcRenderer.on('batch-progress', (e, d) => cb(d)),
  onBatchLine: (cb) => ipcRenderer.on('batch-line', (e, d) => cb(d)),
  onBatchDone: (cb) => ipcRenderer.on('batch-done', (e, d) => cb(d)),
  onTokenObtained: (cb) => ipcRenderer.on('token-obtained', (e, d) => cb(d)),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (e, d) => cb(d))
});
