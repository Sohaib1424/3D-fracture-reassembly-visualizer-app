/**
 * The right-hand panel: what the selected dump is, its scores, and one row
 * per piece. Hovering a row lights the piece in every panel; clicking it
 * fades the others back.
 */
import { pieceColour } from './dump.js';
import { formatBytes, formatChamfer, formatDegrees, formatLoss } from './format.js';
import { ANCHOR_COLOUR, MEASURES, RAMP, measureColour, scoredMean } from './measures.js';

const PLACED = 0.01; // the benchmark's part-accuracy threshold on a piece's Chamfer distance

export class DetailsView extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.dump = null;
    this.node = null;
    this.colourMode = 'pieces';
    this.sort = { key: 'index', descending: false };
    this.focus = -1;
    this.hover = -1;
    container.addEventListener('pointerover', (event) => {
      const row = event.target.closest('tr[data-index]');
      this.dispatchEvent(new CustomEvent('hover', { detail: { index: row ? Number(row.dataset.index) : -1 } }));
    });
    container.addEventListener('pointerleave', () => {
      this.dispatchEvent(new CustomEvent('hover', { detail: { index: -1 } }));
    });
    container.addEventListener('click', (event) => {
      const header = event.target.closest('th[data-sort]');
      if (header) {
        const key = header.dataset.sort;
        this.sort = { key, descending: this.sort.key === key ? !this.sort.descending : key !== 'index' };
        this.renderTable();
        return;
      }
      const row = event.target.closest('tr[data-index]');
      if (row) this.dispatchEvent(new CustomEvent('focus', { detail: { index: Number(row.dataset.index) } }));
    });
    container.addEventListener('keydown', (event) => {
      const row = event.target.closest('tr[data-index]');
      if (row && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        this.dispatchEvent(new CustomEvent('focus', { detail: { index: Number(row.dataset.index) } }));
      }
    });
    this.showEmpty();
  }

  showEmpty() {
    this.dump = null;
    this.container.innerHTML = '<p class="details-empty">Choose a dump in the sidebar to see its scene, scores and pieces.</p>';
  }

  showError(node, message) {
    this.dump = null;
    this.node = node;
    this.container.innerHTML = '<div class="details-head"><h2></h2><p class="path"></p></div><p class="details-error"></p>';
    this.container.querySelector('h2').textContent = node.name;
    this.container.querySelector('.path').textContent = breakable(displayPath(node.path));
    this.container.querySelector('.details-error').textContent = message;
  }

  show(dump, node, size) {
    this.dump = dump;
    this.node = node;
    this.focus = -1;
    this.hover = -1;
    const meanRotation = scoredMean(dump, dump.geodesic);
    const meanPosition = scoredMean(dump, dump.positionLoss);
    const epoch = Number.isFinite(dump.epoch) && dump.epoch >= 0 ? `, epoch ${dump.epoch + 1}` : '';
    const checkpoint = dump.checkpoint ? `${basename(dump.checkpoint)}${epoch}` : '';
    const rotations = {
      matched: 'Fitted from the embedding matches',
      network: 'The rotation head',
    }[dump.rotations] ?? dump.rotations;
    const seed = Number.isFinite(dump.seed)
      ? (dump.seed < 0 ? 'The scene’s own validation draw' : String(dump.seed)) : '';

    const facts = [
      ['Scene', dump.scene],
      ['Checkpoint', checkpoint],
      ['Rotations', rotations],
      ['Scatter seed', seed],
      ['Pieces', `${dump.fragments.length}${dump.anchor >= 0 ? `, piece ${dump.anchor} is the anchor` : ''}`],
      ['File size', Number.isFinite(size) ? formatBytes(size) : ''],
    ].filter(([, value]) => value);
    const scores = [
      ['Mean rotation error', Number.isFinite(meanRotation) ? formatDegrees(meanRotation) : '',
        `${MEASURES.rotation.help} Over every piece but the anchor, whose pose is given.`],
      ['Mean position loss', Number.isFinite(meanPosition) ? formatLoss(meanPosition) : '',
        `${MEASURES.position.help} Over every piece but the anchor, as the training averages it.`],
      ['Part accuracy', format(dump.partAccuracy, 3), 'Share of pieces placed within Chamfer distance 0.01'],
      ['RMSE(T)', format(dump.rmseT, 4), 'Translation error, world units'],
      ['Chamfer', format(dump.chamfer, 5), 'Whole shape against the true one'],
      ['Matches', Number.isFinite(dump.matches) ? String(Math.round(dump.matches)) : '', 'Embedding matches the translation solver used'],
    ].filter(([, value]) => value);

    this.container.innerHTML = `
      <div class="details-head"><h2></h2><p class="path"></p></div>
      <dl class="facts"></dl>
      <section class="scores" aria-label="Scores"><dl></dl></section>
      ${dump.hasPlacement ? '' : '<p class="note">This dump has no solver placement, so every piece ends at its true position.</p>'}
      <div class="legend" hidden></div>
      <table class="pieces">
        <thead><tr>
          <th scope="col" data-sort="index">Piece</th>
          <th scope="col" data-sort="rotation" class="num"></th>
          <th scope="col" data-sort="position" class="num"></th>
          <th scope="col" data-sort="chamfer" class="num" title="The piece’s Chamfer distance where the solver placed it; red at 0.01 or more, the benchmark’s limit for a placed piece">Chamfer</th>
        </tr></thead>
        <tbody></tbody>
      </table>`;
    this.container.querySelector('h2').textContent = node.name;
    this.container.querySelector('.path').textContent = breakable(displayPath(node.path));
    for (const measure of Object.values(MEASURES)) {
      const header = this.container.querySelector(`th[data-sort="${measure.id}"]`);
      header.textContent = measure.column;
      header.title = `${measure.name}: ${measure.help}`;
    }
    const factList = this.container.querySelector('.facts');
    for (const [term, value] of facts) factList.append(definition(term, value));
    const scoreList = this.container.querySelector('.scores dl');
    for (const [term, value, hint] of scores) scoreList.append(definition(term, value, hint));
    this.renderLegend();
    this.renderTable();
  }

  setColourMode(mode) {
    this.colourMode = mode;
    if (!this.dump) return;
    this.renderLegend();
    this.renderTable();
  }

  setFocus(index) {
    this.focus = index;
    this.updateRows();
  }

  setHover(index) {
    this.hover = index;
    this.updateRows();
  }

  renderLegend() {
    const legend = this.container.querySelector('.legend');
    if (!legend) return;
    const measure = MEASURES[this.colourMode];
    const show = Boolean(measure && this.dump && measure.values(this.dump));
    legend.hidden = !show;
    if (!show) return;
    const stops = RAMP.map(([t, c]) => `rgb(${c.join(',')}) ${Math.round(t * 100)}%`).join(', ');
    legend.innerHTML = `<p></p><div class="ramp" style="background: linear-gradient(90deg, ${stops})"></div><div class="ticks"></div>`;
    legend.querySelector('p').textContent = measure.legend;
    const ticks = legend.querySelector('.ticks');
    for (const value of measure.ticks) {
      const tick = document.createElement('span');
      tick.textContent = measure.tick(value);
      tick.style.left = `${measure.scale(value) * 100}%`;
      ticks.append(tick);
    }
  }

  renderTable() {
    const dump = this.dump;
    const body = this.container.querySelector('tbody');
    if (!dump || !body) return;
    const order = dump.fragments.map((_, i) => i);
    const value = (i) => {
      const measure = MEASURES[this.sort.key];
      // The anchor's pose is given: it sorts with the best.
      if (measure) return i === dump.anchor ? -1 : (measure.values(dump)?.[i] ?? -Infinity);
      if (this.sort.key === 'chamfer') return dump.partChamfer?.[i] ?? -Infinity;
      return i;
    };
    order.sort((a, b) => (this.sort.descending ? value(b) - value(a) : value(a) - value(b)));
    for (const header of this.container.querySelectorAll('th[data-sort]')) {
      const active = header.dataset.sort === this.sort.key;
      header.setAttribute('aria-sort', active ? (this.sort.descending ? 'descending' : 'ascending') : 'none');
    }
    const colouring = MEASURES[this.colourMode];
    const colourValues = colouring ? colouring.values(dump) : null;
    const rows = order.map((i) => {
      const row = document.createElement('tr');
      row.dataset.index = String(i);
      row.tabIndex = 0;
      let rgb = pieceColour(i);
      if (colourValues) rgb = i === dump.anchor ? ANCHOR_COLOUR : measureColour(colouring, colourValues[i]);
      const errors = i === dump.anchor
        ? '<td class="num anchor" colspan="2">anchor</td>'
        : Object.values(MEASURES).map((measure) => `<td class="num">${measure.format(measure.values(dump)?.[i])}</td>`).join('');
      const chamfer = dump.partChamfer?.[i];
      const placed = i !== dump.anchor && Number.isFinite(chamfer)
        ? (chamfer < PLACED ? 'placed' : 'off') : '';
      row.innerHTML = `
        <td><span class="swatch" style="background: rgb(${rgb.join(',')})"></span>${i}</td>
        ${errors}
        <td class="num"><span class="chamfer ${placed}">${formatChamfer(chamfer)}</span></td>`;
      row.title = i === dump.anchor
        ? 'The anchor: the largest piece, set to its true pose before scoring'
        : `Piece ${i}${placed ? (placed === 'placed' ? ': placed (Chamfer below 0.01)' : ': not placed (Chamfer 0.01 or more)') : ''}`;
      return row;
    });
    body.replaceChildren(...rows);
    this.updateRows();
  }

  updateRows() {
    for (const row of this.container.querySelectorAll('tr[data-index]')) {
      const index = Number(row.dataset.index);
      row.classList.toggle('focused', index === this.focus);
      row.classList.toggle('hovered', index === this.hover);
      row.setAttribute('aria-pressed', String(index === this.focus));
    }
  }
}

function definition(term, value, hint) {
  const wrapper = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = term;
  dd.textContent = breakable(value);
  if (hint) wrapper.title = hint;
  wrapper.append(dt, dd);
  return wrapper;
}

/** Long paths may break after a slash rather than inside a name. */
function breakable(text) {
  return String(text).replace(/([/\\])/g, '$1\u200b');
}

function format(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : '';
}

/** Paths of the Demo and Dropped files groups start with ':' internally. */
function displayPath(path) {
  return path.replace(/^:demo\//, 'Demo/').replace(/^:dropped\//, 'Dropped files/');
}

function basename(path) {
  return String(path).split(/[\\/]/).pop();
}
