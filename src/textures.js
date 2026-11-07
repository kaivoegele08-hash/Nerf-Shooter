// Procedural canvas textures (no external assets needed).
import * as THREE from '../lib/three.module.min.js';
import { mulberry32 } from './world.js';

const cache = {};

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function noiseFill(ctx, size, base, vary, rng, alpha = 1) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * vary;
    d[i] = Math.max(0, Math.min(255, base[0] + n));
    d[i + 1] = Math.max(0, Math.min(255, base[1] + n));
    d[i + 2] = Math.max(0, Math.min(255, base[2] + n));
    d[i + 3] = 255 * alpha;
  }
  ctx.putImageData(img, 0, 0);
}

function blotches(ctx, size, rng, n, color, rMin, rMax) {
  for (let i = 0; i < n; i++) {
    const x = rng() * size, y = rng() * size, r = rMin + rng() * (rMax - rMin);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

function make(key, size, draw) {
  if (cache[key]) return cache[key];
  const c = canvas(size);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  draw(ctx, size, mulberry32(key.length * 7919 + key.charCodeAt(0)));
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  cache[key] = t;
  return t;
}

export const TEX = {
  concrete: () => make('concrete', 256, (ctx, s, r) => {
    noiseFill(ctx, s, [128, 126, 120], 26, r);
    blotches(ctx, s, r, 18, 'rgba(60,55,45,0.18)', 10, 60);
    blotches(ctx, s, r, 10, 'rgba(200,200,190,0.12)', 10, 40);
    ctx.strokeStyle = 'rgba(40,40,40,0.25)'; ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) { ctx.beginPath(); let x = r() * s, y = r() * s; ctx.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 40; y += (r() - 0.5) * 40; ctx.lineTo(x, y); } ctx.stroke(); }
  }),
  carpet: () => make('carpet', 128, (ctx, s, r) => {
    noiseFill(ctx, s, [92, 74, 62], 34, r);
    blotches(ctx, s, r, 6, 'rgba(40,30,20,0.2)', 8, 30);
  }),
  paint: () => make('paint', 256, (ctx, s, r) => {
    noiseFill(ctx, s, [196, 190, 176], 10, r);
    // cinderblock lines
    ctx.strokeStyle = 'rgba(90,85,75,0.35)'; ctx.lineWidth = 2;
    for (let y = 0; y <= s; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke(); }
    for (let row = 0; row < s / 32; row++) for (let x = (row % 2) * 32; x <= s; x += 64) { ctx.beginPath(); ctx.moveTo(x, row * 32); ctx.lineTo(x, row * 32 + 32); ctx.stroke(); }
    blotches(ctx, s, r, 8, 'rgba(110,100,70,0.15)', 10, 50);
  }),
  wood: () => make('wood', 256, (ctx, s, r) => {
    noiseFill(ctx, s, [140, 100, 62], 18, r);
    for (let x = 0; x < s; x += 32) {
      ctx.fillStyle = `rgba(${60 + r() * 30},${40 + r() * 20},20,0.25)`; ctx.fillRect(x, 0, 32, s);
      ctx.fillStyle = 'rgba(30,20,10,0.5)'; ctx.fillRect(x, 0, 2, s);
      for (let k = 0; k < 10; k++) { ctx.fillStyle = 'rgba(70,45,25,0.18)'; ctx.fillRect(x + r() * 30, 0, 1, s); }
    }
  }),
  grass: () => make('grass', 256, (ctx, s, r) => {
    noiseFill(ctx, s, [70, 104, 48], 40, r);
    blotches(ctx, s, r, 30, 'rgba(110,130,60,0.25)', 6, 30);
    blotches(ctx, s, r, 20, 'rgba(30,50,20,0.25)', 6, 30);
    for (let i = 0; i < 1400; i++) { ctx.fillStyle = `rgba(${40 + r() * 60},${90 + r() * 70},${30 + r() * 30},0.6)`; ctx.fillRect(r() * s, r() * s, 1, 3 + r() * 3); }
  }),
  forest: () => make('forest', 256, (ctx, s, r) => {
    noiseFill(ctx, s, [78, 64, 42], 34, r);
    blotches(ctx, s, r, 30, 'rgba(60,80,30,0.3)', 8, 40);
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = `rgba(${120 + r() * 80},${60 + r() * 50},${20 + r() * 20},0.7)`;
      ctx.beginPath(); ctx.ellipse(r() * s, r() * s, 2 + r() * 3, 1 + r() * 2, r() * 3, 0, 7); ctx.fill();
    }
    for (let i = 0; i < 60; i++) { ctx.strokeStyle = 'rgba(50,35,20,0.6)'; ctx.beginPath(); const x = r() * s, y = r() * s; ctx.moveTo(x, y); ctx.lineTo(x + (r() - .5) * 30, y + (r() - .5) * 30); ctx.stroke(); }
  }),
  dirt: () => make('dirt', 128, (ctx, s, r) => {
    noiseFill(ctx, s, [112, 88, 60], 30, r);
    blotches(ctx, s, r, 12, 'rgba(70,50,30,0.3)', 5, 20);
  }),
  stone: () => make('stone', 256, (ctx, s, r) => {
    noiseFill(ctx, s, [150, 146, 138], 22, r);
    ctx.strokeStyle = 'rgba(60,60,55,0.6)'; ctx.lineWidth = 3;
    for (let y = 0; y <= s; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke(); }
    for (let x = 0; x <= s; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, s); ctx.stroke(); }
    blotches(ctx, s, r, 10, 'rgba(80,90,50,0.2)', 10, 40);
  }),
  brick: () => make('brick', 256, (ctx, s, r) => {
    ctx.fillStyle = '#8a8478'; ctx.fillRect(0, 0, s, s);
    for (let row = 0; row < 16; row++) for (let i = -1; i < 5; i++) {
      const x = i * 64 + (row % 2) * 32, y = row * 16;
      ctx.fillStyle = `rgb(${140 + r() * 40},${60 + r() * 25},${45 + r() * 20})`;
      ctx.fillRect(x + 2, y + 2, 60, 12);
    }
  }),
  bark: () => make('bark', 128, (ctx, s, r) => {
    noiseFill(ctx, s, [80, 62, 46], 30, r);
    for (let i = 0; i < 40; i++) { ctx.fillStyle = 'rgba(30,22,15,0.5)'; ctx.fillRect(r() * s, 0, 2 + r() * 3, s); }
  }),
  leaves: () => make('leaves', 128, (ctx, s, r) => {
    noiseFill(ctx, s, [56, 88, 40], 50, r);
    blotches(ctx, s, r, 30, 'rgba(20,40,10,0.4)', 4, 14);
    blotches(ctx, s, r, 20, 'rgba(120,150,60,0.3)', 4, 12);
  }),
  metal: () => make('metal', 128, (ctx, s, r) => {
    noiseFill(ctx, s, [150, 152, 156], 12, r);
    for (let i = 0; i < s; i += 2) { ctx.fillStyle = `rgba(255,255,255,${r() * 0.05})`; ctx.fillRect(0, i, s, 1); }
  }),
  blades: () => {
    if (cache.blades) return cache.blades;
    const c = canvas(128); const ctx = c.getContext('2d'); const r = mulberry32(99);
    for (let i = 0; i < 46; i++) {
      const x = 8 + r() * 112, h = 50 + r() * 76, bend = (r() - 0.5) * 30;
      ctx.strokeStyle = `rgb(${60 + r() * 50},${95 + r() * 70},${30 + r() * 30})`; ctx.lineWidth = 2 + r() * 3;
      ctx.beginPath(); ctx.moveTo(x, 128); ctx.quadraticCurveTo(x + bend * 0.3, 128 - h * 0.6, x + bend, 128 - h); ctx.stroke();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; cache.blades = t; return t;
  },
  fabric: () => make('fabric', 64, (ctx, s, r) => {
    noiseFill(ctx, s, [200, 200, 200], 30, r);
  }),
};

export function sprayDecal(text, w = 512, h = 256, color = '#111', bg = 'rgba(0,0,0,0)', font = 'bold 64px sans-serif') {
  const c = canvas(1); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = color; ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = text.split('\n');
  lines.forEach((l, i) => ctx.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * parseInt(font.match(/(\d+)px/)[1]) * 1.1));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
