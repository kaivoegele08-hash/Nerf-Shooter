// Procedural WebAudio sound design + speech-synthesised radio voices.
import * as THREE from '../lib/three.module.min.js';

export class AudioSys {
  constructor() {
    this.ctx = null; this.enabled = true; this.voices = true;
    this.speechQueue = []; this.speaking = false;
    this.listenerPos = new THREE.Vector3();
    this.muffle = 0;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16; this.comp.ratio.value = 4;
    // bodycam mic coloration: slight low cut + presence + muffle filter
    this.lowcut = ctx.createBiquadFilter(); this.lowcut.type = 'highpass'; this.lowcut.frequency.value = 70;
    this.muffleF = ctx.createBiquadFilter(); this.muffleF.type = 'lowpass'; this.muffleF.frequency.value = 18000;
    this.master.connect(this.muffleF); this.muffleF.connect(this.lowcut); this.lowcut.connect(this.comp); this.comp.connect(ctx.destination);
    this.world = ctx.createGain(); this.world.connect(this.master);
    this.ui = ctx.createGain(); this.ui.connect(this.master);
    // noise buffers
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const bd = this.brown.getChannelData(0); let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; bd[i] = last * 3.5; }
    this.ambNodes = [];
    this.breathT = 0; this.heartT = 0;
    this.pickVoices();
    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = () => this.pickVoices();
  }

  pickVoices() {
    if (!window.speechSynthesis) return;
    const vs = window.speechSynthesis.getVoices();
    this.enVoices = vs.filter(v => /^en/i.test(v.lang));
    this.deVoice = vs.find(v => /^de/i.test(v.lang)) || null;
  }

  get t() { return this.ctx ? this.ctx.currentTime : 0; }

  setListener(pos, fwd, up) {
    if (!this.ctx) return;
    this.listenerPos.copy(pos);
    const L = this.ctx.listener;
    if (L.positionX) {
      const t = this.ctx.currentTime;
      L.positionX.setTargetAtTime(pos.x, t, 0.02); L.positionY.setTargetAtTime(pos.y, t, 0.02); L.positionZ.setTargetAtTime(pos.z, t, 0.02);
      L.forwardX.setTargetAtTime(fwd.x, t, 0.02); L.forwardY.setTargetAtTime(fwd.y, t, 0.02); L.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      L.upX.value = up.x; L.upY.value = up.y; L.upZ.value = up.z;
    } else {
      L.setPosition(pos.x, pos.y, pos.z); L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  setMuffle(m) {
    if (!this.ctx) return;
    this.muffle = m;
    this.muffleF.frequency.setTargetAtTime(18000 - m * 17000, this.ctx.currentTime, 0.1);
  }

  // output node at a 3D position (or null for 2D)
  out(pos, vol = 1, refDist = 2, maxDist = 60) {
    const ctx = this.ctx;
    const g = ctx.createGain(); g.gain.value = vol;
    if (pos) {
      if (pos.distanceTo(this.listenerPos) > maxDist) return null;
      const p = ctx.createPanner();
      p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = refDist; p.maxDistance = maxDist; p.rolloffFactor = 1.2;
      if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
      g.connect(p); p.connect(this.world);
    } else g.connect(this.ui);
    return g;
  }

  noiseBurst(dest, t, dur, type, freq, q, vol, attack = 0.002, brown = false, rate = 1) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = brown ? this.brown : this.noise;
    src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
    return f;
  }
  tone(dest, t, dur, type, f0, f1, vol, attack = 0.002) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.05);
    return o;
  }

  // ---------------- combat ----------------
  fire(kind, pos, isPlayer) {
    if (!this.ctx) return;
    const o = this.out(isPlayer ? null : pos, isPlayer ? 0.9 : 1.2, 3, 70); if (!o) return;
    const t = this.t;
    if (kind === 'flywheel') {
      this.tone(o, t, 0.12, 'sawtooth', 420, 380, 0.05, 0.01);
      this.noiseBurst(o, t, 0.06, 'bandpass', 1800, 1.2, 0.5);
      this.tone(o, t, 0.05, 'sine', 160, 90, 0.4);
    } else {
      // spring plunger: "thwump" + plastic clack
      const big = kind === 'shotgun' ? 1.4 : kind === 'sniper' ? 1.2 : 1;
      this.tone(o, t, 0.12 * big, 'sine', 140 * (kind === 'pistol' || kind === 'twin' ? 1.4 : 1), 55, 0.7 * big);
      this.noiseBurst(o, t, 0.08 * big, 'lowpass', 900, 0.7, 0.6 * big);
      this.noiseBurst(o, t + 0.005, 0.03, 'highpass', 3500, 0.8, 0.25);
      if (kind === 'rifle' || kind === 'shotgun' || kind === 'sniper') {
        // priming slide after shot
        this.noiseBurst(o, t + 0.22, 0.05, 'bandpass', 2400, 3, 0.3);
        this.noiseBurst(o, t + 0.34, 0.04, 'bandpass', 1700, 3, 0.35);
      }
    }
  }
  whizz(pos) {
    if (!this.ctx) return;
    const o = this.out(pos, 0.5, 1, 6); if (!o) return;
    const f = this.noiseBurst(o, this.t, 0.18, 'bandpass', 1200, 4, 0.5, 0.05);
    f.frequency.exponentialRampToValueAtTime(500, this.t + 0.18);
  }
  impact(pos, surface = 'wood') {
    if (!this.ctx) return;
    const o = this.out(pos, 0.9, 1.5, 35); if (!o) return;
    const t = this.t;
    const freq = { metal: 3200, plastic: 2400, glass: 4200, concrete: 1800, wood: 1100, cardboard: 700, fabric: 500, leaves: 2600, bark: 900, stone: 1900, brick: 1700, body: 600, net: 1500, rubber: 400, ceramic: 3000, trampoline: 300 }[surface] || 1200;
    this.noiseBurst(o, t, surface === 'leaves' ? 0.2 : 0.06, 'bandpass', freq, surface === 'metal' ? 6 : 2, 0.7);
    this.tone(o, t, 0.04, 'triangle', freq * 0.25, freq * 0.15, surface === 'fabric' || surface === 'body' ? 0.2 : 0.35);
    if (surface === 'metal' || surface === 'glass') this.tone(o, t, 0.25, 'sine', freq * 1.1, freq * 1.08, 0.06);
  }
  hitMarker() {
    if (!this.ctx) return;
    const o = this.out(null, 0.25); const t = this.t;
    this.tone(o, t, 0.05, 'square', 1800, 1700, 0.15);
  }
  hurt() {
    if (!this.ctx) return;
    const o = this.out(null, 0.8); const t = this.t;
    this.noiseBurst(o, t, 0.08, 'lowpass', 500, 1, 0.9);
    this.tone(o, t, 0.15, 'sine', 90, 50, 0.7);
  }
  reload(pos, isPlayer, kind) {
    if (!this.ctx) return;
    const o = this.out(isPlayer ? null : pos, isPlayer ? 0.6 : 0.8, 1.5, 20); if (!o) return;
    const t = this.t;
    const n = kind === 'shotgun' ? 4 : kind === 'pistol' ? 6 : 3;
    for (let i = 0; i < n; i++) this.noiseBurst(o, t + 0.15 + i * 0.22, 0.03, 'bandpass', 2000 + Math.random() * 1500, 4, 0.4);
    this.noiseBurst(o, t + 0.2 + n * 0.22, 0.06, 'bandpass', 1400, 2, 0.6);
  }
  click(isPlayer = true) { if (!this.ctx) return; const o = this.out(null, 0.4); this.noiseBurst(o, this.t, 0.02, 'highpass', 3000, 1, 0.5); }
  jam() { if (!this.ctx) return; const o = this.out(null, 0.6); const t = this.t; this.noiseBurst(o, t, 0.05, 'bandpass', 900, 5, 0.8); this.tone(o, t, 0.08, 'square', 120, 80, 0.2); }

  footstep(pos, surface, intensity, isPlayer) {
    if (!this.ctx) return;
    const o = this.out(isPlayer ? null : pos, (isPlayer ? 0.35 : 0.6) * intensity, 1.5, 25); if (!o) return;
    const t = this.t;
    switch (surface) {
      case 'carpet': case 'fabric': this.noiseBurst(o, t, 0.08, 'lowpass', 400, 1, 0.5, 0.01); break;
      case 'grass': this.noiseBurst(o, t, 0.14, 'bandpass', 3200, 0.8, 0.35, 0.02); this.noiseBurst(o, t, 0.06, 'lowpass', 300, 1, 0.3); break;
      case 'leaves': this.noiseBurst(o, t, 0.2, 'bandpass', 2500, 0.6, 0.5, 0.02); this.noiseBurst(o, t + 0.03, 0.1, 'highpass', 4000, 1, 0.25, 0.01); break;
      case 'dirt': this.noiseBurst(o, t, 0.1, 'lowpass', 900, 1, 0.5, 0.01); break;
      case 'gravel': this.noiseBurst(o, t, 0.16, 'bandpass', 2000, 0.5, 0.55, 0.01); break;
      case 'wood': this.noiseBurst(o, t, 0.07, 'bandpass', 600, 1.5, 0.6); this.tone(o, t, 0.06, 'sine', 140, 110, 0.25); break;
      case 'metal': this.noiseBurst(o, t, 0.06, 'bandpass', 1800, 3, 0.4); this.tone(o, t, 0.12, 'sine', 420, 400, 0.08); break;
      case 'stone': this.noiseBurst(o, t, 0.05, 'bandpass', 1500, 1.5, 0.55); break;
      default: this.noiseBurst(o, t, 0.05, 'bandpass', 1200, 1.2, 0.5); this.tone(o, t, 0.03, 'sine', 90, 70, 0.2); // concrete
    }
  }
  rustle(vol) {
    if (!this.ctx || vol < 0.02) return;
    const o = this.out(null, vol); this.noiseBurst(o, this.t, 0.18, 'bandpass', 1600, 0.6, 0.12, 0.05);
  }
  land(surface) { if (!this.ctx) return; const o = this.out(null, 0.6); this.noiseBurst(o, this.t, 0.12, 'lowpass', 500, 1, 0.8); this.tone(o, this.t, 0.1, 'sine', 80, 50, 0.4); }

  // breathing: call each frame with exertion 0..1
  updateBreathing(dt, exertion, stress, downed) {
    if (!this.ctx) return;
    const rate = 0.35 + exertion * 0.9 + stress * 0.5; // breaths/sec
    this.breathT -= dt * rate;
    if (this.breathT <= 0) {
      this.breathT = 1;
      const v = 0.06 + exertion * 0.35 + stress * 0.2 + (downed ? 0.25 : 0);
      const o = this.out(null, v);
      const t = this.t, len = 0.9 / Math.max(0.6, rate);
      this.noiseBurst(o, t, len * 0.45, 'bandpass', 900 + exertion * 300, 0.9, 0.5, len * 0.2, true, 1); // inhale
      this.noiseBurst(o, t + len * 0.5, len * 0.5, 'bandpass', 600, 0.8, 0.6, len * 0.1, true, 1); // exhale
    }
  }
  updateHeartbeat(dt, intensity) {
    if (!this.ctx || intensity <= 0.05) return;
    this.heartT -= dt * (1 + intensity * 1.2);
    if (this.heartT <= 0) {
      this.heartT = 1;
      const o = this.out(null, intensity * 0.8); const t = this.t;
      this.tone(o, t, 0.12, 'sine', 60, 40, 0.9); this.tone(o, t + 0.22, 0.12, 'sine', 55, 38, 0.6);
    }
  }

  radio(on = true) {
    if (!this.ctx) return;
    const o = this.out(null, 0.35); const t = this.t;
    if (on) { this.tone(o, t, 0.06, 'square', 1400, 1400, 0.12); this.noiseBurst(o, t + 0.04, 0.25, 'bandpass', 2200, 0.7, 0.4, 0.01); }
    else { this.noiseBurst(o, t, 0.18, 'bandpass', 2500, 0.7, 0.35, 0.01); this.tone(o, t + 0.16, 0.05, 'square', 900, 900, 0.1); }
  }
  staticBed(dur) {
    if (!this.ctx) return;
    const o = this.out(null, 0.05); this.noiseBurst(o, this.t, dur, 'bandpass', 3000, 0.5, 0.6, 0.05);
  }

  trapAlarm(pos) {
    if (!this.ctx) return;
    const o = this.out(pos, 1.4, 4, 80); if (!o) return;
    const t = this.t;
    for (let i = 0; i < 14; i++) { this.tone(o, t + i * 0.07, 0.12, 'triangle', 2600 + Math.random() * 900, 2500, 0.25); this.noiseBurst(o, t + i * 0.07, 0.05, 'highpass', 5000, 1, 0.2); }
  }
  build(pos) {
    if (!this.ctx) return;
    const o = this.out(pos, 1, 2, 30); if (!o) return;
    for (let i = 0; i < 4; i++) { this.noiseBurst(o, this.t + i * 0.18, 0.06, 'bandpass', 700, 2, 0.8); this.tone(o, this.t + i * 0.18, 0.06, 'sine', 160, 100, 0.4); }
  }
  swoosh(pos) {
    if (!this.ctx) return;
    const o = this.out(pos, 1.2, 2, 30); if (!o) return;
    const f = this.noiseBurst(o, this.t, 0.35, 'bandpass', 600, 2, 0.9, 0.12);
    f.frequency.exponentialRampToValueAtTime(3000, this.t + 0.3);
  }
  bark(pos) {
    if (!this.ctx) return;
    const o = this.out(pos, 1.2, 4, 50); if (!o) return;
    for (let i = 0; i < 2; i++) { const t = this.t + i * 0.28; this.tone(o, t, 0.12, 'sawtooth', 520, 300, 0.3, 0.01); this.noiseBurst(o, t, 0.1, 'bandpass', 900, 2, 0.4); }
  }
  stinger(win) {
    if (!this.ctx) return;
    const o = this.out(null, 0.4); const t = this.t;
    const notes = win ? [392, 494, 587, 784] : [392, 349, 311, 262];
    notes.forEach((n, i) => this.tone(o, t + i * 0.16, 0.5, 'triangle', n, n, 0.3, 0.01));
  }
  countdownBeep(final) { if (!this.ctx) return; const o = this.out(null, 0.3); this.tone(o, this.t, 0.12, 'sine', final ? 1200 : 800, final ? 1200 : 800, 0.4); }

  // ---------------- ambience ----------------
  startAmbience(type) {
    this.stopAmbience();
    if (!this.ctx) return;
    const ctx = this.ctx; const t = this.t;
    const g = ctx.createGain(); g.gain.value = 0; g.gain.linearRampToValueAtTime(1, t + 2); g.connect(this.master);
    this.ambGain = g;
    const loopNoise = (type2, freq, q, vol, brown = true) => {
      const s = ctx.createBufferSource(); s.buffer = brown ? this.brown : this.noise; s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type2; f.frequency.value = freq; f.Q.value = q;
      const gg = ctx.createGain(); gg.gain.value = vol;
      s.connect(f); f.connect(gg); gg.connect(g); s.start();
      this.ambNodes.push(s); return { s, f, gg };
    };
    if (type === 'basement') {
      // fluorescent hum + furnace rumble
      for (const [fr, v] of [[60, 0.05], [120, 0.03], [180, 0.012]]) { const o = ctx.createOscillator(); o.frequency.value = fr; const gg = ctx.createGain(); gg.gain.value = v; o.connect(gg); gg.connect(g); o.start(); this.ambNodes.push(o); }
      loopNoise('lowpass', 140, 0.7, 0.18);
    } else {
      const wind = loopNoise('bandpass', type === 'field' ? 500 : 350, 0.5, type === 'forestmist' ? 0.25 : 0.16);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.08; const lg = ctx.createGain(); lg.gain.value = 180; lfo.connect(lg); lg.connect(wind.f.frequency); lfo.start(); this.ambNodes.push(lfo);
      loopNoise('highpass', 6000, 0.3, type === 'field' ? 0.008 : 0.02, false); // leaves/insects
    }
    this.ambType = type;
    this.birdT = 2;
  }
  stopAmbience() {
    for (const n of this.ambNodes) { try { n.stop(); } catch (e) { /* ignore */ } }
    this.ambNodes = [];
    if (this.ambGain) { this.ambGain.disconnect(); this.ambGain = null; }
  }
  updateAmbience(dt) {
    if (!this.ctx || !this.ambType) return;
    this.birdT -= dt;
    if (this.birdT <= 0) {
      if (this.ambType === 'basement') {
        this.birdT = 6 + Math.random() * 10;
        // pipes ticking / dripping
        const o = this.out(null, 0.15); const t = this.t;
        if (Math.random() < 0.5) this.tone(o, t, 0.08, 'sine', 1800, 900, 0.3); else for (let i = 0; i < 3; i++) this.noiseBurst(o, t + i * 0.3, 0.03, 'bandpass', 3000, 6, 0.4);
      } else {
        this.birdT = this.ambType === 'forestmist' ? 4 + Math.random() * 8 : 1.5 + Math.random() * 4;
        const o = this.out(null, 0.06 + Math.random() * 0.08); const t = this.t;
        if (this.ambType === 'forestmist' && Math.random() < 0.4) {
          // crow
          for (let i = 0; i < 3; i++) { this.tone(o, t + i * 0.35, 0.22, 'sawtooth', 700, 450, 0.25, 0.02); }
        } else {
          const base = 2500 + Math.random() * 2500; const n = 2 + Math.floor(Math.random() * 5);
          for (let i = 0; i < n; i++) this.tone(o, t + i * 0.11, 0.08, 'sine', base * (1 + Math.random() * 0.3), base * 0.8, 0.3, 0.01);
        }
      }
    }
  }

  // ---------------- speech ----------------
  // opts: { radio: bool, pos, char, name, volume }
  say(text, voiceCfg, opts = {}) {
    if (!text) return;
    if (opts.radio) { this.radio(true); this.staticBed(Math.min(3, 0.6 + text.length * 0.05)); setTimeout(() => this.radio(false), Math.min(3200, 700 + text.length * 55)); }
    if (!this.voices || !window.speechSynthesis) return;
    const dist = opts.pos ? opts.pos.distanceTo(this.listenerPos) : 0;
    let vol = opts.radio ? 0.75 : Math.max(0, 1 - dist / 22);
    if (vol < 0.05) return;
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = voiceCfg?.pitch ?? 1; u.rate = voiceCfg?.rate ?? 1; u.volume = vol * (opts.volume ?? 1) * (1 - this.muffle * 0.6);
    if (voiceCfg?.lang === 'de' && this.deVoice) { u.voice = this.deVoice; u.lang = this.deVoice.lang; }
    else if (this.enVoices && this.enVoices.length) {
      const idx = Math.abs(hash(opts.name || 'x')) % this.enVoices.length;
      u.voice = this.enVoices[idx];
    }
    this.speechQueue.push(u);
    if (this.speechQueue.length > 2) this.speechQueue.splice(0, this.speechQueue.length - 2);
    this._pump();
  }
  _pump() {
    if (this.speaking || !this.speechQueue.length) return;
    const u = this.speechQueue.shift();
    this.speaking = true;
    const done = () => { this.speaking = false; setTimeout(() => this._pump(), 120); };
    u.onend = done; u.onerror = done;
    try { window.speechSynthesis.speak(u); } catch (e) { done(); }
    setTimeout(() => { if (this.speaking) { window.speechSynthesis.cancel(); done(); } }, 6000);
  }
  stopSpeech() { this.speechQueue = []; if (window.speechSynthesis) window.speechSynthesis.cancel(); this.speaking = false; }
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
