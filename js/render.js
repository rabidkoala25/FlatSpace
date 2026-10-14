// render.js — flight view, map view, particles and effects (Canvas 2D).
(function () {
  const V = FS.vec;
  const TAU = FS.TAU;
  const R = (FS.Render = {});
  FS.SUN_DIR = { x: 1, y: 0 }; // sunlight comes from +x (far away)

  let cv, ctx, W = 0, H = 0, DPR = 1;
  const stars = [];
  const sprites = {};

  R.init = (canvas) => {
    cv = canvas;
    ctx = canvas.getContext('2d');
    const rnd = FS.rng(4242);
    for (let i = 0; i < 700; i++) {
      const a = rnd() * TAU, d = Math.sqrt(rnd());
      const temp = rnd();
      stars.push({
        x: Math.cos(a) * d, y: Math.sin(a) * d,
        size: Math.pow(rnd(), 6) * 1.8 + 0.4,
        b: 0.35 + rnd() * 0.65,
        c: temp < 0.15 ? '255,214,170' : temp > 0.85 ? '178,206,255' : '240,244,255',
      });
    }
    sprites.flame = makeSprite([[0, 'rgba(255,250,225,1)'], [0.25, 'rgba(255,200,90,0.9)'], [0.6, 'rgba(255,110,30,0.35)'], [1, 'rgba(255,60,0,0)']]);
    sprites.blue = makeSprite([[0, 'rgba(235,245,255,1)'], [0.3, 'rgba(150,190,255,0.8)'], [1, 'rgba(80,120,255,0)']]);
    sprites.smoke = makeSprite([[0, 'rgba(225,222,215,0.55)'], [0.6, 'rgba(190,188,182,0.25)'], [1, 'rgba(160,160,160,0)']]);
    sprites.glow = makeSprite([[0, 'rgba(255,255,255,1)'], [0.2, 'rgba(255,190,120,0.7)'], [1, 'rgba(255,90,30,0)']]);
    R.resize();
  };

  function makeSprite(stops) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    stops.forEach(([o, col]) => gr.addColorStop(o, col));
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  R.resize = () => {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  };
  R.size = () => ({ W, H });

  // ---- Camera transforms ----
  // cam: {x, y (absolute metres), s (px per metre), rot (radians)}
  function w2s(cam, x, y) {
    const dx = x - cam.x, dy = y - cam.y;
    const c = Math.cos(cam.rot), s = Math.sin(cam.rot);
    const xr = dx * c + dy * s;
    const yr = -dx * s + dy * c;
    return { x: W / 2 + xr * cam.s, y: H / 2 - yr * cam.s };
  }
  R.w2s = w2s;
  R.s2w = (cam, sx, sy) => {
    const xr = (sx - W / 2) / cam.s, yr = -(sy - H / 2) / cam.s;
    const c = Math.cos(cam.rot), s = Math.sin(cam.rot);
    return { x: cam.x + xr * c - yr * s, y: cam.y + xr * s + yr * c };
  };
  // Set the context so that drawing in (abs - cam) metre coordinates works.
  function setWorld(cam) {
    const c = Math.cos(cam.rot) * cam.s, s = Math.sin(cam.rot) * cam.s;
    ctx.setTransform(DPR * c, DPR * s, DPR * s, -DPR * c, DPR * W / 2, DPR * H / 2);
  }
  function setScreen() { ctx.setTransform(DPR, 0, 0, DPR, 0, 0); }

  // ---- Background ----
  function drawStars(cam, alpha, rotate) {
    if (alpha <= 0.01) return;
    const rad = Math.hypot(W, H) * 0.55;
    const rot = rotate ? cam.rot : 0;
    const c = Math.cos(-rot), s = Math.sin(-rot);
    // faint galactic band
    ctx.save();
    ctx.globalAlpha = alpha * 0.5;
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-rot + 0.6);
    const band = ctx.createLinearGradient(0, -rad * 0.35, 0, rad * 0.35);
    band.addColorStop(0, 'rgba(90,110,170,0)');
    band.addColorStop(0.5, 'rgba(120,130,190,0.10)');
    band.addColorStop(1, 'rgba(90,110,170,0)');
    ctx.fillStyle = band;
    ctx.fillRect(-rad, -rad * 0.35, rad * 2, rad * 0.7);
    ctx.restore();
    for (const st of stars) {
      const x = W / 2 + (st.x * c - st.y * s) * rad;
      const y = H / 2 + (st.x * s + st.y * c) * rad;
      if (x < -2 || y < -2 || x > W + 2 || y > H + 2) continue;
      ctx.fillStyle = `rgba(${st.c},${st.b * alpha})`;
      ctx.fillRect(x, y, st.size, st.size);
    }
  }

  // Lighting factor for a point on a body: 1 = noon, 0 = night.
  function sunlight(up) {
    const d = V.dot(up, FS.SUN_DIR);
    return FS.smoothstep(-0.12, 0.25, d);
  }

  // ---- Bodies ----
  // Three ways to draw a body, picked by how big it is on screen:
  //  'dot'     tiny: a filled circle
  //  'disc'    whole planet visible: interior + coloured surface band + halo + night side
  //  'surface' camera close to the ground: real terrain relief, ocean, launch site
  // A 'disc' bigger than the screen is drawn only over the visible arc, so the
  // canvas never sees coordinates millions of pixels away.
  function surfaceColor(b, h) {
    if (b.ocean && h < 0) return b.colors.ocean;
    if (b.ocean && h < 40) return b.colors.sand;
    if (b.ocean && h > 2550) return b.colors.snow;
    if (h > (b.ocean ? 1900 : b.terrain.amp * 0.6)) return b.colors.rock;
    return b.colors.land;
  }

  function drawBody(cam, b, t, opts = {}) {
    const c = FS.bodyAbs(b, t);
    const rel = V.sub(c, cam);
    const dist = V.len(rel);
    const Rpx = b.R * cam.s;
    const viewR = Math.hypot(W, H) / 2 / cam.s;
    const atmoH = b.atmo ? b.atmo.height : 0;
    const maxH = b.terrain.amp * 2.5;
    const rot = FS.bodyRot(b, t);
    const px = 1 / cam.s;

    if (Rpx < 4) {
      if (dist - b.R > viewR * 1.2) {
        const sp = w2s(cam, c.x, c.y);
        if (sp.x < -10 || sp.y < -10 || sp.x > W + 10 || sp.y > H + 10) return;
      }
      const sp = w2s(cam, c.x, c.y);
      setScreen();
      ctx.beginPath(); ctx.arc(sp.x, sp.y, Math.max(Rpx, opts.minPx || 2.5), 0, TAU);
      ctx.fillStyle = b.colors.disc; ctx.fill();
      return;
    }

    const haloR = b.R + atmoH * 1.4;
    const surfVisible = dist - b.R - maxH < viewR;
    const haloVisible = b.atmo && dist - haloR < viewR;
    if (!surfVisible && !haloVisible) return;

    setWorld(cam);
    const up = dist > 0 ? V.scale(rel, -1 / dist) : { x: 0, y: 1 }; // centre → camera
    const camAng = Math.atan2(up.y, up.x);
    const full = Rpx < 4000;
    const near = !full && Rpx > 30000 && dist - b.R < viewR * 3 + maxH;

    // Visible window of longitudes
    let a0 = 0, a1 = TAU, N;
    if (!full) {
      const span = dist > viewR * 1.5 ? Math.min(Math.PI, Math.asin(Math.min(1, (viewR * 1.5) / dist)) + 0.002) : Math.PI;
      a0 = camAng - span; a1 = camAng + span;
      N = near ? 420 : 360;
    } else N = Math.round(FS.clamp(Rpx * 0.8, 96, 1600));
    const arc = (rad, from, to, n, move = true) => {
      for (let i = 0; i <= n; i++) {
        const a = from + ((to - from) * i) / n;
        const x = rel.x + Math.cos(a) * rad, y = rel.y + Math.sin(a) * rad;
        i === 0 && move ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
    };
    const deepR = full ? 0 : Math.max(0, b.R - maxH - viewR * 2.5);
    const closeDeep = () => {
      if (full) return;
      ctx.lineTo(rel.x + Math.cos(a1) * deepR, rel.y + Math.sin(a1) * deepR);
      ctx.lineTo(rel.x + Math.cos(a0) * deepR, rel.y + Math.sin(a0) * deepR);
    };
    // gradient along local "up" starting at the surface below the camera
    const localGrad = (r0, r1, stops) => {
      const g = ctx.createLinearGradient(rel.x + up.x * r0, rel.y + up.y * r0, rel.x + up.x * r1, rel.y + up.y * r1);
      stops.forEach(([o, col]) => g.addColorStop(o, col));
      return g;
    };

    // ---- Atmosphere halo (not when we are down inside it) ----
    if (b.atmo && !near) {
      const [r0, g0, b0] = b.atmo.color;
      const stops = [[0, `rgba(${r0},${g0},${b0},0.55)`], [0.45, `rgba(${r0},${g0},${b0},0.18)`], [1, `rgba(${r0},${g0},${b0},0)`]];
      ctx.beginPath();
      if (full) {
        const g = ctx.createRadialGradient(rel.x, rel.y, b.R * 0.98, rel.x, rel.y, haloR);
        stops.forEach(([o, col]) => g.addColorStop(o, col));
        ctx.fillStyle = g;
        ctx.arc(rel.x, rel.y, haloR, 0, TAU);
      } else {
        ctx.fillStyle = localGrad(b.R * 0.98, haloR, stops);
        arc(haloR, a0, a1, N);
        arc(b.R * 0.98, a1, a0, N, false);
        ctx.closePath();
      }
      ctx.fill();
    }
    if (!surfVisible) return;

    // Sample the surface once
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const a = a0 + ((a1 - a0) * i) / N;
      const h = FS.terrainHeight(b, a - rot);
      pts.push({ a, h, x: rel.x + Math.cos(a) * (b.R + h), y: rel.y + Math.sin(a) * (b.R + h) });
    }

    if (near) {
      // ---- Real terrain ----
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      closeDeep();
      ctx.closePath();
      ctx.fillStyle = localGrad(b.R, b.R - viewR * 1.5, [[0, b.colors.land], [1, b.colors.landDeep]]);
      ctx.fill();
      strokeRuns(pts, (p) => { const col = surfaceColor(b, Math.max(p.h, b.ocean ? 0 : p.h)); return col === b.colors.land ? shade(b.colors.land, 1.3) : col; }, px * 3);
      if (b.ocean) {
        ctx.beginPath();
        arc(b.R, a0, a1, N);
        closeDeep();
        ctx.closePath();
        ctx.fillStyle = localGrad(b.R, b.R - viewR, [[0, b.colors.ocean], [1, b.colors.oceanDeep]]);
        ctx.fill();
        ctx.beginPath();
        let pen = false;
        for (const p of pts) {
          const x = rel.x + Math.cos(p.a) * b.R, y = rel.y + Math.sin(p.a) * b.R;
          if (p.h > 0) { pen = false; continue; }
          pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          pen = true;
        }
        ctx.strokeStyle = 'rgba(170,210,255,0.6)';
        ctx.lineWidth = px * 2;
        ctx.stroke();
      }
      if (b.pad) drawSpaceCenter(cam, b, t, rel, px);
      return;
    }

    // ---- Disc: interior, then a coloured band showing the surface type ----
    const band = Math.max(px * 3, b.R * 0.035);
    ctx.beginPath();
    if (full) ctx.arc(rel.x, rel.y, b.R, 0, TAU);
    else { arc(b.R, a0, a1, N); closeDeep(); ctx.closePath(); }
    const interior = b.ocean ? b.colors.oceanDeep : b.colors.landDeep;
    if (full) {
      const g = ctx.createRadialGradient(rel.x, rel.y, b.R * 0.2, rel.x, rel.y, b.R);
      g.addColorStop(0, shade(interior, 0.75)); g.addColorStop(1, interior);
      ctx.fillStyle = g;
    } else ctx.fillStyle = interior;
    ctx.fill();
    // surface band (stroked arc runs)
    const bandPts = pts.map((p) => ({ ...p, x: rel.x + Math.cos(p.a) * (b.R - band / 2), y: rel.y + Math.sin(p.a) * (b.R - band / 2) }));
    strokeRuns(bandPts, (p) => surfaceColor(b, p.h), band, 'butt');
    // relief line on top
    ctx.beginPath();
    pts.forEach((p, i) => {
      const r = b.R + Math.max(b.ocean ? 0 : -1e9, p.h);
      const x = rel.x + Math.cos(p.a) * r, y = rel.y + Math.sin(p.a) * r;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = px;
    ctx.stroke();

    // Night side
    const sun = FS.SUN_DIR;
    if (full) {
      const g = ctx.createRadialGradient(rel.x + sun.x * b.R * 0.6, rel.y + sun.y * b.R * 0.6, b.R * 0.1, rel.x + sun.x * b.R * 0.25, rel.y + sun.y * b.R * 0.25, b.R * 1.35);
      g.addColorStop(0, 'rgba(4,6,14,0)');
      g.addColorStop(0.62, 'rgba(4,6,14,0.05)');
      g.addColorStop(1, 'rgba(4,6,14,0.82)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(rel.x, rel.y, b.R + 1 * px, 0, TAU); ctx.fill();
    } else {
      const dark = (1 - sunlight(up)) * 0.7;
      if (dark > 0.01) {
        ctx.beginPath(); arc(b.R + band * 0.1, a0, a1, N); closeDeep(); ctx.closePath();
        ctx.fillStyle = `rgba(4,6,14,${dark})`;
        ctx.fill();
      }
    }
  }

  // Stroke a polyline, changing colour along the way.
  function strokeRuns(pts, colorOf, width, cap = 'round') {
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = cap;
    let cur, start = 0;
    const flush = (end) => {
      ctx.beginPath();
      ctx.moveTo(pts[start].x, pts[start].y);
      for (let k = start + 1; k <= end; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.strokeStyle = cur;
      ctx.stroke();
    };
    for (let i = 0; i < pts.length; i++) {
      const col = colorOf(pts[i]);
      if (i === 0) { cur = col; continue; }
      if (col !== cur) { flush(i); start = i; cur = col; }
    }
    if (pts.length > 1) flush(pts.length - 1);
    ctx.lineCap = 'butt';
  }

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, ((n >> 16) & 255) * f), g = Math.min(255, ((n >> 8) & 255) * f), bl = Math.min(255, (n & 255) * f);
    return `rgb(${r | 0},${g | 0},${bl | 0})`;
  }

  // Launch pad, tower and a few buildings, drawn in the body's local frame.
  function drawSpaceCenter(cam, b, t, rel, px) {
    const lon = b.pad.lon;
    const ang = lon + FS.bodyRot(b, t);
    const base = { x: rel.x + Math.cos(ang) * (b.R + b.pad.height), y: rel.y + Math.sin(ang) * (b.R + b.pad.height) };
    ctx.save();
    ctx.translate(base.x, base.y);
    ctx.rotate(ang - Math.PI / 2); // local +y = up
    ctx.lineWidth = px;
    ctx.strokeStyle = 'rgba(15,18,24,0.7)';
    // pad slab
    ctx.fillStyle = '#6f7378';
    ctx.fillRect(-14, -3, 28, 3); ctx.strokeRect(-14, -3, 28, 3);
    ctx.fillStyle = '#4b4f55';
    ctx.fillRect(-4, -0.4, 8, 0.4);
    // tower (lattice)
    ctx.fillStyle = '#a33b2b';
    ctx.fillRect(7, 0, 2.6, 34);
    ctx.strokeStyle = 'rgba(40,10,5,0.8)';
    for (let y = 0; y < 34; y += 2.6) { ctx.beginPath(); ctx.moveTo(7, y); ctx.lineTo(9.6, y + 2.6); ctx.moveTo(9.6, y); ctx.lineTo(7, y + 2.6); ctx.stroke(); }
    ctx.fillStyle = '#d9d4c7'; ctx.fillRect(6.5, 34, 3.6, 2);
    // light on tower
    ctx.fillStyle = (t % 2) < 1 ? '#ff4a3a' : '#5a1a14'; ctx.fillRect(8, 36, 0.8, 0.8);
    // buildings
    const blds = [[-160, 46, 38, '#c9ccd1'], [-95, 22, 14, '#b4b9bf'], [-60, 12, 9, '#9da3aa'], [70, 30, 10, '#bfc3c8'], [110, 16, 22, '#aeb3b9']];
    for (const [x, w, h, col] of blds) {
      ctx.fillStyle = col; ctx.fillRect(x, -2, w, h + 2); ctx.strokeStyle = 'rgba(15,18,24,0.6)'; ctx.strokeRect(x, -2, w, h + 2);
      ctx.fillStyle = 'rgba(40,70,110,0.55)';
      for (let wy = 3; wy < h - 2; wy += 4) for (let wx = x + 2; wx < x + w - 3; wx += 4) ctx.fillRect(wx, wy, 2, 1.6);
    }
    // big hangar door
    ctx.fillStyle = '#2d4e7c'; ctx.fillRect(-150, -2, 18, 26);
    ctx.restore();
  }

  // ---- Vessel ----
  R.drawVessel = (cam, ves, t, opts = {}) => {
    const c = V.add(FS.bodyAbs(ves.body, t), ves.r);
    const sp = w2s(cam, c.x, c.y);
    const len = ves.layout.height * cam.s;
    setScreen();
    if (len < 6) {
      // too small to draw: draw a marker
      ctx.save();
      ctx.translate(sp.x, sp.y);
      const sa = -(ves.angle - cam.rot);
      ctx.rotate(sa);
      ctx.fillStyle = ves.isDebris ? 'rgba(200,200,200,0.6)' : '#ffd27a';
      ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, 4); ctx.lineTo(-2, 0); ctx.lineTo(-4, -4); ctx.closePath(); ctx.fill();
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.translate(sp.x, sp.y);
    const sigma = -(ves.angle - cam.rot);
    ctx.rotate(sigma + Math.PI / 2);
    ctx.scale(cam.s, cam.s);
    const px = 1 / cam.s;
    // parachute canopy
    const chutes = ves.parts.filter((p) => p.chute === 'semi' || p.chute === 'full');
    if (chutes.length) {
      const full = chutes.some((p) => p.chute === 'full');
      const top = -ves.layout.com;
      const dist = full ? 11 : 6;
      const cw = full ? 7.5 : 1.6;
      ctx.strokeStyle = 'rgba(230,230,230,0.8)';
      ctx.lineWidth = px;
      ctx.beginPath();
      ctx.moveTo(0, top); ctx.lineTo(-cw, top - dist);
      ctx.moveTo(0, top); ctx.lineTo(cw, top - dist);
      ctx.moveTo(0, top); ctx.lineTo(0, top - dist - cw * 0.3);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-cw, top - dist);
      ctx.quadraticCurveTo(-cw, top - dist - cw * 0.9, 0, top - dist - cw * 0.9);
      ctx.quadraticCurveTo(cw, top - dist - cw * 0.9, cw, top - dist);
      ctx.quadraticCurveTo(0, top - dist - cw * 0.25, -cw, top - dist);
      ctx.fillStyle = '#e8622a'; ctx.fill();
      ctx.fillStyle = '#f4efe6';
      ctx.beginPath();
      ctx.moveTo(-cw * 0.35, top - dist - cw * 0.12);
      ctx.quadraticCurveTo(-cw * 0.3, top - dist - cw * 0.85, 0, top - dist - cw * 0.88);
      ctx.quadraticCurveTo(cw * 0.3, top - dist - cw * 0.85, cw * 0.35, top - dist - cw * 0.12);
      ctx.closePath(); ctx.fill();
    }
    const glowMap = new Map();
    if (ves.nozzles) ves.nozzles.forEach((n) => glowMap.set(n.part, n.power));
    ves.parts.forEach((p, i) => {
      FS.drawPart(ctx, ves.parts, i, ves.layout.tops[i] - ves.layout.com, px, { glow: glowMap.get(p) || 0, showFuel: false });
    });
    ctx.restore();
  };

  // Reentry glow in front of the vessel.
  function drawReentry(cam, ves, t) {
    if (ves.heat <= 0.01) return;
    const b = ves.body;
    const vAir = V.sub(ves.v, FS.airVel(b, ves.r));
    const dir = V.norm(vAir);
    const c = V.add(FS.bodyAbs(b, t), ves.r);
    const lead = V.add(c, V.scale(dir, ves.layout.height * 0.45));
    const sp = w2s(cam, lead.x, lead.y);
    const sd = w2s(cam, lead.x - dir.x * 40, lead.y - dir.y * 40);
    setScreen();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const size = Math.max(14, ves.layout.height * cam.s * 0.9);
    ctx.globalAlpha = ves.heat * 0.9;
    ctx.drawImage(sprites.glow, sp.x - size, sp.y - size, size * 2, size * 2);
    // streaks
    ctx.strokeStyle = `rgba(255,170,90,${0.5 * ves.heat})`;
    ctx.lineWidth = 2;
    for (let k = -2; k <= 2; k++) {
      const off = k * size * 0.25;
      const nx = -(sd.y - sp.y), ny = sd.x - sp.x;
      const nl = Math.hypot(nx, ny) || 1;
      ctx.beginPath();
      ctx.moveTo(sp.x + (nx / nl) * off, sp.y + (ny / nl) * off);
      ctx.lineTo(sd.x + (nx / nl) * off * 3 + (Math.random() - 0.5) * 6, sd.y + (ny / nl) * off * 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- Particles ----
  // Stored relative to the body the active vessel is in.
  R.particles = [];
  R.clearParticles = () => (R.particles.length = 0);

  R.emitExhaust = (ves, dt, t) => {
    if (!ves.nozzles || !ves.nozzles.length) return;
    const b = ves.body;
    const p = FS.pressure(b, ves.altitude);
    const n = ves.nose;
    const side = V.perp(n);
    for (const nz of ves.nozzles) {
      const i = ves.parts.indexOf(nz.part);
      if (i < 0) continue;
      const d = nz.part.def;
      const along = ves.layout.tops[i] + d.len - ves.layout.com;
      const pos = V.sub(ves.r, V.scale(n, along));
      const power = nz.power;
      const count = Math.ceil(dt * 120 * power * (d.w > 2 ? 2 : 1));
      const spread = (1 - p) * 0.9 + 0.12;
      for (let k = 0; k < count; k++) {
        const sp = 40 + Math.random() * 40;
        const lat = (Math.random() - 0.5) * 2 * spread * sp * 0.6;
        const vel = V.add(ves.v, V.add(V.scale(n, -sp), V.scale(side, lat)));
        const jitter = Math.random() * dt;
        R.particles.push({
          x: pos.x + vel.x * jitter - ves.v.x * jitter, y: pos.y + vel.y * jitter - ves.v.y * jitter,
          vx: vel.x, vy: vel.y, life: 0, max: 0.25 + Math.random() * 0.35, size: d.w * (0.7 + Math.random() * 0.5),
          grow: 2.5 + (1 - p) * 4, kind: nz.solid ? 'flame' : (p < 0.05 ? 'blue' : 'flame'),
        });
        if (p > 0.02 && Math.random() < 0.55) {
          R.particles.push({
            x: pos.x, y: pos.y, vx: ves.v.x + (vel.x - ves.v.x) * 0.9 + (Math.random() - 0.5) * 6, vy: ves.v.y + (vel.y - ves.v.y) * 0.9 + (Math.random() - 0.5) * 6,
            life: 0, max: 1.0 + Math.random() * 1.8 * p, size: d.w * 1.1, grow: 3 + 6 * p, kind: 'smoke',
          });
        }
      }
    }
  };

  R.emitExplosion = (body, r, v, size = 4) => {
    for (let k = 0; k < 90; k++) {
      const a = Math.random() * TAU, s = Math.random() * 30 * Math.sqrt(size);
      R.particles.push({ x: r.x, y: r.y, vx: v.x + Math.cos(a) * s, vy: v.y + Math.sin(a) * s, life: 0, max: 0.4 + Math.random() * 0.9, size: size * (0.6 + Math.random()), grow: 6, kind: 'flame' });
    }
    for (let k = 0; k < 60; k++) {
      const a = Math.random() * TAU, s = Math.random() * 12 * Math.sqrt(size);
      R.particles.push({ x: r.x, y: r.y, vx: v.x + Math.cos(a) * s, vy: v.y + Math.sin(a) * s, life: 0, max: 2 + Math.random() * 4, size: size * 1.5, grow: 8, kind: 'smoke' });
    }
  };

  R.updateParticles = (dt, body, t) => {
    const P = R.particles;
    let w = 0;
    for (let i = 0; i < P.length; i++) {
      const q = P[i];
      q.life += dt;
      if (q.life > q.max) continue;
      const rr = q.x * q.x + q.y * q.y;
      const rl = Math.sqrt(rr);
      const alt = rl - body.R;
      const rho = FS.density(body, alt);
      const gk = -body.mu / (rr * rl);
      q.vx += q.x * gk * dt; q.vy += q.y * gk * dt;
      if (rho > 0) {
        const k = Math.min(1, rho * (q.kind === 'smoke' ? 2.2 : 1.6) * dt);
        const ax = -body.omega * q.y, ay = body.omega * q.x;
        q.vx += (ax - q.vx) * k; q.vy += (ay - q.vy) * k;
      }
      q.x += q.vx * dt; q.y += q.vy * dt;
      if (alt < body.terrain.amp * 2.5 && rl < body.R + FS.surfaceHeight(body, FS.lonAt(body, Math.atan2(q.y, q.x), t))) {
        // hit the ground: spread out sideways
        const up = { x: q.x / rl, y: q.y / rl };
        const ax = -body.omega * q.y, ay = body.omega * q.x; // ground velocity
        let rx = q.vx - ax, ry = q.vy - ay;
        const vn = rx * up.x + ry * up.y;
        if (vn < 0) {
          rx -= up.x * vn; ry -= up.y * vn;
          if (vn < -3) {
            // first hard impact: splash sideways, either way
            const side = Math.random() < 0.5 ? -1 : 1;
            rx += -up.y * side * -vn * 0.6; ry += up.x * side * -vn * 0.6;
          } else {
            const fr = Math.max(0, 1 - 1.5 * dt); // ground friction
            rx *= fr; ry *= fr;
          }
          q.vx = ax + rx; q.vy = ay + ry;
        }
        q.x += up.x * 0.3; q.y += up.y * 0.3;
      }
      P[w++] = q;
    }
    P.length = w;
    if (P.length > 6000) P.splice(0, P.length - 6000);
  };

  function drawParticles(cam, body, t) {
    const base = FS.bodyAbs(body, t);
    setScreen();
    ctx.save();
    // smoke first (normal blending), then flames (additive)
    for (const pass of ['smoke', 'fire']) {
      ctx.globalCompositeOperation = pass === 'fire' ? 'lighter' : 'source-over';
      for (const q of R.particles) {
        const isSmoke = q.kind === 'smoke';
        if ((pass === 'smoke') !== isSmoke) continue;
        const sp = w2s(cam, base.x + q.x, base.y + q.y);
        const f = q.life / q.max;
        const size = Math.max(1.5, (q.size + q.grow * q.life) * cam.s);
        if (sp.x < -size || sp.y < -size || sp.x > W + size || sp.y > H + size) continue;
        ctx.globalAlpha = isSmoke ? (1 - f) * 0.7 : (1 - f) * (1 - f);
        const spr = isSmoke ? sprites.smoke : q.kind === 'blue' ? sprites.blue : sprites.flame;
        ctx.drawImage(spr, sp.x - size, sp.y - size, size * 2, size * 2);
      }
    }
    ctx.restore();
  }

  // ---- Flight view ----
  R.drawFlight = (game) => {
    const ves = game.vessel;
    const t = game.t;
    const cam = game.cam;
    const b = ves.body;
    setScreen();
    // Sky
    const alt = ves.altitude;
    let skyT = 1, light = 1;
    const up = V.norm(ves.r);
    light = sunlight(up);
    if (b.atmo) skyT = FS.clamp(Math.pow(Math.max(alt, 0) / b.atmo.height, 0.55), 0, 1);
    const sunsetK = b.atmo ? (1 - skyT) * Math.exp(-Math.pow(V.dot(up, FS.SUN_DIR) / 0.18, 2)) : 0;
    const day = b.atmo ? (1 - skyT) * light : 0;
    const top = mix([6, 9, 20], [58, 118, 196], day);
    const bot = mix(mix([8, 12, 26], [140, 190, 236], day), [236, 132, 72], sunsetK * 0.8);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgb(top));
    g.addColorStop(1, rgb(bot));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    drawStars(cam, 1 - day * 1.15, true);

    // Bodies: farthest first
    const order = FS.bodies.slice().sort((a, c) => V.len(V.sub(FS.bodyAbs(c, t), cam)) - V.len(V.sub(FS.bodyAbs(a, t), cam)));
    for (const body of order) drawBody(cam, body, t, { minPx: 2 });

    // When the ground is out of view, a soft glow at the bottom shows where it is
    {
      const viewR = Math.hypot(W, H) / 2 / cam.s;
      if (ves.altitude - b.terrain.amp * 2.5 > viewR) {
        setScreen();
        const col = b.atmo ? b.atmo.color : [150, 150, 150];
        const k = FS.clamp(1.2 - Math.log10(ves.altitude / viewR) * 0.25, 0.25, 1);
        const gg = ctx.createLinearGradient(0, H, 0, H * 0.55);
        gg.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${0.28 * k})`);
        gg.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
        ctx.fillStyle = gg;
        ctx.fillRect(0, H * 0.55, W, H * 0.45);
      }
    }

    // Night darkening of the near surface
    if (b.atmo && light < 1 && alt < b.atmo.height * 2) {
      setScreen();
      ctx.fillStyle = `rgba(3,5,14,${(1 - light) * 0.55 * (1 - skyT * 0.6)})`;
      ctx.fillRect(0, 0, W, H);
    }

    drawParticles(cam, b, t);
    for (const d of game.debris) if (!d.dead) R.drawVessel(cam, d, t);
    if (!ves.dead) {
      R.drawVessel(cam, ves, t);
      drawReentry(cam, ves, t);
    }
  };

  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rgb(c) { return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; }

  // ---- Map view ----
  const PATCH_COLORS = ['#55d6ff', '#ffb547', '#ff6fb1'];

  R.drawMap = (game) => {
    const t = game.t;
    const cam = game.mapCam;
    setScreen();
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, W, H);
    drawStars(cam, 0.8, false);

    // Orbits and SOIs of bodies
    for (const b of FS.bodies) {
      if (!b.parent) continue;
      const pc = FS.bodyAbs(b.parent, t);
      const sp = w2s(cam, pc.x, pc.y);
      ctx.strokeStyle = 'rgba(150,170,210,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(sp.x, sp.y, b.a * cam.s, 0, TAU); ctx.stroke();
      const bc = FS.bodyAbs(b, t);
      const bs = w2s(cam, bc.x, bc.y);
      if (b.soi * cam.s > 6) {
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = 'rgba(150,170,210,0.28)';
        ctx.beginPath(); ctx.arc(bs.x, bs.y, b.soi * cam.s, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    for (const b of FS.bodies) drawBody(cam, b, t, { minPx: 3.5 });
    // Labels
    setScreen();
    ctx.font = '600 12px "Saira Semi Condensed", "Arial Narrow", sans-serif';
    ctx.textAlign = 'center';
    for (const b of FS.bodies) {
      const bc = FS.bodyAbs(b, t);
      const bs = w2s(cam, bc.x, bc.y);
      ctx.fillStyle = 'rgba(214,224,245,0.85)';
      ctx.fillText(b.name.toUpperCase(), bs.x, bs.y + Math.max(b.R * cam.s, 4) + 16);
    }

    const ves = game.vessel;
    if (!ves.dead && !ves.landed) {
      drawPatches(cam, game.patches, t, false);
      if (game.node && game.nodePatches) drawPatches(cam, game.nodePatches, t, true);
    }
    // Node marker
    if (game.node) {
      const nd = game.node;
      const p = V.add(FS.bodyAbs(nd.body, t), nd.r);
      const s = w2s(cam, p.x, p.y);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#4f8dff'; ctx.strokeStyle = '#d8e6ff'; ctx.lineWidth = 1.5;
      ctx.fillRect(-6, -6, 12, 12); ctx.strokeRect(-6, -6, 12, 12);
      ctx.restore();
    }
    // Vessel
    if (!ves.dead) {
      const vp = V.add(FS.bodyAbs(ves.body, t), ves.r);
      const s = w2s(cam, vp.x, vp.y);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(-ves.angle);
      ctx.fillStyle = '#ffd27a'; ctx.strokeStyle = '#1a1405'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, 5.5); ctx.lineTo(-3, 0); ctx.lineTo(-6, -5.5); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  };

  function drawPatches(cam, patches, t, planned) {
    if (!patches) return;
    patches.forEach((pt, i) => {
      const o = pt.orbit;
      // Frame: the current SOI body is drawn where it is now; later patches
      // are drawn around where their body will be when the patch starts.
      const tRef = i === 0 ? t : pt.tStart;
      const origin = FS.bodyAbs(pt.body, tRef);
      const t0 = Math.max(pt.tStart, i === 0 ? t : pt.tStart);
      const pts = FS.sampleOrbit(o, t0, pt.tEnd, 360);
      ctx.strokeStyle = PATCH_COLORS[i % PATCH_COLORS.length];
      ctx.lineWidth = planned ? 1.6 : 2;
      ctx.globalAlpha = planned ? 0.85 : 1;
      if (planned) ctx.setLineDash([7, 5]);
      ctx.beginPath();
      pts.forEach((p, k) => {
        const s = w2s(cam, origin.x + p.x, origin.y + p.y);
        k ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // ghost body at encounter
      if (i > 0 && pt.body.parent) {
        const s = w2s(cam, origin.x, origin.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(pt.body.R * cam.s, 4), 0, TAU); ctx.stroke();
      }
      if (planned) return;
      // Ap / Pe markers
      const b = pt.body;
      const mark = (nu, label, value) => {
        const dtTo = FS.timeToNu(o, nu, t0);
        if (!isFinite(dtTo) || t0 + dtTo > pt.tEnd) return;
        const st = FS.orbitState(o, t0 + dtTo);
        const s = w2s(cam, origin.x + st.r.x, origin.y + st.r.y);
        marker(s, label, FS.fmtDist(value));
      };
      if (o.e > 1e-4) {
        if (o.e < 1) mark(Math.PI, 'Ap', o.ap - b.R);
        if (o.pe > b.R * 0.2) mark(0, 'Pe', o.pe - b.R);
      }
      const end = pts[pts.length - 1];
      if (pt.end && end) {
        const s = w2s(cam, origin.x + end.x, origin.y + end.y);
        const lbl = pt.end === 'encounter' ? pt.next.name + ' encounter' : pt.end === 'escape' ? 'Escape' : 'Impact';
        marker(s, lbl, FS.fmtTime(pt.tEnd - t), pt.end === 'impact' ? '#ff6b5a' : '#c7d6ff');
      }
    });
  }

  function marker(s, label, value, col = '#ffe2a6') {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(s.x, s.y, 3.5, 0, TAU); ctx.fill();
    ctx.font = '600 11px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(5,7,15,0.7)';
    const txt = label + '  ' + value;
    const w = ctx.measureText(txt).width;
    ctx.fillRect(s.x + 7, s.y - 16, w + 8, 16);
    ctx.fillStyle = col;
    ctx.fillText(txt, s.x + 11, s.y - 4);
  }
})();
