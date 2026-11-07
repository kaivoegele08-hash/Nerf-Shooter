// Match orchestration: teams, lives/downed/revive rules, game modes, combat resolution, voice/radio, events.
import * as THREE from '../lib/three.module.min.js';
import { World } from './world.js';
import { buildMap } from './maps.js';
import { CHARACTERS, charById, pickLine } from './characters.js';
import { Actor, TEAM_COLORS, TEAM_NAMES } from './actor.js';
import { AIController } from './ai.js';
import { DartSystem, TrapSystem } from './weapons.js';
import { Jurgen } from './jurgen.js';
import { Bodycam, CameraRig, Viewmodel } from './bodycam.js';

const rand = (a, b) => a + Math.random() * (b - a);
const TEAM_CSS = ['#ff8a2a', '#4a9bff'];

export class Game {
  constructor(renderer, audio, hud, settings) {
    this.renderer = renderer; this.audio = audio; this.hud = hud; this.settings = settings;
    this.camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.03, 400);
    this.bodycam = new Bodycam(renderer);
    this.rig = new CameraRig(this.camera);
    this.vm = new Viewmodel();
    this.running = false;
    this.session = { roundWins: {}, rounds: 0 };
  }

  resize(w, h) {
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.bodycam.setSize(s.x, s.y);
  }

  // ---------- teams ----------
  static rollTeams(playerId, mode) {
    const ids = CHARACTERS.map(c => c.id);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    const teams = [ids.slice(0, 4), ids.slice(4, 8)];
    const hunterTeam = Math.random() < 0.5 ? 0 : 1;
    return { teams, hunterTeam, playerTeam: teams[0].includes(playerId) ? 0 : 1 };
  }

  start(cfg) {
    this.cleanup();
    this.cfg = cfg;
    this.mode = cfg.mode; this.time = 0; this.running = true; this.over = false;
    const scene = this.scene = new THREE.Scene();
    const world = this.world = new World();
    this.map = buildMap(cfg.mapId, scene, world, Math.floor(Math.random() * 1e6));
    this.actors = []; this.intel = [new Map(), new Map()]; this.danger = [[], []];
    this.teamState = [{ flanker: null }, { flanker: null }];
    this.events = []; this.footprints = []; this.fpMeshes = [];
    this.darts = new DartSystem(this); this.traps = new TrapSystem(this);
    this.spectating = false; this.lastRadioT = -9; this.voiceTeamT = [-9, -9];
    this.hunterTeam = cfg.hunterTeam;
    this.extractionOpen = false; this.escaped = new Set();
    this.firstBlood = false;
    // actors
    for (let team = 0; team < 2; team++) {
      cfg.teams[team].forEach((id, i) => {
        const a = new Actor(charById(id), team, this);
        a.isPlayer = id === cfg.charId;
        if (!a.isPlayer) a.controller = new AIController(a, this);
        this.actors.push(a);
      });
    }
    this.player = this.actors.find(a => a.isPlayer);
    this.player.onLand = (vy) => { this.rig.landKick = Math.min(1, -vy / 10); this.audio.land(); };
    this.viewActor = this.player;
    this.placeTeams();
    // Jürgen
    this.jurgen = null;
    if (this.map.jurgenBase) {
      this.jurgen = new Jurgen(this, this.map.jurgenBase);
      this.jurgen.actor.controller = null;
      this.actors.push(this.jurgen.actor);
    }
    // phase
    if (this.mode === 'hunt') {
      this.phase = 'prep'; this.timeLeft = this.settings.prepTime;
      for (const a of this.actors) if (a.team === 1 - this.hunterTeam) { a.barricadesLeft = 2; a.trapsLeft = 2 + (a.char.traps ? 1 : 0); }
    } else { this.phase = 'live'; this.timeLeft = this.settings.tdmTime; }
    // camera / viewmodel
    this.camera.fov = this.settings.fov; this.camera.updateProjectionMatrix();
    this.vm.setWeapon(this.player.weapon.def, this.player.char);
    const indoor = this.map.indoor;
    this.vm.hemi.intensity = indoor ? 0.55 : 1.2; this.vm.dir.intensity = indoor ? 0.4 : 1.2;
    this.rig.yaw = this.player.yaw; this.rig.pitch = 0;
    this.player.setVisible(false);
    // audio
    this.audio.startAmbience(this.map.ambient);
    this.hud.setup(this);
    this.randomEventT = rand(40, 80);
    this.winCheckT = 1;
    // opening lines
    setTimeout(() => {
      if (!this.running) return;
      const mates = this.actors.filter(a => a.team === this.player.team && !a.isPlayer && !a.neutral);
      if (mates.length) this.voice(mates[Math.floor(Math.random() * mates.length)], 'start', {}, { force: true });
    }, 1500);
    if (this.mode === 'hunt') {
      const msg = this.player.team === this.hunterTeam ? 'YOU ARE A HUNTER · EYES CLOSED, COUNT IT DOWN' : 'YOU ARE HIDING · BUILD, TRAP, HIDE';
      this.hud.flashEvent(msg);
    } else this.hud.flashEvent(`TEAM ${TEAM_NAMES[this.player.team]} · ELIMINATE THE OTHER TEAM`);
  }

  placeTeams() {
    const W = this.world;
    for (let team = 0; team < 2; team++) {
      const members = this.actors.filter(a => a.team === team);
      members.forEach((a, i) => {
        let p;
        if (this.mode === 'hunt') {
          const c = team === this.hunterTeam ? this.map.huntStart : (this.map.hideStart || this.map.spawns[team][0]);
          p = W.randomWalkable(Math.random, c, 3.5);
        } else {
          const sp = this.map.spawns[team][i % this.map.spawns[team].length];
          const cell = W.nearestWalkable(sp.x, sp.z, 4);
          p = cell ? W.cellCenter(cell[0], cell[1]) : sp.clone();
        }
        a.pos.copy(p); a.pos.y = W.supportHeight(p.x, p.z, 0.2, p.y + 1);
        // face the enemy side / map centre
        const target = this.mode === 'hunt' ? new THREE.Vector3(0, 0, 0) : this.map.spawns[1 - team][0];
        a.yaw = Math.atan2(-(target.x - a.pos.x), -(target.z - a.pos.z));
        a.invuln = 2;
      });
    }
  }

  cleanup() {
    if (!this.scene) return;
    this.running = false;
    this.audio.stopAmbience(); this.audio.stopSpeech();
    this.scene.traverse(o => { if (o.geometry) o.geometry.dispose?.(); });
    this.scene = null;
  }

  // ---------- main update ----------
  update(dt, input) {
    if (!this.running) return;
    this.time += dt;
    // phase timers
    if (!this.over) {
      this.timeLeft -= dt;
      if (this.mode === 'hunt' && this.phase === 'prep') {
        if (this.timeLeft <= 5 && Math.ceil(this.timeLeft) !== this._beep) { this._beep = Math.ceil(this.timeLeft); this.audio.countdownBeep(this.timeLeft < 1); }
        if (this.timeLeft <= 0) this.beginHunt();
      } else if (this.mode === 'hunt' && !this.extractionOpen && this.timeLeft <= 60) {
        this.extractionOpen = true;
        this.hud.flashEvent('EXTRACTION OPEN · HIDERS CAN ESCAPE');
        this.hud.event(`Extraction point is open at ${this.world.zoneName(this.map.extraction.x, this.map.extraction.z)}`, 'sys');
        this.showExtraction();
      }
      if (this.timeLeft <= 0 && this.phase === 'live') this.timeUp();
    }
    // player
    this.updatePlayer(dt, input);
    // AI
    for (const a of this.actors) {
      if (a.neutral || a.isPlayer) continue;
      if (a.controller) a.controller.update(dt);
      if (this.mode === 'hunt' && this.phase === 'prep' && a.team === this.hunterTeam) { a.moveIntent.set(0, 0, 0); }
      this.updateActorCommon(a, dt);
    }
    if (this.jurgen) this.jurgen.update(dt);
    this.updateTeamBrains(dt);
    this.darts.update(dt);
    this.traps.update(dt);
    this.updateMisc(dt);
    // win check
    this.winCheckT -= dt;
    if (this.winCheckT <= 0 && !this.over) { this.winCheckT = 0.5; this.checkWin(); }
  }

  updateActorCommon(a, dt) {
    a.invuln = Math.max(0, a.invuln - dt);
    a.hurtT = Math.max(0, a.hurtT - dt * 2.5);
    const w = a.weapon;
    w.cd = Math.max(0, w.cd - dt);
    if (w.jammed > 0) { w.jammed -= dt; if (w.jammed <= 0) w.jammed = 0; }
    if (w.reloading > 0) { w.reloading -= dt; if (w.reloading <= 0) { w.reloading = 0; w.mag = w.def.mag; } }
    if (a.state === 'downed') {
      if (!a.reviver) a.reviveProgress = Math.max(0, a.reviveProgress - dt * 0.15);
      a.downedT -= dt;
      if (a.reviver && (a.reviver.state !== 'alive' || a.reviver.pos.distanceTo(a.pos) > 1.6)) a.reviver = null;
      if (a.downedT <= 0) this.eliminate(a, null, 'bled out');
    }
    a.physics(dt);
    a.animate(dt);
    // hunt: escape via extraction
    if (this.mode === 'hunt' && this.extractionOpen && a.team !== this.hunterTeam && a.state === 'alive' && a.pos.distanceTo(this.map.extraction) < 3.2) {
      this.escape(a);
    }
    // name tags for teammates
    if (!a.isPlayer || this.spectating) {
      const pt = this.player.team;
      const show = a.team === pt && a !== this.viewActor && !this.escaped.has(a) && a.state !== 'out' && a.pos.distanceTo(this.viewActor.pos) < (a.state === 'downed' ? 80 : 30);
      a.setNameTag(show, a.state === 'downed' ? '#ff5050' : TEAM_CSS[a.team]);
    }
  }

  updatePlayer(dt, input) {
    const p = this.player;
    const s = this.settings;
    const frozen = (this.mode === 'hunt' && this.phase === 'prep' && p.team === this.hunterTeam) || this.over;
    // look
    if (!this.spectating) {
      const sens = s.sensitivity * 0.0022 * (p.ads ? 0.6 : 1);
      p.yaw -= input.mdx * sens;
      p.pitch = Math.max(-1.4, Math.min(1.4, p.pitch - input.mdy * sens * (s.invertY ? -1 : 1)));
    }
    if (p.state === 'alive' && !frozen) {
      const k = input.keys;
      let fx = 0, fz = 0;
      if (k.has('KeyW')) fz -= 1; if (k.has('KeyS')) fz += 1; if (k.has('KeyA')) fx -= 1; if (k.has('KeyD')) fx += 1;
      const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      // forward = (-sin, -cos); right = (cos, -sin)
      const mx = fx * cy + fz * sy, mz = -fx * sy + fz * cy;
      p.moveIntent.set(mx, 0, mz);
      p.sprint = k.has('ShiftLeft') && fz < 0;
      p.crouch = k.has('KeyC') || k.has('ControlLeft');
      p.forceStand = !p.crouch;
      p.ads = input.ads;
      if (input.pressed.has('Space')) p.wantJump = true;
      // fire
      const w = p.weapon;
      if ((w.def.auto ? input.fire : input.firePressed)) {
        if (w.mag === 0 && w.reloading <= 0 && input.firePressed) { this.audio.click(); this.startReload(p); }
        else this.fireWeapon(p, null);
      }
      if (input.pressed.has('KeyR')) this.startReload(p);
      // interact: revive
      this.playerInteract(dt, input);
      // gear
      if (input.pressed.has('KeyG') && p.trapsLeft > 0) this.placeTrap(p, 'dart');
      if (input.pressed.has('KeyT') && p.trapsLeft > 0) this.placeTrap(p, 'tripwire');
      if (input.pressed.has('KeyF') && p.barricadesLeft > 0) this.placeBarricade(p);
      // commands
      if (input.pressed.has('Digit1')) this.command('follow');
      if (input.pressed.has('Digit2')) this.command('hold');
      if (input.pressed.has('Digit3')) this.command('push');
      if (input.pressed.has('KeyZ') || input.pressed.has('KeyQ')) this.callout();
      if (input.pressed.has('KeyV')) this.voice(p, 'taunt', {}, { force: true });
    } else {
      p.moveIntent.set(0, 0, 0); p.sprint = false; p.ads = false;
      this.hud.prompt(null);
    }
    if (p.state === 'downed' && input.pressed.has('KeyH')) this.voice(p, 'down', { zone: this.world.zoneName(p.pos.x, p.pos.z) }, { force: true });
    if (this.spectating) {
      if (input.pressed.has('ArrowRight') || input.pressed.has('KeyD') || input.firePressed) this.cycleSpectate(1);
      if (input.pressed.has('ArrowLeft') || input.pressed.has('KeyA')) this.cycleSpectate(-1);
      if (!this.viewActor || this.viewActor.state === 'out' || this.escaped.has(this.viewActor)) this.cycleSpectate(1);
    }
    this.updateActorCommon(p, dt);
    // camera
    const va = this.viewActor;
    const stress = Math.min(1, (this.time - (p.lastHitT || -9) < 4 ? 0.7 : 0) + (this.time - (p.lastNearMiss || -9) < 2 ? 0.4 : 0));
    this.rig.update(dt, va, { spectator: this.spectating, intensity: s.shake, stress, blurScale: s.motionBlur });
    this.vm.update(dt, this.camera, va === p ? p : va, { mdx: input.mdx, mdy: input.mdy });
    if (this.spectating && va !== p) { this.vm.root.visible = false; }
    // zoom
    const zoom = p.ads && p.state === 'alive' && !this.spectating ? (p.weapon.def.zoom || 1.25) : 1;
    const targetFov = s.fov / zoom;
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 12);
    this.camera.updateProjectionMatrix();
    // audio listener
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.audio.setListener(this.camera.position, fwd, up);
    if (!this.spectating) {
      this.audio.updateBreathing(dt, p.state === 'alive' ? Math.max(0, 1 - p.stamina) * (p.sprint ? 1 : 0.6) : 0.2, stress, p.state === 'downed');
      const near = this.nearestEnemyDist(p);
      this.audio.updateHeartbeat(dt, p.state === 'downed' ? 0.8 : (this.mode === 'hunt' && p.team !== this.hunterTeam && near < 10 ? (10 - near) / 10 : stress * 0.4));
      if (p.speed > 0.3 && Math.random() < dt * 2) this.audio.rustle(0.05 + p.speed * 0.02);
    }
    this.audio.setMuffle(frozen && !this.over ? 0.75 : 0);
    this.audio.updateAmbience(dt);
  }

  nearestEnemyDist(a) {
    let m = 1e9;
    for (const o of this.actors) if (o.team !== a.team && !o.neutral && o.state === 'alive') m = Math.min(m, o.pos.distanceTo(a.pos));
    return m;
  }

  playerInteract(dt, input) {
    const p = this.player;
    // find downed teammate in reach
    let target = null, bd = 1.6;
    for (const a of this.actors) {
      if (a === p || a.team !== p.team || a.state !== 'downed') continue;
      const d = a.pos.distanceTo(p.pos);
      if (d < bd) { bd = d; target = a; }
    }
    if (target) {
      if (input.keys.has('KeyE')) {
        p.crouch = true;
        this.reviveTick(p, target, dt);
        this.hud.prompt(`REVIVING ${target.name.toUpperCase()}`, target.reviveProgress);
      } else {
        this.stopRevive(p);
        this.hud.prompt(`HOLD [E] TO REVIVE ${target.name.toUpperCase()}`, target.reviveProgress > 0 ? target.reviveProgress : null);
      }
    } else {
      this.stopRevive(p);
      if (this.mode === 'hunt' && this.phase === 'prep' && p.team !== this.hunterTeam) this.hud.prompt(null);
      else this.hud.prompt(null);
    }
  }

  // ---------- combat ----------
  fireWeapon(a, dir) {
    const w = a.weapon;
    if (a.state !== 'alive' || w.reloading > 0 || w.cd > 0 || w.jammed > 0) return false;
    if (a.sprint && a.speed > 3.5) { a.sprint = false; }
    if (w.mag <= 0) { if (!a.isPlayer) this.startReload(a); return false; }
    if (Math.random() < w.def.jam) {
      w.jammed = 1.3; w.cd = 0.3;
      if (a.isPlayer) { this.audio.jam(); this.hud.event('BLASTER JAMMED · clearing...', 'sys'); }
      this.voice(a, 'hurt', {}, {});
      if (Math.random() < 0.5) this.logEvent(`${a.name}'s blaster jammed at the worst possible moment.`, 'funny');
      return false;
    }
    w.mag--; w.cd = w.def.interval; a.stats.shots++;
    a.lastShotAt = this.time;
    let origin, base;
    if (a.isPlayer && this.viewActor === a) {
      origin = this.camera.position.clone();
      base = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      origin.addScaledVector(base, 0.25).add(new THREE.Vector3(0, -0.06, 0));
      this.vm.fire();
      this.rig.addTrauma(w.def.kind === 'shotgun' ? 0.25 : 0.08);
    } else {
      origin = a.eyePos(new THREE.Vector3());
      base = dir ? dir.clone() : a.forward(new THREE.Vector3());
      origin.addScaledVector(base, 0.4); origin.y -= 0.2;
    }
    const spreadMul = (a.ads ? 0.45 : 1) * (a.speed > 1 ? 1.5 : 1) * (a.crouch ? 0.8 : 1) * (a.onGround ? 1 : 2);
    for (let i = 0; i < w.def.pellets; i++) {
      const s = w.def.spread * spreadMul;
      const d = base.clone();
      d.x += (Math.random() - 0.5) * 2 * s; d.y += (Math.random() - 0.5) * 2 * s; d.z += (Math.random() - 0.5) * 2 * s;
      d.normalize();
      this.darts.fire(a, origin.clone(), d, w.def.speed * (0.95 + Math.random() * 0.1));
    }
    this.audio.fire(w.def.kind, origin, a === this.viewActor);
    this.emitNoise(a.pos, 24, a, 'shot');
    if (w.mag === 0 && a.isPlayer && this.settings.autoReload) this.startReload(a);
    return true;
  }

  startReload(a) {
    const w = a.weapon;
    if (w.reloading > 0 || w.mag >= w.def.mag || a.state !== 'alive') return;
    w.reloading = w.def.reload;
    this.audio.reload(a.pos, a === this.viewActor, w.def.kind);
    if (!a.isPlayer && Math.random() < 0.35) this.voice(a, 'reload', {});
  }

  onDartHitActor(d, victim) {
    const shooter = d.owner;
    if (victim.neutral) {
      if (this.jurgen && victim === this.jurgen.actor) this.jurgen.onHit(shooter.isTrap ? shooter.owner : shooter);
      return;
    }
    this.audio.impact(d.pos, 'body');
    if (victim.state !== 'alive') return;
    if (shooter.team === victim.team) {
      // friendly fire doesn't count, but people do complain
      if (Math.random() < 0.5) this.speak(victim, ['Hey! Same team!', 'Watch it!', 'Friendly fire, dude!'][Math.floor(Math.random() * 3)], victim.team === this.player.team);
      return;
    }
    this.applyHit(victim, shooter.isTrap ? shooter.owner : shooter, shooter.isTrap ? 'trap' : 'dart');
  }

  onDartWorldHit(d, wh) {
    if (wh.box && wh.box.tag === 'trampoline' && Math.random() < 0.3) this.logEvent(`A dart bounced off the trampoline. Physics.`, 'funny');
  }

  onNearMiss(a) { if (a === this.player) this.player.lastNearMiss = this.time; }

  applyHit(victim, source, kind) {
    if (victim.state !== 'alive' || victim.invuln > 0) return;
    if (this.escaped.has(victim)) return;
    victim.lives--; victim.stats.timesHit++;
    victim.invuln = 1.3; victim.hurtT = 1;
    victim.lastHitT = this.time;
    if (source && source.stats && source.team !== undefined && source.team >= 0) source.stats.hits++;
    if (victim.controller) victim.controller.onHurt(source);
    this.stopRevive(victim);
    const srcName = source ? (kind === 'trap' ? `${source.name}'s trap` : source.name) : '?';
    if (!this.firstBlood && source && kind !== 'katana') { this.firstBlood = true; this.logEvent(`First blood: ${source.name} tagged ${victim.name}.`, 'first'); }
    if (kind === 'katana') this.logEvent(`${victim.name} got bonked by Jürgen's katana.`, 'jurgen');
    if (kind === 'trap') this.logEvent(`${victim.name} walked straight into ${source.name}'s trap.`, 'trap');
    if (victim === this.player) {
      this.rig.addTrauma(0.6);
      this.bodycam.fx.glitch = 0.6; this.bodycam.fx.redFlash = 1; this.bodycam.fx.flash = 0.15;
      this.audio.hurt();
    }
    if (source === this.player && victim !== this.player) { this.hud.hit(); this.audio.hitMarker(); }
    if (victim.lives > 0) {
      this.voice(victim, 'hurt', {}, { force: victim === this.player || Math.random() < 0.6 });
      if (source && !source.neutral && source.team !== undefined && Math.random() < 0.4) this.voice(source, 'hit', { enemy: victim.name });
      this.feed(`${tag(source)} <span class="x">⟶</span> ${tag(victim)} <span class="sub">(${victim.lives} left)</span>`);
    } else if (!victim.revived) {
      this.down(victim, source, kind);
    } else {
      this.eliminate(victim, source, kind === 'katana' ? 'katana' : 'tagged');
    }
  }

  down(v, source, kind) {
    v.state = 'downed'; v.downedT = this.settings.bleedout; v.reviveProgress = 0; v.reviver = null;
    v.crouch = false; v.weapon.reloading = 0;
    v.stats.downs++;
    this.voice(v, 'down', { zone: this.world.zoneName(v.pos.x, v.pos.z) }, { force: true });
    if (source && source.team !== undefined && source.team >= 0 && source.char) setTimeout(() => this.voice(source, 'downEnemy', { enemy: v.name }), 900);
    this.feed(`${tag(source)} <span class="x">✖</span> ${tag(v)} <span class="sub">DOWNED</span>`);
    this.logEvent(`${v.name} went down${source ? ' to ' + (kind === 'trap' ? source.name + "'s trap" : source.name) : ''} at ${this.world.zoneName(v.pos.x, v.pos.z)}.`, 'down');
    if (v === this.player) { this.hud.flashEvent('DOWNED'); this.bodycam.fx.glitch = 1; }
  }

  eliminate(v, source, how) {
    if (v.state === 'out') return;
    v.state = 'out'; v.reviver = null;
    v.stats.outs++;
    this.voice(v, 'out', {}, { force: true });
    this.feed(`${tag(source)} <span class="x">☠</span> ${tag(v)} <span class="sub">${how === 'bled out' ? 'BLED OUT' : 'ELIMINATED'}</span>`);
    this.logEvent(how === 'bled out' ? `Nobody came for ${v.name}. They sat there until the timer ran out.` : `${v.name} was eliminated${source ? ' by ' + source.name : ''} after being revived.`, 'out');
    if (v === this.player) {
      this.hud.flashEvent('ELIMINATED · SPECTATING');
      setTimeout(() => this.startSpectate(), 1800);
    }
  }

  escape(a) {
    this.escaped.add(a);
    a.state = 'out'; a.setVisible(false);
    this.feed(`${tag(a)} <span class="sub">ESCAPED</span>`);
    this.logEvent(`${a.name} made it to the extraction point.`, 'clutch');
    this.speak(a, 'I\'m out of here! Made it!', a.team === this.player.team);
    if (a === this.player) { this.hud.flashEvent('ESCAPED!'); setTimeout(() => this.startSpectate(), 1500); }
  }

  // ---------- revive ----------
  reviveTick(reviver, target, dt) {
    if (target.state !== 'downed') return;
    if (target.reviver && target.reviver !== reviver) return;
    if (target.reviver !== reviver) {
      target.reviver = reviver;
      target.reviveStartedT = this.time; target.reviveUnderFire = false;
    }
    if (this.time - (reviver.lastNearMiss || -9) < 1 || this.time - (reviver.lastHitT || -9) < 1) target.reviveUnderFire = true;
    const time = reviver.char.reviveTime || 3.4;
    target.reviveProgress += dt / time;
    if (target.reviveProgress >= 1) {
      target.state = 'alive'; target.lives = 1; target.revived = true; target.invuln = 2; target.reviver = null; target.reviveProgress = 0;
      reviver.stats.revives++;
      this.voice(target, 'revived', {}, { force: true });
      this.feed(`${tag(reviver)} <span class="x">✚</span> ${tag(target)} <span class="sub">REVIVED</span>`);
      this.logEvent(target.reviveUnderFire ? `${reviver.name} revived ${target.name} under heavy fire. Hero moment.` : `${reviver.name} picked ${target.name} back up.`, target.reviveUnderFire ? 'clutch' : 'revive');
      if (target === this.player) this.hud.flashEvent('REVIVED · LAST LIFE');
    }
  }
  stopRevive(reviver) {
    for (const a of this.actors) if (a.reviver === reviver) a.reviver = null;
  }

  // ---------- gear ----------
  placeTrap(a, type) {
    if (a.trapsLeft <= 0) return;
    const f = new THREE.Vector3(-Math.sin(a.yaw), 0, -Math.cos(a.yaw));
    const pos = a.pos.clone().addScaledVector(f, 1.1);
    if (!this.world.walkableAt(pos.x, pos.z)) { if (a.isPlayer) this.hud.event('Can\'t place a trap there', 'sys'); return; }
    a.trapsLeft--;
    this.traps.place(a, type, pos, a.yaw);
    if (!a.isPlayer) this.voice(a, 'trap', {}); else this.hud.event(type === 'tripwire' ? 'Tripwire alarm placed' : 'Dart trap placed', 'sys');
  }
  placeBarricade(a) {
    if (a.barricadesLeft <= 0) return;
    const f = new THREE.Vector3(-Math.sin(a.yaw), 0, -Math.cos(a.yaw));
    const pos = a.pos.clone().addScaledVector(f, 1.4);
    if (!this.world.walkableAt(pos.x, pos.z)) { if (a.isPlayer) this.hud.event('Not enough space for a barricade', 'sys'); return; }
    for (const o of this.actors) if (o !== a && o.pos.distanceTo(pos) < 1.2) return;
    a.barricadesLeft--;
    this.traps.placeBarricade(a, pos, a.yaw);
    if (a.isPlayer) this.hud.event('Barricade built', 'sys');
  }
  onTrapTriggered(t, victim) {
    if (t.team === this.player.team) this.hud.event(`${t.type === 'tripwire' ? 'TRIPWIRE' : 'DART TRAP'} triggered at ${this.world.zoneName(t.pos.x, t.pos.z)} · ${victim.name}`, 'trap');
    if (victim === this.player) this.hud.event('You triggered a trap!', 'warn');
    if (t.type === 'tripwire') this.logEvent(`${victim.name} tripped ${t.owner.name}'s alarm wire. Cans everywhere.`, 'trap');
  }

  // ---------- player commands ----------
  command(type) {
    const p = this.player;
    const mates = this.actors.filter(a => a.team === p.team && a.controller && a.state === 'alive');
    const text = { follow: 'On me! Follow me!', hold: 'Hold this position!', push: 'Push now! Go go go!' }[type];
    this.speak(p, text, false);
    let target = null;
    if (type === 'push') target = this.aimPoint();
    for (const m of mates) {
      m.controller.order = { type, t: this.time, pos: type === 'hold' ? m.pos.clone() : null };
      if (type === 'push') { m.controller.order = null; m.controller.huntTarget = target; m.controller.setState('push'); }
    }
    if (mates.length) setTimeout(() => { const m = mates[Math.floor(Math.random() * mates.length)]; if (m.state === 'alive') this.speak(m, ['Copy.', 'Got it.', 'On it.', 'Roger that.', 'Okay okay!'][Math.floor(Math.random() * 5)], true); }, 700);
    this.hud.event(`ORDER: ${type.toUpperCase()}`, 'sys');
  }

  aimPoint() {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const h = this.world.raycast(this.camera.position, dir, 80, 'shot');
    return this.camera.position.clone().addScaledVector(dir, h ? h.t - 0.3 : 30);
  }

  callout() {
    const p = this.player;
    const eye = this.camera.position;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let best = null, bestA = 0.07;
    for (const a of this.actors) {
      if (a.team === p.team || a.neutral || a.state !== 'alive') continue;
      const to = a.chestPos(new THREE.Vector3()).sub(eye);
      const d = to.length(); to.normalize();
      const ang = Math.acos(Math.min(1, to.dot(dir)));
      if (ang < bestA + 0.3 / d && this.world.lineOfSight(eye, a.chestPos(new THREE.Vector3()))) { bestA = ang; best = a; }
    }
    if (best) {
      this.shareIntel(p.team, best, p, false);
      this.speak(p, `Contact! ${best.name}, ${this.world.zoneName(best.pos.x, best.pos.z)}!`, false);
      this.hud.event(`CALLOUT: ${best.name} @ ${this.world.zoneName(best.pos.x, best.pos.z)}`, 'sys');
    } else {
      const pt = this.aimPoint();
      this.speak(p, `Check ${this.world.zoneName(pt.x, pt.z)}!`, false);
      for (const m of this.actors) if (m.team === p.team && m.controller && m.state === 'alive') m.controller.suspect = { pos: pt, t: this.time, kind: 'ping' };
      this.hud.event(`PING: ${this.world.zoneName(pt.x, pt.z)}`, 'sys');
    }
  }

  // ---------- intel, noise, danger ----------
  shareIntel(team, enemy, spotter, fresh) {
    const prev = this.intel[team].get(enemy.id);
    const teamFresh = !prev || this.time - prev.t > 7;
    this.intel[team].set(enemy.id, { actor: enemy, pos: enemy.pos.clone(), t: this.time, seen: true });
    if (fresh && teamFresh && spotter && !spotter.isPlayer && spotter.controller && Math.random() < spotter.char.ai.callouts) {
      this.voice(spotter, 'spot', { enemy: enemy.name, zone: this.world.zoneName(enemy.pos.x, enemy.pos.z) });
    }
  }
  clearIntelNear(team, pos, r) {
    for (const [k, v] of this.intel[team]) if (v.pos.distanceTo(pos) < r) this.intel[team].delete(k);
  }
  revealTo(team, actor, sec) {
    this.intel[team].set(actor.id, { actor, pos: actor.pos.clone(), t: this.time, seen: true });
  }
  emitNoise(pos, radius, src, kind) {
    for (const a of this.actors) {
      if (!a.controller || a === src || a.state !== 'alive') continue;
      if (a.pos.distanceTo(pos) < radius) a.controller.hear(pos, src, kind, radius);
    }
    if (this.jurgen && (kind === 'shot' || kind === 'alarm')) this.jurgen.hear(pos);
  }
  addDanger(team, pos) {
    const list = this.danger[team];
    const ex = list.find(d => Math.hypot(d.x - pos.x, d.z - pos.z) < 3);
    if (ex) { ex.w = Math.min(5, ex.w + 1); ex.t = this.time; }
    else list.push({ x: pos.x, z: pos.z, w: 1, t: this.time });
    if (list.length > 12) list.shift();
  }
  dangerAt(team, x, z) {
    let c = 0;
    for (const d of this.danger[team]) { const dd = (x - d.x) ** 2 + (z - d.z) ** 2; if (dd < 36) c += d.w * (1 - dd / 36); }
    return c;
  }
  inBush(pos) {
    const l = this.world.query(pos.x - 0.1, pos.z - 0.1, pos.x + 0.1, pos.z + 0.1, this._bq || (this._bq = []));
    for (const b of l) if (b.tag === 'bush' && pos.x > b.min.x && pos.x < b.max.x && pos.z > b.min.z && pos.z < b.max.z) return true;
    return false;
  }

  // ---------- footprints (tracking in Hunt) ----------
  dropFootprint(a) {
    if (this.map.indoor) return;
    const surf = this.world.surfaceAt(a.pos.x, a.pos.z);
    if (surf === 'concrete' || surf === 'stone' || surf === 'wood') return;
    const fp = { pos: a.pos.clone(), t: this.time, team: a.team };
    this.footprints.push(fp);
    if (!this._fpGeo) { this._fpGeo = new THREE.PlaneGeometry(0.16, 0.3); this._fpMat = new THREE.MeshBasicMaterial({ color: 0x1a140c, transparent: true, opacity: 0.45, depthWrite: false }); }
    const m = new THREE.Mesh(this._fpGeo, this._fpMat);
    m.rotation.x = -Math.PI / 2; m.rotation.z = -a.yaw; m.position.set(a.pos.x, this.world.ground(a.pos.x, a.pos.z) + 0.02, a.pos.z);
    this.scene.add(m); fp.mesh = m;
    if (this.footprints.length > 250) { const o = this.footprints.shift(); this.scene.remove(o.mesh); }
  }
  footprintNear(pos, r, team) {
    let best = null;
    for (const fp of this.footprints) {
      if (fp.team === team || this.time - fp.t > 45) continue;
      if (fp.pos.distanceTo(pos) > r) continue;
      if (!best || fp.t > best.t) best = fp;
    }
    if (best) {
      // follow the trail: the newest print of that trail
      let newest = best;
      for (const fp of this.footprints) if (fp.team === best.team && fp.t > newest.t && fp.pos.distanceTo(newest.pos) < 4) newest = fp;
      return newest.pos.clone();
    }
    return null;
  }

  // ---------- team brains ----------
  updateTeamBrains(dt) {
    this._brainT = (this._brainT || 0) - dt;
    if (this._brainT > 0) return;
    this._brainT = 2.5;
    for (let team = 0; team < 2; team++) {
      const ts = this.teamState[team];
      const ais = this.actors.filter(a => a.team === team && a.controller && a.state === 'alive');
      const cur = ais.find(a => a.id === ts.flanker);
      if (!cur || Math.random() < 0.1) {
        let best = null, bs = -1;
        for (const a of ais) { const s = a.controller.p.flank + Math.random() * 0.3; if (s > bs) { bs = s; best = a; } }
        ts.flanker = ais.length >= 2 && best ? best.id : null;
      }
      // decay danger memory
      for (const d of this.danger[team]) d.w *= 0.9;
      this.danger[team] = this.danger[team].filter(d => d.w > 0.2);
      // Jens-style traps in TDM
      if (this.mode === 'tdm') for (const a of ais) {
        if (a.trapsLeft > 0 && a.controller.p.trapper > 0.5 && !a.controller.target && Math.random() < 0.18 && this.time > 6) this.placeTrap(a, Math.random() < 0.6 ? 'dart' : 'tripwire');
      }
    }
  }

  // ---------- voice / radio ----------
  voice(a, key, vars = {}, opts = {}) {
    if (!a || !a.char || !a.char.lines) return;
    if (!opts.force && this.time - (a.lastVoiceT || -9) < 4) return;
    const team = a.team;
    if (!opts.force && team >= 0 && this.time - this.voiceTeamT[team] < 1.2) return;
    const text = pickLine(a.char, key, vars);
    if (!text) return;
    a.lastVoiceT = this.time; if (team >= 0) this.voiceTeamT[team] = this.time;
    const radio = team === this.player.team && a !== this.viewActor;
    this.speak(a, text, radio);
  }
  speak(a, text, radio) {
    if (!text) return;
    const near = a.pos.distanceTo(this.viewActor.pos);
    if (!radio && near > 24 && a !== this.player) return;
    a.speakT = this.time;
    if (radio) this.lastRadioT = this.time;
    this.hud.radio(a.name, text, a.team, radio);
    this.audio.say(text, a.char.voice, { radio, pos: a === this.viewActor ? null : a.pos.clone().setY(a.pos.y + 1.6), name: a.char.id });
  }

  feed(html) { this.hud.event(html); }
  logEvent(text, type) { this.events.push({ t: this.time, text, type }); }

  onJurgenAggro(target) {
    if (!this._jurgenAnnounced || this.time - this._jurgenAnnounced > 20) {
      this._jurgenAnnounced = this.time;
      this.hud.flashEvent('JÜRGEN IS AWAKE');
      this.logEvent(`${target.name} wandered into Jürgen's base. Jürgen did not approve.`, 'jurgen');
      // nearby characters react
      for (const a of this.actors) if (!a.neutral && a.state === 'alive' && a.pos.distanceTo(target.pos) < 30 && a !== target) { this.voice(a, 'jurgen', {}); break; }
    }
  }

  // ---------- misc world flavour ----------
  updateMisc(dt) {
    this.map.builder.update(dt, this.time);
    // sun follows the camera for shadow coverage
    if (this.map.sun) {
      const c = this.viewActor.pos;
      this.map.sun.position.set(c.x + 30, c.y + 50, c.z + 20);
      this.map.sun.target.position.set(c.x, c.y, c.z);
    }
    // footprints fade
    for (const fp of this.footprints) if (fp.mesh) fp.mesh.visible = this.time - fp.t < 45;
    // soccer ball
    const ball = this.map.ball;
    if (ball) {
      for (const d of this.darts.darts) if (d.pos.distanceTo(ball.mesh.position) < 0.25) ball.vel.addScaledVector(d.vel, 0.08);
      for (const a of this.actors) {
        const dx = ball.mesh.position.x - a.pos.x, dz = ball.mesh.position.z - a.pos.z, dd = Math.hypot(dx, dz);
        if (dd < 0.45 && a.speed > 0.5) { ball.vel.x += dx / dd * a.speed * 1.2; ball.vel.z += dz / dd * a.speed * 1.2; if (a.speed > 4 && Math.random() < 0.02) this.logEvent(`${a.name} stopped mid-firefight to dribble the soccer ball.`, 'funny'); }
      }
      ball.mesh.position.addScaledVector(ball.vel, dt);
      ball.vel.multiplyScalar(1 - dt * 0.8);
      const B = this.world.bounds;
      if (Math.abs(ball.mesh.position.x) > B.maxX - 0.5) ball.vel.x *= -0.6;
      if (Math.abs(ball.mesh.position.z) > B.maxZ - 0.5) ball.vel.z *= -0.6;
      ball.mesh.position.x = Math.max(B.minX + 0.5, Math.min(B.maxX - 0.5, ball.mesh.position.x));
      ball.mesh.position.z = Math.max(B.minZ + 0.5, Math.min(B.maxZ - 0.5, ball.mesh.position.z));
      ball.mesh.rotation.x += ball.vel.z * dt * 9; ball.mesh.rotation.z -= ball.vel.x * dt * 9;
    }
    // random story events
    this.randomEventT -= dt;
    if (this.randomEventT <= 0 && this.phase === 'live' && !this.over) {
      this.randomEventT = rand(70, 130);
      this.randomEvent();
    }
    if (this.map.dog) {
      this._dogT = (this._dogT || 5) - dt;
      const near = this.actors.some(a => a.state === 'alive' && a.pos.distanceTo(this.map.dog) < 3.5);
      if (this._dogT <= 0 || (near && this._dogT < 3)) { this._dogT = near ? 3 : rand(20, 45); this.audio.bark(this.map.dog); this.emitNoise(this.map.dog, 12, null, 'dog'); }
    }
  }

  randomEvent() {
    const amb = this.map.ambient;
    const alive = this.actors.filter(a => !a.neutral && a.state === 'alive' && a.controller);
    const someone = alive[Math.floor(Math.random() * alive.length)];
    if ((amb === 'basement' || this.map.indoorRegion) && Math.random() < 0.6) {
      this.hud.radio('Mom (upstairs)', 'Boys! Dinner in ten minutes! And don\'t break anything down there!', -1, false);
      this.audio.say('Boys! Dinner in ten minutes! And don\'t break anything down there!', { pitch: 1.35, rate: 1.0 }, { radio: false, name: 'mom', volume: 0.6 });
      if (someone) setTimeout(() => this.speak(someone, ['OKAY MOM!', 'Five more minutes!', 'We\'re not breaking anything!', 'Shh! You\'ll give away my position!'][Math.floor(Math.random() * 4)], someone.team === this.player.team), 2600);
      this.logEvent('Mom called everyone for dinner mid-match. Nobody stopped.', 'funny');
    } else if (amb === 'garden' || amb === 'field') {
      const lines = amb === 'garden' ? ['Neighbor', 'Can you keep it down over there? Some of us are gardening!'] : ['Groundskeeper', 'Hey! Whose darts are these all over my pitch?!'];
      this.hud.radio(lines[0], lines[1], -1, false);
      this.audio.say(lines[1], { pitch: 0.8, rate: 0.95 }, { radio: false, name: 'npc', volume: 0.6 });
      this.logEvent(`${lines[0]} complained about the noise. The war continued.`, 'funny');
    } else if (someone) {
      this.speak(someone, ['Did anyone else hear that? Something\'s in the woods...', 'Wait, I think I stepped in something.', 'I swear there\'s a tick on me.'][Math.floor(Math.random() * 3)], someone.team === this.player.team);
    }
  }

  showExtraction() {
    const e = this.map.extraction;
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.6, 3.2, 40), new THREE.MeshBasicMaterial({ color: 0x40ff60, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05; g.add(ring);
    const flare = new THREE.PointLight(0x40ff60, 4, 12); flare.position.y = 1.5; g.add(flare);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.2), new THREE.MeshBasicMaterial({ color: 0x40ff60 })); pole.position.y = 1.1; g.add(pole);
    g.position.set(e.x, this.world.ground(e.x, e.z), e.z);
    this.scene.add(g);
  }

  // ---------- spectate ----------
  startSpectate() {
    if (this.over) return;
    this.spectating = true;
    this.player.setVisible(true);
    this.cycleSpectate(1);
  }
  cycleSpectate(dir) {
    const pool = this.actors.filter(a => !a.neutral && a.state !== 'out' && !this.escaped.has(a) && a !== this.player);
    const mates = pool.filter(a => a.team === this.player.team);
    const list = mates.length ? mates : pool;
    if (!list.length) return;
    let i = list.indexOf(this.viewActor);
    i = (i + dir + list.length) % list.length;
    if (this.viewActor && this.viewActor !== this.player) this.viewActor.setVisible(true);
    this.viewActor = list[i];
    this.viewActor.setVisible(false);
    this.rig.yaw = this.viewActor.yaw; this.rig.pitch = this.viewActor.pitch;
    this.vm.setWeapon(this.viewActor.weapon.def, this.viewActor.char);
  }

  // ---------- phases & win ----------
  beginHunt() {
    this.phase = 'live'; this.timeLeft = this.settings.huntTime;
    this.hud.flashEvent('THE HUNT BEGINS');
    this.audio.countdownBeep(true);
    const hunters = this.actors.filter(a => a.team === this.hunterTeam && !a.neutral);
    const h = hunters[Math.floor(Math.random() * hunters.length)];
    if (h) this.speak(h, ['Ready or not, here we come!', 'Fifty-eight, fifty-nine, SIXTY! Coming!', 'Spread out. Find them.'][Math.floor(Math.random() * 3)], h.team === this.player.team || true);
    for (const a of this.actors) { a.trapsLeft = Math.min(a.trapsLeft, a.char.traps || 0); a.barricadesLeft = 0; }
  }

  timeUp() {
    if (this.mode === 'hunt') {
      const def = 1 - this.hunterTeam;
      const surv = this.actors.filter(a => a.team === def && (a.state === 'alive' || this.escaped.has(a)));
      this.end(surv.length ? def : this.hunterTeam, surv.length ? 'The hiders survived the hunt.' : 'Nobody survived.');
    } else {
      const score = [0, 1].map(t => this.actors.filter(a => a.team === t && a.state === 'alive').reduce((s, a) => s + a.lives, 0));
      if (score[0] === score[1]) this.end(-1, 'Time ran out. It\'s a draw. Everyone argues about who won.');
      else this.end(score[0] > score[1] ? 0 : 1, 'Time ran out. Most lives remaining wins.');
    }
  }

  checkWin() {
    if (this.mode === 'hunt' && this.phase === 'prep') return;
    const standing = [0, 1].map(t => this.actors.filter(a => a.team === t && a.state === 'alive' && !this.escaped.has(a)).length);
    if (this.mode === 'tdm') {
      if (standing[0] === 0 && standing[1] === 0) this.end(-1, 'Both teams wiped. Total chaos.');
      else if (standing[0] === 0) this.end(1, `Team ${TEAM_NAMES[0]} has nobody left standing.`);
      else if (standing[1] === 0) this.end(0, `Team ${TEAM_NAMES[1]} has nobody left standing.`);
    } else {
      const def = 1 - this.hunterTeam;
      const escapedN = [...this.escaped].filter(a => a.team === def).length;
      if (standing[def] === 0) this.end(escapedN ? def : this.hunterTeam, escapedN ? 'Some hiders escaped before the rest were caught.' : 'Every hider was found.');
      else if (standing[this.hunterTeam] === 0) this.end(def, 'The hiders turned the tables and took out every hunter.');
    }
    // clutch detection
    for (let t = 0; t < 2; t++) {
      const alive = this.actors.filter(a => a.team === t && a.state === 'alive');
      const enemies = this.actors.filter(a => a.team === 1 - t && a.state === 'alive');
      if (alive.length === 1 && enemies.length >= 2 && !this['_clutch' + t]) { this['_clutch' + t] = alive[0]; this['_clutchN' + t] = enemies.length; }
    }
  }

  end(winner, reason) {
    if (this.over) return;
    this.over = true;
    this.winner = winner; this.reason = reason;
    for (let t = 0; t < 2; t++) { const c = this['_clutch' + t]; if (c && winner === t && c.state === 'alive') this.logEvent(`${c.name} clutched a 1v${this['_clutchN' + t]} for the win. Legendary.`, 'clutch'); }
    const won = winner === this.player.team;
    this.audio.stinger(won);
    const mates = this.actors.filter(a => a.team === this.player.team && !a.isPlayer && !a.neutral);
    if (mates.length) this.voice(mates[Math.floor(Math.random() * mates.length)], winner === -1 ? 'taunt' : won ? 'win' : 'lose', {}, { force: true });
    this.hud.flashEvent(winner === -1 ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT');
    this.session.rounds++;
    if (winner >= 0) for (const a of this.actors) if (a.team === winner && !a.neutral) this.session.roundWins[a.char.id] = (this.session.roundWins[a.char.id] || 0) + 1;
    setTimeout(() => this.onEnd?.(this.report()), 3200);
  }

  report() {
    const pri = { clutch: 6, jurgen: 5, funny: 5, trap: 4, first: 3, revive: 2, down: 1, out: 2 };
    const evs = [...this.events].sort((a, b) => (pri[b.type] || 0) - (pri[a.type] || 0) + (Math.random() - 0.5) * 0.5).slice(0, 6).sort((a, b) => a.t - b.t);
    const mvp = this.actors.filter(a => !a.neutral).sort((a, b) => (b.stats.hits * 2 + b.stats.revives * 3 - b.stats.downs) - (a.stats.hits * 2 + a.stats.revives * 3 - a.stats.downs))[0];
    return {
      winner: this.winner, reason: this.reason, playerTeam: this.player.team, mode: this.mode, map: this.map.name, hunterTeam: this.hunterTeam,
      actors: this.actors.filter(a => !a.neutral).map(a => ({ name: a.name, team: a.team, isPlayer: a.isPlayer, state: this.escaped.has(a) ? 'escaped' : a.state, ...a.stats })),
      highlights: evs, mvp: mvp?.name, duration: this.time, session: this.session,
    };
  }

  render(dt) {
    if (!this.scene) return;
    const p = this.player, va = this.viewActor;
    const s = this.settings;
    const lowLight = 1 - (this.map.lightLevel || 1);
    const prepEyes = this.mode === 'hunt' && this.phase === 'prep' && p.team === this.hunterTeam && !this.spectating;
    const params = {
      vel: this.rig.vel.clone().multiplyScalar(s.motionBlur),
      blur: 0.1 + (va.state === 'downed' ? 0.1 : 0) + Math.min(0.15, Math.hypot(this.rig.vel.x, this.rig.vel.y) * 2) * s.motionBlur,
      desat: va.state === 'downed' ? 0.55 : (this.spectating ? 0.2 : (p.lives === 1 && p.state === 'alive' ? 0.15 : 0)),
      exposure: (this.map.indoor ? 1.35 : 1.0),
      lowlight: 0.3 + lowLight,
      distort: 0.16 * s.lens,
      grain: 0.05 * s.grain + lowLight * 0.04,
      intensity: 1,
      dark: prepEyes ? 0.93 : 0,
      glitch: va.state === 'downed' ? 0.02 : 0,
    };
    this.bodycam.render(this.scene, this.camera, this.vm.scene, dt, params);
  }
}

function tag(a) {
  if (!a) return '<span class="tn">???</span>';
  if (a.isTrap) return `<span class="t${a.team}">${a.name}</span>`;
  if (a.neutral) return '<span class="tj">JÜRGEN</span>';
  return `<span class="t${a.team}">${a.name.toUpperCase()}</span>`;
}
