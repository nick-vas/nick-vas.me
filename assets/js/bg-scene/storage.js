// Everything the scene remembers between pages. Storage can be blocked (private mode, policy),
// so every access is guarded and falls back to "nothing saved".

const MOTION_KEY = 'bg-motion'; // localStorage: 'paused' | 'playing'
const SEEN_KEY = 'bg-seen'; // sessionStorage: the scene has already faded in this visit
const SHAPE_KEY = 'bg-scene-shape'; // sessionStorage: index of the current shape
const TIME_KEY = 'bg-scene-time'; // sessionStorage: { offset, pausedAt, idleShift, hueShift }
const SNAPSHOT_KEY = 'bg-scene-snapshot'; // sessionStorage: shards mid-shatter
const FX_KEY = 'bg-fx'; // localStorage: effect sliders that differ from the defaults

const attempt = (fn, fallback) => {
  try { return fn(); } catch (err) { return fallback; }
};

export const loadMotionPref = () => attempt(() => {
  const v = localStorage.getItem(MOTION_KEY);
  return v === 'paused' ? true : v === 'playing' ? false : null;
}, null);
export const saveMotionPref = (paused) => attempt(() => localStorage.setItem(MOTION_KEY, paused ? 'paused' : 'playing'));

// True once per visit: the first page fades the canvas in, later pages show it at once.
export const firstSceneOfVisit = () => attempt(() => {
  if (sessionStorage.getItem(SEEN_KEY)) return false;
  sessionStorage.setItem(SEEN_KEY, '1');
  return true;
}, true);

export const loadShape = (count) => attempt(() => {
  const v = parseInt(sessionStorage.getItem(SHAPE_KEY), 10);
  return Number.isInteger(v) && v >= 0 && v < count ? v : 0;
}, 0);
export const saveShape = (i) => attempt(() => sessionStorage.setItem(SHAPE_KEY, String(i)));

// offset/pausedAt: the scene's clock. idleShift/hueShift: phase corrections that keep the
// rotation and colour from jumping when their speed sliders change (see applyFx).
const NO_TIME = { offset: 0, pausedAt: 0, idleShift: 0, hueShift: 0 };
export const loadTime = () => attempt(() => {
  const t = JSON.parse(sessionStorage.getItem(TIME_KEY)) || {};
  return Object.fromEntries(Object.keys(NO_TIME).map((k) => [k, Number(t[k]) || 0]));
}, NO_TIME);
export const saveTime = (time) => attempt(() => sessionStorage.setItem(TIME_KEY, JSON.stringify(time)));

// Shatter state handed to the next page. takeSnapshot reads and removes it in one go.
export const takeSnapshot = () => attempt(() => {
  const snap = JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY));
  sessionStorage.removeItem(SNAPSHOT_KEY);
  return snap;
}, null);
export const clearSnapshot = () => attempt(() => sessionStorage.removeItem(SNAPSHOT_KEY));
export const storeSnapshot = (snap) => attempt(() => sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap)));

// Only a plain object counts; anything else in storage (a number, a string...) is ignored.
export const loadFx = () => attempt(() => {
  const saved = JSON.parse(localStorage.getItem(FX_KEY));
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
}, {});
export const saveFx = (changed) => attempt(() => {
  if (Object.keys(changed).length) localStorage.setItem(FX_KEY, JSON.stringify(changed));
  else localStorage.removeItem(FX_KEY);
});

export function toBase64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(str, length) {
  const s = atob(str);
  const out = new Float32Array(length);
  if (s.length !== out.byteLength) throw new Error('snapshot size mismatch');
  const bytes = new Uint8Array(out.buffer);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return out;
}
