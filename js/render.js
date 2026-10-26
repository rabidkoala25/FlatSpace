// render.js — the Canvas 2D renderer: flight view, map view, particles and effects.
// Since step B1 the game draws with the WebGL2 renderer (render-gl.js); this one is the
// fallback for browsers without WebGL2. The particle simulation here is shared by both.
//
// Renderer interface. The rest of the game only talks to Flatspace.Renderer through these
// methods, so renderers can be swapped:
//   init(canvas, game)         set up, and subscribe to game events (explosions, SOI changes)
//   resize()                   the canvas changed size
//   size() -> {W, H}           canvas size in CSS pixels
//   update(game)               advance visual-only state (particles) by game.frame.simulationStep
//   drawFlight(game)           draw the flight view
//   drawMap(game)              draw the map view
//   worldToScreen(camera, x, y)   world metres → screen pixels, for map clicks
//   partToScreen(camera, vessel, time, point)  a point on a craft (craft frame, from its centre of mass) → screen
//   screenToPart(camera, vessel, time, x, y) the reverse, for clicking parts in flight
//   stats() -> {particles}     numbers for the F3 developer overlay
// The renderer only reads game state; it never changes the simulation.
(function () {
  const Vector = Flatspace.Vector;
  const FULL_TURN = Flatspace.TAU;
  const Render = (Flatspace.Render = {});
  Flatspace.SUN_DIRECTION = { x: 1, y: 0 }; // sunlight comes from +x (far away)

  let viewCanvas;
  let context;
  let viewWidth = 0;
  let viewHeight = 0;
  let pixelRatio = 1;
  const stars = [];
  const sprites = {};

  Render.initialise = (canvas, game) => {
    viewCanvas = canvas;
    if (game) {
      subscribe(game);
    }
    context = canvas.getContext('2d');
    const random = Flatspace.seededRandom(4242);
    for (let starIndex = 0; starIndex < 700; starIndex++) {
      const angle = random() * FULL_TURN;
      const distance = Math.sqrt(random());
      const temp = random();
      stars.push({
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
        size: Math.pow(random(), 6) * 1.8 + 0.4,
        brightness: 0.35 + random() * 0.65,
        colour: temp < 0.15 ? '255,214,170' : temp > 0.85 ? '178,206,255' : '240,244,255',
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
  Render.size = () => ({ width: viewWidth, height: viewHeight });

  // ---- Camera transforms ----
  // camera: {x, y (absolute metres), scale (px per metre), rotation (radians)}
  function worldToScreenPoint(camera, x, y) {
    const deltaX = x - camera.x;
    const deltaY = y - camera.y;
    const cosRotation = Math.cos(camera.rotation);
    const sinRotation = Math.sin(camera.rotation);
    const rotatedX = deltaX * cosRotation + deltaY * sinRotation;
    const rotatedY = -deltaX * sinRotation + deltaY * cosRotation;
    return { x: viewWidth / 2 + rotatedX * camera.scale, y: viewHeight / 2 - rotatedY * camera.scale };
  }
  Render.worldToScreen = worldToScreenPoint;
  Render.worldToScreen = worldToScreenPoint;
  Render.screenToWorld = (camera, screenX, screenY) => {
    const rotatedX = (screenX - viewWidth / 2) / camera.scale;
    const rotatedY = -(screenY - viewHeight / 2) / camera.scale;
    const cosRotation = Math.cos(camera.rotation);
    const sinRotation = Math.sin(camera.rotation);
    return {
      x: camera.x + rotatedX * cosRotation - rotatedY * sinRotation,
      y: camera.y + rotatedX * sinRotation + rotatedY * cosRotation,
    };
  };
  // Set the context so that drawing in (absolute - camera) metre coordinates works.
  function setWorld(camera) {
    const cosScaled = Math.cos(camera.rotation) * camera.scale;
    const sinScaled = Math.sin(camera.rotation) * camera.scale;
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
    const rotation = rotate ? camera.rotation : 0;
    const cosRotation = Math.cos(-rotation);
    const sinRotation = Math.sin(-rotation);
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
      const starX = viewWidth / 2 + (star.x * cosRotation - star.y * sinRotation) * skyRadius;
      const starY = viewHeight / 2 + (star.x * sinRotation + star.y * cosRotation) * skyRadius;
      if (starX < -2 || starY < -2 || starX > viewWidth + 2 || starY > viewHeight + 2) {
        continue;
      }
      context.fillStyle = `rgba(${star.colour},${star.brightness * alpha})`;
      context.fillRect(starX, starY, star.size, star.size);
    }
  }

  // Lighting factor for a point on a body: 1 = noon, 0 = night.
  function sunlight(localUp) {
    const sunDot = Vector.dot(localUp, Flatspace.SUN_DIRECTION);
    return Flatspace.smoothstep(-0.12, 0.25, sunDot);
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
    if (height > (body.ocean ? 1900 : body.terrain.amplitude * 0.6)) {
      return body.colors.rock;
    }
    return body.colors.land;
  }

  function drawBody(camera, body, time, options = {}) {
    const centre = Flatspace.bodyAbsolutePosition(body, time);
    const relative = Vector.subtract(centre, camera);
    const distance = Vector.length(relative);
    const radiusPixels = body.radius * camera.scale;
    const viewRadius = Math.hypot(viewWidth, viewHeight) / 2 / camera.scale;
    const atmosphereHeight = body.atmosphere ? body.atmosphere.height : 0;
    const maxHeight = body.terrain.amplitude * 2.5;
    const rotation = Flatspace.bodyRotation(body, time);
    const pixelSize = 1 / camera.scale;

    if (radiusPixels < 4) {
      if (distance - body.radius > viewRadius * 1.2) {
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
      context.arc(
        screenPoint.x,
        screenPoint.y,
        Math.max(radiusPixels, options.minPixels || 2.5),
        0,
        FULL_TURN,
      );
      context.fillStyle = body.colors.disc;
      context.fill();
      return;
    }

    const haloRadius = body.radius + atmosphereHeight * 1.4;
    const surfaceVisible = distance - body.radius - maxHeight < viewRadius;
    const haloVisible = body.atmosphere && distance - haloRadius < viewRadius;
    if (!surfaceVisible && !haloVisible) {
      return;
    }

    setWorld(camera);
    const localUp = distance > 0 ? Vector.scale(relative, -1 / distance) : { x: 0, y: 1 }; // centre → camera
    const cameraAngle = Math.atan2(localUp.y, localUp.x);
    const full = radiusPixels < 4000;
    const near = !full && radiusPixels > 30000 && distance - body.radius < viewRadius * 3 + maxHeight;

    // Visible window of longitudes
    let startAngle = 0;
    let endAngle = FULL_TURN;
    let sampleCount;
    if (!full) {
      const span =
        distance > viewRadius * 1.5
          ? Math.min(Math.PI, Math.asin(Math.min(1, (viewRadius * 1.5) / distance)) + 0.002)
          : Math.PI;
      startAngle = cameraAngle - span;
      endAngle = cameraAngle + span;
      sampleCount = near ? 420 : 360;
    } else {
      sampleCount = Math.round(Flatspace.clamp(radiusPixels * 0.8, 96, 1600));
    }
    const arcPath = (radius, from, toAngle, steps, move = true) => {
      for (let step = 0; step <= steps; step++) {
        const angle = from + ((toAngle - from) * step) / steps;
        const pointX = relative.x + Math.cos(angle) * radius;
        const pointY = relative.y + Math.sin(angle) * radius;
        step === 0 && move ? context.moveTo(pointX, pointY) : context.lineTo(pointX, pointY);
      }
    };
    const deepRadius = full ? 0 : Math.max(0, body.radius - maxHeight - viewRadius * 2.5);
    const closeDeep = () => {
      if (full) {
        return;
      }
      context.lineTo(
        relative.x + Math.cos(endAngle) * deepRadius,
        relative.y + Math.sin(endAngle) * deepRadius,
      );
      context.lineTo(
        relative.x + Math.cos(startAngle) * deepRadius,
        relative.y + Math.sin(startAngle) * deepRadius,
      );
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
    if (body.atmosphere && !near) {
      const [red, green, blue] = body.atmosphere.color;
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
          body.radius * 0.98,
          relative.x,
          relative.y,
          haloRadius,
        );
        stops.forEach(([offset, colour]) => gradient.addColorStop(offset, colour));
        context.fillStyle = gradient;
        context.arc(relative.x, relative.y, haloRadius, 0, FULL_TURN);
      } else {
        context.fillStyle = localGrad(body.radius * 0.98, haloRadius, stops);
        arcPath(haloRadius, startAngle, endAngle, sampleCount);
        arcPath(body.radius * 0.98, endAngle, startAngle, sampleCount, false);
        context.closePath();
      }
      context.fill();
    }
    if (!surfaceVisible) {
      return;
    }

    // Sample the surface once
    const points = [];
    for (let step = 0; step <= sampleCount; step++) {
      const angle = startAngle + ((endAngle - startAngle) * step) / sampleCount;
      const height = Flatspace.terrainHeight(body, angle - rotation);
      points.push({
        angle,
        height,
        x: relative.x + Math.cos(angle) * (body.radius + height),
        y: relative.y + Math.sin(angle) * (body.radius + height),
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
      context.fillStyle = localGrad(body.radius, body.radius - viewRadius * 1.5, [
        [0, body.colors.land],
        [1, body.colors.landDeep],
      ]);
      context.fill();
      strokeRuns(
        points,
        (point) => {
          const colour = surfaceColor(body, Math.max(point.height, body.ocean ? 0 : point.height));
          return colour === body.colors.land ? shade(body.colors.land, 1.3) : colour;
        },
        pixelSize * 3,
      );
      if (body.ocean) {
        context.beginPath();
        arcPath(body.radius, startAngle, endAngle, sampleCount);
        closeDeep();
        context.closePath();
        context.fillStyle = localGrad(body.radius, body.radius - viewRadius, [
          [0, body.colors.ocean],
          [1, body.colors.oceanDeep],
        ]);
        context.fill();
        context.beginPath();
        let penDown = false;
        for (const point of points) {
          const pointX = relative.x + Math.cos(point.angle) * body.radius;
          const pointY = relative.y + Math.sin(point.angle) * body.radius;
          if (point.height > 0) {
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
      if (body.launchPad) {
        drawSpaceCenter(camera, body, time, relative, pixelSize);
      }
      return;
    }

    // ---- Disc: interior, then a coloured band showing the surface type ----
    const band = Math.max(pixelSize * 3, body.radius * 0.035);
    context.beginPath();
    if (full) {
      context.arc(relative.x, relative.y, body.radius, 0, FULL_TURN);
    } else {
      arcPath(body.radius, startAngle, endAngle, sampleCount);
      closeDeep();
      context.closePath();
    }
    const interior = body.ocean ? body.colors.oceanDeep : body.colors.landDeep;
    if (full) {
      const gradient = context.createRadialGradient(
        relative.x,
        relative.y,
        body.radius * 0.2,
        relative.x,
        relative.y,
        body.radius,
      );
      gradient.addColorStop(0, shade(interior, 0.75));
      gradient.addColorStop(1, interior);
      context.fillStyle = gradient;
    } else {
      context.fillStyle = interior;
    }
    context.fill();
    // surface band (stroked arc runs)
    const bandPoints = points.map((point) => ({
      ...point,
      x: relative.x + Math.cos(point.angle) * (body.radius - band / 2),
      y: relative.y + Math.sin(point.angle) * (body.radius - band / 2),
    }));
    strokeRuns(bandPoints, (point) => surfaceColor(body, point.height), band, 'butt');
    // relief line on top
    context.beginPath();
    points.forEach((point, index) => {
      const radius = body.radius + Math.max(body.ocean ? 0 : -1e9, point.height);
      const pointX = relative.x + Math.cos(point.angle) * radius;
      const pointY = relative.y + Math.sin(point.angle) * radius;
      index ? context.lineTo(pointX, pointY) : context.moveTo(pointX, pointY);
    });
    context.strokeStyle = 'rgba(255,255,255,0.25)';
    context.lineWidth = pixelSize;
    context.stroke();

    // Night side
    const sunDirection = Flatspace.SUN_DIRECTION;
    if (full) {
      const gradient = context.createRadialGradient(
        relative.x + sunDirection.x * body.radius * 0.6,
        relative.y + sunDirection.y * body.radius * 0.6,
        body.radius * 0.1,
        relative.x + sunDirection.x * body.radius * 0.25,
        relative.y + sunDirection.y * body.radius * 0.25,
        body.radius * 1.35,
      );
      gradient.addColorStop(0, 'rgba(4,6,14,0)');
      gradient.addColorStop(0.62, 'rgba(4,6,14,0.05)');
      gradient.addColorStop(1, 'rgba(4,6,14,0.82)');
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(relative.x, relative.y, body.radius + 1 * pixelSize, 0, FULL_TURN);
      context.fill();
    } else {
      const dark = (1 - sunlight(localUp)) * 0.7;
      if (dark > 0.01) {
        context.beginPath();
        arcPath(body.radius + band * 0.1, startAngle, endAngle, sampleCount);
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
    const longitude = body.launchPad.longitude;
    const angle = longitude + Flatspace.bodyRotation(body, time);
    const base = {
      x: relative.x + Math.cos(angle) * (body.radius + body.launchPad.height),
      y: relative.y + Math.sin(angle) * (body.radius + body.launchPad.height),
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
    const buildings = [
      [-160, 46, 38, '#c9ccd1'],
      [-95, 22, 14, '#b4b9bf'],
      [-60, 12, 9, '#9da3aa'],
      [70, 30, 10, '#bfc3c8'],
      [110, 16, 22, '#aeb3b9'],
    ];
    for (const [buildingX, buildingWidth, buildingHeight, colour] of buildings) {
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
    const centre = Vector.add(Flatspace.bodyAbsolutePosition(vessel.body, time), vessel.position);
    return {
      screenCentre: worldToScreenPoint(camera, centre.x, centre.y),
      screenAngle: -(vessel.angle - camera.rotation) + Math.PI / 2,
    };
  }
  Render.partToScreen = (camera, vessel, time, point) => {
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
  Render.screenToPart = (camera, vessel, time, screenX, screenY) => {
    const frame = vesselFrame(camera, vessel, time);
    const deltaX = (screenX - frame.screenCentre.x) / camera.scale;
    const deltaY = (screenY - frame.screenCentre.y) / camera.scale;
    const cosAngle = Math.cos(-frame.screenAngle);
    const sinAngle = Math.sin(-frame.screenAngle);
    return { x: deltaX * cosAngle - deltaY * sinAngle, y: -(deltaX * sinAngle + deltaY * cosAngle) };
  };

  Render.drawVessel = (camera, vessel, time, options = {}) => {
    const centre = Vector.add(Flatspace.bodyAbsolutePosition(vessel.body, time), vessel.position);
    const screenPoint = worldToScreenPoint(camera, centre.x, centre.y);
    const craftLength = vessel.layout.height * camera.scale;
    setScreen();
    if (craftLength < 6) {
      // too small to draw: draw a marker
      context.save();
      context.translate(screenPoint.x, screenPoint.y);
      const screenAngle = -(vessel.angle - camera.rotation);
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
    const sigma = -(vessel.angle - camera.rotation);
    context.rotate(sigma + Math.PI / 2);
    context.scale(camera.scale, camera.scale);
    const pixelSize = 1 / camera.scale;
    // parachute canopy
    // Drawing frame: x = the craft's x, y = minus the craft's y (down the rocket).
    const chutes = vessel.parts.filter((part) => part.chute === 'halfOpen' || part.chute === 'full');
    if (chutes.length) {
      const full = chutes.some((part) => part.chute === 'full');
      const chutePart = chutes[0];
      const chuteTip = Vector.add(chutePart.centreOffset, Vector.scale(chutePart.axis, chutePart.length / 2));
      context.save();
      context.translate(chuteTip.x, -chuteTip.y);
      const top = 0;
      const canopyDistance = full ? 11 : 6;
      const canopyWidth = full ? 7.5 : 1.6;
      context.strokeStyle = 'rgba(230,230,230,0.8)';
      context.lineWidth = pixelSize;
      context.beginPath();
      context.moveTo(0, top);
      context.lineTo(-canopyWidth, top - canopyDistance);
      context.moveTo(0, top);
      context.lineTo(canopyWidth, top - canopyDistance);
      context.moveTo(0, top);
      context.lineTo(0, top - canopyDistance - canopyWidth * 0.3);
      context.stroke();
      context.beginPath();
      context.moveTo(-canopyWidth, top - canopyDistance);
      context.quadraticCurveTo(
        -canopyWidth,
        top - canopyDistance - canopyWidth * 0.9,
        0,
        top - canopyDistance - canopyWidth * 0.9,
      );
      context.quadraticCurveTo(
        canopyWidth,
        top - canopyDistance - canopyWidth * 0.9,
        canopyWidth,
        top - canopyDistance,
      );
      context.quadraticCurveTo(
        0,
        top - canopyDistance - canopyWidth * 0.25,
        -canopyWidth,
        top - canopyDistance,
      );
      context.fillStyle = '#e8622a';
      context.fill();
      context.fillStyle = '#f4efe6';
      context.beginPath();
      context.moveTo(-canopyWidth * 0.35, top - canopyDistance - canopyWidth * 0.12);
      context.quadraticCurveTo(
        -canopyWidth * 0.3,
        top - canopyDistance - canopyWidth * 0.85,
        0,
        top - canopyDistance - canopyWidth * 0.88,
      );
      context.quadraticCurveTo(
        canopyWidth * 0.3,
        top - canopyDistance - canopyWidth * 0.85,
        canopyWidth * 0.35,
        top - canopyDistance - canopyWidth * 0.12,
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
      context.translate(part.centreOffset.x, -part.centreOffset.y);
      context.rotate(-part.rotation);
      if (part.flip) {
        context.scale(-1, 1);
      }
      Flatspace.drawPart(context, part, -part.length / 2, pixelSize, { glow: glowMap.get(part) || 0 });
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
    const vAir = Vector.subtract(vessel.velocity, Flatspace.airVelocity(body, vessel.position));
    const direction = Vector.normalise(vAir);
    const centre = Vector.add(Flatspace.bodyAbsolutePosition(body, time), vessel.position);
    const lead = Vector.add(centre, Vector.scale(direction, vessel.layout.height * 0.45));
    const screenPoint = worldToScreenPoint(camera, lead.x, lead.y);
    const trailPoint = worldToScreenPoint(camera, lead.x - direction.x * 40, lead.y - direction.y * 40);
    setScreen();
    context.save();
    context.globalCompositeOperation = 'lighter';
    const size = Math.max(14, vessel.layout.height * camera.scale * 0.9);
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
        Render.emitExplosion(
          vessel.body,
          vessel.position,
          vessel.velocity,
          Math.max(2, vessel.layout.height * 0.4),
        );
      }
    });
    game.on('sphere-change', ({ vessel }) => {
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
    Render.updateParticles(frame.simulationStep, vessel.body, game.time);
    if (!vessel.dead && frame.rate <= 4) {
      Render.emitExhaust(vessel, frame.simulationStep, game.time);
    }
    for (const debrisVessel of game.debris) {
      if (!debrisVessel.dead && debrisVessel.body === vessel.body) {
        Render.emitExhaust(debrisVessel, frame.simulationStep, game.time);
      }
    }
  };

  Render.emitExhaust = (vessel, timeStep, time) => {
    if (!vessel.nozzles || !vessel.nozzles.length) {
      return;
    }
    const body = vessel.body;
    const pressure = Flatspace.pressure(body, vessel.altitude);
    for (const nozzle of vessel.nozzles) {
      const enginePart = nozzle.part;
      if (!vessel.parts.includes(enginePart)) {
        continue;
      }
      const partType = enginePart.type;
      // each engine pushes along its own axis; exhaust leaves from the bottom of its nozzle
      const nozzleDirection = vessel.toWorld(enginePart.axis);
      const side = Vector.perpendicular(nozzleDirection);
      const position = Vector.add(
        vessel.position,
        vessel.toWorld(
          Vector.subtract(enginePart.centreOffset, Vector.scale(enginePart.axis, enginePart.length / 2)),
        ),
      );
      const power = nozzle.power;
      const count = Math.ceil(timeStep * 120 * power * (enginePart.width > 2 ? 2 : 1));
      const spread = (1 - pressure) * 0.9 + 0.12;
      for (let particleIndex = 0; particleIndex < count; particleIndex++) {
        const speed = 40 + Math.random() * 40;
        const sideways = (Math.random() - 0.5) * 2 * spread * speed * 0.6;
        const velocity = Vector.add(
          vessel.velocity,
          Vector.add(Vector.scale(nozzleDirection, -speed), Vector.scale(side, sideways)),
        );
        const jitter = Math.random() * timeStep;
        Render.particles.push({
          x: position.x + velocity.x * jitter - vessel.velocity.x * jitter,
          y: position.y + velocity.y * jitter - vessel.velocity.y * jitter,
          velocityX: velocity.x,
          velocityY: velocity.y,
          life: 0,
          max: 0.25 + Math.random() * 0.35,
          size: enginePart.width * (0.7 + Math.random() * 0.5),
          grow: 2.5 + (1 - pressure) * 4,
          kind: nozzle.solid ? 'flame' : pressure < 0.05 ? 'blue' : 'flame',
        });
        if (pressure > 0.02 && Math.random() < 0.55) {
          Render.particles.push({
            x: position.x,
            y: position.y,
            velocityX: vessel.velocity.x + (velocity.x - vessel.velocity.x) * 0.9 + (Math.random() - 0.5) * 6,
            velocityY: vessel.velocity.y + (velocity.y - vessel.velocity.y) * 0.9 + (Math.random() - 0.5) * 6,
            life: 0,
            max: 1.0 + Math.random() * 1.8 * pressure,
            size: enginePart.width * 1.1,
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
        velocityX: velocity.x + Math.cos(angle) * speed,
        velocityY: velocity.y + Math.sin(angle) * speed,
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
        velocityX: velocity.x + Math.cos(angle) * speed,
        velocityY: velocity.y + Math.sin(angle) * speed,
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
      const altitude = distance - body.radius;
      const airDensity = Flatspace.density(body, altitude);
      const gravityFactor = -body.gravityParameter / (distanceSquared * distance);
      particle.velocityX += particle.x * gravityFactor * timeStep;
      particle.velocityY += particle.y * gravityFactor * timeStep;
      if (airDensity > 0) {
        const dragFactor = Math.min(1, airDensity * (particle.kind === 'smoke' ? 2.2 : 1.6) * timeStep);
        const airVelocityX = -body.angularVelocity * particle.y;
        const airVelocityY = body.angularVelocity * particle.x;
        particle.velocityX += (airVelocityX - particle.velocityX) * dragFactor;
        particle.velocityY += (airVelocityY - particle.velocityY) * dragFactor;
      }
      particle.x += particle.velocityX * timeStep;
      particle.y += particle.velocityY * timeStep;
      if (
        altitude < body.terrain.amplitude * 2.5 &&
        distance <
          body.radius +
            Flatspace.surfaceHeight(
              body,
              Flatspace.longitudeAt(body, Math.atan2(particle.y, particle.x), time),
            )
      ) {
        // hit the ground: spread out sideways
        const localUp = { x: particle.x / distance, y: particle.y / distance };
        const groundVelocityX = -body.angularVelocity * particle.y;
        const groundVelocityY = body.angularVelocity * particle.x; // ground velocity
        let relativeX = particle.velocityX - groundVelocityX;
        let relativeY = particle.velocityY - groundVelocityY;
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
          particle.velocityX = groundVelocityX + relativeX;
          particle.velocityY = groundVelocityY + relativeY;
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
    const base = Flatspace.bodyAbsolutePosition(body, time);
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
        const size = Math.max(1.5, (particle.size + particle.grow * particle.life) * camera.scale);
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
    const time = game.time;
    const camera = game.camera;
    const currentBody = vessel.body;
    setScreen();
    // Sky
    const altitude = vessel.altitude;
    let spaceFraction = 1;
    let light = 1;
    const localUp = Vector.normalise(vessel.position);
    light = sunlight(localUp);
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
    const top = mix([6, 9, 20], [58, 118, 196], daylight);
    const horizonColour = mix(
      mix([8, 12, 26], [140, 190, 236], daylight),
      [236, 132, 72],
      sunsetAmount * 0.8,
    );
    const gradient = context.createLinearGradient(0, 0, 0, viewHeight);
    gradient.addColorStop(0, colourToRGB(top));
    gradient.addColorStop(1, colourToRGB(horizonColour));
    context.fillStyle = gradient;
    context.fillRect(0, 0, viewWidth, viewHeight);
    drawStars(camera, 1 - daylight * 1.15, true);

    // Bodies: farthest first
    const order = Flatspace.bodies
      .slice()
      .sort(
        (first, second) =>
          Vector.length(Vector.subtract(Flatspace.bodyAbsolutePosition(second, time), camera)) -
          Vector.length(Vector.subtract(Flatspace.bodyAbsolutePosition(first, time), camera)),
      );
    for (const body of order) {
      drawBody(camera, body, time, { minPixels: 2 });
    }

    // When the ground is out of view, a soft glow at the bottom shows where it is
    {
      const viewRadius = Math.hypot(viewWidth, viewHeight) / 2 / camera.scale;
      if (vessel.altitude - currentBody.terrain.amplitude * 2.5 > viewRadius) {
        setScreen();
        const colour = currentBody.atmosphere ? currentBody.atmosphere.color : [150, 150, 150];
        const strength = Flatspace.clamp(1.2 - Math.log10(vessel.altitude / viewRadius) * 0.25, 0.25, 1);
        const glowGradient = context.createLinearGradient(0, viewHeight, 0, viewHeight * 0.55);
        glowGradient.addColorStop(0, `rgba(${colour[0]},${colour[1]},${colour[2]},${0.28 * strength})`);
        glowGradient.addColorStop(1, `rgba(${colour[0]},${colour[1]},${colour[2]},0)`);
        context.fillStyle = glowGradient;
        context.fillRect(0, viewHeight * 0.55, viewWidth, viewHeight * 0.45);
      }
    }

    // Night darkening of the near surface
    if (currentBody.atmosphere && light < 1 && altitude < currentBody.atmosphere.height * 2) {
      setScreen();
      context.fillStyle = `rgba(3,5,14,${(1 - light) * 0.55 * (1 - spaceFraction * 0.6)})`;
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
  function colourToRGB(colour) {
    return `rgb(${colour[0] | 0},${colour[1] | 0},${colour[2] | 0})`;
  }

  // ---- Map view ----
  const PATCH_COLORS = ['#55d6ff', '#ffb547', '#ff6fb1'];

  Render.drawMap = (game) => {
    const time = game.time;
    const camera = game.mapCamera;
    setScreen();
    context.fillStyle = '#05070f';
    context.fillRect(0, 0, viewWidth, viewHeight);
    drawStars(camera, 0.8, false);

    // Orbits and SOIs of bodies
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
    for (const body of Flatspace.bodies) {
      drawBody(camera, body, time, { minPixels: 3.5 });
    }
    // Labels
    setScreen();
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

    const vessel = game.vessel;
    if (!vessel.dead && !vessel.landed) {
      drawPatches(camera, game.patches, time, false);
      if (game.node && game.nodePatches) {
        drawPatches(camera, game.nodePatches, time, true, game.node.originTime);
      }
    }
    // Node marker
    if (game.node) {
      const node = game.node;
      // A node on a later patch is drawn around where its body will be when that patch starts.
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
    // Vessel
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

  function drawPatches(camera, patches, time, planned, firstReferenceTime) {
    if (!patches) {
      return;
    }
    patches.forEach((patch, index) => {
      const orbit = patch.orbit;
      // Frame: the current SOI body is drawn where it is now; later patches
      // are drawn around where their body will be when the patch starts.
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
      // Ap / Pe markers
      const body = patch.body;
      const mark = (trueAnomaly, label, value) => {
        const timeUntil = Flatspace.timeToTrueAnomaly(orbit, trueAnomaly, startTime);
        if (!isFinite(timeUntil) || startTime + timeUntil > patch.endTime) {
          return;
        }
        const state = Flatspace.orbitState(orbit, startTime + timeUntil);
        const screenPoint = worldToScreenPoint(
          camera,
          origin.x + state.position.x,
          origin.y + state.position.y,
        );
        marker(screenPoint, label, Flatspace.formatDistance(value));
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
          screenPoint,
          label,
          Flatspace.formatTime(patch.endTime - time),
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
  Flatspace.Renderer = Render;
})();
