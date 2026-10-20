// render-gl.js — the WebGL2 renderer (step B1). Same interface as render.js (see there);
// main.js picks this one when the browser has WebGL2 and falls back to the Canvas 2D one
// otherwise.
//
// One pixel grid for the whole world. Everything in the world is drawn in "art pixels"
// whose size in metres is (1/16) × 2^k: at the closest zoom 16 per metre, as the art is
// authored, then 8, 4, 2… as you zoom out, so an art pixel never gets smaller than the
// chosen pixel size on screen (1.5–3 CSS pixels, a setting). Parts, terrain, planets and
// particles all use the same k, so pixels of different sizes never sit side by side.
//
// What's drawn how:
//  - sky: a full-screen shader, palette bands with ordered dithering, plus pixel stars;
//  - bodies: a full-screen shader per body that works out, for each art pixel, whether it
//    is ocean, ground (with surface, soil and rock layers), atmosphere rim or nothing, and
//    shades it by sunlight with dithered steps; terrain heights come from a texture;
//  - parts, parachutes and the space centre: the prototype's vector drawings, baked into
//    palette pixel art at the current pixel size (temporary art until B2 and B3);
//  - particles: pixel puffs coloured from palette ramps, fading by dither;
//  - orbit lines, markers and labels: an overlay canvas on top.
(function () {
  const V = FS.vec;
  const TAU = FS.TAU;
  const P = FS.Palette;
  const R = (FS.RenderGL = {});

  let gl, cv, overlay, octx, sprites, sky, planet;
  let W = 0, H = 0, DPR = 1;
  let game = null;
  const stars = [];
  const heightTex = new Map(); // body → full-circle height texture
  let windowTex = null;        // heights around the camera, refreshed every frame
  const N_FULL = 4096, N_WIN = 1024;
  let pixelSize = 1.5;         // smallest art pixel on screen, CSS px (setting)
  let frameInfo = { level: 0, draws: 0 };

  R.setPixelSize = (n) => { pixelSize = FS.clamp(n, 1, 3); };
  R.pixelSize = () => pixelSize;

  // ---------- Set-up ----------
  R.init = (canvas, g) => {
    cv = canvas;
    game = g;
    gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available');
    overlay = document.createElement('canvas');
    overlay.className = 'view-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    canvas.after(overlay);
    octx = overlay.getContext('2d');
    sprites = new FS.GL.Sprites(gl, Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE)));
    sky = FS.GL.fullscreen(gl, SKY_FS);
    planet = FS.GL.fullscreen(gl, PLANET_FS);
    windowTex = makeHeightTexture(N_WIN);
    const rnd = FS.rng(4242);
    const starCols = [P.ramps.metal[7], P.ramps.metal[7], P.ramps.blue[7], P.ramps.blue[6], P.ramps.gold[4], P.ramps.dusk[4]];
    for (let i = 0; i < 700; i++) {
      const a = rnd() * TAU, d = Math.sqrt(rnd());
      stars.push({
        x: Math.cos(a) * d, y: Math.sin(a) * d,
        big: rnd() < 0.06,
        b: 0.3 + rnd() * 0.7,
        c: starCols[Math.floor(rnd() * starCols.length)].map((v) => v / 255),
        tw: rnd() < 0.05 ? rnd() * TAU : null, // a few twinkle
      });
    }
    if (FS.Render.subscribe && g) FS.Render.subscribe(g);
    R.resize();
  };

  R.resize = () => {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    overlay.width = cv.width; overlay.height = cv.height;
  };
  R.size = () => ({ W, H });

  // Particles are simulated by the shared code in render.js; only drawing differs.
  R.update = (g) => FS.Render.update(g);
  R.stats = () => ({ particles: FS.Render.particles.length, level: frameInfo.level, draws: frameInfo.draws, atlas: sprites ? Math.round(sprites.atlas.used() * 100) + '%' : '' });

  // ---------- Camera ----------
  function w2s(cam, x, y) {
    const dx = x - cam.x, dy = y - cam.y;
    const c = Math.cos(cam.rot), s = Math.sin(cam.rot);
    return { x: W / 2 + (dx * c + dy * s) * cam.s, y: H / 2 - (-dx * s + dy * c) * cam.s };
  }
  R.worldToScreen = w2s;

  // The art-pixel level for a zoom: art pixels are (1/16)·2^k metres.
  function levelFor(camS) {
    let k = 0;
    while (k < 60 && (camS * Math.pow(2, k)) / 16 < pixelSize) k++;
    return k;
  }

  // ---------- Sky ----------
  const SKY_FS = `#version 300 es
    precision highp float;
    uniform vec2 uRes;
    uniform float uPix;
    uniform vec3 uSky[8];
    uniform int uSkyN;
    uniform float uGal;
    uniform float uGalAng;
    uniform vec3 uGalCol[2];
    out vec4 o;
    ${FS.GL.GLSL_BAYER}
    float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
    float vnoise(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash(i), hash(i + 1.0), f); }
    void main() {
      vec2 cell = floor(vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uPix);
      vec2 mid = (cell + 0.5) * uPix;
      float t = clamp(mid.y / uRes.y, 0.0, 1.0);
      float f = t * float(uSkyN - 1);
      int i = int(floor(f));
      vec3 c = (stepUp(fract(f), cell) && i + 1 < uSkyN) ? uSky[i + 1] : uSky[i];
      if (uGal > 0.0) {
        vec2 p = (mid - uRes * 0.5) / uRes.y;
        vec2 n = vec2(-sin(uGalAng), cos(uGalAng));
        float v = dot(p, n), s = dot(p, vec2(n.y, -n.x));
        float dens = exp(-v * v / 0.012) * (0.45 + 0.55 * vnoise(s * 7.0 + 3.0)) * (0.6 + 0.4 * vnoise(s * 23.0 + v * 9.0));
        float a = dens * uGal;
        if (a > bayer4(cell) * 1.4) c = a > 0.55 ? uGalCol[1] : uGalCol[0];
      }
      o = vec4(c, 1.0);
    }`;

  // Snap a smooth top-to-bottom gradient to palette colours (the shader dithers between them).
  function skyStops(top, bot) {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const k = i / 6;
      const c = P.nearest(top[0] + (bot[0] - top[0]) * k, top[1] + (bot[1] - top[1]) * k, top[2] + (bot[2] - top[2]) * k);
      if (!out.length || out[out.length - 1] !== c) out.push(c);
    }
    return out;
  }

  function drawSky(stops, gal, galAng) {
    gl.useProgram(sky.p);
    gl.uniform2f(sky.u.uRes, cv.width, cv.height);
    gl.uniform1f(sky.u.uPix, Math.max(1, pixelSize * DPR));
    FS.GL.rampUniform(gl, sky.u.uSky, stops, 8);
    gl.uniform1i(sky.u.uSkyN, stops.length);
    gl.uniform1f(sky.u.uGal, gal);
    gl.uniform1f(sky.u.uGalAng, galAng);
    FS.GL.rampUniform(gl, sky.u.uGalCol, [P.ramps.night[2], P.ramps.night[3]], 2);
    gl.disable(gl.BLEND);
    sky.draw();
  }

  // Pixel stars: one or two art pixels each, turning with the camera.
  function drawStars(cam, alpha, rotate, t) {
    if (alpha <= 0.02) return;
    const rad = Math.hypot(W, H) * 0.55;
    const rot = rotate ? cam.rot : 0;
    const c = Math.cos(-rot), s = Math.sin(-rot);
    const px = Math.max(1, pixelSize) * DPR;
    for (const st of stars) {
      const x = W / 2 + (st.x * c - st.y * s) * rad, y = H / 2 + (st.x * s + st.y * c) * rad;
      if (x < -4 || y < -4 || x > W + 4 || y > H + 4) continue;
      let a = st.b * alpha;
      if (st.tw !== null) a *= Math.sin(t * 2.3 + st.tw) > 0.3 ? 1 : 0.45;
      block(x * DPR, y * DPR, st.big ? px * 2 : px, st.big ? px * 2 : px, -rot, [st.c[0], st.c[1], st.c[2], a]);
    }
  }

  // A solid rectangle w × h device px centred at (x, y), turned by angle, with crisp edges.
  function block(x, y, w, h, angle, tint) {
    const e = sprites.white();
    const c = Math.cos(angle), s = Math.sin(angle);
    // the quad reaches 1 texel into the clear padding on every side, so the edges are smoothed
    const hw = (w / 2) * 1.5, hh = (h / 2) * 1.5;
    const at = (dx, dy) => ({ x: x + dx * c - dy * s, y: y + dx * s + dy * c });
    sprites.quad(at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh), e, tint, -1, -1, 5, 5);
  }

  // ---------- Bodies ----------
  // Heights as a 1-pixel-high float texture (read with texelFetch, interpolated by hand).
  function makeHeightTexture(n) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, n, 1, 0, gl.RED, gl.FLOAT, null);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
    return { tex, n, data: new Float32Array(n) };
  }
  function uploadHeights(h) {
    gl.bindTexture(gl.TEXTURE_2D, h.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, h.n, 1, gl.RED, gl.FLOAT, h.data);
  }
  function fullHeights(b) {
    let h = heightTex.get(b);
    if (!h) {
      h = makeHeightTexture(N_FULL);
      for (let i = 0; i < N_FULL; i++) h.data[i] = FS.terrainHeight(b, (i / N_FULL) * TAU);
      uploadHeights(h);
      heightTex.set(b, h);
    }
    return h;
  }

  // Colour ramps for each body's materials (5 entries each, dark to light).
  const hex = (list) => list.map((x) => P.nearest(parseInt(x.slice(1, 3), 16), parseInt(x.slice(3, 5), 16), parseInt(x.slice(5, 7), 16)));
  const pick = (ramp, ...idx) => idx.map((i) => ramp[i]);
  const MATERIALS = {
    Aster: () => ({
      land: pick(P.ramps.green, 0, 1, 2, 3, 4),
      sand: pick(P.ramps.earth, 2, 3, 4, 5, 6),
      rock: pick(P.ramps.metal, 1, 2, 3, 4, 5),
      snow: [P.ramps.metal[3], P.ramps.blue[5], P.ramps.blue[6], P.ramps.metal[7], P.ramps.blue[7]],
      soil: pick(P.ramps.earth, 0, 1, 2, 3, 4),
      strA: pick(P.ramps.earth, 0, 1, 2, 3, 4),
      strB: [P.ramps.earth[0], P.ramps.metal[1], P.ramps.earth[1], P.ramps.metal[2], P.ramps.earth[2]],
      deep: [P.ramps.night[1], P.ramps.blue[0], P.ramps.blue[1], P.ramps.blue[2], P.ramps.blue[3]],
      ocean: pick(P.ramps.blue, 0, 1, 2, 3, 4, 5),
      atmo: pick(P.ramps.blue, 3, 4, 5, 6, 7),
    }),
    Mira: () => ({
      land: pick(P.ramps.metal, 1, 2, 3, 4, 5),
      sand: pick(P.ramps.metal, 1, 2, 3, 4, 5),
      rock: pick(P.ramps.metal, 2, 3, 4, 5, 6),
      snow: pick(P.ramps.metal, 2, 3, 4, 5, 6),
      soil: pick(P.ramps.metal, 0, 1, 2, 3, 4),
      strA: pick(P.ramps.metal, 0, 1, 2, 3, 4),
      strB: [P.ramps.night[1], P.ramps.night[2], P.ramps.metal[1], P.ramps.metal[2], P.ramps.metal[3]],
      deep: [P.ramps.night[0], P.ramps.metal[0], P.ramps.metal[1], P.ramps.metal[2], P.ramps.metal[3]],
      ocean: pick(P.ramps.blue, 0, 1, 2, 3, 4, 5),
      atmo: pick(P.ramps.metal, 3, 4, 5, 6, 7),
    }),
    Pell: () => ({
      land: [P.ramps.teal[0], P.ramps.teal[1], P.ramps.teal[2], P.ramps.teal[3], P.ramps.metal[7]],
      sand: [P.ramps.teal[0], P.ramps.teal[1], P.ramps.teal[2], P.ramps.teal[3], P.ramps.metal[7]],
      rock: [P.ramps.night[2], P.ramps.teal[0], P.ramps.teal[1], P.ramps.teal[2], P.ramps.teal[3]],
      snow: [P.ramps.teal[1], P.ramps.teal[2], P.ramps.teal[3], P.ramps.blue[6], P.ramps.metal[7]],
      soil: [P.ramps.night[1], P.ramps.night[2], P.ramps.teal[0], P.ramps.teal[1], P.ramps.teal[2]],
      strA: [P.ramps.night[1], P.ramps.night[2], P.ramps.teal[0], P.ramps.teal[1], P.ramps.teal[2]],
      strB: [P.ramps.night[0], P.ramps.metal[1], P.ramps.metal[2], P.ramps.teal[0], P.ramps.teal[1]],
      deep: [P.ramps.night[0], P.ramps.night[1], P.ramps.night[2], P.ramps.teal[0], P.ramps.teal[1]],
      ocean: pick(P.ramps.blue, 0, 1, 2, 3, 4, 5),
      atmo: pick(P.ramps.teal, 0, 1, 2, 3, 3),
    }),
  };
  const matCache = new Map();
  const materials = (b) => {
    if (!matCache.has(b)) matCache.set(b, (MATERIALS[b.name] || MATERIALS.Mira)());
    return matCache.get(b);
  };

  const PLANET_FS = `#version 300 es
    precision highp float;
    uniform vec2 uRes;        // device px
    uniform float uCamS;      // device px per metre
    uniform float uCamRot;
    uniform float uCell;      // art pixel, metres
    uniform int uMode;        // 0: whole body (cells in the body's turning frame), 1: close to the ground
    uniform vec2 uC;          // body centre relative to the camera (mode 0)
    uniform float uBodyRot;
    uniform vec2 uUp;         // mode 1: up at the camera
    uniform float uAltCam;    // mode 1: camera height above datum
    uniform float uRc;        // mode 1: camera distance from the centre
    uniform float uU0;        // mode 1: the camera's position along the ground (wrapped)
    uniform float uLonCam;    // mode 1: body-fixed longitude under the camera
    uniform float uSpan;      // mode 1: the height window covers ±uSpan radians
    uniform sampler2D uH;
    uniform int uHN;
    uniform float uR;
    uniform float uAtmoH;
    uniform int uOcean;
    uniform float uSnowH, uRockH, uAmp;
    uniform vec2 uSun;
    uniform float uRim;       // draw the atmosphere rim (1) or not (0)
    uniform vec3 uLand[5], uSand[5], uRock[5], uSnow[5], uSoil[5], uStrA[5], uStrB[5], uDeep[5], uOceanR[6], uAtmo[5];
    out vec4 o;
    ${FS.GL.GLSL_BAYER}
    float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }

    float heightAt(float x) { // x in texels, wraps
      float n = float(uHN);
      x = mod(x, n);
      float i = floor(x);
      int a = int(i), b = int(mod(i + 1.0, n));
      return mix(texelFetch(uH, ivec2(a, 0), 0).r, texelFetch(uH, ivec2(b, 0), 0).r, x - i);
    }
    vec2 gCell;
    vec3 ramp5(vec3 r[5], float t, float th) {
      float f = clamp(t, 0.0, 1.0) * 4.0;
      int i = int(floor(f));
      return (stepUp(fract(f), gCell) && i < 4) ? r[i + 1] : r[i];
    }
    vec3 ramp6(vec3 r[6], float t, float th) {
      float f = clamp(t, 0.0, 1.0) * 5.0;
      int i = int(floor(f));
      return (stepUp(fract(f), gCell) && i < 5) ? r[i + 1] : r[i];
    }

    void main() {
      // screen → metres from the camera, in the world frame
      vec2 sp = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
      vec2 rr = vec2(sp.x - uRes.x * 0.5, -(sp.y - uRes.y * 0.5)) / uCamS;
      float c = cos(uCamRot), s = sin(uCamRot);
      vec2 d = vec2(rr.x * c - rr.y * s, rr.x * s + rr.y * c);

      float alt, h, u, light;
      vec2 cell;
      if (uMode == 0) {
        vec2 p = d - uC;
        float cb = cos(-uBodyRot), sb = sin(-uBodyRot);
        vec2 pb = vec2(p.x * cb - p.y * sb, p.x * sb + p.y * cb);
        cell = floor(pb / uCell);
        vec2 pc = (cell + 0.5) * uCell;
        float r = length(pc);
        alt = r - uR;
        if (alt > uAtmoH * 1.4 + uAmp * 1.5 + uCell * 2.0) discard;
        float lon = atan(pc.y, pc.x);
        h = heightAt(lon / 6.28318530718 * float(uHN));
        u = lon * uR;
        float ca = cos(uBodyRot), sa = sin(uBodyRot);
        vec2 nw = vec2(pc.x * ca - pc.y * sa, pc.x * sa + pc.y * ca) / r;
        light = dot(nw, uSun);
      } else {
        vec2 tang = vec2(-uUp.y, uUp.x);
        float du = dot(d, uUp), dt = dot(d, tang);
        float a = uAltCam + du + dt * dt / (2.0 * (uRc + du));
        float ang = atan(dt, uRc + du);
        float uu = uU0 + ang * uR;
        cell = vec2(floor(uu / uCell), floor(a / uCell));
        alt = (cell.y + 0.5) * uCell;
        float angC = ((cell.x + 0.5) * uCell - uU0) / uR;
        if (alt > uAmp * 1.5 + 10.0) discard;
        h = heightAt((angC / uSpan * 0.5 + 0.5) * float(uHN - 1));
        u = (uLonCam + angC) * uR;
        float ca = cos(angC), sa = sin(angC);
        vec2 nw = vec2(uUp.x * ca - uUp.y * sa, uUp.x * sa + uUp.y * ca);
        light = dot(nw, uSun);
      }
      float th = bayer4(cell);
      gCell = cell;
      float lit = smoothstep(-0.12, 0.25, light);      // 0 night … 1 day
      float shadeT = 0.12 + 0.62 * lit;                // position on a ramp

      vec3 col;
      // from afar, oceans cover the band where the sea floor would show
      bool farSea = uMode == 0 && uOcean == 1 && h < 0.0 && alt < 0.0 && -alt < max(uR * 0.035, uCell * 6.0);
      if (alt > h || farSea) {
        if (uOcean == 1 && alt < 0.0) {
          // water: lighter near the surface, a foam line on top
          float depth = -alt;
          float k = clamp(depth / max(80.0, uCell * 10.0), 0.0, 1.0);
          float t = (1.0 - k) * (0.25 + 0.6 * lit);
          if (depth < uCell * 1.01 && lit > 0.2) t = 0.95;
          col = ramp6(uOceanR, t, th);
        } else if (uMode == 0 && uRim > 0.5 && uAtmoH > 0.0) {
          // atmosphere rim: thins out with height, dimmer on the night side
          float above = alt - max(h, 0.0);
          float dens = exp(-above / (uAtmoH * 0.3));
          float cover = dens * (0.18 + 0.82 * smoothstep(-0.35, 0.3, light));
          if (cover * 0.95 <= th) discard;
          col = ramp5(uAtmo, dens * (0.35 + 0.65 * lit), th);
        } else discard;
      } else {
        float depth = h - alt;
        float wob = (3.0 * sin(u * 0.004) + 1.5 * sin(u * 0.017 + 1.0)) * max(1.0, uCell);
        float top = max(0.6, uCell * 1.5);
        float soil = max(5.0, uCell * 4.0);
        if (uMode == 0) { top = max(top, uR * 0.012); soil = max(soil, uR * 0.022); }
        float bands = max(7.0, uCell * 3.0);
        if (uMode == 0 && depth > max(uR * 0.035, uCell * 6.0)) {
          // the body's interior seen from afar
          col = ramp5(uDeep, 0.15 + 0.55 * lit, th);
        } else if (depth < top) {
          float tuft = hash(floor(u / uCell)) > 0.72 && depth < uCell * 1.01 ? 0.18 : 0.0;
          if (uOcean == 1 && h < 40.0) col = ramp5(uSand, shadeT + tuft, th);
          else if (h > uSnowH) col = ramp5(uSnow, shadeT + 0.15 + tuft, th);
          else if (h > uRockH) col = ramp5(uRock, shadeT + tuft, th);
          else col = ramp5(uLand, shadeT + tuft, th);
        } else if (depth < soil + wob * 0.3) {
          col = ramp5(uSoil, shadeT * 0.9, th);
        } else {
          float band = floor((depth + wob) / bands);
          col = mod(band, 2.0) < 1.0 ? ramp5(uStrA, shadeT * 0.85, th) : ramp5(uStrB, shadeT * 0.85, th);
        }
      }
      o = vec4(col, 1.0);
    }`;

  // Draw one body. Returns whether its surface is visible.
  function drawBody(cam, b, t, k) {
    const cell = Math.pow(2, k) / 16;
    const c = FS.bodyAbs(b, t);
    const rel = { x: c.x - cam.x, y: c.y - cam.y };
    const dist = Math.hypot(rel.x, rel.y);
    const viewR = Math.hypot(W, H) / 2 / cam.s;
    const atmoH = b.atmo ? b.atmo.height : 0;
    const reach = b.R + Math.max(atmoH * 1.4, b.terrain.amp * 1.5);
    if (dist - reach > viewR) return false;
    // tiny: a dot of a few art pixels
    if (b.R * cam.s < 2.5) {
      const sp = w2s(cam, c.x, c.y);
      const col = P.nearest(...hex([b.colors.disc])[0]).map((v) => v / 255);
      sprites.begin(cv.width, cv.height);
      const sz = Math.max(2.5, b.R * cam.s) * 2 * DPR;
      block(sp.x * DPR, sp.y * DPR, sz, sz, 0, [col[0], col[1], col[2], 1]);
      sprites.flush();
      return false;
    }
    const near = cam.body === b && viewR < b.R * 0.3 && dist - b.R < viewR * 4 + b.terrain.amp * 2;
    const m = materials(b);
    const u = planet.u;
    gl.useProgram(planet.p);
    gl.uniform2f(u.uRes, cv.width, cv.height);
    gl.uniform1f(u.uCamS, cam.s * DPR);
    gl.uniform1f(u.uCamRot, cam.rot);
    gl.uniform1f(u.uCell, cell);
    gl.uniform1f(u.uBodyRot, FS.bodyRot(b, t));
    gl.uniform1f(u.uR, b.R);
    gl.uniform1f(u.uAtmoH, atmoH);
    gl.uniform1i(u.uOcean, b.ocean ? 1 : 0);
    gl.uniform1f(u.uSnowH, b.ocean ? 2550 : 1e9);
    gl.uniform1f(u.uRockH, b.ocean ? 1900 : b.terrain.amp * 0.6);
    gl.uniform1f(u.uAmp, b.terrain.amp);
    gl.uniform2f(u.uSun, FS.SUN_DIR.x, FS.SUN_DIR.y);
    gl.uniform1f(u.uRim, near ? 0 : 1);
    const ramps = { uLand: m.land, uSand: m.sand, uRock: m.rock, uSnow: m.snow, uSoil: m.soil, uStrA: m.strA, uStrB: m.strB, uDeep: m.deep, uAtmo: m.atmo };
    for (const [name, r] of Object.entries(ramps)) FS.GL.rampUniform(gl, u[name], r, 5);
    FS.GL.rampUniform(gl, u.uOceanR, m.ocean, 6);
    let hTex;
    if (near) {
      // close to the ground: work in the frame of the ground under the camera
      const up = { x: -rel.x / dist, y: -rel.y / dist };
      const ang = Math.atan2(up.y, up.x);
      const lonCam = FS.wrapAngle(ang - FS.bodyRot(b, t));
      const span = Math.min(Math.PI, (viewR * 1.6) / b.R);
      const period = cell * 65536;
      const u0 = (((lonCam * b.R) % period) + period) % period;
      for (let i = 0; i < N_WIN; i++) windowTex.data[i] = FS.terrainHeight(b, lonCam - span + (2 * span * i) / (N_WIN - 1));
      uploadHeights(windowTex);
      hTex = windowTex;
      gl.uniform1i(u.uMode, 1);
      gl.uniform2f(u.uUp, up.x, up.y);
      gl.uniform1f(u.uAltCam, dist - b.R);
      gl.uniform1f(u.uRc, dist);
      gl.uniform1f(u.uU0, u0);
      gl.uniform1f(u.uLonCam, lonCam);
      gl.uniform1f(u.uSpan, span);
    } else {
      hTex = fullHeights(b);
      gl.uniform1i(u.uMode, 0);
      gl.uniform2f(u.uC, rel.x, rel.y);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, hTex.tex);
    gl.uniform1i(u.uH, 1);
    gl.uniform1i(u.uHN, hTex.n);
    // only shade the pixels the body can cover
    const sp = w2s(cam, c.x, c.y);
    const rpx = reach * cam.s;
    const x0 = FS.clamp(sp.x - rpx, 0, W), x1 = FS.clamp(sp.x + rpx, 0, W);
    const y0 = FS.clamp(sp.y - rpx, 0, H), y1 = FS.clamp(sp.y + rpx, 0, H);
    if (x1 <= x0 || y1 <= y0) return false;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.floor(x0 * DPR), Math.floor((H - y1) * DPR), Math.ceil((x1 - x0) * DPR) + 1, Math.ceil((y1 - y0) * DPR) + 1);
    gl.disable(gl.BLEND);
    planet.draw();
    gl.disable(gl.SCISSOR_TEST);
    return near;
  }

  // ---------- Baked sprites (temporary art) ----------
  // Parts: the vector drawing from parts.js at L art pixels per metre, snapped to the palette.
  function partSprite(p, L, glow) {
    const d = p.def;
    const w = p.w || (d.w === 'auto' ? 1.25 : d.w);
    const tw = p.tw || d.topW || w;
    const len = p.len || d.len;
    const key = `p|${d.id}|${w}|${tw}|${len}|${p.skin || ''}|${glow}|${L}`;
    let s = sprites.atlas.get(key);
    if (s) return s;
    const halfW = Math.max(w, tw) / 2 + (d.fin ? 0.9 : 0.1);
    const hx = Math.ceil(halfW * L), top = Math.ceil(0.6 * L);
    const cw = hx * 2, ch = top + Math.ceil((len + 0.3) * L);
    const img = FS.GL.bake(cw, ch, (g) => {
      g.setTransform(L, 0, 0, L, hx, top);
      FS.drawPart(g, p, 0, 1 / L, { glow });
    });
    s = sprites.atlas.add(key, img);
    if (s) { s.ox = hx; s.oy = top + (len / 2) * L; }
    return s;
  }

  // Parachute canopies, in the drawing frame of drawVessel in render.js.
  function chuteSprite(full, L) {
    const key = `chute|${full ? 1 : 0}|${L}`;
    let s = sprites.atlas.get(key);
    if (s) return s;
    const dist = full ? 11 : 6, cw = full ? 7.5 : 1.6;
    const hx = Math.ceil((cw + 0.5) * L), up = Math.ceil((dist + cw + 0.5) * L), down = Math.ceil(0.5 * L);
    const img = FS.GL.bake(hx * 2, up + down, (g) => {
      g.setTransform(L, 0, 0, L, hx, up);
      const px = 1 / L;
      g.strokeStyle = '#e8e4da';
      g.lineWidth = px * 1.2;
      g.beginPath();
      g.moveTo(0, 0); g.lineTo(-cw, -dist);
      g.moveTo(0, 0); g.lineTo(cw, -dist);
      g.moveTo(0, 0); g.lineTo(0, -dist - cw * 0.3);
      g.stroke();
      g.beginPath();
      g.moveTo(-cw, -dist);
      g.quadraticCurveTo(-cw, -dist - cw * 0.9, 0, -dist - cw * 0.9);
      g.quadraticCurveTo(cw, -dist - cw * 0.9, cw, -dist);
      g.quadraticCurveTo(0, -dist - cw * 0.25, -cw, -dist);
      g.fillStyle = '#e8622a'; g.fill();
      g.fillStyle = '#f4efe6';
      g.beginPath();
      g.moveTo(-cw * 0.35, -dist - cw * 0.12);
      g.quadraticCurveTo(-cw * 0.3, -dist - cw * 0.85, 0, -dist - cw * 0.88);
      g.quadraticCurveTo(cw * 0.3, -dist - cw * 0.85, cw * 0.35, -dist - cw * 0.12);
      g.closePath(); g.fill();
    }, 0.3);
    s = sprites.atlas.add(key, img);
    if (s) { s.ox = hx; s.oy = up; }
    return s;
  }

  // The launch site, baked in 32 m wide tiles (only the visible ones), in the pad's frame
  // (x along the ground, y up). Same drawing as render.js.
  const SC_X0 = -164, SC_X1 = 132, SC_TILE = 32, SC_Y0 = -4, SC_Y1 = 41;
  function drawSpaceCenterVector(g, t) {
    const px = g.__px;
    g.lineWidth = px;
    g.strokeStyle = 'rgba(15,18,24,0.7)';
    g.fillStyle = '#6f7378';
    g.fillRect(-14, -3, 28, 3); g.strokeRect(-14, -3, 28, 3);
    g.fillStyle = '#4b4f55';
    g.fillRect(-4, -0.4, 8, 0.4);
    g.fillStyle = '#a33b2b';
    g.fillRect(7, 0, 2.6, 34);
    g.strokeStyle = 'rgba(40,10,5,0.8)';
    for (let y = 0; y < 34; y += 2.6) { g.beginPath(); g.moveTo(7, y); g.lineTo(9.6, y + 2.6); g.moveTo(9.6, y); g.lineTo(7, y + 2.6); g.stroke(); }
    g.fillStyle = '#d9d4c7'; g.fillRect(6.5, 34, 3.6, 2);
    const blds = [[-160, 46, 38, '#c9ccd1'], [-95, 22, 14, '#b4b9bf'], [-60, 12, 9, '#9da3aa'], [70, 30, 10, '#bfc3c8'], [110, 16, 22, '#aeb3b9']];
    for (const [x, w, h, col] of blds) {
      g.fillStyle = col; g.fillRect(x, -2, w, h + 2); g.strokeStyle = 'rgba(15,18,24,0.6)'; g.strokeRect(x, -2, w, h + 2);
      g.fillStyle = 'rgba(40,70,110,0.55)';
      for (let wy = 3; wy < h - 2; wy += 4) for (let wx = x + 2; wx < x + w - 3; wx += 4) g.fillRect(wx, wy, 2, 1.6);
    }
    g.fillStyle = '#2d4e7c'; g.fillRect(-150, -2, 18, 26);
  }
  function scTile(i, L) {
    const key = `sc|${i}|${L}`;
    let s = sprites.atlas.get(key);
    if (s) return s;
    const x0 = SC_X0 + i * SC_TILE;
    const img = FS.GL.bake(Math.round(SC_TILE * L), Math.round((SC_Y1 - SC_Y0) * L), (g) => {
      g.setTransform(L, 0, 0, -L, -x0 * L, SC_Y1 * L); // y up
      g.__px = 1 / L;
      drawSpaceCenterVector(g);
    });
    return sprites.atlas.add(key, img);
  }
  function drawSpaceCenter(cam, b, t, L) {
    const ang = b.pad.lon + FS.bodyRot(b, t);
    const c = FS.bodyAbs(b, t);
    const base = { x: c.x + Math.cos(ang) * (b.R + b.pad.height), y: c.y + Math.sin(ang) * (b.R + b.pad.height) };
    const bs = w2s(cam, base.x, base.y);
    const reachPx = Math.hypot(W, H) / 2 + 200 * cam.s;
    if (Math.hypot(bs.x - W / 2, bs.y - H / 2) > reachPx) return;
    // pad frame on screen: +x along the ground (east), +y up
    const scr = (ang - Math.PI / 2) - cam.rot; // rotation of the pad's x axis, world → camera
    const size = (cam.s * DPR) / L;
    for (let i = 0; i * SC_TILE + SC_X0 < SC_X1; i++) {
      const midX = SC_X0 + (i + 0.5) * SC_TILE, midY = (SC_Y0 + SC_Y1) / 2;
      const cx = Math.cos(scr), sx = Math.sin(scr);
      const wx = midX * cx - midY * sx, wy = midX * sx + midY * cx; // camera-frame metres
      const sxp = bs.x + wx * cam.s, syp = bs.y - wy * cam.s;
      const rad = (SC_TILE * 0.75 + (SC_Y1 - SC_Y0) * 0.5) * cam.s;
      if (sxp < -rad || syp < -rad || sxp > W + rad || syp > H + rad) continue;
      const e = scTile(i, L);
      if (!e) continue;
      sprites.sprite(e, sxp * DPR, syp * DPR, size, -scr, e.w / 2, e.h / 2, null);
    }
    // beacon on the tower top
    if (t % 2 < 1) {
      const bx = 8.4, by = 36.4;
      const cx = Math.cos(scr), sx = Math.sin(scr);
      const wx = bx * cx - by * sx, wy = bx * sx + by * cx;
      const r = P.ramps.red[0];
      block((bs.x + wx * cam.s) * DPR, (bs.y - wy * cam.s) * DPR, Math.max(0.8 * cam.s * DPR, size * 2), Math.max(0.8 * cam.s * DPR, size * 2), -scr, [r[0] / 255, r[1] / 255, r[2] / 255, 1]);
    }
  }

  // Pixel puffs for particles: discs n art pixels across, white with a lighter core
  // (tinted from a palette ramp when drawn).
  function puff(n) {
    const key = 'puff|' + n;
    let s = sprites.atlas.get(key);
    if (s) return s;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d');
    const img = g.createImageData(n, n);
    const r = n / 2;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const dx = x + 0.5 - r, dy = y + 0.5 - r;
      const q = Math.hypot(dx, dy) / r;
      if (q > (n <= 2 ? 1.5 : 1)) continue;
      const v = q < 0.45 ? 255 : q < 0.8 ? 215 : 180;
      const i = (y * n + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return sprites.atlas.add(key, c);
  }

  // ---------- Vessels ----------
  function vesselFrame(cam, ves, t) {
    const c = V.add(FS.bodyAbs(ves.body, t), ves.r);
    return { sp: w2s(cam, c.x, c.y), th: -(ves.angle - cam.rot) + Math.PI / 2 };
  }
  R.partToScreen = (cam, ves, t, pt) => {
    const f = vesselFrame(cam, ves, t);
    const x = pt.x * cam.s, y = -pt.y * cam.s, c = Math.cos(f.th), s = Math.sin(f.th);
    return { x: f.sp.x + x * c - y * s, y: f.sp.y + x * s + y * c };
  };
  R.screenToPart = (cam, ves, t, sx, sy) => {
    const f = vesselFrame(cam, ves, t);
    const dx = (sx - f.sp.x) / cam.s, dy = (sy - f.sp.y) / cam.s, c = Math.cos(-f.th), s = Math.sin(-f.th);
    return { x: dx * c - dy * s, y: -(dx * s + dy * c) };
  };

  function arrowSprite() {
    let s = sprites.atlas.get('arrow');
    if (s) return s;
    const img = FS.GL.bake(9, 9, (g) => {
      g.fillStyle = '#ffd27a';
      g.beginPath(); g.moveTo(8.5, 4.5); g.lineTo(0.5, 0.5); g.lineTo(2.5, 4.5); g.lineTo(0.5, 8.5); g.closePath(); g.fill();
    }, 0.5);
    return sprites.atlas.add('arrow', img);
  }

  function drawVessel(cam, ves, t, k, tint) {
    const f = vesselFrame(cam, ves, t);
    const len = ves.layout.height * cam.s;
    const L = 16 / Math.pow(2, k);
    if (len < 6 || L < 0.25) {
      const e = arrowSprite();
      const a = ves.isDebris ? 0.6 : 1;
      if (e) sprites.sprite(e, f.sp.x * DPR, f.sp.y * DPR, 1.5 * DPR, -(ves.angle - cam.rot), 4.5, 4.5, [1, 1, 1, a]);
      return;
    }
    const size = (cam.s * DPR) / L;
    const th = f.th;
    const toScreen = (x, y) => { // drawing frame (x, y down the rocket) → device px
      const c = Math.cos(th), s = Math.sin(th);
      return { x: (f.sp.x + (x * c - y * s) * cam.s) * DPR, y: (f.sp.y + (x * s + y * c) * cam.s) * DPR };
    };
    const chutes = ves.parts.filter((p) => p.chute === 'semi' || p.chute === 'full');
    if (chutes.length) {
      const cp = chutes[0];
      const tip = V.add(cp.c, V.scale(cp.axis, cp.len / 2));
      const e = chuteSprite(chutes.some((p) => p.chute === 'full'), L);
      if (e) { const at = toScreen(tip.x, -tip.y); sprites.sprite(e, at.x, at.y, size, th, e.ox, e.oy, tint); }
    }
    const glowMap = new Map();
    if (ves.nozzles) ves.nozzles.forEach((n) => glowMap.set(n.part, n.power));
    for (const p of ves.parts) {
      const glow = Math.round((glowMap.get(p) || 0) * 2) / 2;
      const e = partSprite(p, L, glow);
      if (!e) continue;
      const at = toScreen(p.c.x, -p.c.y);
      sprites.sprite(e, at.x, at.y, size, th - p.rot, e.ox, e.oy, tint, !!p.flip);
    }
  }

  // ---------- Particles ----------
  const FIRE = [P.ramps.gold[4], P.ramps.gold[3], P.ramps.orange[4], P.ramps.orange[3], P.ramps.orange[2], P.ramps.orange[1]];
  const BLUE = [P.ramps.blue[7], P.ramps.blue[6], P.ramps.blue[5], P.ramps.blue[4]];
  const SMOKE = [P.ramps.metal[7], P.ramps.metal[6], P.ramps.metal[6], P.ramps.metal[5], P.ramps.metal[4]];
  const rampAt = (ramp, f) => ramp[Math.min(ramp.length - 1, Math.floor(f * ramp.length))];

  function drawParticles(cam, body, t, cell, tint) {
    const base = FS.bodyAbs(body, t);
    const list = FS.Render.particles;
    for (const pass of ['smoke', 'fire']) {
      for (const q of list) {
        const smoke = q.kind === 'smoke';
        if ((pass === 'smoke') !== smoke) continue;
        const f = q.life / q.max;
        const sizeM = q.size + q.grow * q.life;
        const n = FS.clamp(Math.round(sizeM / cell), 1, 40);
        const sp = w2s(cam, base.x + q.x, base.y + q.y);
        const rpx = n * cell * cam.s;
        if (sp.x < -rpx || sp.y < -rpx || sp.x > W + rpx || sp.y > H + rpx) continue;
        const e = puff(n);
        if (!e) continue;
        const col = smoke ? rampAt(SMOKE, f) : q.kind === 'blue' ? rampAt(BLUE, f) : rampAt(FIRE, f);
        const k = smoke ? tint : [1, 1, 1];
        const a = smoke ? (1 - f) * 0.75 : Math.max(0.05, (1 - f) * (1 - f) * 1.1);
        sprites.sprite(e, sp.x * DPR, sp.y * DPR, cell * cam.s * DPR, -cam.rot * 0, n / 2, n / 2, [(col[0] / 255) * k[0], (col[1] / 255) * k[1], (col[2] / 255) * k[2], a]);
      }
    }
  }

  // Reentry: a pixel glow ahead of the craft and streaks behind it.
  function drawReentry(cam, ves, t, cell) {
    if (ves.heat <= 0.01) return;
    const b = ves.body;
    const vAir = V.sub(ves.v, FS.airVel(b, ves.r));
    const dir = V.norm(vAir);
    const c = V.add(FS.bodyAbs(b, t), ves.r);
    const lead = V.add(c, V.scale(dir, ves.layout.height * 0.45));
    const sp = w2s(cam, lead.x, lead.y);
    const n = FS.clamp(Math.round((ves.layout.height * 0.9) / cell), 3, 40);
    const e = puff(n);
    const hot = ves.heat;
    const col = rampAt(FIRE, 1 - hot);
    if (e) sprites.sprite(e, sp.x * DPR, sp.y * DPR, cell * cam.s * DPR, 0, n / 2, n / 2, [col[0] / 255, col[1] / 255, col[2] / 255, hot * 0.9]);
    const sd = w2s(cam, lead.x - dir.x * 40, lead.y - dir.y * 40);
    const ang = Math.atan2(sd.y - sp.y, sd.x - sp.x);
    const len = Math.hypot(sd.x - sp.x, sd.y - sp.y);
    const thick = Math.max(1, cell * cam.s) * DPR;
    const sc = rampAt(FIRE, 0.4);
    for (let i = -2; i <= 2; i++) {
      const off = i * n * cell * cam.s * 0.25;
      const ox = -Math.sin(ang) * off, oy = Math.cos(ang) * off;
      block((sp.x + ox + Math.cos(ang) * len / 2) * DPR, (sp.y + oy + Math.sin(ang) * len / 2) * DPR, len * DPR * (0.6 + 0.4 * Math.random()), thick, ang, [sc[0] / 255, sc[1] / 255, sc[2] / 255, hot * 0.7]);
    }
  }

  // ---------- Flight view ----------
  function sunlight(up) { return FS.smoothstep(-0.12, 0.25, V.dot(up, FS.SUN_DIR)); }
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  // How sunlit the craft is: dark in a planet's shadow, dimmer towards dusk in the air.
  function lightAt(ves) {
    const b = ves.body;
    const S = FS.SUN_DIR;
    const along = V.dot(ves.r, S);
    const off = Math.abs(V.cross(ves.r, S));
    let lt = along < 0 && off < b.R ? 0 : 1;
    if (b.atmo && ves.altitude < b.atmo.height) lt = Math.min(1, sunlight(V.norm(ves.r)) * 1.25);
    return lt;
  }

  R.drawFlight = (g) => {
    const ves = g.vessel, t = g.t, cam = g.cam, b = ves.body;
    const k = levelFor(cam.s);
    const cell = Math.pow(2, k) / 16;
    frameInfo.level = k;
    sprites.draws = 0;
    gl.viewport(0, 0, cv.width, cv.height);
    // sky
    const alt = ves.altitude;
    const up = V.norm(ves.r);
    const light = sunlight(up);
    let skyT = 1;
    if (b.atmo) skyT = FS.clamp(Math.pow(Math.max(alt, 0) / b.atmo.height, 0.55), 0, 1);
    const sunsetK = b.atmo ? (1 - skyT) * Math.exp(-Math.pow(V.dot(up, FS.SUN_DIR) / 0.18, 2)) : 0;
    const day = b.atmo ? (1 - skyT) * light : 0;
    const top = mix([6, 9, 20], [58, 118, 196], day);
    const bot = mix(mix([8, 12, 26], [140, 190, 236], day), [236, 132, 72], sunsetK * 0.8);
    const starA = 1 - day * 1.15;
    drawSky(skyStops(top, bot), FS.clamp(starA * 1.6 - 0.6, 0, 1) * 0.55, -cam.rot + 0.6);
    sprites.begin(cv.width, cv.height);
    drawStars(cam, starA, true, t);
    sprites.flush();
    // bodies, farthest first
    cam.body = b;
    const order = FS.bodies.slice().sort((a, c) => V.len(V.sub(FS.bodyAbs(c, t), cam)) - V.len(V.sub(FS.bodyAbs(a, t), cam)));
    const L = 16 / Math.pow(2, Math.min(k, 6));
    for (const body of order) {
      const near = drawBody(cam, body, t, k);
      if (near && body.pad) { sprites.begin(cv.width, cv.height); drawSpaceCenter(cam, body, t, L); sprites.flush(); }
    }
    // the craft, its debris and its exhaust
    const lt = lightAt(ves);
    const night = [0.34, 0.38, 0.6];
    const tint = mix(night, [1, 1, 1], lt);
    const tintA = [tint[0], tint[1], tint[2], 1];
    sprites.begin(cv.width, cv.height);
    drawParticles(cam, b, t, cell, tint);
    for (const d of g.debris) if (!d.dead) drawVessel(cam, d, t, k, tintA);
    if (!ves.dead) {
      drawVessel(cam, ves, t, k, tintA);
      drawReentry(cam, ves, t, cell);
    }
    sprites.flush();
    frameInfo.draws = sprites.draws;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, overlay.width, overlay.height);
  };

  // ---------- Map view ----------
  const PATCH_COLORS = ['#55d6ff', '#ffb547', '#ff6fb1'];

  R.drawMap = (g) => {
    const t = g.t, cam = g.mapCam;
    const k = levelFor(cam.s);
    frameInfo.level = k;
    sprites.draws = 0;
    gl.viewport(0, 0, cv.width, cv.height);
    drawSky([P.ramps.night[0]], 0.4, 0.6);
    sprites.begin(cv.width, cv.height);
    drawStars(cam, 0.8, false, t);
    sprites.flush();
    cam.body = null;
    for (const b of FS.bodies) drawBody(cam, b, t, k);
    frameInfo.draws = sprites.draws;

    // lines, markers and labels on the overlay
    const ctx = octx;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
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
    ctx.font = '600 12px "Saira Semi Condensed", "Arial Narrow", sans-serif';
    ctx.textAlign = 'center';
    for (const b of FS.bodies) {
      const bc = FS.bodyAbs(b, t);
      const bs = w2s(cam, bc.x, bc.y);
      ctx.fillStyle = 'rgba(214,224,245,0.85)';
      ctx.fillText(b.name.toUpperCase(), bs.x, bs.y + Math.max(b.R * cam.s, 4) + 16);
    }
    const ves = g.vessel;
    if (!ves.dead && !ves.landed) {
      drawPatches(ctx, cam, g.patches, t, false);
      if (g.node && g.nodePatches) drawPatches(ctx, cam, g.nodePatches, t, true, g.node.originT);
    }
    if (g.node) {
      const nd = g.node;
      const p = V.add(FS.bodyAbs(nd.body, nd.originT ?? t), nd.r);
      const s = w2s(cam, p.x, p.y);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#4f8dff'; ctx.strokeStyle = '#d8e6ff'; ctx.lineWidth = 1.5;
      ctx.fillRect(-6, -6, 12, 12); ctx.strokeRect(-6, -6, 12, 12);
      ctx.restore();
    }
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

  function drawPatches(ctx, cam, patches, t, planned, firstRef) {
    if (!patches) return;
    patches.forEach((pt, i) => {
      const o = pt.orbit;
      const tRef = i === 0 ? (firstRef ?? t) : pt.tStart;
      const origin = FS.bodyAbs(pt.body, tRef);
      const t0 = Math.max(pt.tStart, i === 0 ? t : pt.tStart);
      const pts = FS.sampleOrbit(o, t0, pt.tEnd, 360);
      ctx.strokeStyle = PATCH_COLORS[i % PATCH_COLORS.length];
      ctx.lineWidth = planned ? 1.6 : 2;
      ctx.globalAlpha = planned ? 0.85 : 1;
      if (planned) ctx.setLineDash([7, 5]);
      ctx.beginPath();
      pts.forEach((p, j) => {
        const s = w2s(cam, origin.x + p.x, origin.y + p.y);
        j ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (i > 0 && pt.body.parent) {
        const s = w2s(cam, origin.x, origin.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(pt.body.R * cam.s, 4), 0, TAU); ctx.stroke();
      }
      if (planned) return;
      const b = pt.body;
      const mark = (nu, label, value) => {
        const dtTo = FS.timeToNu(o, nu, t0);
        if (!isFinite(dtTo) || t0 + dtTo > pt.tEnd) return;
        const st = FS.orbitState(o, t0 + dtTo);
        marker(ctx, w2s(cam, origin.x + st.r.x, origin.y + st.r.y), label, FS.fmtDist(value));
      };
      if (o.e > 1e-4) {
        if (o.e < 1) mark(Math.PI, 'Ap', o.ap - b.R);
        if (o.pe > b.R * 0.2) mark(0, 'Pe', o.pe - b.R);
      }
      const end = pts[pts.length - 1];
      if (pt.end && end) {
        const s = w2s(cam, origin.x + end.x, origin.y + end.y);
        const lbl = pt.end === 'encounter' ? pt.next.name + ' encounter' : pt.end === 'escape' ? 'Escape' : 'Impact';
        marker(ctx, s, lbl, FS.fmtTime(pt.tEnd - t), pt.end === 'impact' ? '#ff6b5a' : '#c7d6ff');
      }
    });
  }

  function marker(ctx, s, label, value, col = '#ffe2a6') {
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

  // For the gallery: draw a part sprite at L art pixels per metre.
  R.galleryPart = (p, L, glow) => partSprite(p, L, glow);
  R.sprites = () => sprites;
})();
