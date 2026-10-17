/* ============================================================
   C3D — Three.js layer for Blade Chess 3D
   - board, lighting, custom orbit camera
   - procedural 3D pieces (lathe + extrusion, real silhouettes)
   - tween engine, smooth move animations
   - SWORD CAPTURE: a sword swings through the victim, which is
     split in half with clipping planes and sent flying
   ============================================================ */
const C3D = (() => {
  'use strict';

  /* ============================== core ============================== */
  let renderer, scene, camera, container, clock;
  const squareMeshes = [];
  const pieces = new Map();          // square -> Group
  let piecesRoot, boardRoot;
  const tapHandlers = new Set();
  const frameHooks = new Set();
  const particles = [];              // sparks / chips
  const debris = [];                 // cut-in-half piece parts
  let shakeT = 1, shakeAmp = 0;
  let hoverPiece = null;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  /* ============================== utils ============================== */
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);

  const ease = {
    linear: k => k,
    inQuad: k => k * k,
    outQuad: k => k * (2 - k),
    inOutQuad: k => k < .5 ? 2 * k * k : -1 + (4 - 2 * k) * k,
    inCubic: k => k * k * k,
    outCubic: k => 1 - Math.pow(1 - k, 3),
    inOutCubic: k => k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2,
    outBack: k => { const c = 1.35; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); }
  };

  const Anim = {
    items: new Set(),
    go(dur, fn, easeName = 'inOutCubic') {
      return new Promise(res => {
        Anim.items.add({ t0: performance.now(), dur: Math.max(1, dur), fn, e: ease[easeName] || ease.linear, res });
      });
    },
    step(now) {
      for (const it of [...Anim.items]) {
        let k = (now - it.t0) / it.dur;
        if (k >= 1) k = 1;
        it.fn(it.e(k));
        if (k === 1) { Anim.items.delete(it); it.res(); }
      }
    }
  };
  const delay = ms => Anim.go(ms, () => {}, 'linear');

  function worldPos(square) {
    const file = square.charCodeAt(0) - 97;   // a=0
    const rank = +square[1] - 1;              // 1->0
    return V(file - 3.5, 0, 3.5 - rank);
  }

  /* ============================== materials ============================== */
  const MATS = {};
  function initMaterials() {
    MATS.ivory = new THREE.MeshStandardMaterial({ color: 0xefe2c9, roughness: 0.34, metalness: 0.05 });
    MATS.ebony = new THREE.MeshStandardMaterial({ color: 0x3d2c1e, roughness: 0.26, metalness: 0.18 });
    MATS.gold  = new THREE.MeshStandardMaterial({ color: 0xd9b45c, roughness: 0.28, metalness: 0.85 });
    MATS.dark  = new THREE.MeshStandardMaterial({ color: 0x191410, roughness: 0.5, metalness: 0.1 });
    MATS.steel = new THREE.MeshStandardMaterial({ color: 0xc9ced9, roughness: 0.18, metalness: 0.95 });
  }

  /* ============================== textures ============================== */
  function glowTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(64, 64, 2, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); return t;
  }
  function slashTexture() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.save();
    x.translate(128, 64); x.rotate(-0.5);
    x.fillStyle = g;
    const w = 300, h = 46;
    x.fillRect(-w / 2, -h / 2, w, h);
    x.restore();
    return new THREE.CanvasTexture(c);
  }
  function labelTexture(ch) {
    const c = document.createElement('canvas'); c.width = c.height = 96;
    const x = c.getContext('2d');
    x.fillStyle = '#c9a55a';
    x.font = '600 58px Georgia, serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(ch, 48, 52);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }
  function groundTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(256, 256, 20, 256, 256, 256);
    g.addColorStop(0, '#232839');
    g.addColorStop(0.55, '#141724');
    g.addColorStop(1, '#0b0d14');
    x.fillStyle = g; x.fillRect(0, 0, 512, 512);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }
  let TEX = {};

  /* ============================== camera controls ============================== */
  const ctrl = {
    az: 0.6, pol: 0.98, dist: 13.5,
    gAz: 0.6, gPol: 0.98, gDist: 13.5,
    target: V(0, 0.35, 0),
    auto: true
  };
  const pointers = new Map();
  let pinchD = 0, downInfo = null;

  function attachPointerEvents(dom) {
    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', e => {
      dom.setPointerCapture && dom.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // e.timeStamp = when the event was created (accurate even if the
      // main thread is busy and the handler runs late)
      if (pointers.size === 1) downInfo = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchD = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    dom.addEventListener('pointermove', e => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pointers.size === 1) {
        ctrl.auto = false;
        ctrl.gAz -= dx * 0.0055;
        ctrl.gPol = clamp(ctrl.gPol - dy * 0.0045, 0.30, 1.42);
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchD > 0) ctrl.gDist = clamp(ctrl.gDist * pinchD / d, 6.2, 20);
        pinchD = d;
      }
    });
    const up = e => {
      pointers.delete(e.pointerId);
      if (downInfo && pointers.size === 0) {
        const dt = e.timeStamp - downInfo.t;
        const dist = Math.hypot(e.clientX - downInfo.x, e.clientY - downInfo.y);
        if (dist < 8 && dt < 800) tapHandlers.forEach(h => h(e.clientX, e.clientY));
        downInfo = null;
      }
    };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', e => {
      e.preventDefault();
      ctrl.auto = false;
      ctrl.gDist = clamp(ctrl.gDist * (1 + e.deltaY * 0.0011), 6.2, 20);
    }, { passive: false });
  }

  function applyCam() {
    camera.position.set(
      ctrl.dist * Math.sin(ctrl.pol) * Math.sin(ctrl.az),
      ctrl.dist * Math.cos(ctrl.pol),
      ctrl.dist * Math.sin(ctrl.pol) * Math.cos(ctrl.az)
    ).add(ctrl.target);
    camera.lookAt(ctrl.target);
  }

  function setView(seat, instant) {
    // seat 'w' -> camera behind white (+z); 'b' -> behind black (-z)
    const az = seat === 'b' ? Math.PI : 0;
    ctrl.auto = false;
    if (instant) { ctrl.az = az; ctrl.gAz = az; }
    else ctrl.gAz = ctrl.az + shortestAngle(ctrl.az, az);
    // fairly high angle so back-rank pieces don't hide behind the front rank
    ctrl.gPol = 0.80; ctrl.gDist = 11.6;
  }
  function flipView() { ctrl.gAz = ctrl.az + Math.PI; }
  function shortestAngle(from, to) {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /* ============================== board ============================== */
  function buildBoard() {
    boardRoot = new THREE.Group();
    scene.add(boardRoot);

    const lightMat = new THREE.MeshStandardMaterial({ color: 0xcdb289, roughness: 0.5, metalness: 0.06 });
    const darkMat  = new THREE.MeshStandardMaterial({ color: 0x6a4327, roughness: 0.45, metalness: 0.06 });

    const sqGeo = new THREE.BoxGeometry(1, 0.16, 1);
    for (let r = 1; r <= 8; r++) {
      for (let f = 0; f < 8; f++) {
        // a1 (f=0,r=1) must be DARK: (f+r) odd -> dark
        const m = new THREE.Mesh(sqGeo, ((r + f) % 2 === 1) ? darkMat : lightMat);
        const w = worldPos('abcdefgh'[f] + r);
        m.position.set(w.x, -0.08, w.z);
        m.receiveShadow = true;
        m.userData.square = 'abcdefgh'[f] + r;
        boardRoot.add(m);
        squareMeshes.push(m);
      }
    }

    // frame
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x33200f, roughness: 0.55, metalness: 0.1 });
    const mkFrame = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.22, d), frameMat);
      m.position.set(x, -0.05, z);
      m.castShadow = m.receiveShadow = true;
      boardRoot.add(m);
    };
    mkFrame(9.4, 0.7, 0, 4.35); mkFrame(9.4, 0.7, 0, -4.35);
    mkFrame(0.7, 8.0, 4.35, 0); mkFrame(0.7, 8.0, -4.35, 0);

    // gold inlay line on the frame
    const inlay = new THREE.MeshStandardMaterial({ color: 0xb08d3f, roughness: 0.3, metalness: 0.85 });
    const mkInlay = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, d), inlay);
      m.position.set(x, 0.062, z);
      boardRoot.add(m);
    };
    mkInlay(8.6, 0.05, 0, 4.06); mkInlay(8.6, 0.05, 0, -4.06);
    mkInlay(0.05, 8.1, 4.06, 0); mkInlay(0.05, 8.1, -4.06, 0);

    // plinth
    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(9.9, 0.5, 9.9),
      new THREE.MeshStandardMaterial({ color: 0x1c1108, roughness: 0.7, metalness: 0.05 })
    );
    plinth.position.y = -0.36;
    plinth.receiveShadow = true;
    boardRoot.add(plinth);

    // coordinate labels
    const mkLabel = (ch, x, z, flip) => {
      const t = labelTexture(ch);
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(0.34, 0.34),
        new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false })
      );
      m.rotation.x = -Math.PI / 2;
      if (flip) m.rotation.z = Math.PI;
      m.position.set(x, 0.067, z);
      boardRoot.add(m);
    };
    for (let f = 0; f < 8; f++) {
      mkLabel('abcdefgh'[f], f - 3.5, 4.35, false);
      mkLabel('abcdefgh'[f], f - 3.5, -4.35, true);
    }
    for (let r = 1; r <= 8; r++) {
      mkLabel('' + r, -4.35, 3.5 - (r - 1), false);
      mkLabel('' + r, 4.35, 3.5 - (r - 1), true);
    }

    // ground
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(42, 48),
      new THREE.MeshStandardMaterial({ map: TEX.ground, roughness: 0.9, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.62;
    ground.receiveShadow = true;
    scene.add(ground);
  }

  /* ============================== pieces ============================== */
  const PIECE_H = { p: 0.84, r: 0.92, n: 1.08, b: 1.12, q: 1.33, k: 1.58 };

  function lathe(pts, seg = 44) {
    return new THREE.LatheGeometry(pts.map(p => new THREE.Vector2(p[0], p[1])), seg);
  }
  function addMesh(g, geo, mat) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    return m;
  }

  function buildPawn(mat) {
    const g = new THREE.Group();
    addMesh(g, lathe([
      [0, 0], [0.30, 0], [0.315, 0.015], [0.30, 0.04], [0.26, 0.07], [0.21, 0.11],
      [0.17, 0.17], [0.145, 0.24], [0.125, 0.31], [0.115, 0.36],
      [0.17, 0.40], [0.185, 0.425], [0.19, 0.44], [0.15, 0.46], [0.12, 0.49], [0.105, 0.53]
    ]), mat);
    const head = addMesh(g, new THREE.SphereGeometry(0.155, 24, 18), mat);
    head.position.y = 0.665;
    return g;
  }

  function buildRook(mat) {
    const g = new THREE.Group();
    addMesh(g, lathe([
      [0, 0], [0.33, 0], [0.345, 0.015], [0.33, 0.04], [0.29, 0.07], [0.25, 0.12],
      [0.235, 0.20], [0.245, 0.34], [0.26, 0.48], [0.275, 0.56], [0.295, 0.62],
      [0.30, 0.68], [0.30, 0.76], [0.21, 0.76], [0.21, 0.86], [0.205, 0.88], [0, 0.88]
    ]), mat);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.26;
      const m = addMesh(g, new THREE.BoxGeometry(0.115, 0.14, 0.10), mat);
      m.position.set(Math.cos(a) * 0.252, 0.83, Math.sin(a) * 0.252);
      m.rotation.y = -a;
    }
    return g;
  }

  function buildKnight(mat, darkMat) {
    const g = new THREE.Group();
    addMesh(g, lathe([
      [0, 0], [0.335, 0], [0.35, 0.015], [0.335, 0.04], [0.30, 0.07], [0.26, 0.12],
      [0.245, 0.18], [0.235, 0.24], [0.245, 0.30], [0.235, 0.345], [0.20, 0.375],
      [0.15, 0.39], [0, 0.395]
    ]), mat);

    // horse-head silhouette (CCW, x = forward, y = up)
    const s = new THREE.Shape();
    s.moveTo(-0.17, 0);
    s.lineTo(0.02, 0);
    s.lineTo(0.10, 0.06);
    s.lineTo(0.12, 0.16);
    s.lineTo(0.15, 0.21);
    s.lineTo(0.24, 0.22);
    s.lineTo(0.30, 0.26);
    s.lineTo(0.315, 0.33);
    s.quadraticCurveTo(0.30, 0.40, 0.24, 0.46);   // nose -> face
    s.quadraticCurveTo(0.19, 0.52, 0.09, 0.565);  // forehead
    s.lineTo(0.045, 0.60);
    s.lineTo(0.005, 0.71);                        // ear tip
    s.lineTo(-0.04, 0.60);
    s.lineTo(-0.075, 0.565);
    s.quadraticCurveTo(-0.16, 0.36, -0.20, 0.16); // back of neck
    s.lineTo(-0.17, 0);
    const geo = new THREE.ExtrudeGeometry(s, {
      depth: 0.24, bevelEnabled: true, bevelThickness: 0.028, bevelSize: 0.026, bevelSegments: 3, steps: 1
    });
    geo.translate(0, 0, -0.12);
    const head = addMesh(g, geo, mat);
    head.position.y = 0.355;

    // eyes + nostrils
    for (const zc of [1, -1]) {
      const eye = addMesh(g, new THREE.SphereGeometry(0.026, 10, 8), darkMat);
      eye.position.set(0.10, 0.835, zc * 0.128);
      const nos = addMesh(g, new THREE.SphereGeometry(0.017, 8, 6), darkMat);
      nos.position.set(0.268, 0.655, zc * 0.098);
    }
    return g;
  }

  function buildBishop(mat, darkMat) {
    const g = new THREE.Group();
    addMesh(g, lathe([
      [0, 0], [0.32, 0], [0.335, 0.015], [0.32, 0.04], [0.28, 0.07], [0.24, 0.12],
      [0.20, 0.19], [0.165, 0.28], [0.14, 0.37], [0.125, 0.44],
      [0.175, 0.48], [0.19, 0.51], [0.19, 0.53], [0.14, 0.56],
      [0.15, 0.62], [0.155, 0.70], [0.135, 0.78], [0.10, 0.86],
      [0.06, 0.93], [0.028, 0.985], [0, 1.01]
    ]), mat);
    const ball = addMesh(g, new THREE.SphereGeometry(0.048, 16, 12), mat);
    ball.position.y = 1.045;
    const fin = addMesh(g, new THREE.BoxGeometry(0.05, 0.31, 0.32), darkMat);
    fin.position.set(0, 0.78, 0);
    fin.rotation.z = 0.62;
    return g;
  }

  function buildQueen(mat, gold) {
    const g = new THREE.Group();
    addMesh(g, lathe([
      [0, 0], [0.35, 0], [0.365, 0.015], [0.35, 0.04], [0.31, 0.07], [0.27, 0.13],
      [0.23, 0.22], [0.195, 0.34], [0.165, 0.47], [0.14, 0.60], [0.125, 0.70],
      [0.175, 0.745], [0.19, 0.775], [0.19, 0.80], [0.15, 0.83],
      [0.17, 0.90], [0.205, 0.985], [0.225, 1.05], [0.235, 1.09], [0.19, 1.10],
      [0.16, 1.075], [0.13, 1.10], [0.09, 1.135], [0.05, 1.16], [0, 1.17]
    ]), mat);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const p = addMesh(g, new THREE.SphereGeometry(0.033, 10, 8), gold);
      p.position.set(Math.cos(a) * 0.222, 1.10, Math.sin(a) * 0.222);
    }
    const orb = addMesh(g, new THREE.SphereGeometry(0.072, 16, 12), gold);
    orb.position.y = 1.215;
    const tip = addMesh(g, new THREE.SphereGeometry(0.03, 10, 8), gold);
    tip.position.y = 1.295;
    const ring = addMesh(g, new THREE.TorusGeometry(0.192, 0.014, 8, 32), gold);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.815;
    return g;
  }

  function buildKing(mat, gold) {
    const g = new THREE.Group();
    addMesh(g, lathe([
      [0, 0], [0.375, 0], [0.39, 0.015], [0.375, 0.04], [0.335, 0.07], [0.29, 0.13],
      [0.25, 0.23], [0.215, 0.37], [0.185, 0.52], [0.16, 0.66], [0.145, 0.78], [0.135, 0.87],
      [0.19, 0.92], [0.205, 0.95], [0.205, 0.975], [0.16, 1.005],
      [0.185, 1.08], [0.215, 1.16], [0.23, 1.22], [0.20, 1.245], [0.155, 1.26],
      [0.11, 1.30], [0.06, 1.335], [0, 1.35]
    ]), mat);
    const cv = addMesh(g, new THREE.BoxGeometry(0.055, 0.25, 0.055), gold);
    cv.position.y = 1.465;
    const ch = addMesh(g, new THREE.BoxGeometry(0.185, 0.055, 0.055), gold);
    ch.position.y = 1.50;
    const ring = addMesh(g, new THREE.TorusGeometry(0.207, 0.014, 8, 32), gold);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.985;
    return g;
  }

  function makePiece(type, color) {
    const mat = color === 'w' ? MATS.ivory : MATS.ebony;
    let g;
    switch (type) {
      case 'p': g = buildPawn(mat); break;
      case 'r': g = buildRook(mat); break;
      case 'n': g = buildKnight(mat, MATS.dark); break;
      case 'b': g = buildBishop(mat, MATS.dark); break;
      case 'q': g = buildQueen(mat, MATS.gold); break;
      case 'k': g = buildKing(mat, MATS.gold); break;
      default: g = buildPawn(mat);
    }
    if (type === 'n') g.rotation.y = (color === 'w' ? 1 : -1) * Math.PI / 2;
    g.userData = { type, color, square: null };
    return g;
  }

  function spawnPiece(type, color, square) {
    const g = makePiece(type, color);
    const w = worldPos(square);
    g.position.copy(w);
    g.userData.square = square;
    piecesRoot.add(g);
    pieces.set(square, g);
    return g;
  }
  function pieceAt(sq) { return pieces.get(sq) || null; }
  function clearPieces() {
    for (const g of pieces.values()) piecesRoot.remove(g);
    pieces.clear();
    clearDebris();
    clearFlyers();
  }
  function buildFromFen(fen) {
    clearPieces();
    const rows = fen.split(' ')[0].split('/');
    for (let r = 0; r < 8; r++) {
      let f = 0;
      for (const ch of rows[r]) {
        if (/\d/.test(ch)) { f += +ch; continue; }
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        spawnPiece(ch.toLowerCase(), color, 'abcdefgh'[f] + (8 - r));
        f++;
      }
    }
  }

  /* ============================== highlights ============================== */
  const hl = { sel: null, dots: [], rings: [], lastA: null, lastB: null, check: null };

  function initHighlights() {
    const mk = (geo, color, opacity, blending) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, blending: blending || THREE.NormalBlending, depthWrite: false
      }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.userData.noPick = true;
      scene.add(m);
      return m;
    };
    hl.sel = mk(new THREE.RingGeometry(0.36, 0.45, 40), 0xffd76a, 0.9, THREE.AdditiveBlending);
    hl.check = mk(new THREE.RingGeometry(0.40, 0.50, 40), 0xff3b30, 0.8, THREE.AdditiveBlending);
    for (let i = 0; i < 28; i++)
      hl.dots.push(mk(new THREE.CircleGeometry(0.12, 20), 0x9fd8ff, 0.55, THREE.AdditiveBlending));
    for (let i = 0; i < 16; i++)
      hl.rings.push(mk(new THREE.RingGeometry(0.30, 0.41, 40), 0xff5340, 0.85, THREE.AdditiveBlending));
    hl.lastA = mk(new THREE.PlaneGeometry(0.94, 0.94), 0x4f8cff, 0.20);
    hl.lastB = mk(new THREE.PlaneGeometry(0.94, 0.94), 0x4f8cff, 0.20);
    hl.dots.concat(hl.rings, [hl.sel, hl.check, hl.lastA, hl.lastB]).forEach(m => m.renderOrder = 2);
  }

  function placeFlat(mesh, square, y) {
    const w = worldPos(square);
    mesh.position.set(w.x, y, w.z);
    mesh.visible = true;
  }
  let pickExempt = null; // the selected piece: clicks pass through it to the square behind

  function showSelection(square) {
    placeFlat(hl.sel, square, 0.021);
    hoverPiece = pieceAt(square);
    pickExempt = hoverPiece;
  }
  function showMoves(list) {
    let di = 0, ri = 0;
    for (const it of list) {
      if (it.capture) { if (ri < hl.rings.length) placeFlat(hl.rings[ri++], it.square, 0.023); }
      else if (di < hl.dots.length) placeFlat(hl.dots[di++], it.square, 0.019);
    }
  }
  function showLastMove(from, to) {
    placeFlat(hl.lastA, from, 0.011);
    placeFlat(hl.lastB, to, 0.011);
  }
  function showCheck(square) {
    if (!square) { hl.check.visible = false; return; }
    placeFlat(hl.check, square, 0.026);
  }
  function clearMoveHighlights() {
    if (hoverPiece) hoverPiece.position.y = 0; // don't leave the piece floating
    hoverPiece = null;
    pickExempt = null;
    [hl.sel, hl.check, hl.lastA, hl.lastB].forEach(m => m.visible = false);
    hl.dots.concat(hl.rings).forEach(m => m.visible = false);
  }

  /* ============================== particles & debris ============================== */
  function spawnSparks(pos, count = 14) {
    const mat = new THREE.SpriteMaterial({
      map: TEX.glow, color: 0xffcf7a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false
    });
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(mat);
      const sc = rand(0.07, 0.16);
      s.scale.set(sc, sc, 1);
      s.position.copy(pos);
      scene.add(s);
      particles.push({
        obj: s, mat,
        vel: V(rand(-1, 1), rand(0.5, 1.6), rand(-1, 1)).normalize().multiplyScalar(rand(2, 5)),
        grav: -9, ttl: rand(0.35, 0.6), t: 0, kind: 'sprite'
      });
    }
  }
  function spawnChips(pos, pieceColor, count = 12) {
    const col = pieceColor === 'w' ? 0xD8C49A : 0x4a3323;
    const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.8, transparent: true });
    const geo = new THREE.BoxGeometry(0.055, 0.055, 0.055);
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.position.copy(pos);
      scene.add(m);
      particles.push({
        obj: m, mat,
        vel: V(rand(-1, 1), rand(0.8, 1.8), rand(-1, 1)).normalize().multiplyScalar(rand(1.4, 3.4)),
        grav: -12, ttl: rand(0.7, 1.1), t: 0, kind: 'chip',
        spin: V(rand(-9, 9), rand(-9, 9), rand(-9, 9))
      });
    }
  }
  function stepParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += dt;
      if (p.t >= p.ttl) {
        scene.remove(p.obj);
        particles.splice(i, 1);
        continue;
      }
      p.vel.y += p.grav * dt;
      p.obj.position.addScaledVector(p.vel, dt);
      if (p.obj.position.y < 0.03 && p.vel.y < 0) {
        p.obj.position.y = 0.03;
        p.vel.y *= -0.3; p.vel.x *= 0.6; p.vel.z *= 0.6;
      }
      if (p.kind === 'chip') {
        p.obj.rotation.x += p.spin.x * dt;
        p.obj.rotation.y += p.spin.y * dt;
        p.obj.rotation.z += p.spin.z * dt;
      }
      p.mat.opacity = Math.max(0, 1 - (p.t / p.ttl));
    }
  }

  function deepCloneGroup(src) {
    const c = src.clone(true);
    c.traverse(o => { if (o.isMesh) o.material = o.material.clone(); });
    return c;
  }

  function splitPiece(victim, cutPoint, cutNormal, flyDir) {
    const parts = [];
    for (const keep of [1, -1]) {
      const g = deepCloneGroup(victim);
      g.userData.square = null; // flying halves must not be pickable
      const mats = [];
      const plane = new THREE.Plane();
      g.traverse(o => {
        if (o.isMesh) {
          o.material.transparent = true;
          o.material.clippingPlanes = [plane];
          o.material.clipShadows = true;
          mats.push(o.material);
        }
      });
      piecesRoot.add(g);
      parts.push({
        g, plane, mats, keep,
        n0: cutNormal.clone().multiplyScalar(keep),
        pt0: cutPoint.clone(),
        pos0: victim.position.clone(),
        quat0: victim.quaternion.clone(),
        t: 0, ttl: 1.7
      });
    }
    // top half flies, bottom half tips over
    const top = parts[0], bot = parts[1];
    top.mode = 'fly';
    top.vel = flyDir.clone().multiplyScalar(2.4).add(V(rand(-0.3, 0.3), 3.4, rand(-0.3, 0.3)));
    top.spin = V(rand(-8, 8), rand(-8, 8), rand(-8, 8));
    bot.mode = 'tip';
    bot.tipAxis = new THREE.Vector3().crossVectors(V(0, 1, 0), flyDir).normalize();
    bot.vel = flyDir.clone().multiplyScalar(0.9);
    debris.push(...parts);
    victim.visible = false;
    piecesRoot.remove(victim); // the clones replace it
    return parts;
  }

  const _dq = new THREE.Quaternion(), _qinv = new THREE.Quaternion(), _n = new THREE.Vector3();
  function stepDebris(dt) {
    for (let i = debris.length - 1; i >= 0; i--) {
      const h = debris[i];
      h.t += dt;
      const g = h.g;
      if (h.mode === 'fly') {
        h.vel.y -= 13 * dt;
        g.position.addScaledVector(h.vel, dt);
        if (g.position.y < 0 && h.vel.y < 0) {
          g.position.y = 0;
          h.vel.y *= -0.32; h.vel.x *= 0.55; h.vel.z *= 0.55;
          h.spin.multiplyScalar(0.5);
        }
        const w = Math.hypot(h.spin.x, h.spin.y, h.spin.z) * dt;
        if (w > 0.0001) {
          _dq.setFromAxisAngle(_n.copy(h.spin).normalize(), w);
          g.quaternion.premultiply(_dq);
        }
      } else { // tip over
        const k = Math.min(1, h.t / 0.55);
        const ang = 1.5 * k * k;
        g.position.copy(h.pos0).addScaledVector(h.vel, k * 0.35);
        g.position.y = h.pos0.y + Math.sin(ang) * 0.17;
        _dq.setFromAxisAngle(h.tipAxis, ang);
        g.quaternion.copy(_dq).multiply(h.quat0);
      }
      // keep the cut plane glued to the piece as it moves
      _qinv.copy(h.quat0).invert();
      _dq.copy(g.quaternion).multiply(_qinv);
      _n.copy(h.n0).applyQuaternion(_dq);
      h.plane.setFromNormalAndCoplanarPoint(
        _n,
        h.pt0.clone().add(g.position.clone().sub(h.pos0))
      );
      // fade out
      if (h.t > h.ttl - 0.6) {
        const f = Math.max(0, (h.ttl - h.t) / 0.6);
        h.mats.forEach(m => m.opacity = f);
      }
      if (h.t >= h.ttl) {
        piecesRoot.remove(g);
        h.mats.forEach(m => m.dispose());
        debris.splice(i, 1);
      }
    }
  }
  function clearDebris() {
    for (const h of debris) { piecesRoot.remove(h.g); h.mats.forEach(m => m.dispose()); }
    debris.length = 0;
  }

  /* ============================== the SWORD ============================== */
  /* ============================== SWORD DUELS ==============================
     Harry-Potter-style captures: BOTH pieces draw swords, the blades clash
     mid-air (the defender is disarmed, its sword flying off), and then the
     attacker's blade sweeps through the defender, cutting it in two. */

  const flyers = [];   // disarmed swords tumbling away

  function makeSword() {
    const g = new THREE.Group();
    const mats = [];
    const mk = (geo, mat) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      mats.push(mat);
      g.add(m);
      return m;
    };
    mk(new THREE.BoxGeometry(0.052, 0.80, 0.014),
       new THREE.MeshStandardMaterial({ color: 0xcdd2dc, roughness: 0.18, metalness: 0.95, transparent: true })).position.y = 0.475;
    mk(new THREE.ConeGeometry(0.028, 0.14, 4),
       new THREE.MeshStandardMaterial({ color: 0xcdd2dc, roughness: 0.18, metalness: 0.95, transparent: true })).position.y = 0.935;
    mk(new THREE.BoxGeometry(0.24, 0.034, 0.046),
       new THREE.MeshStandardMaterial({ color: 0xd9b45c, roughness: 0.28, metalness: 0.85, transparent: true })).position.y = 0.072;
    mk(new THREE.CylinderGeometry(0.023, 0.027, 0.17, 10),
       new THREE.MeshStandardMaterial({ color: 0x191410, roughness: 0.5, metalness: 0.1, transparent: true })).position.y = -0.012;
    mk(new THREE.SphereGeometry(0.04, 12, 10),
       new THREE.MeshStandardMaterial({ color: 0xd9b45c, roughness: 0.28, metalness: 0.85, transparent: true })).position.y = -0.105;
    g.userData = { mats };
    return g;
  }
  function setSwordOpacity(swordObj, o) { swordObj.userData.mats.forEach(m => m.opacity = o); }

  function clashFX(point) {
    SFX.clash();
    spawnSparks(point, 10);
    shake(0.09);
    const fl = new THREE.PointLight(0xcfe0ff, 1.9, 5);
    fl.position.copy(point);
    scene.add(fl);
    Anim.go(170, k => { fl.intensity = 1.9 * (1 - k); }, 'outQuad').then(() => scene.remove(fl));
  }

  /* the defender's sword is knocked out of its grip and tumbles away */
  function disarmVictimSword(victim, swordV, sideVec) {
    victim.updateMatrixWorld(true);
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    swordV.getWorldPosition(wp);
    swordV.getWorldQuaternion(wq);
    swordV.getWorldScale(ws);
    // detach from the victim (so the cut-in-half clones stay sword-free)
    if (swordV.parent) swordV.parent.remove(swordV);
    swordV.position.copy(wp);
    swordV.quaternion.copy(wq);
    swordV.scale.copy(ws);
    piecesRoot.add(swordV);
    flyers.push({
      obj: swordV, mats: swordV.userData.mats,
      vel: sideVec.clone().multiplyScalar(2.8).add(V(rand(-0.3, 0.3), 3.6, rand(-0.3, 0.3))),
      spin: V(rand(-9, 9), rand(-9, 9), rand(-9, 9)),
      t: 0, ttl: 0.95
    });
  }

  const _fq = new THREE.Quaternion(), _fv = new THREE.Vector3();
  function stepFlyers(dt) {
    for (let i = flyers.length - 1; i >= 0; i--) {
      const f = flyers[i];
      f.t += dt;
      if (f.t >= f.ttl) {
        piecesRoot.remove(f.obj);
        f.mats.forEach(m => m.dispose());
        flyers.splice(i, 1);
        continue;
      }
      f.vel.y -= 11 * dt;
      f.obj.position.addScaledVector(f.vel, dt);
      if (f.obj.position.y < 0.05 && f.vel.y < 0) {
        f.obj.position.y = 0.05;
        f.vel.y *= -0.3; f.vel.x *= 0.6; f.vel.z *= 0.6;
      }
      const w = f.spin.length() * dt;
      if (w > 1e-4) {
        _fq.setFromAxisAngle(_fv.copy(f.spin).normalize(), w);
        f.obj.quaternion.premultiply(_fq);
      }
      if (f.t > f.ttl - 0.35) f.mats.forEach(m => m.opacity = Math.max(0, (f.ttl - f.t) / 0.35));
    }
  }
  function clearFlyers() {
    for (const f of flyers) { piecesRoot.remove(f.obj); f.mats.forEach(m => m.dispose()); }
    flyers.length = 0;
  }

  /* The full duel. `dir` = horizontal unit vector pointing attacker -> victim.
     The attacker must already be stopped a short distance from the victim. */
  async function duelCapture(attacker, victim, dir) {
    const vh = PIECE_H[victim.userData.type] || 1;
    const ah = PIECE_H[attacker.userData.type] || 1;
    const aW = attacker.position.clone();
    const vW = victim.position.clone();
    const up = V(0, 1, 0);

    // --- attacker's sword arm (child of the attacker, on the side facing the victim)
    const qInv = attacker.quaternion.clone().invert();
    const localDir = dir.clone().applyQuaternion(qInv);
    localDir.y = 0; localDir.normalize();
    const arm = new THREE.Group();
    arm.position.copy(localDir).multiplyScalar(0.30).add(V(0, ah * 0.40, 0));
    const sword = makeSword();
    sword.scale.setScalar(0.001);
    arm.add(sword);
    attacker.add(arm);

    // --- swing geometry (world space)
    const swingAxisW = new THREE.Vector3().crossVectors(up, dir).normalize();
    const handW = aW.clone().addScaledVector(dir, 0.30).add(V(0, ah * 0.40, 0));
    const cutPoint = vW.clone().add(V(0, vh * 0.55, 0));
    const rel = cutPoint.clone().sub(handW);
    const horiz = Math.hypot(rel.x, rel.z);
    const thetaI = Math.atan2(horiz, Math.max(0.02, rel.y)); // blade angle (from vertical) that aims at the victim
    const TH_START = thetaI - 1.55, TH_CLASH = thetaI - 0.52, TH_END = thetaI + 1.05;
    const applyArm = th => {
      const qWorld = new THREE.Quaternion().setFromAxisAngle(swingAxisW, th);
      arm.quaternion.copy(attacker.quaternion.clone().invert().multiply(qWorld));
    };

    // --- defender's guard sword
    const qvInv = victim.quaternion.clone().invert();
    const localDirV = dir.clone().negate().applyQuaternion(qvInv);
    localDirV.y = 0; localDirV.normalize();
    const armV = new THREE.Group();
    armV.position.copy(localDirV).multiplyScalar(0.30).add(V(0, vh * 0.40, 0));
    const swordV = makeSword();
    swordV.scale.setScalar(0.001);
    armV.add(swordV);
    victim.add(armV);
    // guard pose: blade raised toward the attacker
    const axisVLocal = new THREE.Vector3().crossVectors(up, localDirV).normalize();
    armV.quaternion.setFromAxisAngle(axisVLocal, 0.62);

    // --- 1) DRAW: both swords grow out of their holders
    applyArm(TH_START);
    SFX.draw();
    Anim.go(150, k => {
      const s = Math.max(0.001, k);
      sword.scale.setScalar(s);
      swordV.scale.setScalar(s);
    }, 'outQuad');
    await delay(170);

    // --- 2) CLASH + CUT: one accelerating swing; the defender is disarmed
    //        mid-swing, then the blade passes through its body
    const sideVec = swingAxisW.clone().multiplyScalar(Math.random() < 0.5 ? 1 : -1);
    const lungeFrom = attacker.position.clone();
    const lungeTo = vW.clone().addScaledVector(dir, -0.50); lungeTo.y = 0;
    let clashed = false, killed = false;
    SFX.whoosh();
    await Anim.go(240, k => {
      const th = TH_START + (TH_END - TH_START) * k;
      applyArm(th);
      // the attacker lunges into the strike during the second half of the swing
      const lk = Math.max(0, (k - 0.30) / 0.70);
      attacker.position.lerpVectors(lungeFrom, lungeTo, lk);
      if (!clashed && th >= TH_CLASH) {
        clashed = true;
        clashFX(aW.clone().add(vW).multiplyScalar(0.5).add(V(0, (ah + vh) * 0.30, 0)));
        disarmVictimSword(victim, swordV, sideVec);
      }
      if (!killed && th >= thetaI) {
        killed = true;
        const bladeDirI = up.clone().multiplyScalar(Math.cos(thetaI)).addScaledVector(dir, Math.sin(thetaI));
        const cutNormal = new THREE.Vector3()
          .crossVectors(bladeDirI, swingAxisW)
          .addScaledVector(sideVec, 0.5)
          .normalize();
        const flyDir = dir.clone().multiplyScalar(0.85).addScaledVector(sideVec, 0.5).normalize();
        strikeImpact(victim, cutPoint, cutNormal, flyDir);
      }
    }, 'inQuad');

    // --- 3) the attacker's sword fades as it steps into the square
    Anim.go(220, k => setSwordOpacity(sword, 1 - k), 'outQuad').then(() => {
      if (arm.parent) attacker.remove(arm);
      sword.userData.mats.forEach(m => m.dispose());
    });
  }

  /* impact visuals: flash + sparks + chips + shake + split */
  function strikeImpact(victim, cutPoint, cutNormal, flyDir) {
    SFX.capture();
    // flash light
    const fl = new THREE.PointLight(0xffd9a0, 3.6, 8);
    fl.position.copy(cutPoint);
    scene.add(fl);
    Anim.go(220, k => { fl.intensity = 3.6 * (1 - k); }, 'outQuad').then(() => scene.remove(fl));
    // slash streak
    const streak = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX.slash, color: 0xfff2d0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false
    }));
    streak.position.copy(cutPoint);
    streak.scale.set(0.8, 0.4, 1);
    scene.add(streak);
    Anim.go(190, k => {
      streak.scale.set(0.8 + 2.0 * k, 0.4 + 0.9 * k, 1);
      streak.material.opacity = 1 - k;
    }, 'outQuad').then(() => { scene.remove(streak); streak.material.dispose(); });
    // debris
    spawnSparks(cutPoint, 16);
    spawnChips(cutPoint, victim.userData.color, 12);
    shake(0.20);
    splitPiece(victim, cutPoint, cutNormal, flyDir);
  }

  function shake(amp) { shakeAmp = amp; shakeT = 0; }

  /* ============================== move animations ============================== */
  function glideTo(g, to, dur, lift, easeName = 'inOutCubic') {
    const from = g.position.clone();
    return Anim.go(dur, k => {
      g.position.lerpVectors(from, to, k);
      g.position.y = from.y + (to.y - from.y) * k + Math.sin(k * Math.PI) * lift;
    }, easeName);
  }
  function hopTo(g, to, dur = 480, height = 1.25) {
    const from = g.position.clone();
    return Anim.go(dur, k => {
      g.position.lerpVectors(from, to, k);
      g.position.y = Math.sin(k * Math.PI) * height;
    }, 'inOutQuad');
  }

  function promoteSwap(g, newType, color, square) {
    return new Promise(async resolve => {
      const w = worldPos(square);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: TEX.glow, color: 0xffe6a8, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false
      }));
      glow.scale.set(0.5, 0.5, 1);
      glow.position.copy(w).add(V(0, 0.6, 0));
      scene.add(glow);
      SFX.promote();
      await Anim.go(160, k => { g.scale.setScalar(1 - 0.999 * k); glow.scale.setScalar(0.5 + 1.4 * k); }, 'inQuad');
      piecesRoot.remove(g);
      pieces.delete(square);
      const np = spawnPiece(newType, color, square);
      np.scale.setScalar(0.001);
      await Anim.go(260, k => {
        np.scale.setScalar(Math.max(0.001, k));
        glow.scale.setScalar(1.9 - 0.9 * k);
        glow.material.opacity = 1 - k;
      }, 'outBack');
      scene.remove(glow); glow.material.dispose();
      resolve();
    });
  }

  function rookSquaresFor(mv) {
    if (mv.color === 'w') return mv.flags.includes('k') ? ['h1', 'f1'] : ['a1', 'd1'];
    return mv.flags.includes('k') ? ['h8', 'f8'] : ['a8', 'd8'];
  }

  /* Main entry: animate a chess.js verbose move */
  async function animateVerboseMove(mv) {
    const g = pieces.get(mv.from);
    if (!g) return;
    hoverPiece = null;
    const flags = mv.flags || '';
    const isKnight = mv.piece === 'n';
    const capSq = flags.includes('e') ? (mv.to[0] + mv.from[1]) : (flags.includes('c') ? mv.to : null);
    const victim = capSq ? pieces.get(capSq) : null;

    // update logical mapping
    pieces.delete(mv.from);
    if (capSq) pieces.delete(capSq);
    pieces.set(mv.to, g);
    g.userData.square = mv.to;

    const toW = worldPos(mv.to);

    if (victim) {
      // direction of the attack (attacker -> victim, horizontal)
      const fromW = worldPos(mv.from);
      const vicW = worldPos(capSq);
      let dir = vicW.clone().sub(fromW); dir.y = 0;
      if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
      dir.normalize();

      // 1) the attacker closes in and stops a short distance from the victim
      const hover = vicW.clone().addScaledVector(dir, -0.78); hover.y = 0;
      if (isKnight) await hopTo(g, hover, 420, 1.15);
      else await glideTo(g, hover, 250, 0.15);

      // 2) swords are drawn, they clash, the victim is disarmed and cut down
      await duelCapture(g, victim, dir);

      // 3) the victor steps into the square
      await glideTo(g, toW, 210, 0.10);
      SFX.move();
    } else {
      if (isKnight) await hopTo(g, toW);
      else await glideTo(g, toW, 430, 0.15);
      SFX.move();
    }

    // promotion (pawn becomes a new piece)
    if (flags.includes('p') && mv.promotion) {
      await promoteSwap(g, mv.promotion, mv.color, mv.to);
    }

    // castling: rook slides too
    if (flags.includes('k') || flags.includes('q')) {
      const [rf, rt] = rookSquaresFor(mv);
      const rg = pieces.get(rf);
      if (rg) {
        pieces.delete(rf); pieces.set(rt, rg); rg.userData.square = rt;
        glideTo(rg, worldPos(rt), 430, 0.14);
        SFX.castle();
      }
    }
  }

  /* ============================== picking ============================== */
  function pick(x, y) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((x - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((y - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    // Raycast against squares AND piece meshes — clicking a piece's tall body
    // must map to that piece's square, not the square behind it.
    const hits = raycaster.intersectObjects([piecesRoot, ...squareMeshes], true);
    for (const h of hits) {
      let o = h.object;
      if (o.userData.noPick) continue;            // highlights / effects
      // the SELECTED piece never blocks clicks: when you click the square it
      // should move to, the ray may pass through its own tall body (e.g. the
      // king's cross) — skip it so the move target behind is picked instead
      let top = o;
      while (top.parent && top.parent !== piecesRoot) top = top.parent;
      if (top === pickExempt) continue;
      while (o && o.userData.square === undefined) o = o.parent;
      if (o && o.userData.square) return o.userData.square;
    }
    return null;
  }

  /* ============================== atmosphere ============================== */
  let dustGeo = null, dustPos = null, dustPhase = [];
  function buildDust() {
    const N = 70;
    dustGeo = new THREE.BufferGeometry();
    dustPos = new Float32Array(N * 3);
    const base = [];
    for (let i = 0; i < N; i++) {
      base.push(V(rand(-9, 9), rand(0.3, 6.5), rand(-9, 9)));
      dustPhase.push(rand(0, Math.PI * 2));
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x93a7c9, size: 0.045, transparent: true, opacity: 0.35, depthWrite: false
    });
    const pts = new THREE.Points(dustGeo, mat);
    scene.add(pts);
    frameHooks.add(t => {
      for (let i = 0; i < N; i++) {
        dustPos[i * 3] = base[i].x + Math.sin(t * 0.00021 + dustPhase[i]) * 0.5;
        dustPos[i * 3 + 1] = base[i].y + Math.sin(t * 0.00033 + dustPhase[i] * 1.7) * 0.35;
        dustPos[i * 3 + 2] = base[i].z + Math.cos(t * 0.00017 + dustPhase[i]) * 0.5;
      }
      dustGeo.attributes.position.needsUpdate = true;
    });
  }

  /* ============================== init & loop ============================== */
  function init(el) {
    container = el;
    // ?fx=low — lighter effects for weak devices (no shadows, no dust)
    const lowFx = new URLSearchParams(location.search).get('fx') === 'low';

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(lowFx ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = !lowFx;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.localClippingEnabled = true;
    renderer.setClearColor(0x0b0d14, 1);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0b0d14, 0.020);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 120);
    applyCam();

    TEX = { glow: glowTexture(), slash: slashTexture(), ground: groundTexture() };

    initMaterials();

    // lights
    scene.add(new THREE.HemisphereLight(0x9aa5cc, 0x241a12, 0.55));
    const key = new THREE.DirectionalLight(0xfff2df, lowFx ? 1.3 : 1.15);
    key.position.set(7, 14, 8);
    if (!lowFx) {
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.camera.left = key.shadow.camera.bottom = -9;
      key.shadow.camera.right = key.shadow.camera.top = 9;
      key.shadow.camera.near = 2; key.shadow.far = 40;
      key.shadow.bias = -0.0004;
    }
    scene.add(key);
    const warm = new THREE.PointLight(0xff9a55, 0.5, 42, 2); warm.position.set(-9, 6, -6); scene.add(warm);
    const cool = new THREE.PointLight(0x5d7bff, 0.42, 42, 2); cool.position.set(9, 5, 7); scene.add(cool);

    piecesRoot = new THREE.Group();
    scene.add(piecesRoot);

    buildBoard();
    initHighlights();
    if (!lowFx) buildDust();
    buildFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');

    attachPointerEvents(renderer.domElement);

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    clock = performance.now();
    requestAnimationFrame(loop);
  }

  let lastT = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
    lastT = now;

    Anim.step(now);
    stepParticles(dt);
    stepDebris(dt);
    stepFlyers(dt);
    for (const h of frameHooks) h(now);

    // camera smoothing
    if (ctrl.auto) ctrl.gAz += dt * 0.10;
    const lerp = Math.min(1, dt * 7);
    ctrl.az += (ctrl.gAz - ctrl.az) * lerp;
    ctrl.pol += (ctrl.gPol - ctrl.pol) * lerp;
    ctrl.dist += (ctrl.gDist - ctrl.dist) * lerp;
    applyCam();

    // camera shake
    if (shakeT < 0.25) {
      shakeT += dt;
      const k = Math.max(0, 1 - shakeT / 0.25);
      camera.position.x += (Math.random() - 0.5) * shakeAmp * k;
      camera.position.y += (Math.random() - 0.5) * shakeAmp * k;
    }

    // selected piece hovers gently
    if (hoverPiece) hoverPiece.position.y = 0.055 + Math.sin(now * 0.004) * 0.03;

    // check ring pulse
    if (hl.check.visible) {
      hl.check.material.opacity = 0.45 + 0.35 * Math.sin(now * 0.008);
    }

    renderer.render(scene, camera);
  }

  /* ============================== public API ============================== */
  return {
    init, worldPos, pick,
    buildFromFen, spawnPiece, pieceAt, clearPieces,
    showSelection, showMoves, showLastMove, showCheck, clearMoveHighlights,
    animateVerboseMove,
    setView, flipView,
    getCamera: () => camera,
    autoRotate(on) { ctrl.auto = !!on; },
    onTap: fn => { tapHandlers.add(fn); return () => tapHandlers.delete(fn); },
    Anim, delay, ease,
    isBusy: () => Anim.items.size > 0
  };
})();
