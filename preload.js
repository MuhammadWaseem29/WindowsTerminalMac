const { ipcRenderer } = require('electron');

window.wt = {
  createPty: (opts) => ipcRenderer.invoke('pty-create', opts),
  writePty: (id, data) => ipcRenderer.invoke('pty-write', { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.invoke('pty-resize', { id, cols, rows }),
  killPty: (id) => ipcRenderer.invoke('pty-kill', { id }),

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

  minimize:        () => ipcRenderer.invoke('window-minimize'),
  toggleMaximize:  () => ipcRenderer.invoke('window-maximize'),
  toggleFullscreen: () => ipcRenderer.invoke('window-toggle-fullscreen'),
  newWindow:       () => ipcRenderer.invoke('window-new'),
  close:           () => ipcRenderer.invoke('window-close'),
};

ipcRenderer.on('pty-data', (e, { id, data }) => {
  window.wt._ptyDataListeners.forEach((cb) => cb(id, data));
});
ipcRenderer.on('pty-exit', (e, { id, exitCode }) => {
  window.wt._ptyExitListeners.forEach((cb) => cb(id, exitCode));
});
