// Background scene: one primitive hovers at a time. A click shatters it into its own
// triangle shards, which drift apart and slowly regather as the next primitive.
// Runs behind every page. The canvas never takes pointer events; clicks are read
// from the window and ignored when they land on anything interactive.
// Modules live in ./bg-scene/: config, shards (geometry), storage, fx-panel (sliders), math.
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  FrontSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from './vendor/three.module.js';
import { HEMI_BASE, SUN_BASE, createConfig } from './bg-scene/config.js';
import { initFxPanel, restoreFx } from './bg-scene/fx-panel.js';
import { clamp, lerp, mulberry32, smoothstep } from './bg-scene/math.js';
import { SHAPE_COUNT, makeShape } from './bg-scene/shards.js';
import {
  clearSnapshot, firstSceneOfVisit, fromBase64, loadMotionPref, loadShape, loadTime,
  saveMotionPref, saveShape, saveTime, storeSnapshot, takeSnapshot, toBase64,
} from './bg-scene/storage.js';

const canvas = document.getElementById('bg-scene');
if (canvas) init(canvas);

function init(canvas) {
  const CFG = createConfig();
  const FX_DEFAULTS = { ...CFG };
  restoreFx(CFG);

  // The animation plays by default, even when the OS asks for reduced motion (a deliberate
  // choice for this site). WCAG 2.2.2 (Pause, Stop, Hide) is met by the pause button in
  // scene_controls.html; the choice is remembered across pages. Only the dev-only test panel's
  // sim-rm class starts it paused with no saved choice.
  let paused = loadMotionPref() ?? document.documentElement.classList.contains('sim-rm');

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
  const hemi = new HemisphereLight(0xffffff, 0x445066, HEMI_BASE);
  const sun = new DirectionalLight(0xffffff, SUN_BASE);
  sun.position.set(5, 8, 10);
  scene.add(hemi, sun);

  const rand = mulberry32(20261005);

  // Built on demand: only the current shape is cut up before the first frame, and the
  // next one is prepared when the browser is idle, so page loads stay quick.
  const shapeCache = [];
  const shape = (i) => shapeCache[i] || (shapeCache[i] = makeShape(i, CFG.shards));
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
    opacity: CFG.opacity,
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
  let from = loadShape(SHAPE_COUNT);
  let to = from;
  let whole = true; // shards locked together into a solid shape
  let settleTimer = 0;
  resetToWhole(from);

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
  const tint = new Color();
  function applyTheme() {
    const dark = document.documentElement.dataset.theme !== 'light';
    tone = dark ? TONES.dark : TONES.light;
    hemi.groundColor.set(dark ? 0x2a3040 : 0x9aa4b8);
  }
  function paint(t) {
    // Shards are ordered top to bottom, so hue runs down the shape like a rainbow,
    // and the whole spectrum slowly turns over time.
    const drift = (t * CFG.hueDrift + hueShift) % 1;
    for (let i = 0; i < N; i++) {
      const h = (drift + (i / N) * CFG.hueSpan) % 1;
      tint.setHSL(h, tone.s, tone.l);
      for (let v = 0; v < 3; v++) tint.toArray(frontColors, i * 9 + v * 3);
      tint.setHSL((h + 0.5) % 1, tone.s, tone.backL);
      for (let v = 0; v < 3; v++) tint.toArray(backColors, i * 9 + v * 3);
    }
    frontGeometry.attributes.color.needsUpdate = true;
    backGeometry.attributes.color.needsUpdate = true;
  }
  applyTheme();
  new MutationObserver(() => { applyTheme(); if (paused) { paint(animTime()); render(); } })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---- Layout ----
  let radius = 2;
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const halfH = Math.tan((CFG.fov * Math.PI) / 360) * CFG.camZ;
    const halfW = halfH * camera.aspect;
    // Always centred; the reading column scrolls over it. Wide screens get a larger shape.
    const wide = camera.aspect > 1.25;
    radius = Math.min(halfH * (wide ? 0.42 : 0.34), halfW * (wide ? 0.32 : 0.6));
  }
  resize();

  // ---- Pointer ----
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  let hovering = false;
  const lean = new Vector2();

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
      const dx = pos[ix] - lx;
      const dy = pos[ix + 1] - ly;
      const dz = pos[ix + 2] - lz;
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
  // Soft walls just outside the viewport: a shard's centre may go a little past the edge (so a
  // shatter still looks like it bursts off-screen) but is eased back instead of flying away.
  // CFG.edgeMargin: how far past the edge, as a fraction of the half-height visible at the
  // shard's depth. CFG.wallStiffness: how firmly it is pushed back.
  const TAN_HALF_FOV = Math.tan((CFG.fov * Math.PI) / 360);
  const wp = new Vector3();
  const wall = new Vector3();
  const qInv = new Quaternion();

  function step(dt) {
    const K = CFG.stiffness;
    const critical = 2 * Math.sqrt(K);
    const target = shape(to).centroids;
    let settled = true;
    qInv.copy(group.quaternion).invert();
    const gscale = group.scale.x || 1;

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

      // Where is this shard on screen? Past the edge plus the margin, push it back in.
      wp.set(pos[ix], pos[ix + 1], pos[ix + 2]).multiplyScalar(gscale).applyQuaternion(group.quaternion).add(group.position);
      const halfH = TAN_HALF_FOV * Math.max(1, CFG.camZ - wp.z);
      const maxY = halfH * (1 + CFG.edgeMargin);
      const maxX = halfH * camera.aspect + halfH * CFG.edgeMargin;
      const overX = wp.x > maxX ? wp.x - maxX : wp.x < -maxX ? wp.x + maxX : 0;
      const overY = wp.y > maxY ? wp.y - maxY : wp.y < -maxY ? wp.y + maxY : 0;
      if (overX || overY) {
        wall.set(-overX, -overY, 0).multiplyScalar(CFG.wallStiffness * dt / gscale).applyQuaternion(qInv);
        vel[ix] += wall.x;
        vel[ix + 1] += wall.y;
        vel[ix + 2] += wall.z;
        const brake = 1 - Math.min(1, dt * 3);
        vel[ix] *= brake;
        vel[ix + 1] *= brake;
        vel[ix + 2] *= brake;
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
  let { offset: timeOffset, pausedAt, idleShift, hueShift } = loadTime();
  const saveClock = () => saveTime({ offset: timeOffset, pausedAt, idleShift, hueShift });
  const animTime = () => (paused && pausedAt ? pausedAt : clock()) - timeOffset;

  function place(t, dt) {
    // The shape leans gently toward the pointer. It never lights up or swells on hover.
    if (hovering) lean.lerp(ndc, Math.min(1, dt * CFG.followSpeed));
    else lean.multiplyScalar(1 - Math.min(1, dt * CFG.followSpeed));
    group.position.set(Math.cos(t * 0.31) * 0.12, Math.sin(t * 0.6) * 0.22, 0);
    group.rotation.set(
      Math.sin(t * 0.23) * 0.35 - lean.y * CFG.hoverLean,
      t * 0.22 * CFG.idle + idleShift + lean.x * CFG.hoverLean,
      Math.sin(t * 0.17) * 0.12,
    );
    group.scale.setScalar(radius * CFG.size);
  }

  const render = () => renderer.render(scene, camera);

  // ---- Carrying a shatter over to the next page ----
  // When the reader leaves mid-shatter, the shard state goes into sessionStorage; the next
  // page restores it and fast-forwards by the time the navigation took.
  const SNAPSHOT_MAX_AGE = 30; // seconds; older than this, just show the finished shape
  const snapshotFields = [pos, vel, quat, angVel, recover, morph, gap];

  function saveSnapshot() {
    // A paused page never hands its frozen shards on: the next page shows the finished shape.
    if (whole || paused) clearSnapshot();
    else storeSnapshot({ v: 1, n: N, at: Date.now(), from, to, settleTimer, data: snapshotFields.map(toBase64) });
  }

  function restoreSnapshot() {
    const snap = takeSnapshot();
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
    ({ offset: timeOffset, pausedAt, idleShift, hueShift } = loadTime());
    const pref = loadMotionPref();
    if (pref !== null && pref !== paused) setPaused(pref, false);
    if (paused) {
      const current = loadShape(SHAPE_COUNT);
      if (!whole || current !== to) resetToWhole(current);
      clearSnapshot();
      showStill();
      return;
    }
    if (!restoreSnapshot()) {
      const current = loadShape(SHAPE_COUNT);
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
      // Drop the cursor lean too, so the paused pose depends only on time and is the
      // same on every page (otherwise it would jump on the next page load).
      hovering = false;
      lean.set(0, 0);
      showStill();
    } else {
      if (pausedAt) timeOffset += clock() - pausedAt;
      pausedAt = 0;
      start();
    }
    saveClock();
    // A toggle button keeps one name (and tooltip); aria-pressed carries the state (WAI-ARIA APG).
    if (pauseBtn) pauseBtn.setAttribute('aria-pressed', String(p));
    if (shatterBtn) shatterBtn.disabled = p;
    if (save) saveMotionPref(p);
  }

  // WCAG 2.1.1 (Keyboard): the shatter isn't mouse-only; this button bursts the shape from its centre.
  function shatterFromCentre() {
    const c = v3.copy(group.position).project(camera);
    shatter(((c.x + 1) / 2) * window.innerWidth, ((1 - c.y) / 2) * window.innerHeight);
  }

  if (pauseBtn) pauseBtn.addEventListener('click', () => setPaused(!paused));
  if (shatterBtn) shatterBtn.addEventListener('click', () => { if (!paused) shatterFromCentre(); });

  // Effect sliders (fx-panel.js). Changes apply live, and redraw the still frame when paused.
  let lastIdle = CFG.idle;
  let lastDrift = CFG.hueDrift;
  function applyFx() {
    // Rotation and colour are speed x absolute time, so changing a speed would make them jump
    // by (time x change). Shift their phase by the opposite amount to keep them where they are.
    const t = animTime();
    if (CFG.idle !== lastIdle || CFG.hueDrift !== lastDrift) {
      idleShift += t * 0.22 * (lastIdle - CFG.idle);
      hueShift = (hueShift + t * (lastDrift - CFG.hueDrift)) % 1;
      lastIdle = CFG.idle;
      lastDrift = CFG.hueDrift;
      saveClock();
    }
    frontMaterial.opacity = backMaterial.opacity = CFG.opacity;
    hemi.intensity = HEMI_BASE * CFG.light;
    sun.intensity = SUN_BASE * CFG.light;
    if (paused) showStill();
  }
  initFxPanel(CFG, FX_DEFAULTS, applyFx);
  applyFx();

  // The wall test in step() needs the shape's real position and scale, so place it first.
  place(animTime(), 0);
  if (paused) clearSnapshot(); else restoreSnapshot();
  setPaused(paused, false); // draws the still frame when paused, starts the loop when playing
  if (!paused) showStill(); // first frame now, not on the next animation frame
  // Fade in on the first page of a visit only; later pages show it at full opacity at once,
  // so moving between pages never dips the shape's opacity.
  if (!firstSceneOfVisit()) canvas.style.transition = 'none';
  canvas.classList.add('is-ready'); // fades the canvas in (see bg-scene.css)
  if (controls) controls.hidden = false;
}
