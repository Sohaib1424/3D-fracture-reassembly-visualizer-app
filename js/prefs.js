/**
 * View settings kept between visits in this browser. A convenience only: if
 * storage is unavailable (private window, blocked site data) the defaults
 * apply and nothing breaks.
 */
const KEY = 'reassembly-visualizer:prefs';

export function loadPrefs() {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function savePrefs(prefs) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered this time; the page works the same.
  }
}
