/**
 * Reading NumPy's .npz files in the browser.
 *
 * An .npz is a zip of .npy files, one per array (np.savez_compressed deflates
 * them). fflate unzips; each .npy is a short text header describing dtype and
 * shape, followed by the raw bytes. Only what dump_prediction.py writes needs
 * to work, but the reader handles any plain numeric, boolean or string array.
 */
import { unzip, unzipSync } from '../vendor/fflate/fflate.module.js';

export class NpyError extends Error {}

/** `{name: {data, shape, dtype}}` for every array in the archive. */
export async function readNpz(bytes) {
  const entries = await unzipAsync(bytes);
  const arrays = {};
  for (const [path, data] of Object.entries(entries)) {
    if (!path.toLowerCase().endsWith('.npy')) continue;
    const name = path.slice(0, -4).split('/').pop();
    arrays[name] = readNpy(data, name);
  }
  return arrays;
}

function unzipAsync(bytes) {
  const fallback = (resolve, reject) => {
    try {
      resolve(unzipSync(bytes));
    } catch (error) {
      reject(new NpyError(`not a readable .npz archive (${error.message})`));
    }
  };
  return new Promise((resolve, reject) => {
    try {
      // Large entries are inflated in workers, so a big dump does not freeze the page.
      unzip(bytes, (error, data) => (error ? fallback(resolve, reject) : resolve(data)));
    } catch {
      fallback(resolve, reject);
    }
  });
}

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY

/** One .npy file: `{data, shape, dtype}`; `data` is a typed array, or an array of strings. */
export function readNpy(bytes, name = 'array') {
  if (bytes.length < 10 || MAGIC.some((value, i) => bytes[i] !== value)) {
    throw new NpyError(`${name}: not a .npy array`);
  }
  const major = bytes[6];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder(major >= 3 ? 'utf-8' : 'latin1')
    .decode(bytes.subarray(headerStart, headerStart + headerLength));

  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order'\s*:\s*True/.test(header);
  const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!descr || shapeText === undefined) throw new NpyError(`${name}: unreadable .npy header`);
  const shape = shapeText.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const count = shape.reduce((a, b) => a * b, 1);
  const start = headerStart + headerLength;

  const order = descr[0];
  const kind = descr[1];
  const size = Number(descr.slice(2));
  let data;
  if (kind === 'U') {
    data = decodeStrings(bytes, start, count, size, 4, order === '>');
  } else if (kind === 'S' || kind === 'a') {
    data = decodeStrings(bytes, start, count, size, 1, false);
  } else {
    data = decodeNumbers(bytes, start, count, kind, size, order === '>', name, descr);
  }
  if (fortran && shape.length > 1) data = toCOrder(data, shape);
  return { data, shape, dtype: descr };
}

function decodeNumbers(bytes, start, count, kind, size, bigEndian, name, descr) {
  const length = count * size;
  if (start + length > bytes.length) throw new NpyError(`${name}: the file is shorter than its header says`);
  // A fresh, aligned copy: typed arrays need their offset to be a multiple of the item size.
  const raw = bytes.slice(start, start + length);
  if (bigEndian && size > 1) {
    for (let i = 0; i < raw.length; i += size) raw.subarray(i, i + size).reverse();
  }
  const buffer = raw.buffer;
  switch (`${kind}${size}`) {
    case 'f4': return new Float32Array(buffer);
    case 'f8': return new Float64Array(buffer);
    case 'f2': return halfToFloat(new Uint16Array(buffer));
    case 'i1': return new Int8Array(buffer);
    case 'i2': return new Int16Array(buffer);
    case 'i4': return new Int32Array(buffer);
    case 'i8': return Float64Array.from(new BigInt64Array(buffer), Number);
    case 'u1': return new Uint8Array(buffer);
    case 'u2': return new Uint16Array(buffer);
    case 'u4': return new Uint32Array(buffer);
    case 'u8': return Float64Array.from(new BigUint64Array(buffer), Number);
    case 'b1': return new Uint8Array(buffer);
    default: throw new NpyError(`${name}: dtype ${descr} is not supported`);
  }
}

function decodeStrings(bytes, start, count, chars, width, bigEndian) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let item = 0; item < count; item += 1) {
    let text = '';
    for (let c = 0; c < chars; c += 1) {
      const at = start + (item * chars + c) * width;
      const code = width === 4 ? view.getUint32(at, !bigEndian) : bytes[at];
      if (code === 0) break;
      text += String.fromCodePoint(code);
    }
    out.push(text);
  }
  return out;
}

function halfToFloat(halves) {
  const out = new Float32Array(halves.length);
  for (let i = 0; i < halves.length; i += 1) {
    const h = halves[i];
    const sign = h & 0x8000 ? -1 : 1;
    const exponent = (h >> 10) & 0x1f;
    const fraction = h & 0x3ff;
    if (exponent === 0) out[i] = sign * 2 ** -14 * (fraction / 1024);
    else if (exponent === 31) out[i] = fraction ? NaN : sign * Infinity;
    else out[i] = sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
  }
  return out;
}

/** Fortran-ordered data rewritten in C order (last axis fastest). */
function toCOrder(data, shape) {
  const out = new data.constructor(data.length);
  const ndim = shape.length;
  const fStrides = [];
  let stride = 1;
  for (let k = 0; k < ndim; k += 1) { fStrides.push(stride); stride *= shape[k]; }
  const index = new Array(ndim).fill(0);
  for (let c = 0; c < data.length; c += 1) {
    let f = 0;
    for (let k = 0; k < ndim; k += 1) f += index[k] * fStrides[k];
    out[c] = data[f];
    for (let k = ndim - 1; k >= 0; k -= 1) {
      index[k] += 1;
      if (index[k] < shape[k]) break;
      index[k] = 0;
    }
  }
  return out;
}

/** The single value of a 0-d array (or the first value of any array). */
export function scalar(array, fallback = null) {
  if (!array || !array.data || array.data.length === 0) return fallback;
  return array.data[0];
}
