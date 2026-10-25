// Everything the scene remembers between pages. Storage can be blocked (private mode, policy),
// so every access is guarded and falls back to "nothing saved".

const STATE_KEY = 'bg-scene-state'; // localStorage: the shared state (see loadState)
const OLD_MOTION_KEY = 'bg-motion'; // localStorage, earlier versions: 'paused' | 'playing'
const OLD_FX_KEY = 'bg-fx'; // localStorage, earlier versions: the changed sliders
const SEEN_KEY = 'bg-seen'; // sessionStorage: the scene has already faded in this visit
const SHAPE_KEY = 'bg-scene-shape'; // sessionStorage: index of the current shape
const SNAPSHOT_KEY = 'bg-scene-snapshot'; // sessionStorage: shards mid-shatter

const attempt = (fn, fallback) => {
  try { return fn(); } catch (err) { return fallback; }
};

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

// The state every page and tab shares, in one record that is always written whole, so another
// tab never sees half an update:
//   paused: the reader's pause choice, or null until they make one
//   offset/pausedAt: the scene's clock, in plain seconds
//   idleShift/hueShift: phase corrections that keep the rotation and colour from jumping when
//     their speed sliders change (see bg-scene.js); they fit the slider values in `fx`
//   fx: the effect sliders that differ from the defaults
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const emptyState = () => ({ paused: null, offset: 0, pausedAt: 0, idleShift: 0, hueShift: 0, fx: {} });

// Earlier versions kept the pause choice and the sliders under keys of their own.
function legacyState() {
  const motion = localStorage.getItem(OLD_MOTION_KEY);
  return {
    paused: motion === 'paused' ? true : motion === 'playing' ? false : null,
    fx: attempt(() => JSON.parse(localStorage.getItem(OLD_FX_KEY)), null),
  };
}

export const loadState = (now) => attempt(() => {
  let saved = attempt(() => JSON.parse(localStorage.getItem(STATE_KEY)), null);
  if (!isPlainObject(saved)) saved = legacyState();
  const state = emptyState();
  if (typeof saved.paused === 'boolean') state.paused = saved.paused;
  for (const k of ['offset', 'pausedAt', 'idleShift', 'hueShift']) state[k] = finite(saved[k]);
  // A pause moment must be in the past; anything else (corrupt, or a clock set back) is dropped.
  if (state.pausedAt < 0 || state.pausedAt > now + 60) state.pausedAt = 0;
  if (state.offset < 0) state.offset = 0;
  if (isPlainObject(saved.fx)) state.fx = saved.fx;
  return state;
}, emptyState());

export const saveState = (state) => attempt(() => {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  localStorage.removeItem(OLD_MOTION_KEY);
  localStorage.removeItem(OLD_FX_KEY);
});
// Storage-event filter for the cross-tab sync.
export const isStateKey = (key) => key === STATE_KEY;
// False when the browser refuses storage (blocked site data, some private modes).
export const storageAvailable = () => attempt(() => !!localStorage, false);

// Shatter state handed to the next page. takeSnapshot reads and removes it in one go.
export const takeSnapshot = () => attempt(() => {
  const snap = JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY));
  sessionStorage.removeItem(SNAPSHOT_KEY);
  return snap;
}, null);
export const clearSnapshot = () => attempt(() => sessionStorage.removeItem(SNAPSHOT_KEY));
export const storeSnapshot = (snap) => attempt(() => sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap)));

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
