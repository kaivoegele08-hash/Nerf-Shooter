// Foam darts (simulated projectiles), firing, traps and barricades.
import * as THREE from '../lib/three.module.min.js';
import { rayBox } from './world.js';

const G = 7.5;      // effective gravity on foam darts
const DRAG = 0.35;  // linear drag (1/s)

const dartGeo = (() => {
  const body = new THREE.CylinderGeometry(0.0065, 0.0065, 0.072, 6); body.rotateX(Math.PI / 2); body.translate(0, 0, 0.008);
  const tip = new THREE.CylinderGeometry(0.0068, 0.0068, 0.016, 6); tip.rotateX(Math.PI / 2); tip.translate(0, 0, -0.036);
  return { body, tip };
})();
const dartMats = {
  body: new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.9 }),
  bodyB: new THREE.MeshStandardMaterial({ color: 0x2a9a3a, roughness: 0.9 }),
  tip: new THREE.MeshStandardMaterial({ color: 0x1e5bd8, roughness: 0.6 }),
};

export function makeDartMesh(alt) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(dartGeo.body, alt ? dartMats.bodyB : dartMats.body));
  g.add(new THREE.Mesh(dartGeo.tip, dartMats.tip));
  g.scale.setScalar(1.4); // slightly oversized for readability through the bodycam
  return g;
}

export class DartSystem {
  constructor(game) {
    this.game = game; this.darts = []; this.stuck = [];
    this.pool = [];
  }

  _mesh(alt) {
    const m = this.pool.pop() || makeDartMesh(alt);
    this.game.scene.add(m);
    return m;
  }

  fire(owner, origin, dir, speed) {
    const m = this._mesh(owner.team === 1);
    m.position.copy(origin);
    const d = { owner, pos: origin.clone(), vel: dir.clone().multiplyScalar(speed), mesh: m, life: 4, nearMissed: new Set() };
    this.darts.push(d);
    return d;
  }

  update(dt) {
    const W = this.game.world;
    const actors = this.game.actors;
    const step = new THREE.Vector3(), dir = new THREE.Vector3();
    for (let i = this.darts.length - 1; i >= 0; i--) {
      const d = this.darts[i];
      d.life -= dt;
      d.vel.y -= G * dt;
      d.vel.multiplyScalar(1 - DRAG * dt);
      step.copy(d.vel).multiplyScalar(dt);
      const len = step.length();
      dir.copy(step).divideScalar(len || 1);
      // actors
      let hitT = len, hitActor = null;
      for (const a of actors) {
        if (a === d.owner || a.state === 'out') continue;
        const hh = a.hitHeight();
        const r = a.radius + 0.06;
        const box = { min: { x: a.pos.x - r, y: a.pos.y, z: a.pos.z - r }, max: { x: a.pos.x + r, y: a.pos.y + hh, z: a.pos.z + r } };
        const res = rayBox(d.pos, dir, box, hitT);
        if (res && res.t < hitT) { hitT = res.t; hitActor = a; }
        // near-miss whizz for the camera holder
        if (!hitActor && a === this.game.viewActor && !d.nearMissed.has(a)) {
          const dd = a.eyePos(new THREE.Vector3()).distanceTo(d.pos);
          if (dd < 1.2) { d.nearMissed.add(a); this.game.audio.whizz(d.pos); this.game.onNearMiss?.(a, d); }
        }
      }
      const wh = W.raycast(d.pos, dir, hitT, 'shot');
      if (wh && wh.t < hitT) {
        // hit world
        d.pos.addScaledVector(dir, wh.t);
        this.game.audio.impact(d.pos, wh.box ? wh.box.surface : W.surfaceAt(d.pos.x, d.pos.z));
        this.game.onDartWorldHit?.(d, wh);
        this._settle(d, wh);
        this.darts.splice(i, 1);
        continue;
      }
      if (hitActor) {
        d.pos.addScaledVector(dir, hitT);
        this.game.onDartHitActor(d, hitActor);
        this._drop(d, hitActor);
        this.darts.splice(i, 1);
        continue;
      }
      d.pos.add(step);
      d.mesh.position.copy(d.pos);
      d.mesh.lookAt(d.pos.x - dir.x, d.pos.y - dir.y, d.pos.z - dir.z);
      if (d.life <= 0 || d.pos.y < -20) { this._recycle(d.mesh); this.darts.splice(i, 1); }
    }
    // falling bounced darts
    for (const s of this.stuck) {
      if (!s.falling) continue;
      s.vel.y -= 9.8 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin * dt;
      const g = W.supportHeight(s.mesh.position.x, s.mesh.position.z, 0.02, s.mesh.position.y + 0.1);
      if (s.mesh.position.y <= g + 0.01) { s.mesh.position.y = g + 0.01; s.falling = false; s.mesh.rotation.x = Math.PI / 2; s.mesh.rotation.z = Math.random() * 6; }
    }
  }

  _settle(d, wh) {
    // most foam darts bounce off and drop; suction tips occasionally stick to smooth surfaces
    const smooth = wh.box && ['glass', 'metal', 'plastic', 'ceramic'].includes(wh.box.surface);
    const m = d.mesh;
    m.position.copy(d.pos);
    if (smooth && Math.random() < 0.35) {
      m.position.addScaledVector(wh.normal, 0.03);
      this._keep({ mesh: m, falling: false });
    } else {
      const v = d.vel.clone().multiplyScalar(0.12);
      if (wh.normal) v.addScaledVector(wh.normal, -2 * v.dot(wh.normal));
      if (wh.normal) m.position.addScaledVector(wh.normal, 0.03);
      this._keep({ mesh: m, falling: true, vel: v, spin: (Math.random() - 0.5) * 20 });
    }
  }
  _drop(d, actor) {
    const m = d.mesh; m.position.copy(d.pos);
    const v = d.vel.clone().multiplyScalar(-0.08); v.y = 1;
    this._keep({ mesh: m, falling: true, vel: v, spin: 15 });
  }
  _keep(s) {
    this.stuck.push(s);
    if (this.stuck.length > 180) { const old = this.stuck.shift(); this._recycle(old.mesh); }
  }
  _recycle(m) { this.game.scene.remove(m); if (this.pool.length < 100) this.pool.push(m); }

  clear() {
    for (const d of this.darts) this.game.scene.remove(d.mesh);
    for (const s of this.stuck) this.game.scene.remove(s.mesh);
    this.darts = []; this.stuck = [];
  }
}

// Compute the aim direction for a ballistic foam dart from `from` to `to` (approximate drag + gravity compensation)
export function ballisticDir(from, to, speed) {
  const dx = to.x - from.x, dz = to.z - from.z, dy = to.y - from.y;
  const horiz = Math.hypot(dx, dz);
  const k = DRAG;
  const ratio = Math.min(0.95, k * horiz / speed);
  const t = -Math.log(1 - ratio) / k;
  const drop = (G / k) * t - (G / (k * k)) * (1 - Math.exp(-k * t));
  const dir = new THREE.Vector3(dx, dy + drop * 1.02, dz).normalize();
  return dir;
}

// ------------- Traps & barricades -------------
const trapMats = {
  stake: new THREE.MeshStandardMaterial({ color: 0x6a4a2a }),
  wire: new THREE.LineBasicMaterial({ color: 0xdedede, transparent: true, opacity: 0.6 }),
  box: new THREE.MeshStandardMaterial({ color: 0x3a6a2a, roughness: 0.9 }),
  can: new THREE.MeshStandardMaterial({ color: 0xa0a4a8, metalness: 0.7, roughness: 0.3 }),
  pallet: new THREE.MeshStandardMaterial({ color: 0xb8956a, roughness: 0.9 }),
};

export class TrapSystem {
  constructor(game) { this.game = game; this.traps = []; this.barricades = []; }

  // type: 'tripwire' (alarm) or 'dart' (auto-fires at intruder)
  place(owner, type, pos, yaw) {
    const W = this.game.world;
    const g = new THREE.Group();
    const y = W.ground(pos.x, pos.z);
    const t = { owner, team: owner.team, type, pos: new THREE.Vector3(pos.x, y, pos.z), yaw, armed: true, armT: 1.5, mesh: g };
    if (type === 'tripwire') {
      const px = Math.cos(yaw), pz = -Math.sin(yaw);
      t.a = new THREE.Vector3(pos.x - px * 1.2, 0, pos.z - pz * 1.2); t.b = new THREE.Vector3(pos.x + px * 1.2, 0, pos.z + pz * 1.2);
      t.a.y = W.ground(t.a.x, t.a.z); t.b.y = W.ground(t.b.x, t.b.z);
      for (const e of [t.a, t.b]) { const st = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.3, 0.04), trapMats.stake); st.position.set(e.x, e.y + 0.15, e.z); g.add(st); }
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(t.a.x, t.a.y + 0.18, t.a.z), new THREE.Vector3(t.b.x, t.b.y + 0.18, t.b.z)]);
      g.add(new THREE.Line(geo, trapMats.wire));
      for (let i = 0; i < 3; i++) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 8), trapMats.can); c.position.set(t.a.x + 0.05 * i, t.a.y + 0.33, t.a.z); g.add(c); }
    } else {
      const bx = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.25), trapMats.box); bx.position.set(pos.x, y + 0.11, pos.z); bx.rotation.y = yaw; g.add(bx);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.14, 8), new THREE.MeshStandardMaterial({ color: 0xff7a1a })); tube.rotation.x = Math.PI / 2; tube.position.set(pos.x, y + 0.2, pos.z); g.add(tube);
    }
    this.game.scene.add(g);
    this.traps.push(t);
    owner.stats.traps++;
    this.game.audio.build(t.pos);
    return t;
  }

  placeBarricade(owner, pos, yaw) {
    const W = this.game.world;
    const y = W.ground(pos.x, pos.z);
    const g = new THREE.Group();
    const w = 1.7, h = 1.15;
    for (let i = 0; i < 5; i++) { const p = new THREE.Mesh(new THREE.BoxGeometry(w, 0.13, 0.05), trapMats.pallet); p.position.set(0, 0.1 + i * 0.24, 0); p.castShadow = true; g.add(p); }
    for (const sx of [-0.75, 0, 0.75]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, h, 0.08), trapMats.pallet); p.position.set(sx, h / 2, 0.05); p.castShadow = true; g.add(p); }
    // branches on top for camouflage
    const br = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), new THREE.MeshStandardMaterial({ color: 0x3d5f2c, flatShading: true }));
    br.scale.set(1.6, 0.5, 0.5); br.position.y = h; g.add(br);
    g.position.set(pos.x, y, pos.z); g.rotation.y = yaw;
    this.game.scene.add(g);
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    const hw = w / 2 * c + 0.1 * s, hd = w / 2 * s + 0.1 * c;
    const box = W.addBox(pos.x - hw, y, pos.z - hd, pos.x + hw, y + h, pos.z + hd, { surface: 'wood' });
    W.rebuildNavArea(pos.x - hw, pos.z - hd, pos.x + hw, pos.z + hd);
    this.barricades.push({ owner, mesh: g, box, pos: new THREE.Vector3(pos.x, y, pos.z) });
    this.game.audio.build(pos);
  }

  update(dt) {
    for (const t of this.traps) {
      if (!t.armed) continue;
      if (t.armT > 0) { t.armT -= dt; continue; }
      for (const a of this.game.actors) {
        if (a.state !== 'alive' || a.team === t.team) continue;
        if (a.neutral && a.char.id !== 'jurgen') continue;
        if (t.type === 'tripwire') {
          if (segDist2D(a.pos, t.a, t.b) < 0.35 && Math.abs(a.pos.y - t.pos.y) < 1) { this.trigger(t, a); break; }
        } else if (a.pos.distanceTo(t.pos) < 2.6) { this.trigger(t, a); break; }
      }
    }
  }

  trigger(t, victim) {
    t.armed = false;
    const game = this.game;
    if (t.type === 'tripwire') {
      game.audio.trapAlarm(t.pos);
      game.emitNoise(t.pos, 45, victim, 'alarm');
      game.revealTo(t.team, victim, 6);
      game.onTrapTriggered?.(t, victim);
      // knock over cans
      t.mesh.children.forEach(c => { if (c.geometry?.type === 'CylinderGeometry') { c.rotation.z = 1.4; c.position.y -= 0.25; } });
    } else {
      // pop-up dart volley
      const o = t.pos.clone(); o.y += 0.25;
      for (let i = 0; i < 3; i++) {
        setTimeout(() => {
          if (!game.running) return;
          const target = victim.chestPos(new THREE.Vector3());
          const dir = ballisticDir(o, target, 22);
          dir.x += (Math.random() - 0.5) * 0.09; dir.y += (Math.random() - 0.5) * 0.06; dir.z += (Math.random() - 0.5) * 0.09; dir.normalize();
          const fakeOwner = { team: t.team, isTrap: true, owner: t.owner, name: t.owner.name + '\'s trap', char: t.owner.char, stats: t.owner.stats };
          game.darts.fire(fakeOwner, o, dir, 22);
          game.audio.fire('pistol', o, false);
        }, 150 + i * 160);
      }
      game.onTrapTriggered?.(t, victim);
    }
    setTimeout(() => { game.scene.remove(t.mesh); }, 8000);
  }

  clear() {
    for (const t of this.traps) this.game.scene.remove(t.mesh);
    for (const b of this.barricades) this.game.scene.remove(b.mesh);
    this.traps = []; this.barricades = [];
  }
}

function segDist2D(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}
