/**
 * The per-piece measures the view can colour by and the details table lists.
 *
 * rotation  The angle between the predicted and the true rotation: the
 *           training's rotation term (reassembly/nn/losses.py, rotation_loss),
 *           in degrees.
 * position  The training's position term (losses.py, position_loss): the mean
 *           distance from each vertex, turned by the predicted rotation, to
 *           where it belongs, both centred on the piece, in units of the
 *           scene's largest piece radius (the per-scene scale the network
 *           sees). Rotation error measured as distance: a large piece counts
 *           for more than a chip turned by the same angle, and where the solver
 *           placed the piece does not enter. Computed from the dump in dump.js.
 *
 * Both use one colour ramp on a log scale. The position ticks are round
 * numbers near what a piece of the largest radius reads when turned by 1, 5
 * and 30 degrees, so the two colourings agree for the largest piece and a
 * smaller piece reads cooler on position than on rotation.
 */
import { formatDegrees, formatLoss } from './format.js';

/** Blue and teal for pieces that fit, yellow for a little off, orange to deep red for plainly wrong. */
export const RAMP = [
  [0.0, [62, 116, 190]],
  [0.18, [52, 160, 160]],
  [0.38, [226, 192, 64]],
  [0.62, [226, 110, 44]],
  [1.0, [146, 26, 30]],
];

/** The anchor's pose is given, not predicted: neutral, outside the ramp. */
export const ANCHOR_COLOUR = [200, 204, 209];

const logScale = (unit, top) => (value) => Math.min(1, Math.max(0,
  Math.log10(1 + Math.max(0, value) / unit) / Math.log10(1 + top / unit)));

export const MEASURES = {
  rotation: {
    id: 'rotation',
    name: 'Rotation error',
    column: 'Rotation',
    legend: 'Rotation error, log scale',
    values: (dump) => dump.geodesic,
    format: formatDegrees,
    scale: logScale(1, 180),
    ticks: [0, 1, 5, 30, 180],
    tick: (value) => `${value}°`,
    help: 'The angle between the predicted and the true rotation: the training’s rotation term, in degrees.',
  },
  position: {
    id: 'position',
    name: 'Position loss',
    column: 'Position',
    legend: 'Position loss, log scale',
    values: (dump) => dump.positionLoss,
    format: formatLoss,
    // 0.0137 is what a piece of the largest radius reads turned by 1 degree
    // ((pi/4) x 2 sin 0.5 deg, for points on its sphere); 1.57 by 180.
    scale: logScale(0.0137, 1.57),
    ticks: [0, 0.01, 0.05, 0.3, 1.5],
    tick: (value) => String(value),
    help: 'The training’s position term: the mean distance from each vertex, turned by the '
      + 'predicted rotation, to where it belongs, both centred on the piece, in units of the '
      + 'scene’s largest piece radius. Rotation error as distance; where the piece was placed '
      + 'does not enter.',
  },
};

export function measureColour(measure, value) {
  const t = measure.scale(value);
  for (let j = 1; j < RAMP.length; j += 1) {
    const [t1, c1] = RAMP[j];
    const [t0, c0] = RAMP[j - 1];
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0);
      return c0.map((v, k) => Math.round(v + u * (c1[k] - v)));
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/** The mean over the scored pieces (every piece but the anchor), as the training averages. */
export function scoredMean(dump, values) {
  if (!values) return NaN;
  const scored = values.filter((value, i) => i !== dump.anchor && Number.isFinite(value));
  return scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : NaN;
}
