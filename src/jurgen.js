// Jürgen: neutral NPC with a katana who guards his forest base from everyone.
import * as THREE from '../lib/three.module.min.js';
import { Actor } from './actor.js';
import { JURGEN, pickLine } from './characters.js';

const rand = (a, b) => a + Math.random() * (b - a);

export class Jurgen {
  constructor(game, base) {
    this.g = game; this.base = base;
    const a = this.actor = new Actor({ ...JURGEN, speed: 1.12, weapon: 'striker' }, -1, game);
    a.neutral = true; a.lives = 99; a.radius = 0.33;
    a.pos.set(base.fire.x + 1.5, base.y, base.fire.z);
    this.mode = 'guard'; this.target = null; this.modeT = 0;
    this.wanderPt = null; this.path = null; this.pi = 0; this.repathT = 0;
    this.strikeCd = 0; this.windup = 0;
    this.hits = []; this.lastAttacker = null;
    this.lineT = 0; this.idleT = rand(10, 20);
    this.noise = null;
    a.swingT = 0;
    a.model.root.scale.setScalar(1.08);
  }

  get pos() { return this.actor.pos; }

  inZone(p, extra = 0) { return Math.hypot(p.x - this.base.x, p.z - this.base.z) < this.base.r + extra; }

  say(key, force = false) {
    if (!force && this.g.time - this.lineT < 3.5) return;
    this.lineT = this.g.time;
    const text = pickLine(JURGEN, key);
    this.g.speak(this.actor, text, false);
  }

  hear(pos) {
    if (this.mode !== 'guard' && this.mode !== 'return') return;
    if (this.inZone(pos, 14) && !this.inZone(pos)) { this.noise = pos.clone(); this.setMode('investigate'); this.say('investigate'); }
  }

  onHit(shooter) {
    const g = this.g;
    if (this.mode === 'stunned') return;
    this.hits.push(g.time);
    this.hits = this.hits.filter(t => g.time - t < 25);
    this.lastAttacker = shooter && !shooter.isTrap ? shooter : this.lastAttacker;
    g.audio.impact(this.pos.clone().setY(this.pos.y + 1.2), 'body');
    if (this.hits.length >= 4) {
      this.setMode('stunned'); this.say('stunned', true);
      this.actor.state = 'downed';
      g.logEvent(`${shooter?.name || 'Someone'} actually stunned JÜRGEN. Respect.`, 'jurgen');
      g.hud.flashEvent('JÜRGEN IS DOWN (FOR NOW)');
      return;
    }
    if (shooter && shooter.state === 'alive' && (this.mode === 'guard' || this.mode === 'return' || this.mode === 'investigate')) {
      // provoked: chase the attacker if they are not too far
      if (shooter.pos.distanceTo(this.pos) < this.base.r + 22) { this.target = shooter; this.setMode('chase'); this.say('alert', true); }
    }
  }

  setMode(m) { this.mode = m; this.modeT = 0; this.path = null; }

  moveTo(dt, target, sprint) {
    const a = this.actor, W = this.g.world;
    this.repathT -= dt;
    if (!this.path || this.repathT <= 0) {
      this.repathT = 0.6;
      this.path = W.findPath(a.pos, target, null, 20000); this.pi = 1;
    }
    if (!this.path || this.pi >= this.path.length) {
      const dx = target.x - a.pos.x, dz = target.z - a.pos.z, d = Math.hypot(dx, dz);
      if (d > 0.3) a.moveIntent.set(dx / d, 0, dz / d); else a.moveIntent.set(0, 0, 0);
      return d;
    }
    const wp = this.path[this.pi];
    const dx = wp.x - a.pos.x, dz = wp.z - a.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.5) this.pi++;
    a.moveIntent.set(dx / (d || 1), 0, dz / (d || 1));
    a.sprint = sprint;
    this.faceYaw = Math.atan2(-dx, -dz);
    return target.distanceTo(a.pos);
  }

  update(dt) {
    const g = this.g, a = this.actor;
    this.modeT += dt;
    this.strikeCd -= dt;
    a.swingT = Math.max(0, a.swingT - dt * 3);
    a.moveIntent.set(0, 0, 0); a.sprint = false;
    switch (this.mode) {
      case 'guard': {
        if (!this.wanderPt || this.wanderPt.distanceTo(a.pos) < 1 || this.modeT > 12) {
          this.modeT = 0;
          this.wanderPt = g.world.randomWalkable(Math.random, new THREE.Vector3(this.base.x, 0, this.base.z), this.base.r - 3);
          this.path = null;
        }
        if (this.modeT > 4) this.moveTo(dt, this.wanderPt, false);
        a.moveIntent.multiplyScalar(0.55);
        this.idleT -= dt;
        if (this.idleT <= 0) { this.idleT = rand(14, 26); if (g.viewActor && g.viewActor.pos.distanceTo(a.pos) < 25) this.say('idle'); }
        this.scanForIntruders();
        break;
      }
      case 'investigate': {
        const d = this.moveTo(dt, this.noise, false);
        if (d < 1.5 || this.modeT > 10) { a.moveIntent.set(0, 0, 0); this.faceYaw = (this.faceYaw || 0) + dt * 1.5; if (this.modeT > 13) this.setMode('return'); }
        this.scanForIntruders(6);
        break;
      }
      case 'chase': {
        const t = this.target;
        const leash = Math.hypot(a.pos.x - this.base.x, a.pos.z - this.base.z) > this.base.r + 16;
        if (!t || t.state !== 'alive' || leash || this.modeT > 16) { this.say('return'); this.target = null; this.setMode('return'); break; }
        if (this.modeT > 0.4 && Math.random() < dt * 0.25) this.say('chase');
        const d = t.pos.distanceTo(a.pos);
        if (this.windup > 0) {
          this.windup -= dt;
          a.moveIntent.set(0, 0, 0);
          this.faceYaw = Math.atan2(-(t.pos.x - a.pos.x), -(t.pos.z - a.pos.z));
          if (this.windup <= 0) {
            a.swingT = 1;
            g.audio.swoosh(a.pos.clone().setY(a.pos.y + 1.4));
            if (t.pos.distanceTo(a.pos) < 2.1 && t.state === 'alive') {
              this.say('strike', true);
              g.applyHit(t, a, 'katana');
              const dx = t.pos.x - a.pos.x, dz = t.pos.z - a.pos.z, dd = Math.hypot(dx, dz) || 1;
              t.vel.x += dx / dd * 6; t.vel.z += dz / dd * 6; t.vel.y = 3;
              this.strikeCd = 1.4;
              if (Math.random() < 0.45) { this.target = null; this.setMode('return'); this.say('return', true); }
            } else this.strikeCd = 0.8;
          }
          break;
        }
        if (d < 1.8 && this.strikeCd <= 0) { this.windup = 0.38; break; }
        this.path = null;
        const dx = t.pos.x - a.pos.x, dz = t.pos.z - a.pos.z;
        if (d < 6 && g.world.lineOfSight(a.eyePos(new THREE.Vector3()), t.chestPos(new THREE.Vector3()))) { a.moveIntent.set(dx / d, 0, dz / d); a.sprint = true; this.faceYaw = Math.atan2(-dx, -dz); }
        else { this.repathT = 0; this.moveTo(dt, t.pos, true); }
        break;
      }
      case 'return': {
        const home = this.base.fire;
        const d = this.moveTo(dt, home, false);
        if (d < 2.5 || this.modeT > 20) this.setMode('guard');
        this.scanForIntruders();
        break;
      }
      case 'stunned': {
        if (this.modeT > 15) {
          a.state = 'alive'; this.hits = [];
          this.target = this.lastAttacker && this.lastAttacker.state === 'alive' ? this.lastAttacker : null;
          this.setMode(this.target ? 'chase' : 'return');
          this.say('alert', true);
          g.hud.flashEvent('JÜRGEN IS BACK. AND ANGRY.');
        }
        break;
      }
    }
    if (this.faceYaw !== undefined && this.mode !== 'stunned') {
      const dy = Math.atan2(Math.sin(this.faceYaw - a.yaw), Math.cos(this.faceYaw - a.yaw));
      a.yaw += dy * Math.min(1, dt * 8);
    }
    a.physics(dt);
    a.animate(dt);
    const vd = g.viewActor ? g.viewActor.pos.distanceTo(a.pos) : 99;
    a.setNameTag(vd < 22, '#ff5040');
  }

  scanForIntruders(extra = 0) {
    const g = this.g;
    let best = null, bd = 1e9;
    for (const o of g.actors) {
      if (o.neutral || o.state !== 'alive') continue;
      if (!this.inZone(o.pos, extra)) continue;
      const d = o.pos.distanceTo(this.pos);
      if (d < bd) { bd = d; best = o; }
    }
    if (best) {
      this.target = best; this.setMode('chase'); this.say('alert', true);
      g.onJurgenAggro(best);
    }
  }
}
