/**
 * The views a dump can be shown in. Each selected view gets its own panel;
 * the panels share one camera orientation and one timeline.
 *
 * `target` is the pose the pieces move toward (dump.js poseAt); a static view
 * shows one fixed progress `s`, an animated one follows the timeline.
 */
export const MODES = [
  {
    id: 'original',
    name: 'Original object',
    target: 'truth-static',
    animated: false,
    help: 'The object before it was broken: every piece in its true pose (the ground truth).',
  },
  {
    id: 'scattered',
    name: 'Scattered pieces',
    target: 'reassemble',
    s: 0,
    animated: false,
    help: 'The pieces as the model was given them: each one turned by its random rotation, '
      + 'and moved apart here so they do not overlap.',
  },
  {
    id: 'reassembly',
    name: 'Reassembly',
    target: 'reassemble',
    animated: true,
    help: 'From the scattered pieces to the predicted assembly: each piece turns by its '
      + 'predicted rotation and moves to the position the translation solver found.',
  },
  {
    id: 'rotation',
    name: 'Rotation only',
    target: 'rotation',
    animated: true,
    help: 'The predicted rotations, with every piece moved to its true position, so what '
      + 'stays misaligned is rotation error alone.',
  },
  {
    id: 'overlay',
    name: 'Prediction vs original',
    target: 'reassemble',
    s: 1,
    animated: false,
    ghost: true,
    help: 'The predicted assembly, with the original object drawn faintly where it should be.',
  },
];

export const DEFAULT_MODES = ['original', 'scattered', 'reassembly'];

export function modeById(id) {
  return MODES.find((mode) => mode.id === id);
}
