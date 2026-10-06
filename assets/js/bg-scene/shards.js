// The shapes, and the cutting of each into an exact number of triangle shards.
import {
  BoxGeometry,
  ConeGeometry,
  DodecahedronGeometry,
  IcosahedronGeometry,
  OctahedronGeometry,
  TetrahedronGeometry,
  TorusGeometry,
  TorusKnotGeometry,
} from '../vendor/three.module.js';
import { clamp } from './math.js';

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

export const SHAPE_COUNT = SHAPE_MAKERS.length;

// Shape `i`, normalised to radius 1 and cut into exactly `count` triangles.
// Returns { centroids, locals }: each triangle's centre, and its corners relative to that centre.
export const makeShape = (i, count) => buildShards(SHAPE_MAKERS[i](), count);

// Splits the largest triangles along their longest edge (which keeps the surface unchanged)
// until there are `count`, then orders them top-to-bottom in a snake pattern so shards
// travel to nearby spots when shapes change.
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

// Bisect the longest edge; both halves keep the original winding.
function split(t) {
  const d = (a, b) => Math.hypot(t[a] - t[b], t[a + 1] - t[b + 1], t[a + 2] - t[b + 2]);
  const e = [d(0, 3), d(3, 6), d(6, 0)];
  const longest = e.indexOf(Math.max(...e));
  const order = [[0, 3, 6], [3, 6, 0], [6, 0, 3]][longest]; // rotate so the longest edge is A->B
  const A = [t[order[0]], t[order[0] + 1], t[order[0] + 2]];
  const B = [t[order[1]], t[order[1] + 1], t[order[1] + 2]];
  const C = [t[order[2]], t[order[2] + 1], t[order[2] + 2]];
  const M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
  return [Float32Array.from([...A, ...M, ...C]), Float32Array.from([...M, ...B, ...C])];
}
