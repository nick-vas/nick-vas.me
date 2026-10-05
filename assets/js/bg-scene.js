// Background scene: one primitive hovers at a time. A click shatters it into its own
// triangle shards, which drift apart and slowly regather as the next primitive.
// Runs behind every page. The canvas never takes pointer events; clicks are read
// from the window and ignored when they land on anything interactive.
import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  FrontSide,
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
  // The animation plays by default, even when the OS asks for reduced motion (a deliberate
  // choice for this site). WCAG 2.2.2 (Pause, Stop, Hide) is met by the pause button in
  // baseof.html; the choice is remembered across pages. Only the dev-only test panel's
  // sim-rm class starts it paused with no saved choice.
  const startPaused = document.documentElement.classList.contains('sim-rm');
  const MOTION_KEY = 'bg-motion';
  let paused = loadMotionPref() ?? startPaused;
  function loadMotionPref() {
    try {
      const v = localStorage.getItem(MOTION_KEY);
      return v === 'paused' ? true : v === 'playing' ? false : null;
    } catch (err) {
      return null;
    }
  }

  const CFG = {
    fov: 40,
    camZ: 14,
    shards: 768, // every primitive is cut into exactly this many triangles
    burst: quiet ? 2.6 : 3.4, // initial shard speed, in shape radii per second
    holdSeconds: 0.9, // drift freely before the pull back starts
    regatherSeconds: 6, // time for the pull to ramp to full strength
    stiffness: 2.5,
    spinBurst: 9,
    hoverLean: 0.35,
    hueSpan: 0.85, // how much of the spectrum the gradient covers, top to bottom
    hueDrift: 0.015, // spectrum turns per second
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
  const SHAPE_MAKERS = [
    () => new IcosahedronGeometry(1, 1),
    () => new BoxGeometry(1.25, 1.25, 1.25, 2, 2, 2),
    () => new TorusKnotGeometry(0.72, 0.24, 48, 8),
    () => new OctahedronGeometry(1, 1),
    () => new TorusGeometry(0.78, 0.3, 8, 24),
    () => new DodecahedronGeometry(1, 0),
    () => new TetrahedronGeometry(1.1, 0),
    () => new ConeGeometry(0.85, 1.5, 24, 1),
  ];
  const SHAPE_COUNT = SHAPE_MAKERS.length;
  // Built on demand: only the current shape is cut up before the first frame, and the
  // next one is prepared when the browser is idle, so page loads stay quick.
  const shapeCache = [];
  const shape = (i) => shapeCache[i] || (shapeCache[i] = buildShards(SHAPE_MAKERS[i](), CFG.shards));
  const whenIdle = window.requestIdleCallback
    ? (fn) => window.requestIdleCallback(fn, { timeout: 2000 })
    : (fn) => setTimeout(fn, 300);
  const prepareNext = () => whenIdle(() => shape((to + 1) % SHAPE_COUNT));

  const N = CFG.shards;
  const positions = new Float32Array(N * 9);
  const frontColors = new Float32Array(N * 9);
  const backColors = new Float32Array(N * 9);
  // Two meshes share the vertex positions: outer faces get the rainbow, inner faces the
  // complementary hue, so tumbling shards flash between a colour and its complement.
  const positionAttr = new BufferAttribute(positions, 3);
  const frontGeometry = new BufferGeometry();
  frontGeometry.setAttribute('position', positionAttr);
  frontGeometry.setAttribute('color', new BufferAttribute(frontColors, 3));
  const backGeometry = new BufferGeometry();
  backGeometry.setAttribute('position', positionAttr);
  backGeometry.setAttribute('color', new BufferAttribute(backColors, 3));
  const materialOptions = {
    vertexColors: true,
    flatShading: true,
    roughness: 0.4,
    metalness: 0.15,
    transparent: true,
    opacity: 0.95,
  };
  const frontMaterial = new MeshStandardMaterial({ ...materialOptions, side: FrontSide });
  const backMaterial = new MeshStandardMaterial({ ...materialOptions, side: BackSide });
  const group = new Group();
  for (const [g, m] of [[frontGeometry, frontMaterial], [backGeometry, backMaterial]]) {
    const mesh = new Mesh(g, m);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
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
  // Kept apart from `recover` so a second click mid-regather never makes shards jump:
  // morph only moves forward, and the shard size eases instead of resetting.
  const morph = new Float32Array(N).fill(1); // 0 = old shape's triangle, 1 = new shape's
  const gap = new Float32Array(N).fill(1); // shard scale; < 1 while scattered

  // Remember which shape we're on as the reader moves between pages.
  let from = loadShape();
  let to = from;
  let whole = true; // shards locked together into a solid shape
  let settleTimer = 0;
  resetToWhole(from);

  function loadShape() {
    try {
      const v = parseInt(sessionStorage.getItem('bg-scene-shape'), 10);
      return Number.isInteger(v) && v >= 0 && v < SHAPE_COUNT ? v : 0;
    } catch (err) {
      return 0;
    }
  }
  function saveShape(i) {
    try { sessionStorage.setItem('bg-scene-shape', String(i)); } catch (err) { /* private mode */ }
  }

  function resetToWhole(i) {
    pos.set(shape(i).centroids);
    vel.fill(0);
    angVel.fill(0);
    for (let k = 0; k < N; k++) quat.set([0, 0, 0, 1], k * 4);
    recover.fill(1);
    morph.fill(1);
    gap.fill(1);
    from = to = i;
    whole = true;
    writeVertices();
    prepareNext();
  }

  // ---- Colour: a rainbow gradient with complementary inner faces ----
  // Saturation/lightness per theme; the site defaults to dark.
  const TONES = {
    dark: { s: 0.92, l: 0.52, backL: 0.45 },
    light: { s: 0.85, l: 0.48, backL: 0.42 },
  };
  let tone = TONES.dark;
  const accent = new Color();
  const tint = new Color();
  function applyTheme() {
    const dark = document.documentElement.dataset.theme !== 'light';
    tone = dark ? TONES.dark : TONES.light;
    hemi.groundColor.set(dark ? 0x2a3040 : 0x9aa4b8);
  }
  function paint(t) {
    // Shards are ordered top to bottom, so hue runs down the shape like a rainbow,
    // and the whole spectrum slowly turns over time.
    const drift = (t * CFG.hueDrift) % 1;
    for (let i = 0; i < N; i++) {
      const h = (drift + (i / N) * CFG.hueSpan) % 1;
      tint.setHSL(h, tone.s, tone.l);
      for (let v = 0; v < 3; v++) tint.toArray(frontColors, i * 9 + v * 3);
      tint.setHSL((h + 0.5) % 1, tone.s, tone.backL);
      for (let v = 0; v < 3; v++) tint.toArray(backColors, i * 9 + v * 3);
    }
    frontGeometry.attributes.color.needsUpdate = true;
    backGeometry.attributes.color.needsUpdate = true;
    // Hover glow uses the complement of the shape's middle colour.
    accent.setHSL((drift + CFG.hueSpan / 2 + 0.5) % 1, 0.9, 0.6);
  }
  applyTheme();
  new MutationObserver(() => { applyTheme(); if (paused) { paint(animTime()); render(); } })
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
      to = (to + 1) % SHAPE_COUNT;
      saveShape(to);
      morph.fill(0);
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
  const MAX_SPIN = 2 * Math.PI; // rad/s: at most one turn per second (see WCAG 2.3.1 note in step)
  const SETTLE_DIST = 0.002; // shape radii (sum of |dx|+|dy|+|dz|)
  const SETTLE_SPEED = 0.01;
  function step(dt) {
    const K = CFG.stiffness;
    const critical = 2 * Math.sqrt(K);
    const target = shape(to).centroids;
    let settled = true;

    for (let i = 0; i < N; i++) {
      const ix = i * 3;
      recover[i] = Math.min(1, recover[i] + dt / CFG.regatherSeconds);
      const r = smoothstep(clamp(recover[i], 0, 1));
      morph[i] = Math.max(morph[i], r);
      gap[i] += (0.55 + 0.45 * r - gap[i]) * Math.min(1, dt * 4);
      const k = K * r * r;
      const damping = 0.35 + (critical - 0.35) * r;

      for (let c = 0; c < 3; c++) {
        const a = k * (target[ix + c] - pos[ix + c]) - damping * vel[ix + c];
        vel[ix + c] += a * dt;
        pos[ix + c] += vel[ix + c] * dt;
      }

      // Tumble, with the spin bleeding off and the shard easing back to its resting orientation.
      q.fromArray(quat, i * 4);
      let wx = angVel[ix], wy = angVel[ix + 1], wz = angVel[ix + 2];
      let w = Math.hypot(wx, wy, wz);
      if (w > MAX_SPIN) {
        // WCAG 2.3.1 (Three Flashes): a tumbling shard swaps its rainbow face for the
        // complementary one twice per turn. Capping spin at one turn per second keeps every
        // shard under 3 flashes a second, however fast someone clicks (clicks add spin).
        const spinScale = MAX_SPIN / w;
        wx = angVel[ix] *= spinScale;
        wy = angVel[ix + 1] *= spinScale;
        wz = angVel[ix + 2] *= spinScale;
        w = MAX_SPIN;
      }
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

      if (settled && (
        recover[i] < 1 ||
        Math.abs(target[ix] - pos[ix]) + Math.abs(target[ix + 1] - pos[ix + 1]) + Math.abs(target[ix + 2] - pos[ix + 2]) > SETTLE_DIST ||
        Math.abs(vel[ix]) + Math.abs(vel[ix + 1]) + Math.abs(vel[ix + 2]) > SETTLE_SPEED ||
        Math.abs(q.w) < 0.9999 ||
        gap[i] < 0.999
      )) settled = false;
    }

    // Lock into a solid shape only once every shard has actually arrived, so the switch
    // from shards to whole is invisible. The timeout is a safety net, not the normal path.
    settleTimer += dt;
    if (settled || settleTimer > CFG.holdSeconds + CFG.regatherSeconds + 20) resetToWhole(to);
  }

  function writeVertices() {
    const A = shape(from).locals;
    const B = shape(to).locals;
    for (let i = 0; i < N; i++) {
      const m = whole ? 1 : morph[i]; // morph each shard from the old shape's triangle to the new one's
      const shrink = whole ? 1 : gap[i]; // gaps open up while scattered
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
    positionAttr.needsUpdate = true;
  }

  // Wall-clock time keeps the hover motion in phase across page loads.
  const clock = () => (Date.now() / 1000) % 100000;
  // Time spent paused is subtracted, so resuming continues smoothly instead of jumping, and
  // while paused the scene's time stands still at the moment of pausing. Kept in
  // sessionStorage so the pose stays continuous across page loads, paused or not.
  const TIME_KEY = 'bg-scene-time';
  let timeOffset = 0;
  let pausedAt = 0;
  function loadTime() {
    try {
      const t = JSON.parse(sessionStorage.getItem(TIME_KEY));
      timeOffset = Number(t && t.offset) || 0;
      pausedAt = Number(t && t.pausedAt) || 0;
    } catch (err) { /* storage blocked: start from the wall clock */ }
  }
  function saveTime() {
    try { sessionStorage.setItem(TIME_KEY, JSON.stringify({ offset: timeOffset, pausedAt })); } catch (err) { /* blocked */ }
  }
  loadTime();
  const animTime = () => (paused && pausedAt ? pausedAt : clock()) - timeOffset;

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
    frontMaterial.emissive.copy(accent).multiplyScalar(glow * 0.3);
    backMaterial.emissive.copy(frontMaterial.emissive);
  }

  function render() {
    renderer.render(scene, camera);
  }

  // ---- Carrying a shatter over to the next page ----
  // When the reader leaves mid-shatter, the shard state goes into sessionStorage; the next
  // page restores it and fast-forwards by the time the navigation took.
  const SNAPSHOT_KEY = 'bg-scene-snapshot';
  const SNAPSHOT_MAX_AGE = 30; // seconds; older than this, just show the finished shape
  const snapshotFields = [pos, vel, quat, angVel, recover, morph, gap];

  function discardSnapshot() {
    try { sessionStorage.removeItem(SNAPSHOT_KEY); } catch (err) { /* blocked */ }
  }

  function saveSnapshot() {
    try {
      // A paused page never hands its frozen shards on: the next page shows the finished shape.
      if (whole || paused) {
        sessionStorage.removeItem(SNAPSHOT_KEY);
        return;
      }
      sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
        v: 1, n: N, at: Date.now(), from, to, settleTimer,
        data: snapshotFields.map(toBase64),
      }));
    } catch (err) { /* storage full or blocked: the next page just shows the finished shape */ }
  }

  function restoreSnapshot() {
    let snap;
    try {
      snap = JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY));
      sessionStorage.removeItem(SNAPSHOT_KEY);
    } catch (err) {
      return false;
    }
    const age = snap ? (Date.now() - snap.at) / 1000 : -1;
    if (!snap || snap.v !== 1 || snap.n !== N || !(age >= 0 && age <= SNAPSHOT_MAX_AGE)) return false;
    if (![snap.from, snap.to].every((i) => Number.isInteger(i) && i >= 0 && i < SHAPE_COUNT)) return false;
    let decoded;
    try {
      decoded = snapshotFields.map((field, k) => fromBase64(snap.data[k], field.length));
    } catch (err) {
      return false;
    }
    decoded.forEach((arr, k) => snapshotFields[k].set(arr));
    from = snap.from;
    to = snap.to;
    settleTimer = Number(snap.settleTimer) || 0;
    whole = false;
    // Catch up on the time the navigation took, in small steps so the physics stays stable.
    for (let left = age; left > 0 && !whole; left -= 1 / 30) step(Math.min(left, 1 / 30));
    if (!whole) writeVertices();
    return true;
  }

  window.addEventListener('pagehide', saveSnapshot);
  // Back/forward restores this page from memory with its old state; pick up whatever the
  // page we just left was doing instead.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    // Other pages may have paused/resumed the animation, moved the time offset or advanced the
    // shape while this one sat in the cache; pick all of that up.
    loadTime();
    const pref = loadMotionPref();
    if (pref !== null && pref !== paused) setPaused(pref, false);
    if (paused) {
      const current = loadShape();
      if (!whole || current !== to) resetToWhole(current);
      discardSnapshot();
      showStill();
      return;
    }
    if (!restoreSnapshot()) {
      const current = loadShape();
      if (!whole || current !== to) resetToWhole(current);
    }
  });

  function showStill() {
    const t = animTime();
    paint(t);
    place(t, 0);
    render();
  }

  window.addEventListener('resize', () => { resize(); if (paused) showStill(); }, { passive: true });

  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || paused) return;
    hovering = true;
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { hovering = false; });
  window.addEventListener('blur', () => { hovering = false; });

  window.addEventListener('click', (e) => {
    if (paused) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest(IGNORE + ', .scene-controls')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // the user was selecting text
    shatter(e.clientX, e.clientY);
  }, { passive: true });

  let raf = 0;
  let last = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    // rAF timestamps can be slightly earlier than performance.now() at start(), so clamp at 0.
    const dt = Math.min(Math.max(0, (now - last) / 1000) || 0, 1 / 30);
    last = now;
    const t = animTime();
    place(t, dt);
    paint(t);
    if (!whole) {
      step(dt);
      if (!whole) writeVertices();
    }
    render();
  }
  // In forced-colours mode (Windows High Contrast) a11y.css hides the scene; don't keep
  // rendering it out of sight.
  const forcedColors = window.matchMedia('(forced-colors: active)');
  function start() {
    if (!raf && !paused && !document.hidden && !forcedColors.matches) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  forcedColors.addEventListener('change', () => (forcedColors.matches ? stop() : start()));

  // ---- Controls (layouts/_partials/scene_controls.html) ----
  // Shown only once the scene is running, so there is nothing to pause without WebGL or JS.
  const controls = document.getElementById('scene-controls');
  const pauseBtn = document.getElementById('scene-pause');
  const shatterBtn = document.getElementById('scene-shatter');

  function setPaused(p, save = true) {
    paused = p;
    if (p) {
      stop();
      if (!pausedAt) pausedAt = clock(); // keep an earlier page's pause moment, so the pose matches
      // Drop the cursor lean and glow too, so the paused pose depends only on time and is the
      // same on every page (otherwise it would jump on the next page load).
      hovering = false;
      lean.set(0, 0);
      glow = 0;
      showStill();
    } else {
      if (pausedAt) timeOffset += clock() - pausedAt;
      pausedAt = 0;
      start();
    }
    saveTime();
    // A toggle button keeps one name (and tooltip); aria-pressed carries the state (WAI-ARIA APG).
    if (pauseBtn) pauseBtn.setAttribute('aria-pressed', String(p));
    if (shatterBtn) shatterBtn.disabled = p;
    if (save) {
      try { localStorage.setItem(MOTION_KEY, p ? 'paused' : 'playing'); } catch (err) { /* storage blocked */ }
    }
  }

  // WCAG 2.1.1 (Keyboard): the shatter isn't mouse-only; this button bursts the shape from its centre.
  function shatterFromCentre() {
    const c = v3.copy(group.position).project(camera);
    shatter(((c.x + 1) / 2) * window.innerWidth, ((1 - c.y) / 2) * window.innerHeight);
  }

  if (pauseBtn) pauseBtn.addEventListener('click', () => setPaused(!paused));
  if (shatterBtn) shatterBtn.addEventListener('click', () => { if (!paused) shatterFromCentre(); });

  if (paused) discardSnapshot(); else restoreSnapshot();
  setPaused(paused, false); // draws the still frame when paused, starts the loop when playing
  if (!paused) showStill(); // first frame now, not on the next animation frame
  canvas.classList.add('is-ready'); // fades the canvas in (see bg-scene.css)
  if (controls) controls.hidden = false;
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
  // Split in rounds: each round halves the largest triangles, up to the number still
  // needed. Far cheaper than rescanning for the single largest one each time, and the
  // pieces come out just as even.
  while (tris.length < count) {
    const order = tris.map((t, i) => [area(t), i]).sort((a, b) => b[0] - a[0]);
    const n = Math.min(order.length, count - tris.length);
    for (let k = 0; k < n; k++) {
      const i = order[k][1];
      const [t1, t2] = split(tris[i]);
      tris[i] = t1;
      tris.push(t2);
    }
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

function toBase64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(str, length) {
  const s = atob(str);
  const out = new Float32Array(length);
  if (s.length !== out.byteLength) throw new Error('snapshot size mismatch');
  const bytes = new Uint8Array(out.buffer);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return out;
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
