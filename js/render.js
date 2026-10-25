// render.js — the Canvas 2D renderer: flight view, map view, particles and effects.
// Since step B1 the game draws with the WebGL2 renderer (render-gl.js); this one is the
// fallback for browsers without WebGL2. The particle simulation here is shared by both.
//
// Renderer interface. The rest of the game only talks to FS.Renderer through these
// methods, so renderers can be swapped:
//   init(canvas, game)         set up, and subscribe to game events (explosions, SOI changes)
//   resize()                   the canvas changed size
//   size() -> {W, H}           canvas size in CSS pixels
//   update(game)               advance visual-only state (particles) by game.frame.simDt
//   drawFlight(game)           draw the flight view
//   drawMap(game)              draw the map view
//   worldToScreen(cam, x, y)   world metres → screen pixels, for map clicks
//   partToScreen(cam, ves, t, c)    a point on a craft (craft frame, from its centre of mass) → screen
//   screenToPart(cam, ves, t, x, y) the reverse, for clicking parts in flight
//   stats() -> {particles}     numbers for the F3 developer overlay
// The renderer only reads game state; it never changes the simulation.
(function () {
  const Vector = FS.vec;
  const FULL_TURN = FS.TAU;
  const Render = (FS.Render = {});
  FS.SUN_DIR = { x: 1, y: 0 }; // sunlight comes from +x (far away)

  let viewCanvas;
  let context;
  let viewWidth = 0;
  let viewHeight = 0;
  let pixelRatio = 1;
  const stars = [];
  const sprites = {};

  Render.init = (canvas, game) => {
    viewCanvas = canvas;
    if (game) {
      subscribe(game);
    }
    context = canvas.getContext('2d');
    const random = FS.rng(4242);
    for (let starIndex = 0; starIndex < 700; starIndex++) {
      const angle = random() * FULL_TURN;
      const distance = Math.sqrt(random());
      const temp = random();
      stars.push({
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
        size: Math.pow(random(), 6) * 1.8 + 0.4,
        b: 0.35 + random() * 0.65,
        c: temp < 0.15 ? '255,214,170' : temp > 0.85 ? '178,206,255' : '240,244,255',
      });
    }
    sprites.flame = makeSprite([
      [0, 'rgba(255,250,225,1)'],
      [0.25, 'rgba(255,200,90,0.9)'],
      [0.6, 'rgba(255,110,30,0.35)'],
      [1, 'rgba(255,60,0,0)'],
    ]);
    sprites.blue = makeSprite([
      [0, 'rgba(235,245,255,1)'],
      [0.3, 'rgba(150,190,255,0.8)'],
      [1, 'rgba(80,120,255,0)'],
    ]);
    sprites.smoke = makeSprite([
      [0, 'rgba(225,222,215,0.55)'],
      [0.6, 'rgba(190,188,182,0.25)'],
      [1, 'rgba(160,160,160,0)'],
    ]);
    sprites.glow = makeSprite([
      [0, 'rgba(255,255,255,1)'],
      [0.2, 'rgba(255,190,120,0.7)'],
      [1, 'rgba(255,90,30,0)'],
    ]);
    Render.resize();
  };

  function makeSprite(stops) {
    const puffCanvas = document.createElement('canvas');
    puffCanvas.width = puffCanvas.height = 64;
    const graphics = puffCanvas.getContext('2d');
    const gradient = graphics.createRadialGradient(32, 32, 0, 32, 32, 32);
    stops.forEach(([offset, colour]) => gradient.addColorStop(offset, colour));
    graphics.fillStyle = gradient;
    graphics.fillRect(0, 0, 64, 64);
    return puffCanvas;
  }

  Render.resize = () => {
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    viewWidth = viewCanvas.clientWidth;
    viewHeight = viewCanvas.clientHeight;
    viewCanvas.width = Math.round(viewWidth * pixelRatio);
    viewCanvas.height = Math.round(viewHeight * pixelRatio);
  };
  Render.size = () => ({ W: viewWidth, H: viewHeight });

  // ---- Camera transforms ----
  // cam: {x, y (absolute metres), s (px per metre), rot (radians)}
  function worldToScreenPoint(camera, x, y) {
    const deltaX = x - camera.x;
    const deltaY = y - camera.y;
    const cosRot = Math.cos(camera.rot);
    const sinRot = Math.sin(camera.rot);
    const rotatedX = deltaX * cosRot + deltaY * sinRot;
    const rotatedY = -deltaX * sinRot + deltaY * cosRot;
    return { x: viewWidth / 2 + rotatedX * camera.s, y: viewHeight / 2 - rotatedY * camera.s };
  }
  Render.w2s = worldToScreenPoint;
  Render.worldToScreen = worldToScreenPoint;
  Render.s2w = (camera, screenX, screenY) => {
    const rotatedX = (screenX - viewWidth / 2) / camera.s;
    const rotatedY = -(screenY - viewHeight / 2) / camera.s;
    const cosRot = Math.cos(camera.rot);
    const sinRot = Math.sin(camera.rot);
    return {
      x: camera.x + rotatedX * cosRot - rotatedY * sinRot,
      y: camera.y + rotatedX * sinRot + rotatedY * cosRot,
    };
  };
  // Set the context so that drawing in (abs - cam) metre coordinates works.
  function setWorld(camera) {
    const cosScaled = Math.cos(camera.rot) * camera.s;
    const sinScaled = Math.sin(camera.rot) * camera.s;
    context.setTransform(
      pixelRatio * cosScaled,
      pixelRatio * sinScaled,
      pixelRatio * sinScaled,
      -pixelRatio * cosScaled,
      (pixelRatio * viewWidth) / 2,
      (pixelRatio * viewHeight) / 2,
    );
  }
  function setScreen() {
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  // ---- Background ----
  function drawStars(camera, alpha, rotate) {
    if (alpha <= 0.01) {
      return;
    }
    const skyRadius = Math.hypot(viewWidth, viewHeight) * 0.55;
    const rotation = rotate ? camera.rot : 0;
    const cosRot = Math.cos(-rotation);
    const sinRot = Math.sin(-rotation);
    // faint galactic band
    context.save();
    context.globalAlpha = alpha * 0.5;
    context.translate(viewWidth / 2, viewHeight / 2);
    context.rotate(-rotation + 0.6);
    const band = context.createLinearGradient(0, -skyRadius * 0.35, 0, skyRadius * 0.35);
    band.addColorStop(0, 'rgba(90,110,170,0)');
    band.addColorStop(0.5, 'rgba(120,130,190,0.10)');
    band.addColorStop(1, 'rgba(90,110,170,0)');
    context.fillStyle = band;
    context.fillRect(-skyRadius, -skyRadius * 0.35, skyRadius * 2, skyRadius * 0.7);
    context.restore();
    for (const star of stars) {
      const starX = viewWidth / 2 + (star.x * cosRot - star.y * sinRot) * skyRadius;
      const starY = viewHeight / 2 + (star.x * sinRot + star.y * cosRot) * skyRadius;
      if (starX < -2 || starY < -2 || starX > viewWidth + 2 || starY > viewHeight + 2) {
        continue;
      }
      context.fillStyle = `rgba(${star.c},${star.b * alpha})`;
      context.fillRect(starX, starY, star.size, star.size);
    }
  }

  // Lighting factor for a point on a body: 1 = noon, 0 = night.
  function sunlight(localUp) {
    const sunDot = Vector.dot(localUp, FS.SUN_DIR);
    return FS.smoothstep(-0.12, 0.25, sunDot);
  }

  // ---- Bodies ----
  // Three ways to draw a body, picked by how big it is on screen:
  //  'dot'     tiny: a filled circle
  //  'disc'    whole planet visible: interior + coloured surface band + halo + night side
  //  'surface' camera close to the ground: real terrain relief, ocean, launch site
  // A 'disc' bigger than the screen is drawn only over the visible arc, so the
  // canvas never sees coordinates millions of pixels away.
  function surfaceColor(body, height) {
    if (body.ocean && height < 0) {
      return body.colors.ocean;
    }
    if (body.ocean && height < 40) {
      return body.colors.sand;
    }
    if (body.ocean && height > 2550) {
      return body.colors.snow;
    }
    if (height > (body.ocean ? 1900 : body.terrain.amp * 0.6)) {
      return body.colors.rock;
    }
    return body.colors.land;
  }

  function drawBody(camera, body, time, opts = {}) {
    const centre = FS.bodyAbs(body, time);
    const relative = Vector.sub(centre, camera);
    const dist = Vector.len(relative);
    const radiusPixels = body.R * camera.s;
    const viewR = Math.hypot(viewWidth, viewHeight) / 2 / camera.s;
    const atmoH = body.atmo ? body.atmo.height : 0;
    const maxH = body.terrain.amp * 2.5;
    const rotation = FS.bodyRot(body, time);
    const pixelSize = 1 / camera.s;

    if (radiusPixels < 4) {
      if (dist - body.R > viewR * 1.2) {
        const screenPoint = worldToScreenPoint(camera, centre.x, centre.y);
        if (
          screenPoint.x < -10 ||
          screenPoint.y < -10 ||
          screenPoint.x > viewWidth + 10 ||
          screenPoint.y > viewHeight + 10
        ) {
          return;
        }
      }
      const screenPoint = worldToScreenPoint(camera, centre.x, centre.y);
      setScreen();
      context.beginPath();
      context.arc(screenPoint.x, screenPoint.y, Math.max(radiusPixels, opts.minPx || 2.5), 0, FULL_TURN);
      context.fillStyle = body.colors.disc;
      context.fill();
      return;
    }

    const haloR = body.R + atmoH * 1.4;
    const surfVisible = dist - body.R - maxH < viewR;
    const haloVisible = body.atmo && dist - haloR < viewR;
    if (!surfVisible && !haloVisible) {
      return;
    }

    setWorld(camera);
    const localUp = dist > 0 ? Vector.scale(relative, -1 / dist) : { x: 0, y: 1 }; // centre → camera
    const camAng = Math.atan2(localUp.y, localUp.x);
    const full = radiusPixels < 4000;
    const near = !full && radiusPixels > 30000 && dist - body.R < viewR * 3 + maxH;

    // Visible window of longitudes
    let startAngle = 0;
    let endAngle = FULL_TURN;
    let sampleCount;
    if (!full) {
      const span =
        dist > viewR * 1.5
          ? Math.min(Math.PI, Math.asin(Math.min(1, (viewR * 1.5) / dist)) + 0.002)
          : Math.PI;
      startAngle = camAng - span;
      endAngle = camAng + span;
      sampleCount = near ? 420 : 360;
    } else {
      sampleCount = Math.round(FS.clamp(radiusPixels * 0.8, 96, 1600));
    }
    const arcPath = (radius, from, toAngle, steps, move = true) => {
      for (let step = 0; step <= steps; step++) {
        const angle = from + ((toAngle - from) * step) / steps;
        const pointX = relative.x + Math.cos(angle) * radius;
        const pointY = relative.y + Math.sin(angle) * radius;
        step === 0 && move ? context.moveTo(pointX, pointY) : context.lineTo(pointX, pointY);
      }
    };
    const deepR = full ? 0 : Math.max(0, body.R - maxH - viewR * 2.5);
    const closeDeep = () => {
      if (full) {
        return;
      }
      context.lineTo(relative.x + Math.cos(endAngle) * deepR, relative.y + Math.sin(endAngle) * deepR);
      context.lineTo(relative.x + Math.cos(startAngle) * deepR, relative.y + Math.sin(startAngle) * deepR);
    };
    // gradient along local "up" starting at the surface below the camera
    const localGrad = (startRadius, endRadius, stops) => {
      const gradient = context.createLinearGradient(
        relative.x + localUp.x * startRadius,
        relative.y + localUp.y * startRadius,
        relative.x + localUp.x * endRadius,
        relative.y + localUp.y * endRadius,
      );
      stops.forEach(([offset, colour]) => gradient.addColorStop(offset, colour));
      return gradient;
    };

    // ---- Atmosphere halo (not when we are down inside it) ----
    if (body.atmo && !near) {
      const [red, green, blue] = body.atmo.color;
      const stops = [
        [0, `rgba(${red},${green},${blue},0.55)`],
        [0.45, `rgba(${red},${green},${blue},0.18)`],
        [1, `rgba(${red},${green},${blue},0)`],
      ];
      context.beginPath();
      if (full) {
        const gradient = context.createRadialGradient(
          relative.x,
          relative.y,
          body.R * 0.98,
          relative.x,
          relative.y,
          haloR,
        );
        stops.forEach(([offset, colour]) => gradient.addColorStop(offset, colour));
        context.fillStyle = gradient;
        context.arc(relative.x, relative.y, haloR, 0, FULL_TURN);
      } else {
        context.fillStyle = localGrad(body.R * 0.98, haloR, stops);
        arcPath(haloR, startAngle, endAngle, sampleCount);
        arcPath(body.R * 0.98, endAngle, startAngle, sampleCount, false);
        context.closePath();
      }
      context.fill();
    }
    if (!surfVisible) {
      return;
    }

    // Sample the surface once
    const points = [];
    for (let step = 0; step <= sampleCount; step++) {
      const angle = startAngle + ((endAngle - startAngle) * step) / sampleCount;
      const height = FS.terrainHeight(body, angle - rotation);
      points.push({
        a: angle,
        h: height,
        x: relative.x + Math.cos(angle) * (body.R + height),
        y: relative.y + Math.sin(angle) * (body.R + height),
      });
    }

    if (near) {
      // ---- Real terrain ----
      context.beginPath();
      points.forEach((point, index) =>
        index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y),
      );
      closeDeep();
      context.closePath();
      context.fillStyle = localGrad(body.R, body.R - viewR * 1.5, [
        [0, body.colors.land],
        [1, body.colors.landDeep],
      ]);
      context.fill();
      strokeRuns(
        points,
        (point) => {
          const colour = surfaceColor(body, Math.max(point.h, body.ocean ? 0 : point.h));
          return colour === body.colors.land ? shade(body.colors.land, 1.3) : colour;
        },
        pixelSize * 3,
      );
      if (body.ocean) {
        context.beginPath();
        arcPath(body.R, startAngle, endAngle, sampleCount);
        closeDeep();
        context.closePath();
        context.fillStyle = localGrad(body.R, body.R - viewR, [
          [0, body.colors.ocean],
          [1, body.colors.oceanDeep],
        ]);
        context.fill();
        context.beginPath();
        let penDown = false;
        for (const point of points) {
          const pointX = relative.x + Math.cos(point.a) * body.R;
          const pointY = relative.y + Math.sin(point.a) * body.R;
          if (point.h > 0) {
            penDown = false;
            continue;
          }
          penDown ? context.lineTo(pointX, pointY) : context.moveTo(pointX, pointY);
          penDown = true;
        }
        context.strokeStyle = 'rgba(170,210,255,0.6)';
        context.lineWidth = pixelSize * 2;
        context.stroke();
      }
      if (body.pad) {
        drawSpaceCenter(camera, body, time, relative, pixelSize);
      }
      return;
    }

    // ---- Disc: interior, then a coloured band showing the surface type ----
    const band = Math.max(pixelSize * 3, body.R * 0.035);
    context.beginPath();
    if (full) {
      context.arc(relative.x, relative.y, body.R, 0, FULL_TURN);
    } else {
      arcPath(body.R, startAngle, endAngle, sampleCount);
      closeDeep();
      context.closePath();
    }
    const interior = body.ocean ? body.colors.oceanDeep : body.colors.landDeep;
    if (full) {
      const gradient = context.createRadialGradient(
        relative.x,
        relative.y,
        body.R * 0.2,
        relative.x,
        relative.y,
        body.R,
      );
      gradient.addColorStop(0, shade(interior, 0.75));
      gradient.addColorStop(1, interior);
      context.fillStyle = gradient;
    } else {
      context.fillStyle = interior;
    }
    context.fill();
    // surface band (stroked arc runs)
    const bandPts = points.map((point) => ({
      ...point,
      x: relative.x + Math.cos(point.a) * (body.R - band / 2),
      y: relative.y + Math.sin(point.a) * (body.R - band / 2),
    }));
    strokeRuns(bandPts, (point) => surfaceColor(body, point.h), band, 'butt');
    // relief line on top
    context.beginPath();
    points.forEach((point, index) => {
      const radius = body.R + Math.max(body.ocean ? 0 : -1e9, point.h);
      const pointX = relative.x + Math.cos(point.a) * radius;
      const pointY = relative.y + Math.sin(point.a) * radius;
      index ? context.lineTo(pointX, pointY) : context.moveTo(pointX, pointY);
    });
    context.strokeStyle = 'rgba(255,255,255,0.25)';
    context.lineWidth = pixelSize;
    context.stroke();

    // Night side
    const sunDirection = FS.SUN_DIR;
    if (full) {
      const gradient = context.createRadialGradient(
        relative.x + sunDirection.x * body.R * 0.6,
        relative.y + sunDirection.y * body.R * 0.6,
        body.R * 0.1,
        relative.x + sunDirection.x * body.R * 0.25,
        relative.y + sunDirection.y * body.R * 0.25,
        body.R * 1.35,
      );
      gradient.addColorStop(0, 'rgba(4,6,14,0)');
      gradient.addColorStop(0.62, 'rgba(4,6,14,0.05)');
      gradient.addColorStop(1, 'rgba(4,6,14,0.82)');
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(relative.x, relative.y, body.R + 1 * pixelSize, 0, FULL_TURN);
      context.fill();
    } else {
      const dark = (1 - sunlight(localUp)) * 0.7;
      if (dark > 0.01) {
        context.beginPath();
        arcPath(body.R + band * 0.1, startAngle, endAngle, sampleCount);
        closeDeep();
        context.closePath();
        context.fillStyle = `rgba(4,6,14,${dark})`;
        context.fill();
      }
    }
  }

  // Stroke a polyline, changing colour along the way.
  function strokeRuns(points, colorOf, width, lineCap = 'round') {
    context.lineWidth = width;
    context.lineJoin = 'round';
    context.lineCap = lineCap;
    let current;
    let start = 0;
    const flush = (end) => {
      context.beginPath();
      context.moveTo(points[start].x, points[start].y);
      for (let index = start + 1; index <= end; index++) {
        context.lineTo(points[index].x, points[index].y);
      }
      context.strokeStyle = current;
      context.stroke();
    };
    for (let index = 0; index < points.length; index++) {
      const colour = colorOf(points[index]);
      if (index === 0) {
        current = colour;
        continue;
      }
      if (colour !== current) {
        flush(index);
        start = index;
        current = colour;
      }
    }
    if (points.length > 1) {
      flush(points.length - 1);
    }
    context.lineCap = 'butt';
  }

  function shade(hexColour, factor) {
    const number = parseInt(hexColour.slice(1), 16);
    const red = Math.min(255, ((number >> 16) & 255) * factor);
    const green = Math.min(255, ((number >> 8) & 255) * factor);
    const blue = Math.min(255, (number & 255) * factor);
    return `rgb(${red | 0},${green | 0},${blue | 0})`;
  }

  // Launch pad, tower and a few buildings, drawn in the body's local frame.
  function drawSpaceCenter(camera, body, time, relative, pixelSize) {
    const longitude = body.pad.lon;
    const angle = longitude + FS.bodyRot(body, time);
    const base = {
      x: relative.x + Math.cos(angle) * (body.R + body.pad.height),
      y: relative.y + Math.sin(angle) * (body.R + body.pad.height),
    };
    context.save();
    context.translate(base.x, base.y);
    context.rotate(angle - Math.PI / 2); // local +y = up
    context.lineWidth = pixelSize;
    context.strokeStyle = 'rgba(15,18,24,0.7)';
    // pad slab
    context.fillStyle = '#6f7378';
    context.fillRect(-14, -3, 28, 3);
    context.strokeRect(-14, -3, 28, 3);
    context.fillStyle = '#4b4f55';
    context.fillRect(-4, -0.4, 8, 0.4);
    // tower (lattice)
    context.fillStyle = '#a33b2b';
    context.fillRect(7, 0, 2.6, 34);
    context.strokeStyle = 'rgba(40,10,5,0.8)';
    for (let lineY = 0; lineY < 34; lineY += 2.6) {
      context.beginPath();
      context.moveTo(7, lineY);
      context.lineTo(9.6, lineY + 2.6);
      context.moveTo(9.6, lineY);
      context.lineTo(7, lineY + 2.6);
      context.stroke();
    }
    context.fillStyle = '#d9d4c7';
    context.fillRect(6.5, 34, 3.6, 2);
    // light on tower
    context.fillStyle = time % 2 < 1 ? '#ff4a3a' : '#5a1a14';
    context.fillRect(8, 36, 0.8, 0.8);
    // buildings
    const blds = [
      [-160, 46, 38, '#c9ccd1'],
      [-95, 22, 14, '#b4b9bf'],
      [-60, 12, 9, '#9da3aa'],
      [70, 30, 10, '#bfc3c8'],
      [110, 16, 22, '#aeb3b9'],
    ];
    for (const [buildingX, buildingWidth, buildingHeight, colour] of blds) {
      context.fillStyle = colour;
      context.fillRect(buildingX, -2, buildingWidth, buildingHeight + 2);
      context.strokeStyle = 'rgba(15,18,24,0.6)';
      context.strokeRect(buildingX, -2, buildingWidth, buildingHeight + 2);
      context.fillStyle = 'rgba(40,70,110,0.55)';
      for (let windowY = 3; windowY < buildingHeight - 2; windowY += 4) {
        for (let windowX = buildingX + 2; windowX < buildingX + buildingWidth - 3; windowX += 4) {
          context.fillRect(windowX, windowY, 2, 1.6);
        }
      }
    }
    // big hangar door
    context.fillStyle = '#2d4e7c';
    context.fillRect(-150, -2, 18, 26);
    context.restore();
  }

  // ---- Vessel ----
  // Where a craft is drawn: its centre of mass on screen, and the turn of its drawing frame
  // (x = the craft's x, y = minus the craft's y). Shared by drawVessel and part clicks.
  function vesselFrame(camera, vessel, time) {
    const centre = Vector.add(FS.bodyAbs(vessel.body, time), vessel.r);
    return {
      sp: worldToScreenPoint(camera, centre.x, centre.y),
      th: -(vessel.angle - camera.rot) + Math.PI / 2,
    };
  }
  Render.partToScreen = (camera, vessel, time, point) => {
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
  Render.screenToPart = (camera, vessel, time, screenX, screenY) => {
    const frame = vesselFrame(camera, vessel, time);
    const deltaX = (screenX - frame.sp.x) / camera.s;
    const deltaY = (screenY - frame.sp.y) / camera.s;
    const cosAngle = Math.cos(-frame.th);
    const sinAngle = Math.sin(-frame.th);
    return { x: deltaX * cosAngle - deltaY * sinAngle, y: -(deltaX * sinAngle + deltaY * cosAngle) };
  };

  Render.drawVessel = (camera, vessel, time, opts = {}) => {
    const centre = Vector.add(FS.bodyAbs(vessel.body, time), vessel.r);
    const screenPoint = worldToScreenPoint(camera, centre.x, centre.y);
    const craftLength = vessel.layout.height * camera.s;
    setScreen();
    if (craftLength < 6) {
      // too small to draw: draw a marker
      context.save();
      context.translate(screenPoint.x, screenPoint.y);
      const screenAngle = -(vessel.angle - camera.rot);
      context.rotate(screenAngle);
      context.fillStyle = vessel.isDebris ? 'rgba(200,200,200,0.6)' : '#ffd27a';
      context.beginPath();
      context.moveTo(6, 0);
      context.lineTo(-4, 4);
      context.lineTo(-2, 0);
      context.lineTo(-4, -4);
      context.closePath();
      context.fill();
      context.restore();
      return;
    }
    context.save();
    context.translate(screenPoint.x, screenPoint.y);
    const sigma = -(vessel.angle - camera.rot);
    context.rotate(sigma + Math.PI / 2);
    context.scale(camera.s, camera.s);
    const pixelSize = 1 / camera.s;
    // parachute canopy
    // Drawing frame: x = the craft's x, y = minus the craft's y (down the rocket).
    const chutes = vessel.parts.filter((part) => part.chute === 'semi' || part.chute === 'full');
    if (chutes.length) {
      const full = chutes.some((part) => part.chute === 'full');
      const chutePart = chutes[0];
      const chuteTip = Vector.add(chutePart.c, Vector.scale(chutePart.axis, chutePart.len / 2));
      context.save();
      context.translate(chuteTip.x, -chuteTip.y);
      const top = 0;
      const dist = full ? 11 : 6;
      const canopyWidth = full ? 7.5 : 1.6;
      context.strokeStyle = 'rgba(230,230,230,0.8)';
      context.lineWidth = pixelSize;
      context.beginPath();
      context.moveTo(0, top);
      context.lineTo(-canopyWidth, top - dist);
      context.moveTo(0, top);
      context.lineTo(canopyWidth, top - dist);
      context.moveTo(0, top);
      context.lineTo(0, top - dist - canopyWidth * 0.3);
      context.stroke();
      context.beginPath();
      context.moveTo(-canopyWidth, top - dist);
      context.quadraticCurveTo(
        -canopyWidth,
        top - dist - canopyWidth * 0.9,
        0,
        top - dist - canopyWidth * 0.9,
      );
      context.quadraticCurveTo(canopyWidth, top - dist - canopyWidth * 0.9, canopyWidth, top - dist);
      context.quadraticCurveTo(0, top - dist - canopyWidth * 0.25, -canopyWidth, top - dist);
      context.fillStyle = '#e8622a';
      context.fill();
      context.fillStyle = '#f4efe6';
      context.beginPath();
      context.moveTo(-canopyWidth * 0.35, top - dist - canopyWidth * 0.12);
      context.quadraticCurveTo(
        -canopyWidth * 0.3,
        top - dist - canopyWidth * 0.85,
        0,
        top - dist - canopyWidth * 0.88,
      );
      context.quadraticCurveTo(
        canopyWidth * 0.3,
        top - dist - canopyWidth * 0.85,
        canopyWidth * 0.35,
        top - dist - canopyWidth * 0.12,
      );
      context.closePath();
      context.fill();
      context.restore();
    }
    const glowMap = new Map();
    if (vessel.nozzles) {
      vessel.nozzles.forEach((nozzle) => glowMap.set(nozzle.part, nozzle.power));
    }
    for (const part of vessel.parts) {
      context.save();
      context.translate(part.c.x, -part.c.y);
      context.rotate(-part.rot);
      if (part.flip) {
        context.scale(-1, 1);
      }
      FS.drawPart(context, part, -part.len / 2, pixelSize, { glow: glowMap.get(part) || 0 });
      context.restore();
    }
    context.restore();
  };

  // Reentry glow in front of the vessel.
  function drawReentry(camera, vessel, time) {
    if (vessel.heat <= 0.01) {
      return;
    }
    const body = vessel.body;
    const vAir = Vector.sub(vessel.v, FS.airVel(body, vessel.r));
    const direction = Vector.norm(vAir);
    const centre = Vector.add(FS.bodyAbs(body, time), vessel.r);
    const lead = Vector.add(centre, Vector.scale(direction, vessel.layout.height * 0.45));
    const screenPoint = worldToScreenPoint(camera, lead.x, lead.y);
    const trailPoint = worldToScreenPoint(camera, lead.x - direction.x * 40, lead.y - direction.y * 40);
    setScreen();
    context.save();
    context.globalCompositeOperation = 'lighter';
    const size = Math.max(14, vessel.layout.height * camera.s * 0.9);
    context.globalAlpha = vessel.heat * 0.9;
    context.drawImage(sprites.glow, screenPoint.x - size, screenPoint.y - size, size * 2, size * 2);
    // streaks
    context.strokeStyle = `rgba(255,170,90,${0.5 * vessel.heat})`;
    context.lineWidth = 2;
    for (let streak = -2; streak <= 2; streak++) {
      const offset = streak * size * 0.25;
      const normalX = -(trailPoint.y - screenPoint.y);
      const normalY = trailPoint.x - screenPoint.x;
      const normalLength = Math.hypot(normalX, normalY) || 1;
      context.beginPath();
      context.moveTo(
        screenPoint.x + (normalX / normalLength) * offset,
        screenPoint.y + (normalY / normalLength) * offset,
      );
      context.lineTo(
        trailPoint.x + (normalX / normalLength) * offset * 3 + (Math.random() - 0.5) * 6,
        trailPoint.y + (normalY / normalLength) * offset * 3,
      );
      context.stroke();
    }
    context.restore();
  }

  // ---- Particles ----
  // Stored relative to the body the active vessel is in.
  Render.particles = [];
  Render.clearParticles = () => (Render.particles.length = 0);
  Render.stats = () => ({ particles: Render.particles.length });

  // Visual reactions to simulation events.
  Render.subscribe = (game) => subscribe(game);
  function subscribe(game) {
    game.on('exploded', ({ vessel }) => {
      const active = game.vessel;
      if (active && vessel.body === active.body) {
        Render.emitExplosion(vessel.body, vessel.r, vessel.v, Math.max(2, vessel.layout.height * 0.4));
      }
    });
    game.on('soi', ({ vessel }) => {
      if (vessel === game.vessel) {
        Render.clearParticles();
      }
    });
    game.on('flight-start', () => Render.clearParticles());
  }

  // Advance particles by the simulated time of the last frame (game.frame, set by sim.js).
  Render.update = (game) => {
    const frame = game.frame;
    const vessel = game.vessel;
    if (!frame || !vessel) {
      return;
    }
    if (!frame.physics) {
      Render.clearParticles();
      return;
    } // nothing burns on rails
    // move existing particles first, then add new ones at the current time
    Render.updateParticles(frame.simDt, vessel.body, game.t);
    if (!vessel.dead && frame.rate <= 4) {
      Render.emitExhaust(vessel, frame.simDt, game.t);
    }
    for (const debrisVessel of game.debris) {
      if (!debrisVessel.dead && debrisVessel.body === vessel.body) {
        Render.emitExhaust(debrisVessel, frame.simDt, game.t);
      }
    }
  };

  Render.emitExhaust = (vessel, timeStep, time) => {
    if (!vessel.nozzles || !vessel.nozzles.length) {
      return;
    }
    const body = vessel.body;
    const pressure = FS.pressure(body, vessel.altitude);
    for (const nozzle of vessel.nozzles) {
      const enginePart = nozzle.part;
      if (!vessel.parts.includes(enginePart)) {
        continue;
      }
      const partType = enginePart.def;
      // each engine pushes along its own axis; exhaust leaves from the bottom of its nozzle
      const nozzleDirection = vessel.toWorld(enginePart.axis);
      const side = Vector.perp(nozzleDirection);
      const position = Vector.add(
        vessel.r,
        vessel.toWorld(Vector.sub(enginePart.c, Vector.scale(enginePart.axis, enginePart.len / 2))),
      );
      const power = nozzle.power;
      const count = Math.ceil(timeStep * 120 * power * (enginePart.w > 2 ? 2 : 1));
      const spread = (1 - pressure) * 0.9 + 0.12;
      for (let particleIndex = 0; particleIndex < count; particleIndex++) {
        const speed = 40 + Math.random() * 40;
        const sideways = (Math.random() - 0.5) * 2 * spread * speed * 0.6;
        const velocity = Vector.add(
          vessel.v,
          Vector.add(Vector.scale(nozzleDirection, -speed), Vector.scale(side, sideways)),
        );
        const jitter = Math.random() * timeStep;
        Render.particles.push({
          x: position.x + velocity.x * jitter - vessel.v.x * jitter,
          y: position.y + velocity.y * jitter - vessel.v.y * jitter,
          vx: velocity.x,
          vy: velocity.y,
          life: 0,
          max: 0.25 + Math.random() * 0.35,
          size: enginePart.w * (0.7 + Math.random() * 0.5),
          grow: 2.5 + (1 - pressure) * 4,
          kind: nozzle.solid ? 'flame' : pressure < 0.05 ? 'blue' : 'flame',
        });
        if (pressure > 0.02 && Math.random() < 0.55) {
          Render.particles.push({
            x: position.x,
            y: position.y,
            vx: vessel.v.x + (velocity.x - vessel.v.x) * 0.9 + (Math.random() - 0.5) * 6,
            vy: vessel.v.y + (velocity.y - vessel.v.y) * 0.9 + (Math.random() - 0.5) * 6,
            life: 0,
            max: 1.0 + Math.random() * 1.8 * pressure,
            size: enginePart.w * 1.1,
            grow: 3 + 6 * pressure,
            kind: 'smoke',
          });
        }
      }
    }
  };

  Render.emitExplosion = (body, position, velocity, size = 4) => {
    for (let particleIndex = 0; particleIndex < 90; particleIndex++) {
      const angle = Math.random() * FULL_TURN;
      const speed = Math.random() * 30 * Math.sqrt(size);
      Render.particles.push({
        x: position.x,
        y: position.y,
        vx: velocity.x + Math.cos(angle) * speed,
        vy: velocity.y + Math.sin(angle) * speed,
        life: 0,
        max: 0.4 + Math.random() * 0.9,
        size: size * (0.6 + Math.random()),
        grow: 6,
        kind: 'flame',
      });
    }
    for (let particleIndex = 0; particleIndex < 60; particleIndex++) {
      const angle = Math.random() * FULL_TURN;
      const speed = Math.random() * 12 * Math.sqrt(size);
      Render.particles.push({
        x: position.x,
        y: position.y,
        vx: velocity.x + Math.cos(angle) * speed,
        vy: velocity.y + Math.sin(angle) * speed,
        life: 0,
        max: 2 + Math.random() * 4,
        size: size * 1.5,
        grow: 8,
        kind: 'smoke',
      });
    }
  };

  Render.updateParticles = (timeStep, body, time) => {
    const particles = Render.particles;
    let keepCount = 0;
    for (let index = 0; index < particles.length; index++) {
      const particle = particles[index];
      particle.life += timeStep;
      if (particle.life > particle.max) {
        continue;
      }
      const distanceSquared = particle.x * particle.x + particle.y * particle.y;
      const distance = Math.sqrt(distanceSquared);
      const altitude = distance - body.R;
      const airDensity = FS.density(body, altitude);
      const gravityFactor = -body.mu / (distanceSquared * distance);
      particle.vx += particle.x * gravityFactor * timeStep;
      particle.vy += particle.y * gravityFactor * timeStep;
      if (airDensity > 0) {
        const dragFactor = Math.min(1, airDensity * (particle.kind === 'smoke' ? 2.2 : 1.6) * timeStep);
        const airVelocityX = -body.omega * particle.y;
        const airVelocityY = body.omega * particle.x;
        particle.vx += (airVelocityX - particle.vx) * dragFactor;
        particle.vy += (airVelocityY - particle.vy) * dragFactor;
      }
      particle.x += particle.vx * timeStep;
      particle.y += particle.vy * timeStep;
      if (
        altitude < body.terrain.amp * 2.5 &&
        distance < body.R + FS.surfaceHeight(body, FS.lonAt(body, Math.atan2(particle.y, particle.x), time))
      ) {
        // hit the ground: spread out sideways
        const localUp = { x: particle.x / distance, y: particle.y / distance };
        const groundVelocityX = -body.omega * particle.y;
        const groundVelocityY = body.omega * particle.x; // ground velocity
        let relativeX = particle.vx - groundVelocityX;
        let relativeY = particle.vy - groundVelocityY;
        const normalSpeed = relativeX * localUp.x + relativeY * localUp.y;
        if (normalSpeed < 0) {
          relativeX -= localUp.x * normalSpeed;
          relativeY -= localUp.y * normalSpeed;
          if (normalSpeed < -3) {
            // first hard impact: splash sideways, either way
            const side = Math.random() < 0.5 ? -1 : 1;
            relativeX += -localUp.y * side * -normalSpeed * 0.6;
            relativeY += localUp.x * side * -normalSpeed * 0.6;
          } else {
            const friction = Math.max(0, 1 - 1.5 * timeStep); // ground friction
            relativeX *= friction;
            relativeY *= friction;
          }
          particle.vx = groundVelocityX + relativeX;
          particle.vy = groundVelocityY + relativeY;
        }
        particle.x += localUp.x * 0.3;
        particle.y += localUp.y * 0.3;
      }
      particles[keepCount++] = particle;
    }
    particles.length = keepCount;
    if (particles.length > 6000) {
      particles.splice(0, particles.length - 6000);
    }
  };

  function drawParticles(camera, body, time) {
    const base = FS.bodyAbs(body, time);
    setScreen();
    context.save();
    // smoke first (normal blending), then flames (additive)
    for (const pass of ['smoke', 'fire']) {
      context.globalCompositeOperation = pass === 'fire' ? 'lighter' : 'source-over';
      for (const particle of Render.particles) {
        const isSmoke = particle.kind === 'smoke';
        if ((pass === 'smoke') !== isSmoke) {
          continue;
        }
        const screenPoint = worldToScreenPoint(camera, base.x + particle.x, base.y + particle.y);
        const lifeFraction = particle.life / particle.max;
        const size = Math.max(1.5, (particle.size + particle.grow * particle.life) * camera.s);
        if (
          screenPoint.x < -size ||
          screenPoint.y < -size ||
          screenPoint.x > viewWidth + size ||
          screenPoint.y > viewHeight + size
        ) {
          continue;
        }
        context.globalAlpha = isSmoke ? (1 - lifeFraction) * 0.7 : (1 - lifeFraction) * (1 - lifeFraction);
        const puffSprite = isSmoke ? sprites.smoke : particle.kind === 'blue' ? sprites.blue : sprites.flame;
        context.drawImage(puffSprite, screenPoint.x - size, screenPoint.y - size, size * 2, size * 2);
      }
    }
    context.restore();
  }

  // ---- Flight view ----
  Render.drawFlight = (game) => {
    const vessel = game.vessel;
    const time = game.t;
    const camera = game.cam;
    const currentBody = vessel.body;
    setScreen();
    // Sky
    const altitude = vessel.altitude;
    let skyT = 1;
    let light = 1;
    const localUp = Vector.norm(vessel.r);
    light = sunlight(localUp);
    if (currentBody.atmo) {
      skyT = FS.clamp(Math.pow(Math.max(altitude, 0) / currentBody.atmo.height, 0.55), 0, 1);
    }
    const sunsetK = currentBody.atmo
      ? (1 - skyT) * Math.exp(-Math.pow(Vector.dot(localUp, FS.SUN_DIR) / 0.18, 2))
      : 0;
    const daylight = currentBody.atmo ? (1 - skyT) * light : 0;
    const top = mix([6, 9, 20], [58, 118, 196], daylight);
    const horizonColour = mix(mix([8, 12, 26], [140, 190, 236], daylight), [236, 132, 72], sunsetK * 0.8);
    const gradient = context.createLinearGradient(0, 0, 0, viewHeight);
    gradient.addColorStop(0, toRgb(top));
    gradient.addColorStop(1, toRgb(horizonColour));
    context.fillStyle = gradient;
    context.fillRect(0, 0, viewWidth, viewHeight);
    drawStars(camera, 1 - daylight * 1.15, true);

    // Bodies: farthest first
    const order = FS.bodies
      .slice()
      .sort(
        (first, second) =>
          Vector.len(Vector.sub(FS.bodyAbs(second, time), camera)) -
          Vector.len(Vector.sub(FS.bodyAbs(first, time), camera)),
      );
    for (const body of order) {
      drawBody(camera, body, time, { minPx: 2 });
    }

    // When the ground is out of view, a soft glow at the bottom shows where it is
    {
      const viewR = Math.hypot(viewWidth, viewHeight) / 2 / camera.s;
      if (vessel.altitude - currentBody.terrain.amp * 2.5 > viewR) {
        setScreen();
        const colour = currentBody.atmo ? currentBody.atmo.color : [150, 150, 150];
        const strength = FS.clamp(1.2 - Math.log10(vessel.altitude / viewR) * 0.25, 0.25, 1);
        const glowGradient = context.createLinearGradient(0, viewHeight, 0, viewHeight * 0.55);
        glowGradient.addColorStop(0, `rgba(${colour[0]},${colour[1]},${colour[2]},${0.28 * strength})`);
        glowGradient.addColorStop(1, `rgba(${colour[0]},${colour[1]},${colour[2]},0)`);
        context.fillStyle = glowGradient;
        context.fillRect(0, viewHeight * 0.55, viewWidth, viewHeight * 0.45);
      }
    }

    // Night darkening of the near surface
    if (currentBody.atmo && light < 1 && altitude < currentBody.atmo.height * 2) {
      setScreen();
      context.fillStyle = `rgba(3,5,14,${(1 - light) * 0.55 * (1 - skyT * 0.6)})`;
      context.fillRect(0, 0, viewWidth, viewHeight);
    }

    drawParticles(camera, currentBody, time);
    for (const debrisVessel of game.debris) {
      if (!debrisVessel.dead) {
        Render.drawVessel(camera, debrisVessel, time);
      }
    }
    if (!vessel.dead) {
      Render.drawVessel(camera, vessel, time);
      drawReentry(camera, vessel, time);
    }
  };

  function mix(first, second, fraction) {
    return [
      first[0] + (second[0] - first[0]) * fraction,
      first[1] + (second[1] - first[1]) * fraction,
      first[2] + (second[2] - first[2]) * fraction,
    ];
  }
  function toRgb(colour) {
    return `rgb(${colour[0] | 0},${colour[1] | 0},${colour[2] | 0})`;
  }

  // ---- Map view ----
  const PATCH_COLORS = ['#55d6ff', '#ffb547', '#ff6fb1'];

  Render.drawMap = (game) => {
    const time = game.t;
    const camera = game.mapCam;
    setScreen();
    context.fillStyle = '#05070f';
    context.fillRect(0, 0, viewWidth, viewHeight);
    drawStars(camera, 0.8, false);

    // Orbits and SOIs of bodies
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
    for (const body of FS.bodies) {
      drawBody(camera, body, time, { minPx: 3.5 });
    }
    // Labels
    setScreen();
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

    const vessel = game.vessel;
    if (!vessel.dead && !vessel.landed) {
      drawPatches(camera, game.patches, time, false);
      if (game.node && game.nodePatches) {
        drawPatches(camera, game.nodePatches, time, true, game.node.originT);
      }
    }
    // Node marker
    if (game.node) {
      const node = game.node;
      // A node on a later patch is drawn around where its body will be when that patch starts.
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
    // Vessel
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

  function drawPatches(camera, patches, time, planned, firstRef) {
    if (!patches) {
      return;
    }
    patches.forEach((patch, index) => {
      const orbit = patch.orbit;
      // Frame: the current SOI body is drawn where it is now; later patches
      // are drawn around where their body will be when the patch starts.
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
      points.forEach((point, index) => {
        const screenPoint = worldToScreenPoint(camera, origin.x + point.x, origin.y + point.y);
        index ? context.lineTo(screenPoint.x, screenPoint.y) : context.moveTo(screenPoint.x, screenPoint.y);
      });
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
      // ghost body at encounter
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
      // Ap / Pe markers
      const body = patch.body;
      const mark = (trueAnomaly, label, value) => {
        const dtTo = FS.timeToNu(orbit, trueAnomaly, startTime);
        if (!isFinite(dtTo) || startTime + dtTo > patch.tEnd) {
          return;
        }
        const state = FS.orbitState(orbit, startTime + dtTo);
        const screenPoint = worldToScreenPoint(camera, origin.x + state.r.x, origin.y + state.r.y);
        marker(screenPoint, label, FS.fmtDist(value));
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
          screenPoint,
          label,
          FS.fmtTime(patch.tEnd - time),
          patch.end === 'impact' ? '#ff6b5a' : '#c7d6ff',
        );
      }
    });
  }

  function marker(screenPoint, label, value, colour = '#ffe2a6') {
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

  // The active renderer until main.js picks one (WebGL2 when available).
  FS.Renderer = Render;
})();
