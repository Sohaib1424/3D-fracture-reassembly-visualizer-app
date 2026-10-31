/**
 * The 3D view: one WebGL canvas, one panel per selected mode.
 *
 * Every panel has its own scene but shares the fragment geometry and one
 * camera orientation: dragging in any panel turns them all. The camera works
 * in a normalised space (content of radius 1 at the origin) and each panel
 * maps it onto its own content, so panels stay aligned whatever their size.
 * Framing is computed once per dump from every frame a panel can show, so the
 * camera never moves on its own while pieces converge.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { pieceColour, poseAt, truthPose, viewBounds } from './dump.js';
import { ANCHOR_COLOUR, MEASURES, measureColour } from './measures.js';

const FOV = 30;
const HALF_FOV = THREE.MathUtils.degToRad(FOV / 2);
const BASE_DISTANCE = 1 / Math.sin(HALF_FOV);
const MARGIN = 1.06;
const GAP = 6;
const VIEW_DIRECTIONS = {
  z: new THREE.Vector3(1.35, -1.8, 0.95).normalize(),
  y: new THREE.Vector3(1.35, 0.95, 1.8).normalize(),
};

export class Viewer extends EventTarget {
  constructor({ viewport, canvas, backdrops, labels, tooltip }) {
    super();
    this.viewport = viewport;
    this.canvas = canvas;
    this.backdrops = backdrops;
    this.labels = labels;
    this.tooltip = tooltip;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;

    this.master = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
    this.upAxis = 'z';
    this.makeControls();

    this.dump = null;
    this.modes = [];
    this.panels = [];
    this.geometries = [];
    this.materials = [];
    // The original, drawn faintly behind the prediction. Pushed back in depth so
    // that where a piece sits exactly in place the ghost hides behind it instead
    // of flickering through: it shows only where the prediction is off.
    this.ghostMaterial = new THREE.MeshStandardMaterial({
      color: 0x6b7680, transparent: true, opacity: 0.16, depthWrite: false,
      side: THREE.DoubleSide, roughness: 0.9, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
    });
    this.progress = 0;
    this.spread = 1;
    this.colourMode = 'pieces';
    this.scaleMode = 'fit';
    this.shading = 'smooth';
    this.focus = -1;
    this.hover = -1;
    this.dirty = true;
    this.size = { width: 1, height: 1 };
    this.pointer = null;
    this.pointerMoved = false;
    this.lastMove = 0;
    this.pickCost = 0;
    this.pressed = null;
    this.raycaster = new THREE.Raycaster();

    new ResizeObserver(() => this.resize()).observe(viewport);
    canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    canvas.addEventListener('pointerdown', (event) => { this.pressed = { x: event.clientX, y: event.clientY }; });
    canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
    canvas.addEventListener('pointerleave', () => { this.pointer = null; this.setHover(-1, 'canvas'); this.hideTooltip(); });
    canvas.addEventListener('dblclick', () => this.resetView());
    this.resize();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // -- camera ---------------------------------------------------------------

  makeControls() {
    const previous = this.controls;
    this.master.up.copy(this.upAxis === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0));
    if (previous) previous.dispose();
    // OrbitControls fixes its orbit axis from camera.up when it is built, so a
    // new up axis means new controls.
    this.controls = new OrbitControls(this.master, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.9;
    this.controls.minDistance = BASE_DISTANCE * 0.12;
    this.controls.maxDistance = BASE_DISTANCE * 8;
    this.controls.addEventListener('change', () => this.invalidate());
    this.resetView();
  }

  setUpAxis(axis) {
    if (axis === this.upAxis) return;
    this.upAxis = axis;
    this.makeControls();
  }

  resetView() {
    this.controls.target.set(0, 0, 0);
    this.master.position.copy(VIEW_DIRECTIONS[this.upAxis]).multiplyScalar(BASE_DISTANCE);
    this.master.lookAt(0, 0, 0);
    this.controls.update();
    this.invalidate();
  }

  // -- content ----------------------------------------------------------------

  setDump(dump) {
    this.disposeContent();
    this.dump = dump;
    this.focus = -1;
    this.hover = -1;
    if (!dump) {
      this.buildPanels();
      return;
    }
    for (const fragment of dump.fragments) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(fragment.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(fragment.faces, 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      this.geometries.push(geometry);
      this.materials.push(new THREE.MeshStandardMaterial({
        roughness: 0.62, metalness: 0.0, side: THREE.DoubleSide,
        flatShading: this.shading === 'faceted',
      }));
    }
    this.applyColours();
    this.buildPanels();
  }

  setModes(modes) {
    this.modes = modes;
    this.buildPanels();
  }

  setProgress(s) {
    this.progress = s;
    for (const panel of this.panels) {
      if (panel.mode.animated) this.posePanel(panel);
      this.updateLabel(panel);
    }
    this.invalidate();
  }

  setColourMode(mode) {
    this.colourMode = mode;
    this.applyColours();
  }

  setScaleMode(mode) {
    this.scaleMode = mode;
    this.invalidate();
  }

  /** How far apart the scattered pieces are drawn (1 = as dumped). */
  setSpread(spread) {
    this.spread = spread;
    if (!this.dump) return;
    for (const panel of this.panels) {
      panel.bounds = viewBounds(this.dump, panel.mode, 11, spread);
      this.posePanel(panel);
    }
    this.invalidate();
  }

  setShading(shading) {
    this.shading = shading;
    for (const material of this.materials) {
      material.flatShading = shading === 'faceted';
      material.needsUpdate = true;
    }
    this.invalidate();
  }

  setTheme(theme) {
    this.ghostMaterial.color.set(theme === 'dark' ? 0xc9d0d6 : 0x56616b);
    this.ghostMaterial.opacity = theme === 'dark' ? 0.13 : 0.16;
    this.invalidate();
  }

  /** Every piece but `index` fades back; -1 shows all again. */
  setFocus(index, source = 'api') {
    this.focus = index === this.focus ? -1 : index;
    this.applyEmphasis();
    this.dispatchEvent(new CustomEvent('focuschange', { detail: { index: this.focus, source } }));
  }

  setHover(index, source = 'api') {
    if (index === this.hover) return;
    this.hover = index;
    this.applyEmphasis();
    this.dispatchEvent(new CustomEvent('hoverchange', { detail: { index, source } }));
  }

  /** Colour by piece ('pieces') or by a measure in measures.js ('rotation', 'position'). */
  applyColours() {
    const dump = this.dump;
    if (!dump) return;
    const measure = MEASURES[this.colourMode];
    const values = measure ? measure.values(dump) : null;
    this.materials.forEach((material, i) => {
      let rgb = pieceColour(i);
      if (values) rgb = i === dump.anchor ? ANCHOR_COLOUR : measureColour(measure, values[i]);
      material.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
    });
    this.applyEmphasis();
  }

  applyEmphasis() {
    this.materials.forEach((material, i) => {
      const faded = this.focus >= 0 && i !== this.focus;
      material.transparent = faded;
      material.opacity = faded ? 0.13 : 1;
      material.depthWrite = !faded;
      const lit = i === this.hover || (this.focus === i && this.hover < 0);
      material.emissive.copy(material.color).multiplyScalar(lit ? 0.32 : 0);
      material.needsUpdate = true;
    });
    this.invalidate();
  }

  disposeContent() {
    for (const panel of this.panels) panel.scene.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries = [];
    this.materials = [];
  }

  buildPanels() {
    this.panels = [];
    this.backdrops.replaceChildren();
    this.labels.replaceChildren();
    if (!this.dump) {
      this.invalidate();
      return;
    }
    for (const mode of this.modes) {
      const scene = new THREE.Scene();
      const hemi = new THREE.HemisphereLight(0xffffff, 0x4a5056, 1.5);
      hemi.position.copy(this.master.up);
      const key = new THREE.DirectionalLight(0xffffff, 2.1);
      scene.add(hemi, key, key.target);
      const pieces = this.geometries.map((geometry, i) => {
        const mesh = new THREE.Mesh(geometry, this.materials[i]);
        mesh.matrixAutoUpdate = false;
        mesh.userData.index = i;
        scene.add(mesh);
        return mesh;
      });
      const ghosts = mode.ghost
        ? this.geometries.map((geometry, i) => {
          const mesh = new THREE.Mesh(geometry, this.ghostMaterial);
          mesh.matrixAutoUpdate = false;
          mesh.renderOrder = 2;
          setMatrix(mesh, truthPose(this.dump, i));
          scene.add(mesh);
          return mesh;
        })
        : [];
      const backdrop = document.createElement('div');
      backdrop.className = 'panel-backdrop';
      this.backdrops.append(backdrop);
      const label = document.createElement('div');
      label.className = 'panel-label';
      label.innerHTML = '<span class="panel-name"></span><span class="panel-progress"></span>';
      label.querySelector('.panel-name').textContent = mode.name;
      this.labels.append(label);
      const panel = {
        mode, scene, pieces, ghosts, hemi, key, backdrop, label,
        camera: new THREE.PerspectiveCamera(FOV, 1, 0.01, 100),
        bounds: viewBounds(this.dump, mode, 11, this.spread),
        rect: { x: 0, y: 0, w: 1, h: 1 },
      };
      this.posePanel(panel);
      this.updateLabel(panel);
      this.panels.push(panel);
    }
    this.layout();
  }

  posePanel(panel) {
    const { mode } = panel;
    panel.pieces.forEach((mesh, i) => {
      let pose;
      if (mode.target === 'truth-static') pose = truthPose(this.dump, i);
      else pose = poseAt(this.dump, i, mode.animated ? this.progress : mode.s, mode.target, this.spread);
      setMatrix(mesh, pose);
    });
  }

  updateLabel(panel) {
    const progress = panel.label.querySelector('.panel-progress');
    progress.textContent = panel.mode.animated ? `${Math.round(this.progress * 100)}%` : '';
  }

  // -- layout and drawing -----------------------------------------------------

  resize() {
    const width = Math.max(1, this.viewport.clientWidth);
    const height = Math.max(1, this.viewport.clientHeight);
    this.size = { width, height };
    // Moving the window to a screen with another pixel density resizes it too.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.layout();
  }

  /** Equal cells in the arrangement that makes them largest; a short last row is centred. */
  layout() {
    const { width, height } = this.size;
    const n = this.panels.length;
    if (!n) {
      this.invalidate();
      return;
    }
    let best = { cols: 1, rows: n, score: -1 };
    for (let cols = 1; cols <= n; cols += 1) {
      const rows = Math.ceil(n / cols);
      const w = (width - GAP * (cols - 1)) / cols;
      const h = (height - GAP * (rows - 1)) / rows;
      const score = Math.min(w, h * 1.25);
      if (score > best.score + 0.5) best = { cols, rows, score };
    }
    const { cols, rows } = best;
    const w = (width - GAP * (cols - 1)) / cols;
    const h = (height - GAP * (rows - 1)) / rows;
    this.panels.forEach((panel, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, n - row * cols);
      const col = i % cols;
      const indent = ((cols - inRow) * (w + GAP)) / 2;
      const rect = {
        x: Math.round(indent + col * (w + GAP)),
        y: Math.round(row * (h + GAP)),
        w: Math.round(w),
        h: Math.round(h),
      };
      panel.rect = rect;
      for (const element of [panel.backdrop, panel.label]) {
        element.style.left = `${rect.x}px`;
        element.style.top = `${rect.y}px`;
        element.style.width = `${rect.w}px`;
      }
      panel.backdrop.style.height = `${rect.h}px`;
    });
    this.invalidate();
  }

  radiusOf(panel) {
    if (this.scaleMode === 'fit') return panel.bounds.radius;
    return Math.max(...this.panels.map((p) => p.bounds.radius));
  }

  invalidate() {
    this.dirty = true;
  }

  loop() {
    requestAnimationFrame(this.loop);
    const moved = this.controls.update();
    // Picking a heavy dump (a million triangles) takes tens of milliseconds;
    // then it waits until the pointer rests, so turning the view stays smooth.
    if (this.pointerMoved && (this.pickCost < 8 || performance.now() - this.lastMove > 80)) {
      this.pointerMoved = false;
      const started = performance.now();
      this.pick();
      this.pickCost = performance.now() - started;
    }
    if (!this.dirty && !moved) return;
    this.dirty = false;
    this.render();
  }

  render() {
    const { height } = this.size;
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    if (!this.panels.length) return;
    this.renderer.setScissorTest(true);
    const offset = new THREE.Vector3().subVectors(this.master.position, this.controls.target);
    const zoom = offset.length() / BASE_DISTANCE;
    const direction = offset.normalize();
    for (const panel of this.panels) {
      const { x, y, w, h } = panel.rect;
      const glY = height - y - h;
      this.renderer.setViewport(x, glY, w, h);
      this.renderer.setScissor(x, glY, w, h);
      const radius = this.radiusOf(panel);
      const aspect = w / h;
      const halfH = Math.atan(Math.tan(HALF_FOV) * aspect);
      const distance = ((radius * MARGIN) / Math.sin(Math.min(HALF_FOV, halfH))) * zoom;
      const centre = new THREE.Vector3(...panel.bounds.centre);
      const target = centre.addScaledVector(this.controls.target, radius);
      const camera = panel.camera;
      camera.position.copy(target).addScaledVector(direction, distance);
      camera.up.copy(this.master.up);
      camera.lookAt(target);
      camera.aspect = aspect;
      camera.near = Math.max(radius * 0.01, distance - radius * 4);
      camera.far = distance + radius * 4;
      camera.updateProjectionMatrix();
      panel.key.position.copy(camera.position).addScaledVector(this.master.up, radius * 0.8);
      panel.key.target.position.copy(target);
      panel.hemi.position.copy(this.master.up);
      this.renderer.render(panel.scene, camera);
    }
  }

  // -- pointing ---------------------------------------------------------------

  onPointerMove(event) {
    const box = this.canvas.getBoundingClientRect();
    this.pointer = { x: event.clientX - box.left, y: event.clientY - box.top, buttons: event.buttons };
    this.pointerMoved = true;
    this.lastMove = performance.now();
    if (this.pickCost >= 8) this.hideTooltip();
  }

  onPointerUp(event) {
    const start = this.pressed;
    this.pressed = null;
    if (!start || event.button !== 0) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    if (this.pointerMoved) {
      // A click before the deferred pick ran: pick what is under it now.
      this.pointerMoved = false;
      const box = this.canvas.getBoundingClientRect();
      this.pointer = { x: event.clientX - box.left, y: event.clientY - box.top, buttons: 0 };
      this.pick();
    }
    if (this.hover >= 0) this.setFocus(this.hover, 'canvas');
    else if (this.focus >= 0) this.setFocus(-1, 'canvas');
  }

  pick() {
    const p = this.pointer;
    if (!p || p.buttons) {
      this.hideTooltip();
      return;
    }
    const panel = this.panels.find(({ rect }) => p.x >= rect.x && p.x < rect.x + rect.w
      && p.y >= rect.y && p.y < rect.y + rect.h);
    let index = -1;
    if (panel) {
      const ndc = new THREE.Vector2(((p.x - panel.rect.x) / panel.rect.w) * 2 - 1,
        -((p.y - panel.rect.y) / panel.rect.h) * 2 + 1);
      this.raycaster.setFromCamera(ndc, panel.camera);
      const hit = this.raycaster.intersectObjects(panel.pieces, false)[0];
      if (hit) index = hit.object.userData.index;
    }
    this.setHover(index, 'canvas');
    if (index >= 0) this.showTooltip(index, p);
    else this.hideTooltip();
  }

  showTooltip(index, p) {
    const dump = this.dump;
    const lines = [`Piece ${index}`];
    if (index === dump.anchor) {
      lines.push('The anchor, set to its true pose');
    } else {
      for (const measure of Object.values(MEASURES)) {
        const values = measure.values(dump);
        if (values) lines.push(`${measure.name} ${measure.format(values[index])}`);
      }
    }
    this.tooltip.replaceChildren(...lines.map((text, k) => {
      const line = document.createElement(k ? 'span' : 'strong');
      line.textContent = text;
      return line;
    }));
    this.tooltip.hidden = false;
    // Above and right of the pointer, so it never covers the piece being read;
    // below it when there is no room above.
    const { width } = this.size;
    const left = Math.min(p.x + 14, width - this.tooltip.offsetWidth - 8);
    const above = p.y - this.tooltip.offsetHeight - 10;
    this.tooltip.style.left = `${Math.max(8, left)}px`;
    this.tooltip.style.top = `${above >= 8 ? above : p.y + 18}px`;
  }

  hideTooltip() {
    this.tooltip.hidden = true;
  }

  /** A PNG of the whole canvas as it is now. */
  snapshot() {
    this.render();
    return this.canvas.toDataURL('image/png');
  }
}

function setMatrix(mesh, { rotation: r, position: p }) {
  mesh.matrix.set(
    r[0], r[1], r[2], p[0],
    r[3], r[4], r[5], p[1],
    r[6], r[7], r[8], p[2],
    0, 0, 0, 1,
  );
  mesh.matrixWorldNeedsUpdate = true;
}
