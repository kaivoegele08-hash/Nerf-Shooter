// AI brains for the friend group: perception, team intel, cover, flanking, reviving, hunting, hiding, traps.
import * as THREE from '../lib/three.module.min.js';
import { ballisticDir } from './weapons.js';

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
const rand = (a, b) => a + Math.random() * (b - a);
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export class AIController {
  constructor(actor, game) {
    this.a = actor; this.g = game; this.p = actor.char.ai;
    this.state = 'idle'; this.stateT = 0;
    this.path = null; this.pi = 0; this.goal = null; this.goalKey = '';
    this.repathT = 0;
    this.meters = new Map();
    this.memory = new Map();
    this.visible = [];
    this.target = null;
    this.thinkT = Math.random() * 0.4; this.perceiveT = Math.random() * 0.15;
    this.reactT = 0; this.trackT = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1; this.strafeT = 0;
    this.suspect = null;
    this.order = null;
    this.lastHurt = -99; this.lastThreat = null;
    this.scanT = 0; this.scanYaw = actor.yaw;
    this.stuckT = 0; this.lastPos = actor.pos.clone();
    this.hideSpot = null; this.setupDone = false; this.setupStep = 0;
    this.searchIdx = Math.floor(Math.random() * 10); this.lookAroundT = 0;
    this.chaosT = rand(8, 20);
    this.idleLineT = rand(15, 40);
    this.downCallT = 3;
    this.desiredYaw = actor.yaw; this.desiredPitch = 0;
    this.burstLeft = 0;
  }

  get diff() { return this.g.settings.difficulty; } // 0 easy, 1 normal, 2 hard

  // ---------------- perception ----------------
  enemies() { return this.g.actors.filter(e => e.team !== this.a.team && !e.neutral && e.state === 'alive'); }
  allies() { return this.g.actors.filter(e => e.team === this.a.team && e !== this.a && !e.neutral); }

  perceive(dt) {
    const a = this.a, g = this.g, W = g.world;
    const eye = a.eyePos(tmpA);
    const fwdYaw = a.yaw;
    const range = g.map.indoor ? 32 : (g.map.ambient === 'forestmist' ? 34 : g.map.ambient === 'field' ? 75 : 60);
    const light = g.map.lightLevel || 1;
    this.visible.length = 0;
    for (const e of this.enemies()) {
      const d = e.pos.distanceTo(a.pos);
      let m = this.meters.get(e.id) || 0;
      if (d > range) { this.meters.set(e.id, Math.max(0, m - dt)); continue; }
      const dx = e.pos.x - a.pos.x, dz = e.pos.z - a.pos.z;
      const ang = Math.abs(angDiff(Math.atan2(-dx, -dz), fwdYaw));
      const inFov = ang < 1.1 || d < 2.2;
      if (!inFov) { this.meters.set(e.id, Math.max(0, m - dt * 0.5)); continue; }
      const head = e.eyePos(tmpB); const chest = e.chestPos(tmpC);
      const los = W.lineOfSight(eye, head) || W.lineOfSight(eye, chest);
      if (!los) { this.meters.set(e.id, Math.max(0, m - dt * 0.6)); continue; }
      let vis = light;
      if (e.crouch) vis *= 0.55;
      if ((e.speed || 0) < 0.3) vis *= 0.6; else if (e.sprint) vis *= 1.3;
      if (g.inBush(e.pos)) vis *= 0.35;
      if (e.lastShotAt > g.time - 1) vis *= 2.5;
      if (ang > 0.6) vis *= 0.5;
      const rate = vis * 9 / (1 + d * 0.22) * (0.75 + 0.25 * this.diff);
      m = Math.min(1.5, m + rate * dt);
      this.meters.set(e.id, m);
      if (m >= 1) {
        const prev = this.memory.get(e.id);
        const fresh = !prev || g.time - prev.t > 6;
        this.memory.set(e.id, { actor: e, pos: e.pos.clone(), t: g.time, seen: true });
        this.visible.push(e);
        g.shareIntel(a.team, e, a, fresh);
      }
    }
    // Jürgen awareness
    if (g.jurgen) {
      const j = g.jurgen;
      this.jurgenThreat = (j.target === a && j.mode === 'chase') || (j.mode === 'chase' && j.pos.distanceTo(a.pos) < 7);
    }
  }

  hear(pos, src, kind, radius) {
    if (this.a.state !== 'alive') return;
    if (src && src.team === this.a.team) return;
    const d = pos.distanceTo(this.a.pos);
    const err = d * 0.15;
    const p = pos.clone(); p.x += rand(-err, err); p.z += rand(-err, err);
    if (!this.suspect || this.g.time - this.suspect.t > 2 || kind === 'alarm' || kind === 'shot') this.suspect = { pos: p, t: this.g.time, kind };
    if (kind === 'shot' && src && src.team !== undefined && d < radius * 0.5) {
      // close gunshot: rough position knowledge
      const prev = this.memory.get(src.id);
      if (!prev || this.g.time - prev.t > 1.5) this.memory.set(src.id, { actor: src, pos: p, t: this.g.time - 1, seen: false });
    }
  }

  onHurt(shooter) {
    const g = this.g;
    this.lastHurt = g.time;
    if (shooter && shooter.pos) {
      this.lastThreat = shooter.pos.clone();
      if (shooter.team !== undefined && shooter.team >= 0 && !shooter.neutral && !shooter.isTrap) {
        this.memory.set(shooter.id, { actor: shooter, pos: shooter.pos.clone(), t: g.time, seen: false });
        this.meters.set(shooter.id, Math.max(this.meters.get(shooter.id) || 0, 0.8));
        g.addDanger(this.a.team, shooter.pos);
      }
    }
    this.thinkT = 0;
  }

  freshestKnown(maxAge = 14) {
    const g = this.g;
    let best = null;
    const consider = (rec) => {
      if (!rec || g.time - rec.t > maxAge) return;
      if (rec.actor && rec.actor.state !== 'alive') return;
      const score = (g.time - rec.t) + rec.pos.distanceTo(this.a.pos) * 0.15;
      if (!best || score < best.score) best = { ...rec, score };
    };
    for (const rec of this.memory.values()) consider(rec);
    for (const rec of g.intel[this.a.team].values()) consider(rec);
    return best;
  }

  // ---------------- decision ----------------
  think() {
    const a = this.a, g = this.g, p = this.p;
    const prevState = this.state;
    const enemiesVisible = this.visible.filter(e => e.state === 'alive');
    // ---- hunt prep ----
    if (g.mode === 'hunt' && g.phase === 'prep') {
      if (a.team === g.hunterTeam) { this.setState('wait'); return; }
      this.setState('setup'); return;
    }
    // ---- following player orders ----
    // ---- Jürgen ----
    if (this.jurgenThreat) { this.setState('flee'); return; }
    // ---- revive ----
    const downed = this.allies().filter(m => m.state === 'downed' && (!m.reviver || m.reviver === a));
    if (downed.length) {
      let best = null, bd = 1e9;
      for (const m of downed) { const d = m.pos.distanceTo(a.pos); if (d < bd) { bd = d; best = m; } }
      // closest healthy ally should go, medics always go
      const others = this.allies().filter(m => m.state === 'alive' && m.controller && m !== a);
      const closerAlly = others.some(o => o.pos.distanceTo(best.pos) < bd - 3 && o.controller.state !== 'revive' && o.controller.p.revive > 0.3);
      const nearbyThreat = enemiesVisible.some(e => e.pos.distanceTo(best.pos) < 6);
      const bravery = p.revive + (this.diff * 0.1);
      if ((p.revive >= 0.95 || !closerAlly || bd < 4) && (!nearbyThreat || Math.random() < bravery * 0.4) && bd < (g.map.indoor ? 40 : 75)) {
        this.reviveTarget = best;
        this.setState('revive'); return;
      }
    }
    // ---- combat ----
    if (enemiesVisible.length) {
      let best = null, bs = 1e9;
      for (const e of enemiesVisible) {
        const s = e.pos.distanceTo(a.pos) - (3 - e.lives) * 2 + (e === this.target ? -3 : 0) + (e.isPlayer ? -1 : 0);
        if (s < bs) { bs = s; best = e; }
      }
      if (best !== this.target) { this.target = best; this.reactT = p.reaction * [1.6, 1.0, 0.7][this.diff] + rand(0, 0.15); this.trackT = 0; }
      const hurtRecently = g.time - this.lastHurt < 1.6;
      const reloading = a.weapon.reloading > 0 || a.weapon.mag === 0;
      if ((reloading && Math.random() > p.aggression * 0.7) || (hurtRecently && Math.random() > p.aggression) || (a.lives === 1 && !a.revived && Math.random() < p.patience * 0.3)) {
        this.setState('cover'); return;
      }
      if (this.state === 'cover' && this.stateT < 1.2 && reloading) return;
      this.setState('engage'); return;
    }
    this.target = null;
    // ---- player orders ----
    if (this.order && g.time - this.order.t < 40) {
      if (this.order.type === 'follow') { this.setState('follow'); return; }
      if (this.order.type === 'hold') { this.setState('hold'); return; }
      if (this.order.type === 'push') { this.setState('push'); return; }
    }
    const known = this.freshestKnown();
    // ---- Hunt mode ----
    if (g.mode === 'hunt') {
      if (a.team === g.hunterTeam) {
        if (known) { this.huntTarget = known.pos.clone(); this.setState('hunt'); return; }
        if (this.suspect && g.time - this.suspect.t < 10) { this.huntTarget = this.suspect.pos.clone(); this.setState('hunt'); return; }
        const fp = g.footprintNear(a.pos, 7, a.team);
        if (fp) { this.huntTarget = fp; this.setState('hunt'); return; }
        this.setState('sweep'); return;
      } else {
        // defenders: ambush if enemy close, otherwise stay hidden, run to extraction near the end
        if (g.extractionOpen && (p.patience < 0.8 || g.timeLeft < 30) && !known) { this.setState('extract'); return; }
        if (known && known.pos.distanceTo(a.pos) < 9 + p.aggression * 10 && Math.random() < p.aggression + 0.3) { this.huntTarget = known.pos.clone(); this.setState('hunt'); return; }
        if (known && known.pos.distanceTo(a.pos) < 6) { this.setState('relocate'); return; }
        this.setState('hide'); return;
      }
    }
    // ---- TDM ----
    if (known) {
      const teamAlive = this.allies().filter(m => m.state === 'alive').length;
      const isFlanker = g.teamState[a.team].flanker === a.id;
      if (prevState === 'flank' && this.stateT < 14 && this.path) return;
      if (isFlanker && teamAlive >= 1) { this.flankAround(known.pos); return; }
      if (p.camp > 0.6 && Math.random() < p.camp && known.pos.distanceTo(a.pos) > 6) { this.setState('ambush'); this.ambushFocus = known.pos.clone(); return; }
      this.huntTarget = known.pos.clone(); this.setState('push'); return;
    }
    if (this.suspect && g.time - this.suspect.t < 8) { this.huntTarget = this.suspect.pos.clone(); this.setState('investigate'); return; }
    if (p.camp > 0.7 && Math.random() < 0.8) { this.setState('ambush'); return; }
    this.setState('advance');
  }

  setState(s) {
    if (this.state !== s) { this.state = s; this.stateT = 0; this.path = null; this.goal = null; this.onEnter(s); }
  }

  onEnter(s) {
    const a = this.a, g = this.g;
    if (s === 'revive' && this.reviveTarget) g.voice(a, 'revive', { ally: this.reviveTarget.name });
    if (s === 'flank') g.voice(a, 'flank', {});
    if (s === 'cover' && a.weapon.reloading > 0) g.voice(a, 'reload', {});
    if (s === 'flee') g.voice(a, 'jurgen', {}, { force: true });
  }

  flankAround(pos) {
    const a = this.a, W = this.g.world;
    const dx = pos.x - a.pos.x, dz = pos.z - a.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const px = -dz / d, pz = dx / d;
    const side = Math.random() < 0.5 ? 1 : -1;
    const off = Math.min(12, Math.max(5, d * 0.6));
    let fp = new THREE.Vector3(pos.x + px * off * side - dx / d * 2, 0, pos.z + pz * off * side - dz / d * 2);
    if (!W.walkableAt(fp.x, fp.z)) fp = new THREE.Vector3(pos.x - px * off * side, 0, pos.z - pz * off * side);
    this.flankPoint = fp; this.flankFocus = pos.clone();
    this.setState('flank');
  }

  // ---------------- per-frame ----------------
  update(dt) {
    const a = this.a, g = this.g;
    if (a.state === 'out') return;
    if (a.state === 'downed') {
      a.moveIntent.set(0, 0, 0); a.sprint = false;
      a.yaw += Math.sin(g.time * 0.7 + a.id) * dt * 0.6;
      this.downCallT -= dt;
      if (this.downCallT <= 0) { this.downCallT = rand(10, 16); g.voice(a, 'down', { zone: g.world.zoneName(a.pos.x, a.pos.z) }); }
      return;
    }
    this.perceiveT -= dt;
    if (this.perceiveT <= 0) { this.perceive(0.12 - this.perceiveT); this.perceiveT = 0.12; }
    this.thinkT -= dt;
    if (this.thinkT <= 0) { this.thinkT = 0.3 + Math.random() * 0.15; this.think(); }
    this.stateT += dt;
    a.forceStand = true;
    a.ads = false;
    switch (this.state) {
      case 'wait': this.doWait(dt); break;
      case 'setup': this.doSetup(dt); break;
      case 'engage': this.doEngage(dt); break;
      case 'cover': this.doCover(dt); break;
      case 'revive': this.doRevive(dt); break;
      case 'flee': this.doFlee(dt); break;
      case 'flank': this.doMoveTo(dt, this.flankPoint, { sprint: true, look: this.flankFocus, arrive: () => { this.huntTarget = this.flankFocus; this.setState('push'); } }); break;
      case 'push': case 'hunt': case 'investigate': this.doMoveTo(dt, this.huntTarget, { sprint: this.state === 'push' && this.p.aggression > 0.6, careful: true, arrive: () => this.lookAround(dt) }); break;
      case 'advance': this.doAdvance(dt); break;
      case 'ambush': this.doAmbush(dt); break;
      case 'sweep': this.doSweep(dt); break;
      case 'hide': this.doHide(dt); break;
      case 'relocate': this.doRelocate(dt); break;
      case 'extract': this.doMoveTo(dt, g.map.extraction, { sprint: true }); break;
      case 'follow': this.doFollow(dt); break;
      case 'hold': this.doHold(dt); break;
      default: this.doAdvance(dt);
    }
    this.chaos(dt);
    this.applyAim(dt);
    this.stuckCheck(dt);
    this.idleChatter(dt);
  }

  // ---------- movement helpers ----------
  costFn() {
    const g = this.g, team = this.a.team, a = this.a;
    const danger = g.danger[team];
    const jb = g.map.jurgenBase;
    const chaotic = this.p.chaos > 0.9 && Math.random() < 0.05;
    return (x, z) => {
      let c = 0;
      if (jb && !chaotic) { const d = Math.hypot(x - jb.x, z - jb.z); if (d < jb.r + 3) c += 30; }
      for (const dp of danger) { const dd = (x - dp.x) ** 2 + (z - dp.z) ** 2; if (dd < 36) c += dp.w * 3 * (1 - dd / 36); }
      return c;
    };
  }

  doMoveTo(dt, target, opts = {}) {
    const a = this.a, g = this.g, W = g.world;
    if (!target) { this.halt(); return; }
    const key = Math.round(target.x * 2) + ',' + Math.round(target.z * 2);
    this.repathT -= dt;
    if (!this.path || (key !== this.goalKey && this.repathT <= 0)) {
      this.goalKey = key; this.repathT = 0.8;
      this.path = W.findPath(a.pos, target, this.costFn(), 25000);
      this.pi = 1;
      if (!this.path) { this.halt(); this.path = null; this.repathT = 1.5; opts.arrive?.(); return; }
    }
    const P = this.path;
    if (this.pi >= P.length) { this.halt(); opts.arrive?.(); return; }
    const wp = P[this.pi];
    const dx = wp.x - a.pos.x, dz = wp.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.45) { this.pi++; if (this.pi >= P.length) { this.halt(); opts.arrive?.(); } return; }
    a.moveIntent.set(dx / d, 0, dz / d);
    const remaining = this.pathRemaining();
    a.sprint = !!opts.sprint && remaining > 4 && a.stamina > 0.25;
    if (opts.careful && remaining < 6) a.sprint = false;
    a.crouch = !!opts.crouch;
    if (opts.crouch) a.forceStand = false;
    // look direction
    const look = opts.look && remaining < 10 ? opts.look : null;
    if (look) this.lookAt(look, 0.2); else this.desiredYaw = Math.atan2(-dx, -dz), this.desiredPitch = 0;
  }
  pathRemaining() {
    if (!this.path) return 0;
    let s = 0, prev = this.a.pos;
    for (let i = this.pi; i < this.path.length; i++) { s += Math.hypot(this.path[i].x - prev.x, this.path[i].z - prev.z); prev = this.path[i]; }
    return s;
  }
  halt() { this.a.moveIntent.set(0, 0, 0); this.a.sprint = false; }
  lookAt(p, yOff = 1.2) {
    const a = this.a; const e = a.eyePos(tmpA);
    const dx = p.x - e.x, dz = p.z - e.z, dy = (p.y + yOff) - e.y;
    this.desiredYaw = Math.atan2(-dx, -dz);
    this.desiredPitch = Math.atan2(dy, Math.hypot(dx, dz));
  }
  lookAround(dt) {
    this.halt();
    this.lookAroundT += dt;
    this.desiredYaw += dt * 1.6 * Math.sin(this.lookAroundT * 0.8 + this.a.id);
    if (this.lookAroundT > 3) {
      this.lookAroundT = 0; this.huntTarget = null; this.suspect = null; this.thinkT = 0;
      // nothing here: forget stale intel around this spot so we move on
      this.g.clearIntelNear(this.a.team, this.a.pos, 6);
      for (const [k, v] of this.memory) if (v.pos.distanceTo(this.a.pos) < 6) this.memory.delete(k);
      this.setState('idle');
    }
  }

  applyAim(dt) {
    const a = this.a;
    const turn = (this.state === 'engage' ? 7 : 4.5) * (0.8 + this.p.aggression * 0.4);
    const dy = angDiff(this.desiredYaw, a.yaw);
    a.yaw += Math.sign(dy) * Math.min(Math.abs(dy), turn * dt) + dy * Math.min(1, 6 * dt) * 0.3;
    a.pitch += (this.desiredPitch - a.pitch) * Math.min(1, 8 * dt);
    this.aimError = Math.abs(dy);
  }

  stuckCheck(dt) {
    const a = this.a;
    const moving = Math.hypot(a.moveIntent.x, a.moveIntent.z) > 0.1;
    if (moving && a.pos.distanceTo(this.lastPos) < 0.6 * dt * 2) this.stuckT += dt; else this.stuckT = Math.max(0, this.stuckT - dt);
    this.lastPos.copy(a.pos);
    if (this.stuckT > 1.2) {
      this.stuckT = 0; this.path = null; this.repathT = 0;
      a.wantJump = true;
      a.moveIntent.set(rand(-1, 1), 0, rand(-1, 1));
    }
  }

  // ---------- combat ----------
  doEngage(dt) {
    const a = this.a, g = this.g, p = this.p, t = this.target;
    if (!t || t.state !== 'alive') { this.thinkT = 0; this.halt(); return; }
    const d = t.pos.distanceTo(a.pos);
    // aim point (ballistic)
    const eye = a.eyePos(tmpA);
    const lead = t.vel.clone().multiplyScalar(Math.min(0.6, d / a.weapon.def.speed) * (0.4 + 0.6 * p.accuracy));
    const aimPt = t.chestPos(tmpB).add(lead);
    const dir = ballisticDir(eye, aimPt, a.weapon.def.speed);
    this.desiredYaw = Math.atan2(-dir.x, -dir.z);
    this.desiredPitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    // movement style
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafeT = rand(0.5, 1.6) * (1.2 - p.aggression * 0.4); if (Math.random() < 0.6) this.strafeDir *= -1; this.crouchPeek = Math.random() < p.patience * 0.6; }
    const fx = (t.pos.x - a.pos.x) / (d || 1), fz = (t.pos.z - a.pos.z) / (d || 1);
    let mx = -fz * this.strafeDir, mz = fx * this.strafeDir;
    let fwd = 0;
    if (d > p.range * 1.2) fwd = 0.8; else if (d < p.range * 0.5 && p.aggression < 0.7) fwd = -0.6; else if (p.aggression > 0.8) fwd = 0.5;
    mx += fx * fwd; mz += fz * fwd;
    const strafeAmt = 0.4 + p.aggression * 0.5;
    if (!g.world.walkableAt(a.pos.x + mx * 0.8, a.pos.z + mz * 0.8)) { this.strafeDir *= -1; mx = fx * fwd; mz = fz * fwd; }
    a.moveIntent.set(mx * strafeAmt, 0, mz * strafeAmt);
    a.sprint = p.aggression > 0.85 && d > 6;
    a.crouch = !!this.crouchPeek && d > 4 && !a.sprint;
    a.forceStand = !a.crouch;
    a.ads = p.patience > 0.6 && d > 8;
    if (a.crouch) a.moveIntent.multiplyScalar(0.4);
    // fire
    if (this.reactT > 0) { this.reactT -= dt; return; }
    this.trackT += dt;
    if (a.weapon.mag === 0 && a.weapon.reloading <= 0) { g.startReload(a); return; }
    const visibleNow = this.visible.includes(t);
    const maxRange = a.weapon.def.speed * 1.35;
    if (visibleNow && d < maxRange && this.aimError < 0.08 + 1 / (d + 4)) {
      // aim error
      let err = 0.026 + (1 - p.accuracy) * 0.14 + Math.min(0.06, (t.speed || 0) * 0.009) + (a.speed > 1 ? 0.025 : 0) + d * 0.0015 + (t.crouch ? 0.01 : 0);
      err *= [1.7, 1.0, 0.6][this.diff];
      err *= Math.max(0.55, 1 - this.trackT * 0.25);
      if (g.time - this.lastHurt < 0.6) err *= 1.6;
      const shotDir = dir.clone();
      shotDir.x += rand(-err, err); shotDir.y += rand(-err, err) * 0.7; shotDir.z += rand(-err, err);
      shotDir.normalize();
      if (g.fireWeapon(a, shotDir)) {
        // trigger discipline: short pauses between volleys
        this.burstLeft--;
        if (this.burstLeft <= 0) { this.burstLeft = 2 + Math.floor(Math.random() * (a.weapon.def.auto ? 6 : 3)); this.reactT = rand(0.25, 0.7) * (1.2 - p.aggression * 0.5); }
      }
    }
  }

  doCover(dt) {
    const a = this.a, g = this.g;
    const threat = this.target ? this.target.pos : this.lastThreat;
    if (!this.coverPos || this.stateT < 0.05) this.coverPos = this.findCover(threat);
    if (a.weapon.mag < a.weapon.def.mag && a.weapon.reloading <= 0) g.startReload(a);
    if (this.coverPos) {
      const d = this.coverPos.distanceTo(a.pos);
      if (d > 0.5) this.doMoveTo(dt, this.coverPos, { sprint: d > 3 });
      else { this.halt(); a.crouch = true; a.forceStand = false; }
      if (threat && d < 3) this.lookAt(threat, 1.0);
    } else {
      // no cover: back away from threat
      if (threat) { const dx = a.pos.x - threat.x, dz = a.pos.z - threat.z, dd = Math.hypot(dx, dz) || 1; a.moveIntent.set(dx / dd, 0, dz / dd); this.lookAt(threat); }
      a.crouch = true; a.forceStand = false;
    }
    if (this.stateT > 2.5 + this.p.patience * 2 && a.weapon.reloading <= 0) { this.coverPos = null; this.thinkT = 0; this.setState('idle'); }
  }

  findCover(threat) {
    const a = this.a, W = this.g.world;
    if (!threat) return null;
    const te = new THREE.Vector3(threat.x, threat.y + 1.5, threat.z);
    let best = null, bs = 1e9;
    for (let i = 0; i < 26; i++) {
      const ang = (i / 26) * Math.PI * 2 + Math.random() * 0.2;
      const r = 1.5 + (i % 4) * 2;
      const x = a.pos.x + Math.cos(ang) * r, z = a.pos.z + Math.sin(ang) * r;
      if (!W.walkableAt(x, z)) continue;
      const y = W.ground(x, z);
      const crouchEye = tmpC.set(x, y + 1.0, z);
      if (W.lineOfSight(te, crouchEye)) continue; // exposed
      const distT = Math.hypot(x - threat.x, z - threat.z);
      const score = r * 1.2 - Math.min(distT, 15) * 0.15 + (distT < 4 ? 10 : 0) + this.g.dangerAt(a.team, x, z) * 2;
      if (score < bs) { bs = score; best = new THREE.Vector3(x, y, z); }
    }
    return best;
  }

  doRevive(dt) {
    const a = this.a, g = this.g, m = this.reviveTarget;
    if (!m || m.state !== 'downed') { this.thinkT = 0; this.setState('idle'); return; }
    if (m.reviver && m.reviver !== a) { this.thinkT = 0; this.setState('idle'); return; }
    const d = m.pos.distanceTo(a.pos);
    if (d > 1.1) { this.doMoveTo(dt, m.pos, { sprint: d > 3 }); g.stopRevive(a); return; }
    this.halt(); a.crouch = true; a.forceStand = false;
    this.lookAt(m.pos, 0.6);
    g.reviveTick(a, m, dt);
  }

  doFlee(dt) {
    const a = this.a, g = this.g, j = g.jurgen;
    if (!j) { this.setState('idle'); return; }
    if (!this.fleePt || this.stateT > 3 || this.fleePt.distanceTo(a.pos) < 1.5) {
      const dx = a.pos.x - j.pos.x, dz = a.pos.z - j.pos.z, dd = Math.hypot(dx, dz) || 1;
      this.fleePt = g.world.randomWalkable(Math.random, new THREE.Vector3(a.pos.x + dx / dd * 14, 0, a.pos.z + dz / dd * 14), 5);
      this.path = null;
    }
    this.doMoveTo(dt, this.fleePt, { sprint: true });
    // shoot back if very close and brave
    const d = j.pos.distanceTo(a.pos);
    if (d < 6 && this.p.aggression > 0.6) {
      this.lookAt(j.pos, 1.2);
      if (a.weapon.mag > 0 && this.aimError < 0.15) { const dir = ballisticDir(a.eyePos(tmpA), j.pos.clone().setY(j.pos.y + 1.2), a.weapon.def.speed); g.fireWeapon(a, dir); }
    }
    if (!this.jurgenThreat && this.stateT > 2) { this.thinkT = 0; this.setState('idle'); }
  }

  doAdvance(dt) {
    const a = this.a, g = this.g;
    if (!this.advanceGoal || this.advanceGoal.distanceTo(a.pos) < 2 || this.stateT > 25) {
      // move toward enemy side through interesting points
      const enemySpawn = g.map.spawns[1 - a.team][0];
      const pts = g.map.searchPoints;
      const cand = pts.filter(pt => pt.distanceTo(enemySpawn) < a.pos.distanceTo(enemySpawn) + 2);
      const list = cand.length ? cand : pts;
      this.advanceGoal = list[Math.floor(Math.random() * list.length)].clone();
      if (Math.random() < 0.3 + this.p.aggression * 0.3) this.advanceGoal = enemySpawn.clone();
      this.stateT = 0; this.path = null;
    }
    this.doMoveTo(dt, this.advanceGoal, { sprint: this.p.aggression > 0.7, careful: true });
  }

  doAmbush(dt) {
    const a = this.a, g = this.g;
    if (!this.ambushSpot || this.stateT > 40) {
      const pts = g.map.defensePoints;
      const base = pts[Math.floor(Math.random() * pts.length)];
      this.ambushSpot = this.findHideNear(base) || base.clone();
      this.stateT = 0;
    }
    const d = this.ambushSpot.distanceTo(a.pos);
    if (d > 0.8) { this.doMoveTo(dt, this.ambushSpot, { sprint: d > 10, careful: true }); return; }
    this.halt(); a.crouch = true; a.forceStand = false;
    this.scan(dt, this.ambushFocus);
  }

  scan(dt, focus) {
    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = rand(1.5, 3.5);
      if (focus && Math.random() < 0.6) { const a = this.a; this.scanYaw = Math.atan2(-(focus.x - a.pos.x), -(focus.z - a.pos.z)) + rand(-0.4, 0.4); }
      else this.scanYaw = this.a.yaw + rand(-1.6, 1.6);
    }
    this.desiredYaw = this.scanYaw; this.desiredPitch = rand(-0.02, 0.02);
  }

  findHideNear(base) {
    const W = this.g.world;
    for (let i = 0; i < 30; i++) {
      const p = W.randomWalkable(Math.random, base, 4);
      // prefer spots with cover around
      let cover = 0;
      for (let k = 0; k < 8; k++) {
        const ang = k / 8 * Math.PI * 2;
        const h = W.raycast(new THREE.Vector3(p.x, p.y + 0.8, p.z), new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang)), 2.5, 'sight');
        if (h) cover++;
      }
      if (cover >= 3 || i > 25) return p;
    }
    return null;
  }

  doSweep(dt) {
    const a = this.a, g = this.g;
    const pts = g.map.searchPoints;
    if (!this.sweepGoal) {
      // spread hunters across points
      const idx = (this.searchIdx + g.actors.indexOf(a) * 3) % pts.length;
      this.searchIdx++;
      this.sweepGoal = Math.random() < 0.45 ? g.world.randomWalkable(Math.random, a.pos, 22) : g.world.randomWalkable(Math.random, pts[idx], 8);
    }
    if (this.sweepGoal.distanceTo(a.pos) < 2 || this.stateT > 30) {
      this.lookAround(dt);
      if (this.lookAroundT === 0) { this.sweepGoal = null; this.stateT = 0; }
      return;
    }
    this.doMoveTo(dt, this.sweepGoal, { sprint: false, careful: true });
  }

  doHide(dt) {
    const a = this.a;
    if (!this.hideSpot) this.hideSpot = this.pickHideSpot();
    const d = this.hideSpot.distanceTo(a.pos);
    if (d > 0.8) { this.doMoveTo(dt, this.hideSpot, { sprint: d > 8 }); return; }
    this.halt(); a.crouch = true; a.forceStand = false;
    this.scan(dt, this.g.map.huntStart);
  }
  doRelocate(dt) {
    if (!this.relocSpot || this.stateT < 0.05) { this.relocSpot = this.pickHideSpot(true); }
    this.doMoveTo(dt, this.relocSpot, { sprint: true, arrive: () => { this.hideSpot = this.relocSpot; this.setState('hide'); } });
  }

  pickHideSpot(far = false) {
    const g = this.g, a = this.a;
    let pts = g.map.defensePoints;
    // bushes make great hiding spots outdoors
    if (!g.map.indoor) {
      const bushes = g.world.boxes.filter(b => b.tag === 'bush');
      const extra = [];
      for (let i = 0; i < 14 && bushes.length; i++) {
        const b = bushes[Math.floor(Math.random() * bushes.length)];
        const c = new THREE.Vector3((b.min.x + b.max.x) / 2, 0, (b.min.z + b.max.z) / 2);
        if (g.world.walkableAt(c.x, c.z) && c.distanceTo(g.map.huntStart) > 15) { c.y = g.world.ground(c.x, c.z); c.bush = true; extra.push(c); }
      }
      pts = pts.concat(extra);
    }
    const taken = g.actors.filter(o => o !== a && o.team === a.team && o.controller?.hideSpot).map(o => o.controller.hideSpot);
    let best = null, bs = -1e9;
    for (const pt of pts) {
      let s = Math.random() * 6 + pt.distanceTo(g.map.huntStart) * 0.08;
      for (const t of taken) if (t.distanceTo(pt) < 8) s -= 10;
      if (far) s += pt.distanceTo(a.pos) * 0.2;
      if (pt.bush) s += 2 + this.p.patience * 3;
      if (s > bs) { bs = s; best = pt; }
    }
    if (best && best.bush) return best.clone();
    return this.findHideNear(best || a.pos) || (best || a.pos).clone();
  }

  doSetup(dt) {
    const a = this.a, g = this.g;
    if (!this.hideSpot) this.hideSpot = this.pickHideSpot();
    const spot = this.hideSpot;
    const d = spot.distanceTo(a.pos);
    // place a tripwire on the way, roughly between the hunters' start and the hide spot
    if (this.setupStep === 0 && a.trapsLeft > 0 && d < 16 && d > 6 && this.p.trapper + 0.4 > Math.random()) {
      g.placeTrap(a, 'tripwire'); this.setupStep = 1;
    } else if (this.setupStep === 0 && d <= 6) this.setupStep = 1;
    if (d > 0.8) { this.doMoveTo(dt, spot, { sprint: true }); return; }
    this.halt();
    const hs = g.map.huntStart;
    const faceYaw = Math.atan2(-(hs.x - a.pos.x), -(hs.z - a.pos.z));
    if (this.setupStep === 1) {
      this.desiredYaw = faceYaw;
      if (Math.abs(angDiff(faceYaw, a.yaw)) < 0.2) {
        if (a.barricadesLeft > 0) g.placeBarricade(a);
        this.setupStep = 2;
      }
      return;
    }
    if (this.setupStep === 2) {
      if (a.trapsLeft > 0) { this.desiredYaw = faceYaw + rand(-0.8, 0.8); g.placeTrap(a, 'dart'); }
      this.setupStep = 3; return;
    }
    a.crouch = true; a.forceStand = false;
    this.scan(dt, hs);
  }

  doWait(dt) { this.halt(); this.desiredYaw += dt * 0.2; }

  doFollow(dt) {
    const a = this.a, pl = this.g.player;
    if (!pl || pl.state !== 'alive') { this.order = null; this.setState('idle'); return; }
    const d = pl.pos.distanceTo(a.pos);
    if (d > 3.2) this.doMoveTo(dt, pl.pos, { sprint: d > 8 });
    else { this.halt(); a.crouch = pl.crouch; this.scan(dt, null); }
  }
  doHold(dt) {
    const a = this.a;
    if (!this.order.pos) this.order.pos = a.pos.clone();
    const d = this.order.pos.distanceTo(a.pos);
    if (d > 1) this.doMoveTo(dt, this.order.pos, {});
    else { this.halt(); a.crouch = true; a.forceStand = false; this.scan(dt, null); }
  }

  // ---------- personality flavour ----------
  chaos(dt) {
    const a = this.a, g = this.g, p = this.p;
    if (p.chaos < 0.2) return;
    this.chaosT -= dt;
    if (this.chaosT > 0) return;
    this.chaosT = rand(10, 25) / p.chaos;
    const r = Math.random();
    if (r < 0.3 && a.speed > 3) { a.stumble = 1.1; g.voice(a, a.char.lines.trip ? 'trip' : 'hurt', {}, { force: true }); g.logEvent(`${a.name} tripped over absolutely nothing.`, 'funny'); }
    else if (r < 0.55) { a.wantJump = true; g.voice(a, 'taunt', {}); }
    else if (r < 0.75 && g.mode === 'tdm') { this.huntTarget = g.world.randomWalkable(); this.setState('investigate'); g.voice(a, 'flank', {}); }
  }

  idleChatter(dt) {
    this.idleLineT -= dt;
    if (this.idleLineT <= 0) {
      this.idleLineT = rand(25, 60);
      if (!this.target && this.a.state === 'alive') this.g.voice(this.a, 'idle', {});
    }
  }
}
