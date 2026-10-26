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
  const Vector = FS.vec;
  const FULL_TURN = FS.TAU;
  const Palette = FS.Palette;
  const RenderGL = (FS.RenderGL = {});

  let webgl;
  let viewCanvas;
  let overlay;
  let overlayContext;
  let sprites;
  let skyShader;
  let planet;
  let viewWidth = 0;
  let viewHeight = 0;
  let pixelRatio = 1;
  let game = null;
  const stars = [];
  const heightTex = new Map(); // body → full-circle height texture
  let windowTex = null; // heights around the camera, refreshed every frame
  const N_FULL = 4096;
  const N_WIN = 1024;
  let pixelSize = 1.5; // smallest art pixel on screen, CSS px (setting)
  let frameInfo = { level: 0, draws: 0 };

  RenderGL.setPixelSize = (size) => {
    pixelSize = FS.clamp(size, 1, 3);
  };
  RenderGL.pixelSize = () => pixelSize;

  // ---------- Set-up ----------
  RenderGL.init = (canvas, theGame) => {
    viewCanvas = canvas;
    game = theGame;
    webgl = canvas.getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    if (!webgl) {
      throw new Error('WebGL2 is not available');
    }
    overlay = document.createElement('canvas');
    overlay.className = 'view-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    canvas.after(overlay);
    overlayContext = overlay.getContext('2d');
    sprites = new FS.GL.Sprites(webgl, Math.min(2048, webgl.getParameter(webgl.MAX_TEXTURE_SIZE)));
    skyShader = FS.GL.fullscreen(webgl, SKY_FS);
    planet = FS.GL.fullscreen(webgl, PLANET_FS);
    windowTex = makeHeightTexture(N_WIN);
    const random = FS.rng(4242);
    const starCols = [
      Palette.ramps.metal[7],
      Palette.ramps.metal[7],
      Palette.ramps.blue[7],
      Palette.ramps.blue[6],
      Palette.ramps.gold[4],
      Palette.ramps.dusk[4],
    ];
    for (let starIndex = 0; starIndex < 700; starIndex++) {
      const angle = random() * FULL_TURN;
      const distance = Math.sqrt(random());
      stars.push({
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
        big: random() < 0.06,
        b: 0.3 + random() * 0.7,
        c: starCols[Math.floor(random() * starCols.length)].map((channel) => channel / 255),
        tw: random() < 0.05 ? random() * FULL_TURN : null, // a few twinkle
      });
    }
    if (FS.Render.subscribe && theGame) {
      FS.Render.subscribe(theGame);
    }
    RenderGL.resize();
  };

  RenderGL.resize = () => {
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    viewWidth = viewCanvas.clientWidth;
    viewHeight = viewCanvas.clientHeight;
    viewCanvas.width = Math.round(viewWidth * pixelRatio);
    viewCanvas.height = Math.round(viewHeight * pixelRatio);
    overlay.width = viewCanvas.width;
    overlay.height = viewCanvas.height;
  };
  RenderGL.size = () => ({ W: viewWidth, H: viewHeight });

  // Particles are simulated by the shared code in render.js; only drawing differs.
  RenderGL.update = (theGame) => FS.Render.update(theGame);
  RenderGL.stats = () => ({
    particles: FS.Render.particles.length,
    level: frameInfo.level,
    draws: frameInfo.draws,
    atlas: sprites ? Math.round(sprites.atlas.used() * 100) + '%' : '',
  });

  // ---------- Camera ----------
  function worldToScreenPoint(camera, x, y) {
    const deltaX = x - camera.x;
    const deltaY = y - camera.y;
    const cosRot = Math.cos(camera.rot);
    const sinRot = Math.sin(camera.rot);
    return {
      x: viewWidth / 2 + (deltaX * cosRot + deltaY * sinRot) * camera.s,
      y: viewHeight / 2 - (-deltaX * sinRot + deltaY * cosRot) * camera.s,
    };
  }
  RenderGL.worldToScreen = worldToScreenPoint;

  // The art-pixel level for a zoom: art pixels are (1/16)·2^k metres.
  function levelFor(camS) {
    let level = 0;
    while (level < 60 && (camS * Math.pow(2, level)) / 16 < pixelSize) {
      level++;
    }
    return level;
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
  function skyStops(top, bottom) {
    const out = [];
    for (let stopIndex = 0; stopIndex < 7; stopIndex++) {
      const fraction = stopIndex / 6;
      const colour = Palette.nearest(
        top[0] + (bottom[0] - top[0]) * fraction,
        top[1] + (bottom[1] - top[1]) * fraction,
        top[2] + (bottom[2] - top[2]) * fraction,
      );
      if (!out.length || out[out.length - 1] !== colour) {
        out.push(colour);
      }
    }
    return out;
  }

  function drawSky(stops, galaxyStrength, galAng) {
    webgl.useProgram(skyShader.p);
    webgl.uniform2f(skyShader.u.uRes, viewCanvas.width, viewCanvas.height);
    webgl.uniform1f(skyShader.u.uPix, Math.max(1, pixelSize * pixelRatio));
    FS.GL.rampUniform(webgl, skyShader.u.uSky, stops, 8);
    webgl.uniform1i(skyShader.u.uSkyN, stops.length);
    webgl.uniform1f(skyShader.u.uGal, galaxyStrength);
    webgl.uniform1f(skyShader.u.uGalAng, galAng);
    FS.GL.rampUniform(webgl, skyShader.u.uGalCol, [Palette.ramps.night[2], Palette.ramps.night[3]], 2);
    webgl.disable(webgl.BLEND);
    skyShader.draw();
  }

  // Pixel stars: one or two art pixels each, turning with the camera.
  function drawStars(camera, alpha, rotate, time) {
    if (alpha <= 0.02) {
      return;
    }
    const skyRadius = Math.hypot(viewWidth, viewHeight) * 0.55;
    const rotation = rotate ? camera.rot : 0;
    const cosRot = Math.cos(-rotation);
    const sinRot = Math.sin(-rotation);
    const dotSize = Math.max(1, pixelSize) * pixelRatio;
    for (const star of stars) {
      const starX = viewWidth / 2 + (star.x * cosRot - star.y * sinRot) * skyRadius;
      const starY = viewHeight / 2 + (star.x * sinRot + star.y * cosRot) * skyRadius;
      if (starX < -4 || starY < -4 || starX > viewWidth + 4 || starY > viewHeight + 4) {
        continue;
      }
      let starAlpha = star.b * alpha;
      if (star.tw !== null) {
        starAlpha *= Math.sin(time * 2.3 + star.tw) > 0.3 ? 1 : 0.45;
      }
      block(
        starX * pixelRatio,
        starY * pixelRatio,
        star.big ? dotSize * 2 : dotSize,
        star.big ? dotSize * 2 : dotSize,
        -rotation,
        [star.c[0], star.c[1], star.c[2], starAlpha],
      );
    }
  }

  // A solid rectangle w × h device px centred at (x, y), turned by angle, with crisp edges.
  function block(centreX, centreY, width, height, angle, tint) {
    const entry = sprites.white();
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);
    // the quad reaches 1 texel into the clear padding on every side, so the edges are smoothed
    const halfWidth = (width / 2) * 1.5;
    const halfHeight = (height / 2) * 1.5;
    const cornerAt = (offsetX, offsetY) => ({
      x: centreX + offsetX * cosAngle - offsetY * sinAngle,
      y: centreY + offsetX * sinAngle + offsetY * cosAngle,
    });
    sprites.quad(
      cornerAt(-halfWidth, -halfHeight),
      cornerAt(halfWidth, -halfHeight),
      cornerAt(halfWidth, halfHeight),
      cornerAt(-halfWidth, halfHeight),
      entry,
      tint,
      -1,
      -1,
      5,
      5,
    );
  }

  // ---------- Bodies ----------
  // Heights as a 1-pixel-high float texture (read with texelFetch, interpolated by hand).
  function makeHeightTexture(sampleCount) {
    const texture = webgl.createTexture();
    webgl.bindTexture(webgl.TEXTURE_2D, texture);
    webgl.texImage2D(webgl.TEXTURE_2D, 0, webgl.R32F, sampleCount, 1, 0, webgl.RED, webgl.FLOAT, null);
    for (const filter of [webgl.TEXTURE_MIN_FILTER, webgl.TEXTURE_MAG_FILTER]) {
      webgl.texParameteri(webgl.TEXTURE_2D, filter, webgl.NEAREST);
    }
    return { tex: texture, n: sampleCount, data: new Float32Array(sampleCount) };
  }
  function uploadHeights(heights) {
    webgl.bindTexture(webgl.TEXTURE_2D, heights.tex);
    webgl.texSubImage2D(webgl.TEXTURE_2D, 0, 0, 0, heights.n, 1, webgl.RED, webgl.FLOAT, heights.data);
  }
  function fullHeights(body) {
    let heights = heightTex.get(body);
    if (!heights) {
      heights = makeHeightTexture(N_FULL);
      for (let sampleIndex = 0; sampleIndex < N_FULL; sampleIndex++) {
        heights.data[sampleIndex] = FS.terrainHeight(body, (sampleIndex / N_FULL) * FULL_TURN);
      }
      uploadHeights(heights);
      heightTex.set(body, heights);
    }
    return heights;
  }

  // Colour ramps for each body's materials (5 entries each, dark to light).
  const hexToPalette = (list) =>
    list.map((hexText) =>
      Palette.nearest(
        parseInt(hexText.slice(1, 3), 16),
        parseInt(hexText.slice(3, 5), 16),
        parseInt(hexText.slice(5, 7), 16),
      ),
    );
  const pick = (ramp, ...indices) => indices.map((index) => ramp[index]);
  const MATERIALS = {
    Aster: () => ({
      land: pick(Palette.ramps.green, 0, 1, 2, 3, 4),
      sand: pick(Palette.ramps.earth, 2, 3, 4, 5, 6),
      rock: pick(Palette.ramps.metal, 1, 2, 3, 4, 5),
      snow: [
        Palette.ramps.metal[3],
        Palette.ramps.blue[5],
        Palette.ramps.blue[6],
        Palette.ramps.metal[7],
        Palette.ramps.blue[7],
      ],
      soil: pick(Palette.ramps.earth, 0, 1, 2, 3, 4),
      strA: pick(Palette.ramps.earth, 0, 1, 2, 3, 4),
      strB: [
        Palette.ramps.earth[0],
        Palette.ramps.metal[1],
        Palette.ramps.earth[1],
        Palette.ramps.metal[2],
        Palette.ramps.earth[2],
      ],
      deep: [
        Palette.ramps.night[1],
        Palette.ramps.blue[0],
        Palette.ramps.blue[1],
        Palette.ramps.blue[2],
        Palette.ramps.blue[3],
      ],
      ocean: pick(Palette.ramps.blue, 0, 1, 2, 3, 4, 5),
      atmo: pick(Palette.ramps.blue, 3, 4, 5, 6, 7),
    }),
    Mira: () => ({
      land: pick(Palette.ramps.metal, 1, 2, 3, 4, 5),
      sand: pick(Palette.ramps.metal, 1, 2, 3, 4, 5),
      rock: pick(Palette.ramps.metal, 2, 3, 4, 5, 6),
      snow: pick(Palette.ramps.metal, 2, 3, 4, 5, 6),
      soil: pick(Palette.ramps.metal, 0, 1, 2, 3, 4),
      strA: pick(Palette.ramps.metal, 0, 1, 2, 3, 4),
      strB: [
        Palette.ramps.night[1],
        Palette.ramps.night[2],
        Palette.ramps.metal[1],
        Palette.ramps.metal[2],
        Palette.ramps.metal[3],
      ],
      deep: [
        Palette.ramps.night[0],
        Palette.ramps.metal[0],
        Palette.ramps.metal[1],
        Palette.ramps.metal[2],
        Palette.ramps.metal[3],
      ],
      ocean: pick(Palette.ramps.blue, 0, 1, 2, 3, 4, 5),
      atmo: pick(Palette.ramps.metal, 3, 4, 5, 6, 7),
    }),
    Pell: () => ({
      land: [
        Palette.ramps.teal[0],
        Palette.ramps.teal[1],
        Palette.ramps.teal[2],
        Palette.ramps.teal[3],
        Palette.ramps.metal[7],
      ],
      sand: [
        Palette.ramps.teal[0],
        Palette.ramps.teal[1],
        Palette.ramps.teal[2],
        Palette.ramps.teal[3],
        Palette.ramps.metal[7],
      ],
      rock: [
        Palette.ramps.night[2],
        Palette.ramps.teal[0],
        Palette.ramps.teal[1],
        Palette.ramps.teal[2],
        Palette.ramps.teal[3],
      ],
      snow: [
        Palette.ramps.teal[1],
        Palette.ramps.teal[2],
        Palette.ramps.teal[3],
        Palette.ramps.blue[6],
        Palette.ramps.metal[7],
      ],
      soil: [
        Palette.ramps.night[1],
        Palette.ramps.night[2],
        Palette.ramps.teal[0],
        Palette.ramps.teal[1],
        Palette.ramps.teal[2],
      ],
      strA: [
        Palette.ramps.night[1],
        Palette.ramps.night[2],
        Palette.ramps.teal[0],
        Palette.ramps.teal[1],
        Palette.ramps.teal[2],
      ],
      strB: [
        Palette.ramps.night[0],
        Palette.ramps.metal[1],
        Palette.ramps.metal[2],
        Palette.ramps.teal[0],
        Palette.ramps.teal[1],
      ],
      deep: [
        Palette.ramps.night[0],
        Palette.ramps.night[1],
        Palette.ramps.night[2],
        Palette.ramps.teal[0],
        Palette.ramps.teal[1],
      ],
      ocean: pick(Palette.ramps.blue, 0, 1, 2, 3, 4, 5),
      atmo: pick(Palette.ramps.teal, 0, 1, 2, 3, 3),
    }),
  };
  const matCache = new Map();
  const materials = (body) => {
    if (!matCache.has(body)) {
      matCache.set(body, (MATERIALS[body.name] || MATERIALS.Mira)());
    }
    return matCache.get(body);
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
  function drawBody(camera, body, time, zoomLevel) {
    const cell = Math.pow(2, zoomLevel) / 16;
    const centre = FS.bodyAbs(body, time);
    const relative = { x: centre.x - camera.x, y: centre.y - camera.y };
    const dist = Math.hypot(relative.x, relative.y);
    const viewR = Math.hypot(viewWidth, viewHeight) / 2 / camera.s;
    const atmoH = body.atmo ? body.atmo.height : 0;
    const reach = body.R + Math.max(atmoH * 1.4, body.terrain.amp * 1.5);
    if (dist - reach > viewR) {
      return false;
    }
    // tiny: a dot of a few art pixels
    if (body.R * camera.s < 2.5) {
      const screenPoint = worldToScreenPoint(camera, centre.x, centre.y);
      const colour = Palette.nearest(...hexToPalette([body.colors.disc])[0]).map((channel) => channel / 255);
      sprites.begin(viewCanvas.width, viewCanvas.height);
      const dotSize = Math.max(2.5, body.R * camera.s) * 2 * pixelRatio;
      block(screenPoint.x * pixelRatio, screenPoint.y * pixelRatio, dotSize, dotSize, 0, [
        colour[0],
        colour[1],
        colour[2],
        1,
      ]);
      sprites.flush();
      return false;
    }
    const near =
      camera.body === body && viewR < body.R * 0.3 && dist - body.R < viewR * 4 + body.terrain.amp * 2;
    const material = materials(body);
    const uniforms = planet.u;
    webgl.useProgram(planet.p);
    webgl.uniform2f(uniforms.uRes, viewCanvas.width, viewCanvas.height);
    webgl.uniform1f(uniforms.uCamS, camera.s * pixelRatio);
    webgl.uniform1f(uniforms.uCamRot, camera.rot);
    webgl.uniform1f(uniforms.uCell, cell);
    webgl.uniform1f(uniforms.uBodyRot, FS.bodyRot(body, time));
    webgl.uniform1f(uniforms.uR, body.R);
    webgl.uniform1f(uniforms.uAtmoH, atmoH);
    webgl.uniform1i(uniforms.uOcean, body.ocean ? 1 : 0);
    webgl.uniform1f(uniforms.uSnowH, body.ocean ? 2550 : 1e9);
    webgl.uniform1f(uniforms.uRockH, body.ocean ? 1900 : body.terrain.amp * 0.6);
    webgl.uniform1f(uniforms.uAmp, body.terrain.amp);
    webgl.uniform2f(uniforms.uSun, FS.SUN_DIR.x, FS.SUN_DIR.y);
    webgl.uniform1f(uniforms.uRim, near ? 0 : 1);
    const ramps = {
      uLand: material.land,
      uSand: material.sand,
      uRock: material.rock,
      uSnow: material.snow,
      uSoil: material.soil,
      uStrA: material.strA,
      uStrB: material.strB,
      uDeep: material.deep,
      uAtmo: material.atmo,
    };
    for (const [name, ramp] of Object.entries(ramps)) {
      FS.GL.rampUniform(webgl, uniforms[name], ramp, 5);
    }
    FS.GL.rampUniform(webgl, uniforms.uOceanR, material.ocean, 6);
    let hTex;
    if (near) {
      // close to the ground: work in the frame of the ground under the camera
      const localUp = { x: -relative.x / dist, y: -relative.y / dist };
      const angle = Math.atan2(localUp.y, localUp.x);
      const lonCam = FS.wrapAngle(angle - FS.bodyRot(body, time));
      const span = Math.min(Math.PI, (viewR * 1.6) / body.R);
      const period = cell * 65536;
      const windowStart = (((lonCam * body.R) % period) + period) % period;
      for (let sampleIndex = 0; sampleIndex < N_WIN; sampleIndex++) {
        windowTex.data[sampleIndex] = FS.terrainHeight(
          body,
          lonCam - span + (2 * span * sampleIndex) / (N_WIN - 1),
        );
      }
      uploadHeights(windowTex);
      hTex = windowTex;
      webgl.uniform1i(uniforms.uMode, 1);
      webgl.uniform2f(uniforms.uUp, localUp.x, localUp.y);
      webgl.uniform1f(uniforms.uAltCam, dist - body.R);
      webgl.uniform1f(uniforms.uRc, dist);
      webgl.uniform1f(uniforms.uU0, windowStart);
      webgl.uniform1f(uniforms.uLonCam, lonCam);
      webgl.uniform1f(uniforms.uSpan, span);
    } else {
      hTex = fullHeights(body);
      webgl.uniform1i(uniforms.uMode, 0);
      webgl.uniform2f(uniforms.uC, relative.x, relative.y);
    }
    webgl.activeTexture(webgl.TEXTURE1);
    webgl.bindTexture(webgl.TEXTURE_2D, hTex.tex);
    webgl.uniform1i(uniforms.uH, 1);
    webgl.uniform1i(uniforms.uHN, hTex.n);
    // only shade the pixels the body can cover
    const screenPoint = worldToScreenPoint(camera, centre.x, centre.y);
    const reachPixels = reach * camera.s;
    const minX = FS.clamp(screenPoint.x - reachPixels, 0, viewWidth);
    const maxX = FS.clamp(screenPoint.x + reachPixels, 0, viewWidth);
    const minY = FS.clamp(screenPoint.y - reachPixels, 0, viewHeight);
    const maxY = FS.clamp(screenPoint.y + reachPixels, 0, viewHeight);
    if (maxX <= minX || maxY <= minY) {
      return false;
    }
    webgl.enable(webgl.SCISSOR_TEST);
    webgl.scissor(
      Math.floor(minX * pixelRatio),
      Math.floor((viewHeight - maxY) * pixelRatio),
      Math.ceil((maxX - minX) * pixelRatio) + 1,
      Math.ceil((maxY - minY) * pixelRatio) + 1,
    );
    webgl.disable(webgl.BLEND);
    planet.draw();
    webgl.disable(webgl.SCISSOR_TEST);
    return near;
  }

  const parsedCache = new Map();

  function newSprite(part, width, topWidth, length) {
    const partType = part.def;
    let cacheKey = null;
    let makeSprite = null;
    if (FS.SPRITES[partType.id]) {
      cacheKey = 'hand|' + partType.id;
      makeSprite = () => FS.Sprites.parse(partType.id, FS.SPRITES[partType.id]);
    } else if (partType.stretch) {
      const skinName = part.skin || (partType.foam ? 'foam' : 'white');
      cacheKey = `tank|${width}|${length}|${skinName}`;
      makeSprite = () => FS.Sprites.tank(width, length, skinName);
    } else if (partType.id === 'adapter') {
      cacheKey = `adapter|${width}|${topWidth}|${length}`;
      makeSprite = () =>
        FS.Sprites.profile({
          id: 'adapter',
          length,
          widestHalfWidth: Math.max(width, topWidth) / 2,
          halfWidthAt: (howFarDown) => topWidth / 2 + (width / 2 - topWidth / 2) * howFarDown,
          rampName: 'metal',
          tone: 5, // adapter colour
        });
    } else if (partType.id === 'decoupler') {
      cacheKey = `decoupler|${width}|${length}`;
      makeSprite = () =>
        FS.Sprites.profile({
          id: 'decoupler',
          length,
          widestHalfWidth: width / 2,
          halfWidthAt: () => width / 2,
          rampName: 'metal',
          tone: 3, //decoupler color
        });
    }
    if (!cacheKey) {
      return null;
    }

    if (!parsedCache.has(cacheKey)) {
      parsedCache.set(cacheKey, makeSprite());
    }
    const sprite = parsedCache.get(cacheKey);
    if (!sprite) {
      return null;
    }
    return { cacheKey, sprite };
  }

  // ---------- Baked sprites (temporary art) ----------
  // Parts: the vector drawing from parts.js at L art pixels per metre, snapped to the palette.
  function partSprite(part, pixelsPerMetre, glow, sunStep = 8, sunlit = 1) {
    const partType = part.def;
    const width = part.w || (partType.w === 'auto' ? 1.25 : partType.w);
    const topWidth = part.tw || partType.topW || width;
    const length = part.len || partType.len;

    //is me now :)
    // ugh have to edit this

    if (pixelsPerMetre === 16) {
      const newArt = newSprite(part, width, topWidth, length);
      if (newArt) {
        const nozzleGlow = partType.engine ? glow : 0; //only engines glow
        const mirrored = !!part.flip;
        const litKey = `${newArt.cacheKey}|${sunStep}|${sunlit}|${nozzleGlow}|${mirrored}`;
        let atlasEntry = sprites.atlas.get(litKey);
        if (atlasEntry) {
          return atlasEntry;
        }

        const sunAngle = sunStep * (FS.TAU / 32);
        let sunAcross = Math.sin(sunAngle);
        const sunAlong = Math.cos(sunAngle);
        if (mirrored) {
          sunAcross = -sunAcross;
        }
        atlasEntry = sprites.atlas.add(
          litKey,
          FS.Sprites.light(newArt.sprite, sunAcross, sunAlong, sunlit, nozzleGlow),
        );
        if (atlasEntry) {
          atlasEntry.ox = newArt.sprite.width / 2;
          atlasEntry.oy = newArt.sprite.height / 2;
          atlasEntry.lit = true;
        }
        return atlasEntry;
      }
    }

    const cacheKey = `p|${partType.id}|${width}|${topWidth}|${length}|${part.skin || ''}|${glow}|${pixelsPerMetre}`;
    let atlasEntry = sprites.atlas.get(cacheKey);
    if (atlasEntry) {
      return atlasEntry;
    }
    const halfWidth = Math.max(width, topWidth) / 2 + (partType.fin ? 0.9 : 0.1);
    const halfWidthPixels = Math.ceil(halfWidth * pixelsPerMetre);
    const topMargin = Math.ceil(0.6 * pixelsPerMetre);
    const canvasWidth = halfWidthPixels * 2;
    const canvasHeight = topMargin + Math.ceil((length + 0.3) * pixelsPerMetre);
    const image = FS.GL.bake(canvasWidth, canvasHeight, (graphics) => {
      graphics.setTransform(pixelsPerMetre, 0, 0, pixelsPerMetre, halfWidthPixels, topMargin);
      FS.drawPart(graphics, part, 0, 1 / pixelsPerMetre, { glow });
    });
    atlasEntry = sprites.atlas.add(cacheKey, image);
    if (atlasEntry) {
      atlasEntry.ox = halfWidthPixels;
      atlasEntry.oy = topMargin + (length / 2) * pixelsPerMetre;
    }
    return atlasEntry;
  }

  // Parachute canopies, in the drawing frame of drawVessel in render.js.
  function chuteSprite(full, pixelsPerMetre) {
    const key = `chute|${full ? 1 : 0}|${pixelsPerMetre}`;
    let atlasEntry = sprites.atlas.get(key);
    if (atlasEntry) {
      return atlasEntry;
    }
    const dist = full ? 11 : 6;
    const canopyWidth = full ? 7.5 : 1.6;
    const halfWidthPixels = Math.ceil((canopyWidth + 0.5) * pixelsPerMetre);
    const abovePixels = Math.ceil((dist + canopyWidth + 0.5) * pixelsPerMetre);
    const down = Math.ceil(0.5 * pixelsPerMetre);
    const image = FS.GL.bake(
      halfWidthPixels * 2,
      abovePixels + down,
      (graphics) => {
        graphics.setTransform(pixelsPerMetre, 0, 0, pixelsPerMetre, halfWidthPixels, abovePixels);
        const pixelSize = 1 / pixelsPerMetre;
        graphics.strokeStyle = '#e8e4da';
        graphics.lineWidth = pixelSize * 1.2;
        graphics.beginPath();
        graphics.moveTo(0, 0);
        graphics.lineTo(-canopyWidth, -dist);
        graphics.moveTo(0, 0);
        graphics.lineTo(canopyWidth, -dist);
        graphics.moveTo(0, 0);
        graphics.lineTo(0, -dist - canopyWidth * 0.3);
        graphics.stroke();
        graphics.beginPath();
        graphics.moveTo(-canopyWidth, -dist);
        graphics.quadraticCurveTo(-canopyWidth, -dist - canopyWidth * 0.9, 0, -dist - canopyWidth * 0.9);
        graphics.quadraticCurveTo(canopyWidth, -dist - canopyWidth * 0.9, canopyWidth, -dist);
        graphics.quadraticCurveTo(0, -dist - canopyWidth * 0.25, -canopyWidth, -dist);
        graphics.fillStyle = '#e8622a';
        graphics.fill();
        graphics.fillStyle = '#f4efe6';
        graphics.beginPath();
        graphics.moveTo(-canopyWidth * 0.35, -dist - canopyWidth * 0.12);
        graphics.quadraticCurveTo(
          -canopyWidth * 0.3,
          -dist - canopyWidth * 0.85,
          0,
          -dist - canopyWidth * 0.88,
        );
        graphics.quadraticCurveTo(
          canopyWidth * 0.3,
          -dist - canopyWidth * 0.85,
          canopyWidth * 0.35,
          -dist - canopyWidth * 0.12,
        );
        graphics.closePath();
        graphics.fill();
      },
      0.3,
    );
    atlasEntry = sprites.atlas.add(key, image);
    if (atlasEntry) {
      atlasEntry.ox = halfWidthPixels;
      atlasEntry.oy = abovePixels;
    }
    return atlasEntry;
  }

  // The launch site, baked in 32 m wide tiles (only the visible ones), in the pad's frame
  // (x along the ground, y up). Same drawing as render.js.
  const SC_X0 = -164;
  const SC_X1 = 132;
  const SC_TILE = 32;
  const SC_Y0 = -4;
  const SC_Y1 = 41;
  function drawSpaceCenterVector(graphics, time) {
    const pixelSize = graphics.__px;
    graphics.lineWidth = pixelSize;
    graphics.strokeStyle = 'rgba(15,18,24,0.7)';
    graphics.fillStyle = '#6f7378';
    graphics.fillRect(-14, -3, 28, 3);
    graphics.strokeRect(-14, -3, 28, 3);
    graphics.fillStyle = '#4b4f55';
    graphics.fillRect(-4, -0.4, 8, 0.4);
    graphics.fillStyle = '#a33b2b';
    graphics.fillRect(7, 0, 2.6, 34);
    graphics.strokeStyle = 'rgba(40,10,5,0.8)';
    for (let lineY = 0; lineY < 34; lineY += 2.6) {
      graphics.beginPath();
      graphics.moveTo(7, lineY);
      graphics.lineTo(9.6, lineY + 2.6);
      graphics.moveTo(9.6, lineY);
      graphics.lineTo(7, lineY + 2.6);
      graphics.stroke();
    }
    graphics.fillStyle = '#d9d4c7';
    graphics.fillRect(6.5, 34, 3.6, 2);
    const blds = [
      [-160, 46, 38, '#c9ccd1'],
      [-95, 22, 14, '#b4b9bf'],
      [-60, 12, 9, '#9da3aa'],
      [70, 30, 10, '#bfc3c8'],
      [110, 16, 22, '#aeb3b9'],
    ];
    for (const [buildingX, buildingWidth, buildingHeight, colour] of blds) {
      graphics.fillStyle = colour;
      graphics.fillRect(buildingX, -2, buildingWidth, buildingHeight + 2);
      graphics.strokeStyle = 'rgba(15,18,24,0.6)';
      graphics.strokeRect(buildingX, -2, buildingWidth, buildingHeight + 2);
      graphics.fillStyle = 'rgba(40,70,110,0.55)';
      for (let windowY = 3; windowY < buildingHeight - 2; windowY += 4) {
        for (let windowX = buildingX + 2; windowX < buildingX + buildingWidth - 3; windowX += 4) {
          graphics.fillRect(windowX, windowY, 2, 1.6);
        }
      }
    }
    graphics.fillStyle = '#2d4e7c';
    graphics.fillRect(-150, -2, 18, 26);
  }
  function scTile(tileIndex, pixelsPerMetre) {
    const key = `sc|${tileIndex}|${pixelsPerMetre}`;
    let atlasEntry = sprites.atlas.get(key);
    if (atlasEntry) {
      return atlasEntry;
    }
    const tileStartX = SC_X0 + tileIndex * SC_TILE;
    const image = FS.GL.bake(
      Math.round(SC_TILE * pixelsPerMetre),
      Math.round((SC_Y1 - SC_Y0) * pixelsPerMetre),
      (graphics) => {
        graphics.setTransform(
          pixelsPerMetre,
          0,
          0,
          -pixelsPerMetre,
          -tileStartX * pixelsPerMetre,
          SC_Y1 * pixelsPerMetre,
        ); // y up
        graphics.__px = 1 / pixelsPerMetre;
        drawSpaceCenterVector(graphics);
      },
    );
    return sprites.atlas.add(key, image);
  }
  function drawSpaceCenter(camera, body, time, pixelsPerMetre) {
    const angle = body.pad.lon + FS.bodyRot(body, time);
    const centre = FS.bodyAbs(body, time);
    const base = {
      x: centre.x + Math.cos(angle) * (body.R + body.pad.height),
      y: centre.y + Math.sin(angle) * (body.R + body.pad.height),
    };
    const baseScreen = worldToScreenPoint(camera, base.x, base.y);
    const reachPx = Math.hypot(viewWidth, viewHeight) / 2 + 200 * camera.s;
    if (Math.hypot(baseScreen.x - viewWidth / 2, baseScreen.y - viewHeight / 2) > reachPx) {
      return;
    }
    // pad frame on screen: +x along the ground (east), +y up
    const screenRotation = angle - Math.PI / 2 - camera.rot; // rotation of the pad's x axis, world → camera
    const size = (camera.s * pixelRatio) / pixelsPerMetre;
    for (let tileIndex = 0; tileIndex * SC_TILE + SC_X0 < SC_X1; tileIndex++) {
      const midX = SC_X0 + (tileIndex + 0.5) * SC_TILE;
      const midY = (SC_Y0 + SC_Y1) / 2;
      const cosRot = Math.cos(screenRotation);
      const sinRot = Math.sin(screenRotation);
      const worldX = midX * cosRot - midY * sinRot;
      const worldY = midX * sinRot + midY * cosRot; // camera-frame metres
      const screenX = baseScreen.x + worldX * camera.s;
      const screenY = baseScreen.y - worldY * camera.s;
      const tileRadius = (SC_TILE * 0.75 + (SC_Y1 - SC_Y0) * 0.5) * camera.s;
      if (
        screenX < -tileRadius ||
        screenY < -tileRadius ||
        screenX > viewWidth + tileRadius ||
        screenY > viewHeight + tileRadius
      ) {
        continue;
      }
      const entry = scTile(tileIndex, pixelsPerMetre);
      if (!entry) {
        continue;
      }
      sprites.sprite(
        entry,
        screenX * pixelRatio,
        screenY * pixelRatio,
        size,
        -screenRotation,
        entry.w / 2,
        entry.h / 2,
        null,
      );
    }
    // beacon on the tower top
    if (time % 2 < 1) {
      const beaconX = 8.4;
      const beaconY = 36.4;
      const cosRot = Math.cos(screenRotation);
      const sinRot = Math.sin(screenRotation);
      const worldX = beaconX * cosRot - beaconY * sinRot;
      const worldY = beaconX * sinRot + beaconY * cosRot;
      const beaconColour = Palette.ramps.red[0];
      block(
        (baseScreen.x + worldX * camera.s) * pixelRatio,
        (baseScreen.y - worldY * camera.s) * pixelRatio,
        Math.max(0.8 * camera.s * pixelRatio, size * 2),
        Math.max(0.8 * camera.s * pixelRatio, size * 2),
        -screenRotation,
        [beaconColour[0] / 255, beaconColour[1] / 255, beaconColour[2] / 255, 1],
      );
    }
  }

  // Pixel puffs for particles: discs n art pixels across, white with a lighter core
  // (tinted from a palette ramp when drawn).
  function puff(size) {
    const key = 'puff|' + size;
    let atlasEntry = sprites.atlas.get(key);
    if (atlasEntry) {
      return atlasEntry;
    }
    const puffCanvas = document.createElement('canvas');
    puffCanvas.width = puffCanvas.height = size;
    const graphics = puffCanvas.getContext('2d');
    const image = graphics.createImageData(size, size);
    const radius = size / 2;
    for (let pixelY = 0; pixelY < size; pixelY++) {
      for (let pixelX = 0; pixelX < size; pixelX++) {
        const deltaX = pixelX + 0.5 - radius;
        const deltaY = pixelY + 0.5 - radius;
        const distanceFraction = Math.hypot(deltaX, deltaY) / radius;
        if (distanceFraction > (size <= 2 ? 1.5 : 1)) {
          continue;
        }
        const brightness = distanceFraction < 0.45 ? 255 : distanceFraction < 0.8 ? 215 : 180;
        const byte = (pixelY * size + pixelX) * 4;
        image.data[byte] = image.data[byte + 1] = image.data[byte + 2] = brightness;
        image.data[byte + 3] = 255;
      }
    }
    graphics.putImageData(image, 0, 0);
    return sprites.atlas.add(key, puffCanvas);
  }

  // ---------- Vessels ----------
  function vesselFrame(camera, vessel, time) {
    const centre = Vector.add(FS.bodyAbs(vessel.body, time), vessel.r);
    return {
      sp: worldToScreenPoint(camera, centre.x, centre.y),
      th: -(vessel.angle - camera.rot) + Math.PI / 2,
    };
  }
  RenderGL.partToScreen = (camera, vessel, time, point) => {
    const frame = vesselFrame(camera, vessel, time);
    const scaledX = point.x * camera.s;
    const scaledY = -point.y * camera.s;
    const cosAngle = Math.cos(frame.th);
    const sinAngle = Math.sin(frame.th);
    return {
      x: frame.sp.x + scaledX * cosAngle - scaledY * sinAngle,
      y: frame.sp.y + scaledX * sinAngle + scaledY * cosAngle,
    };
  };
  RenderGL.screenToPart = (camera, vessel, time, screenX, screenY) => {
    const frame = vesselFrame(camera, vessel, time);
    const deltaX = (screenX - frame.sp.x) / camera.s;
    const deltaY = (screenY - frame.sp.y) / camera.s;
    const cosAngle = Math.cos(-frame.th);
    const sinAngle = Math.sin(-frame.th);
    return { x: deltaX * cosAngle - deltaY * sinAngle, y: -(deltaX * sinAngle + deltaY * cosAngle) };
  };

  function arrowSprite() {
    let atlasEntry = sprites.atlas.get('arrow');
    if (atlasEntry) {
      return atlasEntry;
    }
    const image = FS.GL.bake(
      9,
      9,
      (graphics) => {
        graphics.fillStyle = '#ffd27a';
        graphics.beginPath();
        graphics.moveTo(8.5, 4.5);
        graphics.lineTo(0.5, 0.5);
        graphics.lineTo(2.5, 4.5);
        graphics.lineTo(0.5, 8.5);
        graphics.closePath();
        graphics.fill();
      },
      0.5,
    );
    return sprites.atlas.add('arrow', image);
  }

  function drawVessel(camera, vessel, time, zoomLevel, tint) {
    const frame = vesselFrame(camera, vessel, time);
    const craftLength = vessel.layout.height * camera.s;
    const pixelsPerMetre = 16 / Math.pow(2, zoomLevel);
    if (craftLength < 6 || pixelsPerMetre < 0.25) {
      const arrowEntry = arrowSprite();
      const alpha = vessel.isDebris ? 0.6 : 1;
      if (arrowEntry) {
        sprites.sprite(
          arrowEntry,
          frame.sp.x * pixelRatio,
          frame.sp.y * pixelRatio,
          1.5 * pixelRatio,
          -(vessel.angle - camera.rot),
          4.5,
          4.5,
          [1, 1, 1, alpha],
        );
      }
      return;
    }
    const size = (camera.s * pixelRatio) / pixelsPerMetre;
    const drawAngle = frame.th;
    const toScreen = (drawX, drawY) => {
      // drawing frame (x, y down the rocket) → device px
      const cosAngle = Math.cos(drawAngle);
      const sinAngle = Math.sin(drawAngle);
      return {
        x: (frame.sp.x + (drawX * cosAngle - drawY * sinAngle) * camera.s) * pixelRatio,
        y: (frame.sp.y + (drawX * sinAngle + drawY * cosAngle) * camera.s) * pixelRatio,
      };
    };
    const chutes = vessel.parts.filter((part) => part.chute === 'semi' || part.chute === 'full');
    if (chutes.length) {
      const chutePart = chutes[0];
      const chuteTip = Vector.add(chutePart.c, Vector.scale(chutePart.axis, chutePart.len / 2));
      const chuteEntry = chuteSprite(
        chutes.some((part) => part.chute === 'full'),
        pixelsPerMetre,
      );
      if (chuteEntry) {
        const screenAt = toScreen(chuteTip.x, -chuteTip.y);
        sprites.sprite(
          chuteEntry,
          screenAt.x,
          screenAt.y,
          size,
          drawAngle,
          chuteEntry.ox,
          chuteEntry.oy,
          tint,
        );
      }
    }
    const glowMap = new Map();
    if (vessel.nozzles) {
      vessel.nozzles.forEach((nozzle) => glowMap.set(nozzle.part, nozzle.power));
    }
    const sunlit = Math.round(lightAt(vessel) *4) / 4;
    const SUN_STEP = FS.TAU / 32;
    const noTint = [1, 1, 1, tint ? tint[3] : 1];
    for (const part of vessel.parts) {
      const glow = Math.round((glowMap.get(part) || 0) *2) /2;
      const noseAngle = vessel.angle + part.rot;
      const sunStep = ((Math.round(noseAngle / SUN_STEP)%32)+32)%32;
      const atlasEntry = partSprite(part, pixelsPerMetre, glow, sunStep, sunlit);
      if (!atlasEntry) {
        continue;

      }
      const screenAt = toScreen(part.c.x, -part.c.y);
      const spriteTint = atlasEntry.lit ? noTint : tint;
      sprites.sprite(atlasEntry, screenAt.x, screenAt.y, size, drawAngle - part.rot, atlasEntry.ox, atlasEntry.oy, spriteTint, !!part.flip);

    }
  }

  // ---------- Particles ----------
  const FIRE = [
    Palette.ramps.gold[4],
    Palette.ramps.gold[3],
    Palette.ramps.orange[4],
    Palette.ramps.orange[3],
    Palette.ramps.orange[2],
    Palette.ramps.orange[1],
  ];
  const BLUE = [Palette.ramps.blue[7], Palette.ramps.blue[6], Palette.ramps.blue[5], Palette.ramps.blue[4]];
  const SMOKE = [
    Palette.ramps.metal[7],
    Palette.ramps.metal[6],
    Palette.ramps.metal[6],
    Palette.ramps.metal[5],
    Palette.ramps.metal[4],
  ];
  const rampAt = (ramp, fraction) => ramp[Math.min(ramp.length - 1, Math.floor(fraction * ramp.length))];

  function drawParticles(camera, body, time, cell, tint) {
    const base = FS.bodyAbs(body, time);
    const list = FS.Render.particles;
    for (const pass of ['smoke', 'fire']) {
      for (const particle of list) {
        const smoke = particle.kind === 'smoke';
        if ((pass === 'smoke') !== smoke) {
          continue;
        }
        const lifeFraction = particle.life / particle.max;
        const sizeM = particle.size + particle.grow * particle.life;
        const size = FS.clamp(Math.round(sizeM / cell), 1, 40);
        const screenPoint = worldToScreenPoint(camera, base.x + particle.x, base.y + particle.y);
        const radiusPixels = size * cell * camera.s;
        if (
          screenPoint.x < -radiusPixels ||
          screenPoint.y < -radiusPixels ||
          screenPoint.x > viewWidth + radiusPixels ||
          screenPoint.y > viewHeight + radiusPixels
        ) {
          continue;
        }
        const puffEntry = puff(size);
        if (!puffEntry) {
          continue;
        }
        const colour = smoke
          ? rampAt(SMOKE, lifeFraction)
          : particle.kind === 'blue'
            ? rampAt(BLUE, lifeFraction)
            : rampAt(FIRE, lifeFraction);
        const particleTint = smoke ? tint : [1, 1, 1];
        const alpha = smoke
          ? (1 - lifeFraction) * 0.75
          : Math.max(0.05, (1 - lifeFraction) * (1 - lifeFraction) * 1.1);
        sprites.sprite(
          puffEntry,
          screenPoint.x * pixelRatio,
          screenPoint.y * pixelRatio,
          cell * camera.s * pixelRatio,
          -camera.rot * 0,
          size / 2,
          size / 2,
          [
            (colour[0] / 255) * particleTint[0],
            (colour[1] / 255) * particleTint[1],
            (colour[2] / 255) * particleTint[2],
            alpha,
          ],
        );
      }
    }
  }

  // Reentry: a pixel glow ahead of the craft and streaks behind it.
  function drawReentry(camera, vessel, time, cell) {
    if (vessel.heat <= 0.01) {
      return;
    }
    const body = vessel.body;
    const vAir = Vector.sub(vessel.v, FS.airVel(body, vessel.r));
    const direction = Vector.norm(vAir);
    const centre = Vector.add(FS.bodyAbs(body, time), vessel.r);
    const lead = Vector.add(centre, Vector.scale(direction, vessel.layout.height * 0.45));
    const screenPoint = worldToScreenPoint(camera, lead.x, lead.y);
    const size = FS.clamp(Math.round((vessel.layout.height * 0.9) / cell), 3, 40);
    const puffEntry = puff(size);
    const heat = vessel.heat;
    const colour = rampAt(FIRE, 1 - heat);
    if (puffEntry) {
      sprites.sprite(
        puffEntry,
        screenPoint.x * pixelRatio,
        screenPoint.y * pixelRatio,
        cell * camera.s * pixelRatio,
        0,
        size / 2,
        size / 2,
        [colour[0] / 255, colour[1] / 255, colour[2] / 255, heat * 0.9],
      );
    }
    const trailPoint = worldToScreenPoint(camera, lead.x - direction.x * 40, lead.y - direction.y * 40);
    const angle = Math.atan2(trailPoint.y - screenPoint.y, trailPoint.x - screenPoint.x);
    const trailLength = Math.hypot(trailPoint.x - screenPoint.x, trailPoint.y - screenPoint.y);
    const thick = Math.max(1, cell * camera.s) * pixelRatio;
    const streakColour = rampAt(FIRE, 0.4);
    for (let streak = -2; streak <= 2; streak++) {
      const offset = streak * size * cell * camera.s * 0.25;
      const offsetX = -Math.sin(angle) * offset;
      const offsetY = Math.cos(angle) * offset;
      block(
        (screenPoint.x + offsetX + (Math.cos(angle) * trailLength) / 2) * pixelRatio,
        (screenPoint.y + offsetY + (Math.sin(angle) * trailLength) / 2) * pixelRatio,
        trailLength * pixelRatio * (0.6 + 0.4 * Math.random()),
        thick,
        angle,
        [streakColour[0] / 255, streakColour[1] / 255, streakColour[2] / 255, heat * 0.7],
      );
    }
  }

  // ---------- Flight view ----------
  function sunlight(localUp) {
    return FS.smoothstep(-0.12, 0.25, Vector.dot(localUp, FS.SUN_DIR));
  }
  const mixColours = (first, second, fraction) => [
    first[0] + (second[0] - first[0]) * fraction,
    first[1] + (second[1] - first[1]) * fraction,
    first[2] + (second[2] - first[2]) * fraction,
  ];

  // How sunlit the craft is: dark in a planet's shadow, dimmer towards dusk in the air.
  function lightAt(vessel) {
    const body = vessel.body;
    const sunDirection = FS.SUN_DIR;
    const along = Vector.dot(vessel.r, sunDirection);
    const offsetFromLine = Math.abs(Vector.cross(vessel.r, sunDirection));
    let lightLevel = along < 0 && offsetFromLine < body.R ? 0 : 1;
    if (body.atmo && vessel.altitude < body.atmo.height) {
      lightLevel = Math.min(1, sunlight(Vector.norm(vessel.r)) * 1.25);
    }
    return lightLevel;
  }

  RenderGL.drawFlight = (theGame) => {
    const vessel = theGame.vessel;
    const time = theGame.t;
    const camera = theGame.cam;
    const currentBody = vessel.body;
    const zoomLevel = levelFor(camera.s);
    const cell = Math.pow(2, zoomLevel) / 16;
    frameInfo.level = zoomLevel;
    sprites.draws = 0;
    webgl.viewport(0, 0, viewCanvas.width, viewCanvas.height);
    // sky
    const altitude = vessel.altitude;
    const localUp = Vector.norm(vessel.r);
    const light = sunlight(localUp);
    let skyT = 1;
    if (currentBody.atmo) {
      skyT = FS.clamp(Math.pow(Math.max(altitude, 0) / currentBody.atmo.height, 0.55), 0, 1);
    }
    const sunsetK = currentBody.atmo
      ? (1 - skyT) * Math.exp(-Math.pow(Vector.dot(localUp, FS.SUN_DIR) / 0.18, 2))
      : 0;
    const daylight = currentBody.atmo ? (1 - skyT) * light : 0;
    const top = mixColours([6, 9, 20], [58, 118, 196], daylight);
    const horizonColour = mixColours(
      mixColours([8, 12, 26], [140, 190, 236], daylight),
      [236, 132, 72],
      sunsetK * 0.8,
    );
    const starA = 1 - daylight * 1.15;
    drawSky(skyStops(top, horizonColour), FS.clamp(starA * 1.6 - 0.6, 0, 1) * 0.55, -camera.rot + 0.6);
    sprites.begin(viewCanvas.width, viewCanvas.height);
    drawStars(camera, starA, true, time);
    sprites.flush();
    // bodies, farthest first
    camera.body = currentBody;
    const order = FS.bodies
      .slice()
      .sort(
        (first, second) =>
          Vector.len(Vector.sub(FS.bodyAbs(second, time), camera)) -
          Vector.len(Vector.sub(FS.bodyAbs(first, time), camera)),
      );
    const pixelsPerMetre = 16 / Math.pow(2, Math.min(zoomLevel, 6));
    for (const body of order) {
      const near = drawBody(camera, body, time, zoomLevel);
      if (near && body.pad) {
        sprites.begin(viewCanvas.width, viewCanvas.height);
        drawSpaceCenter(camera, body, time, pixelsPerMetre);
        sprites.flush();
      }
    }
    // the craft, its debris and its exhaust
    const lightLevel = lightAt(vessel);
    const night = [0.34, 0.38, 0.6];
    const tint = mixColours(night, [1, 1, 1], lightLevel);
    const tintA = [tint[0], tint[1], tint[2], 1];
    sprites.begin(viewCanvas.width, viewCanvas.height);
    drawParticles(camera, currentBody, time, cell, tint);
    for (const debrisVessel of theGame.debris) {
      if (!debrisVessel.dead) {
        drawVessel(camera, debrisVessel, time, zoomLevel, tintA);
      }
    }
    if (!vessel.dead) {
      drawVessel(camera, vessel, time, zoomLevel, tintA);
      drawReentry(camera, vessel, time, cell);
    }
    sprites.flush();
    frameInfo.draws = sprites.draws;
    overlayContext.setTransform(1, 0, 0, 1, 0, 0);
    overlayContext.clearRect(0, 0, overlay.width, overlay.height);
  };

  // ---------- Map view ----------
  const PATCH_COLORS = ['#55d6ff', '#ffb547', '#ff6fb1'];

  RenderGL.drawMap = (theGame) => {
    const time = theGame.t;
    const camera = theGame.mapCam;
    const zoomLevel = levelFor(camera.s);
    frameInfo.level = zoomLevel;
    sprites.draws = 0;
    webgl.viewport(0, 0, viewCanvas.width, viewCanvas.height);
    drawSky([Palette.ramps.night[0]], 0.4, 0.6);
    sprites.begin(viewCanvas.width, viewCanvas.height);
    drawStars(camera, 0.8, false, time);
    sprites.flush();
    camera.body = null;
    for (const body of FS.bodies) {
      drawBody(camera, body, time, zoomLevel);
    }
    frameInfo.draws = sprites.draws;

    // lines, markers and labels on the overlay
    const context = overlayContext;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, viewWidth, viewHeight);
    for (const body of FS.bodies) {
      if (!body.parent) {
        continue;
      }
      const parentCentre = FS.bodyAbs(body.parent, time);
      const screenPoint = worldToScreenPoint(camera, parentCentre.x, parentCentre.y);
      context.strokeStyle = 'rgba(150,170,210,0.22)';
      context.lineWidth = 1;
      context.beginPath();
      context.arc(screenPoint.x, screenPoint.y, body.a * camera.s, 0, FULL_TURN);
      context.stroke();
      const bodyCentre = FS.bodyAbs(body, time);
      const bodyScreen = worldToScreenPoint(camera, bodyCentre.x, bodyCentre.y);
      if (body.soi * camera.s > 6) {
        context.setLineDash([4, 6]);
        context.strokeStyle = 'rgba(150,170,210,0.28)';
        context.beginPath();
        context.arc(bodyScreen.x, bodyScreen.y, body.soi * camera.s, 0, FULL_TURN);
        context.stroke();
        context.setLineDash([]);
      }
    }
    context.font = '600 12px "Saira Semi Condensed", "Arial Narrow", sans-serif';
    context.textAlign = 'center';
    for (const body of FS.bodies) {
      const bodyCentre = FS.bodyAbs(body, time);
      const bodyScreen = worldToScreenPoint(camera, bodyCentre.x, bodyCentre.y);
      context.fillStyle = 'rgba(214,224,245,0.85)';
      context.fillText(
        body.name.toUpperCase(),
        bodyScreen.x,
        bodyScreen.y + Math.max(body.R * camera.s, 4) + 16,
      );
    }
    const vessel = theGame.vessel;
    if (!vessel.dead && !vessel.landed) {
      drawPatches(context, camera, theGame.patches, time, false);
      if (theGame.node && theGame.nodePatches) {
        drawPatches(context, camera, theGame.nodePatches, time, true, theGame.node.originT);
      }
    }
    if (theGame.node) {
      const node = theGame.node;
      const position = Vector.add(FS.bodyAbs(node.body, node.originT ?? time), node.r);
      const screenPoint = worldToScreenPoint(camera, position.x, position.y);
      context.save();
      context.translate(screenPoint.x, screenPoint.y);
      context.rotate(Math.PI / 4);
      context.fillStyle = '#4f8dff';
      context.strokeStyle = '#d8e6ff';
      context.lineWidth = 1.5;
      context.fillRect(-6, -6, 12, 12);
      context.strokeRect(-6, -6, 12, 12);
      context.restore();
    }
    if (!vessel.dead) {
      const vesselPosition = Vector.add(FS.bodyAbs(vessel.body, time), vessel.r);
      const screenPoint = worldToScreenPoint(camera, vesselPosition.x, vesselPosition.y);
      context.save();
      context.translate(screenPoint.x, screenPoint.y);
      context.rotate(-vessel.angle);
      context.fillStyle = '#ffd27a';
      context.strokeStyle = '#1a1405';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(9, 0);
      context.lineTo(-6, 5.5);
      context.lineTo(-3, 0);
      context.lineTo(-6, -5.5);
      context.closePath();
      context.fill();
      context.stroke();
      context.restore();
    }
  };

  function drawPatches(context, camera, patches, time, planned, firstRef) {
    if (!patches) {
      return;
    }
    patches.forEach((patch, index) => {
      const orbit = patch.orbit;
      const tRef = index === 0 ? (firstRef ?? time) : patch.tStart;
      const origin = FS.bodyAbs(patch.body, tRef);
      const startTime = Math.max(patch.tStart, index === 0 ? time : patch.tStart);
      const points = FS.sampleOrbit(orbit, startTime, patch.tEnd, 360);
      context.strokeStyle = PATCH_COLORS[index % PATCH_COLORS.length];
      context.lineWidth = planned ? 1.6 : 2;
      context.globalAlpha = planned ? 0.85 : 1;
      if (planned) {
        context.setLineDash([7, 5]);
      }
      context.beginPath();
      points.forEach((point, pointIndex) => {
        const screenPoint = worldToScreenPoint(camera, origin.x + point.x, origin.y + point.y);
        pointIndex
          ? context.lineTo(screenPoint.x, screenPoint.y)
          : context.moveTo(screenPoint.x, screenPoint.y);
      });
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
      if (index > 0 && patch.body.parent) {
        const screenPoint = worldToScreenPoint(camera, origin.x, origin.y);
        context.strokeStyle = 'rgba(255,255,255,0.3)';
        context.beginPath();
        context.arc(screenPoint.x, screenPoint.y, Math.max(patch.body.R * camera.s, 4), 0, FULL_TURN);
        context.stroke();
      }
      if (planned) {
        return;
      }
      const body = patch.body;
      const mark = (trueAnomaly, label, value) => {
        const dtTo = FS.timeToNu(orbit, trueAnomaly, startTime);
        if (!isFinite(dtTo) || startTime + dtTo > patch.tEnd) {
          return;
        }
        const state = FS.orbitState(orbit, startTime + dtTo);
        marker(
          context,
          worldToScreenPoint(camera, origin.x + state.r.x, origin.y + state.r.y),
          label,
          FS.fmtDist(value),
        );
      };
      if (orbit.e > 1e-4) {
        if (orbit.e < 1) {
          mark(Math.PI, 'Ap', orbit.ap - body.R);
        }
        if (orbit.pe > body.R * 0.2) {
          mark(0, 'Pe', orbit.pe - body.R);
        }
      }
      const end = points[points.length - 1];
      if (patch.end && end) {
        const screenPoint = worldToScreenPoint(camera, origin.x + end.x, origin.y + end.y);
        const label =
          patch.end === 'encounter'
            ? patch.next.name + ' encounter'
            : patch.end === 'escape'
              ? 'Escape'
              : 'Impact';
        marker(
          context,
          screenPoint,
          label,
          FS.fmtTime(patch.tEnd - time),
          patch.end === 'impact' ? '#ff6b5a' : '#c7d6ff',
        );
      }
    });
  }

  function marker(context, screenPoint, label, value, colour = '#ffe2a6') {
    context.fillStyle = colour;
    context.beginPath();
    context.arc(screenPoint.x, screenPoint.y, 3.5, 0, FULL_TURN);
    context.fill();
    context.font = '600 11px "IBM Plex Mono", ui-monospace, monospace';
    context.textAlign = 'left';
    context.fillStyle = 'rgba(5,7,15,0.7)';
    const text = label + '  ' + value;
    const textWidth = context.measureText(text).width;
    context.fillRect(screenPoint.x + 7, screenPoint.y - 16, textWidth + 8, 16);
    context.fillStyle = colour;
    context.fillText(text, screenPoint.x + 11, screenPoint.y - 4);
  }

  // For the gallery: draw a part sprite at L art pixels per metre.
  RenderGL.galleryPart = (part, pixelsPerMetre, glow) => partSprite(part, pixelsPerMetre, glow);
  RenderGL.sprites = () => sprites;
})();
