/*!
 * chibineko 1.0.0: a little 3D cat that chases your cursor. MIT licensed.
 * A 3D take on oneko.js by adryd325 (MIT): https://github.com/adryd325/oneko.js
 * Neko was originally created by Masayuki Koba.
 *
 * Usage:
 *   <script src="https://cdn.jsdelivr.net/gh/Rulesobeyer/chibineko@1/chibineko.min.js"
 *     data-size="64"            cat height in CSS px
 *     data-color="#ffffff"      fur colour
 *     data-outline="#1a1a1a"    outline / eye colour
 *     data-accent="#ffb3c1"     inner ears, nose, blush
 *     data-speed="1"            speed multiplier
 *     data-persist-position     remember position across page loads
 *     data-pet="false"          disable click-to-pet (and the right-click colour picker)
 *     data-prints="false"       no paw prints
 *     data-blur="false"         no motion blur
 *     data-three="..."          self-hosted three.module(.min).js URL
 *   ></script>
 */
(async function chibineko() {
  "use strict";

  const VERSION = "1.0.0";
  if (window.chibineko) return;
  const script = document.currentScript || document.querySelector('script[src*="chibineko"]');
  const ds = (script && script.dataset) || {};
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const positive = (v, d) => {
    const n = parseFloat(v);
    return n > 0 ? n : d;
  };
  const cfg = {
    size: positive(ds.size, 64),
    color: ds.color || "#ffffff",
    outline: ds.outline || "#1a1a1a",
    accent: ds.accent || "#ffb3c1",
    speed: positive(ds.speed, 1),
    persist: ds.persistPosition !== undefined && ds.persistPosition !== "false",
    pet: ds.pet !== "false",
    prints: ds.prints !== "false",
    blur: ds.blur !== "false",
    three: ds.three || "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js",
  };

  const PRESETS = {
    white: { color: "#ffffff", outline: "#1a1a1a", accent: "#ffb3c1" },
    black: { color: "#2a2a30", outline: "#ffffff", accent: "#ff9db4" },
    ginger: { color: "#f3a35c", outline: "#3a2416", accent: "#ffb8a8" },
    grey: { color: "#a9b1bb", outline: "#22252a", accent: "#ffb3c1" },
    cream: { color: "#f2e2c4", outline: "#4a3b2a", accent: "#ffb3a7" },
    tabby: { color: "#9a7a5c", outline: "#2b1d12", accent: "#ffb3a7" },
  };
  // A colour the viewer picked (right-click menu or setColors) wins over data-* attributes.
  const COLORS_KEY = "chibineko:colors";
  const POSITION_KEY = "chibineko:position";
  const COLOR_KEYS = ["color", "outline", "accent"];
  try {
    const saved = JSON.parse(localStorage.getItem(COLORS_KEY));
    for (const k of COLOR_KEYS) if (saved && typeof saved[k] === "string") cfg[k] = saved[k];
  } catch (_) {
    /* storage unavailable */
  }

  // Claim the slot synchronously so a second copy of the script bails out.
  window.chibineko = { loading: true };

  let THREE;
  try {
    THREE = window.THREE && window.THREE.WebGLRenderer ? window.THREE : await import(cfg.three);
  } catch (err) {
    console.warn("chibineko: could not load three.js from " + cfg.three, err);
    delete window.chibineko;
    return;
  }
  if (!document.body) {
    await new Promise((r) => document.addEventListener("DOMContentLoaded", r, { once: true }));
  }

  // ---------------------------------------------------------------- helpers

  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
  const wrap = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
  const frac = (x) => x - Math.floor(x);
  const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const rand = (a, b) => a + Math.random() * (b - a);
  const bump = (t, len) => (t > 0 && t < len ? Math.sin((Math.PI * t) / len) : 0);
  const isLight = (css) => {
    const c = new THREE.Color(css); // linear
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.35;
  };

  // Damped spring, sub-stepped so large frame gaps stay stable.
  const springState = () => ({ x: 0, v: 0 });
  function spring(st, target, k, zeta, dt) {
    const steps = Math.max(1, Math.ceil(dt / 0.012));
    const h = dt / steps;
    const c = 2 * zeta * Math.sqrt(k);
    for (let i = 0; i < steps; i++) {
      st.v += (k * (target - st.x) - c * st.v) * h;
      st.x += st.v * h;
    }
    return st.x;
  }

  // ---------------------------------------------------------------- sizing

  const S = cfg.size;
  const s = S / 64;
  const VIEW = 3; // world units across the canvas; 1 world unit ≈ S css px
  const CANVAS = Math.round(S * VIEW);
  const PITCH = (32 * Math.PI) / 180;
  const SIN_P = Math.sin(PITCH);
  const STOP = 56 * s; // stop this far from the pointer (oneko: 48px)
  const START = STOP + 14 * s; // hysteresis before chasing again
  const WALK = 90 * s * cfg.speed;
  const RUN = 320 * s * cfg.speed;
  const ACCEL = 720 * s * cfg.speed;
  const DECEL = 1100 * s * cfg.speed;
  const MAX_TURN = 9; // rad/s
  const HIT = Math.round(S * 0.9);

  // ---------------------------------------------------------------- renderer

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: CANVAS + "px",
    height: CANVAS + "px",
    pointerEvents: "none",
    zIndex: "2147483647",
    willChange: "transform",
  });

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch (err) {
    console.warn("chibineko: WebGL is not available", err);
    delete window.chibineko;
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(CANVAS, CANVAS, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-VIEW / 2, VIEW / 2, VIEW / 2, -VIEW / 2, 0.1, 50);
  const LOOK = new THREE.Vector3(0, 0.45, 0);
  camera.position.set(0, Math.sin(PITCH) * 20, Math.cos(PITCH) * 20).add(LOOK);
  camera.lookAt(LOOK);
  camera.updateMatrixWorld();

  // Canvas pixel that sits on the cat's logical position (its body centre).
  const anchor = LOOK.clone().project(camera);
  const AX = ((anchor.x + 1) / 2) * CANVAS;
  const AY = ((1 - anchor.y) / 2) * CANVAS;

  scene.add(new THREE.HemisphereLight(0xffffff, 0xaab4d4, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.9);
  key.position.set(-1.5, 3, 2.2);
  scene.add(key);

  // ---------------------------------------------------------------- materials

  const gradient = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;

  const furMat = new THREE.MeshToonMaterial({ color: cfg.color, gradientMap: gradient });
  const accentMat = new THREE.MeshToonMaterial({ color: cfg.accent, gradientMap: gradient });
  const inkMat = new THREE.MeshBasicMaterial({ color: cfg.outline });
  const shineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const mouthMat = new THREE.MeshBasicMaterial({ color: 0x6b2737 });
  const blushMat = new THREE.MeshBasicMaterial({
    color: cfg.accent,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });

  // Inverted-hull outline: back faces pushed out along their normals. The push happens
  // before skinning, so the same material outlines rigid and skinned meshes.
  const outlineMat = new THREE.MeshBasicMaterial({ color: cfg.outline, side: THREE.BackSide });
  outlineMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      "vec3 transformed = position + normalize(normal) * 0.026;"
    );
  };

  // Shapes are baked into geometry (not mesh scale) so outline width stays even.
  const ellipsoid = (rx, ry, rz, w = 24, h = 16) => new THREE.SphereGeometry(1, w, h).scale(rx, ry, rz);
  const capsuleDown = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 12).translate(0, -len / 2, 0);

  function part(geometry, material, parent, x = 0, y = 0, z = 0, outline = true) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    if (outline) mesh.add(new THREE.Mesh(geometry, outlineMat));
    return mesh;
  }

  // Average the normals of vertices that share a position (sphere seams and poles),
  // so displaced geometry shades without creases.
  function weldNormals(geometry) {
    const pos = geometry.attributes.position;
    const nor = geometry.attributes.normal;
    const groups = new Map();
    for (let i = 0; i < pos.count; i++) {
      const k = Math.round(pos.getX(i) * 1e4) + "," + Math.round(pos.getY(i) * 1e4) + "," + Math.round(pos.getZ(i) * 1e4);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(i);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      let x = 0;
      let y = 0;
      let z = 0;
      for (const i of g) {
        x += nor.getX(i);
        y += nor.getY(i);
        z += nor.getZ(i);
      }
      const l = Math.hypot(x, y, z) || 1;
      for (const i of g) nor.setXYZ(i, x / l, y / l, z / l);
    }
  }

  const _v = new THREE.Vector3();

  // ---------------------------------------------------------------- cat rig
  // Cat space: the cat faces +Z, +X is its left, y = 0 is the floor. ~1 unit = standing height.

  const root = new THREE.Group();
  scene.add(root);

  // Torso: one skinned mesh over two bones so the spine can arch and stretch.
  const HIPS = new THREE.Vector3(0, 0.36, -0.12);
  const BEND_Z = 0.04; // where the spine flexes
  // Pear-shaped: full at the rump, tapering towards the shoulders. u = -1 rump, +1 chest.
  const torsoProfile = [];
  for (let i = 0; i <= 28; i++) {
    const u = -1 + (2 * i) / 28;
    const base = lerp(0.172, 0.128, (u + 1) / 2) * (1 + 0.06 * Math.exp(-(((u + 0.45) / 0.35) ** 2)));
    const r = base * Math.pow(Math.max(0, 1 - Math.abs(u) ** 2.4), 1 / 2.4);
    torsoProfile.push(new THREE.Vector2(r, 0.02 + u * 0.35));
  }
  const torsoGeo = new THREE.LatheGeometry(torsoProfile, 22)
    .rotateX(Math.PI / 2)
    .scale(0.92, 1, 1)
    .translate(0, HIPS.y, 0);
  {
    const pos = torsoGeo.attributes.position;
    const index = new Uint16Array(pos.count * 4);
    const weight = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      const w = smooth(-0.2, 0.2, pos.getZ(i) - BEND_Z); // wide blend: the back curves, not kinks
      index[i * 4 + 1] = 1;
      weight[i * 4] = 1 - w;
      weight[i * 4 + 1] = w;
    }
    torsoGeo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(index, 4));
    torsoGeo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weight, 4));
  }
  const hips = new THREE.Bone();
  hips.position.copy(HIPS);
  hips.rotation.order = "YXZ";
  root.add(hips);
  const chest = new THREE.Bone();
  chest.position.set(0, 0, BEND_Z - HIPS.z);
  chest.rotation.order = "YXZ";
  hips.add(chest);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([hips, chest]);
  const torso = new THREE.SkinnedMesh(torsoGeo, furMat);
  const torsoInk = new THREE.SkinnedMesh(torsoGeo, outlineMat);
  root.add(torso, torsoInk);
  torso.bind(skeleton);
  torsoInk.bind(skeleton, torso.bindMatrix);
  torso.frustumCulled = torsoInk.frustumCulled = false;
  const chestM = new THREE.Matrix4(); // chest bone in cat space

  // Head: a wide ellipsoid with a muzzle bump baked into its surface.
  const NECK = new THREE.Vector3(0, 0.09, 0.22); // on the chest bone
  const neck = new THREE.Group(); // counter-rotates the torso so head angles are absolute
  neck.position.copy(NECK);
  chest.add(neck);
  const head = new THREE.Group();
  head.rotation.order = "YXZ";
  neck.add(head);
  const face = new THREE.Group();
  face.position.set(0, 0.13, 0.07);
  head.add(face);

  const HR = new THREE.Vector3(0.27, 0.22, 0.225);
  const MUZZLE = new THREE.Vector3(0, -0.3, 1).normalize();
  // Surface point of the head in direction (x, y, z), including the muzzle bump.
  function headPoint(x, y, z, out = new THREE.Vector3()) {
    out.set(x, y, z).normalize();
    const b = 0.055 * Math.exp(-((Math.acos(clamp(out.dot(MUZZLE), -1, 1)) / 0.4) ** 2));
    return out.set(out.x * (HR.x + b), out.y * (HR.y + b), out.z * (HR.z + b));
  }
  const headGeo = new THREE.SphereGeometry(1, 40, 28);
  {
    const pos = headGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      headPoint(pos.getX(i), pos.getY(i), pos.getZ(i), _v);
      pos.setXYZ(i, _v.x, _v.y, _v.z);
    }
    headGeo.computeVertexNormals();
    weldNormals(headGeo);
  }
  part(headGeo, furMat, face);

  // Attach obj to the face surface in direction (x, y, z), facing outwards. Yaw and pitch
  // only, no roll, so vertical features (eyes) stay upright.
  function onFace(obj, x, y, z, inset = 0) {
    const p = headPoint(x, y, z);
    const n = new THREE.Vector3(p.x / (HR.x * HR.x), p.y / (HR.y * HR.y), p.z / (HR.z * HR.z)).normalize();
    obj.position.copy(p).addScaledVector(n, -inset);
    obj.rotation.set(-Math.asin(n.y), Math.atan2(n.x, n.z), 0, "YXZ");
    face.add(obj);
    return obj;
  }
  const flatMesh = (geometry, material) => new THREE.Mesh(geometry, material);

  function makeEar(side) {
    const pivot = new THREE.Group();
    headPoint(0.55 * side, 0.8, -0.1, pivot.position);
    pivot.position.y -= 0.03;
    face.add(pivot);
    // A cone with a tiny flat top rather than a point: a true apex has no usable normal, so its
    // outline either fans into spikes or thins out to nothing along the edges.
    const earGeo = new THREE.CylinderGeometry(0.004, 0.105, 0.22, 16, 1).translate(0, 0.11, 0).scale(1, 1, 0.72);
    weldNormals(earGeo);
    part(earGeo, furMat, pivot);
    part(
      new THREE.ConeGeometry(0.064, 0.15, 16).translate(0, 0.075, 0).scale(1, 1, 0.3),
      accentMat,
      pivot,
      0,
      0.016,
      0.05,
      false
    );
    return { pivot, side };
  }
  const ears = [makeEar(1), makeEar(-1)];

  // Point on the (muzzle-displaced) head surface at head-space (x, y), and its normal.
  function surfaceAt(x, y, outP, outN) {
    const u = x / HR.x;
    const v = y / HR.y;
    headPoint(u, v, Math.sqrt(Math.max(0, 1 - u * u - v * v)), outP);
    outN.set(outP.x / (HR.x * HR.x), outP.y / (HR.y * HR.y), outP.z / (HR.z * HR.z)).normalize();
    return outP;
  }

  // A line drawn on the head through head-space (x, y) points, lifted off the surface along its
  // normal. It keeps its 2D shape seen from the front, stays even in width, and never sinks into
  // the curve the way a flat shape does. `origin` is subtracted so it can live in a sub-group.
  const FACE_ORIGIN = new THREE.Vector3();
  function faceStroke(xy, r, lift, origin = FACE_ORIGIN) {
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const pts = xy.map(([x, y]) => surfaceAt(x, y, p, n).clone().addScaledVector(n, lift).sub(origin));
    const g = new THREE.Group();
    part(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 3, r, 8, false), inkMat, g, 0, 0, 0, false);
    for (const end of [pts[0], pts[pts.length - 1]]) {
      part(new THREE.SphereGeometry(r, 10, 8), inkMat, g, end.x, end.y, end.z, false);
    }
    return g;
  }
  // (x, y) points along a circular arc from angle `from` to `to`.
  const arcXY = (cx, cy, R, from, to, steps = 10) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const t = from + ((to - from) * i) / steps;
      return [cx + R * Math.cos(t), cy + R * Math.sin(t)];
    });

  // Neko's eyes: thin vertical lines. Closed, they become arcs: ∩ when happy, ∪ when asleep or blinking.
  const EYE = { x: 0.088, y: 0.056, len: 0.07, r: 0.0125, lift: 0.006, arcR: 0.036, arcW: 0.0095, roundR: 0.04 };
  function makeEye(side) {
    const x = EYE.x * side;
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const g = new THREE.Group(); // at the middle of the eye, so blinks squash towards it
    surfaceAt(x, EYE.y, p, n);
    g.position.copy(p).addScaledVector(n, EYE.lift);
    face.add(g);
    const open = new THREE.Group();
    g.add(open);
    const line = Array.from({ length: 7 }, (_, i) => [x, EYE.y + (i / 6 - 0.5) * EYE.len]);
    open.add(faceStroke(line, EYE.r, EYE.lift, g.position));
    const happy = faceStroke(arcXY(x, EYE.y - 0.014, EYE.arcR, 0, Math.PI), EYE.arcW, EYE.lift, g.position);
    const shut = faceStroke(arcXY(x, EYE.y + 0.016, EYE.arcR, Math.PI, 2 * Math.PI), EYE.arcW, EYE.lift, g.position);
    g.add(happy, shut);
    happy.visible = shut.visible = false;
    // Alert: round eyes, a flattened ball facing out along the surface normal.
    surfaceAt(x, EYE.y, p, n);
    const round = new THREE.Group();
    round.rotation.set(-Math.asin(n.y), Math.atan2(n.x, n.z), 0, "YXZ");
    g.add(round);
    part(ellipsoid(EYE.roundR, EYE.roundR, 0.012, 18, 10), inkMat, round, 0, 0, 0, false);
    round.visible = false;
    return { open, happy, shut, round };
  }
  const eyes = [makeEye(1), makeEye(-1)];

  onFace(flatMesh(ellipsoid(0.038, 0.025, 0.022, 14, 10), accentMat), 0, -0.14, 1, 0.01);
  // ω, hanging just under the nose. Two shallow arcs whose outer ends line up with the eyes.
  // Each arc is 2·R·sin(span) wide, so the two together reach ±halfWidth (a bit inside the eyes).
  const MOUTH_HALF_WIDTH = EYE.x * 0.85;
  const MOUTH = { top: -0.064, R: MOUTH_HALF_WIDTH / (2 * Math.sin((70 * Math.PI) / 180)), span: (70 * Math.PI) / 180, r: 0.007 };
  const mouthW = new THREE.Group();
  face.add(mouthW);
  for (const side of [1, -1]) {
    const cx = side * MOUTH.R * Math.sin(MOUTH.span); // inner ends meet at x = 0
    const cy = MOUTH.top + MOUTH.R * Math.cos(MOUTH.span);
    const from = -Math.PI / 2 - MOUTH.span;
    mouthW.add(faceStroke(arcXY(cx, cy, MOUTH.R, from, from + 2 * MOUTH.span), MOUTH.r, 0.004));
  }
  const yawn = onFace(flatMesh(ellipsoid(0.046, 0.052, 0.017, 16, 10), mouthMat), 0, -0.5, 0.87, 0.004);
  yawn.visible = false;
  // Alert: a small round "o" just under the nose, where the ω usually sits.
  const gasp = onFace(flatMesh(ellipsoid(0.022, 0.026, 0.012, 14, 10), mouthMat), 0, -0.36, 0.93, 0.004);
  gasp.visible = false;
  const blush = [1, -1].map((side) => {
    const b = onFace(flatMesh(new THREE.CircleGeometry(0.034, 18), blushMat), 0.62 * side, -0.26, 0.74, -0.004);
    b.visible = false;
    return b;
  });

  // Legs: rigid segments in cat space, placed every frame by IK.
  const PAW_H = 0.028;
  const HIND = { L1: 0.2, L2: 0.17, L3: 0.085 };
  const FORE = { L1: 0.13, L2: 0.18 };
  const MAX_STRETCH = 1.3;
  const FX = 0.075;
  const FZ = 0.24;
  const HX = 0.09;
  const HZ = -0.17;
  // Big haunch: round at the hip, tapering to the knee, which lands around mid-body.
  const thighGeo = new THREE.LatheGeometry(
    [
      [0, -0.245],
      [0.035, -0.238],
      [0.05, -0.215],
      [0.062, -0.18],
      [0.082, -0.13],
      [0.104, -0.075],
      [0.118, -0.025],
      [0.12, 0.015],
      [0.108, 0.05],
      [0.075, 0.078],
      [0.035, 0.092],
      [0, 0.097],
    ].map(([r, y]) => new THREE.Vector2(r, y)),
    20
  ).scale(0.8, 1, 1);

  // offW / offB: phase offsets for the walk (lateral sequence) and the bound.
  const legs = [
    { k: "fl", side: 1, front: true, joint: new THREE.Vector3(FX, -0.05, 0.16), home: [FX, FZ], offW: 0.75, offB: 0.5 },
    { k: "fr", side: -1, front: true, joint: new THREE.Vector3(-FX, -0.05, 0.16), home: [-FX, FZ], offW: 0.25, offB: 0.44 },
    { k: "bl", side: 1, front: false, joint: new THREE.Vector3(0.1, -0.03, -0.1), home: [HX, HZ], offW: 0, offB: 0 },
    { k: "br", side: -1, front: false, joint: new THREE.Vector3(-0.1, -0.03, -0.1), home: [-HX, HZ], offW: 0.5, offB: 0.94 },
  ];
  for (const leg of legs) {
    if (leg.front) {
      leg.pole = new THREE.Vector3(0, 0, -1); // elbows bend back
      leg.upper = part(capsuleDown(0.048, FORE.L1), furMat, root);
      leg.lower = part(capsuleDown(0.04, FORE.L2), furMat, root);
      leg.paw = part(ellipsoid(0.043, PAW_H, 0.054, 16, 10), furMat, root);
    } else {
      leg.pole = new THREE.Vector3(0.12 * leg.side, 0, 1).normalize(); // knees bend forward
      leg.upper = part(thighGeo, furMat, root);
      leg.lower = part(capsuleDown(0.036, HIND.L2), furMat, root);
      leg.foot = part(capsuleDown(0.033, HIND.L3), furMat, root);
      leg.paw = part(ellipsoid(0.045, PAW_H, 0.058, 16, 10), furMat, root);
    }
  }

  const _ikD = new THREE.Vector3();
  const _ikP = new THREE.Vector3();
  // Two-bone IK from A towards T. Writes the middle joint to K and clamps T if unreachable.
  // Returns a stretch factor (> 1 when the limb has to lengthen a little to reach).
  function solveIK(A, T, L1, L2, pole, K) {
    _ikD.subVectors(T, A);
    let dist = _ikD.length() || 1e-6;
    _ikD.divideScalar(dist);
    let k = 1;
    const reach = L1 + L2;
    if (dist > reach) {
      k = Math.min(MAX_STRETCH, dist / reach);
      L1 *= k;
      L2 *= k;
      if (dist > reach * k) {
        dist = reach * k * 0.9999;
        T.copy(A).addScaledVector(_ikD, dist);
      }
    }
    dist = Math.max(dist, Math.abs(L1 - L2) + 1e-4);
    const a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    _ikP.copy(pole).addScaledVector(_ikD, -pole.dot(_ikD));
    if (_ikP.lengthSq() < 1e-8) _ikP.set(0, 1, 0);
    _ikP.normalize();
    K.copy(A).addScaledVector(_ikD, a).addScaledVector(_ikP, h);
    return k;
  }

  const _sx = new THREE.Vector3();
  const _sy = new THREE.Vector3();
  const _sz = new THREE.Vector3();
  const _sm = new THREE.Matrix4();
  // Point a segment (modelled hanging down -Y from its origin) from `from` to `to`.
  function placeSeg(mesh, from, to, k) {
    mesh.position.copy(from);
    _sy.subVectors(from, to).normalize();
    _sx.set(1, 0, 0).addScaledVector(_sy, -_sy.x);
    if (_sx.lengthSq() < 1e-6) _sx.set(0, 0, 1);
    _sx.normalize();
    _sz.crossVectors(_sx, _sy);
    mesh.quaternion.setFromRotationMatrix(_sm.makeBasis(_sx, _sy, _sz));
    mesh.scale.set(1, k, 1);
  }

  const _joint = new THREE.Vector3();
  const _toe = new THREE.Vector3();
  const _end = new THREE.Vector3();
  const _knee = new THREE.Vector3();
  const _hock = new THREE.Vector3();
  const _att = new THREE.Vector3();
  const _off = new THREE.Vector3();

  function updateLeg(leg, p) {
    _joint.copy(leg.joint).applyMatrix4(leg.front ? chestM : hips.matrix);
    _toe.set(p[leg.k + "x"], p[leg.k + "y"], p[leg.k + "z"]);
    if (leg.front) {
      _end.set(_toe.x, _toe.y + 0.014, _toe.z - 0.01); // wrist
      _off.subVectors(_toe, _end);
      const k = solveIK(_joint, _end, FORE.L1, FORE.L2, leg.pole, _knee);
      placeSeg(leg.upper, _joint, _knee, k);
      placeSeg(leg.lower, _knee, _end, k);
      leg.paw.position.copy(_end).add(_off);
    } else {
      // Digitigrade: the metatarsal angle comes from the pose, IK solves hip → hock.
      const th = p[leg.k + "f"];
      _att.set(_toe.x, _toe.y + 0.012, _toe.z - 0.01);
      _hock.set(_att.x, _att.y + Math.cos(th) * HIND.L3, _att.z - Math.sin(th) * HIND.L3);
      _off.subVectors(_att, _hock);
      const k = solveIK(_joint, _hock, HIND.L1, HIND.L2, leg.pole, _knee);
      _att.copy(_hock).add(_off);
      placeSeg(leg.upper, _joint, _knee, k);
      placeSeg(leg.lower, _knee, _hock, k);
      placeSeg(leg.foot, _hock, _att, 1);
      leg.paw.position.set(_att.x, _att.y - 0.012, _att.z + 0.01);
    }
    leg.paw.rotation.set(p[leg.k + "c"], 0, 0);
  }

  // Tail: a tube whose vertices are rebuilt every frame from a spring-driven spine.
  const TAIL_N = 6;
  const TAIL_SEG = 0.058;
  const RINGS = 22;
  const RADIAL = 8;
  const TAIL_R0 = 0.042;
  const TAIL_R1 = 0.03;
  const tailPivot = new THREE.Group(); // cancels hip pitch so tail angles are absolute
  tailPivot.position.set(0, 0.05, -0.18);
  hips.add(tailPivot);
  const tailPos = new Float32Array(RINGS * (RADIAL + 1) * 3);
  const tailNrm = new Float32Array(RINGS * (RADIAL + 1) * 3);
  const tailIdx = [];
  for (let i = 0; i < RINGS - 1; i++) {
    for (let j = 0; j < RADIAL; j++) {
      const a = i * (RADIAL + 1) + j;
      const b = a + RADIAL + 1;
      tailIdx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const tailGeo = new THREE.BufferGeometry();
  tailGeo.setAttribute("position", new THREE.BufferAttribute(tailPos, 3).setUsage(THREE.DynamicDrawUsage));
  tailGeo.setAttribute("normal", new THREE.BufferAttribute(tailNrm, 3).setUsage(THREE.DynamicDrawUsage));
  tailGeo.setIndex(tailIdx);
  const tailMesh = part(tailGeo, furMat, tailPivot);
  tailMesh.frustumCulled = tailMesh.children[0].frustumCulled = false;
  const tailTip = part(new THREE.SphereGeometry(TAIL_R1 * 1.04, 12, 8), furMat, tailPivot);

  const spine = Array.from({ length: TAIL_N + 1 }, () => new THREE.Vector3());
  const tailCurve = new THREE.CatmullRomCurve3(spine, false, "centripetal");
  const rings = Array.from({ length: RINGS }, () => new THREE.Vector3());
  const vT = new THREE.Vector3();
  const vN = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const X_AXIS = new THREE.Vector3(1, 0, 0);
  const Y_AXIS = new THREE.Vector3(0, 1, 0);

  // Per-segment angles: a = elevation step, b = sideways step. Springs chase the pose.
  const tailA = new Float32Array(TAIL_N);
  const tailAV = new Float32Array(TAIL_N);
  const tailB = new Float32Array(TAIL_N);
  const tailBV = new Float32Array(TAIL_N);
  let tailReady = false;
  const tailTargetA = (p, i) => (i === 0 ? p.tailLift : p.tailCurl);
  const tailTargetB = (p, i, phase) =>
    (i === 0 ? p.tailSide : p.tailSideCurl) + p.tailSway * Math.sin(phase - i * 0.7) * ((i + 1) / TAIL_N) * 0.55;

  function stepTail(p, dt, phase, yawDelta, bodyVy) {
    if (!tailReady) {
      for (let i = 0; i < TAIL_N; i++) {
        tailA[i] = tailTargetA(p, i);
        tailB[i] = tailTargetB(p, i, phase);
      }
      tailReady = true;
    }
    // The tail resists the body's motion: turning drags it sideways, bobbing flicks it.
    tailB[0] -= yawDelta * 0.8;
    tailB[1] -= yawDelta * 0.3;
    tailAV[0] -= bodyVy * 2;
    tailAV[1] -= bodyVy * 1;
    const steps = Math.max(1, Math.ceil(dt / 0.012));
    const h = dt / steps;
    for (let st = 0; st < steps; st++) {
      for (let i = 0; i < TAIL_N; i++) {
        const k = lerp(220, 70, i / (TAIL_N - 1));
        const c = 0.9 * Math.sqrt(k);
        tailAV[i] += (k * (tailTargetA(p, i) - tailA[i]) - c * tailAV[i]) * h;
        tailBV[i] += (k * (tailTargetB(p, i, phase) - tailB[i]) - c * tailBV[i]) * h;
        tailA[i] += tailAV[i] * h;
        tailB[i] += tailBV[i] * h;
      }
    }
  }

  function buildTail() {
    let a = 0;
    let b = 0;
    for (let i = 1; i <= TAIL_N; i++) {
      a += tailA[i - 1];
      b += tailB[i - 1];
      const ca = Math.cos(a);
      spine[i]
        .set(Math.sin(b) * ca, Math.sin(a), -Math.cos(b) * ca)
        .multiplyScalar(TAIL_SEG)
        .add(spine[i - 1]);
    }
    for (let i = 0; i < RINGS; i++) tailCurve.getPoint(i / (RINGS - 1), rings[i]);
    for (let i = 0; i < RINGS; i++) {
      vT.subVectors(rings[Math.min(RINGS - 1, i + 1)], rings[Math.max(0, i - 1)]).normalize();
      if (i === 0) {
        vN.crossVectors(vT, X_AXIS);
        if (vN.lengthSq() < 1e-4) vN.crossVectors(vT, Y_AXIS);
      } else {
        vN.addScaledVector(vT, -vN.dot(vT)); // parallel transport: no twisting
      }
      vN.normalize();
      vB.crossVectors(vT, vN);
      const r = lerp(TAIL_R0, TAIL_R1, i / (RINGS - 1));
      const P = rings[i];
      for (let j = 0; j <= RADIAL; j++) {
        const ang = (j / RADIAL) * TAU;
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        const k = (i * (RADIAL + 1) + j) * 3;
        const nx = vN.x * c + vB.x * sn;
        const ny = vN.y * c + vB.y * sn;
        const nz = vN.z * c + vB.z * sn;
        tailNrm[k] = nx;
        tailNrm[k + 1] = ny;
        tailNrm[k + 2] = nz;
        tailPos[k] = P.x + nx * r;
        tailPos[k + 1] = P.y + ny * r;
        tailPos[k + 2] = P.z + nz * r;
      }
    }
    tailGeo.attributes.position.needsUpdate = true;
    tailGeo.attributes.normal.needsUpdate = true;
    tailTip.position.copy(rings[RINGS - 1]);
  }

  function canvasTexture(draw) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    draw(c.getContext("2d"));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: canvasTexture((g) => {
        const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, "rgba(0,0,0,0.45)");
        grad.addColorStop(0.6, "rgba(0,0,0,0.25)");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 64, 64);
      }),
      transparent: true,
      depthWrite: false,
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  shadow.renderOrder = -1;
  root.add(shadow);

  // Contact shadows: a small dark spot under each paw that fades as the paw lifts.
  for (const leg of legs) {
    leg.contact = new THREE.Mesh(
      shadow.geometry,
      new THREE.MeshBasicMaterial({ map: shadow.material.map, transparent: true, depthWrite: false })
    );
    leg.contact.rotation.x = -Math.PI / 2;
    leg.contact.scale.set(0.15, 0.19, 1);
    leg.contact.renderOrder = -1;
    root.add(leg.contact);
  }

  // ---------------------------------------------------------------- effects

  // Sprite textures are stroked in the outline colour, so they're rebuilt on recolour.
  const tex = {};
  function glyph(text, fill) {
    return canvasTexture((g) => {
      g.font = "900 46px system-ui, -apple-system, 'Segoe UI', sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.lineJoin = "round";
      g.lineWidth = 9;
      g.strokeStyle = cfg.outline;
      g.strokeText(text, 32, 35);
      g.fillStyle = fill;
      g.fillText(text, 32, 35);
    });
  }
  function buildTextures() {
    for (const k in tex) tex[k].dispose();
    const fill = isLight(cfg.outline) ? cfg.color : "#ffffff";
    tex.z = glyph("z", fill);
    tex.bang = glyph("!", fill);
    tex.heart = canvasTexture((g) => {
      g.beginPath();
      g.moveTo(32, 54);
      g.bezierCurveTo(6, 36, 8, 12, 22, 12);
      g.bezierCurveTo(29, 12, 32, 17, 32, 21);
      g.bezierCurveTo(32, 17, 35, 12, 42, 12);
      g.bezierCurveTo(56, 12, 58, 36, 32, 54);
      g.closePath();
      g.lineJoin = "round";
      g.lineWidth = 6;
      g.strokeStyle = cfg.outline;
      g.stroke();
      g.fillStyle = "#ff6f91";
      g.fill();
    });
  }

  // Recolour everything in place: materials, the eye glint and the sprite textures.
  function applyColors() {
    furMat.color.set(cfg.color);
    accentMat.color.set(cfg.accent);
    blushMat.color.set(cfg.accent);
    inkMat.color.set(cfg.outline);
    outlineMat.color.set(cfg.outline);
    shineMat.color.set(isLight(cfg.outline) ? cfg.color : "#ffffff"); // dark glint on light eyes
    buildTextures();
    // Prints are always dark: a light outline (black cat) falls back to the fur colour.
    const print = !isLight(cfg.outline) ? cfg.outline : !isLight(cfg.color) ? cfg.color : "#1a1a1a";
    for (const el of printEls) el.style.backgroundColor = print;
  }

  const particles = [];
  for (let i = 0; i < 12; i++) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false })
    );
    sprite.visible = false;
    sprite.renderOrder = 10;
    scene.add(sprite);
    particles.push({ sprite, age: 0, life: 0, vx: 0, vy: 0, size: 0, wobble: 0, pop: false });
  }
  const headWorld = new THREE.Vector3();

  function spawn(tex, ox, oy, vx, vy, life, size, opts = {}) {
    const p = particles.find((q) => !q.sprite.visible) || particles[0];
    face.getWorldPosition(headWorld);
    p.sprite.material.map = tex;
    p.sprite.material.needsUpdate = true;
    p.sprite.position.set(headWorld.x + ox, headWorld.y + oy, headWorld.z + 0.3);
    p.sprite.visible = true;
    p.age = 0;
    p.life = life;
    p.vx = vx;
    p.vy = vy;
    p.size = size;
    p.wobble = opts.wobble || 0;
    p.pop = !!opts.pop;
    return p;
  }

  function updateParticles(dt) {
    for (const p of particles) {
      if (!p.sprite.visible) continue;
      p.age += dt;
      const t = p.age / p.life;
      if (t >= 1) {
        p.sprite.visible = false;
        continue;
      }
      p.sprite.position.x += (p.vx + Math.sin(p.age * 3.2) * p.wobble) * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.material.opacity = Math.min(1, t * 6) * Math.min(1, (1 - t) * 4);
      const grow = p.pop ? 1 + 0.35 * bump(p.age, 0.22) : 0.65 + 0.35 * Math.min(1, t * 3);
      p.sprite.scale.setScalar(p.size * grow);
    }
  }

  // ---------------------------------------------------------------- behaviour

  const B = {
    x: S,
    y: S,
    vx: 0,
    vy: 0,
    heading: 0,
    yawRate: 0,
    state: "sit",
    stateTime: 0,
    nextIdle: rand(8, 20),
    animDur: 3,
    alertDur: 0.38,
    wall: null,
    approach: false,
    petTime: 0,
    turnTimer: 0,
    turnTo: null,
    toward: 0,
    bearingVel: 0,
    dist: 0,
    rel: 0,
  };

  if (cfg.persist) {
    try {
      const saved = JSON.parse(localStorage.getItem(POSITION_KEY));
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        B.x = saved.x;
        B.y = saved.y;
        B.heading = Number.isFinite(saved.heading) ? saved.heading : 0;
      }
    } catch (_) {
      /* storage unavailable */
    }
  }
  let tx = B.x;
  let ty = B.y;

  // Layer clocks: each pose layer animates from its own start time.
  const layerTime = { stand: 0, loco: 0, sit: 0, groom: 0, scratchWall: 0, tired: 0, sleep: 0, alert: 0, pet: 0 };

  function setState(name) {
    if (B.state === name) return;
    const prev = B.state;
    B.state = name;
    B.stateTime = 0;
    if (name !== "stand") B.turnTo = null;
    if (name in layerTime) layerTime[name] = 0;
    if (name === "sit") B.nextIdle = rand(8, 20);
    if (name === "alert") {
      B.alertDur = prev === "sleep" ? 0.75 : 0.42;
      spawn(tex.bang, 0, 0.42, 0, 0.05, B.alertDur + 0.15, 0.24, { pop: true });
    }
  }

  // Each wall: which way to face, and how far the cat still has to walk to reach it.
  const WALLS = [
    { heading: -Math.PI / 2, gap: () => B.x - S * 0.62 },
    { heading: Math.PI / 2, gap: () => innerWidth - S * 0.62 - B.x },
    { heading: Math.PI, gap: () => B.y - S * 0.72 },
    { heading: 0, gap: () => innerHeight - S * 0.5 - B.y },
  ];

  function nearestWall(force) {
    const reach = STOP + S * 0.5;
    let best = null;
    let bestGap = Infinity;
    for (const w of WALLS) {
      const gap = w.gap();
      if ((force || gap < reach) && gap < bestGap) {
        best = w;
        bestGap = gap;
      }
    }
    return best;
  }

  function startIdle(name) {
    if (name === "scratchWall") {
      B.wall = nearestWall(true);
      B.approach = true;
    }
    B.animDur = name === "groom" ? rand(2.4, 3.4) : rand(2.6, 3.8);
    setState(name);
  }

  function pickIdle() {
    const choices = [
      ["groom", 1],
      ["tired", 1.1],
    ];
    if (nearestWall(false)) choices.push(["scratchWall", 1.6]);
    let r = Math.random() * choices.reduce((sum, c) => sum + c[1], 0);
    for (const [name, w] of choices) {
      if ((r -= w) <= 0) return startIdle(name);
    }
    startIdle("groom");
  }

  function updateBehaviour(dt) {
    const W = innerWidth;
    const H = innerHeight;
    const M = S * 0.5;
    const cx = clamp(tx, M, Math.max(M, W - M));
    const cy = clamp(ty, M, Math.max(M, H - M));
    const dx = cx - B.x;
    const dy = cy - B.y;
    const dist = Math.hypot(dx, dy);
    const toward = Math.atan2(dx, dy);
    if (menu.open && dist > MENU_R * 2.4) closeMenu(); // pointer wandered off
    const far = dist > START && !menu.open; // stay put while the colour picker is open
    // How fast the pointer is circling the cat (rad/s, smoothed).
    B.bearingVel = damp(B.bearingVel, Math.abs(wrap(toward - B.toward)) / dt, 4, dt);
    B.toward = toward;
    B.dist = dist;
    B.rel = wrap(toward - B.heading);
    B.stateTime += dt;

    switch (B.state) {
      case "chase":
        if (dist <= STOP) setState("stand");
        break;
      case "stand":
        if (far) setState("chase");
        else if (B.stateTime > 0.7 && B.turnTo === null) setState("sit");
        break;
      case "sit":
        if (far) setState("alert");
        else if (B.stateTime > B.nextIdle && !menu.open) pickIdle();
        break;
      case "groom":
        if (far) setState("alert");
        else if (B.stateTime > B.animDur) setState("sit");
        break;
      case "scratchWall":
        // Walking to the wall may take the cat a little away from the pointer.
        if (dist > START + S) setState("alert");
        else if (B.approach) {
          if (B.wall.gap() <= 1 || B.stateTime > 4) {
            B.approach = false;
            B.stateTime = 0;
            layerTime.scratchWall = 0;
          }
        } else if (B.stateTime > B.animDur) setState("sit");
        break;
      case "tired":
        if (far) setState("alert");
        else if (B.stateTime > 2.1) setState("sleep");
        break;
      case "sleep":
        if (far) setState("alert");
        break;
      case "alert":
        if (B.stateTime > B.alertDur) setState(dist > STOP ? "chase" : "sit");
        break;
      case "pet":
        B.petTime -= dt;
        if (B.petTime <= 0) setState("sit");
        break;
    }

    // Steering: the cat moves along its heading, so paths arc naturally.
    let desired = 0;
    let target = B.heading;
    let turn = 0;
    if (B.state === "chase") {
      desired = lerp(WALK, RUN, clamp((dist - 150 * s) / (300 * s), 0, 1));
      desired = Math.min(desired, (dist - STOP) * 3 + 25 * s);
      desired *= clamp((Math.cos(B.rel) + 0.25) / 1.25, 0, 1); // turn before sprinting
      target = toward;
      turn = 1;
    } else if (B.state === "alert") {
      target = toward;
      turn = 0.5;
    } else if (B.state === "scratchWall") {
      target = B.wall.heading;
      turn = 0.8;
      if (B.approach) {
        desired = Math.min(WALK * 0.8, Math.max(0, B.wall.gap()) * 3 + 10 * s);
        desired *= clamp((Math.cos(wrap(target - B.heading)) + 0.25) / 1.25, 0, 1);
      }
    } else if (B.state === "sit") {
      // Seated, the head follows the pointer. Only if it stays well behind (and isn't hovering
      // over the cat, where its bearing swings wildly) does the cat get up and re-settle.
      // A pointer that's still moving round the cat is just watched; it has to settle first.
      const behind = dist > STOP * 0.5 && Math.abs(B.rel) > 1.6 && B.bearingVel < 0.5;
      B.turnTimer = behind ? B.turnTimer + dt : Math.max(0, B.turnTimer - dt * 2);
      if (B.turnTimer > 1.5 && B.stateTime > 3 && !menu.open) {
        B.turnTimer = 0;
        B.turnTo = toward; // lock the heading: no chasing a circling pointer
        setState("stand");
      }
    } else if (B.state === "stand" && B.turnTo !== null) {
      // Step round to the locked heading, then sit back down.
      target = B.turnTo;
      turn = 0.45;
      if (Math.abs(wrap(B.turnTo - B.heading)) < 0.08) B.turnTo = null;
    }

    const dH = wrap(target - B.heading);
    const rate = MAX_TURN * turn * Math.min(1, Math.abs(dH) / 0.6);
    const step = clamp(dH, -rate * dt, rate * dt);
    B.heading = wrap(B.heading + step);
    B.yawRate = damp(B.yawRate, step / dt, 12, dt);

    const speed = Math.hypot(B.vx, B.vy);
    let ex = Math.sin(B.heading) * desired - B.vx;
    let ey = Math.cos(B.heading) * desired - B.vy;
    const el = Math.hypot(ex, ey);
    const maxDv = (desired > speed ? ACCEL : DECEL) * dt;
    if (el > maxDv) {
      ex *= maxDv / el;
      ey *= maxDv / el;
    }
    B.vx += ex;
    B.vy += ey;
    B.x += B.vx * dt;
    B.y += B.vy * dt;

    if (B.x < M) (B.x = M), (B.vx = Math.max(0, B.vx));
    if (B.x > W - M) (B.x = Math.max(M, W - M)), (B.vx = Math.min(0, B.vx));
    if (B.y < M) (B.y = M), (B.vy = Math.max(0, B.vy));
    if (B.y > H - M) (B.y = Math.max(M, H - M)), (B.vy = Math.min(0, B.vy));
  }

  // ---------------------------------------------------------------- poses
  // Angles are absolute (relative to the floor), positive = nose up.
  // Each leg has a toe target (x, y, z) in cat space, f = hind metatarsal angle from
  // vertical (heel back), c = paw curl (toes down).

  const REST = {
    lift: 0,
    hipsX: 0,
    hipsY: 0,
    hipsZ: 0,
    hipsPitch: 0.03,
    hipsRoll: 0,
    hipsYaw: 0,
    flex: 0, // + arches the back
    twist: 0,
    squash: 1,
    headPitch: 0.05,
    headYaw: 0,
    headRoll: 0,
    headDrop: 0,
    earBack: 0,
    earPerk: 0,
    tailLift: 0.7,
    tailCurl: 0.12,
    tailSide: 0,
    tailSideCurl: 0,
    tailSway: 0.22,
    tailRate: 2.4,
    eyeOpen: 1,
    eyeHappy: 0,
    eyeRound: 0, // 1 = round alert eyes instead of lines
    mouth: 0,
    gasp: 0, // 1 = small round alert mouth
    blush: 0,
    look: 1,
  };
  for (const leg of legs) {
    REST[leg.k + "x"] = leg.home[0];
    REST[leg.k + "y"] = PAW_H;
    REST[leg.k + "z"] = leg.home[1];
    REST[leg.k + "f"] = 0.4;
    REST[leg.k + "c"] = 0;
  }
  const KEYS = Object.keys(REST);

  function foot(p, k, x, y, z, f, c) {
    p[k + "x"] = x;
    p[k + "y"] = y;
    p[k + "z"] = z;
    if (f !== undefined) p[k + "f"] = f;
    if (c !== undefined) p[k + "c"] = c;
  }

  // Distance the body travels per gait cycle: walk → bound.
  const cycleLength = (g) => lerp(0.62, 1.4, g);
  // Fraction of the cycle each foot is on the ground: walk → bound.
  const dutyFactor = (g) => lerp(0.6, 0.34, g);

  function sitBase(p) {
    p.hipsPitch = 0.62;
    p.hipsY = -0.16;
    p.hipsZ = 0.05;
    foot(p, "fl", FX * 0.85, PAW_H, 0.21);
    foot(p, "fr", -FX * 0.85, PAW_H, 0.21);
    foot(p, "bl", 0.12, PAW_H, 0.06, 1.45);
    foot(p, "br", -0.12, PAW_H, 0.06, 1.45);
    p.headPitch = 0.06;
    // Tail drops to the floor and wraps round towards the front paws.
    p.tailLift = -0.7;
    p.tailCurl = 0.13;
    p.tailSide = 1.25;
    p.tailSideCurl = 0.36;
    p.tailSway = 0.1;
    p.tailRate = 1.8;
  }

  const LAYERS = {
    stand(p) {
      p.look = 1;
    },

    // Parametric gait: lateral-sequence walk blending into oneko's bound, which alternates
    // a low stretched leap (E1 sprite) with a round arched gather (E2 sprite).
    loco(p, A) {
      const g = A.gallop;
      const φ = A.cycle;
      const a = A.amt;
      const D = dutyFactor(g);
      const E = D * cycleLength(g) * A.trans;
      const h = lerp(0.05, 0.1, g) * clamp(a * 1.5, 0, 1);
      for (const leg of legs) {
        const ph = frac(φ + lerp(leg.offW, leg.offB, g));
        let dz;
        let dy = 0;
        let c = 0;
        let f = 0.4;
        if (ph < D) {
          const u = ph / D;
          dz = E * (0.5 - u); // planted: slides back exactly as fast as the body moves
          if (leg.front) c = -0.4 * g * (1 - smooth(0, 0.25, u)); // paw lands flat, settles
          else f = 0.4 + 0.6 * g * u * u; // heel lifts as the hind leg pushes off
        } else {
          const u = (ph - D) / (1 - D);
          const arc = Math.sin(Math.PI * u);
          dz = E * (u * u * (3 - 2 * u) - 0.5);
          dy = h * arc;
          if (leg.front) c = 0.9 * arc - 0.4 * g * smooth(0.55, 0.95, u); // reach out flat
          else {
            c = 0.9 * arc;
            f = 0.4 + 0.75 * arc + 0.6 * g * (1 - smooth(0, 0.35, u));
          }
        }
        foot(p, leg.k, leg.home[0], PAW_H + dy, leg.home[1] + dz, f, c);
      }
      const w = TAU * φ;
      const wave = a * Math.cos(TAU * (φ - 0.44));
      const ext = Math.max(0, wave); // stretched leap
      const gath = Math.max(0, -wave); // gathered, back arched
      p.hipsY = lerp(-0.008 * a * Math.cos(2 * w), -0.045 * ext + 0.02 * gath, g);
      p.hipsX = lerp(0.01 * a * Math.sin(w), 0, g);
      p.hipsRoll = lerp(0.035 * a * Math.sin(w + 0.6), 0, g);
      p.hipsYaw = lerp(-0.035 * a * Math.sin(w), 0, g);
      p.twist = lerp(0.07 * a * Math.sin(w), 0, g);
      p.flex = lerp(0, 0.58 * gath - 0.18 * ext, g);
      p.hipsPitch = lerp(0.03, 0.03 + 0.14 * gath - 0.06 * ext, g);
      p.headPitch = lerp(0.04, 0.05 * ext - 0.12 * gath, g);
      p.earBack = lerp(0.05, 0.45, g);
      p.tailLift = lerp(1.15, 0.7, g);
      p.tailCurl = lerp(0.14, 0.02 + 0.22 * gath, g);
      p.tailSway = lerp(0.18, 0.08, g);
      p.tailRate = lerp(4, 6, g);
      p.look = 0.35;
    },

    sit(p) {
      sitBase(p);
    },

    groom(p, A) {
      // oneko's scratchSelf: right hind leg scratches behind the ear.
      const t = A.lt.groom;
      sitBase(p);
      const sc = Math.sin(t * 24);
      p.hipsRoll = 0.12;
      p.headRoll = 0.38;
      p.headYaw = -0.3;
      p.headPitch = -0.02;
      p.headDrop = -0.04;
      foot(p, "br", -0.2, 0.44 + 0.03 * sc, 0.2 + 0.02 * Math.cos(t * 24), 0.3, 0.4);
      p.eyeOpen = 0;
      p.eyeHappy = 1;
      p.earBack = 0.25 + 0.1 * sc;
      p.look = 0;
    },

    scratchWall(p, A) {
      const t = A.lt.scratchWall;
      const c = Math.sin(t * 13);
      p.hipsPitch = 1.2;
      p.hipsY = -0.04;
      p.hipsZ = 0.04;
      foot(p, "bl", HX, PAW_H, -0.1, 0.55);
      foot(p, "br", -HX, PAW_H, -0.1, 0.55);
      foot(p, "fl", 0.08, 0.86 + 0.06 * c, 0.44 - 0.03 * c, undefined, -1.3);
      foot(p, "fr", -0.08, 0.86 - 0.06 * c, 0.44 + 0.03 * c, undefined, -1.3);
      p.headPitch = 0.3;
      p.headYaw = 0.12 * Math.sin(t * 2.1);
      p.earBack = -0.1;
      p.tailLift = -0.6;
      p.tailCurl = 0.12;
      p.tailSway = 0.35;
      p.tailRate = 4;
      p.look = 0;
    },

    tired(p, A) {
      // Yawn, then droop.
      const t = A.lt.tired;
      sitBase(p);
      const e = Math.sin(Math.PI * clamp((t - 0.15) / 1.3, 0, 1));
      const droop = smooth(1.3, 1.9, t);
      p.mouth = e;
      p.headPitch = lerp(0.06 + 0.42 * e, -0.1, droop);
      p.eyeOpen = lerp(1 - e, 0.32, droop);
      p.earBack = 0.3 * e + 0.2 * droop;
      p.look = 0.2;
    },

    sleep(p, A) {
      // A loaf: belly on the floor, paws tucked, haunches out, tail wrapped round.
      p.hipsY = -0.2;
      p.hipsPitch = -0.02;
      p.hipsRoll = 0.05;
      p.flex = 0.14;
      foot(p, "fl", 0.06, 0.03, 0.2, undefined, 0.2);
      foot(p, "fr", -0.06, 0.03, 0.2, undefined, 0.2);
      foot(p, "bl", 0.12, PAW_H, 0.0, 1.5);
      foot(p, "br", -0.12, PAW_H, 0.0, 1.5);
      p.headDrop = -0.15;
      p.headPitch = -0.18;
      p.headYaw = 0.45;
      p.headRoll = 0.2;
      p.earBack = 0.35;
      p.eyeOpen = 0;
      p.tailLift = -0.35;
      p.tailCurl = 0.07;
      p.tailSide = 1.3;
      p.tailSideCurl = 0.34;
      p.tailSway = 0.05;
      p.tailRate = 1.2;
      p.squash = 1 + 0.025 * Math.sin(A.t * 1.6);
      p.look = 0;
    },

    alert(p, A) {
      // Crouch (anticipation), hop, land.
      const t = A.lt.alert;
      const crouch = bump(t, 0.12);
      const hop = bump(t - 0.1, 0.3);
      p.hipsY = -0.04 * crouch;
      p.lift = 0.1 * hop;
      p.squash = 1 - 0.06 * crouch + 0.07 * hop;
      p.earBack = -0.2;
      p.earPerk = 1;
      p.eyeRound = 1;
      p.gasp = 1;
      p.headPitch = 0.14;
      p.tailLift = 1.25;
      p.tailCurl = 0.05;
      p.tailSway = 0.05;
    },

    pet(p, A) {
      const t = A.lt.pet;
      sitBase(p);
      p.eyeOpen = 0;
      p.eyeHappy = 1;
      p.blush = 1;
      p.headRoll = 0.2 * Math.sin(t * 2.8);
      p.headYaw = 0.12 * Math.sin(t * 1.4);
      p.headPitch = 0.16;
      p.earBack = 0.22;
      p.squash = 1 + 0.01 * Math.sin(t * 60) + 0.06 * Math.exp(-A.petPulse * 7) * Math.sin(A.petPulse * 22);
      p.tailSway = 0.25;
      p.tailRate = 2.5;
      p.look = 0.25;
    },
  };
  const LAYER_NAMES = Object.keys(LAYERS);

  // ---------------------------------------------------------------- animator

  const weights = {};
  const targets = {};
  for (const n of LAYER_NAMES) weights[n] = targets[n] = 0;
  weights.sit = 1;
  const pose = {};
  const tmp = {};
  const A = {
    t: 0,
    lt: layerTime,
    cycle: 0,
    amt: 0,
    gallop: 0,
    trans: 1,
    petPulse: 9,
    lookYaw: 0,
    swayPhase: 0,
    blinkIn: rand(1.5, 4),
    blinkT: -1,
    twitchIn: rand(2, 6),
    twitchT: -1,
    twitchSide: 0,
    prevSpeed: 0,
    lean: springState(),
    bank: springState(),
    nod: springState(),
    earWob: springState(),
    neckY: null,
    hipsY: null,
    headPitch: 0,
  };

  function animate(dt) {
    A.t += dt;
    A.petPulse += dt;
    for (const n of LAYER_NAMES) layerTime[n] += dt;

    // Gait phase follows ground distance, so planted feet don't skate. Vertical screen
    // motion covers more ground because the floor is foreshortened by the camera pitch.
    const speed = Math.hypot(B.vx, B.vy);
    const ground = (Math.hypot(B.vx, B.vy / SIN_P) * dt) / S;
    A.gallop = damp(A.gallop, smooth(WALK * 1.5, RUN * 0.8, speed), 5, dt);
    const C = cycleLength(A.gallop);
    const walked = ground / C;
    const advance = walked + Math.abs(B.yawRate) * dt * 0.12; // turning on the spot steps too
    A.cycle = (A.cycle + advance) % 1000;
    A.trans = damp(A.trans, advance > 1e-6 ? walked / advance : 1, 8, dt);
    A.amt = damp(A.amt, clamp(Math.max(speed / WALK, Math.abs(B.yawRate) / 5), 0, 1), 10, dt);

    for (const n of LAYER_NAMES) targets[n] = 0;
    if (B.state === "chase" || B.state === "stand" || (B.state === "scratchWall" && B.approach)) {
      const l = smooth(0.05, 0.4, A.amt);
      targets.loco = l;
      targets.stand = 1 - l;
    } else {
      targets[B.state] = 1;
    }
    const k = B.state === "alert" ? 14 : B.state === "sleep" ? 3.2 : 7;
    for (const n of LAYER_NAMES) weights[n] = damp(weights[n], targets[n], k, dt);

    // Blend every active layer into one pose.
    for (const key of KEYS) pose[key] = 0;
    let total = 0;
    for (const n of LAYER_NAMES) {
      const w = weights[n];
      if (w < 0.0005) continue;
      Object.assign(tmp, REST);
      LAYERS[n](tmp, A);
      for (const key of KEYS) pose[key] += tmp[key] * w;
      total += w;
    }
    if (total > 0) for (const key of KEYS) pose[key] /= total;
    else Object.assign(pose, REST);

    // Additive life: look at the pointer, breathe, blink, twitch.
    const lookAmt = smooth(4 * s, 20 * s, B.dist);
    A.lookYaw = damp(A.lookYaw, clamp(B.rel, -1.05, 1.05) * lookAmt, 6, dt);
    pose.headYaw += A.lookYaw * pose.look;
    pose.headPitch += 0.22 * (1 - smooth(STOP * 0.4, STOP * 1.6, B.dist)) * pose.look;
    pose.squash += 0.012 * Math.sin(A.t * 2.6) * (1 - weights.sleep);

    A.blinkIn -= dt;
    if (A.blinkIn <= 0) {
      A.blinkT = 0;
      A.blinkIn = rand(2, 6);
    }
    if (A.blinkT >= 0) {
      A.blinkT += dt;
      pose.eyeOpen *= 1 - bump(A.blinkT, 0.16);
      if (A.blinkT > 0.16) A.blinkT = -1;
    }
    A.twitchIn -= dt;
    if (A.twitchIn <= 0) {
      A.twitchT = 0;
      A.twitchIn = rand(2.5, 7);
      A.twitchSide = Math.random() < 0.5 ? 0 : 1;
    }
    let twitch = 0;
    if (A.twitchT >= 0) {
      A.twitchT += dt;
      twitch = 0.55 * bump(A.twitchT, 0.22);
      if (A.twitchT > 0.22) A.twitchT = -1;
    }

    // Root motion: lean into acceleration (springy) and into turns.
    const fwd = speed / S;
    const accel = (fwd - A.prevSpeed) / dt;
    A.prevSpeed = fwd;
    spring(A.lean, clamp(-accel * 0.01, -0.14, 0.14), 60, 0.6, dt);
    pose.hipsPitch += A.lean.x;
    // Bank into turns like a bike: the body tips towards the inside around the ground line
    // while the paws stay planted, so the legs slant out beneath it. + = towards the cat's left.
    const bank = spring(A.bank, clamp(0.9 * Math.atan((fwd * B.yawRate) / 25), -0.35, 0.35), 50, 0.7, dt);
    pose.hipsRoll -= bank;
    pose.hipsX += 0.3 * Math.sin(bank);
    pose.hipsY -= 0.3 * (1 - Math.cos(bank));
    pose.headRoll -= 0.5 * bank; // the head leans about half as much, like a rider

    A.swayPhase = (A.swayPhase + pose.tailRate * dt) % (TAU * 1000);

    // Footfalls (a foot entering stance while walking) leave paw prints.
    const D = dutyFactor(A.gallop);
    const walking = weights.loco > 0.5 && speed > WALK * 0.3;
    for (const leg of legs) {
      const stance = frac(A.cycle + lerp(leg.offW, leg.offB, A.gallop)) < D;
      if (stance && !leg.stance && walking) footfalls.push(leg);
      leg.stance = stance;
    }
    applyPose(pose, dt, twitch);
  }

  function applyPose(p, dt, twitch) {
    root.position.y = p.lift;
    root.rotation.y = B.heading;

    hips.position.set(HIPS.x + p.hipsX, HIPS.y + p.hipsY, HIPS.z + p.hipsZ);
    hips.rotation.set(-p.hipsPitch, p.hipsYaw, p.hipsRoll);
    const inv = 1 / Math.sqrt(p.squash);
    hips.scale.set(inv, p.squash, inv);
    chest.rotation.set(p.flex, p.twist, 0);
    hips.updateMatrix();
    chest.updateMatrix();
    chestM.multiplyMatrices(hips.matrix, chest.matrix);

    // Head: undo the torso's rotation so head angles are absolute, then add a nod that
    // lags behind the body's bobbing.
    neck.position.set(NECK.x, NECK.y + p.headDrop, NECK.z);
    neck.quaternion.copy(hips.quaternion).multiply(chest.quaternion).invert();
    _v.copy(neck.position).applyMatrix4(chestM);
    const neckY = _v.y + p.lift;
    const neckVel = A.neckY === null ? 0 : (neckY - A.neckY) / dt;
    A.neckY = neckY;
    spring(A.nod, clamp(-neckVel * 0.3, -0.12, 0.12), 140, 0.45, dt);
    const headPitch = p.headPitch + A.nod.x;
    head.rotation.set(-headPitch, p.headYaw, p.headRoll);

    // Ears flop a little when the head moves quickly.
    const headVel = (headPitch - A.headPitch) / dt;
    A.headPitch = headPitch;
    spring(A.earWob, clamp(headVel * 0.08, -0.35, 0.35), 160, 0.3, dt);
    for (const ear of ears) {
      const tw = (ear.side > 0 ? A.twitchSide === 0 : A.twitchSide === 1) ? twitch : 0;
      ear.pivot.rotation.set(-(p.earBack + tw + A.earWob.x) - 0.08, 0, -0.3 * ear.side);
      ear.pivot.scale.y = 1 + 0.15 * p.earPerk;
    }

    for (const leg of legs) updateLeg(leg, p);

    tailPivot.rotation.set(p.hipsPitch, 0, 0);
    const hipsY = hips.position.y + p.lift;
    const bodyVy = A.hipsY === null ? 0 : (hipsY - A.hipsY) / dt;
    A.hipsY = hipsY;
    stepTail(p, dt, A.swayPhase, B.yawRate * dt, clamp(bodyVy, -3, 3));
    buildTail();

    const open = clamp(p.eyeOpen, 0, 1.25);
    const closed = open < 0.22;
    const round = clamp(p.eyeRound, 0, 1);
    for (const eye of eyes) {
      eye.open.visible = !closed && round < 0.5;
      eye.open.scale.set(1 + Math.max(0, open - 1) * 0.4, Math.max(open, 0.15), 1);
      eye.round.visible = !closed && round >= 0.5;
      const pop = 0.6 + 0.4 * round; // grows in as the alert takes over
      eye.round.scale.set(pop, pop * Math.max(Math.min(open, 1), 0.15), pop);
      eye.happy.visible = closed && p.eyeHappy > 0.5;
      eye.shut.visible = closed && p.eyeHappy <= 0.5;
    }
    yawn.visible = p.mouth > 0.03;
    yawn.scale.set(0.6 + 0.4 * p.mouth, Math.max(p.mouth, 0.01), 1);
    gasp.visible = p.gasp > 0.05;
    gasp.scale.setScalar(Math.max(p.gasp, 0.01));
    mouthW.visible = p.mouth < 0.3 && p.gasp < 0.5;
    blushMat.opacity = 0.85 * p.blush;
    blush[0].visible = blush[1].visible = p.blush > 0.01;

    // Shadows stay on the floor when the cat hops (root.lift raises everything else).
    const air = clamp(p.lift * 3, 0, 0.6);
    shadow.position.y = 0.002 - p.lift;
    shadow.scale.set(0.62 * (1 - air * 0.5), (1.15 + 0.1 * weights.sleep) * (1 - air * 0.5), 1);
    shadow.material.opacity = 1 - air;
    for (const leg of legs) {
      const height = Math.max(0, leg.paw.position.y - PAW_H + p.lift);
      leg.contact.position.set(leg.paw.position.x, 0.003 - p.lift, leg.paw.position.z);
      leg.contact.material.opacity = 0.85 * (1 - smooth(0, 0.07, height));
      leg.contact.visible = leg.contact.material.opacity > 0.01;
    }
  }

  // ---------------------------------------------------------------- input & DOM

  const onPointer = (e) => {
    tx = e.clientX;
    ty = e.clientY;
  };
  const onTouch = (e) => {
    const t = e.touches[0];
    if (t) {
      tx = t.clientX;
      ty = t.clientY;
    }
  };
  document.addEventListener("pointermove", onPointer, { passive: true });
  document.addEventListener("pointerdown", onPointer, { passive: true });
  document.addEventListener("touchmove", onTouch, { passive: true });

  function pet() {
    if (B.state !== "pet") setState("pet");
    B.petTime = 2.2;
    A.petPulse = 0;
    spawn(tex.heart, rand(-0.08, 0.08), 0.32, rand(-0.12, 0.12), 0.5, 1.2, 0.22, { wobble: 0.15 });
  }

  let hit = null;
  if (cfg.pet) {
    hit = document.createElement("div");
    hit.setAttribute("aria-hidden", "true");
    Object.assign(hit.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: HIT + "px",
      height: HIT + "px",
      borderRadius: "50%",
      zIndex: "2147483647",
      cursor: "pointer",
      touchAction: "manipulation",
      background: "transparent",
      willChange: "transform",
    });
    hit.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      pet();
    });
    hit.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu.open) closeMenu();
      else openMenu();
    });
    document.body.appendChild(hit);
  }

  // Paw prints: a small pool of page-fixed divs behind the cat, masked to a paw shape.
  const PRINT = Math.max(6, Math.round(S * 0.16));
  const PAW_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>" +
    "<ellipse cx='12' cy='16' rx='5.5' ry='4.6'/><ellipse cx='5.6' cy='9.6' rx='2.2' ry='2.8'/>" +
    "<ellipse cx='9.6' cy='5.6' rx='2.2' ry='2.9'/><ellipse cx='14.4' cy='5.6' rx='2.2' ry='2.9'/>" +
    "<ellipse cx='18.4' cy='9.6' rx='2.2' ry='2.8'/></svg>";
  const pawMask = `url("data:image/svg+xml,${encodeURIComponent(PAW_SVG)}") center / contain no-repeat`;
  const printEls = [];
  const footfalls = [];
  let printNext = 0;
  if (cfg.prints) {
    for (let i = 0; i < 24; i++) {
      const el = document.createElement("div");
      el.setAttribute("aria-hidden", "true");
      Object.assign(el.style, {
        position: "fixed",
        left: "0",
        top: "0",
        width: PRINT + "px",
        height: PRINT + "px",
        pointerEvents: "none",
        zIndex: "2147483646",
        opacity: "0",
        mask: pawMask,
        webkitMask: pawMask,
      });
      document.body.appendChild(el);
      printEls.push(el);
    }
  }

  function stampPrint(leg) {
    // Paw on the floor → world → canvas pixels → page.
    _v.set(leg.paw.position.x, 0, leg.paw.position.z).applyMatrix4(root.matrixWorld);
    _v.y = 0;
    _v.project(camera);
    const x = B.x - AX + ((_v.x + 1) / 2) * CANVAS;
    const y = B.y - AY + ((1 - _v.y) / 2) * CANVAS;
    const el = printEls[printNext];
    printNext = (printNext + 1) % printEls.length;
    // Toes point along the heading; scaleY lays the print flat on the foreshortened floor.
    el.style.transform = `translate(${(x - PRINT / 2).toFixed(1)}px, ${(y - PRINT / 2).toFixed(1)}px) scaleY(${SIN_P.toFixed(3)}) rotate(${(Math.PI - B.heading).toFixed(3)}rad)`;
    el.animate([{ opacity: 0.32 }, { opacity: 0 }], { duration: 1400, easing: "ease-in", fill: "forwards" });
  }

  // Right-click colour picker: swatches swirl out of the cat and float around it.
  const MENU_R = Math.max(56, 0.95 * S) + 14;
  const SWATCH = Math.round(clamp(S * 0.44, 24, 34));
  const menu = { open: false, el: null, slots: [] };

  function buildMenu() {
    const style = document.createElement("style");
    style.textContent =
      ".chibineko-swatch{transition:scale .15s ease}" +
      ".chibineko-swatch:hover,.chibineko-swatch:focus-visible{scale:1.18;outline:none}" +
      ".chibineko-swatch[aria-pressed=true]{box-shadow:0 0 0 3px #fff,0 0 0 5px #ff6f91,0 3px 8px rgba(0,0,0,.3)!important}";
    const wrap = document.createElement("div");
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Cat colour");
    Object.assign(wrap.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "0",
      height: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      display: "none",
    });
    wrap.appendChild(style);
    for (const [name, c] of Object.entries(PRESETS)) {
      const slot = document.createElement("div");
      Object.assign(slot.style, { position: "absolute", left: "0", top: "0", opacity: "0" });
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chibineko-swatch";
      b.title = name[0].toUpperCase() + name.slice(1);
      b.setAttribute("aria-label", b.title);
      Object.assign(b.style, {
        position: "absolute",
        left: -SWATCH / 2 + "px",
        top: -SWATCH / 2 + "px",
        width: SWATCH + "px",
        height: SWATCH + "px",
        padding: "0",
        borderRadius: "50%",
        border: `3px solid ${c.outline}`,
        background: `radial-gradient(circle at 68% 32%, ${c.accent} 0 18%, transparent 20%), ${c.color}`,
        boxShadow: "0 3px 8px rgba(0,0,0,.28)",
        cursor: "pointer",
        pointerEvents: "auto",
      });
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setColors(c);
        closeMenu();
        pet();
      });
      slot.appendChild(b);
      wrap.appendChild(slot);
      menu.slots.push({ slot, button: b, name });
    }
    document.body.appendChild(wrap);
    menu.el = wrap;
  }

  function openMenu() {
    if (!menu.el) buildMenu();
    menu.open = true;
    if (B.state !== "sit" && B.state !== "pet") setState("sit"); // wake up, stop
    menu.el.style.display = "block";
    place();
    const n = menu.slots.length;
    menu.slots.forEach(({ slot, button, name }, i) => {
      const a = -Math.PI / 2 + (i * TAU) / n;
      const to = `rotate(0deg) translate(${(Math.cos(a) * MENU_R).toFixed(1)}px, ${(Math.sin(a) * MENU_R).toFixed(1)}px) scale(1)`;
      slot.dataset.to = to;
      for (const anim of slot.getAnimations()) anim.cancel();
      slot.animate(
        [
          { transform: "rotate(-60deg) translate(0px, 0px) scale(0.2)", opacity: 0 },
          { transform: to, opacity: 1 },
        ],
        { duration: 460, delay: i * 35, easing: "cubic-bezier(.2,1.5,.4,1)", fill: "both" }
      );
      button.animate([{ translate: "0 -3px" }, { translate: "0 3px" }], {
        duration: 1500 + i * 140,
        delay: -i * 260,
        direction: "alternate",
        iterations: Infinity,
        easing: "ease-in-out",
      });
      const c = PRESETS[name];
      button.setAttribute("aria-pressed", String(c.color === cfg.color && c.outline === cfg.outline));
    });
  }

  function closeMenu() {
    if (!menu.open) return;
    menu.open = false;
    let pending = menu.slots.length;
    menu.slots.forEach(({ slot, button }, i) => {
      for (const anim of slot.getAnimations()) anim.cancel();
      const out = slot.animate(
        [
          { transform: slot.dataset.to, opacity: 1 },
          { transform: "rotate(50deg) translate(0px, 0px) scale(0.2)", opacity: 0 },
        ],
        { duration: 240, delay: i * 20, easing: "ease-in", fill: "both" }
      );
      out.onfinish = () => {
        for (const anim of button.getAnimations()) anim.cancel();
        if (--pending === 0 && !menu.open) menu.el.style.display = "none";
      };
    });
  }

  const onDocDown = (e) => {
    if (menu.open && !menu.el.contains(e.target) && e.target !== hit) closeMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeMenu();
  };
  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("keydown", onKey);

  function setColors(c) {
    for (const k of COLOR_KEYS) if (c && typeof c[k] === "string") cfg[k] = c[k];
    applyColors();
    try {
      localStorage.setItem(COLORS_KEY, JSON.stringify({ color: cfg.color, outline: cfg.outline, accent: cfg.accent }));
    } catch (_) {
      /* storage unavailable */
    }
  }

  // Motion blur: when moving fast, render to a target and smear it along the page velocity.
  let blur = null;
  if (cfg.blur) {
    const pr = renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(CANVAS * pr, CANVAS * pr, { samples: 4, colorSpace: THREE.SRGBColorSpace });
    const mat = new THREE.ShaderMaterial({
      uniforms: { tex: { value: rt.texture }, dir: { value: new THREE.Vector2() } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tex;
        uniform vec2 dir;
        varying vec2 vUv;
        void main() {
          // Premultiplied taps towards the direction of travel: the trail lands behind the cat.
          vec4 sum = vec4(0.0);
          float total = 0.0;
          for (int i = 0; i < 12; i++) {
            float t = float(i) / 11.0;
            float w = 1.0 - 0.8 * t;
            sum += texture2D(tex, vUv + dir * t) * w;
            total += w;
          }
          vec4 c = sum / total;
          if (c.a > 0.0) c.rgb /= c.a;
          gl_FragColor = c;
          #include <colorspace_fragment>
          gl_FragColor.rgb *= gl_FragColor.a;
        }`,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const post = new THREE.Scene();
    post.add(quad);
    blur = { rt, mat, post, cam: new THREE.Camera() };
  }

  function render() {
    const smear = 0.03; // seconds of "shutter"
    if (!blur || Math.hypot(B.vx, B.vy) * smear < 1.5) {
      renderer.render(scene, camera);
      return;
    }
    // Canvas UV has y up; page y points down.
    blur.mat.uniforms.dir.value.set((B.vx * smear) / CANVAS, (-B.vy * smear) / CANVAS);
    renderer.setRenderTarget(blur.rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(blur.post, blur.cam);
  }

  document.body.appendChild(canvas);

  function save() {
    if (!cfg.persist) return;
    try {
      localStorage.setItem(
        POSITION_KEY,
        JSON.stringify({ x: Math.round(B.x), y: Math.round(B.y), heading: +B.heading.toFixed(3) })
      );
    } catch (_) {
      /* storage unavailable */
    }
  }
  const onVisibility = () => {
    if (document.visibilityState === "hidden") save();
  };
  window.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", onVisibility);

  // ---------------------------------------------------------------- loop

  let zTimer = 0;
  let heartTimer = 0;
  function updateEffects(dt) {
    zTimer -= dt;
    if (B.state === "sleep" && weights.sleep > 0.7 && zTimer <= 0) {
      const big = Math.random() < 0.5;
      spawn(tex.z, 0.16, 0.18, 0.1, 0.26, 2.2, big ? 0.2 : 0.15, { wobble: 0.08 });
      zTimer = 1.3;
    }
    if (B.state === "pet") {
      heartTimer -= dt;
      if (heartTimer <= 0) {
        spawn(tex.heart, rand(-0.12, 0.12), 0.32, rand(-0.12, 0.12), 0.45, 1.2, 0.18, { wobble: 0.15 });
        heartTimer = 0.55;
      }
    } else heartTimer = 0.55;
    updateParticles(dt);
  }

  let raf = 0;
  let last = performance.now();
  let dead = false;
  let timeScale = 1;
  let debug = null;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000) * timeScale;
    last = now;
    if (!(dt > 0) || (debug && debug.frozen)) return;
    step(dt);
  }

  function step(dt) {
    updateBehaviour(dt);
    animate(dt);
    root.updateMatrixWorld(true);
    if (printEls.length) for (const leg of footfalls) stampPrint(leg);
    footfalls.length = 0;
    updateEffects(dt);
    place();
    render();
  }

  function place() {
    canvas.style.transform = `translate3d(${(B.x - AX).toFixed(1)}px, ${(B.y - AY).toFixed(1)}px, 0)`;
    if (hit) hit.style.transform = `translate3d(${(B.x - HIT / 2).toFixed(1)}px, ${(B.y - HIT / 2).toFixed(1)}px, 0)`;
    if (menu.el) menu.el.style.transform = `translate3d(${B.x.toFixed(1)}px, ${B.y.toFixed(1)}px, 0)`;
  }

  function destroy() {
    if (dead) return;
    dead = true;
    save();
    cancelAnimationFrame(raf);
    document.removeEventListener("pointermove", onPointer);
    document.removeEventListener("pointerdown", onPointer);
    document.removeEventListener("touchmove", onTouch);
    window.removeEventListener("pagehide", save);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("pointerdown", onDocDown, true);
    document.removeEventListener("keydown", onKey);
    canvas.remove();
    if (hit) hit.remove();
    if (menu.el) menu.el.remove();
    for (const el of printEls) el.remove();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    if (blur) blur.rt.dispose();
    renderer.dispose();
    delete window.chibineko;
  }
  canvas.addEventListener("webglcontextlost", destroy);

  const TRIGGERS = ["stand", "sit", "groom", "scratchWall", "tired", "sleep", "alert"];
  window.chibineko = {
    version: VERSION,
    /** Play a behaviour: stand, sit, groom, scratchWall, tired, sleep, alert or pet. */
    trigger(name) {
      if (name === "pet") return pet();
      if (!TRIGGERS.includes(name)) throw new Error("chibineko: unknown behaviour " + name);
      tx = B.x; // forget the pointer until it moves again
      ty = B.y;
      if (name === "groom" || name === "scratchWall") startIdle(name);
      else setState(name);
    },
    pet,
    destroy,
    /** Recolour the cat live, e.g. setColors(chibineko.presets.black). Remembered per viewer. */
    setColors,
    presets: JSON.parse(JSON.stringify(PRESETS)),
    get colors() {
      return { color: cfg.color, outline: cfg.outline, accent: cfg.accent };
    },
    get state() {
      return B.state;
    },
    /** Slow motion (or fast-forward) for inspecting the animation. 1 = normal speed. */
    get timeScale() {
      return timeScale;
    },
    set timeScale(v) {
      timeScale = clamp(Number(v) || 1, 0.05, 4);
    },
  };
  // Development hooks (data-debug): freeze the loop, step it by hand, grab frames.
  if (ds.debug !== undefined) {
    debug = window.chibineko._debug = {
      B,
      A,
      weights,
      pose,
      tail: { tailA, tailB },
      frozen: false,
      step,
      snap() {
        renderer.render(scene, camera);
        return canvas.toDataURL();
      },
    };
  }

  applyColors();
  place();
  raf = requestAnimationFrame(frame);
})();
