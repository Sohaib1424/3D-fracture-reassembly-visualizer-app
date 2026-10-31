/**
 * Reassembly Visualizer: wiring between the sidebar, the 3D view, the
 * timeline and the details panel.
 */
import { DetailsView } from './details.js';
import { DumpError, parseDump } from './dump.js';
import {
  canPickFolder, folderPermission, openFile, pickFolder, rememberedFolder, scanFolder,
  serverFolder, treeFromFiles,
} from './folder.js';
import { MEASURES } from './measures.js';
import { DEFAULT_MODES, MODES, modeById } from './modes.js';
import { readNpz } from './npz.js';
import { Player, crackPath } from './player.js';
import { loadPrefs, savePrefs } from './prefs.js';
import { TreeView, countFiles } from './tree.js';
import { Viewer } from './viewer.js';

const $ = (id) => document.getElementById(id);
const COLOURINGS = ['pieces', ...Object.keys(MEASURES)]; // the order C steps through
const CACHE_BYTES = 256 * 1024 ** 2; // dumps kept in memory for flicking back and forth
const REFRESH_GAP = 4000; // ms between automatic rescans when the page comes back into view
const SLOW_SCAN = 1500; // ms; a folder slower than this is only rescanned on request

const prefs = {
  modes: DEFAULT_MODES,
  colour: 'pieces',
  scale: 'fit',
  spread: 1,
  up: 'z',
  shading: 'smooth',
  theme: 'system',
  loop: 'pingpong',
  speed: 1,
  details: true,
  ...loadPrefs(),
};
prefs.modes = MODES.map((m) => m.id).filter((id) => prefs.modes.includes(id));
if (!prefs.modes.length) prefs.modes = DEFAULT_MODES.slice();
if (prefs.colour === 'error') prefs.colour = 'rotation'; // the name before position loss was added
if (!COLOURINGS.includes(prefs.colour)) prefs.colour = 'pieces';

const viewer = new Viewer({
  viewport: $('viewport'), canvas: $('canvas'), backdrops: $('backdrops'),
  labels: $('labels'), tooltip: $('tooltip'),
});
const player = new Player();
const tree = new TreeView($('tree'));
const details = new DetailsView($('details'));

const cache = new Map(); // `${path}|${modified}|${size}` -> dump, oldest first
let current = null; // {node, dump, size, modified}
let loadToken = 0;

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function effectiveTheme() {
  return prefs.theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : prefs.theme;
}

function applyTheme() {
  const theme = effectiveTheme();
  document.documentElement.dataset.theme = theme;
  viewer.setTheme(theme);
  const button = $('theme-button');
  button.setAttribute('aria-label', theme === 'dark' ? 'Use the light theme' : 'Use the dark theme');
}

$('theme-button').addEventListener('click', () => {
  prefs.theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
  savePrefs(prefs);
  applyTheme();
});
darkQuery.addEventListener('change', applyTheme);

// ---------------------------------------------------------------------------
// Views (one panel each), colours and view options
// ---------------------------------------------------------------------------

function buildModeChips() {
  const container = $('modes');
  container.replaceChildren(...MODES.map((mode) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.mode = mode.id;
    chip.textContent = mode.name;
    chip.title = mode.help;
    return chip;
  }));
  container.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    const id = chip.dataset.mode;
    const on = prefs.modes.includes(id);
    if (on && prefs.modes.length === 1) return; // at least one view stays
    prefs.modes = MODES.map((m) => m.id).filter((m) => (m === id ? !on : prefs.modes.includes(m)));
    savePrefs(prefs);
    applyModes();
  });
}

function applyModes() {
  for (const chip of $('modes').querySelectorAll('.chip')) {
    chip.setAttribute('aria-pressed', String(prefs.modes.includes(chip.dataset.mode)));
  }
  viewer.setModes(prefs.modes.map(modeById));
  const animated = prefs.modes.some((id) => modeById(id).animated);
  $('player').classList.toggle('idle', !animated);
  $('player').title = animated ? '' : 'Add Reassembly or Rotation only to see the pieces move';
}

/** Whether the open dump has a value per piece for this colouring (any, before one is open). */
function colouringAvailable(id) {
  return id === 'pieces' || !current || Boolean(MEASURES[id].values(current.dump));
}

function applyColourMode() {
  const mode = colouringAvailable(prefs.colour) ? prefs.colour : 'pieces';
  for (const button of $('colour-mode').querySelectorAll('button')) {
    const id = button.dataset.colour;
    button.setAttribute('aria-pressed', String(id === mode));
    if (id === 'pieces') continue;
    const measure = MEASURES[id];
    button.disabled = !colouringAvailable(id);
    button.title = button.disabled ? `This dump has no ${measure.name.toLowerCase()} per piece`
      : `Colour each piece by its ${measure.name.toLowerCase()}. ${measure.help}`;
  }
  viewer.setColourMode(mode);
  details.setColourMode(mode);
}

$('colour-mode').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-colour]');
  if (!button || button.disabled) return;
  prefs.colour = button.dataset.colour;
  savePrefs(prefs);
  applyColourMode();
});

function bindRadios(name, apply) {
  for (const input of document.querySelectorAll(`input[name="${name}"]`)) {
    input.checked = input.value === prefs[name];
    input.addEventListener('change', () => {
      if (!input.checked) return;
      prefs[name] = input.value;
      savePrefs(prefs);
      apply(input.value);
    });
  }
  apply(prefs[name]);
}

bindRadios('scale', (value) => viewer.setScaleMode(value));

function applySpread() {
  const spread = Number(prefs.spread) || 1;
  $('spread').value = String(spread);
  $('spread-value').textContent = Math.abs(spread - 1) < 0.025 ? 'Drawn as dumped'
    : `${Math.round(spread * 100)}% of the dumped spacing`;
  viewer.setSpread(spread);
}
$('spread').addEventListener('input', (event) => {
  prefs.spread = Number(event.target.value);
  savePrefs(prefs);
  applySpread();
});
$('spread').addEventListener('dblclick', () => {
  prefs.spread = 1;
  savePrefs(prefs);
  applySpread();
});
applySpread();
bindRadios('up', (value) => viewer.setUpAxis(value));
bindRadios('shading', (value) => viewer.setShading(value));

const viewMenu = $('view-menu');
document.addEventListener('pointerdown', (event) => {
  if (viewMenu.open && !viewMenu.contains(event.target)) viewMenu.open = false;
});

$('reset-view').addEventListener('click', () => viewer.resetView());

$('snapshot').addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = viewer.snapshot();
  link.download = `${(current?.node.name ?? 'view').replace(/\.npz$/i, '')}.png`;
  link.click();
  viewMenu.open = false;
});

// On narrow screens the details panel lies over the view, so it starts closed
// there and is not remembered.
const narrowQuery = window.matchMedia('(max-width: 900px)');
let detailsOverlay = false;

function applyDetails() {
  const open = narrowQuery.matches ? detailsOverlay : prefs.details;
  $('app').classList.toggle('no-details', !open);
  $('details-button').setAttribute('aria-pressed', String(open));
}

$('details-button').addEventListener('click', () => {
  if (narrowQuery.matches) {
    detailsOverlay = !detailsOverlay;
  } else {
    prefs.details = !prefs.details;
    savePrefs(prefs);
  }
  applyDetails();
});
$('details-close').addEventListener('click', () => {
  detailsOverlay = false;
  if (!narrowQuery.matches) {
    prefs.details = false;
    savePrefs(prefs);
  }
  applyDetails();
});
narrowQuery.addEventListener('change', applyDetails);

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

const crack = crackPath();
for (const path of $('seam').querySelectorAll('path')) path.setAttribute('d', crack);

player.addEventListener('change', ({ detail }) => {
  viewer.setProgress(detail.s);
  $('seam-fill').setAttribute('width', String(detail.s * 100));
  $('scrub').value = String(Math.round(detail.s * 1000));
  $('progress').textContent = `${Math.round(detail.s * 100)}%`;
  const play = $('play');
  play.classList.toggle('playing', detail.playing);
  play.setAttribute('aria-label', detail.playing ? 'Pause' : 'Play');
});

$('play').addEventListener('click', () => player.toggle());
$('scrub').addEventListener('input', (event) => player.seek(Number(event.target.value) / 1000));
$('speed').value = String(prefs.speed);
$('loop').value = prefs.loop;
player.setSpeed(Number(prefs.speed));
player.setLoop(prefs.loop);
$('speed').addEventListener('change', (event) => {
  prefs.speed = Number(event.target.value);
  savePrefs(prefs);
  player.setSpeed(prefs.speed);
});
$('loop').addEventListener('change', (event) => {
  prefs.loop = event.target.value;
  savePrefs(prefs);
  player.setLoop(prefs.loop);
});

let lastFrame = performance.now();
function frame(now) {
  player.tick(Math.min(0.1, (now - lastFrame) / 1000));
  lastFrame = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Pieces: hover and focus shared by the view and the table
// ---------------------------------------------------------------------------

viewer.addEventListener('hoverchange', ({ detail }) => {
  if (detail.source !== 'table') details.setHover(detail.index);
});
viewer.addEventListener('focuschange', ({ detail }) => details.setFocus(detail.index));
details.addEventListener('hover', ({ detail }) => viewer.setHover(detail.index, 'table'));
details.addEventListener('focus', ({ detail }) => viewer.setFocus(detail.index, 'table'));

// ---------------------------------------------------------------------------
// The sidebar: one folder, plus the Demo and Dropped files groups
// ---------------------------------------------------------------------------

// Where the folder came from: {name, rescan?}. `rescan` reads it again (the
// refresh button, and coming back to the page); a folder input cannot.
let source = null;
let folderRoot = null;
let extras = []; // groups shown above the folder; their paths start with ':'
let scanning = false;
let lastScan = 0;
let scanCost = 0;

function rebuildTree(fresh) {
  const children = [...extras, ...(folderRoot?.children ?? [])];
  const root = folderRoot
    ? { ...folderRoot, children }
    : { name: '', path: ':', kind: 'dir', children };
  if (fresh) tree.setRoot(root);
  else tree.update(root);
  updateSidebar();
}

function updateSidebar() {
  const files = folderRoot ? countFiles(folderRoot) : 0;
  const all = countFiles(tree.root);
  $('folder-summary').hidden = !folderRoot;
  // Once a folder is open, picking another is a side action.
  $('open-folder').classList.toggle('primary', !folderRoot);
  if (folderRoot) {
    $('folder-name').textContent = folderRoot.name;
    $('folder-count').textContent = files === 1 ? '1 dump' : `${files} dumps`;
  }
  $('filter-label').hidden = all < 2;
  $('refresh-folder').hidden = !source?.rescan;
  $('sidebar-note').hidden = all > 0;
  $('sidebar-note').textContent = folderRoot ? 'No .npz files in this folder or its subfolders.' : 'No folder open yet.';
  if (!current && !tree.selected) {
    if (all) {
      showEmpty('Choose a dump in the sidebar', 'Each one opens in the views selected above. J and K step through them.', false);
    } else if (folderRoot) {
      showEmpty(`No dumps in ${folderRoot.name}`,
        'Dumps are the .npz files written by python -m scripts.dump_prediction ... --out <name>.npz. Pick the folder you saved them in.',
        true);
    }
  }
}

function setFolder(root, folderSource) {
  folderRoot = root;
  source = folderSource;
  extras = [];
  lastScan = performance.now();
  $('reopen-folder').hidden = true;
  rebuildTree(true);
}

async function openFolder() {
  if (!canPickFolder) {
    $('folder-input').click();
    return;
  }
  let handle;
  try {
    handle = await pickFolder();
  } catch (error) {
    if (error.name !== 'AbortError') showEmpty('The folder could not be opened', error.message, true);
    return;
  }
  await loadHandle(handle);
}

async function loadHandle(handle) {
  showLoading(`Reading ${handle.name}`);
  const started = performance.now();
  try {
    const root = await scanFolder(handle, (n) => showLoading(`Reading ${handle.name}: ${n} dumps so far`));
    setFolder(root, { name: handle.name, rescan: () => scanFolder(handle) });
    scanCost = performance.now() - started;
  } catch (error) {
    showEmpty(`${handle.name} could not be read`, error.message, true);
  } finally {
    hideLoading();
  }
}

/** Read the folder again; what was open and selected stays so. */
async function rescan(quiet) {
  const mine = source;
  if (!mine?.rescan || scanning) return;
  scanning = true;
  const started = performance.now();
  if (!quiet) showLoading(`Reading ${mine.name}`);
  try {
    const root = await mine.rescan();
    scanCost = performance.now() - started; // the scan alone, not the reload below
    if (source !== mine) return; // another folder was opened meanwhile
    if (!root) throw new Error('the server did not list it; is serve.py still running?');
    folderRoot = root;
    rebuildTree(false);
    await reloadIfChanged();
  } catch (error) {
    if (!quiet) {
      $('sidebar-note').hidden = false;
      $('sidebar-note').textContent = `${mine.name} could not be read again: ${error.message}`;
    }
  } finally {
    scanning = false;
    lastScan = performance.now();
    if (!quiet) hideLoading();
  }
}

/** A dump rewritten on disk (the same --out again) is read again. */
async function reloadIfChanged() {
  if (!current) return;
  const node = tree.find(current.node.path);
  if (!node || node.kind !== 'file') return;
  try {
    const file = await openFile(node);
    if (file.modified !== current.modified || file.size !== current.size) await openNode(node, { quiet: true });
  } catch {
    // Gone or unreadable now: keep showing what was read.
  }
}

function refreshWhenBack() {
  if (document.hidden || !source?.rescan || scanning) return;
  if (performance.now() - lastScan < REFRESH_GAP || scanCost > SLOW_SCAN) return;
  rescan(true);
}

window.addEventListener('focus', refreshWhenBack);
document.addEventListener('visibilitychange', refreshWhenBack);

$('open-folder').addEventListener('click', openFolder);
$('empty-open').addEventListener('click', openFolder);
$('refresh-folder').addEventListener('click', () => rescan(false));
$('folder-input').addEventListener('change', (event) => {
  const files = event.target.files;
  if (!files?.length) return;
  const root = treeFromFiles(files);
  setFolder(root, { name: root.name });
  event.target.value = '';
});

$('filter').addEventListener('input', (event) => tree.setFilter(event.target.value));

async function offerRemembered() {
  const handle = await rememberedFolder();
  if (!handle) return;
  if (await folderPermission(handle)) {
    await loadHandle(handle);
    return;
  }
  const button = $('reopen-folder');
  button.textContent = `Reopen ${handle.name}`;
  button.title = `Read ${handle.name} again (the browser asks first)`;
  button.hidden = false;
  button.onclick = async () => {
    if (await folderPermission(handle, true)) await loadHandle(handle);
  };
}

/** Add (or refresh) a group of loose files above the folder, and select its first file. */
async function addGroup(key, name, files) {
  const path = `:${key}`;
  const old = extras.find((group) => group.path === path);
  const nodes = new Map((old?.children ?? []).map((node) => [node.name, node]));
  for (const file of files) nodes.set(file.name, { ...file, path: `${path}/${file.name}`, kind: 'file' });
  const group = { name, path, kind: 'dir', children: [...nodes.values()] };
  extras = [group, ...extras.filter((g) => g.path !== path)];
  rebuildTree(false);
  const first = `${path}/${files[0].name}`;
  tree.select(first);
  await openNode(tree.find(first));
}

// ---------------------------------------------------------------------------
// Opening a dump
// ---------------------------------------------------------------------------

tree.addEventListener('select', ({ detail }) => openNode(detail.node));

function remember(key, dump) {
  cache.delete(key);
  cache.set(key, dump);
  const bytes = (d) => d.fragments.reduce((sum, f) => sum + f.positions.byteLength + f.faces.byteLength, 0);
  let total = 0;
  for (const value of cache.values()) total += bytes(value);
  for (const [oldKey, value] of cache) {
    if (total <= CACHE_BYTES || cache.size <= 1) break;
    total -= bytes(value);
    cache.delete(oldKey);
  }
}

async function openNode(node, { quiet = false } = {}) {
  if (!node) return;
  const token = ++loadToken;
  if (!quiet) showLoading(`Reading ${node.name}`);
  try {
    const file = await openFile(node);
    const key = `${node.path}|${file.modified}|${file.size}`;
    let dump = cache.get(key);
    if (!dump) dump = parseDump(await readNpz(await file.read()), node.name);
    remember(key, dump);
    if (token !== loadToken) return; // a later choice won
    current = { node, dump, size: file.size, modified: file.modified };
    tree.mark(node.path, null);
    hideEmpty();
    viewer.setDump(dump);
    details.show(dump, node, file.size);
    applyColourMode();
    document.title = `${node.name.replace(/\.npz$/i, '')} | Reassembly Visualizer`;
  } catch (error) {
    if (token !== loadToken) return;
    const message = error instanceof DumpError
      ? error.message : `${node.name} could not be read: ${error.message}`;
    tree.mark(node.path, message);
    current = null;
    viewer.setDump(null);
    details.showError(node, message);
    showEmpty(`${node.name} did not open`, message, false);
    document.title = 'Reassembly Visualizer';
  } finally {
    if (token === loadToken) hideLoading();
  }
}

function step(direction) {
  const files = tree.files();
  if (!files.length) return;
  // From the dump last chosen, even if it is still loading (J pressed twice goes two ahead).
  const at = files.findIndex((file) => file.path === (tree.selected ?? current?.node.path));
  const next = at < 0 ? files[direction > 0 ? 0 : files.length - 1]
    : files[(at + direction + files.length) % files.length];
  tree.select(next.path);
  openNode(next);
}

// -- the demo, and files dropped on the view --------------------------------

async function openDemo() {
  showLoading('Reading the demo');
  try {
    const response = await fetch('samples/demo-vase.npz', { cache: 'no-store' });
    if (!response.ok) throw new Error(`the demo file is missing (${response.status})`);
    const file = new File([await response.blob()], 'demo-vase.npz');
    await addGroup('demo', 'Demo', [{ name: file.name, file }]);
  } catch (error) {
    showEmpty('The demo did not open',
      `${error.message}. Start the app with start.bat or python serve.py, so the page can read its own files.`, true);
  } finally {
    hideLoading();
  }
}

$('demo-button').addEventListener('click', openDemo);

const viewport = $('viewport');
viewport.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  $('drop-hint').hidden = false;
});
viewport.addEventListener('dragleave', (event) => {
  if (!viewport.contains(event.relatedTarget)) $('drop-hint').hidden = true;
});
viewport.addEventListener('drop', async (event) => {
  event.preventDefault();
  $('drop-hint').hidden = true;
  const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.name.toLowerCase().endsWith('.npz'));
  if (!files.length) {
    if (!current) showEmpty('Nothing to open', 'Only .npz dumps can be dropped here. To open a whole folder, use Open folder.', true);
    return;
  }
  await addGroup('dropped', 'Dropped files', files.map((file) => ({ name: file.name, file })));
});

// ---------------------------------------------------------------------------
// Messages in the view
// ---------------------------------------------------------------------------

function showEmpty(title, text, withActions) {
  $('empty').hidden = false;
  $('empty-title').textContent = title;
  $('empty-text').textContent = text;
  $('empty-actions').hidden = !withActions;
}

function hideEmpty() {
  $('empty').hidden = true;
}

let loadingTimer = 0;

/** A loading note, shown only if the wait lasts long enough to notice. */
function showLoading(text, delay = 150) {
  $('loading-text').textContent = text;
  if ($('loading').hidden && !loadingTimer) {
    loadingTimer = window.setTimeout(() => {
      loadingTimer = 0;
      $('loading').hidden = false;
    }, delay);
  }
}

function hideLoading() {
  window.clearTimeout(loadingTimer);
  loadingTimer = 0;
  $('loading').hidden = true;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

$('help-button').addEventListener('click', () => $('help').showModal());

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  if ($('help').open) return;
  if (event.key === 'Escape' && viewMenu.open) {
    viewMenu.open = false;
    viewMenu.querySelector('summary').focus();
    event.preventDefault();
    return;
  }
  const target = event.target;
  const typing = target.closest?.('input, select, textarea, [contenteditable="true"]');
  const inTree = target.closest?.('#tree');
  const onControl = target.closest?.('button, summary, tr[data-index]');
  if (typing && target.id !== 'scrub') return;
  const key = event.key;
  if (key === ' ' && !onControl && !inTree && target.id !== 'scrub') {
    player.toggle();
  } else if ((key === 'ArrowLeft' || key === 'ArrowRight') && !inTree && target.id !== 'scrub') {
    player.seek(player.s + (key === 'ArrowRight' ? 0.02 : -0.02));
  } else if ((key === 'Home' || key === 'End') && !inTree && target.id !== 'scrub') {
    player.seek(key === 'End' ? 1 : 0);
  } else if (key === 'j' || key === 'J') {
    step(1);
  } else if (key === 'k' || key === 'K') {
    step(-1);
  } else if (key === 'r' || key === 'R') {
    viewer.resetView();
  } else if (key === 'c' || key === 'C') {
    // Piece colours, rotation error, position loss, round again; skipping what the dump lacks.
    const at = COLOURINGS.indexOf(prefs.colour);
    for (let k = 1; k <= COLOURINGS.length; k += 1) {
      const next = COLOURINGS[(at + k) % COLOURINGS.length];
      if (colouringAvailable(next)) {
        prefs.colour = next;
        break;
      }
    }
    savePrefs(prefs);
    applyColourMode();
  } else if (key === 'Escape') {
    if (viewer.focus >= 0) viewer.setFocus(-1, 'key');
    else if (narrowQuery.matches && detailsOverlay) $('details-close').click();
    else return;
  } else if (key === '?') {
    $('help').showModal();
  } else {
    return;
  }
  event.preventDefault();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  buildModeChips();
  applyTheme();
  applyModes();
  applyColourMode();
  applyDetails();
  player.seek(0);
  if (!canPickFolder) {
    $('empty-text').textContent += ' Your browser will ask to "upload" the folder: nothing is sent anywhere, the page only reads it.';
  }
  showLoading('Looking for dumps', 400);
  const served = await serverFolder();
  hideLoading();
  if (served) setFolder(served, { name: served.name, rescan: serverFolder });
  else await offerRemembered();
  if (new URLSearchParams(window.location.search).has('demo')) await openDemo();
}

start();

// For checking the app from the browser console, and for tests.
window.reassemblyVisualizer = { viewer, player, tree, details, openDemo, openNode, rescan };
