// render-gl.js — the WebGL2 renderer (step B1). Same interface as render.js (see there);
// main.js picks this one when the browser has WebGL2 and falls back to the Canvas 2D one
// otherwise.
//
// One pixel grid for the whole world. Everything in the world is drawn in "art pixels"
// whose size in metres is (1/16) × 2^level: at the closest zoom 16 per metre, as the art is
// authored, then 8, 4, 2… as you zoom out, so an art pixel never gets smaller than the
// chosen pixel size on screen (1.5–3 CSS pixels, a setting). Parts, terrain, planets and
// particles all use the same level, so pixels of different sizes never sit side by side.
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
  const Vector = Flatspace.Vector;
  const FULL_TURN = Flatspace.TAU;
  const Palette = Flatspace.Palette;
  const RenderGL = (Flatspace.RenderGL = {});

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
  const heightTextures = new Map(); // body → full-circle height texture
  let windowTexture = null; // heights around the camera, refreshed every frame
  const FULL_CIRCLE_SAMPLES = 4096;
  const WINDOW_SAMPLES = 1024;
  let pixelSize = 1.5; // smallest art pixel on screen, CSS px (setting)
  let frameInfo = { level: 0, draws: 0 };

  RenderGL.setPixelSize = (size) => {
    pixelSize = Flatspace.clamp(size, 1, 3);
  };
  RenderGL.pixelSize = () => pixelSize;

  // ---------- Set-up ----------
  RenderGL.initialise = (canvas, theGame) => {
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
    sprites = new Flatspace.WebGL.Sprites(webgl, Math.min(2048, webgl.getParameter(webgl.MAX_TEXTURE_SIZE)));
    skyShader = Flatspace.WebGL.fullscreen(webgl, SKY_FS);
    planet = Flatspace.WebGL.fullscreen(webgl, PLANET_FS);
    windowTexture = makeHeightTexture(WINDOW_SAMPLES);
    const random = Flatspace.seededRandom(4242);
    const starColours = [
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
        brightness: 0.3 + random() * 0.7,
        colour: starColours[Math.floor(random() * starColours.length)].map((channel) => channel / 255),
        twinkle: random() < 0.05 ? random() * FULL_TURN : null, // a few twinkle
      });
    }
    if (Flatspace.Render.subscribe && theGame) {
      Flatspace.Render.subscribe(theGame);
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
  RenderGL.size = () => ({ width: viewWidth, height: viewHeight });

  // Particles are simulated by the shared code in render.js; only drawing differs.
  RenderGL.update = (theGame) => Flatspace.Render.update(theGame);
  RenderGL.stats = () => ({
    particles: Flatspace.Render.particles.length,
    level: frameInfo.level,
    draws: frameInfo.draws,
    atlas: sprites ? Math.round(sprites.atlas.used() * 100) + '%' : '',
  });

  // ---------- Camera ----------
  function worldToScreenPoint(camera, x, y) {
    const deltaX = x - camera.x;
    const deltaY = y - camera.y;
    const cosRotation = Math.cos(camera.rotation);
    const sinRotation = Math.sin(camera.rotation);
    return {
      x: viewWidth / 2 + (deltaX * cosRotation + deltaY * sinRotation) * camera.scale,
      y: viewHeight / 2 - (-deltaX * sinRotation + deltaY * cosRotation) * camera.scale,
    };
  }
  RenderGL.worldToScreen = worldToScreenPoint;

  // The art-pixel level for a zoom: art pixels are (1/16)·2^level metres.
  function levelFor(cameraScale) {
    let level = 0;
    while (level < 60 && (cameraScale * Math.pow(2, level)) / 16 < pixelSize) {
      level++;
    }
    return level;
  }

  // ---------- Sky ----------
  const SKY_FS = `#version 300 es
    precision highp float;
    uniform vec2 resolution;
    uniform float pixelSize;
    uniform vec3 skyColours[8];
    uniform int skyColourCount;
    uniform float galaxyStrength;
    uniform float galaxyAngle;
    uniform vec3 galaxyColours[2];
    out vec4 fragmentColour;
    ${Flatspace.WebGL.GLSL_BAYER}
    float hash(float seed) { return fract(sin(seed * 12.9898) * 43758.5453); }
    float valueNoise(float position) { float stopIndex = floor(position), blend = fract(position); blend = blend * blend * (3.0 - 2.0 * blend); return mix(hash(stopIndex), hash(stopIndex + 1.0), blend); }
    void main() {
      vec2 cell = floor(vec2(gl_FragCoord.x, resolution.y - gl_FragCoord.y) / pixelSize);
      vec2 mid = (cell + 0.5) * pixelSize;
      float screenHeight = clamp(mid.y / resolution.y, 0.0, 1.0);
      float blend = screenHeight * float(skyColourCount - 1);
      int stopIndex = int(floor(blend));
      vec3 colour = (stepUp(fract(blend), cell) && stopIndex + 1 < skyColourCount) ? skyColours[stopIndex + 1] : skyColours[stopIndex];
      if (galaxyStrength > 0.0) {
        vec2 point = (mid - resolution * 0.5) / resolution.y;
        vec2 seed = vec2(-sin(galaxyAngle), cos(galaxyAngle));
        float across = dot(point, seed), along = dot(point, vec2(seed.y, -seed.x));
        float density = exp(-across * across / 0.012) * (0.45 + 0.55 * valueNoise(along * 7.0 + 3.0)) * (0.6 + 0.4 * valueNoise(along * 23.0 + across * 9.0));
        float galaxyAmount = density * galaxyStrength;
        if (galaxyAmount > bayer4(cell) * 1.4) colour = galaxyAmount > 0.55 ? galaxyColours[1] : galaxyColours[0];
      }
      fragmentColour = vec4(colour, 1.0);
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

  function drawSky(stops, galaxyStrength, galaxyAngle) {
    webgl.useProgram(skyShader.program);
    webgl.uniform2f(skyShader.uniforms.resolution, viewCanvas.width, viewCanvas.height);
    webgl.uniform1f(skyShader.uniforms.pixelSize, Math.max(1, pixelSize * pixelRatio));
    Flatspace.WebGL.rampUniform(webgl, skyShader.uniforms.skyColours, stops, 8);
    webgl.uniform1i(skyShader.uniforms.skyColourCount, stops.length);
    webgl.uniform1f(skyShader.uniforms.galaxyStrength, galaxyStrength);
    webgl.uniform1f(skyShader.uniforms.galaxyAngle, galaxyAngle);
    Flatspace.WebGL.rampUniform(
      webgl,
      skyShader.uniforms.galaxyColours,
      [Palette.ramps.night[2], Palette.ramps.night[3]],
      2,
    );
    webgl.disable(webgl.BLEND);
    skyShader.draw();
  }

  // Pixel stars: one or two art pixels each, turning with the camera.
  function drawStars(camera, alpha, rotate, time) {
    if (alpha <= 0.02) {
      return;
    }
    const skyRadius = Math.hypot(viewWidth, viewHeight) * 0.55;
    const rotation = rotate ? camera.rotation : 0;
    const cosRotation = Math.cos(-rotation);
    const sinRotation = Math.sin(-rotation);
    const dotSize = Math.max(1, pixelSize) * pixelRatio;
    for (const star of stars) {
      const starX = viewWidth / 2 + (star.x * cosRotation - star.y * sinRotation) * skyRadius;
      const starY = viewHeight / 2 + (star.x * sinRotation + star.y * cosRotation) * skyRadius;
      if (starX < -4 || starY < -4 || starX > viewWidth + 4 || starY > viewHeight + 4) {
        continue;
      }
      let starAlpha = star.brightness * alpha;
      if (star.twinkle !== null) {
        starAlpha *= Math.sin(time * 2.3 + star.twinkle) > 0.3 ? 1 : 0.45;
      }
      block(
        starX * pixelRatio,
        starY * pixelRatio,
        star.big ? dotSize * 2 : dotSize,
        star.big ? dotSize * 2 : dotSize,
        -rotation,
        [star.colour[0], star.colour[1], star.colour[2], starAlpha],
      );
    }
  }

  // A solid rectangle width × height device px centred at (x, y), turned by angle, with crisp edges.
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
    sprites.drawQuad(
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
    return { texture, sampleCount, data: new Float32Array(sampleCount) };
  }
  function uploadHeights(heights) {
    webgl.bindTexture(webgl.TEXTURE_2D, heights.texture);
    webgl.texSubImage2D(
      webgl.TEXTURE_2D,
      0,
      0,
      0,
      heights.sampleCount,
      1,
      webgl.RED,
      webgl.FLOAT,
      heights.data,
    );
  }
  function fullHeights(body) {
    let heights = heightTextures.get(body);
    if (!heights) {
      heights = makeHeightTexture(FULL_CIRCLE_SAMPLES);
      for (let sampleIndex = 0; sampleIndex < FULL_CIRCLE_SAMPLES; sampleIndex++) {
        heights.data[sampleIndex] = Flatspace.terrainHeight(
          body,
          (sampleIndex / FULL_CIRCLE_SAMPLES) * FULL_TURN,
        );
      }
      uploadHeights(heights);
      heightTextures.set(body, heights);
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
      strataA: pick(Palette.ramps.earth, 0, 1, 2, 3, 4),
      strataB: [
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
      atmosphere: pick(Palette.ramps.blue, 3, 4, 5, 6, 7),
    }),
    Mira: () => ({
      land: pick(Palette.ramps.metal, 1, 2, 3, 4, 5),
      sand: pick(Palette.ramps.metal, 1, 2, 3, 4, 5),
      rock: pick(Palette.ramps.metal, 2, 3, 4, 5, 6),
      snow: pick(Palette.ramps.metal, 2, 3, 4, 5, 6),
      soil: pick(Palette.ramps.metal, 0, 1, 2, 3, 4),
      strataA: pick(Palette.ramps.metal, 0, 1, 2, 3, 4),
      strataB: [
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
      atmosphere: pick(Palette.ramps.metal, 3, 4, 5, 6, 7),
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
      strataA: [
        Palette.ramps.night[1],
        Palette.ramps.night[2],
        Palette.ramps.teal[0],
        Palette.ramps.teal[1],
        Palette.ramps.teal[2],
      ],
      strataB: [
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
      atmosphere: pick(Palette.ramps.teal, 0, 1, 2, 3, 3),
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
    uniform vec2 resolution;        // device px
    uniform float cameraScale;      // device px per metre
    uniform float cameraRotation;
    uniform float cellSize;      // art pixel, metres
    uniform int mode;        // 0: whole body (cells in the body's turning frame), 1: close to the ground
    uniform vec2 bodyCentre;          // body centre relative to the camera (mode 0)
    uniform float bodyRotation;
    uniform vec2 up;         // mode 1: up at the camera
    uniform float cameraAltitude;    // mode 1: camera height above datum
    uniform float cameraDistance;        // mode 1: camera distance from the centre
    uniform float cameraAlong;        // mode 1: the camera's position along the ground (wrapped)
    uniform float cameraLongitude;    // mode 1: body-fixed longitude under the camera
    uniform float span;      // mode 1: the height window covers ±span radians
    uniform sampler2D heights;
    uniform int heightCount;
    uniform float radius;
    uniform float atmosphereHeight;
    uniform int hasOcean;
    uniform float snowHeight, rockHeight, amplitude;
    uniform vec2 sunDirection;
    uniform float drawRim;       // draw the atmosphere rim (1) or not (0)
    uniform vec3 landColours[5], sandColours[5], rockColours[5], snowColours[5], soilColours[5], strataColoursA[5], strataColoursB[5], deepColours[5], oceanColours[6], atmosphereColours[5];
    out vec4 fragmentColour;
    ${Flatspace.WebGL.GLSL_BAYER}
    float hash(float seed) { return fract(sin(seed * 12.9898) * 43758.5453); }

    float heightAt(float position) { // x in texels, wraps
      float count = float(heightCount);
      position = mod(position, count);
      float whole = floor(position);
      int leftIndex = int(whole), rightIndex = int(mod(whole + 1.0, count));
      return mix(texelFetch(heights, ivec2(leftIndex, 0), 0).r, texelFetch(heights, ivec2(rightIndex, 0), 0).r, position - whole);
    }
    vec2 currentCell;
    vec3 ramp5(vec3 colours[5], float position, float threshold) {
      float scaled = clamp(position, 0.0, 1.0) * 4.0;
      int index = int(floor(scaled));
      return (stepUp(fract(scaled), currentCell) && index < 4) ? colours[index + 1] : colours[index];
    }
    vec3 ramp6(vec3 colours[6], float position, float threshold) {
      float scaled = clamp(position, 0.0, 1.0) * 5.0;
      int index = int(floor(scaled));
      return (stepUp(fract(scaled), currentCell) && index < 5) ? colours[index + 1] : colours[index];
    }

    void main() {
      // screen → metres from the camera, in the world frame
      vec2 screenPoint = vec2(gl_FragCoord.x, resolution.y - gl_FragCoord.y);
      vec2 fromCamera = vec2(screenPoint.x - resolution.x * 0.5, -(screenPoint.y - resolution.y * 0.5)) / cameraScale;
      float cosRotation = cos(cameraRotation), sinRotation = sin(cameraRotation);
      vec2 worldOffset = vec2(fromCamera.x * cosRotation - fromCamera.y * sinRotation, fromCamera.x * sinRotation + fromCamera.y * cosRotation);

      float altitude, groundHeight, along, light;
      vec2 cell;
      if (mode == 0) {
        vec2 fromBody = worldOffset - bodyCentre;
        float cosBody = cos(-bodyRotation), sinBody = sin(-bodyRotation);
        vec2 bodyPoint = vec2(fromBody.x * cosBody - fromBody.y * sinBody, fromBody.x * sinBody + fromBody.y * cosBody);
        cell = floor(bodyPoint / cellSize);
        vec2 cellCentre = (cell + 0.5) * cellSize;
        float centreDistance = length(cellCentre);
        altitude = centreDistance - radius;
        if (altitude > atmosphereHeight * 1.4 + amplitude * 1.5 + cellSize * 2.0) discard;
        float longitude = atan(cellCentre.y, cellCentre.x);
        groundHeight = heightAt(longitude / 6.28318530718 * float(heightCount));
        along = longitude * radius;
        float cosAngle = cos(bodyRotation), sinAngle = sin(bodyRotation);
        vec2 worldNormal = vec2(cellCentre.x * cosAngle - cellCentre.y * sinAngle, cellCentre.x * sinAngle + cellCentre.y * cosAngle) / centreDistance;
        light = dot(worldNormal, sunDirection);
      } else {
        vec2 tangent = vec2(-up.y, up.x);
        float upDistance = dot(worldOffset, up), sideDistance = dot(worldOffset, tangent);
        float heightAboveDatum = cameraAltitude + upDistance + sideDistance * sideDistance / (2.0 * (cameraDistance + upDistance));
        float angle = atan(sideDistance, cameraDistance + upDistance);
        float alongGround = cameraAlong + angle * radius;
        cell = vec2(floor(alongGround / cellSize), floor(heightAboveDatum / cellSize));
        altitude = (cell.y + 0.5) * cellSize;
        float cellAngle = ((cell.x + 0.5) * cellSize - cameraAlong) / radius;
        if (altitude > amplitude * 1.5 + 10.0) discard;
        groundHeight = heightAt((cellAngle / span * 0.5 + 0.5) * float(heightCount - 1));
        along = (cameraLongitude + cellAngle) * radius;
        float cosAngle = cos(cellAngle), sinAngle = sin(cellAngle);
        vec2 worldNormal = vec2(up.x * cosAngle - up.y * sinAngle, up.x * sinAngle + up.y * cosAngle);
        light = dot(worldNormal, sunDirection);
      }
      float threshold = bayer4(cell);
      currentCell = cell;
      float daylight = smoothstep(-0.12, 0.25, light);      // 0 night … 1 day
      float shade = 0.12 + 0.62 * daylight;                // position on a ramp

      vec3 colour;
      // from afar, oceans cover the band where the sea floor would show
      bool farSea = mode == 0 && hasOcean == 1 && groundHeight < 0.0 && altitude < 0.0 && -altitude < max(radius * 0.035, cellSize * 6.0);
      if (altitude > groundHeight || farSea) {
        if (hasOcean == 1 && altitude < 0.0) {
          // water: lighter near the surface, a foam line on top
          float depth = -altitude;
          float depthFraction = clamp(depth / max(80.0, cellSize * 10.0), 0.0, 1.0);
          float shadePosition = (1.0 - depthFraction) * (0.25 + 0.6 * daylight);
          if (depth < cellSize * 1.01 && daylight > 0.2) shadePosition = 0.95;
          colour = ramp6(oceanColours, shadePosition, threshold);
        } else if (mode == 0 && drawRim > 0.5 && atmosphereHeight > 0.0) {
          // atmosphere rim: thins out with height, dimmer on the night side
          float above = altitude - max(groundHeight, 0.0);
          float density = exp(-above / (atmosphereHeight * 0.3));
          float cover = density * (0.18 + 0.82 * smoothstep(-0.35, 0.3, light));
          if (cover * 0.95 <= threshold) discard;
          colour = ramp5(atmosphereColours, density * (0.35 + 0.65 * daylight), threshold);
        } else discard;
      } else {
        float depth = groundHeight - altitude;
        float wobble = (3.0 * sin(along * 0.004) + 1.5 * sin(along * 0.017 + 1.0)) * max(1.0, cellSize);
        float top = max(0.6, cellSize * 1.5);
        float soil = max(5.0, cellSize * 4.0);
        if (mode == 0) { top = max(top, radius * 0.012); soil = max(soil, radius * 0.022); }
        float bandThickness = max(7.0, cellSize * 3.0);
        if (mode == 0 && depth > max(radius * 0.035, cellSize * 6.0)) {
          // the body's interior seen from afar
          colour = ramp5(deepColours, 0.15 + 0.55 * daylight, threshold);
        } else if (depth < top) {
          float tuft = hash(floor(along / cellSize)) > 0.72 && depth < cellSize * 1.01 ? 0.18 : 0.0;
          if (hasOcean == 1 && groundHeight < 40.0) colour = ramp5(sandColours, shade + tuft, threshold);
          else if (groundHeight > snowHeight) colour = ramp5(snowColours, shade + 0.15 + tuft, threshold);
          else if (groundHeight > rockHeight) colour = ramp5(rockColours, shade + tuft, threshold);
          else colour = ramp5(landColours, shade + tuft, threshold);
        } else if (depth < soil + wobble * 0.3) {
          colour = ramp5(soilColours, shade * 0.9, threshold);
        } else {
          float band = floor((depth + wobble) / bandThickness);
          colour = mod(band, 2.0) < 1.0 ? ramp5(strataColoursA, shade * 0.85, threshold) : ramp5(strataColoursB, shade * 0.85, threshold);
        }
      }
      fragmentColour = vec4(colour, 1.0);
    }`;

  // Draw one body. Returns whether its surface is visible.
  function drawBody(camera, body, time, zoomLevel) {
    const cell = Math.pow(2, zoomLevel) / 16;
    const centre = Flatspace.bodyAbsolutePosition(body, time);
    const relative = { x: centre.x - camera.x, y: centre.y - camera.y };
    const distance = Math.hypot(relative.x, relative.y);
    const viewRadius = Math.hypot(viewWidth, viewHeight) / 2 / camera.scale;
    const atmosphereHeight = body.atmosphere ? body.atmosphere.height : 0;
    const reach = body.radius + Math.max(atmosphereHeight * 1.4, body.terrain.amplitude * 1.5);
    if (distance - reach > viewRadius) {
      return false;
    }
    // tiny: a dot of a few art pixels
    if (body.radius * camera.scale < 2.5) {
      const screenPoint = worldToScreenPoint(camera, centre.x, centre.y);
      const colour = Palette.nearest(...hexToPalette([body.colors.disc])[0]).map((channel) => channel / 255);
      sprites.begin(viewCanvas.width, viewCanvas.height);
      const dotSize = Math.max(2.5, body.radius * camera.scale) * 2 * pixelRatio;
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
      camera.body === body &&
      viewRadius < body.radius * 0.3 &&
      distance - body.radius < viewRadius * 4 + body.terrain.amplitude * 2;
    const material = materials(body);
    const uniforms = planet.uniforms;
    webgl.useProgram(planet.program);
    webgl.uniform2f(uniforms.resolution, viewCanvas.width, viewCanvas.height);
    webgl.uniform1f(uniforms.cameraScale, camera.scale * pixelRatio);
    webgl.uniform1f(uniforms.cameraRotation, camera.rotation);
    webgl.uniform1f(uniforms.cellSize, cell);
    webgl.uniform1f(uniforms.bodyRotation, Flatspace.bodyRotation(body, time));
    webgl.uniform1f(uniforms.radius, body.radius);
    webgl.uniform1f(uniforms.atmosphereHeight, atmosphereHeight);
    webgl.uniform1i(uniforms.hasOcean, body.ocean ? 1 : 0);
    webgl.uniform1f(uniforms.snowHeight, body.ocean ? 2550 : 1e9);
    webgl.uniform1f(uniforms.rockHeight, body.ocean ? 1900 : body.terrain.amplitude * 0.6);
    webgl.uniform1f(uniforms.amplitude, body.terrain.amplitude);
    webgl.uniform2f(uniforms.sunDirection, Flatspace.SUN_DIRECTION.x, Flatspace.SUN_DIRECTION.y);
    webgl.uniform1f(uniforms.drawRim, near ? 0 : 1);
    const ramps = {
      landColours: material.land,
      sandColours: material.sand,
      rockColours: material.rock,
      snowColours: material.snow,
      soilColours: material.soil,
      strataColoursA: material.strataA,
      strataColoursB: material.strataB,
      deepColours: material.deep,
      atmosphereColours: material.atmosphere,
    };
    for (const [name, ramp] of Object.entries(ramps)) {
      Flatspace.WebGL.rampUniform(webgl, uniforms[name], ramp, 5);
    }
    Flatspace.WebGL.rampUniform(webgl, uniforms.oceanColours, material.ocean, 6);
    let heightTexture;
    if (near) {
      // close to the ground: work in the frame of the ground under the camera
      const localUp = { x: -relative.x / distance, y: -relative.y / distance };
      const angle = Math.atan2(localUp.y, localUp.x);
      const cameraLongitude = Flatspace.wrapAngle(angle - Flatspace.bodyRotation(body, time));
      const span = Math.min(Math.PI, (viewRadius * 1.6) / body.radius);
      const period = cell * 65536;
      const windowStart = (((cameraLongitude * body.radius) % period) + period) % period;
      for (let sampleIndex = 0; sampleIndex < WINDOW_SAMPLES; sampleIndex++) {
        windowTexture.data[sampleIndex] = Flatspace.terrainHeight(
          body,
          cameraLongitude - span + (2 * span * sampleIndex) / (WINDOW_SAMPLES - 1),
        );
      }
      uploadHeights(windowTexture);
      heightTexture = windowTexture;
      webgl.uniform1i(uniforms.mode, 1);
      webgl.uniform2f(uniforms.up, localUp.x, localUp.y);
      webgl.uniform1f(uniforms.cameraAltitude, distance - body.radius);
      webgl.uniform1f(uniforms.cameraDistance, distance);
      webgl.uniform1f(uniforms.cameraAlong, windowStart);
      webgl.uniform1f(uniforms.cameraLongitude, cameraLongitude);
      webgl.uniform1f(uniforms.span, span);
    } else {
      heightTexture = fullHeights(body);
      webgl.uniform1i(uniforms.mode, 0);
      webgl.uniform2f(uniforms.bodyCentre, relative.x, relative.y);
    }
    webgl.activeTexture(webgl.TEXTURE1);
    webgl.bindTexture(webgl.TEXTURE_2D, heightTexture.texture);
    webgl.uniform1i(uniforms.heights, 1);
    webgl.uniform1i(uniforms.heightCount, heightTexture.sampleCount);
    // only shade the pixels the body can cover
    const screenPoint = worldToScreenPoint(camera, centre.x, centre.y);
    const reachPixels = reach * camera.scale;
    const minX = Flatspace.clamp(screenPoint.x - reachPixels, 0, viewWidth);
    const maxX = Flatspace.clamp(screenPoint.x + reachPixels, 0, viewWidth);
    const minY = Flatspace.clamp(screenPoint.y - reachPixels, 0, viewHeight);
    const maxY = Flatspace.clamp(screenPoint.y + reachPixels, 0, viewHeight);
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
    const partType = part.type;
    let cacheKey = null;
    let makeSprite = null;
    if (Flatspace.SPRITES[partType.id]) {
      cacheKey = 'hand|' + partType.id;
      makeSprite = () => Flatspace.Sprites.parse(partType.id, Flatspace.SPRITES[partType.id]);
    } else if (partType.stretch) {
      const skinName = part.skin || (partType.foam ? 'foam' : 'white');
      cacheKey = `tank|${width}|${length}|${skinName}`;
      makeSprite = () => Flatspace.Sprites.tank(width, length, skinName);
    } else if (partType.id === 'adapter') {
      cacheKey = `adapter|${width}|${topWidth}|${length}`;
      makeSprite = () =>
        Flatspace.Sprites.profile({
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
        Flatspace.Sprites.profile({
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
  // Parts: the vector drawing from parts.js at pixelsPerMetre art pixels per metre, snapped to the palette.
  function partSprite(part, pixelsPerMetre, glow, sunStep = 8, sunlit = 1) {
    const partType = part.type;
    const width = part.width || (partType.width === 'auto' ? 1.25 : partType.width);
    const topWidth = part.topWidth || partType.topWidth || width;
    const length = part.length || partType.length;

    //is me now :)
    // ugh have to edit this

    // New art at full zoom, and at ½ and ¼ zoom by halving it once or twice.
    const halvings = { 16: 0, 8: 1, 4: 2 }[pixelsPerMetre]; // further out, parts are only a few pixels, so the old art stays
    if (halvings !== undefined) {
      const newArt = newSprite(part, width, topWidth, length);
      if (newArt) {
        const halvedKey = `${newArt.cacheKey}|half${halvings}`; // its own key for each size
        if (!parsedCache.has(halvedKey)) {
          let halved = newArt.sprite;
          for (let step = 0; step < halvings; step++) {
            halved = Flatspace.Sprites.halve(halved);
          }
          parsedCache.set(halvedKey, halved);
        }
        const sprite = parsedCache.get(halvedKey);

        const nozzleGlow = partType.engine ? glow : 0; //only engines glow
        const mirrored = !!part.flip;
        const litKey = `${halvedKey}|${sunStep}|${sunlit}|${nozzleGlow}|${mirrored}`;
        let atlasEntry = sprites.atlas.get(litKey);
        if (atlasEntry) {
          return atlasEntry;
        }

        const sunAngle = sunStep * (Flatspace.TAU / 32);
        let sunAcross = Math.sin(sunAngle);
        const sunAlong = Math.cos(sunAngle);
        if (mirrored) {
          sunAcross = -sunAcross;
        }
        atlasEntry = sprites.atlas.add(
          litKey,
          Flatspace.Sprites.light(sprite, sunAcross, sunAlong, sunlit, nozzleGlow),
        );
        if (atlasEntry) {
          // the centre in the halved sprite's own pixels: the full-size centre halved, so odd sizes don't drift
          atlasEntry.originX = newArt.sprite.width / 2 / Math.pow(2, halvings);
          atlasEntry.originY = newArt.sprite.height / 2 / Math.pow(2, halvings);
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
    const image = Flatspace.WebGL.bake(canvasWidth, canvasHeight, (graphics) => {
      graphics.setTransform(pixelsPerMetre, 0, 0, pixelsPerMetre, halfWidthPixels, topMargin);
      Flatspace.drawPart(graphics, part, 0, 1 / pixelsPerMetre, { glow });
    });
    atlasEntry = sprites.atlas.add(cacheKey, image);
    if (atlasEntry) {
      atlasEntry.originX = halfWidthPixels;
      atlasEntry.originY = topMargin + (length / 2) * pixelsPerMetre;
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
    const canopyDistance = full ? 11 : 6;
    const canopyWidth = full ? 7.5 : 1.6;
    const halfWidthPixels = Math.ceil((canopyWidth + 0.5) * pixelsPerMetre);
    const abovePixels = Math.ceil((canopyDistance + canopyWidth + 0.5) * pixelsPerMetre);
    const down = Math.ceil(0.5 * pixelsPerMetre);
    const image = Flatspace.WebGL.bake(
      halfWidthPixels * 2,
      abovePixels + down,
      (graphics) => {
        graphics.setTransform(pixelsPerMetre, 0, 0, pixelsPerMetre, halfWidthPixels, abovePixels);
        const pixelSize = 1 / pixelsPerMetre;
        graphics.strokeStyle = '#e8e4da';
        graphics.lineWidth = pixelSize * 1.2;
        graphics.beginPath();
        graphics.moveTo(0, 0);
        graphics.lineTo(-canopyWidth, -canopyDistance);
        graphics.moveTo(0, 0);
        graphics.lineTo(canopyWidth, -canopyDistance);
        graphics.moveTo(0, 0);
        graphics.lineTo(0, -canopyDistance - canopyWidth * 0.3);
        graphics.stroke();
        graphics.beginPath();
        graphics.moveTo(-canopyWidth, -canopyDistance);
        graphics.quadraticCurveTo(
          -canopyWidth,
          -canopyDistance - canopyWidth * 0.9,
          0,
          -canopyDistance - canopyWidth * 0.9,
        );
        graphics.quadraticCurveTo(
          canopyWidth,
          -canopyDistance - canopyWidth * 0.9,
          canopyWidth,
          -canopyDistance,
        );
        graphics.quadraticCurveTo(0, -canopyDistance - canopyWidth * 0.25, -canopyWidth, -canopyDistance);
        graphics.fillStyle = '#e8622a';
        graphics.fill();
        graphics.fillStyle = '#f4efe6';
        graphics.beginPath();
        graphics.moveTo(-canopyWidth * 0.35, -canopyDistance - canopyWidth * 0.12);
        graphics.quadraticCurveTo(
          -canopyWidth * 0.3,
          -canopyDistance - canopyWidth * 0.85,
          0,
          -canopyDistance - canopyWidth * 0.88,
        );
        graphics.quadraticCurveTo(
          canopyWidth * 0.3,
          -canopyDistance - canopyWidth * 0.85,
          canopyWidth * 0.35,
          -canopyDistance - canopyWidth * 0.12,
        );
        graphics.closePath();
        graphics.fill();
      },
      0.3,
    );
    atlasEntry = sprites.atlas.add(key, image);
    if (atlasEntry) {
      atlasEntry.originX = halfWidthPixels;
      atlasEntry.originY = abovePixels;
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
    const pixelSize = graphics.__pixelSize;
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
    const buildings = [
      [-160, 46, 38, '#c9ccd1'],
      [-95, 22, 14, '#b4b9bf'],
      [-60, 12, 9, '#9da3aa'],
      [70, 30, 10, '#bfc3c8'],
      [110, 16, 22, '#aeb3b9'],
    ];
    for (const [buildingX, buildingWidth, buildingHeight, colour] of buildings) {
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
    const image = Flatspace.WebGL.bake(
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
        graphics.__pixelSize = 1 / pixelsPerMetre;
        drawSpaceCenterVector(graphics);
      },
    );
    return sprites.atlas.add(key, image);
  }
  function drawSpaceCenter(camera, body, time, pixelsPerMetre) {
    const angle = body.launchPad.longitude + Flatspace.bodyRotation(body, time);
    const centre = Flatspace.bodyAbsolutePosition(body, time);
    const base = {
      x: centre.x + Math.cos(angle) * (body.radius + body.launchPad.height),
      y: centre.y + Math.sin(angle) * (body.radius + body.launchPad.height),
    };
    const baseScreen = worldToScreenPoint(camera, base.x, base.y);
    const reachPixels = Math.hypot(viewWidth, viewHeight) / 2 + 200 * camera.scale;
    if (Math.hypot(baseScreen.x - viewWidth / 2, baseScreen.y - viewHeight / 2) > reachPixels) {
      return;
    }
    // pad frame on screen: +x along the ground (east), +y up
    const screenRotation = angle - Math.PI / 2 - camera.rotation; // rotation of the pad's x axis, world → camera
    const size = (camera.scale * pixelRatio) / pixelsPerMetre;
    for (let tileIndex = 0; tileIndex * SC_TILE + SC_X0 < SC_X1; tileIndex++) {
      const midX = SC_X0 + (tileIndex + 0.5) * SC_TILE;
      const midY = (SC_Y0 + SC_Y1) / 2;
      const cosRotation = Math.cos(screenRotation);
      const sinRotation = Math.sin(screenRotation);
      const worldX = midX * cosRotation - midY * sinRotation;
      const worldY = midX * sinRotation + midY * cosRotation; // camera-frame metres
      const screenX = baseScreen.x + worldX * camera.scale;
      const screenY = baseScreen.y - worldY * camera.scale;
      const tileRadius = (SC_TILE * 0.75 + (SC_Y1 - SC_Y0) * 0.5) * camera.scale;
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
        entry.width / 2,
        entry.height / 2,
        null,
      );
    }
    // beacon on the tower top
    if (time % 2 < 1) {
      const beaconX = 8.4;
      const beaconY = 36.4;
      const cosRotation = Math.cos(screenRotation);
      const sinRotation = Math.sin(screenRotation);
      const worldX = beaconX * cosRotation - beaconY * sinRotation;
      const worldY = beaconX * sinRotation + beaconY * cosRotation;
      const beaconColour = Palette.ramps.red[0];
      block(
        (baseScreen.x + worldX * camera.scale) * pixelRatio,
        (baseScreen.y - worldY * camera.scale) * pixelRatio,
        Math.max(0.8 * camera.scale * pixelRatio, size * 2),
        Math.max(0.8 * camera.scale * pixelRatio, size * 2),
        -screenRotation,
        [beaconColour[0] / 255, beaconColour[1] / 255, beaconColour[2] / 255, 1],
      );
    }
  }

  // Pixel puffs for particles: discs a few art pixels across, white with a lighter core
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
    const centre = Vector.add(Flatspace.bodyAbsolutePosition(vessel.body, time), vessel.position);
    return {
      screenCentre: worldToScreenPoint(camera, centre.x, centre.y),
      screenAngle: -(vessel.angle - camera.rotation) + Math.PI / 2,
    };
  }
  RenderGL.partToScreen = (camera, vessel, time, point) => {
    const frame = vesselFrame(camera, vessel, time);
    const scaledX = point.x * camera.scale;
    const scaledY = -point.y * camera.scale;
    const cosAngle = Math.cos(frame.screenAngle);
    const sinAngle = Math.sin(frame.screenAngle);
    return {
      x: frame.screenCentre.x + scaledX * cosAngle - scaledY * sinAngle,
      y: frame.screenCentre.y + scaledX * sinAngle + scaledY * cosAngle,
    };
  };
  RenderGL.screenToPart = (camera, vessel, time, screenX, screenY) => {
    const frame = vesselFrame(camera, vessel, time);
    const deltaX = (screenX - frame.screenCentre.x) / camera.scale;
    const deltaY = (screenY - frame.screenCentre.y) / camera.scale;
    const cosAngle = Math.cos(-frame.screenAngle);
    const sinAngle = Math.sin(-frame.screenAngle);
    return { x: deltaX * cosAngle - deltaY * sinAngle, y: -(deltaX * sinAngle + deltaY * cosAngle) };
  };

  function arrowSprite() {
    let atlasEntry = sprites.atlas.get('arrow');
    if (atlasEntry) {
      return atlasEntry;
    }
    const image = Flatspace.WebGL.bake(
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
    const craftLength = vessel.layout.height * camera.scale;
    const pixelsPerMetre = 16 / Math.pow(2, zoomLevel);
    if (craftLength < 6 || pixelsPerMetre < 0.25) {
      const arrowEntry = arrowSprite();
      const alpha = vessel.isDebris ? 0.6 : 1;
      if (arrowEntry) {
        sprites.sprite(
          arrowEntry,
          frame.screenCentre.x * pixelRatio,
          frame.screenCentre.y * pixelRatio,
          1.5 * pixelRatio,
          -(vessel.angle - camera.rotation),
          4.5,
          4.5,
          [1, 1, 1, alpha],
        );
      }
      return;
    }
    const size = (camera.scale * pixelRatio) / pixelsPerMetre;
    const drawAngle = frame.screenAngle;
    const toScreen = (drawX, drawY) => {
      // drawing frame (x, y down the rocket) → device px
      const cosAngle = Math.cos(drawAngle);
      const sinAngle = Math.sin(drawAngle);
      return {
        x: (frame.screenCentre.x + (drawX * cosAngle - drawY * sinAngle) * camera.scale) * pixelRatio,
        y: (frame.screenCentre.y + (drawX * sinAngle + drawY * cosAngle) * camera.scale) * pixelRatio,
      };
    };
    const chutes = vessel.parts.filter((part) => part.chute === 'halfOpen' || part.chute === 'full');
    if (chutes.length) {
      const chutePart = chutes[0];
      const chuteTip = Vector.add(chutePart.centreOffset, Vector.scale(chutePart.axis, chutePart.length / 2));
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
          chuteEntry.originX,
          chuteEntry.originY,
          tint,
        );
      }
    }
    const glowMap = new Map();
    if (vessel.nozzles) {
      vessel.nozzles.forEach((nozzle) => glowMap.set(nozzle.part, nozzle.power));
    }
    const sunlit = Math.round(lightAt(vessel) * 4) / 4;
    const SUN_STEP = Flatspace.TAU / 32;
    const noTint = [1, 1, 1, tint ? tint[3] : 1];
    for (const part of vessel.parts) {
      const glow = Math.round((glowMap.get(part) || 0) * 2) / 2;
      const noseAngle = vessel.angle + part.rotation;
      const sunStep = ((Math.round(noseAngle / SUN_STEP) % 32) + 32) % 32;
      const atlasEntry = partSprite(part, pixelsPerMetre, glow, sunStep, sunlit);
      if (!atlasEntry) {
        continue;
      }
      const screenAt = toScreen(part.centreOffset.x, -part.centreOffset.y);
      const spriteTint = atlasEntry.lit ? noTint : tint;
      sprites.sprite(
        atlasEntry,
        screenAt.x,
        screenAt.y,
        size,
        drawAngle - part.rotation,
        atlasEntry.originX,
        atlasEntry.originY,
        spriteTint,
        !!part.flip,
      );
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
    const base = Flatspace.bodyAbsolutePosition(body, time);
    const list = Flatspace.Render.particles;
    for (const pass of ['smoke', 'fire']) {
      for (const particle of list) {
        const smoke = particle.kind === 'smoke';
        if ((pass === 'smoke') !== smoke) {
          continue;
        }
        const lifeFraction = particle.life / particle.max;
        const sizeMetres = particle.size + particle.grow * particle.life;
        const size = Flatspace.clamp(Math.round(sizeMetres / cell), 1, 40);
        const screenPoint = worldToScreenPoint(camera, base.x + particle.x, base.y + particle.y);
        const radiusPixels = size * cell * camera.scale;
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
          cell * camera.scale * pixelRatio,
          -camera.rotation * 0,
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
    const vAir = Vector.subtract(vessel.velocity, Flatspace.airVelocity(body, vessel.position));
    const direction = Vector.normalise(vAir);
    const centre = Vector.add(Flatspace.bodyAbsolutePosition(body, time), vessel.position);
    const lead = Vector.add(centre, Vector.scale(direction, vessel.layout.height * 0.45));
    const screenPoint = worldToScreenPoint(camera, lead.x, lead.y);
    const size = Flatspace.clamp(Math.round((vessel.layout.height * 0.9) / cell), 3, 40);
    const puffEntry = puff(size);
    const heat = vessel.heat;
    const colour = rampAt(FIRE, 1 - heat);
    if (puffEntry) {
      sprites.sprite(
        puffEntry,
        screenPoint.x * pixelRatio,
        screenPoint.y * pixelRatio,
        cell * camera.scale * pixelRatio,
        0,
        size / 2,
        size / 2,
        [colour[0] / 255, colour[1] / 255, colour[2] / 255, heat * 0.9],
      );
    }
    const trailPoint = worldToScreenPoint(camera, lead.x - direction.x * 40, lead.y - direction.y * 40);
    const angle = Math.atan2(trailPoint.y - screenPoint.y, trailPoint.x - screenPoint.x);
    const trailLength = Math.hypot(trailPoint.x - screenPoint.x, trailPoint.y - screenPoint.y);
    const thick = Math.max(1, cell * camera.scale) * pixelRatio;
    const streakColour = rampAt(FIRE, 0.4);
    for (let streak = -2; streak <= 2; streak++) {
      const offset = streak * size * cell * camera.scale * 0.25;
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
    return Flatspace.smoothstep(-0.12, 0.25, Vector.dot(localUp, Flatspace.SUN_DIRECTION));
  }
  const mixColours = (first, second, fraction) => [
    first[0] + (second[0] - first[0]) * fraction,
    first[1] + (second[1] - first[1]) * fraction,
    first[2] + (second[2] - first[2]) * fraction,
  ];

  // How sunlit the craft is: dark in a planet's shadow, dimmer towards dusk in the air.
  function lightAt(vessel) {
    const body = vessel.body;
    const sunDirection = Flatspace.SUN_DIRECTION;
    const along = Vector.dot(vessel.position, sunDirection);
    const offsetFromLine = Math.abs(Vector.cross(vessel.position, sunDirection));
    let lightLevel = along < 0 && offsetFromLine < body.radius ? 0 : 1;
    if (body.atmosphere && vessel.altitude < body.atmosphere.height) {
      lightLevel = Math.min(1, sunlight(Vector.normalise(vessel.position)) * 1.25);
    }
    return lightLevel;
  }

  RenderGL.drawFlight = (theGame) => {
    const vessel = theGame.vessel;
    const time = theGame.time;
    const camera = theGame.camera;
    const currentBody = vessel.body;
    const zoomLevel = levelFor(camera.scale);
    const cell = Math.pow(2, zoomLevel) / 16;
    frameInfo.level = zoomLevel;
    sprites.draws = 0;
    webgl.viewport(0, 0, viewCanvas.width, viewCanvas.height);
    // sky
    const altitude = vessel.altitude;
    const localUp = Vector.normalise(vessel.position);
    const light = sunlight(localUp);
    let spaceFraction = 1;
    if (currentBody.atmosphere) {
      spaceFraction = Flatspace.clamp(
        Math.pow(Math.max(altitude, 0) / currentBody.atmosphere.height, 0.55),
        0,
        1,
      );
    }
    const sunsetAmount = currentBody.atmosphere
      ? (1 - spaceFraction) * Math.exp(-Math.pow(Vector.dot(localUp, Flatspace.SUN_DIRECTION) / 0.18, 2))
      : 0;
    const daylight = currentBody.atmosphere ? (1 - spaceFraction) * light : 0;
    const top = mixColours([6, 9, 20], [58, 118, 196], daylight);
    const horizonColour = mixColours(
      mixColours([8, 12, 26], [140, 190, 236], daylight),
      [236, 132, 72],
      sunsetAmount * 0.8,
    );
    const starA = 1 - daylight * 1.15;
    drawSky(
      skyStops(top, horizonColour),
      Flatspace.clamp(starA * 1.6 - 0.6, 0, 1) * 0.55,
      -camera.rotation + 0.6,
    );
    sprites.begin(viewCanvas.width, viewCanvas.height);
    drawStars(camera, starA, true, time);
    sprites.flush();
    // bodies, farthest first
    camera.body = currentBody;
    const order = Flatspace.bodies
      .slice()
      .sort(
        (first, second) =>
          Vector.length(Vector.subtract(Flatspace.bodyAbsolutePosition(second, time), camera)) -
          Vector.length(Vector.subtract(Flatspace.bodyAbsolutePosition(first, time), camera)),
      );
    const pixelsPerMetre = 16 / Math.pow(2, Math.min(zoomLevel, 6));
    for (const body of order) {
      const near = drawBody(camera, body, time, zoomLevel);
      if (near && body.launchPad) {
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
    const time = theGame.time;
    const camera = theGame.mapCamera;
    const zoomLevel = levelFor(camera.scale);
    frameInfo.level = zoomLevel;
    sprites.draws = 0;
    webgl.viewport(0, 0, viewCanvas.width, viewCanvas.height);
    drawSky([Palette.ramps.night[0]], 0.4, 0.6);
    sprites.begin(viewCanvas.width, viewCanvas.height);
    drawStars(camera, 0.8, false, time);
    sprites.flush();
    camera.body = null;
    for (const body of Flatspace.bodies) {
      drawBody(camera, body, time, zoomLevel);
    }
    frameInfo.draws = sprites.draws;

    // lines, markers and labels on the overlay
    const context = overlayContext;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, viewWidth, viewHeight);
    for (const body of Flatspace.bodies) {
      if (!body.parent) {
        continue;
      }
      const parentCentre = Flatspace.bodyAbsolutePosition(body.parent, time);
      const screenPoint = worldToScreenPoint(camera, parentCentre.x, parentCentre.y);
      context.strokeStyle = 'rgba(150,170,210,0.22)';
      context.lineWidth = 1;
      context.beginPath();
      context.arc(screenPoint.x, screenPoint.y, body.semiMajorAxis * camera.scale, 0, FULL_TURN);
      context.stroke();
      const bodyCentre = Flatspace.bodyAbsolutePosition(body, time);
      const bodyScreen = worldToScreenPoint(camera, bodyCentre.x, bodyCentre.y);
      if (body.sphereOfInfluence * camera.scale > 6) {
        context.setLineDash([4, 6]);
        context.strokeStyle = 'rgba(150,170,210,0.28)';
        context.beginPath();
        context.arc(bodyScreen.x, bodyScreen.y, body.sphereOfInfluence * camera.scale, 0, FULL_TURN);
        context.stroke();
        context.setLineDash([]);
      }
    }
    context.font = '600 12px "Saira Semi Condensed", "Arial Narrow", sans-serif';
    context.textAlign = 'center';
    for (const body of Flatspace.bodies) {
      const bodyCentre = Flatspace.bodyAbsolutePosition(body, time);
      const bodyScreen = worldToScreenPoint(camera, bodyCentre.x, bodyCentre.y);
      context.fillStyle = 'rgba(214,224,245,0.85)';
      context.fillText(
        body.name.toUpperCase(),
        bodyScreen.x,
        bodyScreen.y + Math.max(body.radius * camera.scale, 4) + 16,
      );
    }
    const vessel = theGame.vessel;
    if (!vessel.dead && !vessel.landed) {
      drawPatches(context, camera, theGame.patches, time, false);
      if (theGame.node && theGame.nodePatches) {
        drawPatches(context, camera, theGame.nodePatches, time, true, theGame.node.originTime);
      }
    }
    if (theGame.node) {
      const node = theGame.node;
      const position = Vector.add(
        Flatspace.bodyAbsolutePosition(node.body, node.originTime ?? time),
        node.position,
      );
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
      const vesselPosition = Vector.add(Flatspace.bodyAbsolutePosition(vessel.body, time), vessel.position);
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

  function drawPatches(context, camera, patches, time, planned, firstReferenceTime) {
    if (!patches) {
      return;
    }
    patches.forEach((patch, index) => {
      const orbit = patch.orbit;
      const referenceTime = index === 0 ? (firstReferenceTime ?? time) : patch.startTime;
      const origin = Flatspace.bodyAbsolutePosition(patch.body, referenceTime);
      const startTime = Math.max(patch.startTime, index === 0 ? time : patch.startTime);
      const points = Flatspace.sampleOrbit(orbit, startTime, patch.endTime, 360);
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
        context.arc(
          screenPoint.x,
          screenPoint.y,
          Math.max(patch.body.radius * camera.scale, 4),
          0,
          FULL_TURN,
        );
        context.stroke();
      }
      if (planned) {
        return;
      }
      const body = patch.body;
      const mark = (trueAnomaly, label, value) => {
        const timeUntil = Flatspace.timeToTrueAnomaly(orbit, trueAnomaly, startTime);
        if (!isFinite(timeUntil) || startTime + timeUntil > patch.endTime) {
          return;
        }
        const state = Flatspace.orbitState(orbit, startTime + timeUntil);
        marker(
          context,
          worldToScreenPoint(camera, origin.x + state.position.x, origin.y + state.position.y),
          label,
          Flatspace.formatDistance(value),
        );
      };
      if (orbit.eccentricity > 1e-4) {
        if (orbit.eccentricity < 1) {
          mark(Math.PI, 'Ap', orbit.apoapsis - body.radius);
        }
        if (orbit.periapsis > body.radius * 0.2) {
          mark(0, 'Pe', orbit.periapsis - body.radius);
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
          Flatspace.formatTime(patch.endTime - time),
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

  // For the gallery: draw a part sprite at pixelsPerMetre art pixels per metre.
  RenderGL.galleryPart = (part, pixelsPerMetre, glow) => partSprite(part, pixelsPerMetre, glow);
  RenderGL.sprites = () => sprites;
})();
