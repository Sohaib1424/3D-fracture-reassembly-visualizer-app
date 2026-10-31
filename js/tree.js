/**
 * The sidebar: the chosen folder's subfolders and .npz files.
 *
 * Rendered as a flat list of rows (one per visible folder or file) with the
 * WAI-ARIA tree pattern: arrow keys move, Right/Left open and close folders,
 * Enter opens a file. A filter narrows the list to matching files and opens
 * the folders on their path.
 */
const CHEVRON = '<svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FILE_ICON = '<svg class="file-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5h4.8l2.2 2.2v8.8h-7z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6.5 8.6l1.7-1.4 1.3 1.1" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const OPEN_ALL = 40; // a tree with this many files or fewer starts fully open

export class TreeView extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.root = null;
    this.expanded = new Set();
    this.selected = null;
    this.focused = null;
    this.filter = '';
    this.rows = [];
    this.notes = new Map(); // path -> message, for files that did not open
    container.addEventListener('keydown', (event) => this.onKey(event));
    container.addEventListener('click', (event) => {
      const row = event.target.closest('[data-path]');
      if (row) this.activate(row.dataset.path, true);
    });
  }

  setRoot(root) {
    this.root = root;
    this.expanded = new Set();
    this.selected = null;
    this.focused = null;
    this.notes.clear();
    if (root) {
      this.expanded.add(root.path);
      // Open everything when it is short enough to read at a glance.
      if (countFiles(root) <= OPEN_ALL) walk(root, (node) => { if (node.kind === 'dir') this.expanded.add(node.path); });
    }
    this.render();
  }

  /** A new scan of the same folder: what was open, selected or marked stays so. */
  update(root) {
    const before = new Set();
    walk(this.root, (node) => before.add(node.path));
    const now = new Set();
    walk(root, (node) => now.add(node.path));
    this.root = root;
    this.expanded = new Set([...this.expanded].filter((path) => now.has(path)));
    this.expanded.add(root.path);
    if (countFiles(root) <= OPEN_ALL) {
      walk(root, (node) => { if (node.kind === 'dir' && !before.has(node.path)) this.expanded.add(node.path); });
    }
    if (!now.has(this.selected)) this.selected = null;
    if (!now.has(this.focused)) this.focused = null;
    for (const path of this.notes.keys()) if (!now.has(path)) this.notes.delete(path);
    this.render();
  }

  /** Mark a file that did not open (`message`), or clear the mark (null). */
  mark(path, message) {
    if (message) this.notes.set(path, message);
    else this.notes.delete(path);
    this.render();
  }

  setFilter(text) {
    this.filter = text.trim().toLowerCase();
    this.render();
  }

  /** Files in display order (what Next and Previous step through). */
  files() {
    const out = [];
    walk(this.root, (node) => { if (node.kind === 'file' && this.matches(node)) out.push(node); });
    return out;
  }

  select(path, { reveal = true } = {}) {
    this.selected = path;
    this.focused = path;
    if (reveal) for (const dir of ancestors(path)) this.expanded.add(dir);
    this.render();
    const row = this.rowElement(path);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  find(path) {
    let found = null;
    walk(this.root, (node) => { if (node.path === path) found = node; });
    return found;
  }

  matches(node) {
    if (!this.filter) return true;
    return node.path.toLowerCase().includes(this.filter);
  }

  visibleRows() {
    const rows = [];
    if (!this.root) return rows;
    const visit = (node, depth) => {
      if (node.kind === 'file') {
        if (this.matches(node)) rows.push({ node, depth });
        return;
      }
      const files = countFiles(node, (file) => this.matches(file));
      if (!files) return;
      if (node !== this.root) rows.push({ node, depth, files });
      const open = node === this.root || this.filter || this.expanded.has(node.path);
      if (open) for (const child of node.children) visit(child, node === this.root ? depth : depth + 1);
    };
    visit(this.root, 0);
    return rows;
  }

  render() {
    this.rows = this.visibleRows();
    const fragment = document.createDocumentFragment();
    if (!this.focused || !this.rows.some((r) => r.node.path === this.focused)) {
      this.focused = this.rows.find((r) => r.node.path === this.selected)?.node.path ?? this.rows[0]?.node.path ?? null;
    }
    for (const { node, depth, files } of this.rows) {
      const row = document.createElement('div');
      row.className = `tree-row ${node.kind}`;
      row.dataset.path = node.path;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(depth + 1));
      row.style.setProperty('--depth', depth);
      row.tabIndex = node.path === this.focused ? 0 : -1;
      if (node.kind === 'dir') {
        const open = Boolean(this.filter) || this.expanded.has(node.path);
        row.setAttribute('aria-expanded', String(open));
        row.innerHTML = `${CHEVRON}<span class="name"></span><span class="count"></span>`;
        row.querySelector('.count').textContent = String(files);
      } else {
        row.setAttribute('aria-selected', String(node.path === this.selected));
        row.innerHTML = `${FILE_ICON}<span class="name"></span>`;
        if (this.notes.has(node.path)) row.classList.add('unreadable');
      }
      const name = row.querySelector('.name');
      name.textContent = node.kind === 'file' ? node.name.replace(/\.npz$/i, '') : node.name;
      const note = this.notes.get(node.path);
      row.title = note ? `${node.path}\n${note}` : node.path;
      fragment.append(row);
    }
    this.container.replaceChildren(fragment);
    this.dispatchEvent(new CustomEvent('render', { detail: { rows: this.rows.length } }));
  }

  rowElement(path) {
    return this.container.querySelector(`[data-path="${CSS.escape(path)}"]`);
  }

  activate(path, fromPointer = false) {
    const node = this.rows.find((r) => r.node.path === path)?.node;
    if (!node) return;
    this.focused = path;
    if (node.kind === 'dir') {
      if (this.expanded.has(path)) this.expanded.delete(path);
      else this.expanded.add(path);
      this.render();
      this.rowElement(path)?.focus();
      return;
    }
    this.selected = path;
    this.render();
    if (!fromPointer) this.rowElement(path)?.focus();
    this.dispatchEvent(new CustomEvent('select', { detail: { node } }));
  }

  onKey(event) {
    const index = this.rows.findIndex((r) => r.node.path === this.focused);
    if (index < 0) return;
    const { node } = this.rows[index];
    const move = (to) => {
      const target = this.rows[Math.max(0, Math.min(this.rows.length - 1, to))];
      if (!target) return;
      this.focused = target.node.path;
      this.render();
      this.rowElement(this.focused)?.focus();
    };
    switch (event.key) {
      case 'ArrowDown': move(index + 1); break;
      case 'ArrowUp': move(index - 1); break;
      case 'Home': move(0); break;
      case 'End': move(this.rows.length - 1); break;
      case 'ArrowRight':
        if (node.kind === 'dir' && !this.expanded.has(node.path) && !this.filter) this.activate(node.path);
        else move(index + 1);
        break;
      case 'ArrowLeft':
        if (node.kind === 'dir' && this.expanded.has(node.path) && !this.filter) this.activate(node.path);
        else {
          const parent = this.rows.findIndex((r) => r.node.path === parentPath(node.path));
          if (parent >= 0) move(parent);
        }
        break;
      case 'Enter':
      case ' ':
        this.activate(node.path);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
}

export function walk(node, visit) {
  if (!node) return;
  visit(node);
  if (node.children) for (const child of node.children) walk(child, visit);
}

export function countFiles(node, keep = () => true) {
  let n = 0;
  walk(node, (child) => { if (child.kind === 'file' && keep(child)) n += 1; });
  return n;
}

function parentPath(path) {
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : '';
}

function ancestors(path) {
  const out = [];
  let current = parentPath(path);
  while (current) {
    out.push(current);
    current = parentPath(current);
  }
  return out;
}
