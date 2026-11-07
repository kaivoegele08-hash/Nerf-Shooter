// Actor: shared state, body model, animation and movement for the player and AI characters.
import * as THREE from '../lib/three.module.min.js';
import { WEAPONS } from './characters.js';

export const TEAM_COLORS = [0xff6a00, 0x1e7bff];
export const TEAM_NAMES = ['ORANGE', 'BLUE'];

const geoCache = {};
function bgeo(w, h, d) {
  const k = w + '|' + h + '|' + d;
  return geoCache[k] || (geoCache[k] = new THREE.BoxGeometry(w, h, d));
}
const matCache = {};
function mat(color, rough = 0.8, extra = {}) {
  const k = color + '|' + rough + JSON.stringify(extra);
  return matCache[k] || (matCache[k] = new THREE.MeshStandardMaterial(Object.assign({ color, roughness: rough }, extra)));
}

// Build a blaster mesh (used in world models and first-person viewmodel)
export function buildBlaster(kind, color, scale = 1) {
  const g = new THREE.Group();
  const body = mat(color, 0.5);
  const grey = mat(0x3a3d42, 0.6);
  const orange = mat(0xff7a1a, 0.5);
  const add = (w, h, d, m, x, y, z) => { const me = new THREE.Mesh(bgeo(w * scale, h * scale, d * scale), m); me.position.set(x * scale, y * scale, z * scale); me.castShadow = true; g.add(me); return me; };
  switch (kind) {
    case 'pistol':
      add(0.05, 0.08, 0.22, body, 0, 0.02, -0.06); add(0.04, 0.11, 0.05, grey, 0, -0.06, 0.02);
      add(0.07, 0.07, 0.07, grey, 0, 0.02, -0.02); add(0.025, 0.025, 0.06, orange, 0, 0.03, -0.2);
      break;
    case 'twin':
      add(0.04, 0.07, 0.16, body, 0, 0.02, -0.05); add(0.035, 0.09, 0.045, grey, 0, -0.05, 0.02); add(0.02, 0.02, 0.04, orange, 0, 0.03, -0.14);
      break;
    case 'rifle':
      add(0.06, 0.09, 0.5, body, 0, 0.02, -0.16); add(0.045, 0.12, 0.05, grey, 0, -0.07, 0.04);
      add(0.05, 0.05, 0.18, grey, 0, -0.03, -0.28); add(0.05, 0.08, 0.2, body, 0, 0.0, 0.18); add(0.06, 0.12, 0.08, grey, 0, -0.06, -0.06);
      add(0.03, 0.03, 0.06, orange, 0, 0.03, -0.43);
      break;
    case 'flywheel':
      add(0.07, 0.1, 0.38, body, 0, 0.02, -0.1); add(0.045, 0.12, 0.05, grey, 0, -0.07, 0.04);
      add(0.08, 0.06, 0.1, mat(0x1e7bff, 0.5), 0, 0.03, -0.22); add(0.04, 0.16, 0.06, mat(0xffd21a, 0.5), 0, -0.1, -0.06);
      add(0.03, 0.03, 0.04, orange, 0, 0.03, -0.3);
      break;
    case 'shotgun':
      add(0.07, 0.1, 0.42, body, 0, 0.02, -0.12); add(0.045, 0.12, 0.05, grey, 0, -0.07, 0.04);
      add(0.06, 0.06, 0.16, grey, 0, -0.04, -0.2); add(0.08, 0.06, 0.06, orange, 0, 0.03, -0.33);
      break;
    case 'sniper':
      add(0.05, 0.08, 0.7, body, 0, 0.02, -0.25); add(0.045, 0.12, 0.05, grey, 0, -0.07, 0.04);
      add(0.04, 0.04, 0.18, mat(0x111111, 0.3), 0, 0.09, -0.1); add(0.05, 0.09, 0.22, body, 0, -0.0, 0.18);
      add(0.025, 0.025, 0.06, orange, 0, 0.03, -0.62);
      break;
  }
  return g;
}

let actorId = 0;

export class Actor {
  constructor(char, team, game) {
    this.id = actorId++;
    this.char = char; this.name = char.name; this.team = team; this.game = game;
    this.isPlayer = false; this.neutral = false;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.radius = 0.3;
    this.lives = 3; this.revived = false; this.state = 'alive'; // alive | downed | out
    this.invuln = 0; this.hurtT = 0;
    this.crouch = false; this.sprint = false; this.ads = false;
    this.moveIntent = new THREE.Vector3(); this.wantJump = false;
    this.onGround = true; this.stamina = 1;
    const wdef = WEAPONS[char.weapon] || WEAPONS.raider;
    this.weapon = { def: wdef, mag: wdef.mag, reloading: 0, cd: 0, jammed: 0, spin: 0, burst: 0 };
    this.downedT = 0; this.reviveProgress = 0; this.reviver = null; this.reviveTarget = null;
    this.stats = { hits: 0, downs: 0, revives: 0, shots: 0, timesHit: 0, traps: 0, outs: 0 };
    this.trapsLeft = char.traps || 0; this.barricadesLeft = 0;
    this.stepPhase = 0; this.stepDist = 0; this.animT = Math.random() * 10;
    this.lastShotAt = -99; this.lastNoise = -99; this.speaking = 0;
    this.stumble = 0;
    this.height = 1.8;
    this.footprintT = 0;
    this.buildModel();
  }

  get alive() { return this.state === 'alive'; }
  get eyeHeight() { return this.state === 'downed' ? 0.95 : this.state === 'out' ? 0.8 : this.crouch ? 1.1 : 1.62; }
  eyePos(out = new THREE.Vector3()) { return out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z); }
  chestPos(out = new THREE.Vector3()) { return out.set(this.pos.x, this.pos.y + (this.state === 'downed' ? 0.7 : this.crouch ? 0.8 : 1.2), this.pos.z); }
  forward(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }
  hitHeight() { return this.state === 'downed' ? 1.05 : this.crouch ? 1.2 : 1.8; }

  buildModel() {
    const c = this.char;
    const root = new THREE.Group();
    const shirt = mat(c.color, 0.9);
    const pants = mat(c.pants || 0x2a2e38, 0.9);
    const skin = mat(c.skin || 0xe0b090, 0.7);
    const hair = mat(c.hair || 0x222222, 0.9);
    const shoe = mat(0x1a1a1a, 0.8);
    const team = this.team >= 0 ? mat(TEAM_COLORS[this.team], 0.5, { emissive: TEAM_COLORS[this.team], emissiveIntensity: 0.25 }) : mat(0x666655);
    const mk = (geo, m, parent, x, y, z) => { const me = new THREE.Mesh(geo, m); me.position.set(x, y, z); me.castShadow = true; me.receiveShadow = true; parent.add(me); return me; };

    const hips = new THREE.Group(); hips.position.y = 0.92; root.add(hips);
    const legs = [];
    for (const s of [-1, 1]) {
      const thigh = new THREE.Group(); thigh.position.set(s * 0.11, 0, 0); hips.add(thigh);
      mk(bgeo(0.16, 0.46, 0.18), pants, thigh, 0, -0.23, 0);
      const knee = new THREE.Group(); knee.position.set(0, -0.46, 0); thigh.add(knee);
      mk(bgeo(0.15, 0.44, 0.16), pants, knee, 0, -0.22, 0);
      mk(bgeo(0.15, 0.08, 0.26), shoe, knee, 0, -0.44, -0.05);
      legs.push({ thigh, knee });
    }
    const torso = new THREE.Group(); torso.position.y = 0.0; hips.add(torso);
    mk(bgeo(0.46, 0.62, 0.26), shirt, torso, 0, 0.31, 0);
    // bodycam on chest
    mk(bgeo(0.07, 0.09, 0.04), mat(0x111111, 0.4), torso, 0.1, 0.45, -0.15);
    mk(bgeo(0.015, 0.015, 0.01), mat(0xff2020, 0.3, { emissive: 0xff0000, emissiveIntensity: 2 }), torso, 0.12, 0.48, -0.175);
    // team vest stripe / armband
    mk(bgeo(0.47, 0.08, 0.27), team, torso, 0, 0.5, 0);
    const neck = new THREE.Group(); neck.position.y = 0.64; torso.add(neck);
    const head = mk(bgeo(0.24, 0.27, 0.25), skin, neck, 0, 0.15, 0);
    mk(bgeo(0.26, 0.08, 0.27), hair, neck, 0, 0.28, 0.01);
    mk(bgeo(0.26, 0.05, 0.27), team, neck, 0, 0.22, 0); // headband
    mk(bgeo(0.04, 0.03, 0.01), mat(0x111111), neck, -0.06, 0.17, -0.127);
    mk(bgeo(0.04, 0.03, 0.01), mat(0x111111), neck, 0.06, 0.17, -0.127);
    if (c.id === 'jurgen') {
      mk(bgeo(0.26, 0.16, 0.1), mat(0x9a9a92), neck, 0, 0.06, -0.12); // beard
      mk(bgeo(0.5, 0.04, 0.5), mat(0x5a4a2a), neck, 0, 0.32, 0); mk(bgeo(0.28, 0.12, 0.28), mat(0x5a4a2a), neck, 0, 0.39, 0); // hat
      mk(bgeo(0.5, 0.75, 0.3), mat(0x2f3b24, 0.95), torso, 0, 0.1, 0); // coat
    }
    // arms (both forward holding blaster)
    const arms = [];
    for (const s of [-1, 1]) {
      const sh = new THREE.Group(); sh.position.set(s * 0.29, 0.56, 0); torso.add(sh);
      mk(bgeo(0.12, 0.32, 0.13), shirt, sh, 0, -0.16, 0);
      const el = new THREE.Group(); el.position.set(0, -0.32, 0); sh.add(el);
      mk(bgeo(0.11, 0.3, 0.11), skin, el, 0, -0.15, 0);
      arms.push({ sh, el });
    }
    const blaster = c.id === 'jurgen'
      ? (() => { const g = new THREE.Group(); const bl = new THREE.Mesh(bgeo(0.03, 0.04, 0.95), mat(0xd8dce0, 0.2, { metalness: 0.8 })); bl.position.z = -0.55; g.add(bl); const hd = new THREE.Mesh(bgeo(0.04, 0.05, 0.26), mat(0x111111)); hd.position.z = 0.0; g.add(hd); const gu = new THREE.Mesh(bgeo(0.12, 0.02, 0.04), mat(0xb8a040, 0.4, { metalness: 0.7 })); gu.position.z = -0.08; g.add(gu); return g; })()
      : buildBlaster(this.weapon.def.kind, this.weapon.def.color, 1.0);
    blaster.position.set(0.12, 0.32, -0.32); torso.add(blaster);
    this.model = { root, hips, legs, torso, neck, head, arms, blaster };
    // name tag
    root.userData.actor = this;
    this.game?.scene.add(root);
  }

  setNameTag(visible, color = '#fff') {
    if (!this.tag) {
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
      const tex = new THREE.CanvasTexture(cv);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
      sp.scale.set(0.9, 0.22, 1); sp.position.y = 2.15; sp.renderOrder = 10;
      this.model.root.add(sp);
      this.tag = { cv, tex, sp, last: '' };
    }
    this.tag.sp.visible = visible;
    const label = this.name + (this.state === 'downed' ? ' ✚' : '');
    const key = label + color;
    if (visible && this.tag.last !== key) {
      const ctx = this.tag.cv.getContext('2d'); ctx.clearRect(0, 0, 256, 64);
      ctx.font = 'bold 30px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const w = ctx.measureText(label).width + 20; ctx.fillRect(128 - w / 2, 12, w, 40);
      ctx.fillStyle = color; ctx.fillText(label, 128, 43);
      this.tag.tex.needsUpdate = true; this.tag.last = key;
    }
  }

  // ------------------- movement -------------------
  speedFor() {
    const c = this.char;
    let s = 3.1;
    if (this.sprint && !this.crouch && !this.ads && this.stamina > 0.05) s = 5.6;
    if (this.crouch) s = 1.7;
    if (this.ads && !this.sprint) s = Math.min(s, 2.3);
    if (this.lives === 1 && this.state === 'alive') s *= 0.93; // limping a bit when on last life
    return s * (c.speed || 1);
  }

  physics(dt) {
    const W = this.game.world;
    if (this.state !== 'alive') {
      this.vel.x *= 0.8; this.vel.z *= 0.8;
      this.moveIntent.set(0, 0, 0);
    }
    // stumble (Yogi)
    if (this.stumble > 0) { this.stumble -= dt; this.moveIntent.multiplyScalar(0.15); }
    // auto-crouch under low ceilings
    if (!this.crouch && this.state === 'alive' && W.blockedAt(this.pos.x, this.pos.z, this.radius * 0.9, this.pos.y, 1.8)) this.crouch = true;
    if (this.forceStand && this.crouch && !W.blockedAt(this.pos.x, this.pos.z, this.radius * 0.9, this.pos.y, 1.8)) this.crouch = false;
    const want = this.speedFor();
    const mi = this.moveIntent;
    const len = Math.hypot(mi.x, mi.z);
    const tx = len > 0.01 ? mi.x / Math.max(1, len) * want : 0, tz = len > 0.01 ? mi.z / Math.max(1, len) * want : 0;
    const accel = this.onGround ? 14 : 3;
    this.vel.x += (tx - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (tz - this.vel.z) * Math.min(1, accel * dt);
    if (this.wantJump && this.onGround && this.state === 'alive' && !this.crouch) { this.vel.y = 5.2; this.onGround = false; }
    this.wantJump = false;
    const h = this.crouch || this.state !== 'alive' ? 1.15 : 1.8;
    const wasGround = this.onGround;
    const vy = this.vel.y;
    const r = W.moveCircle(this.pos, this.vel, dt, this.radius, h);
    this.onGround = r.onGround;
    if (!wasGround && this.onGround && vy < -4) this.onLand?.(vy);
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.speed = sp;
    // stamina
    if (this.sprint && sp > 4) this.stamina = Math.max(0, this.stamina - dt * 0.16);
    else this.stamina = Math.min(1, this.stamina + dt * (sp < 0.5 ? 0.22 : 0.1));
    // footsteps
    if (this.onGround && sp > 0.4) {
      this.stepDist += sp * dt;
      const stride = this.sprint ? 1.5 : this.crouch ? 0.7 : 1.05;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        const surf = W.surfaceAt(this.pos.x, this.pos.z);
        const loud = this.crouch ? 0.25 : this.sprint ? 1.0 : 0.55;
        this.game.audio.footstep(this.pos, surf, loud, this.isPlayer && !this.game.spectating);
        if (!this.crouch) this.game.emitNoise(this.pos, this.sprint ? 11 : 5.5, this, 'step');
        if (this.sprint) this.game.dropFootprint?.(this);
      }
    }
    this.stepPhase += sp * dt * (this.sprint ? 2.6 : 3.4) / Math.max(1, sp * 0.4);
  }

  // ------------------- animation -------------------
  animate(dt) {
    const m = this.model; const r = m.root;
    r.position.copy(this.pos);
    r.rotation.y = this.yaw;
    this.animT += dt;
    const sp = this.speed || 0;
    const L = m.legs, A = m.arms;
    const lerp = (a, b, k) => a + (b - a) * Math.min(1, k * dt);
    let hipsY = 0.92, thighA = 0, kneeA = 0, torsoX = 0, torsoY = 0;
    const ph = this.stepPhase * 2.2;
    if (this.state === 'downed') {
      // kneeling, hands on head
      hipsY = 0.52;
      L.forEach(l => { l.thigh.rotation.x = lerp(l.thigh.rotation.x, 0.0, 8); l.knee.rotation.x = lerp(l.knee.rotation.x, -1.55, 8); });
      A.forEach((a, i) => { a.sh.rotation.x = lerp(a.sh.rotation.x, 2.7, 8); a.sh.rotation.z = lerp(a.sh.rotation.z, (i ? 1 : -1) * 0.45, 8); a.el.rotation.x = lerp(a.el.rotation.x, 1.9, 8); });
      m.blaster.visible = false;
      torsoX = 0.15 + Math.sin(this.animT * 1.5) * 0.04;
    } else if (this.state === 'out') {
      hipsY = 0.25;
      L.forEach((l, i) => { l.thigh.rotation.x = lerp(l.thigh.rotation.x, 1.5, 6); l.knee.rotation.x = lerp(l.knee.rotation.x, -1.6, 6); l.thigh.rotation.z = (i ? -1 : 1) * 0.4; });
      A.forEach((a, i) => { a.sh.rotation.x = lerp(a.sh.rotation.x, 0.6, 6); a.sh.rotation.z = (i ? -1 : 1) * 0.2; a.el.rotation.x = lerp(a.el.rotation.x, 0.8, 6); });
      m.blaster.visible = false;
      torsoX = 0.3;
    } else {
      m.blaster.visible = true;
      L.forEach(l => { l.thigh.rotation.z = 0; });
      if (this.crouch) {
        hipsY = 0.62;
        const sw = sp > 0.3 ? Math.sin(ph) * 0.35 : 0;
        L[0].thigh.rotation.x = lerp(L[0].thigh.rotation.x, 1.0 + sw, 12); L[1].thigh.rotation.x = lerp(L[1].thigh.rotation.x, 0.5 - sw, 12);
        L[0].knee.rotation.x = lerp(L[0].knee.rotation.x, -1.4, 12); L[1].knee.rotation.x = lerp(L[1].knee.rotation.x, -1.9, 12);
        torsoX = 0.25;
      } else {
        const amp = Math.min(1, sp / 5) * (this.sprint ? 0.9 : 0.6);
        thighA = Math.sin(ph) * amp;
        L[0].thigh.rotation.x = lerp(L[0].thigh.rotation.x, thighA, 15); L[1].thigh.rotation.x = lerp(L[1].thigh.rotation.x, -thighA, 15);
        L[0].knee.rotation.x = lerp(L[0].knee.rotation.x, -Math.max(0, -Math.sin(ph)) * amp * 1.4, 15);
        L[1].knee.rotation.x = lerp(L[1].knee.rotation.x, -Math.max(0, Math.sin(ph)) * amp * 1.4, 15);
        hipsY = 0.92 - Math.abs(Math.cos(ph)) * amp * 0.06;
        torsoX = this.sprint ? 0.18 : 0.04;
      }
      if (this.char.id === 'jurgen' && this.swingT > 0) {
        const k = this.swingT;
        A.forEach(a => { a.sh.rotation.x = 2.6 - (1 - k) * 1.9; a.sh.rotation.z = 0; a.el.rotation.x = 0.3; });
        m.blaster.rotation.x = 1.3 - (1 - k) * 1.6;
      } else {
        // arms aiming forward with pitch
        const aimX = 1.45 + this.pitch * 0.9 - (this.sprint && sp > 3 ? 0.9 : 0);
        A[0].sh.rotation.x = lerp(A[0].sh.rotation.x, aimX, 14); A[1].sh.rotation.x = lerp(A[1].sh.rotation.x, aimX + 0.1, 14);
        A[0].sh.rotation.z = lerp(A[0].sh.rotation.z, 0.35, 10); A[1].sh.rotation.z = lerp(A[1].sh.rotation.z, -0.25, 10);
        A[0].el.rotation.x = lerp(A[0].el.rotation.x, 0.5, 10); A[1].el.rotation.x = lerp(A[1].el.rotation.x, 0.3, 10);
        m.blaster.rotation.x = lerp(m.blaster.rotation.x, this.pitch + (this.sprint && sp > 3 ? -0.8 : 0), 14);
      }
      if (this.weapon.reloading > 0) { m.blaster.rotation.z = Math.sin(this.animT * 10) * 0.3; } else m.blaster.rotation.z = 0;
    }
    if (this.hurtT > 0) { torsoX -= this.hurtT * 0.6; }
    if (this.stumble > 0) { torsoX += 0.7; hipsY -= 0.3; }
    m.hips.position.y = lerp(m.hips.position.y, hipsY, 10);
    m.torso.rotation.x = lerp(m.torso.rotation.x, -torsoX, 10);
    m.neck.rotation.x = lerp(m.neck.rotation.x, this.state === 'alive' ? this.pitch * 0.6 + torsoX * 0.8 : 0.3, 10);
    m.blaster.position.y = 0.32;
  }

  setVisible(v) { this.model.root.visible = v; }

  dispose() { this.game.scene.remove(this.model.root); }
}
