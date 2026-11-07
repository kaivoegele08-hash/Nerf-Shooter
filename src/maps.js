// Map builders: Basement, Forest, Jürgen Forest, Soccer Field, Garden, Garden + Basement.
import * as THREE from '../lib/three.module.min.js';
import { TEX, sprayDecal } from './textures.js';
import { mulberry32, makeNoise } from './world.js';

export const MAPS = {
  basement: { name: 'Basement', desc: 'Tight rooms, low ceilings, furniture everywhere. Pure close-quarters chaos.', modes: ['tdm'], rec: 'tdm' },
  forest: { name: 'Forest', desc: 'Huge woodland with hills, trails, a hunting stand and an old shack.', modes: ['hunt', 'tdm'], rec: 'hunt' },
  jurgen: { name: 'Jürgen Forest', desc: 'Misty woods. Somewhere in there, Jürgen guards his base with a katana.', modes: ['hunt', 'tdm'], rec: 'hunt' },
  soccer: { name: 'Soccer Field', desc: 'Wide open pitch, almost no cover. Fast, aggressive, high risk.', modes: ['tdm', 'hunt'], rec: 'tdm' },
  garden: { name: 'Garden', desc: 'Hedges, a shed, a trampoline and a greenhouse. Balanced and sneaky.', modes: ['tdm', 'hunt'], rec: 'tdm' },
  gardenbasement: { name: 'Garden + Basement', desc: 'The backyard connects to the walk-out basement. Patio door, cellar steps, crawl window.', modes: ['tdm', 'hunt'], rec: 'tdm' },
};

const V = (x, y, z) => new THREE.Vector3(x, y, z);

class Builder {
  constructor(scene, world, seed) {
    this.scene = scene; this.world = world; this.rng = mulberry32(seed);
    this.group = new THREE.Group(); scene.add(this.group);
    this.mats = {}; this.geos = {};
    this.flickers = []; this.updaters = [];
  }
  mat(key, opts = {}) {
    if (this.mats[key]) return this.mats[key];
    const m = new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.85, metalness: 0.0 }, opts));
    this.mats[key] = m; return m;
  }
  tmat(key, tex, color = 0xffffff, extra = {}) { return this.mat(key, Object.assign({ map: TEX[tex](), color }, extra)); }

  boxGeo(w, h, d, ts) {
    const k = `${w.toFixed(2)}|${h.toFixed(2)}|${d.toFixed(2)}|${ts}`;
    if (this.geos[k]) return this.geos[k];
    const g = new THREE.BoxGeometry(w, h, d);
    if (ts) {
      const uv = g.attributes.uv;
      const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
      for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
        const i = f * 4 + v;
        uv.setXY(i, uv.getX(i) * dims[f][0] / ts, uv.getY(i) * dims[f][1] / ts);
      }
    }
    this.geos[k] = g; return g;
  }

  // centre x/z, bottom y, size
  box(cx, y0, cz, w, h, d, mat, opts = {}) {
    const m = new THREE.Mesh(this.boxGeo(w, h, d, opts.ts || (mat.map ? 1.5 : 0)), mat);
    m.position.set(cx, y0 + h / 2, cz);
    if (opts.rotY) m.rotation.y = opts.rotY;
    m.castShadow = opts.cast !== false; m.receiveShadow = true;
    this.group.add(m);
    if (opts.collide !== false) {
      let hw = w / 2, hd = d / 2;
      if (opts.rotY) { const c = Math.abs(Math.cos(opts.rotY)), s = Math.abs(Math.sin(opts.rotY)); const nw = hw * c + hd * s, nd = hw * s + hd * c; hw = nw; hd = nd; }
      this.world.addBox(cx - hw, y0, cz - hd, cx + hw, y0 + h, cz + hd, opts);
    }
    return m;
  }
  vis(geo, mat, x, y, z, opts = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (opts.rot) m.rotation.set(opts.rot[0], opts.rot[1], opts.rot[2]);
    m.castShadow = opts.cast !== false; m.receiveShadow = true;
    (opts.parent || this.group).add(m);
    return m;
  }
  // wall along X at z; doors: [{c, w, top?}]
  wallX(x0, x1, z, h, t, doors, mat, opts = {}) {
    const segs = [];
    let cur = x0;
    const ds = [...(doors || [])].sort((a, b) => a.c - b.c);
    for (const dr of ds) {
      const a = dr.c - dr.w / 2, b = dr.c + dr.w / 2;
      if (a > cur) segs.push([cur, a]);
      const top = dr.top ?? 2.05;
      if (top < h) this.box((a + b) / 2, top, z, b - a, h - top, t, mat, opts);
      if (dr.sill) this.box((a + b) / 2, 0, z, b - a, dr.sill, t, mat, opts);
      cur = b;
    }
    if (cur < x1) segs.push([cur, x1]);
    for (const [a, b] of segs) this.box((a + b) / 2, 0, z, b - a, h, t, mat, opts);
  }
  wallZ(z0, z1, x, h, t, doors, mat, opts = {}) {
    let cur = z0;
    const ds = [...(doors || [])].sort((a, b) => a.c - b.c);
    for (const dr of ds) {
      const a = dr.c - dr.w / 2, b = dr.c + dr.w / 2;
      if (a > cur) this.box(x, 0, (cur + a) / 2, t, h, a - cur, mat, opts);
      const top = dr.top ?? 2.05;
      if (top < h) this.box(x, top, (a + b) / 2, t, h - top, b - a, mat, opts);
      if (dr.sill) this.box(x, 0, (a + b) / 2, t, dr.sill, b - a, mat, opts);
      cur = b;
    }
    if (cur < z1) this.box(x, 0, (cur + z1) / 2, t, h, z1 - cur, mat, opts);
  }
  floor(x0, z0, x1, z1, mat, y = 0, ts = 2) {
    const w = x1 - x0, d = z1 - z0;
    const g = new THREE.PlaneGeometry(w, d);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / ts, uv.getY(i) * d / ts);
    const m = new THREE.Mesh(g, mat);
    m.rotation.x = -Math.PI / 2; m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    m.receiveShadow = true;
    this.group.add(m); return m;
  }
  ceiling(x0, z0, x1, z1, mat, y) {
    const m = this.floor(x0, z0, x1, z1, mat, y, 2);
    m.rotation.x = Math.PI / 2; return m;
  }
  fluoro(x, z, y, len = 1.2, color = 0xf2f5ff, intensity = 5, dist = 9, flicker = 0, alongX = true) {
    const tube = new THREE.Mesh(this.boxGeo(alongX ? len : 0.12, 0.05, alongX ? 0.12 : len, 0), this.mat('fluoro_' + color, { color, emissive: color, emissiveIntensity: 1.5 }));
    tube.position.set(x, y - 0.03, z);
    this.group.add(tube);
    const L = new THREE.PointLight(color, intensity, dist, 1.6);
    L.position.set(x, y - 0.25, z);
    this.group.add(L);
    if (flicker) this.flickers.push({ L, tube, base: intensity, f: flicker, t: 0 });
    return L;
  }
  sign(text, x, y, z, w, h, rotY = 0, color = '#222', bg = '#d8d0b0', font = 'bold 56px sans-serif') {
    const tex = sprayDecal(text, 512, Math.round(512 * h / w), color, bg, font);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    m.position.set(x, y, z); m.rotation.y = rotY;
    this.group.add(m); return m;
  }
  // build a structure sitting at ground height y (offsets meshes and colliders)
  atY(y, fn) {
    const g = new THREE.Group(); g.position.y = y; this.group.add(g);
    const prev = this.group; this.group = g;
    const before = this.world.boxes.length;
    fn();
    this.group = prev;
    for (let i = before; i < this.world.boxes.length; i++) { const bx = this.world.boxes[i]; bx.min.y += y; bx.max.y += y; }
  }
  update(dt, t) {
    for (const f of this.flickers) {
      f.t -= dt;
      if (f.t <= 0) {
        const off = Math.random() < f.f;
        f.L.intensity = off ? f.base * 0.05 : f.base * (0.85 + Math.random() * 0.2);
        f.tube.material.emissiveIntensity = off ? 0.1 : 1.5;
        f.t = off ? 0.03 + Math.random() * 0.12 : 0.1 + Math.random() * 2.5;
      }
    }
    for (const u of this.updaters) u(dt, t);
  }
}

// ---------- furniture helpers ----------
function couch(b, x, z, w, rotY, color) {
  const m = b.mat('couch' + color, { color, map: TEX.fabric(), roughness: 1 });
  const c = Math.cos(rotY), s = Math.sin(rotY);
  const off = (dx, dz) => [x + dx * c + dz * s, z - dx * s + dz * c];
  const [sx, sz] = off(0, 0);
  b.box(sx, 0, sz, w, 0.45, 0.9, m, { rotY, surface: 'fabric' });
  const [bx, bz] = off(0, 0.38);
  b.box(bx, 0.45, bz, w, 0.45, 0.18, m, { rotY, surface: 'fabric' });
  for (const sgn of [-1, 1]) { const [ax, az] = off(sgn * (w / 2 - 0.1), 0); b.box(ax, 0.45, az, 0.2, 0.2, 0.9, m, { rotY, collide: false }); }
}
function shelf(b, x, z, w, h, d, rotY, items = true) {
  const metal = b.tmat('shelfmetal', 'metal', 0x7d8288, { metalness: 0.4, roughness: 0.6 });
  b.box(x, 0, z, w, h, d, b.mat('shelfdark', { color: 0x2b2d30 }), { rotY, surface: 'metal', collide: true, cast: true }).visible = false;
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY; b.group.add(g);
  for (const sx of [-w / 2 + 0.03, w / 2 - 0.03]) for (const sz of [-d / 2 + 0.03, d / 2 - 0.03]) b.vis(b.boxGeo(0.05, h, 0.05, 0), metal, sx, h / 2, sz, { parent: g });
  const levels = Math.max(2, Math.round(h / 0.5));
  const boxCols = [0xa88a5a, 0x9c7b4b, 0xb59b6a, 0x6a7d9a, 0xaa4040, 0x3a6a3a, 0xd8d0c0];
  for (let i = 0; i < levels; i++) {
    const y = 0.12 + i * (h - 0.15) / (levels - 1);
    b.vis(b.boxGeo(w, 0.03, d, 0), metal, 0, y, 0, { parent: g });
    if (items && i < levels - 1) {
      let cx = -w / 2 + 0.1;
      while (cx < w / 2 - 0.2) {
        const bw = 0.2 + b.rng() * 0.35, bh = 0.15 + b.rng() * 0.3;
        if (cx + bw > w / 2 - 0.05) break;
        if (b.rng() < 0.82) b.vis(b.boxGeo(bw, bh, d * 0.8, 0), b.mat('cb' + (i % 7), { color: boxCols[Math.floor(b.rng() * boxCols.length)] }), cx + bw / 2, y + 0.015 + bh / 2, 0, { parent: g });
        cx += bw + 0.04;
      }
    }
  }
}
function cardboard(b, x, z, s, y = 0, rotY = 0) {
  return b.box(x, y, z, s, s * 0.8, s, b.mat('cardboard', { color: 0xa88a5a, roughness: 1 }), { rotY, surface: 'cardboard' });
}
function table(b, x, z, w, d, h, mat, rotY = 0) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY; b.group.add(g);
  b.vis(b.boxGeo(w, 0.05, d, 0), mat, 0, h - 0.025, 0, { parent: g });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.vis(b.boxGeo(0.06, h - 0.05, 0.06, 0), mat, sx * (w / 2 - 0.06), (h - 0.05) / 2, sz * (d / 2 - 0.06), { parent: g });
  // collider only on top (crawlable under for players), plus thin "legs" are ignored
  const c = Math.abs(Math.cos(rotY)), s = Math.abs(Math.sin(rotY));
  const hw = (w / 2) * c + (d / 2) * s, hd = (w / 2) * s + (d / 2) * c;
  b.world.addBox(x - hw, h - 0.06, z - hd, x + hw, h, z + hd, { surface: 'wood' });
  return g;
}

// =============================================================
// BASEMENT
// =============================================================
function buildBasement(b, info) {
  const W = b.world;
  W.bounds = { minX: -14, maxX: 14, minZ: -10, maxZ: 10 };
  const H = 2.45, T = 0.2;
  const wallM = b.tmat('paint', 'paint', 0xffffff);
  const conc = b.tmat('concrete', 'concrete', 0xffffff);
  const carpet = b.tmat('carpet', 'carpet', 0xffffff);
  const woodM = b.tmat('wood', 'wood', 0xffffff);
  b.floor(-14, -10, 14, 10, conc, 0, 3);
  b.floor(-14, -0.5, -2, 10, carpet, 0.005, 1.5); // rec room carpet
  b.ceiling(-14, -10, 14, 10, b.mat('ceil', { color: 0x9a968c, map: TEX.concrete() }), H);
  // pipes & joists on ceiling
  const pipeM = b.mat('pipe', { color: 0x8a6a3a, metalness: 0.5, roughness: 0.5 });
  for (let x = -13; x <= 13; x += 2.2) b.box(x, H - 0.18, 0, 0.12, 0.18, 20, woodM, { collide: false, cast: false });
  b.vis(new THREE.CylinderGeometry(0.05, 0.05, 28, 8), pipeM, 0, H - 0.3, -1.75, { rot: [0, 0, Math.PI / 2], cast: false });
  b.vis(new THREE.CylinderGeometry(0.07, 0.07, 28, 8), b.mat('pipe2', { color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 }), 0, H - 0.35, -1.4, { rot: [0, 0, Math.PI / 2], cast: false });

  // outer walls
  b.wallX(-14.2, 14.2, -10.1, H, T, [], wallM, { surface: 'concrete' });
  b.wallX(-14.2, 14.2, 10.1, H, T, [], wallM, { surface: 'concrete' });
  b.wallZ(-10, 10, -14.1, H, T, [], wallM, { surface: 'concrete' });
  b.wallZ(-10, 10, 14.1, H, T, [], wallM, { surface: 'concrete' });
  // north rooms / hallway
  b.wallX(-14, 14, -3, H, T, [{ c: -11.5, w: 1.3 }, { c: -5, w: 1.0 }, { c: 3, w: 1.2 }, { c: 10.5, w: 1.1 }], wallM, { surface: 'concrete' });
  b.wallX(-14, 14, -0.5, H, T, [{ c: -10, w: 1.5 }, { c: -4, w: 1.0 }, { c: 2, w: 1.3 }, { c: 7.75, w: 0.9 }, { c: 12, w: 1.3 }], wallM, { surface: 'concrete' });
  b.wallZ(-10, -3, -9, H, T, [{ c: -6.5, w: 1.0 }], wallM);
  b.wallZ(-10, -3, -1, H, T, [{ c: -7, w: 1.0 }], wallM);
  b.wallZ(-10, -3, 7, H, T, [{ c: -5.2, w: 1.0 }], wallM);
  b.wallZ(-0.5, 10, -2, H, T, [{ c: 6, w: 1.2 }, { c: 2.4, w: 1.0 }], wallM);
  b.wallZ(-0.5, 10, 6, H, T, [{ c: 7.2, w: 1.1 }], wallM);
  b.wallZ(-0.5, 4, 9.5, H, T, [], wallM);
  b.wallX(6, 9.5, 4, H, T, [], wallM);

  // --- Stairwell (NW) ---
  for (let i = 0; i < 9; i++) b.box(-12.4, 0, -4.9 - i * 0.55, 2.2, 0.27 * (i + 1), 0.55, woodM, { surface: 'wood', collide: false });
  W.addBox(-13.5, 0, -9.9, -11.3, 2.4, -4.6, { surface: 'wood' }); // stairs volume (non-climbable)
  b.box(-9.6, 0, -4.0, 0.6, 1.0, 1.4, woodM, { surface: 'wood' }); // shoe bench
  b.box(-10.3, 0, -9.5, 1.2, 1.8, 0.5, b.mat('coat', { color: 0x4a3a30 }), { surface: 'fabric' }); // coat cupboard
  b.fluoro(-11, -7, H, 1.0, 0xfff0d0, 3.5, 7, 0.05);

  // --- Laundry ---
  const white = b.mat('appliance', { color: 0xe8e8e2, roughness: 0.4 });
  b.box(-8.3, 0, -9.5, 0.7, 0.9, 0.7, white, { surface: 'metal' });
  b.box(-7.5, 0, -9.5, 0.7, 0.9, 0.7, white, { surface: 'metal' });
  b.vis(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 20), b.mat('glass', { color: 0x223344, metalness: 0.8, roughness: 0.1 }), -8.3, 0.5, -9.14, { rot: [Math.PI / 2, 0, 0] });
  b.vis(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 20), b.mat('glass'), -7.5, 0.5, -9.14, { rot: [Math.PI / 2, 0, 0] });
  b.box(-2.0, 0, -9.4, 0.7, 1.6, 0.7, b.mat('heater', { color: 0xc8c0a8, roughness: 0.5 }), { surface: 'metal' }); // water heater
  table(b, -5, -6.8, 1.8, 0.8, 0.9, woodM);
  b.box(-5.6, 0.9, -6.9, 0.5, 0.3, 0.4, b.mat('basket', { color: 0x4a7ab8 }), { collide: false });
  b.box(-3.2, 0, -4.2, 1.2, 0.8, 0.5, b.mat('basket'), { surface: 'plastic' });
  b.box(-6.5, 0, -4.0, 0.6, 0.5, 0.6, b.mat('laundrypile', { color: 0x9a9aa8, map: TEX.fabric() }), { surface: 'fabric' });
  b.fluoro(-5, -6.5, H, 1.2, 0xf2f5ff, 4, 8, 0.12);

  // --- Workshop ---
  b.box(3, 0, -9.55, 4.5, 0.95, 0.8, woodM, { surface: 'wood' });
  shelf(b, 6.4, -8, 0.5, 1.9, 2.4, Math.PI / 2 * 0 + 0, true);
  b.box(0.0, 0, -9.6, 0.8, 2.0, 0.5, b.mat('pegboard', { color: 0x9a7a52 }), { surface: 'wood' });
  for (let i = 0; i < 4; i++) b.vis(new THREE.CylinderGeometry(0.34, 0.34, 0.22, 16), b.mat('tire', { color: 0x161616, roughness: 0.9 }), 0.0, 0.11 + i * 0.22, -4.0);
  W.addBox(-0.35, 0, -4.35, 0.35, 0.88, -3.65, { surface: 'rubber' });
  table(b, 3.2, -6.0, 2.0, 1.0, 0.85, woodM, 0.1);
  for (let i = 0; i < 3; i++) b.vis(new THREE.CylinderGeometry(0.13, 0.13, 0.25, 12), b.mat('paint' + i, { color: [0xc84a3a, 0x3a6ac8, 0xe8d24a][i] }), 5.3 + i * 0.3, 0.125, -3.7);
  b.box(1.0, 0, -6.2, 0.9, 0.6, 0.9, b.mat('sawhorse', { color: 0xb8903a }), { surface: 'wood' });
  b.fluoro(3, -6.5, H, 1.2, 0xf2f5ff, 4.5, 9, 0.02);

  // --- Furnace room (NE, spawn B) ---
  b.box(12.5, 0, -8.5, 2.2, 1.9, 1.8, b.mat('furnace', { color: 0x6a6e70, metalness: 0.5, roughness: 0.5 }), { surface: 'metal' });
  b.vis(new THREE.CylinderGeometry(0.15, 0.15, 0.7, 12), b.mat('pipe'), 12.5, 2.1, -8.5);
  b.box(8.4, 0, -9.3, 2.0, 1.2, 1.0, b.mat('oiltank', { color: 0x4a5a3a, metalness: 0.3 }), { surface: 'metal' });
  cardboard(b, 9.2, -5.6, 0.7); cardboard(b, 9.2, -5.6, 0.55, 0.56, 0.4); cardboard(b, 8.2, -4.0, 0.6);
  b.box(12.8, 0, -4.4, 1.8, 0.6, 0.8, b.mat('treadmill', { color: 0x222222 }), { surface: 'metal' });
  b.fluoro(10.5, -6.5, H, 1.0, 0xffd8a0, 3, 7, 0.25);

  // --- Hallway ---
  cardboard(b, -7.5, -1.2, 0.8); cardboard(b, -7.5, -1.2, 0.6, 0.64, 0.3);
  b.box(0.5, 0, -2.6, 0.6, 0.85, 0.55, b.mat('fridge', { color: 0xdedede, roughness: 0.4 }), { surface: 'metal' });
  b.box(6.0, 0, -1.0, 1.4, 1.0, 0.5, woodM, { surface: 'wood' });
  b.box(-13.3, 0, -1.7, 0.8, 0.5, 1.6, b.mat('shoes', { color: 0x5a4030 }), { surface: 'wood' });
  b.fluoro(-8, -1.75, H, 1.0, 0xf2f5ff, 2.6, 7, 0.08);
  b.fluoro(4, -1.75, H, 1.0, 0xf2f5ff, 2.6, 7, 0.3);
  b.fluoro(11, -1.75, H, 1.0, 0xf2f5ff, 2.2, 6, 0.05);

  // --- Rec room (SW) ---
  couch(b, -9.5, 5.5, 3.0, 0, 0x5a6a7a);
  couch(b, -12.6, 3.0, 2.2, -Math.PI / 2, 0x5a6a7a);
  b.box(-9.5, 0, 3.8, 1.4, 0.45, 0.7, woodM, { surface: 'wood' }); // coffee table
  b.box(-9.5, 0, 0.0, 2.2, 0.6, 0.5, woodM, { surface: 'wood' }); // tv stand
  const tv = b.box(-9.5, 0.6, 0.0, 1.6, 0.9, 0.08, b.mat('tv', { color: 0x050505, roughness: 0.2 }), { surface: 'plastic' });
  const tvGlow = new THREE.PointLight(0x6080ff, 1.2, 4, 2); tvGlow.position.set(-9.5, 1.0, 0.6); b.group.add(tvGlow);
  b.updaters.push((dt, t) => { tvGlow.intensity = 0.8 + Math.sin(t * 13) * 0.25 + Math.sin(t * 3.1) * 0.3; tvGlow.color.setHSL(0.6 + Math.sin(t * 0.7) * 0.08, 0.6, 0.5); });
  // ping pong table (crouch cover, solid)
  b.box(-5.0, 0, 6.0, 1.5, 0.76, 2.7, b.mat('pingpong', { color: 0x1d4a2a, roughness: 0.6 }), { surface: 'wood' });
  b.box(-5.0, 0.76, 6.0, 1.6, 0.15, 0.02, b.mat('net', { color: 0xeeeeee }), { collide: false });
  b.box(-3.0, 0, 9.4, 0.7, 1.8, 0.7, b.mat('arcade', { color: 0x3a1a6a }), { surface: 'wood' });
  b.box(-13.6, 0, 8.0, 0.5, 1.9, 2.0, woodM, { surface: 'wood' }); // bookshelf
  b.box(-6.5, 0, 9.2, 0.9, 0.5, 0.9, b.mat('beanbag', { color: 0xc84a2a, map: TEX.fabric() }), { surface: 'fabric' });
  b.box(-11.5, 0, 9.3, 0.9, 0.5, 0.9, b.mat('beanbag2', { color: 0x2a8ac8, map: TEX.fabric() }), { surface: 'fabric' });
  b.fluoro(-10, 3, H, 1.2, 0xfff0d8, 3.2, 9, 0.0);
  b.fluoro(-5, 7, H, 1.2, 0xfff0d8, 3.2, 9, 0.04);

  // --- Storage (shelves maze) ---
  shelf(b, -0.6, 2.2, 2.0, 2.0, 0.5, 0); shelf(b, 3.6, 2.2, 2.4, 2.0, 0.5, 0);
  shelf(b, 0.5, 5.0, 2.6, 2.0, 0.5, 0); shelf(b, 4.8, 5.8, 0.5, 2.0, 2.2, 0);
  shelf(b, -0.8, 8.3, 2.0, 1.6, 0.5, 0); shelf(b, 2.8, 8.6, 2.0, 1.6, 0.5, 0);
  cardboard(b, 1.6, 6.8, 0.6); cardboard(b, -1.3, 3.6, 0.5); cardboard(b, 3.0, 3.6, 0.7); cardboard(b, 3.0, 3.6, 0.5, 0.56, 0.5);
  b.box(5.2, 0, 9.3, 1.1, 1.2, 0.6, b.mat('xmas', { color: 0x2a6a2a }), { surface: 'cardboard' });
  b.fluoro(2, 4, H, 1.2, 0xf2f5ff, 3.5, 8, 0.15);

  // --- Bathroom ---
  b.box(8.9, 0, 0.2, 0.5, 0.45, 0.7, white, { surface: 'ceramic' });
  b.box(6.5, 0, 3.4, 0.6, 0.85, 0.5, white, { surface: 'ceramic' });
  b.fluoro(7.75, 1.8, H, 0.6, 0xfff8e8, 1.6, 4, 0.1);

  // --- Guest room / bar (SE) ---
  b.box(11.0, 0, 3.5, 3.0, 1.1, 0.6, woodM, { surface: 'wood' }); // bar counter
  b.box(13.6, 0, 3.0, 0.5, 1.9, 2.6, b.mat('barshelf', { color: 0x3a2a1a }), { surface: 'wood' });
  b.box(11.5, 0, 7.6, 2.2, 0.8, 1.2, b.mat('pool', { color: 0x1a5a3a }), { surface: 'wood' }); // pool table
  couch(b, 8.0, 9.2, 2.4, 0, 0x7a4a3a);
  b.sign('DART\nBOARD', 14.0, 1.6, 6.0, 0.6, 0.6, -Math.PI / 2, '#fff', '#222', 'bold 90px sans-serif');
  b.fluoro(11.5, 5, H, 1.0, 0xffe0b0, 3.2, 8, 0.05);
  b.fluoro(8.5, 7.5, H, 0.8, 0xffe0b0, 2, 6, 0.0);

  // a sign on the wall
  b.sign('NO NERF\nIN THE\nLAUNDRY!', -6.5, 1.5, -9.98, 0.8, 0.6, 0, '#a01010', '#f4eedc', 'bold 70px sans-serif');
  b.sign('BASEMENT\nRULES:\n1. HAVE FUN\n2. NO HEADSHOTS', -1.2, 1.5, -2.88, 0.8, 0.8, 0, '#222', '#f4eedc', 'bold 50px sans-serif');

  W.zones = [
    { name: 'Stairs', minX: -14, maxX: -9, minZ: -10, maxZ: -3 },
    { name: 'Laundry', minX: -9, maxX: -1, minZ: -10, maxZ: -3 },
    { name: 'Workshop', minX: -1, maxX: 7, minZ: -10, maxZ: -3 },
    { name: 'Furnace room', minX: 7, maxX: 14, minZ: -10, maxZ: -3 },
    { name: 'Hallway', minX: -14, maxX: 14, minZ: -3, maxZ: -0.5 },
    { name: 'Rec room', minX: -14, maxX: -2, minZ: -0.5, maxZ: 10 },
    { name: 'Storage', minX: -2, maxX: 6, minZ: -0.5, maxZ: 10 },
    { name: 'Bathroom', minX: 6, maxX: 9.5, minZ: -0.5, maxZ: 4 },
    { name: 'Bar', minX: 6, maxX: 14, minZ: -0.5, maxZ: 10 },
  ];
  W.surfaceFn = (x, z) => (x < -2 && z > -0.5) ? 'carpet' : 'concrete';
  info.indoor = true; info.ambient = 'basement';
  info.spawns = [
    [V(-12.5, 0, -2.0), V(-11.5, 0, -1.2), V(-12.0, 0, 1.5), V(-11.0, 0, 2.6), V(-10.5, 0, -1.8)],
    [V(12.5, 0, -2.0), V(11.5, 0, -1.2), V(12.0, 0, -5.0), V(11.0, 0, -6.0), V(10.5, 0, -1.8)],
  ];
  info.searchPoints = W.zones.map(z => V((z.minX + z.maxX) / 2, 0, (z.minZ + z.maxZ) / 2));
  info.defensePoints = [V(-5, 0, 7.6), V(-9.5, 0, 4.6), V(2.5, 0, 7), V(11, 0, 4.4), V(3, 0, -7), V(-7.6, 0, -8.6), V(12.5, 0, -6.8)];
  info.huntStart = V(-12.3, 0, -8.2); // stairwell top as hunter start
  info.extraction = V(-12.4, 0, -5.6);
  info.lightLevel = 0.55;
  return info;
}

// =============================================================
// FOREST (+ Jürgen variant)
// =============================================================
function buildForest(b, info, jurgen) {
  const W = b.world;
  const S = 58;
  W.bounds = { minX: -S, maxX: S, minZ: -S, maxZ: S };
  W.hilly = true;
  const n1 = makeNoise(jurgen ? 77 : 42), n2 = makeNoise(jurgen ? 13 : 7);
  const jb = jurgen ? { x: 26, z: -20, r: 13 } : null;
  // trails (polylines)
  const trails = jurgen
    ? [[[0, 56], [2, 30], [-6, 10], [0, -10], [12, -18], [26, -20]], [[-50, 20], [-20, 12], [-6, 10], [20, 6], [50, 14]], [[0, -10], [-10, -32], [0, -56]]]
    : [[[0, 56], [4, 34], [-4, 16], [0, 0], [10, -20], [0, -56]], [[-56, -10], [-30, -8], [-12, -2], [0, 0], [18, 12], [40, 22], [56, 18]], [[-25, -10], [-30, 20], [-15, 30]]];
  const distToSeg = (px, pz, ax, az, bx, bz) => {
    const dx = bx - ax, dz = bz - az; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(px - ax - dx * t, pz - az - dz * t);
  };
  const trailDist = (x, z) => { let m = 1e9; for (const tr of trails) for (let i = 0; i < tr.length - 1; i++) m = Math.min(m, distToSeg(x, z, tr[i][0], tr[i][1], tr[i + 1][0], tr[i + 1][1])); return m; };
  const groundFn = (x, z) => {
    let h = (n1(x * 0.035 + 10, z * 0.035 + 10) - 0.5) * 7 + (n2(x * 0.11, z * 0.11) - 0.5) * 1.2;
    // flatten around jurgen base & spawns
    const flat = (cx, cz, r, k = 1) => { const d = Math.hypot(x - cx, z - cz); if (d < r) { const f = Math.min(1, (r - d) / (r * 0.4)) * k; h = h * (1 - f); } };
    flat(0, 52, 9); flat(0, 0, 8);
    if (jb) flat(jb.x, jb.z, jb.r + 6); else { flat(-25, -10, 8); flat(15, 20, 6); }
    return h;
  };
  W.groundFn = groundFn;
  W.surfaceFn = (x, z) => trailDist(x, z) < 1.4 ? 'dirt' : (jb && Math.hypot(x - jb.x, z - jb.z) < jb.r - 1 ? 'gravel' : 'leaves');

  // terrain mesh
  const seg = 116;
  const tg = new THREE.PlaneGeometry(S * 2, S * 2, seg, seg);
  tg.rotateX(-Math.PI / 2);
  const pos = tg.attributes.position;
  const cols = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, groundFn(x, z));
    const td = trailDist(x, z);
    const tcol = td < 1.6 ? 0.75 + td * 0.1 : 1;
    const v = 0.85 + n2(x * 0.3, z * 0.3) * 0.3;
    cols[i * 3] = v * tcol * (td < 1.6 ? 1.1 : 1); cols[i * 3 + 1] = v * tcol * (td < 1.6 ? 0.95 : 1.05); cols[i * 3 + 2] = v * tcol * 0.95;
  }
  tg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  tg.computeVertexNormals();
  const uv = tg.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * S / 2.5, uv.getY(i) * S / 2.5);
  const terrain = new THREE.Mesh(tg, b.mat('forestfloor', { map: TEX.forest(), vertexColors: true, roughness: 1 }));
  terrain.receiveShadow = true; b.group.add(terrain);

  const rng = b.rng;
  const clear = (x, z) => {
    if (trailDist(x, z) < 2.2) return false;
    if (Math.hypot(x, z - 52) < 9 || Math.hypot(x, z) < 6) return false;
    if (jb && Math.hypot(x - jb.x, z - jb.z) < jb.r + 2) return false;
    for (const p of info._reserved || []) if (Math.hypot(x - p[0], z - p[1]) < p[2]) return false;
    return true;
  };
  info._reserved = [[15, 20, 5], [-25, -10, 6], [30, -28, 6], [-15, 30, 5], [-40, 35, 5], [40, 40, 4]];
  if (jurgen) info._reserved = [[-20, -25, 5], [-25, 20, 6], [-38, -5, 5], [15, 30, 5], [40, 40, 4]];

  // trees (instanced)
  const trunkG = new THREE.CylinderGeometry(0.18, 0.28, 1, 7); trunkG.translate(0, 0.5, 0);
  const pineG = new THREE.ConeGeometry(1.6, 1, 8); pineG.translate(0, 0.5, 0);
  const leafG = new THREE.IcosahedronGeometry(1, 1);
  const trees = [];
  for (let i = 0; i < 2600 && trees.length < 330; i++) {
    const x = (rng() * 2 - 1) * (S - 1), z = (rng() * 2 - 1) * (S - 1);
    if (!clear(x, z)) continue;
    let ok = true; for (const t of trees) if (Math.abs(t.x - x) < 2.6 && Math.abs(t.z - z) < 2.6) { ok = false; break; }
    if (!ok) continue;
    trees.push({ x, z, h: 7 + rng() * 7, pine: rng() < 0.55, r: 0.7 + rng() * 0.6 });
  }
  const trunkM = new THREE.InstancedMesh(trunkG, b.mat('bark', { map: TEX.bark(), color: 0xffffff }), trees.length);
  const pines = trees.filter(t => t.pine), leafs = trees.filter(t => !t.pine);
  const pineM = new THREE.InstancedMesh(pineG, b.mat('pine', { color: jurgen ? 0x7a9a80 : 0x90b088, map: TEX.leaves(), roughness: 1 }), pines.length * 3);
  const leafM = new THREE.InstancedMesh(leafG, b.mat('leafy', { color: jurgen ? 0x9aa880 : 0xb8d090, map: TEX.leaves(), roughness: 1, flatShading: true }), leafs.length * 2);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  let pi = 0, li = 0;
  trees.forEach((t, i) => {
    const g = groundFn(t.x, t.z);
    const tw = t.r;
    m4.compose(p.set(t.x, g - 0.3, t.z), q.identity(), sc.set(tw, t.pine ? t.h * 0.75 : t.h * 0.6, tw)); trunkM.setMatrixAt(i, m4);
    W.addBox(t.x - 0.22 * tw, g - 1, t.z - 0.22 * tw, t.x + 0.22 * tw, g + t.h, t.z + 0.22 * tw, { surface: 'bark', tag: 'tree' });
    if (t.pine) {
      for (let k = 0; k < 3; k++) {
        const s = (1.25 - k * 0.3) * (0.8 + tw * 0.4);
        q.setFromAxisAngle(p.set(0, 1, 0), rng() * 6);
        m4.compose(p.set(t.x, g + t.h * 0.3 + k * t.h * 0.22, t.z), q, sc.set(s, t.h * 0.38, s)); pineM.setMatrixAt(pi++, m4);
      }
    } else {
      for (let k = 0; k < 2; k++) {
        const s = 2.0 + rng() * 1.4;
        q.setFromEuler(new THREE.Euler(rng(), rng() * 6, rng()));
        m4.compose(p.set(t.x + (rng() - 0.5) * 1.2, g + t.h * 0.62 + k * 1.3, t.z + (rng() - 0.5) * 1.2), q, sc.set(s, s * 0.8, s)); leafM.setMatrixAt(li++, m4);
      }
      if (t.h > 0 && rng() < 0.5) W.addBox(t.x - 2.2, g + 2.4, t.z - 2.2, t.x + 2.2, g + t.h, t.z + 2.2, { solid: false, sight: true, shot: false, tag: 'canopy' });
    }
  });
  trunkM.castShadow = pineM.castShadow = leafM.castShadow = true;
  trunkM.receiveShadow = pineM.receiveShadow = leafM.receiveShadow = true;
  b.group.add(trunkM, pineM, leafM);

  // bushes
  const bushG = new THREE.IcosahedronGeometry(1, 1);
  const bushes = [];
  for (let i = 0; i < 1600 && bushes.length < 190; i++) {
    const x = (rng() * 2 - 1) * (S - 1), z = (rng() * 2 - 1) * (S - 1);
    if (trailDist(x, z) < 1.8 || Math.hypot(x, z - 52) < 8) continue;
    if (jb && Math.hypot(x - jb.x, z - jb.z) < jb.r + 1) continue;
    bushes.push({ x, z, s: 0.8 + rng() * 0.9 });
  }
  const bushM = new THREE.InstancedMesh(bushG, b.mat('bush', { color: jurgen ? 0x8a9a80 : 0xa0c090, map: TEX.leaves(), roughness: 1, flatShading: true }), bushes.length);
  bushes.forEach((bu, i) => {
    const g = groundFn(bu.x, bu.z);
    q.setFromEuler(new THREE.Euler(0, rng() * 6, 0));
    m4.compose(p.set(bu.x, g + bu.s * 0.45, bu.z), q, sc.set(bu.s * 1.2, bu.s * 0.8, bu.s * 1.1)); bushM.setMatrixAt(i, m4);
    W.addBox(bu.x - bu.s, g, bu.z - bu.s, bu.x + bu.s, g + bu.s * 1.25, bu.z + bu.s, { solid: false, sight: true, shot: true, tag: 'bush', surface: 'leaves' });
  });
  bushM.castShadow = true; bushM.receiveShadow = true; b.group.add(bushM);

  // grass tufts
  const tuftG = new THREE.PlaneGeometry(0.7, 0.5); tuftG.translate(0, 0.25, 0);
  const tuftM = new THREE.InstancedMesh(tuftG, b.mat('tuft', { map: TEX.blades(), color: jurgen ? 0x8a9a7a : 0xb0c890, side: THREE.DoubleSide, roughness: 1, alphaTest: 0.4 }), 3000);
  for (let i = 0; i < 3000; i++) {
    const x = (rng() * 2 - 1) * S, z = (rng() * 2 - 1) * S;
    q.setFromEuler(new THREE.Euler(0, rng() * 6, 0));
    m4.compose(p.set(x, groundFn(x, z), z), q, sc.set(1 + rng(), 0.6 + rng(), 1)); tuftM.setMatrixAt(i, m4);
  }
  b.group.add(tuftM);

  // rocks & logs
  const rockM = b.mat('rock', { color: 0x7a7870, map: TEX.stone(), roughness: 0.95, flatShading: true });
  const rockG = new THREE.DodecahedronGeometry(1, 0);
  const placeRock = (x, z, s) => {
    const g = groundFn(x, z);
    const m = b.vis(rockG, rockM, x, g + s * 0.3, z, { rot: [rng(), rng() * 6, rng()] });
    m.scale.set(s * 1.2, s * 0.8, s);
    W.addBox(x - s * 0.95, g - 0.5, z - s * 0.8, x + s * 0.95, g + s * 0.95, z + s * 0.8, { surface: 'stone' });
  };
  const logM = b.mat('log', { map: TEX.bark(), color: 0xc8b8a0 });
  const placeLog = (x, z, len, rot) => {
    const g = groundFn(x, z);
    b.vis(new THREE.CylinderGeometry(0.32, 0.36, len, 9), logM, x, g + 0.3, z, { rot: [0, rot, Math.PI / 2] });
    const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
    const hw = len / 2 * c + 0.35 * s, hd = len / 2 * s + 0.35 * c;
    W.addBox(x - hw, g - 0.3, z - hd, x + hw, g + 0.66, z + hd, { surface: 'bark' });
  };
  for (let i = 0; i < 40; i++) { const x = (rng() * 2 - 1) * (S - 3), z = (rng() * 2 - 1) * (S - 3); if (clear(x, z)) placeRock(x, z, 0.5 + rng() * 1.1); }
  for (let i = 0; i < 26; i++) { const x = (rng() * 2 - 1) * (S - 4), z = (rng() * 2 - 1) * (S - 4); if (clear(x, z)) placeLog(x, z, 3 + rng() * 4, rng() * 3); }

  const woodM = b.tmat('wood', 'wood', 0xd8c8b0);
  const oldWood = b.tmat('oldwood', 'wood', 0x9a8a78);

  if (!jurgen) {
    // Hunting stand (climbable via steps)
    const hx = 15, hz = 20, hg = groundFn(hx, hz);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(hx + dx * 1.1, hg - 0.5, hz + dz * 1.1, 0.18, 3.2, 0.18, oldWood, { surface: 'wood' });
    b.box(hx, hg + 2.4, hz, 2.6, 0.12, 2.6, woodM, { surface: 'wood' });
    b.box(hx, hg + 2.52, hz - 1.25, 2.6, 0.8, 0.08, oldWood, { surface: 'wood' });
    b.box(hx - 1.25, hg + 2.52, hz, 0.08, 0.8, 2.6, oldWood, { surface: 'wood' });
    b.box(hx + 1.25, hg + 2.52, hz, 0.08, 0.8, 2.6, oldWood, { surface: 'wood' });
    for (let i = 0; i < 7; i++) b.box(hx, hg + i * 0.36 - 0.1, hz + 1.6 + (6 - i) * 0.35, 1.0, 0.12, 0.35, oldWood, { surface: 'wood' });
    // Old shack
    const sx = -25, sz = -10, sg = groundFn(sx, sz);
    const shackOpts = { surface: 'wood' };
    const wallH = 2.4;
    const bx0 = sx - 3, bx1 = sx + 3, bz0 = sz - 2.5, bz1 = sz + 2.5;
    b.atY(sg, () => {
      b.wallX(bx0, bx1, bz0, wallH, 0.15, [{ c: sx + 1, w: 1.0, top: 1.6, sill: 0.9 }], oldWood, shackOpts);
      b.wallX(bx0, bx1, bz1, wallH, 0.15, [{ c: sx - 1, w: 1.3 }], oldWood, shackOpts);
      b.wallZ(bz0, bz1, bx0, wallH, 0.15, [{ c: sz, w: 0.9, top: 1.6, sill: 0.9 }], oldWood, shackOpts);
      b.wallZ(bz0, bz1, bx1, wallH, 0.15, [], oldWood, shackOpts);
      b.box(sx + 2, 0, sz - 1.6, 1.4, 0.8, 0.8, woodM, shackOpts);
      b.box(sx - 2.2, 0, sz - 1.8, 0.6, 0.6, 0.6, b.mat('barrel', { color: 0x5a3a2a }), shackOpts);
    });
    const roof = b.vis(b.boxGeo(6.6, 0.1, 5.8, 0), b.mat('roof', { color: 0x4a4038 }), sx, sg + wallH + 0.2, sz, { rot: [0.12, 0, 0] });
    // rock outcrop
    placeRock(30, -28, 2.2); placeRock(32.5, -26, 1.6); placeRock(28, -25.5, 1.3); placeRock(31, -30.5, 1.4);
    // fallen tree barricade
    placeLog(-15, 30, 8, 0.3); placeLog(-14, 31.5, 6, 0.5);
    // abandoned tent
    const tg2 = new THREE.ConeGeometry(1.6, 1.5, 4); const tent = b.vis(tg2, b.mat('tent', { color: 0x4a6a8a, roughness: 0.9 }), -40, groundFn(-40, 35) + 0.75, 35, { rot: [0, Math.PI / 4, 0] });
    W.addBox(-41.1, groundFn(-40, 35), 33.9, -38.9, groundFn(-40, 35) + 1.3, 36.1, { surface: 'fabric' });
    info.defensePoints = [V(hx, hg + 2.5, hz), V(sx, sg, sz), V(29, 0, -24), V(-15, 0, 32), V(-40, 0, 37), V(40, 0, 40)].map(v => { v.y = groundFn(v.x, v.z); return v; });
    W.zones = [
      { name: 'the hunting stand', circle: true, x: hx, z: hz, r: 7 },
      { name: 'the old shack', circle: true, x: sx, z: sz, r: 8 },
      { name: 'the rocks', circle: true, x: 30, z: -27, r: 8 },
      { name: 'the fallen tree', circle: true, x: -15, z: 30, r: 7 },
      { name: 'the tent', circle: true, x: -40, z: 35, r: 7 },
      { name: 'the trailhead', circle: true, x: 0, z: 52, r: 10 },
      { name: 'the clearing', circle: true, x: 0, z: 0, r: 9 },
      { name: 'the north woods', minX: -58, maxX: 58, minZ: -58, maxZ: -25 },
      { name: 'the east woods', minX: 0, maxX: 58, minZ: -25, maxZ: 58 },
      { name: 'the west woods', minX: -58, maxX: 0, minZ: -25, maxZ: 58 },
    ];
  } else {
    // ---------- Jürgen's compound ----------
    const { x: cx, z: cz, r } = jb;
    const g0 = groundFn(cx, cz);
    const stake = b.mat('stake', { map: TEX.bark(), color: 0xb0a080 });
    const stakeG = new THREE.CylinderGeometry(0.11, 0.13, 2.4, 6);
    const nSt = 70;
    for (let i = 0; i < nSt; i++) {
      const a = i / nSt * Math.PI * 2;
      // gates at west (a≈π) and north (a≈-π/2)
      const ad = (x) => Math.abs(Math.atan2(Math.sin(a - x), Math.cos(a - x)));
      if (ad(Math.PI) < 0.09 || ad(-Math.PI / 2) < 0.09) continue;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const gg = groundFn(x, z);
      b.vis(stakeG, stake, x, gg + 1.1 + (i % 3) * 0.08, z);
      W.addBox(x - 0.62, gg - 0.5, z - 0.62, x + 0.62, gg + 2.3, z + 0.62, { surface: 'bark', sight: (i % 4 !== 0), tag: 'palisade' });
    }
    // hut
    const hx = cx + 4, hz = cz - 3;
    const hutWood = b.tmat('hutwood', 'wood', 0x8a7058);
    b.atY(g0, () => {
      b.wallX(hx - 2.5, hx + 2.5, hz - 2, 2.3, 0.15, [], hutWood, { surface: 'wood' });
      b.wallX(hx - 2.5, hx + 2.5, hz + 2, 2.3, 0.15, [{ c: hx - 1, w: 1.0 }], hutWood, { surface: 'wood' });
      b.wallZ(hz - 2, hz + 2, hx - 2.5, 2.3, 0.15, [{ c: hz, w: 0.9, top: 1.6, sill: 1.0 }], hutWood, { surface: 'wood' });
      b.wallZ(hz - 2, hz + 2, hx + 2.5, 2.3, 0.15, [], hutWood, { surface: 'wood' });
      b.box(hx + 1.6, 0, hz - 1.2, 1.2, 0.5, 1.6, b.mat('cot', { color: 0x5a4a3a, map: TEX.fabric() }), { surface: 'fabric' });
    });
    b.vis(new THREE.ConeGeometry(3.8, 1.6, 4), b.mat('thatch', { color: 0x6a5a3a, roughness: 1, flatShading: true }), hx, g0 + 3.1, hz, { rot: [0, Math.PI / 4, 0] });
    // campfire
    const fx = cx - 2, fz = cz + 2;
    for (let i = 0; i < 8; i++) { const a = i / 8 * 6.28; b.vis(rockG, rockM, fx + Math.cos(a) * 0.7, g0 + 0.1, fz + Math.sin(a) * 0.7).scale.setScalar(0.22); }
    const flame = b.vis(new THREE.ConeGeometry(0.35, 0.9, 7), new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.85 }), fx, g0 + 0.45, fz, { cast: false });
    const fireL = new THREE.PointLight(0xff8a3a, 6, 14, 1.5); fireL.position.set(fx, g0 + 1, fz); b.group.add(fireL);
    b.updaters.push((dt, t) => { fireL.intensity = 5 + Math.sin(t * 17) * 1 + Math.sin(t * 7.3) * 1.2; flame.scale.y = 0.9 + Math.sin(t * 14) * 0.15; flame.rotation.y += dt * 3; });
    // log seats, katana rack, laundry line, lantern
    placeLog(fx - 1.8, fz, 1.6, 0); placeLog(fx, fz + 1.8, 1.6, Math.PI / 2);
    b.box(cx - 6, g0, cz - 5, 1.6, 1.2, 0.6, hutWood, { surface: 'wood' });
    b.box(cx + 7, g0, cz + 5, 1.2, 1.0, 1.2, b.mat('firewood', { map: TEX.bark(), color: 0xaa9070 }), { surface: 'bark' });
    // warning signs
    for (const [sx, sz2, rot] of [[cx - r - 1.5, cz + 2, -Math.PI / 2], [cx + 2, cz - r - 1.5, Math.PI], [cx - 10, cz + 12, -Math.PI * 0.75]]) {
      const gg = groundFn(sx, sz2);
      b.vis(b.boxGeo(0.08, 1.4, 0.08, 0), hutWood, sx, gg + 0.7, sz2);
      const s = b.sign('PRIVATGRUNDSTÜCK\nBETRETEN VERBOTEN!\n- JÜRGEN', sx, gg + 1.45, sz2, 1.2, 0.6, rot, '#7a0a0a', '#e8dcc0', 'bold 46px serif');
    }
    // lantern light
    const lan = new THREE.PointLight(0xffc070, 2.5, 9, 1.5); lan.position.set(hx - 1, g0 + 2.2, hz + 2.3); b.group.add(lan);
    info.jurgenBase = { x: cx, z: cz, r: r + 0.5, y: g0, hut: V(hx, g0, hz), fire: V(fx, g0, fz) };
    // other POIs
    placeRock(-20, -25, 2.0); placeRock(-22, -23, 1.4); placeRock(-18, -27, 1.3);
    placeLog(-25, 20, 7, 0.4); placeLog(-24, 22, 5, 0.9);
    placeRock(-38, -5, 1.8); placeRock(-36, -3, 1.2);
    placeLog(15, 30, 7, 1.2);
    info.defensePoints = [V(-20, 0, -23), V(-25, 0, 22), V(-37, 0, -3), V(15, 0, 32), V(40, 0, 40), V(-10, 0, 40)].map(v => { v.y = groundFn(v.x, v.z); return v; });
    W.zones = [
      { name: 'JÜRGEN\'S BASE', circle: true, x: cx, z: cz, r: r + 1 },
      { name: 'the boulders', circle: true, x: -20, z: -25, r: 8 },
      { name: 'the log pile', circle: true, x: -25, z: 21, r: 7 },
      { name: 'the trailhead', circle: true, x: 0, z: 52, r: 10 },
      { name: 'the crossing', circle: true, x: -6, z: 10, r: 8 },
      { name: 'the north woods', minX: -58, maxX: 58, minZ: -58, maxZ: -25 },
      { name: 'the east woods', minX: 0, maxX: 58, minZ: -25, maxZ: 58 },
      { name: 'the west woods', minX: -58, maxX: 0, minZ: -25, maxZ: 58 },
    ];
  }
  // trailhead: parked car + sign (hunters start)
  const tgc = groundFn(0, 54);
  b.box(4, tgc, 54, 1.9, 1.4, 4.4, b.mat('car', { color: 0x2a3a5a, metalness: 0.5, roughness: 0.4 }), { surface: 'metal' });
  b.box(4, tgc + 1.4, 54.3, 1.7, 0.6, 2.4, b.mat('carglass', { color: 0x1a2028, metalness: 0.8, roughness: 0.1 }), { surface: 'metal' });
  b.sign('TRAILHEAD\nWALDWEG 3', -3, tgc + 1.6, 51, 1.4, 0.7, 0, '#fff', '#3a5a2a', 'bold 60px sans-serif');
  b.vis(b.boxGeo(0.1, 1.6, 0.1, 0), woodM, -3, tgc + 0.8, 51.05);

  const gy = (x, z) => groundFn(x, z);
  info.ambient = jurgen ? 'forestmist' : 'forest';
  info.spawns = [
    [V(-3, 0, 50), V(-1, 0, 49), V(1, 0, 50), V(3, 0, 49), V(0, 0, 47)],
    [V(-3, 0, -50), V(-1, 0, -49), V(1, 0, -50), V(3, 0, -49), V(0, 0, -47)],
  ].map(arr => arr.map(v => { v.y = gy(v.x, v.z); return v; }));
  info.huntStart = V(0, gy(0, 52), 52);
  info.hideStart = V(0, gy(0, 0), 0);
  info.extraction = V(0, gy(0, -54), -54);
  info.searchPoints = [...info.defensePoints, V(0, 0, 0), V(-30, 0, -40), V(30, 0, 0), V(-40, 0, 10), V(20, 0, -45), V(45, 0, -10), V(-10, 0, -15)].map(v => { v.y = gy(v.x, v.z); return v; });
  info.lightLevel = jurgen ? 0.6 : 0.85;
  info.trailDist = trailDist;
  return info;
}

// =============================================================
// SOCCER FIELD
// =============================================================
function buildSoccer(b, info) {
  const W = b.world;
  W.bounds = { minX: -42, maxX: 42, minZ: -28, maxZ: 28 };
  const grass = b.tmat('pitch', 'grass', 0xffffff);
  b.floor(-42, -28, 42, 28, grass, 0, 3);
  // stripes + lines
  for (let i = -6; i < 6; i++) if (i % 2 === 0) b.floor(i * 6, -21, i * 6 + 6, 21, b.mat('stripe', { color: 0x7aa060, map: TEX.grass(), transparent: true, opacity: 0.35 }), 0.004, 3);
  const lineM = b.mat('line', { color: 0xf4f4f0, roughness: 1 });
  const line = (x0, z0, x1, z1) => b.floor(Math.min(x0, x1) - 0.06, Math.min(z0, z1) - 0.06, Math.max(x0, x1) + 0.06, Math.max(z0, z1) + 0.06, lineM, 0.008, 1);
  line(-34, -21, 34, -21); line(-34, 21, 34, 21); line(-34, -21, -34, 21); line(34, -21, 34, 21); line(0, -21, 0, 21);
  line(-34, -10, -24, -10); line(-34, 10, -24, 10); line(-24, -10, -24, 10);
  line(34, -10, 24, -10); line(34, 10, 24, 10); line(24, -10, 24, 10);
  const ring = new THREE.Mesh(new THREE.RingGeometry(6.8, 6.95, 64), lineM); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.009; b.group.add(ring);
  // running track
  const track = b.mat('track', { color: 0xa04a3a, map: TEX.dirt(), roughness: 1 });
  b.floor(-42, -28, 42, -24, track, 0.003, 2); b.floor(-42, 24, 42, 28, track, 0.003, 2);
  // goals
  const postM = b.mat('post', { color: 0xffffff, metalness: 0.3, roughness: 0.4 });
  const netM = b.mat('netm', { color: 0xdddddd, transparent: true, opacity: 0.35, side: THREE.DoubleSide, wireframe: true });
  for (const sgn of [-1, 1]) {
    const gx = sgn * 34;
    b.box(gx, 0, -3.66, 0.12, 2.44, 0.12, postM, { surface: 'metal' });
    b.box(gx, 0, 3.66, 0.12, 2.44, 0.12, postM, { surface: 'metal' });
    b.box(gx, 2.38, 0, 0.12, 0.12, 7.4, postM, { surface: 'metal', collide: false });
    const net = b.vis(new THREE.BoxGeometry(2, 2.44, 7.32, 6, 6, 12), netM, gx + sgn * 1.0, 1.22, 0, { cast: false });
    W.addBox(gx + sgn * 2.0 - 0.05, 0, -3.7, gx + sgn * 2.0 + 0.05, 2.44, 3.7, { sight: false, surface: 'net' });
    W.addBox(Math.min(gx, gx + sgn * 2), 0, -3.75, Math.max(gx, gx + sgn * 2), 2.44, -3.65, { sight: false, surface: 'net' });
    W.addBox(Math.min(gx, gx + sgn * 2), 0, 3.65, Math.max(gx, gx + sgn * 2), 2.44, 3.75, { sight: false, surface: 'net' });
  }
  // benches/dugouts (cover)
  const benchM = b.mat('dugout', { color: 0x3a5a8a, roughness: 0.5 });
  for (const sgn of [-1, 1]) {
    const bx = sgn * 8;
    b.box(bx, 0, 24.6, 6, 2.0, 0.15, b.mat('plexi', { color: 0x9ab0c0, transparent: true, opacity: 0.5 }), { surface: 'plastic', sight: false });
    b.box(bx, 0, 25.6, 6, 0.45, 0.6, benchM, { surface: 'plastic' });
    b.box(bx - 3, 0, 25.1, 0.15, 2.0, 1.2, benchM, { surface: 'plastic' });
    b.box(bx + 3, 0, 25.1, 0.15, 2.0, 1.2, benchM, { surface: 'plastic' });
  }
  // bleachers (stepped, climbable)
  const bleachM = b.mat('bleach', { color: 0x8a8e94, metalness: 0.5, roughness: 0.5 });
  for (let i = 0; i < 5; i++) b.box(0, 0, -24.6 - i * 0.7, 20, 0.4 + i * 0.4, 0.7, bleachM, { surface: 'metal' });
  // equipment & cover pieces
  const wallM = b.mat('fkwall', { color: 0xe8d020, roughness: 0.6 });
  const fk = [[-16, -6, 0.2], [-14, 9, -0.3], [16, 6, 0.2], [14, -9, -0.3], [-4, 14, 1.5], [4, -14, 1.5], [0, 0, 1.57]];
  for (const [x, z, r] of fk) b.box(x, 0, z, 2.2, 1.75, 0.25, wallM, { rotY: r, surface: 'plastic' });
  b.box(-22, 0, 17, 1.2, 0.9, 0.8, b.mat('ballcart', { color: 0x333333, metalness: 0.5 }), { surface: 'metal' });
  b.box(22, 0, -17, 1.2, 0.9, 0.8, b.mat('ballcart'), { surface: 'metal' });
  // shipping container corner
  b.box(-38.5, 0, -19, 2.4, 2.6, 6, b.mat('container', { color: 0x9a3a2a, metalness: 0.4, roughness: 0.6 }), { surface: 'metal' });
  b.box(38.5, 0, 19, 2.4, 2.6, 6, b.mat('container2', { color: 0x2a5a8a, metalness: 0.4, roughness: 0.6 }), { surface: 'metal' });
  // bags & cones
  for (let i = 0; i < 10; i++) { const x = (b.rng() - 0.5) * 60, z = (b.rng() - 0.5) * 36; b.vis(new THREE.ConeGeometry(0.12, 0.3, 8), b.mat('cone', { color: 0xff6a1a }), x, 0.15, z); }
  for (const [x, z] of [[-27, 3], [27, -3], [-10, -18], [10, 18]]) b.box(x, 0, z, 1.0, 0.4, 0.5, b.mat('bag', { color: 0x1a1a3a, map: TEX.fabric() }), { surface: 'fabric' });
  // a soccer ball that rolls when hit
  const ball = b.vis(new THREE.IcosahedronGeometry(0.11, 1), b.mat('ball', { color: 0xffffff, flatShading: true }), 2, 0.11, 3);
  info.ball = { mesh: ball, vel: new THREE.Vector3() };
  // fence around
  const fenceM = b.mat('fence', { color: 0x4a6a4a, wireframe: true });
  for (const [x0, z0, x1, z1] of [[-42, -28, 42, -28], [-42, 28, 42, 28], [-42, -28, -42, 28], [42, -28, 42, 28]]) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    b.vis(new THREE.PlaneGeometry(len, 2.5, Math.ceil(len / 0.3), 8), fenceM, (x0 + x1) / 2, 1.25, (z0 + z1) / 2, { rot: [0, z0 === z1 ? 0 : Math.PI / 2, 0], cast: false });
  }
  // light towers (visual)
  for (const [x, z] of [[-40, -26], [40, -26], [-40, 26], [40, 26]]) b.box(x, 0, z, 0.4, 14, 0.4, b.mat('tower', { color: 0x777777, metalness: 0.6 }), { surface: 'metal' });
  // tree line outside the fence (visual)
  const treeG = new THREE.ConeGeometry(2.5, 9, 7);
  for (let i = 0; i < 40; i++) {
    const a = i / 40 * Math.PI * 2; const x = Math.cos(a) * 58, z = Math.sin(a) * 40;
    b.vis(treeG, b.mat('farTree', { color: 0x2a4a2a, flatShading: true }), x, 4.5, z, { cast: false });
  }
  W.surfaceFn = (x, z) => Math.abs(z) > 24 ? 'gravel' : 'grass';
  W.zones = [
    { name: 'the west goal', minX: -42, maxX: -24, minZ: -12, maxZ: 12 },
    { name: 'the east goal', minX: 24, maxX: 42, minZ: -12, maxZ: 12 },
    { name: 'the bleachers', minX: -14, maxX: 14, minZ: -28, maxZ: -21 },
    { name: 'the dugouts', minX: -14, maxX: 14, minZ: 21, maxZ: 28 },
    { name: 'midfield', minX: -8, maxX: 8, minZ: -21, maxZ: 21 },
    { name: 'the west half', minX: -42, maxX: 0, minZ: -28, maxZ: 28 },
    { name: 'the east half', minX: 0, maxX: 42, minZ: -28, maxZ: 28 },
  ];
  info.ambient = 'field';
  info.spawns = [
    [V(-30, 0, -2), V(-30, 0, 2), V(-31, 0, 0), V(-29, 0, -4), V(-29, 0, 4)],
    [V(30, 0, -2), V(30, 0, 2), V(31, 0, 0), V(29, 0, -4), V(29, 0, 4)],
  ];
  info.defensePoints = [V(-38.5, 0, -15), V(8, 0, 26), V(0, 0, -26), V(-16, 0, -7), V(16, 0, 7), V(38.5, 0, 15), V(-22, 0, 18)];
  info.searchPoints = info.defensePoints.concat([V(0, 0, 0), V(-25, 0, 0), V(25, 0, 0)]);
  info.huntStart = V(30, 0, 0); info.hideStart = V(-10, 0, 0); info.extraction = V(-40, 0, 0);
  info.lightLevel = 1.0;
  return info;
}

// =============================================================
// GARDEN (optionally with basement attached to the north)
// =============================================================
function buildGarden(b, info, withBasement) {
  const W = b.world;
  const zMin = withBasement ? -31 : -15;
  W.bounds = { minX: -18, maxX: 18, minZ: zMin, maxZ: 15 };
  const grass = b.tmat('lawn', 'grass', 0xffffff);
  const stone = b.tmat('patio', 'stone', 0xffffff);
  const woodM = b.tmat('wood', 'wood', 0xffffff);
  const fenceWood = b.tmat('fencewood', 'wood', 0xb89a78);
  const brick = b.tmat('brick', 'brick', 0xffffff);
  b.floor(-18, -11, 18, 15, grass, 0, 3);
  b.floor(-10, -11, 6, -7, stone, 0.006, 1.5);
  // garden path to shed
  b.floor(5, -7, 7, 8, stone, 0.006, 1.5);
  // fence around garden
  const fo = { surface: 'wood' };
  b.wallX(-18, 18, 15, 1.8, 0.1, [{ c: 0, w: 1.2, top: 1.8 }], fenceWood, fo);
  b.wallZ(-11, 15, -18, 1.8, 0.1, withBasement ? [] : [], fenceWood, fo);
  b.wallZ(-11, 15, 18, 1.8, 0.1, [], fenceWood, fo);
  // gate visual
  b.box(0, 0, 15.1, 1.2, 1.4, 0.05, woodM, { collide: false });
  W.addBox(-0.6, 0, 15.0, 0.6, 1.4, 15.2, { surface: 'wood' });

  // house
  const H = 2.6;
  if (!withBasement) {
    b.box(0, 0, -13, 36, 6, 4, brick, { surface: 'brick' });
    b.box(-4, 0.0, -10.97, 2.2, 2.2, 0.05, b.mat('door', { color: 0x223344, metalness: 0.6, roughness: 0.2 }), { collide: false });
    b.box(6, 1.0, -10.97, 1.6, 1.2, 0.05, b.mat('window', { color: 0x3a4a5a, metalness: 0.7, roughness: 0.1 }), { collide: false });
  } else {
    buildAttachedBasement(b, info, H);
  }
  // patio furniture
  table(b, -6, -9, 1.6, 0.9, 0.75, b.mat('patiotable', { color: 0xdddddd, roughness: 0.4 }));
  for (const [x, z] of [[-7.1, -9], [-4.9, -9], [-6, -10]]) b.box(x, 0, z, 0.5, 0.45, 0.5, b.mat('chair', { color: 0x333333 }), { surface: 'plastic' });
  b.box(2.5, 0, -9.6, 1.2, 1.0, 0.6, b.mat('grill', { color: 0x1a1a1a, metalness: 0.6, roughness: 0.4 }), { surface: 'metal' });
  b.vis(new THREE.CylinderGeometry(0.03, 0.03, 2.3, 6), b.mat('pole', { color: 0x888888 }), -6, 1.15, -9);
  b.vis(new THREE.ConeGeometry(1.5, 0.5, 8), b.mat('parasol', { color: 0xc8402a, side: THREE.DoubleSide }), -6, 2.4, -9, { cast: true });
  // trampoline
  const tx = -4, tz = 3;
  const tramp = b.vis(new THREE.CylinderGeometry(1.8, 1.8, 0.1, 24), b.mat('trampmat', { color: 0x111111 }), tx, 0.9, tz);
  for (let i = 0; i < 8; i++) { const a = i / 8 * 6.28; b.vis(new THREE.CylinderGeometry(0.03, 0.03, 2.6, 5), b.mat('tpole', { color: 0x3a6aaa }), tx + Math.cos(a) * 1.85, 1.3, tz + Math.sin(a) * 1.85); }
  b.vis(new THREE.CylinderGeometry(1.86, 1.86, 1.7, 24, 1, true), b.mat('tnet', { color: 0x222222, transparent: true, opacity: 0.25, side: THREE.DoubleSide }), tx, 1.75, tz, { cast: false });
  W.addBox(tx - 1.6, 0, tz - 1.6, tx + 1.6, 0.95, tz + 1.6, { surface: 'trampoline', sight: false, tag: 'trampoline' });
  // hedges (tall, sight-blocking, solid)
  const hedgeM = b.mat('hedge', { color: 0xa8c898, map: TEX.leaves(), roughness: 1 });
  for (const [x, z, w, d] of [[-13, -2, 0.9, 7], [12, 4, 6, 0.9], [-9, 10, 6, 0.9], [9, -4, 0.9, 4], [-15.5, 7, 4, 0.9]]) b.box(x, 0, z, w, 2.0, d, hedgeM, { surface: 'leaves', ts: 1 });
  // low bushes (concealment)
  const bushM = b.mat('gbush', { color: 0xb0d0a0, map: TEX.leaves(), flatShading: true });
  for (const [x, z, s] of [[-16.5, -9, 1], [16, -9, 1.1], [-2, 13.5, 0.9], [14.5, 13, 1.2], [-10, -5, 0.8], [3, 8, 0.8], [-16, 13.5, 1]]) {
    b.vis(new THREE.IcosahedronGeometry(s, 1), bushM, x, s * 0.5, z).scale.y = 0.8;
    W.addBox(x - s, 0, z - s, x + s, s * 1.2, z + s, { solid: false, tag: 'bush', surface: 'leaves' });
  }
  // shed (enterable) SE
  const sx = 13, sz = 10;
  b.wallX(sx - 2, sx + 2, sz - 1.8, 2.3, 0.12, [{ c: sx - 0.8, w: 1.0 }], woodM, fo);
  b.wallX(sx - 2, sx + 2, sz + 1.8, 2.3, 0.12, [], woodM, fo);
  b.wallZ(sz - 1.8, sz + 1.8, sx - 2, 2.3, 0.12, [{ c: sz + 0.4, w: 0.7, top: 1.6, sill: 1.0 }], woodM, fo);
  b.wallZ(sz - 1.8, sz + 1.8, sx + 2, 2.3, 0.12, [], woodM, fo);
  b.vis(b.boxGeo(4.4, 0.1, 4.0, 0), b.mat('shedroof', { color: 0x3a3a3a }), sx, 2.4, sz, { rot: [0.1, 0, 0] });
  b.box(sx + 1.4, 0, sz + 1.2, 0.8, 1.0, 0.6, b.mat('mower', { color: 0xc82a2a, metalness: 0.4 }), { surface: 'metal' });
  shelf(b, sx + 1.6, sz - 0.6, 0.5, 1.8, 1.4, 0);
  // greenhouse SW (glass: blocks movement and darts, not sight)
  const gx = -12, gz = -7.5;
  const glass = b.mat('ghglass', { color: 0xbfe8e0, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.1, depthWrite: false });
  const gho = { surface: 'glass', sight: false, cast: false };
  b.wallX(gx - 2.5, gx + 2.5, gz - 1.8, 2.2, 0.06, [], glass, gho);
  b.wallX(gx - 2.5, gx + 2.5, gz + 1.8, 2.2, 0.06, [{ c: gx + 1.5, w: 1.1 }], glass, gho);
  b.wallZ(gz - 1.8, gz + 1.8, gx - 2.5, 2.2, 0.06, [], glass, gho);
  b.wallZ(gz - 1.8, gz + 1.8, gx + 2.5, 2.2, 0.06, [], glass, gho);
  b.box(gx, 0, gz - 1.1, 4.2, 0.8, 0.6, woodM, { surface: 'wood' });
  for (let i = 0; i < 6; i++) b.vis(new THREE.IcosahedronGeometry(0.22, 0), bushM, gx - 1.8 + i * 0.7, 1.0, gz - 1.1);
  // raised beds, compost, playhouse, firewood, wheelbarrow, gnomes
  for (const [x, z] of [[0, -3], [4, 1], [-8, -1]]) { b.box(x, 0, z, 2.4, 0.45, 1.0, woodM, { surface: 'wood' }); b.floor(x - 1.1, z - 0.4, x + 1.1, z + 0.4, b.mat('soil', { map: TEX.dirt(), color: 0x6a4a30 }), 0.46, 1); }
  b.box(-16.4, 0, 1.0, 1.6, 1.1, 1.4, b.mat('compost', { color: 0x2a3a2a }), { surface: 'plastic' });
  b.box(3, 0, 12.5, 2.0, 1.6, 1.6, b.mat('playhouse', { color: 0xe8c040 }), { surface: 'plastic' });
  b.vis(new THREE.ConeGeometry(1.6, 0.8, 4), b.mat('playroof', { color: 0xc83a2a }), 3, 2.0, 12.5, { rot: [0, Math.PI / 4, 0] });
  b.box(16.8, 0, -3, 0.8, 1.2, 3.0, b.mat('firewood', { map: TEX.bark(), color: 0xaa9070 }), { surface: 'bark' });
  b.box(-1.5, 0, 8.5, 0.6, 0.6, 1.3, b.mat('wheelbarrow', { color: 0x2a6a2a, metalness: 0.5 }), { surface: 'metal' });
  for (const [x, z] of [[-1, -5.4], [8, 13], [-17, -4]]) {
    b.vis(new THREE.ConeGeometry(0.1, 0.22, 8), b.mat('gnomehat', { color: 0xd02a2a }), x, 0.38, z);
    b.vis(new THREE.CylinderGeometry(0.1, 0.12, 0.28, 8), b.mat('gnome', { color: 0x2a5ad0 }), x, 0.14, z);
  }
  // dog house + doggo (cosmetic, barks)
  b.box(16.2, 0, 7, 1.2, 1.0, 1.0, b.mat('doghouse', { color: 0x8a5a3a }), { surface: 'wood' });
  info.dog = V(16.2, 0.5, 7);
  // garden lights (evening mood optional) - few
  W.surfaceFn = (x, z) => {
    if (z < -11) return 'concrete';
    if (x > -10 && x < 6 && z > -11 && z < -7) return 'stone';
    if (x > 5 && x < 7 && z > -7 && z < 8) return 'stone';
    if (Math.abs(x - 13) < 2 && Math.abs(z - 10) < 1.8) return 'wood';
    return 'grass';
  };
  const gz2 = [
    { name: 'the patio', minX: -10, maxX: 6, minZ: -11, maxZ: -7 },
    { name: 'the greenhouse', minX: -14.5, maxX: -9.5, minZ: -9.3, maxZ: -5.7 },
    { name: 'the shed', minX: 11, maxX: 15, minZ: 8.2, maxZ: 11.8 },
    { name: 'the trampoline', circle: true, x: tx, z: tz, r: 3 },
    { name: 'the playhouse', circle: true, x: 3, z: 12.5, r: 3 },
    { name: 'the hedges', minX: -18, maxX: -12, minZ: -6, maxZ: 10 },
    { name: 'the veggie beds', minX: -9, maxX: 5.5, minZ: -4, maxZ: 2 },
    { name: 'the back fence', minX: -18, maxX: 18, minZ: 11, maxZ: 15 },
    { name: 'the garden', minX: -18, maxX: 18, minZ: -11, maxZ: 15 },
  ];
  W.zones = (W.zones || []).concat(gz2);
  info.ambient = 'garden';
  if (!withBasement) {
    info.spawns = [
      [V(-15, 0, 12.5), V(-13, 0, 12.5), V(-11, 0, 13), V(-15, 0, 10), V(-12, 0, 11)],
      [V(15, 0, -6), V(14, 0, -8), V(16, 0, -8.5), V(12, 0, -8.5), V(14, 0, -6)],
    ];
    info.defensePoints = [V(13, 0, 10.6), V(-12, 0, -7), V(3, 0, 11), V(-4, 0, 5.2), V(-14, 0, -2), V(16, 0, -1), V(-6, 0, -9.8)];
    info.huntStart = V(0, 0, 13.5); info.hideStart = V(0, 0, -5); info.extraction = V(16.5, 0, -10);
  } else {
    info.spawns = [
      [V(-15, 0, 12.5), V(-13, 0, 12.5), V(-11, 0, 13), V(-15, 0, 10), V(-12, 0, 11)],
      [V(12, 0, -27), V(10, 0, -28), V(14, 0, -28.5), V(12, 0, -25), V(9, 0, -26)],
    ];
    info.defensePoints = [V(13, 0, 10.6), V(-12, 0, -7), V(3, 0, 11), V(-4, 0, 5.2), V(-8, 0, -22), V(6, 0, -18), V(14, 0, -24), V(-1, 0, -28)];
    info.huntStart = V(0, 0, 13.5); info.hideStart = V(0, 0, -20); info.extraction = V(-16.5, 0, -28);
  }
  info.searchPoints = info.defensePoints.concat([V(0, 0, 0), V(10, 0, -2), V(-10, 0, 5)]);
  info.lightLevel = 1.0;
  return info;
}

function buildAttachedBasement(b, info, _H) {
  const W = b.world;
  const H = 2.45, T = 0.2;
  const wallM = b.tmat('paint', 'paint', 0xffffff);
  const brick = b.tmat('brick', 'brick', 0xffffff);
  const conc = b.tmat('concrete', 'concrete', 0xffffff);
  const carpet = b.tmat('carpet', 'carpet', 0xffffff);
  const woodM = b.tmat('wood', 'wood', 0xffffff);
  // Basement footprint x -15..18, z -31..-11 ; west strip x -18..-15 is the outdoor cellar stairwell
  b.floor(-15, -31, 18, -11, conc, 0, 3);
  b.floor(-15, -19, -2, -11, carpet, 0.005, 1.5);
  b.floor(-18, -31, -15, -11, b.tmat('patio', 'stone', 0xffffff), 0.004, 1.5);
  b.ceiling(-15, -31, 18, -11, b.mat('ceil', { color: 0x9a968c, map: TEX.concrete() }), H);
  // house exterior (upper floor mass above basement, visual)
  b.box(1.5, H, -21, 33.4, 3.2, 20.4, brick, { collide: false });
  // exterior/perimeter walls
  // south wall facing garden: patio sliding door (x=-4) + crawl window (x=8)
  b.wallX(-15.1, 18, -11, H, T, [{ c: -4, w: 2.0, top: 2.1 }, { c: 8, w: 1.2, top: 1.25 }], brick, { surface: 'brick' });
  b.wallX(-15.1, 18, -31.1, H, T, [], wallM, { surface: 'concrete' });
  b.wallZ(-31, -11, 18.1, H, T, [], wallM, { surface: 'concrete' });
  b.wallZ(-31, -11, -15.1, H, T, [{ c: -27.5, w: 1.1 }], brick, { surface: 'brick' }); // cellar door from stairwell
  // cellar stairwell strip outside (walls along it, open top)
  b.wallZ(-31, -12.5, -18.1, 1.0, T, [], b.tmat('patio', 'stone', 0xffffff), { surface: 'stone' });
  b.box(-16.5, 0, -31.2, 3, 1.0, 0.2, b.tmat('patio', 'stone', 0xffffff), { surface: 'stone' });
  b.sign('CELLAR', -15.0, 2.2, -27.5, 0.8, 0.3, -Math.PI / 2, '#fff', '#333', 'bold 80px sans-serif');
  // glass door visual
  b.box(-3.3, 0, -11.0, 0.6, 2.1, 0.04, b.mat('glassdoor', { color: 0x9ac0d0, transparent: true, opacity: 0.25 }), { collide: false, cast: false });
  // interior walls
  b.wallX(-15, 18, -19, H, T, [{ c: -12, w: 1.3 }, { c: -4, w: 1.0 }, { c: 4, w: 1.2 }, { c: 13, w: 1.2 }], wallM, { surface: 'concrete' });
  b.wallX(-15, 18, -23.5, H, T, [{ c: -10, w: 1.2 }, { c: 2, w: 1.3 }, { c: 10, w: 1.2 }], wallM, { surface: 'concrete' });
  b.wallZ(-19, -11, -2, H, T, [{ c: -15, w: 1.1 }], wallM);
  b.wallZ(-19, -11, 10, H, T, [{ c: -14, w: 1.1 }], wallM);
  b.wallZ(-31, -23.5, -6, H, T, [{ c: -27, w: 1.0 }], wallM);
  b.wallZ(-31, -23.5, 6, H, T, [{ c: -28, w: 1.0 }], wallM);
  // Rec room (SW, behind patio door)
  couch(b, -9, -13.4, 2.8, 0, 0x5a6a7a);
  b.box(-9, 0, -15.2, 1.3, 0.45, 0.6, woodM, { surface: 'wood' });
  b.box(-9, 0, -18.5, 2.0, 0.6, 0.45, woodM, { surface: 'wood' });
  b.box(-9, 0.6, -18.6, 1.5, 0.85, 0.08, b.mat('tv', { color: 0x050505, roughness: 0.2 }), { surface: 'plastic' });
  b.box(-13.8, 0, -14.5, 0.5, 1.9, 2.0, woodM, { surface: 'wood' });
  b.box(-5, 0, -16, 1.5, 0.76, 2.6, b.mat('pingpong', { color: 0x1d4a2a, roughness: 0.6 }), { surface: 'wood' });
  b.fluoro(-9, -15, H, 1.2, 0xfff0d8, 3.2, 9, 0.02);
  // Workshop (S middle, behind crawl window)
  b.box(4, 0, -11.6, 4.0, 0.95, 0.7, woodM, { surface: 'wood' });
  table(b, 4, -15, 2.0, 1.0, 0.85, woodM);
  for (let i = 0; i < 3; i++) b.vis(new THREE.CylinderGeometry(0.34, 0.34, 0.22, 16), b.mat('tire', { color: 0x161616 }), 0.5, 0.11 + i * 0.22, -17.8);
  W.addBox(0.15, 0, -18.15, 0.85, 0.66, -17.45, { surface: 'rubber' });
  b.fluoro(4, -15, H, 1.2, 0xf2f5ff, 4, 8, 0.1);
  // Laundry (SE)
  const white = b.mat('appliance', { color: 0xe8e8e2, roughness: 0.4 });
  b.box(16.8, 0, -12.5, 0.7, 0.9, 0.7, white, { surface: 'metal' });
  b.box(16.8, 0, -13.4, 0.7, 0.9, 0.7, white, { surface: 'metal' });
  table(b, 14, -16, 1.6, 0.8, 0.9, woodM);
  b.box(11.5, 0, -18.2, 0.6, 0.5, 0.6, b.mat('laundrypile', { color: 0x9a9aa8, map: TEX.fabric() }), { surface: 'fabric' });
  b.fluoro(14, -15, H, 1.0, 0xf2f5ff, 3.4, 8, 0.2);
  // Hallway
  cardboard(b, -7, -20.5, 0.8); cardboard(b, 7, -22.5, 0.7); cardboard(b, 7, -22.5, 0.5, 0.56, 0.3);
  b.box(15, 0, -22.8, 0.6, 0.85, 0.55, b.mat('fridge', { color: 0xdedede, roughness: 0.4 }), { surface: 'metal' });
  b.fluoro(-6, -21.25, H, 1.0, 0xf2f5ff, 2.6, 8, 0.1);
  b.fluoro(8, -21.25, H, 1.0, 0xf2f5ff, 2.6, 8, 0.35);
  // Storage (N west)
  shelf(b, -12, -26, 2.2, 2.0, 0.5, 0); shelf(b, -12, -29.2, 2.2, 2.0, 0.5, 0); shelf(b, -8.5, -27.6, 0.5, 2.0, 2.2, 0);
  cardboard(b, -9.5, -25, 0.6);
  b.fluoro(-10, -27, H, 1.2, 0xf2f5ff, 3.2, 8, 0.12);
  // Furnace (N middle)
  b.box(0, 0, -29.5, 2.2, 1.9, 1.8, b.mat('furnace', { color: 0x6a6e70, metalness: 0.5, roughness: 0.5 }), { surface: 'metal' });
  b.box(-3.6, 0, -25, 1.6, 1.1, 0.9, b.mat('oiltank', { color: 0x4a5a3a, metalness: 0.3 }), { surface: 'metal' });
  b.fluoro(0, -26.5, H, 1.0, 0xffd8a0, 3, 7, 0.3);
  // Bar (NE, spawn B)
  b.box(12, 0, -26, 3.0, 1.1, 0.6, woodM, { surface: 'wood' });
  b.box(17.5, 0, -27, 0.5, 1.9, 2.6, b.mat('barshelf', { color: 0x3a2a1a }), { surface: 'wood' });
  b.box(9, 0, -29.3, 2.2, 0.8, 1.2, b.mat('pool', { color: 0x1a5a3a }), { surface: 'wood' });
  b.fluoro(12, -27, H, 1.0, 0xffe0b0, 3.2, 8, 0.05);
  W.zones = [
    { name: 'the cellar steps', minX: -18, maxX: -15, minZ: -31, maxZ: -11 },
    { name: 'the rec room', minX: -15, maxX: -2, minZ: -19, maxZ: -11 },
    { name: 'the workshop', minX: -2, maxX: 10, minZ: -19, maxZ: -11 },
    { name: 'the laundry', minX: 10, maxX: 18, minZ: -19, maxZ: -11 },
    { name: 'the hallway', minX: -15, maxX: 18, minZ: -23.5, maxZ: -19 },
    { name: 'storage', minX: -15, maxX: -6, minZ: -31, maxZ: -23.5 },
    { name: 'the furnace room', minX: -6, maxX: 6, minZ: -31, maxZ: -23.5 },
    { name: 'the bar', minX: 6, maxX: 18, minZ: -31, maxZ: -23.5 },
  ];
  info.indoorRegion = { minX: -15, maxX: 18, minZ: -31, maxZ: -11 };
}

// =============================================================
export function buildMap(id, scene, world, seed = 1) {
  const b = new Builder(scene, world, seed);
  const info = { id, name: MAPS[id].name, builder: b };
  if (id === 'basement') buildBasement(b, info);
  else if (id === 'forest') buildForest(b, info, false);
  else if (id === 'jurgen') buildForest(b, info, true);
  else if (id === 'soccer') buildSoccer(b, info);
  else if (id === 'garden') buildGarden(b, info, false);
  else if (id === 'gardenbasement') buildGarden(b, info, true);
  // environment & lighting
  setupLighting(scene, info, b);
  world.buildNav(0.5);
  return info;
}

function setupLighting(scene, info, b) {
  const amb = info.ambient;
  if (amb === 'basement') {
    scene.background = new THREE.Color(0x050505);
    scene.fog = new THREE.Fog(0x0a0a0a, 6, 30);
    scene.add(new THREE.HemisphereLight(0x8a8a90, 0x30281e, 0.55));
    return;
  }
  const mist = amb === 'forestmist';
  const sky = amb === 'field' ? 0xa8c4dc : amb === 'garden' ? 0xb0c8dc : mist ? 0x8a9488 : 0x9ab0b0;
  scene.background = new THREE.Color(sky);
  scene.fog = mist ? new THREE.FogExp2(0x8a9488, 0.032) : new THREE.Fog(sky, amb === 'field' ? 40 : 20, amb === 'field' ? 160 : 95);
  const hemi = new THREE.HemisphereLight(mist ? 0xb0b8b0 : 0xdde8ff, mist ? 0x3a3a2a : 0x4a4030, mist ? 0.9 : 1.0);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(mist ? 0xd8dcd0 : 0xfff2dc, mist ? 0.9 : 2.2);
  sun.position.set(30, 50, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera; sc.left = -35; sc.right = 35; sc.top = 35; sc.bottom = -35; sc.near = 1; sc.far = 150;
  sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03;
  scene.add(sun); scene.add(sun.target);
  info.sun = sun;
  if (info.indoorRegion) scene.add(new THREE.HemisphereLight(0x8a8a90, 0x30281e, 0.15));
}
