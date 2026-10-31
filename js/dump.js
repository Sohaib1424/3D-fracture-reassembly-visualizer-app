/**
 * A prediction dump (scripts/dump_prediction.py) as fragments and poses.
 *
 * The pose math is reassembly/viz/reassembly.py's, line for line, so a frame
 * here is the frame visualize_reassembly.py and render_gif.py draw. Fragment
 * f's vertices, centred on its own centroid c, are x = v - c; the dump holds
 * the scatter rotation A the model was shown, a display-only scatter offset,
 * the predicted rotation R and the solver's predicted centroid p:
 *
 *   s = 0  scattered       A x + c + shift
 *   s = 1  reassembled     R A x + p          (target "reassemble")
 *          rotation only   R A x + c          (target "rotation": true positions)
 *          ground truth    x + c              (R_gt = A^T)
 *
 * Between the two ends the rotation turns from the identity to R along the
 * shortest arc (on top of the fixed scatter A), and the position moves in a
 * straight line.
 */
import { scalar } from './npz.js';

export class DumpError extends Error {}

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** The package palette (reassembly/viz/scene.py): piece k has this colour in every view and figure. */
export const PALETTE = [
  [66, 133, 244], [219, 68, 55], [244, 180, 0], [15, 157, 88],
  [156, 39, 176], [0, 172, 193], [255, 112, 67], [92, 107, 192],
  [141, 110, 99], [38, 166, 154], [236, 64, 122], [124, 179, 66],
];

const REQUIRED = ['vertices', 'faces', 'vertex_offsets', 'face_offsets'];

/** Arrays read from an .npz, checked and cut into fragments. */
export function parseDump(arrays, name) {
  const missing = REQUIRED.filter((key) => !(key in arrays));
  if (missing.length) {
    throw new DumpError(`${name} is not a prediction dump: it has no ${missing.join(', ')} `
      + `array${missing.length > 1 ? 's' : ''}. Dumps are written by scripts/dump_prediction.py.`);
  }
  const vertices = arrays.vertices.data;
  const faces = arrays.faces.data;
  const vOffsets = Array.from(arrays.vertex_offsets.data, Number);
  const fOffsets = Array.from(arrays.face_offsets.data, Number);
  const count = vOffsets.length - 1;
  if (count < 1 || fOffsets.length !== count + 1) {
    throw new DumpError(`${name}: the fragment offsets do not agree (${vOffsets.length} and ${fOffsets.length}).`);
  }

  const centroids = rows(arrays.centroids, 3);
  const fragments = [];
  for (let f = 0; f < count; f += 1) {
    const v0 = vOffsets[f];
    const v1 = vOffsets[f + 1];
    const n = v1 - v0;
    let centre = centroids?.[f];
    if (!centre) {
      centre = [0, 0, 0];
      for (let i = v0; i < v1; i += 1) for (let k = 0; k < 3; k += 1) centre[k] += vertices[3 * i + k] / n;
    }
    const local = new Float32Array(3 * n);
    let radius = 0;
    for (let i = 0; i < n; i += 1) {
      let r2 = 0;
      for (let k = 0; k < 3; k += 1) {
        const value = vertices[3 * (v0 + i) + k] - centre[k];
        local[3 * i + k] = value;
        r2 += value * value;
      }
      radius = Math.max(radius, r2);
    }
    const f0 = fOffsets[f];
    const f1 = fOffsets[f + 1];
    const index = new Uint32Array(3 * (f1 - f0));
    for (let j = 0; j < index.length; j += 1) {
      const vertex = faces[3 * f0 + j];
      if (vertex < 0 || vertex >= n) {
        throw new DumpError(`${name}: fragment ${f} has a face pointing at vertex ${vertex} of ${n}.`);
      }
      index[j] = vertex;
    }
    fragments.push({ index: f, positions: local, faces: index, centroid: centre,
      radius: Math.sqrt(radius), vertexCount: n, faceCount: f1 - f0 });
  }

  const A = matrices(arrays.A, count) ?? fragments.map(() => IDENTITY.slice());
  const Rgt = matrices(arrays.R_gt, count) ?? A.map(transpose);
  const Rpred = matrices(arrays.R_pred, count) ?? Rgt.map((m) => m.slice());
  const shift = rows(arrays.shift, 3) ?? fragments.map(() => [0, 0, 0]);
  const hasPlacement = Boolean(arrays.placement);
  const placement = rows(arrays.placement, 3) ?? fragments.map((f) => f.centroid.slice());
  const perFragment = (key) => (arrays[key] ? Array.from(arrays[key].data, Number) : null);
  const geodesic = perFragment('geodesic_deg');
  // The training's position term, per piece (measures.js): only for a dump
  // that holds a prediction, else it would read 0 for the truth stood in.
  const largest = Math.max(...fragments.map((fragment) => fragment.radius), 1e-12);
  const positionLoss = arrays.R_pred
    ? fragments.map((fragment, i) => meanDisplacement(fragment.positions, multiply(Rpred[i], A[i])) / largest)
    : null;

  return {
    name,
    fragments,
    A, Rgt, Rpred, shift, placement,
    hasPlacement,
    geodesic,
    positionLoss,
    tilt: perFragment('tilt_deg'),
    twist: perFragment('twist_deg'),
    partChamfer: perFragment('part_chamfer'),
    anchor: findAnchor(fragments, geodesic),
    scene: text(arrays.scene),
    checkpoint: text(arrays.checkpoint),
    rotations: text(arrays.rotations),
    seed: number(arrays.seed),
    epoch: number(arrays.epoch),
    rmseT: number(arrays.rmse_t),
    chamfer: number(arrays.chamfer),
    partAccuracy: number(arrays.part_accuracy),
    matches: number(arrays.matches),
  };
}

/**
 * The anchor: the scene's largest fragment by radius (reassembly/nn/anchor.py,
 * first on ties), set to its true pose before scoring, so its error is zero.
 * The dump does not name it, so it is found by the same rule and confirmed by
 * its error; failing that, the largest piece with a zero error is taken.
 */
function findAnchor(fragments, geodesic) {
  if (!geodesic || geodesic.length !== fragments.length) return -1;
  let largest = 0;
  fragments.forEach((fragment, i) => {
    if (fragment.radius > fragments[largest].radius) largest = i;
  });
  if (Math.abs(geodesic[largest]) < 1e-2) return largest;
  let anchor = -1;
  geodesic.forEach((value, i) => {
    if (Math.abs(value) < 1e-3 && (anchor < 0 || fragments[i].radius > fragments[anchor].radius)) anchor = i;
  });
  return anchor;
}

/**
 * Mean over a piece's centred vertices x of |M x - x|: how far the turn M moves
 * them. With M = R_pred A (the predicted rotation applied to the scattered
 * piece) this is the training's position_loss before the scene's scale.
 */
function meanDisplacement(points, M) {
  const count = points.length / 3;
  if (!count) return NaN;
  let sum = 0;
  for (let j = 0; j < points.length; j += 3) {
    const x = points[j];
    const y = points[j + 1];
    const z = points[j + 2];
    const dx = M[0] * x + M[1] * y + M[2] * z - x;
    const dy = M[3] * x + M[4] * y + M[5] * z - y;
    const dz = M[6] * x + M[7] * y + M[8] * z - z;
    sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return sum / count;
}

function rows(array, width) {
  if (!array) return null;
  const out = [];
  for (let i = 0; i + width <= array.data.length; i += width) out.push(Array.from(array.data.subarray(i, i + width), Number));
  return out;
}

function matrices(array, count) {
  const list = rows(array, 9);
  return list && list.length === count ? list : null;
}

function text(array) {
  const value = scalar(array, '');
  return typeof value === 'string' ? value : String(value ?? '');
}

function number(array) {
  const value = scalar(array, null);
  return value === null ? NaN : Number(value);
}

// ---------------------------------------------------------------------------
// Rotations: row-major 3x3 as flat arrays of 9
// ---------------------------------------------------------------------------

export function multiply(a, b) {
  const out = new Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[3 * r + c] = a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c];
    }
  }
  return out;
}

export function transpose(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** (w, x, y, z), from the branch with the largest denominator: accurate near 180 degrees. */
export function matrixToQuaternion(m) {
  const trace = m[0] + m[4] + m[8];
  const candidates = [1 + trace, 1 + m[0] - m[4] - m[8], 1 - m[0] + m[4] - m[8], 1 - m[0] - m[4] + m[8]];
  const k = candidates.indexOf(Math.max(...candidates));
  let q;
  if (k === 0) q = [candidates[0], m[7] - m[5], m[2] - m[6], m[3] - m[1]];
  else if (k === 1) q = [m[7] - m[5], candidates[1], m[1] + m[3], m[2] + m[6]];
  else if (k === 2) q = [m[2] - m[6], m[1] + m[3], candidates[2], m[5] + m[7]];
  else q = [m[3] - m[1], m[2] + m[6], m[5] + m[7], candidates[3]];
  const norm = Math.max(Math.hypot(...q), 1e-12);
  return q.map((v) => v / norm);
}

export function quaternionToMatrix(q) {
  const norm = Math.max(Math.hypot(...q), 1e-12);
  const [w, x, y, z] = q.map((v) => v / norm);
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/** The rotation s of the way from the identity to R, along the shortest arc. */
export function slerpFromIdentity(R, s) {
  let q = matrixToQuaternion(R);
  if (q[0] < 0) q = q.map((v) => -v);
  const angle = 2 * Math.acos(Math.min(1, Math.max(-1, q[0])));
  if (angle < 1e-9) return IDENTITY.slice();
  const norm = Math.max(Math.hypot(q[1], q[2], q[3]), 1e-12);
  const half = (s * angle) / 2;
  const sin = Math.sin(half) / norm;
  return quaternionToMatrix([Math.cos(half), q[1] * sin, q[2] * sin, q[3] * sin]);
}

// ---------------------------------------------------------------------------
// Poses
// ---------------------------------------------------------------------------

/**
 * Fragment i at progress s toward `target`: `{rotation, position}`, so that a
 * centred vertex x lands at rotation * x + position. `spread` scales the
 * display-only scatter offset (1 draws it as dumped).
 */
export function poseAt(dump, i, s, target = 'reassemble', spread = 1) {
  const { centroid } = dump.fragments[i];
  let R;
  let end;
  if (target === 'truth') { R = dump.Rgt[i]; end = centroid; }
  else if (target === 'rotation') { R = dump.Rpred[i]; end = centroid; }
  else { R = dump.Rpred[i]; end = dump.placement[i]; }
  const rotation = multiply(slerpFromIdentity(R, s), dump.A[i]);
  const shift = dump.shift[i];
  const position = [0, 1, 2].map((k) => (1 - s) * (centroid[k] + spread * shift[k]) + s * end[k]);
  return { rotation, position };
}

/** The object as it was: every fragment unrotated at its own centroid. */
export function truthPose(dump, i) {
  return { rotation: IDENTITY.slice(), position: dump.fragments[i].centroid.slice() };
}

/**
 * A bounding sphere over everything a view shows, at every frame it can
 * show -- so the camera is placed once and never breathes as pieces converge.
 * Each fragment is a sphere about its centroid (rotation keeps its radius);
 * the view's sphere is centred on their bounding box and just reaches the
 * farthest of them.
 */
export function viewBounds(dump, mode, samples = 11, spread = 1) {
  const spheres = [];
  const params = mode.animated
    ? Array.from({ length: samples }, (_, j) => j / (samples - 1))
    : [mode.s ?? 1];
  dump.fragments.forEach((fragment, i) => {
    if (mode.target === 'truth-static' || mode.ghost) spheres.push([fragment.centroid, fragment.radius]);
    if (mode.target === 'truth-static') return;
    for (const s of params) spheres.push([poseAt(dump, i, s, mode.target, spread).position, fragment.radius]);
  });
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const [position, radius] of spheres) {
    for (let k = 0; k < 3; k += 1) {
      lo[k] = Math.min(lo[k], position[k] - radius);
      hi[k] = Math.max(hi[k], position[k] + radius);
    }
  }
  const centre = lo.map((v, k) => (v + hi[k]) / 2);
  let radius = 1e-6;
  for (const [position, r] of spheres) {
    radius = Math.max(radius, Math.hypot(position[0] - centre[0], position[1] - centre[1], position[2] - centre[2]) + r);
  }
  return { centre, radius };
}

export function pieceColour(index) {
  return PALETTE[index % PALETTE.length];
}
