// Collision world: axis-aligned boxes, terrain height, raycasts, navigation grid + A*.
import * as THREE from '../lib/three.module.min.js';

const CELL = 4; // spatial hash cell size (m)

export class World {
  constructor() {
    this.boxes = [];
    this.hash = new Map();
    this.stamp = 0;
    this.bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
    this.groundFn = () => 0;
    this.surfaceFn = () => 'concrete';
    this.zones = [];
    this.hilly = false;
    this.nav = null;
  }

  ground(x, z) { return this.groundFn(x, z); }
  surfaceAt(x, z) { return this.surfaceFn(x, z); }

  zoneName(x, z) {
    for (const zn of this.zones) {
      if (zn.circle) {
        if (Math.hypot(x - zn.x, z - zn.z) < zn.r) return zn.name;
      } else if (x >= zn.minX && x <= zn.maxX && z >= zn.minZ && z <= zn.maxZ) return zn.name;
    }
    return 'Open ground';
  }

  // opts: solid (blocks movement), sight (blocks vision), shot (blocks darts), surface, tag
  addBox(minX, minY, minZ, maxX, maxY, maxZ, opts = {}) {
    const b = {
      min: new THREE.Vector3(Math.min(minX, maxX), Math.min(minY, maxY), Math.min(minZ, maxZ)),
      max: new THREE.Vector3(Math.max(minX, maxX), Math.max(minY, maxY), Math.max(minZ, maxZ)),
      solid: opts.solid !== false,
      sight: opts.sight !== false,
      shot: opts.shot !== false,
      surface: opts.surface || 'wood',
      tag: opts.tag || '',
      _s: 0,
      id: this.boxes.length,
    };
    this.boxes.push(b);
    this._hashInsert(b);
    return b;
  }

  removeBox(b) {
    const i = this.boxes.indexOf(b);
    if (i >= 0) this.boxes.splice(i, 1);
    for (const [, list] of this.hash) {
      const j = list.indexOf(b);
      if (j >= 0) list.splice(j, 1);
    }
  }

  _key(ix, iz) { return ix * 73856093 ^ iz * 19349663; }

  _hashInsert(b) {
    const x0 = Math.floor(b.min.x / CELL), x1 = Math.floor(b.max.x / CELL);
    const z0 = Math.floor(b.min.z / CELL), z1 = Math.floor(b.max.z / CELL);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const k = this._key(ix, iz);
      let l = this.hash.get(k);
      if (!l) { l = []; this.hash.set(k, l); }
      l.push(b);
    }
  }

  query(minX, minZ, maxX, maxZ, out = []) {
    out.length = 0;
    const s = ++this.stamp;
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const l = this.hash.get(this._key(ix, iz));
      if (!l) continue;
      for (const b of l) { if (b._s !== s) { b._s = s; out.push(b); } }
    }
    return out;
  }

  // ---- character movement ----
  // pos: feet position (mutated). Returns {onGround}
  moveCircle(pos, vel, dt, radius, height, stepH = 0.42) {
    const tmp = this._tmp || (this._tmp = []);
    pos.x += vel.x * dt;
    pos.z += vel.z * dt;
    // horizontal push-out (2 iterations)
    for (let it = 0; it < 2; it++) {
      this.query(pos.x - radius - 0.1, pos.z - radius - 0.1, pos.x + radius + 0.1, pos.z + radius + 0.1, tmp);
      for (const b of tmp) {
        if (!b.solid) continue;
        if (b.max.y <= pos.y + stepH || b.min.y >= pos.y + height) continue;
        const cx = Math.max(b.min.x, Math.min(pos.x, b.max.x));
        const cz = Math.max(b.min.z, Math.min(pos.z, b.max.z));
        let dx = pos.x - cx, dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= radius * radius) continue;
        if (d2 < 1e-8) {
          // centre inside box: push out along smallest axis
          const pl = pos.x - b.min.x, pr = b.max.x - pos.x, pb = pos.z - b.min.z, pf = b.max.z - pos.z;
          const m = Math.min(pl, pr, pb, pf);
          if (m === pl) pos.x = b.min.x - radius; else if (m === pr) pos.x = b.max.x + radius;
          else if (m === pb) pos.z = b.min.z - radius; else pos.z = b.max.z + radius;
          continue;
        }
        const d = Math.sqrt(d2);
        const push = radius - d;
        dx /= d; dz /= d;
        pos.x += dx * push; pos.z += dz * push;
        // remove velocity into the wall
        const vn = vel.x * dx + vel.z * dz;
        if (vn < 0) { vel.x -= vn * dx; vel.z -= vn * dz; }
      }
    }
    const B = this.bounds;
    pos.x = Math.max(B.minX + radius, Math.min(B.maxX - radius, pos.x));
    pos.z = Math.max(B.minZ + radius, Math.min(B.maxZ - radius, pos.z));

    // vertical
    const support = this.supportHeight(pos.x, pos.z, radius * 0.7, pos.y + stepH);
    vel.y -= 18 * dt;
    pos.y += vel.y * dt;
    let onGround = false;
    if (pos.y <= support) {
      pos.y = support; if (vel.y < 0) vel.y = 0; onGround = true;
    } else if (pos.y - support < 0.05 && vel.y <= 0) {
      pos.y = support; vel.y = 0; onGround = true;
    }
    // head bump
    if (vel.y > 0) {
      this.query(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius, tmp);
      for (const b of tmp) {
        if (!b.solid) continue;
        if (pos.x + radius * 0.7 < b.min.x || pos.x - radius * 0.7 > b.max.x || pos.z + radius * 0.7 < b.min.z || pos.z - radius * 0.7 > b.max.z) continue;
        if (b.min.y > pos.y + height - 0.1 && b.min.y < pos.y + height + 0.2) { vel.y = 0; }
      }
    }
    return { onGround };
  }

  supportHeight(x, z, r, maxY) {
    let h = this.ground(x, z);
    const tmp = this._tmp2 || (this._tmp2 = []);
    this.query(x - r, z - r, x + r, z + r, tmp);
    for (const b of tmp) {
      if (!b.solid) continue;
      if (x + r < b.min.x || x - r > b.max.x || z + r < b.min.z || z - r > b.max.z) continue;
      if (b.max.y <= maxY && b.max.y > h) h = b.max.y;
    }
    return h;
  }

  // clearance above point: is there a solid box overlapping [y, y+h] at (x,z)?
  blockedAt(x, z, r, y, h) {
    const tmp = this._tmp3 || (this._tmp3 = []);
    this.query(x - r, z - r, x + r, z + r, tmp);
    for (const b of tmp) {
      if (!b.solid) continue;
      if (x + r < b.min.x || x - r > b.max.x || z + r < b.min.z || z - r > b.max.z) continue;
      if (b.min.y < y + h && b.max.y > y + 0.42) return true;
    }
    return false;
  }

  // ---- raycasts ----
  // flag: 'sight' | 'shot' | 'solid'
  raycast(origin, dir, maxDist, flag = 'shot') {
    let best = maxDist, bestBox = null, bestN = null;
    const ex = origin.x + dir.x * maxDist, ez = origin.z + dir.z * maxDist;
    // DDA over hash cells
    const s = ++this.stamp;
    let ix = Math.floor(origin.x / CELL), iz = Math.floor(origin.z / CELL);
    const tx = Math.floor(ex / CELL), tz = Math.floor(ez / CELL);
    const stepX = dir.x > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(dir.x) > 1e-9 ? CELL / Math.abs(dir.x) : Infinity;
    const tDeltaZ = Math.abs(dir.z) > 1e-9 ? CELL / Math.abs(dir.z) : Infinity;
    let tMaxX = Math.abs(dir.x) > 1e-9 ? ((dir.x > 0 ? (ix + 1) * CELL - origin.x : origin.x - ix * CELL) / Math.abs(dir.x)) : Infinity;
    let tMaxZ = Math.abs(dir.z) > 1e-9 ? ((dir.z > 0 ? (iz + 1) * CELL - origin.z : origin.z - iz * CELL) / Math.abs(dir.z)) : Infinity;
    let guard = 0;
    while (guard++ < 400) {
      const l = this.hash.get(this._key(ix, iz));
      if (l) for (const b of l) {
        if (b._s === s) continue; b._s = s;
        if (!b[flag]) continue;
        const r = rayBox(origin, dir, b, best);
        if (r) { best = r.t; bestBox = b; bestN = r.n; }
      }
      const tEnter = Math.min(tMaxX, tMaxZ);
      if (tEnter > best) break;
      if (ix === tx && iz === tz) break;
      if (tMaxX < tMaxZ) { tMaxX += tDeltaX; ix += stepX; } else { tMaxZ += tDeltaZ; iz += stepZ; }
    }
    // ground
    let groundHit = false;
    if (dir.y < 0 || this.hilly) {
      const step = this.hilly ? 0.75 : best;
      if (!this.hilly) {
        const g = this.ground(0, 0);
        if (dir.y < -1e-6) {
          const t = (g - origin.y) / dir.y;
          if (t > 0 && t < best) { best = t; bestBox = null; bestN = new THREE.Vector3(0, 1, 0); groundHit = true; }
        }
      } else {
        for (let t = step; t < best; t += step) {
          const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
          if (y < this.ground(x, z)) { best = t - step * 0.5; bestBox = null; bestN = new THREE.Vector3(0, 1, 0); groundHit = true; break; }
        }
      }
    }
    if (best >= maxDist && !bestBox && !groundHit) return null;
    return { t: best, box: bestBox, normal: bestN, ground: groundHit };
  }

  lineOfSight(a, b, flag = 'sight') {
    const d = _v.subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return true;
    d.divideScalar(len);
    const hit = this.raycast(a, d.clone(), len, flag);
    return !hit || hit.t >= len - 0.05;
  }

  // ---- navigation ----
  buildNav(cell = 0.5) {
    const B = this.bounds;
    const w = Math.ceil((B.maxX - B.minX) / cell), h = Math.ceil((B.maxZ - B.minZ) / cell);
    const nav = { cell, w, h, ox: B.minX, oz: B.minZ, walk: new Uint8Array(w * h), cost: new Float32Array(w * h), dyn: new Float32Array(w * h) };
    this.nav = nav;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this._navCell(i, j);
    return nav;
  }

  _navCell(i, j) {
    const nav = this.nav;
    const x = nav.ox + (i + 0.5) * nav.cell, z = nav.oz + (j + 0.5) * nav.cell;
    const g = this.ground(x, z);
    const r = 0.2;
    const tmp = this._tmp4 || (this._tmp4 = []);
    this.query(x - r, z - r, x + r, z + r, tmp);
    let walk = 1, cost = 1;
    for (const b of tmp) {
      if (x + r < b.min.x || x - r > b.max.x || z + r < b.min.z || z - r > b.max.z) continue;
      if (!b.solid) { if (b.tag === 'bush') cost = Math.max(cost, 2.5); continue; }
      if (b.max.y <= g + 0.42) continue; // steppable
      if (b.min.y >= g + 1.05) continue; // crawlable under
      walk = 0; break;
    }
    // edge of bounds
    const B = this.bounds;
    if (x < B.minX + 0.4 || x > B.maxX - 0.4 || z < B.minZ + 0.4 || z > B.maxZ - 0.4) walk = 0;
    if (this.hilly) {
      const s = Math.abs(this.ground(x + 0.5, z) - this.ground(x - 0.5, z)) + Math.abs(this.ground(x, z + 0.5) - this.ground(x, z - 0.5));
      if (s > 1.4) walk = 0; else cost += s;
    }
    const k = j * nav.w + i;
    nav.walk[k] = walk; nav.cost[k] = cost;
  }

  rebuildNavArea(minX, minZ, maxX, maxZ) {
    const nav = this.nav; if (!nav) return;
    const i0 = Math.max(0, Math.floor((minX - nav.ox) / nav.cell) - 1), i1 = Math.min(nav.w - 1, Math.floor((maxX - nav.ox) / nav.cell) + 1);
    const j0 = Math.max(0, Math.floor((minZ - nav.oz) / nav.cell) - 1), j1 = Math.min(nav.h - 1, Math.floor((maxZ - nav.oz) / nav.cell) + 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this._navCell(i, j);
  }

  cellOf(x, z) {
    const nav = this.nav;
    return [Math.floor((x - nav.ox) / nav.cell), Math.floor((z - nav.oz) / nav.cell)];
  }
  cellCenter(i, j) {
    const nav = this.nav;
    const x = nav.ox + (i + 0.5) * nav.cell, z = nav.oz + (j + 0.5) * nav.cell;
    return new THREE.Vector3(x, this.ground(x, z), z);
  }
  walkable(i, j) {
    const nav = this.nav;
    return i >= 0 && j >= 0 && i < nav.w && j < nav.h && nav.walk[j * nav.w + i] === 1;
  }
  walkableAt(x, z) { const [i, j] = this.cellOf(x, z); return this.walkable(i, j); }

  nearestWalkable(x, z, maxR = 8) {
    const [ci, cj] = this.cellOf(x, z);
    if (this.walkable(ci, cj)) return [ci, cj];
    const nav = this.nav;
    const R = Math.ceil(maxR / nav.cell);
    for (let r = 1; r <= R; r++) {
      for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
        if (Math.abs(di) !== r && Math.abs(dj) !== r) continue;
        if (this.walkable(ci + di, cj + dj)) return [ci + di, cj + dj];
      }
    }
    return null;
  }

  // dynamic cost function: (x,z) => extra cost
  findPath(from, to, extraCost = null, maxIter = 40000) {
    const nav = this.nav;
    const s = this.nearestWalkable(from.x, from.z, 3);
    const e = this.nearestWalkable(to.x, to.z, 6);
    if (!s || !e) return null;
    const W = nav.w, N = W * nav.h;
    if (!this._g || this._g.length !== N) {
      this._g = new Float32Array(N); this._par = new Int32Array(N); this._vis = new Uint32Array(N); this._open = new Uint32Array(N); this._gen = 0;
    }
    const g = this._g, par = this._par, vis = this._vis, openS = this._open;
    const gen = ++this._gen;
    const sk = s[1] * W + s[0], ek = e[1] * W + e[0];
    const ex = e[0], ey = e[1];
    const heap = new Heap();
    g[sk] = 0; par[sk] = -1; openS[sk] = gen;
    heap.push(sk, 0);
    const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
    let iter = 0, found = false;
    while (heap.size && iter++ < maxIter) {
      const k = heap.pop();
      if (vis[k] === gen) continue;
      vis[k] = gen;
      if (k === ek) { found = true; break; }
      const ci = k % W, cj = (k / W) | 0;
      for (const [di, dj, dc] of D) {
        const ni = ci + di, nj = cj + dj;
        if (!this.walkable(ni, nj)) continue;
        if (di && dj && (!this.walkable(ci + di, cj) || !this.walkable(ci, cj + dj))) continue;
        const nk = nj * W + ni;
        if (vis[nk] === gen) continue;
        let c = dc * nav.cost[nk] + nav.dyn[nk];
        if (extraCost) c += dc * extraCost(nav.ox + (ni + 0.5) * nav.cell, nav.oz + (nj + 0.5) * nav.cell);
        const ng = g[k] + c;
        if (openS[nk] !== gen || ng < g[nk]) {
          openS[nk] = gen; g[nk] = ng; par[nk] = k;
          const dx = Math.abs(ni - ex), dy = Math.abs(nj - ey);
          heap.push(nk, ng + (dx + dy) + (1.414 - 2) * Math.min(dx, dy));
        }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let k = ek; k !== -1; k = par[k]) cells.push(k);
    cells.reverse();
    // smoothing
    const pts = [];
    let anchor = 0;
    pts.push(cells[0]);
    for (let i = 2; i < cells.length; i++) {
      if (!this._gridLine(cells[anchor], cells[i])) { anchor = i - 1; pts.push(cells[anchor]); }
    }
    pts.push(cells[cells.length - 1]);
    const out = pts.map(k => this.cellCenter(k % W, (k / W) | 0));
    out.push(new THREE.Vector3(to.x, this.ground(to.x, to.z), to.z));
    if (this.walkableAt(to.x, to.z) === false) out.pop();
    return out;
  }

  _gridLine(a, b) {
    const W = this.nav.w;
    let x0 = a % W, y0 = (a / W) | 0;
    const x1 = b % W, y1 = (b / W) | 0;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    const nav = this.nav;
    const baseCost = nav.cost[a];
    while (true) {
      if (!this.walkable(x0, y0)) return false;
      const k = y0 * W + x0;
      if (nav.cost[k] > baseCost + 1.2 || nav.dyn[k] > 2) return false;
      if (x0 === x1 && y0 === y1) return true;
      const e2 = 2 * err;
      if (e2 > -dy && e2 < dx) {
        // diagonal: check corners for safety
        if (!this.walkable(x0 + sx, y0) || !this.walkable(x0, y0 + sy)) return false;
      }
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  randomWalkable(rng = Math.random, near = null, radius = 10) {
    const nav = this.nav;
    for (let t = 0; t < 200; t++) {
      let x, z;
      if (near) { const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * radius; x = near.x + Math.cos(a) * r; z = near.z + Math.sin(a) * r; }
      else { x = nav.ox + rng() * nav.w * nav.cell; z = nav.oz + rng() * nav.h * nav.cell; }
      if (this.walkableAt(x, z)) return new THREE.Vector3(x, this.ground(x, z), z);
    }
    return near ? near.clone() : new THREE.Vector3();
  }
}

const _v = new THREE.Vector3();

export function rayBox(o, d, b, maxT) {
  let tmin = 0, tmax = maxT, nAxis = -1, nSign = 0;
  for (let a = 0; a < 3; a++) {
    const oa = a === 0 ? o.x : a === 1 ? o.y : o.z;
    const da = a === 0 ? d.x : a === 1 ? d.y : d.z;
    const mn = a === 0 ? b.min.x : a === 1 ? b.min.y : b.min.z;
    const mx = a === 0 ? b.max.x : a === 1 ? b.max.y : b.max.z;
    if (Math.abs(da) < 1e-9) { if (oa < mn || oa > mx) return null; continue; }
    let t1 = (mn - oa) / da, t2 = (mx - oa) / da, s = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; nAxis = a; nSign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (nAxis < 0) return null; // origin inside
  const n = new THREE.Vector3();
  n.setComponent(nAxis, nSign);
  return { t: tmin, n };
}

class Heap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(k, p) {
    const K = this.k, P = this.p;
    K.push(k); P.push(p);
    let i = K.length - 1;
    while (i > 0) {
      const pi = (i - 1) >> 1;
      if (P[pi] <= P[i]) break;
      [K[pi], K[i]] = [K[i], K[pi]]; [P[pi], P[i]] = [P[i], P[pi]];
      i = pi;
    }
  }
  pop() {
    const K = this.k, P = this.p;
    const top = K[0];
    const lk = K.pop(), lp = P.pop();
    if (K.length) {
      K[0] = lk; P[0] = lp;
      let i = 0;
      const n = K.length;
      while (true) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < n && P[l] < P[m]) m = l;
        if (r < n && P[r] < P[m]) m = r;
        if (m === i) break;
        [K[m], K[i]] = [K[i], K[m]]; [P[m], P[i]] = [P[i], P[m]];
        i = m;
      }
    }
    return top;
  }
}

// deterministic RNG
export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// value noise for terrain
export function makeNoise(seed) {
  const rng = mulberry32(seed);
  const P = new Float32Array(256 * 256);
  for (let i = 0; i < P.length; i++) P[i] = rng();
  const at = (x, y) => P[((y & 255) << 8) | (x & 255)];
  const sm = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = sm(x - xi), yf = sm(y - yi);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}
