/** Number formatting shared by the panels. */

export function formatDegrees(value) {
  if (!Number.isFinite(value)) return '–';
  if (value < 0.1) return `${value.toFixed(3)}°`;
  if (value < 10) return `${value.toFixed(2)}°`;
  return `${value.toFixed(1)}°`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** A position loss (units of the scene's largest piece radius). */
export function formatLoss(value) {
  if (!Number.isFinite(value)) return '–';
  if (value < 0.001) return '<0.001';
  return value.toFixed(3);
}

/** A piece's Chamfer distance (mean squared, world units): placed below 0.01. */
export function formatChamfer(value) {
  if (!Number.isFinite(value)) return '–';
  if (value < 0.0001) return '<0.0001';
  return value.toFixed(4);
}
