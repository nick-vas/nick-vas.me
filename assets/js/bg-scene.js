// Background scene: floating primitives that scatter on click and slowly regather.
// Runs behind every page. The canvas never takes pointer events; clicks are read
// from the window and ignored when they land on anything interactive.
import {
  BoxGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  Fog,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  PerspectiveCamera,
  Raycaster,
  Scene,
  TetrahedronGeometry,
  TorusGeometry,
  Vector2,
  WebGLRenderer,
} from './vendor/three.module.js';

const canvas = document.getElementById('bg-scene');
if (canvas) init(canvas);

function init(canvas) {
  const quiet = canvas.classList.contains('is-quiet');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CFG = {
    fov: 50,
    camZ: 14,
    nearZ: 3,
    farZ: -9,
    stiffness: 1.1, // spring pull back to home once fully recovered
    regatherSeconds: 5, // time for the pull to ramp back to full strength
    burst: quiet ? 9 : 14, // click impulse
    burstRadius: quiet ? 3.2 : 4.2,
    hoverRadius: 1.8,
    hoverForce: quiet ? 6 : 16,
    bob: 0.35,
  };

  let renderer;
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  } catch (err) {
    canvas.remove(); // no WebGL: the site works exactly as before
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  scene.fog = new Fog(0x000000, CFG.camZ - 2, CFG.camZ + 16);
  const camera = new PerspectiveCamera(CFG.fov, 1, 0.1, 100);
  camera.position.set(0, 0, CFG.camZ);

  const hemi = new HemisphereLight(0xffffff, 0x445066, 1.3);
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(6, 9, 12);
  scene.add(hemi, sun);

  // Same seed on every page, so the formation is identical as you navigate.
  const rand = mulberry32(20261005);

  const geometries = [
    new IcosahedronGeometry(0.55, 0),
    new BoxGeometry(0.75, 0.75, 0.75),
    new OctahedronGeometry(0.6, 0),
    new TetrahedronGeometry(0.7, 0),
    new DodecahedronGeometry(0.55, 0),
    new TorusGeometry(0.45, 0.16, 8, 20),
    new ConeGeometry(0.45, 0.85, 6),
  ];

  const area = window.innerWidth * window.innerHeight;
  const count = clamp(Math.round(area / 15000), 32, 110);

  // Per-shape state in flat arrays.
  const type = new Uint8Array(count);
  const slot = new Uint16Array(count);
  const home = new Float32Array(count * 3); // x/y normalised to the viewport, z in world units
  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const rot = new Float32Array(count * 3);
  const spin = new Float32Array(count * 3);
  const extraSpin = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const freq = new Float32Array(count);
  const size = new Float32Array(count);
  const recover = new Float32Array(count).fill(1); // 0 = just scattered, 1 = fully gathered
  const tint = new Uint8Array(count);
  const glow = new Float32Array(count);

  const perType = new Array(geometries.length).fill(0);
  for (let i = 0; i < count; i++) {
    const t = Math.floor(rand() * geometries.length);
    type[i] = t;
    slot[i] = perType[t]++;

    // Bias shapes slightly toward the sides so the reading column stays calmer.
    const hx = rand() * 2 - 1;
    home[i * 3] = Math.sign(hx) * Math.pow(Math.abs(hx), 0.75);
    home[i * 3 + 1] = rand() * 2 - 1;
    home[i * 3 + 2] = lerp(CFG.farZ, CFG.nearZ, Math.pow(rand(), 1.4));

    for (let k = 0; k < 3; k++) {
      rot[i * 3 + k] = rand() * Math.PI * 2;
      spin[i * 3 + k] = (rand() - 0.5) * 0.5;
    }
    phase[i] = rand() * Math.PI * 2;
    freq[i] = 0.25 + rand() * 0.35;
    size[i] = 0.55 + rand() * 0.7;
    tint[i] = Math.floor(rand() * 4);
  }

  const material = new MeshStandardMaterial({
    color: 0xffffff,
    flatShading: true,
    roughness: 0.5,
    metalness: 0.15,
    transparent: true,
    opacity: 0.92,
  });
  const meshes = geometries.map((g, t) => {
    const m = new InstancedMesh(g, material, Math.max(perType[t], 1));
    m.count = perType[t];
    m.frustumCulled = false;
    scene.add(m);
    return m;
  });

  // Palettes follow PaperMod's light/dark toggle. Index 4 is the hover/accent colour.
  const PALETTES = {
    dark: ['#56627a', '#6b7894', '#7f8aa3', '#4a5468', '#8fb0ff'],
    light: ['#b6bfd0', '#a2acc0', '#c7cdd9', '#8e99b0', '#4566d6'],
  };
  let palette = [];
  function applyTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    palette = PALETTES[dark ? 'dark' : 'light'].map((c) => new Color(c));
    // Fade distant shapes into the actual page background.
    const bg = getComputedStyle(document.body).backgroundColor;
    try { scene.fog.color.setStyle(bg); } catch (err) { scene.fog.color.set(dark ? 0x1d1e20 : 0xffffff); }
    hemi.groundColor.set(dark ? 0x2a3040 : 0x9aa4b8);
  }
  applyTheme();
  new MutationObserver(() => { applyTheme(); if (reduceMotion) render(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // Viewport helpers: homes are stored normalised and mapped to the visible area at each depth,
  // so the field always fills the screen whatever its size.
  let aspect = 1;
  function halfHeightAt(z) {
    return Math.tan((CFG.fov * Math.PI) / 360) * (CFG.camZ - z);
  }
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    aspect = w / h;
    renderer.setSize(w, h, false);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }
  resize();

  // Wall-clock time keeps the bobbing in phase across page loads.
  const clock = () => (Date.now() / 1000) % 100000;

  function target(i, t, out) {
    const z = home[i * 3 + 2];
    const hh = halfHeightAt(z) * 1.05;
    const p = phase[i];
    const f = freq[i];
    out[0] = home[i * 3] * hh * aspect + Math.cos(t * f * 0.7 + p) * CFG.bob * 0.6;
    out[1] = home[i * 3 + 1] * hh + Math.sin(t * f + p) * CFG.bob;
    out[2] = z + Math.sin(t * f * 0.5 + p * 2) * CFG.bob * 0.5;
  }

  const tmp = [0, 0, 0];
  const t0 = clock();
  for (let i = 0; i < count; i++) {
    target(i, t0, tmp);
    pos[i * 3] = tmp[0];
    pos[i * 3 + 1] = tmp[1];
    pos[i * 3 + 2] = tmp[2];
  }

  // Pointer → world-space ray.
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  let hovering = false;
  function rayPointAtZ(z, out) {
    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    const s = (z - o.z) / d.z;
    out[0] = o.x + d.x * s;
    out[1] = o.y + d.y * s;
  }
  function setPointer(x, y) {
    ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
  }

  const IGNORE = 'a, button, input, textarea, select, label, summary, details, [role="button"], [contenteditable], pre, code, img, video, iframe, .post-entry, .toc, .header, .footer';

  function scatter(x, y) {
    setPointer(x, y);
    const p = [0, 0];
    const r2 = CFG.burstRadius * CFG.burstRadius;
    for (let i = 0; i < count; i++) {
      const ix = i * 3;
      rayPointAtZ(pos[ix + 2], p);
      let dx = pos[ix] - p[0];
      let dy = pos[ix + 1] - p[1];
      let d = Math.hypot(dx, dy);
      const falloff = Math.exp(-(d * d) / r2);
      if (falloff < 0.04) continue;
      if (d < 1e-3) { dx = rand() - 0.5; dy = rand() - 0.5; d = Math.hypot(dx, dy); }
      const impulse = CFG.burst * falloff * (0.7 + rand() * 0.6);
      vel[ix] += (dx / d) * impulse;
      vel[ix + 1] += (dy / d) * impulse;
      vel[ix + 2] += (rand() - 0.3) * impulse * 0.8;
      for (let k = 0; k < 3; k++) extraSpin[ix + k] += (rand() - 0.5) * 10 * falloff;
      recover[i] = Math.min(recover[i], 1 - falloff);
    }
  }

  const dummy = new Object3D();
  const col = new Color();
  const near = [0, 0];

  function step(dt, t) {
    if (hovering) raycaster.setFromCamera(ndc, camera);
    const K = CFG.stiffness;
    const critical = 2 * Math.sqrt(K);

    for (let i = 0; i < count; i++) {
      const ix = i * 3;
      recover[i] = Math.min(1, recover[i] + dt / CFG.regatherSeconds);
      const r = smoothstep(recover[i]);
      const k = K * r * r;
      const damping = 0.55 + (critical - 0.55) * r;

      target(i, t, tmp);
      let ax = k * (tmp[0] - pos[ix]) - damping * vel[ix];
      let ay = k * (tmp[1] - pos[ix + 1]) - damping * vel[ix + 1];
      let az = k * (tmp[2] - pos[ix + 2]) - damping * vel[ix + 2];

      let g = 0;
      if (hovering) {
        rayPointAtZ(pos[ix + 2], near);
        const dx = pos[ix] - near[0];
        const dy = pos[ix + 1] - near[1];
        const d = Math.hypot(dx, dy);
        if (d < CFG.hoverRadius && d > 1e-3) {
          g = 1 - d / CFG.hoverRadius;
          const f = CFG.hoverForce * g * g;
          ax += (dx / d) * f;
          ay += (dy / d) * f;
        }
      }
      glow[i] += (g - glow[i]) * Math.min(1, dt * 6);

      vel[ix] += ax * dt;
      vel[ix + 1] += ay * dt;
      vel[ix + 2] += az * dt;
      pos[ix] += vel[ix] * dt;
      pos[ix + 1] += vel[ix + 1] * dt;
      pos[ix + 2] += vel[ix + 2] * dt;

      const spinDecay = Math.exp(-dt * 0.9);
      for (let c = 0; c < 3; c++) {
        extraSpin[ix + c] *= spinDecay;
        rot[ix + c] += (spin[ix + c] + extraSpin[ix + c]) * dt;
      }
    }
  }

  function writeInstances() {
    for (let i = 0; i < count; i++) {
      const ix = i * 3;
      // Scattered shapes shrink as they disperse and grow back as they regather.
      const s = size[i] * (0.3 + 0.7 * smoothstep(recover[i])) * (1 + glow[i] * 0.25);
      dummy.position.set(pos[ix], pos[ix + 1], pos[ix + 2]);
      dummy.rotation.set(rot[ix], rot[ix + 1], rot[ix + 2]);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      const mesh = meshes[type[i]];
      mesh.setMatrixAt(slot[i], dummy.matrix);
      col.copy(palette[tint[i]]).lerp(palette[4], Math.min(1, glow[i] * 1.4));
      mesh.setColorAt(slot[i], col);
    }
    for (const m of meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  function render() {
    writeInstances();
    renderer.render(scene, camera);
  }

  window.addEventListener('resize', () => { resize(); if (reduceMotion) render(); }, { passive: true });

  if (reduceMotion) {
    // Respect the OS setting: a still image, no animation or interaction.
    render();
    return;
  }

  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    hovering = true;
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { hovering = false; });
  window.addEventListener('blur', () => { hovering = false; });

  window.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest(IGNORE)) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // the user was selecting text
    scatter(e.clientX, e.clientY);
  }, { passive: true });

  let raf = 0;
  let last = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000 || 0, 1 / 30);
    last = now;
    step(dt, clock());
    render();
  }
  function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  start();
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(x) { return x * x * (3 - 2 * x); }
