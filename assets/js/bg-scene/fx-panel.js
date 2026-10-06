// The gear panel (layouts/_partials/scene_controls.html): one slider per effect setting.
// Changes apply live, are remembered, and keep the spin cap in the simulation (WCAG 2.3.1)
// whatever is chosen here.
import { clamp } from './math.js';
import { loadFx, saveFx } from './storage.js';

// [key in the config, label, min, max, step]
export const FX = [
  ['burst', 'Shatter speed', 0.5, 6, 0.1],
  ['regatherSeconds', 'Regather time (s)', 1, 15, 0.5],
  ['stiffness', 'Pull strength', 0.5, 6, 0.1],
  ['spinBurst', 'Shard spin', 0, 9, 0.5],
  ['edgeMargin', 'Off-screen limit', 0, 1, 0.01],
  ['wallStiffness', 'Edge pushback', 5, 100, 1],
  ['hoverLean', 'Hover tilt', 0, 1.5, 0.05],
  ['followSpeed', 'Follow speed', 0.5, 20, 0.5],
  ['idle', 'Idle rotation', 0, 2, 0.05],
  ['size', 'Size', 0.5, 1.5, 0.05],
  ['opacity', 'Opacity', 0.2, 1, 0.05],
  ['light', 'Brightness', 0.5, 2, 0.05],
  ['hueSpan', 'Colour spread', 0, 1, 0.05],
  ['hueDrift', 'Colour drift', 0, 0.1, 0.005],
];

// Puts the remembered slider values into `cfg`, ignoring anything out of range.
export function restoreFx(cfg) {
  const saved = loadFx();
  for (const [key, , min, max] of FX) {
    const v = Number(saved[key]);
    if (key in saved && Number.isFinite(v)) cfg[key] = clamp(v, min, max);
  }
}

// Builds the panel. `defaults` is a copy of the config before any saved values; `onChange`
// runs after every change so the scene can apply it.
export function initFxPanel(cfg, defaults, onChange) {
  const toggle = document.getElementById('scene-fx-toggle');
  const panel = document.getElementById('scene-fx-panel');
  const list = document.getElementById('scene-fx-list');
  if (!toggle || !panel || !list) return;

  const setOpen = (open) => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  // APG disclosure: Escape closes the panel and returns focus to its button. Listens on the
  // document because Safari doesn't focus a button when it is clicked, so focus may be on <body>.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { setOpen(false); toggle.focus(); }
  });

  const save = () => saveFx(Object.fromEntries(FX.filter(([k]) => cfg[k] !== defaults[k]).map(([k]) => [k, cfg[k]])));
  const rows = FX.map(([key, label, min, max, step]) => {
    const id = 'fx-' + key;
    const row = document.createElement('div');
    row.className = 'scene-fx-row';
    const lab = Object.assign(document.createElement('label'), { htmlFor: id, textContent: label });
    const out = Object.assign(document.createElement('output'), { htmlFor: id });
    const input = Object.assign(document.createElement('input'), { type: 'range', id, min, max, step });
    const show = () => { input.value = cfg[key]; out.textContent = String(+Number(input.value).toFixed(3)); };
    input.addEventListener('input', () => {
      cfg[key] = Number(input.value);
      show();
      save();
      onChange();
    });
    show();
    row.append(lab, out, input);
    list.append(row);
    return show;
  });

  document.getElementById('scene-fx-reset')?.addEventListener('click', () => {
    Object.assign(cfg, defaults);
    rows.forEach((show) => show());
    save();
    onChange();
  });
}
