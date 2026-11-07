// Bodycam look: chest-mounted camera rig, first-person blaster viewmodel, and the post-processing lens shader.
import * as THREE from '../lib/three.module.min.js';
import { buildBlaster } from './actor.js';

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const POST_FRAG = `
precision highp float;
uniform sampler2D tScene; uniform sampler2D tPrev;
uniform float time, distort, aberr, grain, vignette, blur, flash, glitch, desat, exposure, lowlight, redFlash, dark, intensity;
uniform vec2 vel; uniform vec2 res;
varying vec2 vUv;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
vec2 barrel(vec2 uv, float k){
  vec2 c = uv * 2.0 - 1.0;
  float aspect = res.x / res.y;
  c.x *= aspect;
  float r2 = dot(c, c);
  float rc = aspect * aspect + 1.0;
  c *= (1.0 + k * r2 + k * 0.35 * r2 * r2) / (1.0 + k * rc + k * 0.35 * rc * rc);
  c.x /= aspect;
  return c * 0.5 + 0.5;
}
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
void main(){
  vec2 uv = vUv;
  if (glitch > 0.0) {
    float line = floor(uv.y * 48.0);
    float n = hash(vec2(line, floor(time * 24.0)));
    if (n < glitch * 0.6) uv.x += (hash(vec2(line, time)) - 0.5) * 0.06 * glitch;
  }
  vec2 duv = barrel(uv, distort);
  vec2 dir = duv - 0.5;
  float edge = dot(dir, dir) * 4.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 7; i++) {
    float t = float(i) / 6.0 - 0.5;
    vec2 o = vel * t;
    acc.r += texture2D(tScene, duv + o + dir * aberr * edge).r;
    acc.g += texture2D(tScene, duv + o).g;
    acc.b += texture2D(tScene, duv + o - dir * aberr * edge).b;
  }
  vec3 col = acc / 7.0;
  col *= exposure;
  col += max(col - 0.85, 0.0) * 0.6; // highlight bloom-ish clipping
  col = aces(col);
  col = toSRGB(col);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, clamp(0.8 - desat, 0.0, 1.0));
  col = (col - 0.5) * 1.08 + 0.5 + vec3(-0.01, 0.005, 0.012);
  // auto-gain noise: stronger in darker areas
  float n = hash(vUv * res + fract(time * 7.13) * 100.0) - 0.5;
  float n2 = hash(floor(vUv * res / 2.0) + fract(time * 3.7) * 50.0) - 0.5;
  col += (n * 0.7 + n2 * 0.5) * grain * (0.5 + lowlight * (1.0 - l) * 1.6) * intensity;
  // vignette
  float v = smoothstep(1.05, 0.25, length(dir * vec2(res.x / res.y, 1.0)) * 1.1);
  col *= mix(1.0, v, vignette);
  // temporal smear (sensor lag)
  vec3 prev = texture2D(tPrev, vUv).rgb;
  col = mix(col, prev, blur);
  // faint interlace
  col *= 0.975 + 0.025 * sin(vUv.y * res.y * 1.5708 + time * 30.0);
  col = mix(col, vec3(0.6, 0.05, 0.03), redFlash);
  col = mix(col, vec3(1.0), flash);
  col *= 1.0 - dark;
  if (duv.x < 0.0 || duv.x > 1.0 || duv.y < 0.0 || duv.y > 1.0) col = vec3(0.0);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const COPY_FRAG = `precision highp float; uniform sampler2D t; varying vec2 vUv; void main(){ gl_FragColor = texture2D(t, vUv); }`;

export class Bodycam {
  constructor(renderer) {
    this.r = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const opts = { type: THREE.HalfFloatType, depthBuffer: true };
    this.rtScene = new THREE.WebGLRenderTarget(size.x, size.y, { ...opts, samples: 4 });
    this.rtA = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.UnsignedByteType, depthBuffer: false });
    this.rtB = this.rtA.clone();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.PlaneGeometry(2, 2);
    this.post = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: POST_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tScene: { value: null }, tPrev: { value: null }, time: { value: 0 }, distort: { value: 0.22 }, aberr: { value: 0.004 },
        grain: { value: 0.06 }, vignette: { value: 0.55 }, blur: { value: 0.18 }, flash: { value: 0 }, glitch: { value: 0 },
        desat: { value: 0 }, exposure: { value: 1.0 }, lowlight: { value: 0.5 }, redFlash: { value: 0 }, dark: { value: 0 },
        vel: { value: new THREE.Vector2() }, res: { value: new THREE.Vector2(size.x, size.y) }, intensity: { value: 1 },
      },
    });
    this.copy = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COPY_FRAG, uniforms: { t: { value: null } }, depthTest: false, depthWrite: false });
    this.quad = new THREE.Mesh(geo, this.post);
    this.quadScene = new THREE.Scene(); this.quadScene.add(this.quad);
    this.flip = false;
    this.fx = { flash: 0, glitch: 0, redFlash: 0, dark: 0 };
  }

  setSize(w, h) {
    this.rtScene.setSize(w, h); this.rtA.setSize(w, h); this.rtB.setSize(w, h);
    this.post.uniforms.res.value.set(w, h);
  }

  render(scene, camera, vmScene, dt, params) {
    const r = this.r;
    const U = this.post.uniforms;
    r.setRenderTarget(this.rtScene);
    r.autoClear = true;
    r.render(scene, camera);
    if (vmScene) { r.autoClear = false; r.clearDepth(); r.render(vmScene, camera); r.autoClear = true; }
    const src = this.flip ? this.rtA : this.rtB, dst = this.flip ? this.rtB : this.rtA;
    this.flip = !this.flip;
    // decay transient effects
    const f = this.fx;
    f.flash = Math.max(0, f.flash - dt * 4); f.glitch = Math.max(0, f.glitch - dt * 1.5); f.redFlash = Math.max(0, f.redFlash - dt * 2.5);
    U.tScene.value = this.rtScene.texture; U.tPrev.value = src.texture;
    U.time.value += dt;
    U.flash.value = f.flash; U.glitch.value = Math.max(f.glitch, params.glitch || 0); U.redFlash.value = f.redFlash * 0.25;
    U.dark.value = params.dark || 0;
    U.desat.value = params.desat || 0;
    U.exposure.value = params.exposure ?? 1;
    U.lowlight.value = params.lowlight ?? 0.5;
    U.blur.value = Math.min(0.6, (params.blur ?? 0.15));
    U.vel.value.copy(params.vel || new THREE.Vector2());
    U.distort.value = params.distort ?? 0.22;
    U.intensity.value = params.intensity ?? 1;
    U.grain.value = params.grain ?? 0.06;
    this.quad.material = this.post;
    r.setRenderTarget(dst); r.render(this.quadScene, this.quadCam);
    this.copy.uniforms.t.value = dst.texture;
    this.quad.material = this.copy;
    r.setRenderTarget(null); r.render(this.quadScene, this.quadCam);
  }
}

// Chest-mounted camera with handheld micro-shake, stride bob and trauma.
export class CameraRig {
  constructor(camera) {
    this.cam = camera;
    this.yaw = 0; this.pitch = 0; this.roll = 0;
    this.trauma = 0; this.t = 0;
    this.prevYaw = 0; this.prevPitch = 0;
    this.vel = new THREE.Vector2();
    this.pos = new THREE.Vector3();
    this.landKick = 0;
    this.eyeY = 1.5;
  }

  addTrauma(v) { this.trauma = Math.min(1, this.trauma + v); }

  update(dt, actor, opts = {}) {
    this.t += dt;
    const sp = actor.speed || 0;
    const bobAmt = (actor.char.bob || 1) * Math.min(1.3, sp / 4.5) * (actor.crouch ? 0.5 : 1) * (opts.intensity ?? 1);
    const ph = actor.stepPhase * 2.2;
    // smooth eye height (crouch / downed transitions)
    const targetEye = actor.eyeHeight - 0.14;
    this.eyeY += (targetEye - this.eyeY) * Math.min(1, dt * (actor.state === 'downed' ? 3 : 10));
    // rotation follows actor with slight lag (chest mount)
    const lag = opts.spectator ? 7 : 28;
    const dy = Math.atan2(Math.sin(actor.yaw - this.yaw), Math.cos(actor.yaw - this.yaw));
    this.yaw += dy * Math.min(1, dt * lag);
    this.pitch += (actor.pitch - this.pitch) * Math.min(1, dt * lag);
    // handheld micro shake
    const t = this.t;
    const micro = 0.0025 * (opts.intensity ?? 1) * (1 + (actor.state === 'downed' ? 2 : 0) + (opts.stress || 0) * 2);
    let sx = (Math.sin(t * 1.7) + Math.sin(t * 2.9 + 1.3) * 0.6 + Math.sin(t * 7.1) * 0.15) * micro;
    let sy = (Math.sin(t * 1.3 + 2) + Math.sin(t * 3.7) * 0.5 + Math.sin(t * 8.3) * 0.15) * micro;
    // stride bob (vertical twice per stride, lateral sway)
    const bobV = Math.abs(Math.sin(ph)) * 0.045 * bobAmt;
    const bobL = Math.cos(ph) * 0.03 * bobAmt;
    const rollB = Math.cos(ph) * 0.018 * bobAmt + (actor.sprint ? Math.sin(ph) * 0.01 : 0);
    // trauma shake
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const tr = this.trauma * this.trauma;
    sx += (Math.random() - 0.5) * 0.08 * tr; sy += (Math.random() - 0.5) * 0.08 * tr;
    this.landKick = Math.max(0, this.landKick - dt * 4);
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    this.pos.set(actor.pos.x, actor.pos.y + this.eyeY - bobV - this.landKick * 0.12, actor.pos.z)
      .addScaledVector(fwd, 0.12).addScaledVector(right, bobL);
    const cam = this.cam;
    cam.position.copy(this.pos);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.yaw + sx;
    cam.rotation.x = this.pitch + sy - this.landKick * 0.05 + (actor.sprint && sp > 3 ? -0.03 : 0);
    const downRoll = actor.state === 'downed' ? Math.sin(t * 0.6) * 0.05 + 0.06 : 0;
    this.roll += ((rollB + downRoll + (opts.lean || 0)) - this.roll) * Math.min(1, dt * 8);
    cam.rotation.z = this.roll + (Math.random() - 0.5) * 0.03 * tr;
    cam.updateMatrixWorld();
    // angular velocity -> screen-space motion blur vector
    const dYaw = Math.atan2(Math.sin(cam.rotation.y - this.prevYaw), Math.cos(cam.rotation.y - this.prevYaw));
    const dPitch = cam.rotation.x - this.prevPitch;
    this.prevYaw = cam.rotation.y; this.prevPitch = cam.rotation.x;
    const vf = THREE.MathUtils.degToRad(cam.fov), hf = vf * cam.aspect;
    const k = (opts.blurScale ?? 1);
    this.vel.set(THREE.MathUtils.clamp(dYaw / hf * k, -0.05, 0.05), THREE.MathUtils.clamp(-dPitch / vf * k, -0.05, 0.05));
    this.vel.y += bobAmt * Math.cos(ph * 2) * 0.0015;
  }
}

// First-person blaster + hands rendered in an overlay scene so it never clips walls.
export class Viewmodel {
  constructor() {
    this.scene = new THREE.Scene();
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2); this.scene.add(this.hemi);
    this.dir = new THREE.DirectionalLight(0xffffff, 1.0); this.dir.position.set(1, 2, 1); this.scene.add(this.dir);
    this.holder = new THREE.Group(); this.root.add(this.holder);
    this.kick = 0; this.swayX = 0; this.swayY = 0; this.reloadT = 0; this.adsK = 0; this.t = 0;
    this.kind = null;
  }

  setWeapon(def, char) {
    this.holder.clear();
    const bl = buildBlaster(def.kind, def.color, 1.0);
    this.holder.add(bl);
    this.blaster = bl;
    const skin = new THREE.MeshStandardMaterial({ color: char.skin, roughness: 0.7 });
    const sleeve = new THREE.MeshStandardMaterial({ color: char.color, roughness: 0.9 });
    const hand = (x, y, z, rx = 0) => {
      const g = new THREE.Group();
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.11), skin); g.add(h);
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.32), sleeve); s.position.set(0, -0.01, 0.2); g.add(s);
      g.position.set(x, y, z); g.rotation.x = rx; this.holder.add(g);
    };
    hand(0, -0.06, 0.05, 0.3);
    if (def.kind === 'twin') {
      const b2 = buildBlaster('twin', def.color, 1.0); b2.position.set(-0.32, 0, 0); this.holder.add(b2); hand(-0.32, -0.06, 0.05, 0.3);
    } else hand(-0.03, -0.04, def.kind === 'pistol' ? 0.02 : -0.22, 0.1);
    this.kind = def.kind;
  }

  update(dt, camera, actor, input = {}) {
    this.t += dt;
    this.root.position.copy(camera.position);
    this.root.quaternion.copy(camera.quaternion);
    const ads = actor.ads && actor.weapon.reloading <= 0 && !actor.sprint;
    this.adsK += ((ads ? 1 : 0) - this.adsK) * Math.min(1, dt * 12);
    this.kick = Math.max(0, this.kick - dt * 9);
    this.swayX += ((input.mdx || 0) * -0.0006 - this.swayX) * Math.min(1, dt * 10);
    this.swayY += ((input.mdy || 0) * 0.0006 - this.swayY) * Math.min(1, dt * 10);
    const sp = actor.speed || 0;
    const ph = actor.stepPhase * 2.2;
    const bob = Math.min(1, sp / 5);
    const sprint = actor.sprint && sp > 3 ? 1 : 0;
    const reload = actor.weapon.reloading > 0 ? 1 : 0;
    this.reloadT += ((reload ? 1 : 0) - this.reloadT) * Math.min(1, dt * 8);
    const k = this.adsK;
    const baseX = 0.2 * (1 - k) + 0.0 * k, baseY = -0.2 * (1 - k) + -0.115 * k, baseZ = -0.42 * (1 - k) + -0.3 * k;
    const h = this.holder;
    h.position.set(
      baseX + this.swayX + Math.cos(ph) * 0.012 * bob * (1 - k * 0.8) + sprint * 0.05,
      baseY + this.swayY - Math.abs(Math.sin(ph)) * 0.015 * bob - sprint * 0.06 - this.reloadT * 0.08 + Math.sin(this.t * 1.3) * 0.002,
      baseZ + this.kick * 0.06
    );
    h.rotation.set(this.kick * 0.18 + sprint * -0.5 - this.reloadT * 0.6 + this.swayY * 2, sprint * 0.6 + this.swayX * 2 + this.reloadT * 0.3, sprint * 0.3 + this.reloadT * 0.5);
    if (this.kind === 'twin') h.position.x += 0.14 * (1 - k);
    this.root.visible = actor.state === 'alive';
  }
  fire() { this.kick = 1; }
}
