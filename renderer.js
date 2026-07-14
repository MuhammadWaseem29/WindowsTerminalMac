// ═══════════════════════════════════════════════════════════════════════
// Windows Terminal for Mac — Renderer
// References:
//   Pane.cpp (binary tree), Tab.cpp, AppKeyBindings.cpp (keybinding table)
//   Terminal pane appearance: Cascadia Mono 12pt, padding "8, 8, 8, 8", historySize 9001
// ═══════════════════════════════════════════════════════════════════════
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { WebglAddon } = require('@xterm/addon-webgl');

const SCHEMES = require('./campbell');
const DEFAULT_SCHEME = 'Campbell';

// ── Visible error surfacing (no DevTools in production) ──────────────
function showError(msg) {
  console.error('[WT]', msg);
  try {
    let bar = document.getElementById('statusbar');
    if (!bar) return;
    bar.textContent = '\u26A0 ' + String(msg).slice(0, 160);
    bar.classList.add('visible');
    clearTimeout(showError._t);
    showError._t = setTimeout(() => bar.classList.remove('visible'), 6000);
  } catch (e) { console.error('showError crashed:', e); }
}
function toast(msg) {
  try {
    let t = document.getElementById('wt-toast');
    if (!t) { t = document.createElement('div'); t.id='wt-toast'; t.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:18px;background:#2B2B2B;color:#fff;padding:6px 14px;border-radius:6px;font-size:12px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.5);pointer-events:none;transition:opacity .3s;'; document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity='1';
    clearTimeout(toast._t); toast._t=setTimeout(()=>t.style.opacity='0', 1200);
  } catch(e){}
}
window.addEventListener('error', (e) => showError(e.message));
window.addEventListener('unhandledrejection', (e) => showError('Unhandled: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));

let tabs = [];
let activeTabId = 0;
let tabIdCounter = 0;
let paneIdCounter = 0;
let currentFontSize = 12;

// ── Pane binary tree ──────────────────────────────────────────────────
// Mirrors Pane.cpp: leaf or Branch{first, second, splitState, separatorPos}
// splitState: 'horizontal' (top/bottom) | 'vertical' (left/right)
let paneTreeRoots = {}; // tabId -> root Pane node

class PaneNode {
  constructor(opts) {
    this.id = opts.id;
    this.ptyId = opts.ptyId;
    this.term = opts.term;
    this.fit = opts.fit;
    this.element = opts.element;
    this.title = 'Terminal';
    this.splitState = null;          // null = leaf, else 'horizontal'|'vertical'
    this.first = null;
    this.second = null;
    this.separatorPos = 0.5;
    this._unsubData = null;         // listener cleanup handles
    this._unsubExit = null;
    this._disposed = false;
  }
  isLeaf() { return this.splitState === null; }
}

function createTermInstance() {
  const term = new Terminal({
    fontFamily: "Cascadia Mono, Menlo, Monaco, 'Courier New', monospace",
    fontSize: currentFontSize,
    lineHeight: 1.0,
    letterSpacing: 0,
    cursorStyle: 'bar',
    cursorBlink: true,
    allowProposedApi: true,
    theme: SCHEMES[DEFAULT_SCHEME],
    scrollback: 9001,
    windowsMode: false,
    drawBoldText: true,
    allowTransparency: false,
  });
  return term;
}

async function spawnPane(element, cwd) {
  const term = createTermInstance();
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  try { term.loadAddon(new WebglAddon()); } catch(e) { /* webgl optional */ }

  term.open(element);
  fit.fit();

  const ptyId = await window.wt.createPty({
    cwd: cwd || require('os').homedir(),
    cols: term.cols, rows: term.rows,
  });

  const paneNode = new PaneNode({
    id: ++paneIdCounter, ptyId, term, fit, element,
  });

  paneNode._unsubData = window.wt.onPtyData((id, data) => {
    if (id === ptyId && !paneNode._disposed && term) term.write(data);
  });
  paneNode._unsubExit = window.wt.onPtyExit((id, code) => {
    if (id === ptyId && !paneNode._disposed && term) {
      term.write(`\r\n\x1b[2m[Process exited ${code}]\x1b[0m\r\n`);
    }
  });

  term.onData((d) => window.wt.writePty(ptyId, d));
  term.onTitleChange((t) => { paneNode.title = t || 'Terminal'; renderTabs(activeTabId); });
  term.onResize(({ cols, rows }) => window.wt.resizePty(ptyId, cols, rows));

  return paneNode;
}

// ── Tab management ────────────────────────────────────────────────────
async function newTab(cwd) {
  const tabId = ++tabIdCounter;
  const element = document.createElement('div');
  element.className = 'pane focused';
  element.style.flex = '1';

  // Attach to a temporary offscreen container so xterm.js can measure,
  // then we'll reattach properly via renderTree on rerender.
  const tempHost = document.createElement('div');
  tempHost.style.position = 'absolute';
  tempHost.style.left = '-9999px';
  tempHost.style.top = '0';
  tempHost.style.width = '1024px';
  tempHost.style.height = '700px';
  document.body.appendChild(tempHost);
  tempHost.appendChild(element);

  const prevActive = activeTabId;

  const pane = await spawnPane(element, cwd);
  paneTreeRoots[tabId] = pane;
  tabs.push({ id: tabId, rootPaneId: pane.id, focusedPaneId: pane.id });
  // Only take focus if nothing else claimed it while we were awaiting
  if (activeTabId === prevActive) activeTabId = tabId;

  // Move the pane element out of the temp host and into the actual #panes
  // via the proper tree renderer so future tab switches work correctly.
  if (tempHost.parentNode) tempHost.parentNode.removeChild(tempHost);

  renderTabs(activeTabId);
  rerenderActiveTabPanes();
  attachClickHandlers(tabId);
  toast('New tab #' + tabId);
  setTimeout(() => { try { pane.fit.fit(); } catch(e){} }, 60);
}

function closeTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  disposeTree(paneTreeRoots[tabId]);
  delete paneTreeRoots[tabId];
  tabs = tabs.filter(t => t.id !== tabId);
  if (tabs.length === 0) { window.wt.close(); return; }
  if (activeTabId === tabId) activeTabId = tabs[0].id;
  renderTabs(activeTabId);
  rerenderActiveTabPanes();
}

function disposeTree(node) {
  if (!node) return;
  if (node.isLeaf()) {
    node._disposed = true;
    if (node._unsubData) node._unsubData();
    if (node._unsubExit) node._unsubExit();
    if (node.ptyId) window.wt.killPty(node.ptyId);
    if (node.term) { try { node.term.dispose(); } catch(e){} }
    if (node.element?.parentNode) node.element.parentNode.removeChild(node.element);
  } else {
    disposeTree(node.first);
    disposeTree(node.second);
  }
}

// ── Split logic (matches Pane.cpp::_Split) ────────────────────────────
// Direction: 'auto'|'up'|'down'|'left'|'right'
// WT naming quirk: 'horizontal' = top/bottom split, 'vertical' = left/right
async function splitPane(tabId, direction) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  const root = paneTreeRoots[tabId];
  const targetPane = findPaneById(root, tab.focusedPaneId);
  if (!targetPane) return;

  // Resolve auto based on aspect ratio (Pane.cpp:2256) — measure the panes container
  let resolvedDir = direction;
  if (direction === 'auto') {
    const host = document.getElementById('panes');
    const w = host?.offsetWidth || 1024;
    const h = host?.offsetHeight || 700;
    resolvedDir = (w >= h) ? 'right' : 'down';
  }
  const isVertical = (resolvedDir === 'left' || resolvedDir === 'right');

  // Create new pane element on a temporary offscreen host so xterm can measure.
  const newElement = document.createElement('div');
  newElement.className = 'pane';
  const tempHost = document.createElement('div');
  tempHost.style.cssText = 'position:absolute;left:-9999px;top:0;width:1024px;height:700px;';
  document.body.appendChild(tempHost);
  tempHost.appendChild(newElement);

  const cwd = require('os').homedir();
  const newNode = await spawnPane(newElement, cwd);
  if (tempHost.parentNode) tempHost.parentNode.removeChild(tempHost);

  // Convert target leaf to branch (Pane.cpp:2275)
  const oldFirstId = targetPane.id;
  const oldPtyId = targetPane.ptyId;
  targetPane.splitState = isVertical ? 'vertical' : 'horizontal';
  targetPane.separatorPos = 0.5;
  targetPane.first = new PaneNode({ id: oldFirstId, ptyId: oldPtyId, term: targetPane.term, fit: targetPane.fit, element: targetPane.element });
  targetPane.second = newNode;
  if (resolvedDir === 'up' || resolvedDir === 'left') {
    // swap children so new pane is first
    [targetPane.first, targetPane.second] = [targetPane.second, targetPane.first];
  }
  // The original targetPane is now a branch — clear leaf-only props
  targetPane.ptyId = null; targetPane.term = null; targetPane.fit = null; targetPane.element = null;

  tab.focusedPaneId = newNode.id;
  rerenderActiveTabPanes();
}

function findPaneById(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  if (node.isLeaf()) return null;
  return findPaneById(node.first, id) || findPaneById(node.second, id);
}

function collectLeaves(node, arr = []) {
  if (!node) return arr;
  if (node.isLeaf()) { arr.push(node); return arr; }
  collectLeaves(node.first, arr);
  collectLeaves(node.second, arr);
  return arr;
}

function closePane(tabId, paneId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  const root = paneTreeRoots[tabId];
  if (root.isLeaf() && root.id === paneId) { closeTab(tabId); return; }

  const parent = findParentOf(root, paneId);
  if (!parent) return;

  // Capture references BEFORE mutating parent — critical!
  const surviving = (parent.first.id === paneId) ? parent.second : parent.first;
  const removed   = (parent.first.id === paneId) ? parent.first  : parent.second;

  // Dispose the removed pane's entire subtree
  disposeTree(removed);

  // Lift surviving's properties up into parent
  parent.id = surviving.id;
  parent.ptyId = surviving.ptyId;
  parent.term = surviving.term;
  parent.fit = surviving.fit;
  parent.element = surviving.element;
  parent.title = surviving.title;
  parent.splitState = surviving.splitState;
  parent.first = surviving.first;
  parent.second = surviving.second;
  parent.separatorPos = surviving.separatorPos;

  tab.focusedPaneId = parent.id;
  rerenderActiveTabPanes();
}

function findParentOf(node, id, parent = null) {
  if (!node) return null;
  if (node.id === id) return parent;
  if (node.isLeaf()) return null;
  return findParentOf(node.first, id, node) || findParentOf(node.second, id, node);
}

// ── Focus navigation (matches Pane::NavigateDirection) ───────────────
function moveFocus(tabId, direction) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  const root = paneTreeRoots[tabId];
  const cur = findPaneById(root, tab.focusedPaneId);
  if (!cur) return;
  const curEl = cur.element.getBoundingClientRect();

  // Collect leaves with their current screen rects
  const leaves = collectLeaves(root).map(p => ({
    p,
    r: p.element.getBoundingClientRect(),
  }));

  let best = null, bestScore = Infinity;
  for (const { p, r } of leaves) {
    if (p === cur) continue;
    const dx = (r.left + r.width / 2) - (curEl.left + curEl.width / 2);
    const dy = (r.top + r.height / 2) - (curEl.top + curEl.height / 2);
    let primary, secondary, require;
    switch (direction) {
      case 'right':  primary = dx;  secondary = Math.abs(dy); require = dx > 0; break;
      case 'left':   primary = -dx; secondary = Math.abs(dy); require = dx < 0; break;
      case 'down':   primary = dy;  secondary = Math.abs(dx); require = dy > 0; break;
      case 'up':     primary = -dy; secondary = Math.abs(dx); require = dy < 0; break;
      case 'previous': {
        const idx = leaves.findIndex(l => l.p === cur);
        best = leaves[idx > 0 ? idx - 1 : 0].p;
        break;
      }
      default: continue;
    }
    if (direction === 'previous') { if (best) { tab.focusedPaneId = best.id; rerenderActiveTabPanes(); } return; }
    if (!require) continue;
    const score = primary + secondary * 0.5;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  if (best) {
    tab.focusedPaneId = best.id;
    rerenderActiveTabPanes();
  }
}

// ── Pane resize (Pane::ResizePane — 5% increments) ───────────────────
function resizePane(tabId, direction) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  const root = paneTreeRoots[tabId];
  const target = findPaneById(root, tab.focusedPaneId);
  if (!target) return;

  // Walk up to find matching separator
  function walk(node, dir) {
    if (!node || node.isLeaf()) return null;
    const matches =
      (node.splitState === 'horizontal' && (dir === 'up' || dir === 'down')) ||
      (node.splitState === 'vertical' && (dir === 'left' || dir === 'right'));
    const contains = findPaneById(node, target.id);
    if (matches && contains) return node;
    return walk(node.first, dir) || walk(node.second, dir);
  }
  const sep = walk(root, direction);
  if (!sep) return;
  let delta = 0.05;
  if (direction === 'down' || direction === 'right') delta = -0.05;
  sep.separatorPos = Math.max(0.1, Math.min(0.9, sep.separatorPos + delta));
  rerenderActiveTabPanes();
}

// ── Panes layout (binary tree -> flexbox) ────────────────────────────
function rerenderActiveTabPanes() {
  // Close any open find overlay since the pane tree changed
  const fo = document.getElementById('find-overlay');
  if (fo) fo.remove();
  findOpen = false;

  const container = document.getElementById('panes');
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) { container.replaceChildren(); return; }
  const root = paneTreeRoots[activeTabId];
  if (!root) { container.replaceChildren(); return; }
  // Use replaceChildren to move existing nodes (no detach/reattach flicker)
  const frag = document.createDocumentFragment();
  renderTree(root, frag, tab.focusedPaneId);
  container.replaceChildren(frag);
  setTimeout(() => {
    collectLeaves(root).forEach(p => { try { p.fit?.fit(); } catch(e){} });
  }, 30);
}

function renderTree(node, parent, focusedPaneId) {
  if (node.isLeaf()) {
    node.element.classList.toggle('focused', node.id === focusedPaneId);
    node.element.style.flex = '1';
    parent.appendChild(node.element);
    return;
  }
  const wrapper = document.createElement('div');
  wrapper.style.display = 'flex';
  wrapper.style.flex = '1';
  wrapper.style.flexDirection = node.splitState === 'vertical' ? 'row' : 'column';
  wrapper.style.minWidth = '0'; wrapper.style.minHeight = '0';

  const firstWrap = document.createElement('div');
  firstWrap.style.display = 'flex';
  firstWrap.style.flex = node.separatorPos;
  firstWrap.style.minWidth = '0'; firstWrap.style.minHeight = '0';

  const sep = document.createElement('div');
  sep.className = 'pane-separator' + (node.splitState === 'horizontal' ? ' horizontal' : '');
  sep.addEventListener('mousedown', (e) => startDragResize(e, node, sep, node.splitState));

  const secondWrap = document.createElement('div');
  secondWrap.style.display = 'flex';
  secondWrap.style.flex = 1 - node.separatorPos;
  secondWrap.style.minWidth = '0'; secondWrap.style.minHeight = '0';

  wrapper.appendChild(firstWrap);
  wrapper.appendChild(sep);
  wrapper.appendChild(secondWrap);
  parent.appendChild(wrapper);

  renderTree(node.first, firstWrap, focusedPaneId);
  renderTree(node.second, secondWrap, focusedPaneId);
}

let _rafPending = null;
function startDragResize(e, node, sepEl, splitState) {
  e.preventDefault();
  const container = document.getElementById('panes');
  const rect = container.getBoundingClientRect();
  function onMove(ev) {
    if (splitState === 'vertical') {
      const x = ev.clientX - rect.left;
      node.separatorPos = Math.max(0.1, Math.min(0.9, x / rect.width));
    } else {
      const y = ev.clientY - rect.top;
      node.separatorPos = Math.max(0.1, Math.min(0.9, y / rect.height));
    }
    if (_rafPending) return;
    _rafPending = requestAnimationFrame(() => { _rafPending = null; rerenderActiveTabPanes(); });
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Global pane focus handler — attached once, dispatched via event delegation.
// Previously attachClickHandlers() was called per-tab, stacking duplicate
// listeners that all fired. Now we attach one listener that always uses
// the active tab's tree to resolve pane focus.
let _paneFocusHandlerAttached = false;
function attachClickHandlers(tabId) {
  if (_paneFocusHandlerAttached) return;
  _paneFocusHandlerAttached = true;
  document.getElementById('panes').addEventListener('mousedown', (e) => {
    let el = e.target;
    while (el && !el.classList?.contains('pane')) el = el.parentElement;
    if (!el) return;
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;
    const leaves = collectLeaves(paneTreeRoots[activeTabId]);
    const found = leaves.find(p => p.element === el);
    if (found) {
      tab.focusedPaneId = found.id;
      rerenderActiveTabPanes();
      renderTabs(activeTabId);
    }
  }, true);
}

// ── Tabs UI rendering ─────────────────────────────────────────────────
function renderTabs(highlightId) {
  const container = document.getElementById('tabs');
  container.innerHTML = '';
  tabs.forEach((tab, i) => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === highlightId ? ' active' : '');
    el.onclick = () => { activeTabId = tab.id; renderTabs(activeTabId); rerenderActiveTabPanes(); };
    const title = document.createElement('div');
    title.className = 'tab-title';
    const firstLeaf = collectLeaves(paneTreeRoots[tab.id])[0];
    title.textContent = firstLeaf?.title || 'Terminal';
    el.appendChild(title);
    const close = document.createElement('div');
    close.className = 'tab-close';
    close.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.25,1.25 L8.75,8.75 M8.75,1.25 L1.25,8.75" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';
    close.onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };
    el.appendChild(close);
    container.appendChild(el);
  });
}

// ── Window control buttons ───────────────────────────────────────────
document.querySelector('.minimize').onclick = () => window.wt.minimize();
document.querySelector('.maximize').onclick = () => window.wt.toggleMaximize();
document.querySelector('.close').onclick = () => window.wt.close();
// The + button fires on pointerdown (NOT click). On macOS with a draggable
// titlebar (-webkit-app-region:drag), a real mouse press with tiny movement
// gets turned into a window drag — swallowing the "click" event so the tab
// never opens. pointerdown fires at press time, before any drag threshold,
// so the new tab always opens. A short debounce prevents double-fires.
let _newTabLock = 0;
function doNewTab() {
  const now = Date.now();
  if (now - _newTabLock < 400) return;   // debounce: ignore within 400ms
  _newTabLock = now;
  // Open a new window which will create its own tab on load
  try {
    window.wt.newWindow();
  } catch (e) {
    showError('newWindow failed: ' + (e && e.message ? e.message : e));
  }
}
document.getElementById('newtab-btn').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  doNewTab();
});
// Keyboard accessibility: Enter/Space still trigger via click
document.getElementById('newtab-btn').addEventListener('click', (e) => {
  e.preventDefault();
  doNewTab();
});

// ── New-Tab Dropdown (Ctrl+Shift+Space → Terminal.OpenNewTabDropdown) ─
// Like the real WT, the caret opens a menu with profile options + schemes.
let dropdownOpen = false;
document.getElementById('newtab-caret').onclick = (e) => {
  e.stopPropagation();
  if (dropdownOpen) { closeDropdown(); return; }
  const menu = document.createElement('div');
  menu.id = 'wt-dropdown';
  menu.style.cssText = `position:absolute;top:40px;left:8px;background:#1F1F1F;border:1px solid #2B2B2B;
    border-radius:4px;padding:6px 0;min-width:200px;max-width:280px;max-height:60vh;overflow-y:auto;
    z-index:1000;box-shadow:0 8px 24px rgba(0,0,0,0.6);font-size:12px;color:#CCCCCC;
    -webkit-app-region:no-drag;`;
  // New Tab action (matches WT: top entry launches a new tab)
  const newTabItem = document.createElement('div');
  newTabItem.style.cssText = 'padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;font-weight:600;';
  newTabItem.onmouseenter = () => newTabItem.style.background = '#2B2B2B';
  newTabItem.onmouseleave = () => newTabItem.style.background = 'transparent';
  const ntIco = document.createElement('div');
  ntIco.style.cssText = 'width:14px;height:14px;display:flex;align-items:center;justify-content:center;color:#E6E6E6;font-size:14px;line-height:1;';
  ntIco.textContent = '+';
  newTabItem.appendChild(ntIco);
  const ntLbl = document.createElement('span');
  ntLbl.textContent = 'New Tab';
  newTabItem.appendChild(ntLbl);
  newTabItem.onclick = () => { closeDropdown(); newTab().catch(err => showError('newTab failed: ' + (err && err.message ? err.message : err))); };
  menu.appendChild(newTabItem);
  // Separator
  const ntSep = document.createElement('div');
  ntSep.style.cssText = 'height:1px;margin:4px 0;background:#2B2B2B;';
  menu.appendChild(ntSep);
  // Header
  const hdr = document.createElement('div');
  hdr.style.cssText = 'padding:6px 12px;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;';
  hdr.textContent = 'Color Schemes';
  menu.appendChild(hdr);
  // Scheme list
  Object.keys(SCHEMES).forEach((name) => {
    const item = document.createElement('div');
    item.style.cssText = 'padding:6px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;';
    item.onmouseenter = () => item.style.background = '#2B2B2B';
    item.onmouseleave = () => item.style.background = 'transparent';
    const sw = document.createElement('div');
    sw.style.cssText = `width:12px;height:12px;border-radius:2px;background:${SCHEMES[name].background};border:1px solid ${SCHEMES[name].foreground};`;
    item.appendChild(sw);
    const label = document.createElement('span');
    label.textContent = name;
    item.appendChild(label);
    item.onclick = () => {
      tabs.forEach(t => collectLeaves(paneTreeRoots[t.id]).forEach(p => {
        p.term.options.theme = SCHEMES[name];
      }));
      closeDropdown();
    };
    menu.appendChild(item);
  });
  // Separator
  const sep = document.createElement('div');
  sep.style.cssText = 'height:1px;margin:6px 0;background:#2B2B2B;';
  menu.appendChild(sep);
  // Settings row
  const settingsItem = document.createElement('div');
  settingsItem.style.cssText = 'padding:6px 12px;cursor:pointer;';
  settingsItem.onmouseenter = () => settingsItem.style.background = '#2B2B2B';
  settingsItem.onmouseleave = () => settingsItem.style.background = 'transparent';
  settingsItem.textContent = 'Settings  Ctrl+,';
  settingsItem.onclick = () => { closeDropdown(); };
  menu.appendChild(settingsItem);
  document.body.appendChild(menu);
  dropdownOpen = true;
};
function closeDropdown() {
  const m = document.getElementById('wt-dropdown');
  if (m) m.remove();
  dropdownOpen = false;
}
document.addEventListener('click', (e) => {
  if (dropdownOpen && !e.target.closest('#newtab-caret') && !e.target.closest('#wt-dropdown')) {
    closeDropdown();
  }
});

// ── Font size adjustment (Terminal.AdjustFontSize) ────────────────────
function adjustFontSize(delta) {
  currentFontSize = Math.max(6, Math.min(32, currentFontSize + delta));
  tabs.forEach(t => collectLeaves(paneTreeRoots[t.id]).forEach(p => {
    p.term.options.fontSize = currentFontSize;
    try { p.fit?.fit(); } catch(e){}
  }));
}

// ── Clear buffer (Terminal.ClearBuffer) ────────────────────────────────
function clearBuffer() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;
  const leaf = findPaneById(paneTreeRoots[activeTabId], tab.focusedPaneId);
  if (leaf) leaf.term.clear();
}

// ── Switch to tab N (Terminal.SwitchToTab) ────────────────────────────
function switchToTab(index) {
  if (tabs.length === 0) return;
  index = Math.max(0, Math.min(index, tabs.length - 1));
  activeTabId = tabs[index].id;
  renderTabs(activeTabId);
  rerenderActiveTabPanes();
}

function nextTab() {
  const i = tabs.findIndex(t => t.id === activeTabId);
  activeTabId = tabs[(i + 1) % tabs.length].id;
  renderTabs(activeTabId); rerenderActiveTabPanes();
}
function prevTab() {
  const i = tabs.findIndex(t => t.id === activeTabId);
  activeTabId = tabs[(i - 1 + tabs.length) % tabs.length].id;
  renderTabs(activeTabId); rerenderActiveTabPanes();
}

// ── Find (Terminal.FindText — basic implementation) ───────────────────
let findOpen = false;
function openFind() {
  if (findOpen) { document.getElementById('find-overlay')?.querySelector('input')?.focus(); return; }
  findOpen = true;
  const overlay = document.createElement('div');
  overlay.id = 'find-overlay';
  overlay.style.cssText = 'position:absolute;top:44px;right:8px;background:#1B1B1B;padding:8px;border:1px solid #3A96DD;border-radius:4px;display:flex;gap:6px;z-index:1000;box-shadow:0 8px 24px rgba(0,0,0,0.6);';
  const input = document.createElement('input');
  input.placeholder = 'Find...';
  input.style.cssText = 'background:#0C0C0C;color:#fff;border:1px solid #3A96DD;padding:4px 8px;font-size:12px;width:180px;outline:none;border-radius:2px;';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕'; closeBtn.style.cssText = 'background:transparent;border:none;color:#ccc;cursor:pointer;font-size:12px;padding:2px 4px;';
  closeBtn.onclick = () => { overlay.remove(); findOpen = false; };
  input.oninput = () => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;
    const leaf = findPaneById(paneTreeRoots[activeTabId], tab.focusedPaneId);
    if (leaf && input.value) { try { leaf.term.findNext(input.value); } catch(e) { /* findNext removed in xterm 5.x — use @xterm/addon-search in future */ } }
  };
  overlay.appendChild(input); overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);
  // Escape + outside-click close
  const outsideHandler = (e) => {
    if (!overlay.contains(e.target)) { overlay.remove(); findOpen = false; document.removeEventListener('mousedown', outsideHandler, true); }
  };
  setTimeout(() => document.addEventListener('mousedown', outsideHandler, true), 0);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); findOpen = false; document.removeEventListener('mousedown', outsideHandler, true); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const tab = tabs.find(t => t.id === activeTabId);
      const leaf = tab && findPaneById(paneTreeRoots[activeTabId], tab.focusedPaneId);
      if (leaf && input.value) { try { leaf.term.findNext(input.value); } catch(e){} }
    }
  });
  input.focus();
}

// ── Fullscreen (Terminal.ToggleFullscreen) ─────────────────────────────
let isFullscreen = false;
function toggleFullscreen() {
  window.wt.toggleFullscreen();
}

// ── KEYBINDINGS (exact from defaults.json, macOS-translated) ──────────
// ctrl → cmd for app-level actions, alt stays alt for pane navigation
document.addEventListener('keydown', (e) => {
  const cmd = e.metaKey; const ctrl = e.ctrlKey; const shift = e.shiftKey;
  const alt = e.altKey; const key = e.key.toLowerCase();
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;

  // ── Application-level (Cmd+) ──
  // Cmd+Shift+T — new tab (Terminal.OpenNewTab)
  if (cmd && shift && key === 't') { e.preventDefault(); newTab(); return; }
  // Cmd+Shift+W — close pane (Terminal.ClosePane)
  if (cmd && shift && key === 'w') {
    e.preventDefault(); closePane(activeTabId, tab.focusedPaneId); return;
  }
  // Cmd+Shift+D — duplicate tab (Terminal.DuplicateTab) → open new tab
  if (cmd && shift && key === 'd') { e.preventDefault(); newTab(); return; }
  // Cmd+Shift+N — new window (Terminal.OpenNewWindow) — spawn new electron process
  if (cmd && shift && key === 'n') {
    e.preventDefault();
    // Notify main process; main.js handles actual window creation
    window.wt.newWindow();
    return;
  }
  // Cmd+Shift+F — find (Terminal.FindText)
  if (cmd && shift && key === 'f') { e.preventDefault(); openFind(); return; }
  // Cmd+Shift+K — clear buffer (Terminal.ClearBuffer)
  if (cmd && shift && key === 'k') { e.preventDefault(); clearBuffer(); return; }
  // Cmd+Shift+A — select all (Terminal.SelectAll)
  if (cmd && shift && key === 'a') {
    e.preventDefault();
    const leaf = findPaneById(paneTreeRoots[activeTabId], tab.focusedPaneId);
    if (leaf) leaf.term.selectAll();
    return;
  }
  // Cmd+Shift+P — command palette (not implemented, just prevent)
  if (cmd && shift && key === 'p') { e.preventDefault(); return; }
  // Ctrl+Shift+Space — open new-tab dropdown (Terminal.OpenNewTabDropdown)
  if (ctrl && shift && key === ' ') { e.preventDefault(); document.getElementById('newtab-caret').click(); return; }
  // Cmd+, — open settings (not implemented)
  if (cmd && !shift && key === ',') { e.preventDefault(); return; }

  // ── Tab navigation ──
  if (ctrl && key === 'tab' && !shift) { e.preventDefault(); nextTab(); return; }
  if (ctrl && key === 'tab' && shift) { e.preventDefault(); prevTab(); return; }
  // Ctrl+Alt+1..9 — switch to tab N (Terminal.SwitchToTab0..8 + SwitchToLastTab)
  if (ctrl && alt && /^[1-9]$/.test(key)) {
    e.preventDefault();
    if (key === '9') { activeTabId = tabs[tabs.length - 1]?.id; if (activeTabId) { renderTabs(activeTabId); rerenderActiveTabPanes(); } }
    else switchToTab(parseInt(key) - 1);
    return;
  }
  // Cmd+Shift+1..9 — open new tab with profile N (Terminal.OpenNewTabProfile0..8)
  // On macOS we map to opening new tab (only one profile available)

  // ── Pane management (Alt+) ──
  // Alt+Shift+D — split pane auto (Terminal.DuplicatePaneAuto)
  if (alt && shift && key === 'd') { e.preventDefault(); splitPane(activeTabId, 'auto'); return; }
  // Alt+Shift+- — split pane down (Terminal.DuplicatePaneDown)
  if (alt && shift && key === '-') { e.preventDefault(); splitPane(activeTabId, 'down'); return; }
  // Alt+Shift++ or Alt+Shift+= — split pane right (Terminal.DuplicatePaneRight)
  if (alt && shift && (key === '+' || key === '=')) { e.preventDefault(); splitPane(activeTabId, 'right'); return; }
  // Alt+Arrows — move focus (Terminal.MoveFocus*)
  if (alt && !shift && (key === 'arrowleft' || key === 'arrowright' || key === 'arrowup' || key === 'arrowdown')) {
    e.preventDefault();
    const dir = key.replace('arrow', '');
    moveFocus(activeTabId, dir);
    return;
  }
  // Ctrl+Alt+Left — move focus to previous (Terminal.MoveFocusPrevious)
  if (ctrl && alt && key === 'arrowleft') { e.preventDefault(); moveFocus(activeTabId, 'previous'); return; }
  // Alt+Shift+Arrows — resize pane (Terminal.ResizePane*)
  if (alt && shift && (key === 'arrowleft' || key === 'arrowright' || key === 'arrowup' || key === 'arrowdown')) {
    e.preventDefault();
    const dir = key.replace('arrow', '');
    resizePane(activeTabId, dir);
    return;
  }

  // ── Scrollback ──
  // Cmd+Shift+Up/Down — scroll up/down 1 row (Terminal.ScrollUp/Down)
  if (cmd && shift && key === 'arrowup') {
    e.preventDefault();
    const leaf = findPaneById(paneTreeRoots[activeTabId], tab.focusedPaneId);
    if (leaf) leaf.term.scrollLines(-1);
    return;
  }
  if (cmd && shift && key === 'arrowdown') {
    e.preventDefault();
    const leaf = findPaneById(paneTreeRoots[activeTabId], tab.focusedPaneId);
    if (leaf) leaf.term.scrollLines(1);
    return;
  }
  // Cmd+Shift+Home — scroll to top (Terminal.ScrollToTop)
  if (cmd && shift && key === 'home') {
    e.preventDefault();
    const leaf = findPaneById(paneTreeRoots[activeTabId], tab.focusedPaneId);
    if (leaf) leaf.term.scrollToTop();
    return;
  }
  // Cmd+Shift+End — scroll to bottom (Terminal.ScrollToBottom)
  if (cmd && shift && key === 'end') {
    e.preventDefault();
    const leaf = findPaneById(paneTreeRoots[activeTabId], tab.focusedPaneId);
    if (leaf) leaf.term.scrollToBottom();
    return;
  }

  // ── Visual adjustments ──
  // Cmd+= — increase font size (Terminal.IncreaseFontSize)
  if (cmd && (key === '=' || key === '+')) { e.preventDefault(); adjustFontSize(1); return; }
  // Cmd+- — decrease font size (Terminal.DecreaseFontSize)
  if (cmd && !shift && key === '-') { e.preventDefault(); adjustFontSize(-1); return; }
  // Cmd+0 — reset font size (Terminal.ResetFontSize)
  if (cmd && !shift && key === '0') { e.preventDefault(); currentFontSize = 12; adjustFontSize(0); return; }

  // ── Fullscreen ──
  // F11 or Alt+Enter — toggle fullscreen (Terminal.ToggleFullscreen)
  if (key === 'f11' || (alt && key === 'enter')) { e.preventDefault(); toggleFullscreen(); return; }

  // ── Quit ──
  // Cmd+Q — quit (Terminal.Quit) — macOS convention
  if (cmd && !shift && key === 'q') { e.preventDefault(); window.wt.close(); return; }

  // ── Clipboard ──
  // Cmd+C — copy (Terminal.CopyToClipboard)
  if (cmd && !shift && key === 'c') {
    const leaf = findPaneById(paneTreeRoots[activeTabId], tab.focusedPaneId);
    if (leaf && leaf.term.hasSelection()) {
      e.preventDefault();
      const sel = leaf.term.getSelection();
      navigator.clipboard.writeText(sel);
    }
    return;
  }
  // Cmd+V — paste (Terminal.PasteFromClipboard)
  if (cmd && !shift && key === 'v') {
    e.preventDefault();
    const leaf = findPaneById(paneTreeRoots[activeTabId], tab.focusedPaneId);
    if (leaf) {
      navigator.clipboard.readText().then((text) => window.wt.writePty(leaf.ptyId, text));
    }
    return;
  }
});

// ── Window resize handler (fit all panes) ─────────────────────────────
window.addEventListener('resize', () => {
  tabs.forEach(t => collectLeaves(paneTreeRoots[t.id]).forEach(p => { try { p.fit?.fit(); } catch(e){} }));
});

// ── Boot — open first tab ─────────────────────────────────────────────
newTab();
