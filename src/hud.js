// Bodycam-style HUD overlay (DOM based).
import { TEAM_NAMES } from './actor.js';

const $ = (id) => document.getElementById(id);
const pad = (n, l = 2) => String(n).padStart(l, '0');

export class HUD {
  constructor() {
    this.el = $('hud');
    this.radioLines = [];
    this.feed = [];
    this.battery = 78 + Math.floor(Math.random() * 20);
    this.batT = 0;
    this.start = new Date();
    this.camNo = pad(Math.floor(Math.random() * 90) + 10);
    this.lastSecond = -1;
    this.hitT = 0;
  }

  show(v) { this.el.classList.toggle('hidden', !v); }

  setup(game) {
    const p = game.player;
    $('cam-id').textContent = `NERFCAM X3 · UNIT ${this.camNo} · ${p.name.toUpperCase()}`;
    $('mode-label').textContent = game.mode === 'tdm' ? 'TEAM DEATHMATCH' : 'HUNT';
    $('map-label').textContent = game.map.name.toUpperCase();
    this.radioLines = []; this.feed = [];
    $('radio-feed').innerHTML = ''; $('event-feed').innerHTML = '';
    this.buildRoster(game);
    this.flashEvent('');
  }

  buildRoster(game) {
    const r = $('roster'); r.innerHTML = '';
    const mates = game.actors.filter(a => a.team === game.player.team && !a.neutral);
    for (const m of mates) {
      const d = document.createElement('div');
      d.className = 'mate'; d.id = 'mate-' + m.id;
      d.innerHTML = `<span class="lamp"></span><span class="nm">${m.name.toUpperCase()}${m.isPlayer ? ' (YOU)' : ''}</span><span class="lv"></span>`;
      r.appendChild(d);
    }
  }

  update(dt, game) {
    const now = new Date();
    if (now.getSeconds() !== this.lastSecond) {
      this.lastSecond = now.getSeconds();
      $('timestamp').textContent = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}  ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      this.batT++;
      if (this.batT % 40 === 0 && this.battery > 5) this.battery--;
      $('battery').textContent = `BAT ${this.battery}%`;
      $('battery-bar').style.width = this.battery + '%';
    }
    const va = game.viewActor || game.player;
    $('loc').textContent = 'LOC: ' + game.world.zoneName(va.pos.x, va.pos.z).toUpperCase();
    // match status
    const t = Math.max(0, game.timeLeft);
    const tStr = `${pad(Math.floor(t / 60))}:${pad(Math.floor(t % 60))}`;
    let status = '';
    if (game.mode === 'tdm') {
      const s = [0, 1].map(team => game.actors.filter(a => a.team === team && a.state === 'alive').length);
      status = `<span class="t0">${TEAM_NAMES[0]} ${s[0]}</span> · ${tStr} · <span class="t1">${s[1]} ${TEAM_NAMES[1]}</span>`;
    } else {
      const def = 1 - game.hunterTeam;
      const alive = game.actors.filter(a => a.team === def && a.state === 'alive').length;
      const hunters = game.actors.filter(a => a.team === game.hunterTeam && a.state === 'alive').length;
      status = game.phase === 'prep' ? `PREPARATION · ${tStr}` : `HIDERS ${alive} · ${tStr} · HUNTERS ${hunters}`;
      if (game.extractionOpen && game.phase === 'live') status += ' · <span class="blink">EXTRACTION OPEN</span>';
    }
    $('match-status').innerHTML = status;
    // player status
    const p = game.player;
    const lives = $('lives'); let html = '';
    const maxL = p.revived ? 1 : 3;
    for (let i = 0; i < 3; i++) html += `<span class="pip ${i < p.lives && p.state === 'alive' ? 'on' : ''} ${i >= maxL ? 'gone' : ''}"></span>`;
    lives.innerHTML = html;
    const st = p.state === 'out' ? 'ELIMINATED' : p.state === 'downed' ? 'DOWNED' : p.lives < 3 || p.revived ? 'INJURED' : 'OK';
    const stEl = $('pstatus'); stEl.textContent = st; stEl.className = 'st-' + st.toLowerCase();
    const w = p.weapon;
    $('ammo').textContent = w.jammed > 0 ? 'JAM' : w.reloading > 0 ? 'RELOADING' : `${pad(w.mag)} / ${pad(w.def.mag)}`;
    $('weapon-name').textContent = w.def.name.toUpperCase();
    $('reload-bar').style.width = w.reloading > 0 ? (100 * (1 - w.reloading / w.def.reload)) + '%' : '0%';
    $('stamina-bar').style.width = (p.stamina * 100) + '%';
    let gear = '';
    if (p.trapsLeft > 0) gear += `TRAPS ${p.trapsLeft} [G/T] `;
    if (p.barricadesLeft > 0) gear += `BARRICADES ${p.barricadesLeft} [F]`;
    $('gear').textContent = gear;
    // roster
    for (const m of game.actors) {
      const el = $('mate-' + m.id); if (!el) continue;
      el.className = 'mate ' + m.state + (game.time - (m.speakT || -9) < 2.5 ? ' talking' : '') + (game.viewActor === m && game.spectating ? ' viewing' : '');
      el.querySelector('.lv').textContent = m.state === 'out' ? 'OUT' : m.state === 'downed' ? 'DOWN' : '●'.repeat(m.lives);
    }
    // radio lines expire
    const rf = $('radio-feed');
    for (let i = this.radioLines.length - 1; i >= 0; i--) {
      const l = this.radioLines[i]; l.t -= dt;
      if (l.t <= 0) { l.el.remove(); this.radioLines.splice(i, 1); } else if (l.t < 1) l.el.style.opacity = l.t;
    }
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const l = this.feed[i]; l.t -= dt;
      if (l.t <= 0) { l.el.remove(); this.feed.splice(i, 1); } else if (l.t < 1) l.el.style.opacity = l.t;
    }
    // hit marker
    this.hitT = Math.max(0, this.hitT - dt);
    $('hitmarker').style.opacity = this.hitT > 0 ? 1 : 0;
    // overlays
    $('downed-overlay').classList.toggle('hidden', !(p.state === 'downed' && !game.spectating));
    if (p.state === 'downed') {
      $('bleed').textContent = Math.ceil(p.downedT);
      $('revive-status').textContent = p.reviver ? `${p.reviver.name.toUpperCase()} IS REVIVING YOU... ${Math.floor(p.reviveProgress * 100)}%` : 'HOLD ON. CALL FOR HELP [H]';
    }
    $('spectate-overlay').classList.toggle('hidden', !game.spectating);
    if (game.spectating && game.viewActor) $('spectate-name').textContent = `CAM ${game.viewActor.name.toUpperCase()}`;
    $('crosshair').style.display = game.settings.crosshair && p.state === 'alive' && !game.spectating ? 'block' : 'none';
    // prep overlay (hunter eyes closed)
    const eyes = game.mode === 'hunt' && game.phase === 'prep' && p.team === game.hunterTeam;
    $('eyes-overlay').classList.toggle('hidden', !eyes);
    if (eyes) $('eyes-count').textContent = Math.ceil(game.timeLeft);
    $('prep-help').classList.toggle('hidden', !(game.mode === 'hunt' && game.phase === 'prep' && p.team !== game.hunterTeam));
    // REC blink
    $('rec').style.visibility = (Math.floor(game.time * 1.4) % 2 === 0) ? 'visible' : 'hidden';
    $('radio-ind').classList.toggle('active', game.time - (game.lastRadioT || -9) < 2);
  }

  radio(name, text, team, isRadio = true) {
    const rf = document.getElementById('radio-feed');
    const d = document.createElement('div');
    d.className = 'rline ' + (isRadio ? 'radio' : 'near') + (team === 1 ? ' t1' : team === 0 ? ' t0' : ' tn');
    d.innerHTML = `<span class="who">${isRadio ? '◉ ' : ''}${name.toUpperCase()}:</span> ${escape(text)}`;
    rf.appendChild(d);
    this.radioLines.push({ el: d, t: 6 });
    while (this.radioLines.length > 5) { const o = this.radioLines.shift(); o.el.remove(); }
  }

  event(text, cls = '') {
    const ef = document.getElementById('event-feed');
    const d = document.createElement('div'); d.className = 'ev ' + cls; d.innerHTML = text;
    ef.appendChild(d);
    this.feed.push({ el: d, t: 6 });
    while (this.feed.length > 6) { const o = this.feed.shift(); o.el.remove(); }
  }

  flashEvent(text) {
    const el = document.getElementById('center-msg');
    el.textContent = text;
    el.classList.remove('pop'); void el.offsetWidth;
    if (text) el.classList.add('pop');
  }

  prompt(text, progress = null) {
    const el = document.getElementById('prompt');
    el.classList.toggle('hidden', !text);
    if (text) {
      document.getElementById('prompt-text').textContent = text;
      const bar = document.getElementById('prompt-bar');
      bar.style.display = progress === null ? 'none' : 'block';
      if (progress !== null) bar.firstElementChild.style.width = (progress * 100) + '%';
    }
  }

  hit() { this.hitT = 0.15; }
}

function escape(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
