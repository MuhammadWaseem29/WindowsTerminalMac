// With nodeIntegration:true and contextIsolation:false, we can expose ipcRenderer
// directly. ETerminal preload runs before renderer scripts.
const { ipcRenderer } = require('electron');

window.wt = {
  createPty: (opts) => ipcRenderer.invoke('pty-create', opts),
  writePty: (id, data) => ipcRenderer.invoke('pty-write', { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.invoke('pty-resize', { id, cols, rows }),
  killPty: (id) => ipcRenderer.invoke('pty-kill', { id }),

  // Single global PTY event listeners (set up once)
  _ptyDataListeners: [],
  _ptyExitListeners: [],
  onPtyData: (cb) => {
    window.wt._ptyDataListeners.push(cb);
    return () => {
      const i = window.wt._ptyDataListeners.indexOf(cb);
      if (i >= 0) window.wt._ptyDataListeners.splice(i, 1);
    };
  },
  onPtyExit: (cb) => {
    window.wt._ptyExitListeners.push(cb);
    return () => {
      const i = window.wt._ptyExitListeners.indexOf(cb);
      if (i >= 0) window.wt._ptyExitListeners.splice(i, 1);
    };
  },

  minimize: () => ipcRenderer.send('window-minimize'),
  toggleMaximize: () => ipcRenderer.send('window-maximize'),
  toggleFullscreen: () => ipcRenderer.send('window-toggle-fullscreen'),
  newWindow: () => ipcRenderer.send('window-new'),
};

ipcRenderer.on('pty-data', (e, { id, data }) => {
  window.wt._ptyDataListeners.forEach((cb) => cb(id, data));
});
ipcRenderer.on('pty-exit', (e, { id, exitCode }) => {
  window.wt._ptyExitListeners.forEach((cb) => cb(id, exitCode));
});
