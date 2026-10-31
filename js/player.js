/**
 * The timeline: reassembly progress from 0 (scattered) to 1 (assembled).
 *
 * Back and forth holds both ends, so the result stays on screen long enough
 * to be judged instead of snapping back (render_gif.py's ping-pong). The
 * scrubber is drawn as a crack that fills with gold as the pieces come
 * together.
 */
const HOLD = 0.8; // seconds at each end
const SWEEP = 3.2; // seconds from scattered to assembled, at 1x

export class Player extends EventTarget {
  constructor() {
    super();
    this.s = 0;
    this.playing = false;
    this.loop = 'pingpong';
    this.speed = 1;
    this.phase = 0;
  }

  get period() {
    return this.loop === 'pingpong' ? 2 * (HOLD + SWEEP) : 2 * HOLD + SWEEP;
  }

  play() {
    if (this.loop === 'once' && this.s >= 1) this.seek(0, false);
    this.playing = true;
    this.emit();
  }

  pause() {
    this.playing = false;
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Jump to progress s; scrubbing pauses unless told otherwise. */
  seek(s, pause = true) {
    this.s = Math.min(1, Math.max(0, s));
    this.phase = HOLD + this.s * SWEEP;
    if (pause) this.playing = false;
    this.emit();
  }

  setLoop(loop) {
    this.loop = loop;
    this.phase = HOLD + this.s * SWEEP;
    this.emit();
  }

  setSpeed(speed) {
    this.speed = speed;
    this.emit();
  }

  tick(seconds) {
    if (!this.playing) return;
    this.phase += seconds * this.speed;
    if (this.loop === 'once') {
      if (this.phase >= HOLD + SWEEP) {
        this.phase = HOLD + SWEEP;
        this.playing = false;
      }
    } else {
      this.phase %= this.period;
    }
    this.s = this.progressAt(this.phase);
    this.emit();
  }

  progressAt(t) {
    if (t < HOLD) return 0;
    if (t < HOLD + SWEEP) return (t - HOLD) / SWEEP;
    if (this.loop !== 'pingpong' || t < 2 * HOLD + SWEEP) return 1;
    return Math.max(0, 1 - (t - 2 * HOLD - SWEEP) / SWEEP);
  }

  emit() {
    this.dispatchEvent(new CustomEvent('change', { detail: { s: this.s, playing: this.playing } }));
  }
}

/**
 * A deterministic jagged line across the track: the same crack every time,
 * so it reads as a fixed thing being mended, not noise.
 */
export function crackPath(points = 48, seed = 7) {
  let state = seed;
  const random = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
  const coords = [];
  for (let i = 0; i <= points; i += 1) {
    const x = (i / points) * 100;
    const edge = i === 0 || i === points;
    const y = edge ? 6 : 6 + (random() - 0.5) * 7 * (0.55 + random() * 0.45);
    coords.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${coords.join(' L')}`;
}
