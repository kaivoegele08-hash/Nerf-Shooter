// Entry point: menus, settings, input and the main loop.
import * as THREE from '../lib/three.module.min.js';
import { CHARACTERS, WEAPONS, charById } from './characters.js';
import { MAPS } from './maps.js';
import { AudioSys } from './audio.js';
import { HUD } from './hud.js';
import { Game } from './game.js';
import { TEAM_NAMES } from './actor.js';

const $ = (id) => document.getElementById(id);
window.addEventListener('error', (e) => { const el = $('err'); el.classList.remove('hidden'); el.textContent = 'Error: ' + (e.message || e) + (e.filename ? `\n${e.filename}:${e.lineno}` : ''); });

// ---------------- settings ----------------
const DEFAULTS = { sensitivity: 1.0, fov: 82, difficulty: 1, voices: true, crosshair: true, lens: 1, shake: 1, motionBlur: 1, grain: 1, invertY: false, autoReload: true, prepTime: 50, huntTime: 240, tdmTime: 360, bleedout: 45 };
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('bw-settings') || '{}')); } catch (e) { /* storage unavailable */ }
const saveSettings = () => { try { localStorage.setItem('bw-settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } };

// ---------------- renderer ----------------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const audio = new AudioSys();
const hud = new HUD();
const game = new Game(renderer, audio, hud, settings);
window.__game = game;

addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight, false); game.resize(innerWidth, innerHeight); });

// ---------------- menu state ----------------
const state = { charId: null, mode: 'tdm', mapId: 'basement', teams: null, screen: 'title', inGame: false, paused: false };
let returnTo = 'title';

function show(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  $('screen-' + screen).classList.remove('hidden');
  state.screen = screen;
}
function menuVisible(v) { $('menu').classList.toggle('hidden-menu', !v); }

// title
$('btn-play').onclick = () => { audio.init(); show('char'); };
$('btn-howto').onclick = () => { returnTo = 'title'; show('howto'); };
$('btn-settings').onclick = () => { returnTo = 'title'; buildSettings(); show('settings'); };
document.querySelectorAll('.back').forEach(b => b.onclick = () => {
  const map = { char: 'title', mode: 'char', teams: 'mode', howto: returnTo, settings: returnTo };
  show(map[state.screen] || 'title');
});

// character select
function buildChars() {
  const grid = $('char-grid'); grid.innerHTML = '';
  for (const c of CHARACTERS) {
    const w = WEAPONS[c.weapon];
    const d = document.createElement('div');
    d.className = 'card' + (state.charId === c.id ? ' sel' : '');
    const stat = (label, v) => `<div class="stat"><b>${label}</b><i style="--v:${Math.round(v * 100)}%"></i></div>`;
    d.innerHTML = `<span class="swatch" style="background:#${c.color.toString(16).padStart(6, '0')}"></span>
      <div class="nm">${c.name.toUpperCase()}</div><div class="ti">${c.title.toUpperCase()}</div>
      <div class="bio">${c.bio}</div>
      ${stat('SPEED', (c.speed - 0.85) / 0.3)}${stat('ACCURACY', c.ai.accuracy)}${stat('AGGRESSION', c.ai.aggression)}${stat('PATIENCE', c.ai.patience)}
      <div class="wp">BLASTER: ${w.name} · ${w.mag} darts${c.traps ? ` · ${c.traps} traps` : ''}${c.reviveTime ? ' · fast revives' : ''}</div>`;
    d.onclick = () => { state.charId = c.id; buildChars(); $('btn-char-next').disabled = false; audio.click(); };
    grid.appendChild(d);
  }
}
$('btn-char-next').onclick = () => { buildMaps(); show('mode'); };

// mode + map
document.querySelectorAll('#mode-tabs .tab').forEach(t => t.onclick = () => {
  state.mode = t.dataset.mode;
  document.querySelectorAll('#mode-tabs .tab').forEach(x => x.classList.toggle('active', x === t));
  const rec = Object.entries(MAPS).find(([id, m]) => m.rec === state.mode);
  if (rec && !MAPS[state.mapId].modes.includes(state.mode)) state.mapId = rec[0];
  if (state.mode === 'hunt' && state.mapId === 'basement') state.mapId = 'forest';
  if (state.mode === 'tdm' && !MAPS[state.mapId].modes.includes('tdm')) state.mapId = 'basement';
  buildMaps();
});
const THUMB = { basement: 'linear-gradient(135deg,#3a3630,#1a1814)', forest: 'linear-gradient(135deg,#2a4a2a,#1a2a18)', jurgen: 'linear-gradient(135deg,#2a3428,#3a1a14)', soccer: 'linear-gradient(135deg,#4a7a3a,#2a5a2a)', garden: 'linear-gradient(135deg,#5a8a3a,#7a6a4a)', gardenbasement: 'linear-gradient(90deg,#5a8a3a 50%,#3a3630 50%)' };
function buildMaps() {
  const grid = $('map-grid'); grid.innerHTML = '';
  for (const [id, m] of Object.entries(MAPS)) {
    if (!m.modes.includes(state.mode)) continue;
    const d = document.createElement('div');
    d.className = 'card map-card' + (state.mapId === id ? ' sel' : '');
    d.innerHTML = `<div class="thumb" style="background:${THUMB[id]}"></div><div class="nm">${m.name.toUpperCase()}${m.rec === state.mode ? '<span class="badge">PRIMARY</span>' : ''}</div><div class="bio">${m.desc}</div>`;
    d.onclick = () => { state.mapId = id; buildMaps(); audio.click(); };
    grid.appendChild(d);
  }
  if (!MAPS[state.mapId].modes.includes(state.mode)) { state.mapId = Object.keys(MAPS).find(k => MAPS[k].modes.includes(state.mode)); buildMaps(); }
}
$('btn-mode-next').onclick = () => { rollTeams(); show('teams'); };

// teams
function rollTeams() {
  state.teams = Game.rollTeams(state.charId, state.mode);
  const t = state.teams;
  const wrap = $('teams-wrap'); wrap.innerHTML = '';
  $('teams-title').textContent = state.mode === 'hunt' ? 'HUNT · ROLES ASSIGNED' : 'TEAMS GENERATED';
  const youTeam = t.playerTeam;
  $('teams-hint').textContent = state.mode === 'hunt'
    ? (youTeam === t.hunterTeam ? 'You are HUNTING. Count with your eyes closed, then track them down.' : 'You are HIDING. Use the prep time to hide, build barricades and set traps.')
    : `You are on team ${TEAM_NAMES[youTeam]}. ${MAPS[state.mapId].name}. Good luck.`;
  for (let i = 0; i < 2; i++) {
    const col = document.createElement('div');
    col.className = 'team-col';
    col.style.borderColor = i === 0 ? 'var(--orange)' : 'var(--blue)';
    const role = state.mode === 'hunt' ? (i === t.hunterTeam ? ' · HUNTERS' : ' · HIDERS') : '';
    col.innerHTML = `<h4 class="t${i}">TEAM ${TEAM_NAMES[i]}${role}</h4>` + t.teams[i].map(id => {
      const c = charById(id);
      return `<div class="row ${id === state.charId ? 'you' : ''}"><span>${c.name}${id === state.charId ? ' (YOU)' : ' · AI'}</span><span class="ti">${c.title}</span></div>`;
    }).join('');
    wrap.appendChild(col);
  }
}
$('btn-reroll').onclick = () => { rollTeams(); audio.click(); };
$('btn-deploy').onclick = () => deploy();

function deploy() {
  audio.init();
  audio.voices = settings.voices;
  show('loading');
  $('loading-text').textContent = `Loading ${MAPS[state.mapId].name}… syncing 8 bodycams…`;
  setTimeout(() => {
    try {
      game.start({ charId: state.charId, mode: state.mode, mapId: state.mapId, teams: state.teams.teams, hunterTeam: state.teams.hunterTeam });
    } catch (e) { console.error(e); const el = $('err'); el.classList.remove('hidden'); el.textContent = 'Failed to start: ' + e.message + '\n' + e.stack; show('title'); return; }
    game.resize(innerWidth, innerHeight);
    state.inGame = true; state.paused = false;
    menuVisible(false);
    hud.show(true);
    lockPointer();
  }, 60);
}

game.onEnd = (rep) => {
  state.inGame = false;
  document.exitPointerLock?.();
  hud.show(false);
  showEnd(rep);
};

function showEnd(rep) {
  const won = rep.winner === rep.playerTeam;
  $('end-title').textContent = rep.winner === -1 ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT';
  $('end-title').style.textShadow = won ? '3px 3px 0 #2a8a3a' : '3px 3px 0 #8a2a2a';
  $('end-reason').textContent = `${rep.reason}  ·  ${rep.map}  ·  ${Math.floor(rep.duration / 60)}m ${Math.floor(rep.duration % 60)}s`;
  const story = $('end-story'); story.innerHTML = '';
  (rep.highlights.length ? rep.highlights : [{ t: 0, text: 'A quiet round. Suspiciously quiet.' }]).forEach(h => {
    const li = document.createElement('li');
    li.textContent = `[${String(Math.floor(h.t / 60)).padStart(2, '0')}:${String(Math.floor(h.t % 60)).padStart(2, '0')}] ${h.text}`;
    story.appendChild(li);
  });
  $('end-mvp').textContent = rep.mvp ? `MVP: ${rep.mvp}` : '';
  const tb = $('end-table');
  const role = (t) => rep.mode === 'hunt' ? (t === rep.hunterTeam ? 'HUNT' : 'HIDE') : TEAM_NAMES[t];
  tb.innerHTML = '<tr><th>PLAYER</th><th>TEAM</th><th>HITS</th><th>DOWNED</th><th>REVIVES</th><th>STATUS</th><th>WINS</th></tr>' +
    rep.actors.sort((a, b) => a.team - b.team || b.hits - a.hits).map(a => `<tr class="${a.isPlayer ? 'me' : ''}"><td class="t${a.team}">${a.name}${a.isPlayer ? ' (YOU)' : ''}</td><td>${role(a.team)}</td><td>${a.hits}</td><td>${a.downs}</td><td>${a.revives}</td><td>${a.state.toUpperCase()}</td><td>${rep.session.roundWins[charIdByName(a.name)] || 0}</td></tr>`).join('');
  menuVisible(true);
  show('end');
}
const charIdByName = (n) => CHARACTERS.find(c => c.name === n)?.id;

$('btn-next').onclick = () => { rollTeams(); deploy(); };
$('btn-change').onclick = () => { game.cleanup(); show('mode'); buildMaps(); };
$('btn-menu').onclick = () => { game.cleanup(); show('title'); };

// pause
function pause() {
  if (!state.inGame || state.paused) return;
  state.paused = true;
  menuVisible(true); $('menu').classList.add('ingame');
  show('pause');
  audio.stopSpeech();
}
function resume() {
  state.paused = false;
  menuVisible(false); $('menu').classList.remove('ingame');
  lockPointer();
}
$('btn-resume').onclick = resume;
$('btn-pause-settings').onclick = () => { returnTo = 'pause'; buildSettings(); show('settings'); };
$('btn-quit').onclick = () => { state.inGame = false; state.paused = false; game.cleanup(); hud.show(false); $('menu').classList.remove('ingame'); show('title'); };

// settings form
function buildSettings() {
  const f = $('settings-form'); f.innerHTML = '';
  const rows = [
    ['sensitivity', 'Mouse sensitivity', 'range', 0.2, 3, 0.05],
    ['fov', 'Field of view', 'range', 60, 105, 1],
    ['difficulty', 'AI difficulty', 'select', [['0', 'Easy'], ['1', 'Normal'], ['2', 'Hard']]],
    ['voices', 'Spoken voice lines (text-to-speech)', 'check'],
    ['crosshair', 'Center dot', 'check'],
    ['autoReload', 'Auto reload', 'check'],
    ['invertY', 'Invert Y', 'check'],
    ['lens', 'Fisheye lens distortion', 'range', 0, 2, 0.05],
    ['shake', 'Camera shake / head bob', 'range', 0, 2, 0.05],
    ['motionBlur', 'Motion blur', 'range', 0, 2, 0.05],
    ['grain', 'Sensor noise', 'range', 0, 2, 0.05],
    ['prepTime', 'Hunt prep time (s)', 'range', 20, 120, 5],
    ['bleedout', 'Bleed-out timer (s)', 'range', 20, 90, 5],
  ];
  for (const [key, label, type, a, b, step] of rows) {
    const d = document.createElement('div'); d.className = 'set';
    let input;
    if (type === 'range') { input = document.createElement('input'); input.type = 'range'; input.min = a; input.max = b; input.step = step; input.value = settings[key]; }
    else if (type === 'check') { input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!settings[key]; }
    else { input = document.createElement('select'); for (const [v, l] of a) { const o = document.createElement('option'); o.value = v; o.textContent = l; input.appendChild(o); } input.value = String(settings[key]); }
    const val = document.createElement('span'); val.style.minWidth = '44px'; val.style.textAlign = 'right';
    const upd = () => {
      if (type === 'range') settings[key] = parseFloat(input.value);
      else if (type === 'check') settings[key] = input.checked;
      else settings[key] = parseInt(input.value, 10);
      val.textContent = type === 'range' ? settings[key] : '';
      audio.voices = settings.voices;
      saveSettings();
    };
    input.oninput = upd; input.onchange = upd; upd();
    const lab = document.createElement('label'); lab.textContent = label;
    const right = document.createElement('div'); right.style.display = 'flex'; right.style.gap = '10px'; right.style.alignItems = 'center';
    right.append(input, val);
    d.append(lab, right); f.appendChild(d);
  }
}

// ---------------- input ----------------
const input = { keys: new Set(), pressed: new Set(), mdx: 0, mdy: 0, fire: false, firePressed: false, ads: false };
function lockPointer() {
  try { const r = canvas.requestPointerLock?.(); if (r && r.catch) r.catch(() => $('click-to-play').classList.remove('hidden')); } catch (e) { $('click-to-play').classList.remove('hidden'); }
}
$('click-to-play').onclick = () => { $('click-to-play').classList.add('hidden'); lockPointer(); };
canvas.addEventListener('click', () => { if (state.inGame && !state.paused && document.pointerLockElement !== canvas) lockPointer(); });
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (locked) $('click-to-play').classList.add('hidden');
  if (!locked && state.inGame && !state.paused && !game.over) pause();
});
addEventListener('keydown', (e) => {
  if (state.inGame && ['Tab', 'Space', 'ControlLeft', 'KeyW', 'KeyS', 'KeyA', 'KeyD'].includes(e.code)) e.preventDefault();
  if (e.code === 'Escape' && state.paused) { resume(); return; }
  if (!e.repeat) input.pressed.add(e.code);
  input.keys.add(e.code);
  if (e.code === 'Tab' && state.inGame) showScoreboard(true);
});
addEventListener('keyup', (e) => { input.keys.delete(e.code); if (e.code === 'Tab') showScoreboard(false); });
addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { input.mdx += e.movementX; input.mdy += e.movementY; } });
addEventListener('mousedown', (e) => {
  if (!state.inGame || state.paused) return;
  if (document.pointerLockElement !== canvas) return;
  if (e.button === 0) { input.fire = true; input.firePressed = true; }
  if (e.button === 2) input.ads = true;
});
addEventListener('mouseup', (e) => { if (e.button === 0) input.fire = false; if (e.button === 2) input.ads = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('blur', () => { input.keys.clear(); input.fire = false; input.ads = false; });

function showScoreboard(v) {
  const sb = $('scoreboard');
  sb.classList.toggle('hidden', !v);
  if (!v || !game.actors) return;
  const rows = game.actors.filter(a => !a.neutral).sort((a, b) => a.team - b.team).map(a =>
    `<tr class="${a.isPlayer ? 'me' : ''}"><td class="t${a.team}">${a.name}${a.isPlayer ? ' (YOU)' : ''}</td><td>${a.char.title}</td><td>${a.state === 'alive' ? '◆'.repeat(a.lives) : a.state.toUpperCase()}</td><td>${a.stats.hits}</td><td>${a.stats.revives}</td></tr>`).join('');
  sb.innerHTML = `<table><tr><th>NAME</th><th>ROLE</th><th>LIVES</th><th>HITS</th><th>REVIVES</th></tr>${rows}</table>`;
}

// ---------------- loop ----------------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000; last = now;
  dt = Math.min(dt, 0.05);
  if (state.inGame && !state.paused) {
    game.update(dt, input);
    hud.update(dt, game);
    if (!$('scoreboard').classList.contains('hidden')) showScoreboard(true);
  }
  if (game.scene) game.render(state.paused ? 0 : dt);
  else renderer.clear();
  input.pressed.clear(); input.mdx = 0; input.mdy = 0; input.firePressed = false;
}
requestAnimationFrame(frame);

buildChars();
show('title');

// debug/automation hook: ?auto=charId,mode,map starts immediately
const qp = new URLSearchParams(location.search);
if (qp.get('auto')) {
  const [c, m, mp] = qp.get('auto').split(',');
  state.charId = c || 'kai'; state.mode = m || 'tdm'; state.mapId = mp || 'basement';
  rollTeams(); deploy();
}
