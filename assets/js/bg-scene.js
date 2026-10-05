// Background scene: one primitive hovers at a time. A click shatters it into its own
// triangle shards, which drift apart and slowly regather as the next primitive.
// Runs behind every page. The canvas never takes pointer events; clicks are read
// from the window and ignored when they land on anything interactive.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  DoubleSide,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  TetrahedronGeometry,
  TorusGeometry,
  TorusKnotGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from './vendor/three.module.js';

const canvas = document.getElementById('bg-scene');
if (canvas) init(canvas);

function init(canvas) {
  const quiet = canvas.classList.contains('is-quiet');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CFG = {
    fov: 40,
    camZ: 14,
    shards: 768, // every primitive is cut into exactly this many triangles
    burst: quiet ? 2.6 : 3.4, // initial shard speed, in shape radii per second
    holdSeconds: 0.9, // drift freely before the pull back starts
    regatherSeconds: 6, // time for the pull to ramp to full strength
    stiffness: 1.4,
    spinBurst: 9,
    hoverLean: 0.35,
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
  const camera = new PerspectiveCamera(CFG.fov, 1, 0.1, 100);
  camera.position.set(0, 0, CFG.camZ);
  const hemi = new HemisphereLight(0xffffff, 0x445066, 1.4);
  const sun = new DirectionalLight(0xffffff, 1.8);
  sun.position.set(5, 8, 10);
  scene.add(hemi, sun);

  const rand = mulberry32(20261005);

  // ---- Shapes: each normalised to radius 1 and cut into exactly CFG.shards triangles ----
  const SHAPES = [
    () => new IcosahedronGeometry(1, 1),
    () => new BoxGeometry(1.25, 1.25, 1.25, 2, 2, 2),
    () => new TorusKnotGeometry(0.72, 0.24, 48, 8),
    () => new OctahedronGeometry(1, 1),
    () => new TorusGeometry(0.78, 0.3, 8, 24),
    () => new DodecahedronGeometry(1, 0),
    () => new TetrahedronGeometry(1.1, 0),
    () => new ConeGeometry(0.85, 1.5, 24, 1),
  ].map((make) => buildShards(make(), CFG.shards));

  const N = CFG.shards;
  const positions = new Float32Array(N * 9);
  const colors = new Float32Array(N * 9);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const material = new MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.45,
    metalness: 0.2,
    side: DoubleSide,
    transparent: true,
    opacity: 0.95,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  const group = new Group();
  group.add(mesh);
  scene.add(group);

  // Scratch objects shared by the simulation and vertex writer.
  const q = new Quaternion();
  const dq = new Quaternion();
  const ident = new Quaternion();
  const axis = new Vector3();
  const v3 = new Vector3();

  // ---- Shard state (in the group's local space, radius-1 units) ----
  const pos = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3);
  const quat = new Float32Array(N * 4);
  const angVel = new Float32Array(N * 3);
  const recover = new Float32Array(N).fill(1);

  // Remember which shape we're on as the reader moves between pages.
  let from = loadShape();
  let to = from;
  let whole = true; // shards locked together into a solid shape
  let settleTimer = 0;
  resetToWhole(from);

  function loadShape() {
    try {
      const v = parseInt(sessionStorage.getItem('bg-scene-shape'), 10);
      return Number.isInteger(v) && v >= 0 && v < SHAPES.length ? v : 0;
    } catch (err) {
      return 0;
    }
  }
  function saveShape(i) {
    try { sessionStorage.setItem('bg-scene-shape', String(i)); } catch (err) { /* private mode */ }
  }

  function resetToWhole(i) {
    const s = SHAPES[i];
    pos.set(s.centroids);
    vel.fill(0);
    angVel.fill(0);
    for (let k = 0; k < N; k++) quat.set([0, 0, 0, 1], k * 4);
    recover.fill(1);
    from = to = i;
    whole = true;
    writeVertices();
  }

  // ---- Theme ----
  const PALETTES = {
    dark: { a: '#4f5d7a', b: '#8a96b4', accent: '#8fb0ff' },
    light: { a: '#9aa6bf', b: '#d2d8e4', accent: '#4566d6' },
  };
  const accent = new Color();
  function applyTheme() {
    const p = PALETTES[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'];
    const a = new Color(p.a);
    const b = new Color(p.b);
    const c = new Color();
    accent.set(p.accent);
    for (let i = 0; i < N; i++) {
      // Shards are ordered top to bottom, so this is a soft vertical gradient on every shape.
      c.copy(a).lerp(b, 1 - i / N).offsetHSL(0, 0, (rand() - 0.5) * 0.02);
      for (let v = 0; v < 3; v++) colors.set([c.r, c.g, c.b], i * 9 + v * 3);
    }
    geometry.attributes.color.needsUpdate = true;
    hemi.groundColor.set(document.documentElement.dataset.theme === 'dark' ? 0x2a3040 : 0x9aa4b8);
  }
  applyTheme();
  new MutationObserver(() => { applyTheme(); if (reduceMotion) render(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---- Layout ----
  let radius = 2;
  let homeX = 0;
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const halfH = Math.tan((CFG.fov * Math.PI) / 360) * CFG.camZ;
    const halfW = halfH * camera.aspect;
    // On wide screens sit to the right of the reading column; otherwise centre it.
    const wide = camera.aspect > 1.25;
    homeX = wide ? halfW * 0.5 : 0;
    radius = Math.min(halfH * (wide ? 0.42 : 0.34), halfW * (wide ? 0.32 : 0.6));
  }
  resize();

  // ---- Pointer ----
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  let hovering = false;
  const lean = new Vector2();
  let glow = 0;

  function pointOnShapePlane(x, y, out) {
    ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    const s = (group.position.z - o.z) / d.z;
    return out.set(o.x + d.x * s, o.y + d.y * s, group.position.z);
  }

  const IGNORE = 'a, button, input, textarea, select, label, summary, details, [role="button"], [contenteditable], pre, code, img, video, iframe, .post-entry, .toc, .header, .footer';

  function shatter(x, y) {
    // Click point in the shape's local frame: shards fly out from the centre, pushed away from the click.
    const local = group.worldToLocal(pointOnShapePlane(x, y, v3));
    const lx = local.x * 0.35;
    const ly = local.y * 0.35;
    const lz = local.z * 0.35;
    if (whole) {
      from = to;
      to = (to + 1) % SHAPES.length;
      saveShape(to);
      whole = false;
    }
    for (let i = 0; i < N; i++) {
      const ix = i * 3;
      let dx = pos[ix] - lx;
      let dy = pos[ix + 1] - ly;
      let dz = pos[ix + 2] - lz;
      const d = Math.hypot(dx, dy, dz) || 1;
      const speed = CFG.burst * (0.45 + rand() * 0.9);
      vel[ix] += (dx / d) * speed;
      vel[ix + 1] += (dy / d) * speed;
      vel[ix + 2] += (dz / d) * speed * 0.35; // mostly in-plane, so no shard swells past the camera
      for (let k = 0; k < 3; k++) angVel[ix + k] += (rand() - 0.5) * CFG.spinBurst;
      recover[i] = -CFG.holdSeconds / CFG.regatherSeconds;
    }
    settleTimer = 0;
  }

  // ---- Simulation ----
  function step(dt) {
    const K = CFG.stiffness;
    const critical = 2 * Math.sqrt(K);
    const target = SHAPES[to].centroids;
    let allRecovered = true;

    for (let i = 0; i < N; i++) {
      const ix = i * 3;
      recover[i] = Math.min(1, recover[i] + dt / CFG.regatherSeconds);
      const r = smoothstep(clamp(recover[i], 0, 1));
      if (recover[i] < 1) allRecovered = false;
      const k = K * r * r;
      const damping = 0.35 + (critical - 0.35) * r;

      for (let c = 0; c < 3; c++) {
        const a = k * (target[ix + c] - pos[ix + c]) - damping * vel[ix + c];
        vel[ix + c] += a * dt;
        pos[ix + c] += vel[ix + c] * dt;
      }

      // Tumble, with the spin bleeding off and the shard easing back to its resting orientation.
      q.fromArray(quat, i * 4);
      const wx = angVel[ix], wy = angVel[ix + 1], wz = angVel[ix + 2];
      const w = Math.hypot(wx, wy, wz);
      if (w > 1e-4) {
        dq.setFromAxisAngle(axis.set(wx / w, wy / w, wz / w), w * dt);
        q.premultiply(dq);
      }
      const decay = Math.exp(-dt * (0.6 + 2.5 * r));
      angVel[ix] *= decay;
      angVel[ix + 1] *= decay;
      angVel[ix + 2] *= decay;
      q.slerp(ident, 1 - Math.exp(-dt * 3 * r * r));
      q.toArray(quat, i * 4);
    }

    if (allRecovered) {
      settleTimer += dt;
      if (settleTimer > 1.2) resetToWhole(to);
    }
  }

  function writeVertices() {
    const A = SHAPES[from].locals;
    const B = SHAPES[to].locals;
    for (let i = 0; i < N; i++) {
      const r = whole ? 1 : smoothstep(clamp(recover[i], 0, 1));
      const m = whole ? 1 : r; // morph each shard from the old shape's triangle to the new one's
      const shrink = whole ? 1 : 0.55 + 0.45 * r; // gaps open up while scattered
      q.fromArray(quat, i * 4);
      for (let v = 0; v < 3; v++) {
        const j = i * 9 + v * 3;
        v3.set(lerp(A[j], B[j], m), lerp(A[j + 1], B[j + 1], m), lerp(A[j + 2], B[j + 2], m))
          .multiplyScalar(shrink)
          .applyQuaternion(q);
        positions[j] = pos[i * 3] + v3.x;
        positions[j + 1] = pos[i * 3 + 1] + v3.y;
        positions[j + 2] = pos[i * 3 + 2] + v3.z;
      }
    }
    geometry.attributes.position.needsUpdate = true;
  }

  // Wall-clock time keeps the hover motion in phase across page loads.
  const clock = () => (Date.now() / 1000) % 100000;

  function place(t, dt) {
    if (hovering) {
      raycaster.setFromCamera(ndc, camera);
      lean.lerp(ndc, Math.min(1, dt * 2));
      const o = raycaster.ray.origin;
      const d = raycaster.ray.direction;
      const s = (group.position.z - o.z) / d.z;
      const dist = Math.hypot(o.x + d.x * s - group.position.x, o.y + d.y * s - group.position.y);
      glow += ((dist < radius * 1.15 ? 1 : 0) - glow) * Math.min(1, dt * 4);
    } else {
      lean.multiplyScalar(1 - Math.min(1, dt * 2));
      glow *= 1 - Math.min(1, dt * 4);
    }
    group.position.set(homeX + Math.cos(t * 0.31) * 0.12, Math.sin(t * 0.6) * 0.22, 0);
    group.rotation.set(
      Math.sin(t * 0.23) * 0.35 - lean.y * CFG.hoverLean,
      t * 0.22 + lean.x * CFG.hoverLean,
      Math.sin(t * 0.17) * 0.12,
    );
    group.scale.setScalar(radius * (1 + glow * 0.04));
    material.emissive.copy(accent).multiplyScalar(glow * 0.25);
  }

  function render() {
    renderer.render(scene, camera);
  }

  window.addEventListener('resize', () => { resize(); if (reduceMotion) { place(clock(), 0); render(); } }, { passive: true });

  if (reduceMotion) {
    // Respect the OS setting: a still image, no animation or interaction.
    place(clock(), 0);
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
    shatter(e.clientX, e.clientY);
  }, { passive: true });

  let raf = 0;
  let last = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000 || 0, 1 / 30);
    last = now;
    place(clock(), dt);
    if (!whole) {
      step(dt);
      if (!whole) writeVertices();
    }
    render();
  }
  function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  start();
}

// Turn a geometry into exactly `count` triangles (splitting the largest ones along their
// longest edge, which keeps the surface unchanged), normalised to radius 1 and ordered
// top-to-bottom in a snake pattern so shards travel to nearby spots when shapes change.
function buildShards(geometry, count) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.computeBoundingSphere();
  const { center, radius } = g.boundingSphere;
  const src = g.attributes.position.array;
  let tris = [];
  for (let i = 0; i < src.length; i += 9) {
    const t = new Float32Array(9);
    for (let k = 0; k < 9; k += 3) {
      t[k] = (src[i + k] - center.x) / radius;
      t[k + 1] = (src[i + k + 1] - center.y) / radius;
      t[k + 2] = (src[i + k + 2] - center.z) / radius;
    }
    tris.push(t);
  }
  if (tris.length > count) {
    // Not expected with the shapes above; keep the largest so the silhouette survives.
    tris.sort((a, b) => area(b) - area(a));
    tris = tris.slice(0, count);
  }
  while (tris.length < count) {
    let best = 0;
    let bestArea = -1;
    for (let i = 0; i < tris.length; i++) {
      const a = area(tris[i]);
      if (a > bestArea) { bestArea = a; best = i; }
    }
    const [t1, t2] = split(tris[best]);
    tris[best] = t1;
    tris.push(t2);
  }

  const BANDS = 14;
  const keyed = tris.map((t) => {
    const cx = (t[0] + t[3] + t[6]) / 3;
    const cy = (t[1] + t[4] + t[7]) / 3;
    const cz = (t[2] + t[5] + t[8]) / 3;
    const len = Math.hypot(cx, cy, cz) || 1;
    const lat = Math.asin(clamp(cy / len, -1, 1)); // -pi/2 .. pi/2
    const band = Math.min(BANDS - 1, Math.floor(((Math.PI / 2 - lat) / Math.PI) * BANDS));
    let lon = (Math.atan2(cz, cx) + Math.PI) / (2 * Math.PI);
    if (band % 2) lon = 1 - lon;
    return { t, cx, cy, cz, key: band + lon };
  });
  keyed.sort((a, b) => a.key - b.key);

  const centroids = new Float32Array(count * 3);
  const locals = new Float32Array(count * 9);
  keyed.forEach(({ t, cx, cy, cz }, i) => {
    centroids.set([cx, cy, cz], i * 3);
    for (let k = 0; k < 9; k += 3) {
      locals[i * 9 + k] = t[k] - cx;
      locals[i * 9 + k + 1] = t[k + 1] - cy;
      locals[i * 9 + k + 2] = t[k + 2] - cz;
    }
  });
  g.dispose();
  geometry.dispose();
  return { centroids, locals };
}

function area(t) {
  const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2];
  const vx = t[6] - t[0], vy = t[7] - t[1], vz = t[8] - t[2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

function split(t) {
  // Bisect the longest edge; both halves keep the original winding.
  const d = (a, b) => Math.hypot(t[a] - t[b], t[a + 1] - t[b + 1], t[a + 2] - t[b + 2]);
  const e = [d(0, 3), d(3, 6), d(6, 0)];
  const longest = e.indexOf(Math.max(...e));
  // Rotate so the longest edge is A→B.
  const order = [[0, 3, 6], [3, 6, 0], [6, 0, 3]][longest];
  const A = [t[order[0]], t[order[0] + 1], t[order[0] + 2]];
  const B = [t[order[1]], t[order[1] + 1], t[order[1] + 2]];
  const C = [t[order[2]], t[order[2] + 1], t[order[2] + 2]];
  const M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
  return [Float32Array.from([...A, ...M, ...C]), Float32Array.from([...M, ...B, ...C])];
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
