/**
 * Reaching a folder of dumps from the page, in one of three ways.
 *
 *   serve.py FOLDER   the server lists the folder and hands out its .npz files
 *                     (every browser; the folder is the one the server was
 *                     started with)
 *   Open folder       Chrome and Edge give a real folder handle (File System
 *                     Access API): the page can scan it again and, with the
 *                     visitor's permission, reopen it on the next visit
 *   folder input      other browsers read a folder through a file input,
 *                     which lists every file once
 *
 * Either way the files stay on this computer.
 *
 * A tree node is `{name, path, kind: 'dir' | 'file', children?}`, and a file
 * node also carries one of `handle`, `file` or `url` (with `size`, `modified`).
 */
const DB_NAME = 'reassembly-visualizer';
const STORE = 'handles';
const SKIP = new Set(['node_modules', '__pycache__', '.git', '.venv', 'venv', '.idea', '.vscode']);
const MAX_DEPTH = 12;
const APP = 'reassembly-visualizer';

export const canPickFolder = typeof window.showDirectoryPicker === 'function';

export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ id: 'reassembly-dumps', mode: 'read' });
  await rememberFolder(handle);
  return handle;
}

/** Every .npz under the folder, as a tree; folders without any are left out. */
export async function scanFolder(handle, onProgress = () => {}) {
  let seen = 0;
  const visit = async (dirHandle, path, depth) => {
    const node = { name: dirHandle.name, path, kind: 'dir', children: [], handle: dirHandle };
    if (depth > MAX_DEPTH) return node;
    for await (const [name, child] of dirHandle.entries()) {
      if (child.kind === 'directory') {
        if (name.startsWith('.') || SKIP.has(name)) continue;
        const sub = await visit(child, `${path}/${name}`, depth + 1);
        if (sub.children.length) node.children.push(sub);
      } else if (name.toLowerCase().endsWith('.npz')) {
        node.children.push({ name, path: `${path}/${name}`, kind: 'file', handle: child });
        seen += 1;
        if (seen % 50 === 0) onProgress(seen);
      }
    }
    sortChildren(node);
    return node;
  };
  return visit(handle, handle.name, 0);
}

/** The same tree from a folder input's file list (webkitRelativePath gives the path). */
export function treeFromFiles(fileList, rootName = null) {
  const files = Array.from(fileList).filter((file) => file.name.toLowerCase().endsWith('.npz'));
  const first = (files[0]?.webkitRelativePath || '').split('/')[0];
  const name = rootName || first || 'Files';
  const root = { name, path: name, kind: 'dir', children: [] };
  for (const file of files) {
    const parts = (file.webkitRelativePath || `${name}/${file.name}`).split('/');
    if (parts[0] !== name) parts.unshift(name);
    if (parts.slice(1, -1).some((part) => part.startsWith('.') || SKIP.has(part))) continue;
    let node = root;
    for (let i = 1; i < parts.length - 1; i += 1) {
      const path = parts.slice(0, i + 1).join('/');
      let next = node.children.find((child) => child.kind === 'dir' && child.name === parts[i]);
      if (!next) {
        next = { name: parts[i], path, kind: 'dir', children: [] };
        node.children.push(next);
      }
      node = next;
    }
    node.children.push({ name: file.name, path: parts.join('/'), kind: 'file', file });
  }
  sortTree(root);
  return root;
}

/** The folder serve.py was started with, as a tree, or null if there is none. */
export async function serverFolder() {
  let body;
  try {
    const response = await fetch('api/folder', { cache: 'no-store' });
    if (!response.ok) return null;
    body = await response.json();
  } catch {
    return null;
  }
  if (body?.app !== APP || !body.folder) return null;
  sortTree(body.folder);
  return body.folder;
}

/**
 * What opening a file needs: its size and modification time (to tell a
 * rewritten dump from the one already read) and a way to read its bytes.
 */
export async function openFile(node) {
  if (node.url) {
    return {
      size: node.size,
      modified: node.modified,
      read: async () => {
        const response = await fetch(node.url, { cache: 'no-store' });
        if (response.status === 404) throw new Error('it is no longer in the folder');
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      },
    };
  }
  const file = node.file ?? await node.handle.getFile();
  return {
    size: file.size,
    modified: file.lastModified,
    read: async () => new Uint8Array(await file.arrayBuffer()),
  };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortChildren(node) {
  node.children.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name)
    : a.kind === 'dir' ? -1 : 1));
}

/** Folders first, then files, each in natural order (mug_2 before mug_10). */
export function sortTree(node) {
  if (node?.kind !== 'dir') return;
  sortChildren(node);
  for (const child of node.children) sortTree(child);
}

// -- remembering the folder between visits (Chrome and Edge only) -----------

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rememberFolder(handle) {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(handle, 'last');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  } catch {
    // Remembering is a convenience: without it, the folder is picked again next time.
  }
}

export async function rememberedFolder() {
  if (!canPickFolder) return null;
  try {
    const db = await openDatabase();
    const handle = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get('last');
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

/** Whether the page may read the folder; `ask` shows the browser's prompt (needs a click). */
export async function folderPermission(handle, ask = false) {
  try {
    const options = { mode: 'read' };
    if ((await handle.queryPermission(options)) === 'granted') return true;
    if (!ask) return false;
    return (await handle.requestPermission(options)) === 'granted';
  } catch {
    return false;
  }
}
