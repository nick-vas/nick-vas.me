// Tunable settings for the scene. The ones listed in fx-panel.js are adjustable from the gear
// panel; the rest are fixed.
export const HEMI_BASE = 1.4;
export const SUN_BASE = 1.8;

export const createConfig = () => ({
  fov: 40,
  camZ: 14,
  shards: 768, // every primitive is cut into exactly this many triangles
  burst: 3.4, // initial shard speed, in shape radii per second
  holdSeconds: 0.9, // drift freely before the pull back starts
  regatherSeconds: 6, // time for the pull to ramp to full strength
  stiffness: 2.5,
  spinBurst: 9,
  hoverLean: 0.35,
  followSpeed: 8, // how fast the tilt chases the pointer
  hueSpan: 0.85, // how much of the spectrum the gradient covers, top to bottom
  hueDrift: 0.015, // spectrum turns per second
  idle: 1, // speed of the slow idle rotation, 1 = normal
  size: 1, // shape size, 1 = normal
  opacity: 0.95,
  light: 1, // brightness of the lights, 1 = normal
  edgeMargin: 0.05, // how far shards may travel past the screen edge (0 = stay on screen)
  wallStiffness: 40, // how firmly shards are pushed back from that limit
});
