const { app, BrowserWindow, ipcMain, webContents } = require('electron');
const path = require('path');
const os = require('os');
const pty = require('node-pty');
const { execSync } = require('child_process');

const ptys = new Map();
const windowPtyMap = new Map();
let ptyIdCounter = 0;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

const ICON_ICNS = path.join(__dirname, 'assets', 'icon.icns');
const ICON_PNG = path.join(__dirname, 'assets', 'icon_256.png');

app.name = 'Windows Terminal';
app.setAppUserModelId('com.microsoft.windows-terminal.mac-clone');

let loginPath = process.env.PATH || '';
try {
  const userShell = process.env.SHELL || '/bin/zsh';
  const out = execSync(`"${userShell}" -l -c 'printf %s "$PATH"'`, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
  });
  if (out && out.length) loginPath = out;
} catch (e) { /* fallback to process.env.PATH */ }

{
  const seen = new Set();
  loginPath = loginPath.split(':').filter(Boolean).filter(p => seen.has(p) ? false : (seen.add(p), true)).join(':');
}
process.env.PATH = loginPath;

function createWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 700,
    minWidth: 400,
    minHeight: 300,
    titleBarStyle: 'customInset',
    frame: false,
    backgroundColor: '#0C0C0C',
    icon: ICON_ICNS,
    title: 'Windows Terminal',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js'),
    }
  });

  windowPtyMap.set(win.webContents.id, []);

  try {
    app.dock.setIcon(ICON_ICNS);
  } catch (e) { /* not on this platform */ }

  win.loadFile('index.html');
  if (process.argv.some(a => a === '--dev' || a.startsWith('--dev='))) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  win.on('closed', () => {
    const ptyIds = windowPtyMap.get(win.webContents.id) || [];
    for (const id of ptyIds) {
      const e = ptys.get(id);
      if (e && !e.killed) {
        e.killed = true;
        try { e.proc.kill(); } catch (e2) {}
      }
      ptys.delete(id);
    }
    windowPtyMap.delete(win.webContents.id);
  });

  return win;
}

function getWindowForEvent(event) {
  const wc = event.sender;
  if (wc && !wc.isDestroyed()) return BrowserWindow.fromWebContents(wc);
  return null;
}

app.whenReady().then(() => {
  try {
    app.setAboutPanelOptions({
      applicationName: 'Windows Terminal',
      applicationVersion: '1.0.0 (Mac clone)',
      credits: 'Based on microsoft/terminal design',
      authors: ['Original Microsoft Terminal team (UI specs)', 'xterm.js + electron-node-pty'],
      iconPath: ICON_ICNS,
    });
  } catch(e) { /* about panel optional */ }
  createWindow();
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

app.on('window-all-closed', () => {
  for (const [, e] of ptys) { e.killed = true; try { e.proc.kill(); } catch(e2){} }
  ptys.clear();
  windowPtyMap.clear();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const [, e] of ptys) { e.killed = true; try { e.proc.kill(); } catch(e2){} }
  ptys.clear();
  windowPtyMap.clear();
});

ipcMain.handle('pty-create', (event, { cwd, cols, rows }) => {
  const senderWin = getWindowForEvent(event);
  if (!senderWin) return -1;

  const userShell = process.env.SHELL;
  const fs = require('fs');
  const shell = (userShell && fs.existsSync(userShell)) ? userShell : '/bin/bash';
  const ptyProcess = pty.spawn(shell, ['-i'], {
    name: 'xterm-256color',
    cols: cols || DEFAULT_COLS,
    rows: rows || DEFAULT_ROWS,
    cwd: cwd || os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  });

  const id = ++ptyIdCounter;
  const entry = { proc: ptyProcess, killed: false, exited: false, senderId: event.sender.id };
  ptys.set(id, entry);

  const ptyList = windowPtyMap.get(event.sender.id);
  if (ptyList) ptyList.push(id);

  ptyProcess.onData((data) => {
    if (entry.killed) return;
    const wc = webContents.fromId(entry.senderId);
    if (wc && !wc.isDestroyed()) {
      try { wc.send('pty-data', { id, data }); } catch(e) {}
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (entry.exited) return;
    entry.exited = true;
    if (!entry.killed) {
      const wc = webContents.fromId(entry.senderId);
      if (wc && !wc.isDestroyed()) {
        try { wc.send('pty-exit', { id, exitCode }); } catch(e) {}
      }
    }
    ptys.delete(id);
  });

  return id;
});

ipcMain.handle('pty-write', (event, { id, data }) => {
  const e = ptys.get(id);
  if (e && !e.killed) e.proc.write(data);
});

ipcMain.handle('pty-resize', (event, { id, cols, rows }) => {
  const e = ptys.get(id);
  if (e && !e.killed) e.proc.resize(cols, rows);
});

ipcMain.handle('pty-kill', (event, { id }) => {
  const e = ptys.get(id);
  if (e) {
    e.killed = true;
    try { e.proc.kill(); } catch(e2){}
    ptys.delete(id);
  }
});

ipcMain.handle('window-minimize', (event) => { const w = getWindowForEvent(event); if (w) w.minimize(); });
ipcMain.handle('window-maximize', (event) => {
  const w = getWindowForEvent(event); if (!w) return;
  w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.handle('window-toggle-fullscreen', (event) => {
  const w = getWindowForEvent(event); if (!w) return;
  if (process.platform === 'darwin') {
    w.setSimpleFullScreen(!w.isSimpleFullScreen());
  } else {
    w.setFullScreen(!w.isFullScreen());
  }
});
ipcMain.handle('window-new', () => {
  createWindow();
});
ipcMain.handle('window-close', (event) => { const w = getWindowForEvent(event); if (w) w.close(); });
ipcMain.handle('window-is-maximized', (event) => {
  const w = getWindowForEvent(event); return w ? w.isMaximized() : false;
});
