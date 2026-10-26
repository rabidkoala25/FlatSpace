// parts.js — part lookup, engine maths and how parts are drawn.
// The part stats live in data/parts.js; the part tree, staging and Δv are in partgraph.js.
(function () {
  const STANDARD_GRAVITY = Flatspace.STANDARD_GRAVITY;

  const PARTS = Flatspace.DATA.parts; // stats live in data/parts.js
  const BY_ID = {};
  PARTS.forEach((partType) => (BY_ID[partType.id] = partType));
  Flatspace.PARTS = PARTS;
  Flatspace.PART = BY_ID;
  Flatspace.PART_CATEGORIES = ['Command', 'Fuel', 'Engines', 'Structural', 'Utility'];

  Flatspace.partMass = (part) => (part.dry ?? part.type.mass) + part.fuel + part.solid;

  // Engine thrust and mass flow at a given pressure (atm).
  Flatspace.engineThrust = (engine, pressure, throttle = 1) => {
    const massFlowRate = (engine.vacuumThrust / (engine.vacuumSpecificImpulse * STANDARD_GRAVITY)) * throttle;
    const specificImpulse = Math.max(
      0,
      engine.vacuumSpecificImpulse -
        (engine.vacuumSpecificImpulse - engine.seaLevelSpecificImpulse) * pressure,
    );
    return { force: massFlowRate * specificImpulse * STANDARD_GRAVITY, massFlowRate, specificImpulse };
  };

  // ---- Drawing ----
  function cylinderGradient(context, leftX, rightX, base, light, dark) {
    const gradient = context.createLinearGradient(leftX, 0, rightX, 0);
    gradient.addColorStop(0, dark);
    gradient.addColorStop(0.35, light);
    gradient.addColorStop(0.55, base);
    gradient.addColorStop(1, dark);
    return gradient;
  }

  // Draw a part with its top at y, its axis along +y pointing down the rocket, centred on x = 0.
  // Widths come from Flatspace.relayout (part.width, part.topWidth). pixelSize = size of one screen pixel in metres.
  Flatspace.drawPart = (context, part, y, pixelSize, options = {}) => {
    const partType = part.type;
    const width = part.width || (partType.width === 'auto' ? 1.25 : partType.width);
    const topWidth = part.topWidth || partType.topWidth || width;
    const height = part.length || partType.length;
    const halfWidth = width / 2;
    const topHalfWidth = topWidth / 2;
    context.lineWidth = pixelSize * 1.2;
    context.strokeStyle = 'rgba(10,14,22,0.75)';
    context.lineJoin = 'round';

    const trap = (topHalf, botHalf, topY, bandHeight) => {
      context.beginPath();
      context.moveTo(-topHalf, topY);
      context.lineTo(topHalf, topY);
      context.lineTo(botHalf, topY + bandHeight);
      context.lineTo(-botHalf, topY + bandHeight);
      context.closePath();
    };

    if (partType.id === 'lark') {
      trap(topHalfWidth, halfWidth, y, height);
      context.fillStyle = cylinderGradient(context, -halfWidth, halfWidth, '#6d737c', '#a7adb6', '#3a3f46');
      context.fill();
      context.stroke();
      // heat shield lip
      context.fillStyle = '#5a3d2a';
      context.fillRect(-halfWidth, y + height - 0.12, width, 0.12);
      // window
      context.beginPath();
      context.arc(-0.08, y + height * 0.45, 0.15, 0, Flatspace.TAU);
      context.fillStyle = '#9fd8ff';
      context.fill();
      context.stroke();
      context.fillStyle = '#e9edf2';
      context.fillRect(-topHalfWidth * 0.6, y - 0.08, topHalfWidth * 1.2, 0.1);
    } else if (partType.id === 'sparrow') {
      trap(halfWidth * 0.8, halfWidth, y, height);
      context.fillStyle = cylinderGradient(context, -halfWidth, halfWidth, '#c9a24a', '#f0d690', '#7a5d22');
      context.fill();
      context.stroke();
      context.beginPath();
      context.moveTo(halfWidth * 0.4, y);
      context.lineTo(halfWidth * 0.4, y - 0.5);
      context.strokeStyle = '#ccc';
      context.lineWidth = pixelSize * 1.5;
      context.stroke();
      context.fillStyle = '#5ec6ff';
      context.fillRect(-0.12, y + height * 0.35, 0.24, 0.1);
    } else if (partType.id === 'canopy') {
      context.beginPath();
      context.moveTo(-halfWidth, y + height);
      context.quadraticCurveTo(-halfWidth, y, 0, y);
      context.quadraticCurveTo(halfWidth, y, halfWidth, y + height);
      context.closePath();
      context.fillStyle = cylinderGradient(context, -halfWidth, halfWidth, '#d8642b', '#f0955c', '#8d3a15');
      context.fill();
      context.stroke();
      context.fillStyle = '#f2efe8';
      context.fillRect(-halfWidth * 0.25, y + height * 0.15, halfWidth * 0.5, height * 0.85);
    } else if (partType.fuel) {
      // tank looks (step A4): white, gold foil, orange foam, roll pattern, bare steel
      const skin = part.skin || (partType.foam ? 'foam' : 'white');
      const band = Math.min(0.14, height * 0.12);
      context.beginPath();
      context.rect(-halfWidth, y, width, height);
      if (skin === 'foam') {
        context.fillStyle = cylinderGradient(context, -halfWidth, halfWidth, '#c46a2c', '#e8995b', '#7a3c14');
      } else if (skin === 'gold') {
        context.fillStyle = cylinderGradient(context, -halfWidth, halfWidth, '#c99a2e', '#f6dc7a', '#7a5718');
      } else if (skin === 'steel') {
        context.fillStyle = cylinderGradient(context, -halfWidth, halfWidth, '#8f969e', '#c9ced4', '#545a61');
      } else {
        context.fillStyle = cylinderGradient(context, -halfWidth, halfWidth, '#d9d6cc', '#fbfaf5', '#8e8b82');
      }
      context.fill();
      context.save();
      context.beginPath();
      context.rect(-halfWidth, y, width, height);
      context.clip();
      if (skin === 'roll') {
        // black and white quarters, repeating along the tank, so a roll shows on camera
        const cell = Math.max(0.6, Math.min(width, 1.25));
        for (let rowIndex = 0, rowY = y + band; rowY < y + height - band; rowIndex++, rowY += cell) {
          context.fillStyle = 'rgba(20,22,26,0.88)';
          context.fillRect(
            rowIndex % 2 ? 0 : -halfWidth,
            rowY,
            halfWidth,
            Math.min(cell, y + height - band - rowY),
          );
        }
      } else if (skin === 'gold') {
        // crinkled foil: soft diagonal creases
        context.strokeStyle = 'rgba(110,70,10,0.35)';
        context.lineWidth = pixelSize;
        for (let offset = -width; offset < height + width; offset += 0.35) {
          context.beginPath();
          context.moveTo(-halfWidth, y + offset);
          context.lineTo(halfWidth, y + offset - width * 0.6);
          context.stroke();
        }
        context.fillStyle = 'rgba(255,250,210,0.25)';
        for (let offset = 0.2; offset < height; offset += 0.9) {
          context.fillRect(-halfWidth * 0.6, y + offset, halfWidth * 0.4, 0.12);
        }
      } else if (skin === 'steel') {
        // weld seams and rivet lines
        context.fillStyle = 'rgba(40,44,50,0.5)';
        for (let offset = 1; offset < height; offset += 1) {
          context.fillRect(-halfWidth, y + offset, width, Math.max(pixelSize, 0.03));
        }
        for (let offset = 0.5; offset < height; offset += 1) {
          for (let rivetX = -halfWidth + 0.12; rivetX < halfWidth; rivetX += 0.25) {
            context.fillRect(rivetX, y + offset, 0.04, 0.04);
          }
        }
      }
      context.restore();
      context.beginPath();
      context.rect(-halfWidth, y, width, height);
      context.stroke();
      context.fillStyle =
        skin === 'foam'
          ? 'rgba(80,40,15,0.6)'
          : skin === 'gold'
            ? '#8a6418'
            : skin === 'steel'
              ? '#4b5057'
              : skin === 'roll'
                ? '#1c1e22'
                : '#c8692b';
      context.fillRect(-halfWidth, y, width, band);
      context.fillRect(-halfWidth, y + height - band, width, band);
      if (skin === 'white' && height > 1) {
        context.fillStyle = 'rgba(40,50,70,0.55)';
        context.fillRect(-halfWidth * 0.15, y + height * 0.3, halfWidth * 0.3, height * 0.4);
      }
      // fuel gauge overlay
      if (options.showFuel && partType.fuel) {
        const fuelFraction = part.fuel / (part.fuelCapacity || partType.fuel);
        context.fillStyle = 'rgba(255,190,80,0.18)';
        context.fillRect(-halfWidth, y + height * (1 - fuelFraction), width, height * fuelFraction);
      }
    } else if (partType.engine && partType.engine.solid) {
      context.beginPath();
      context.rect(-halfWidth, y, width, height * 0.88);
      context.fillStyle = cylinderGradient(context, -halfWidth, halfWidth, '#e6e3db', '#ffffff', '#8f8c85');
      context.fill();
      context.stroke();
      context.fillStyle = '#b8342a';
      for (let bandIndex = 0; bandIndex < 3; bandIndex++) {
        context.fillRect(-halfWidth, y + height * (0.12 + bandIndex * 0.28), width, 0.12);
      }
      trap(halfWidth * 0.35, halfWidth * 0.55, y + height * 0.88, height * 0.12);
      context.fillStyle = '#3b3e44';
      context.fill();
      context.stroke();
    } else if (partType.engine) {
      const mountHeight = height * (partType.vacuum ? 0.25 : 0.32);
      trap(topHalfWidth, halfWidth * 0.75, y, mountHeight);
      context.fillStyle = cylinderGradient(context, -halfWidth, halfWidth, '#50555d', '#848a93', '#2c2f34');
      context.fill();
      context.stroke();
      const nozzleTopHalfWidth = partType.vacuum ? halfWidth * 0.22 : halfWidth * 0.32;
      const nozzleBottomHalfWidth = partType.vacuum ? halfWidth * 0.8 : halfWidth * 0.85;
      context.beginPath();
      context.moveTo(-nozzleTopHalfWidth, y + mountHeight);
      context.lineTo(nozzleTopHalfWidth, y + mountHeight);
      context.quadraticCurveTo(
        nozzleTopHalfWidth * 1.05,
        y + height * 0.7,
        nozzleBottomHalfWidth,
        y + height,
      );
      context.lineTo(-nozzleBottomHalfWidth, y + height);
      context.quadraticCurveTo(
        -nozzleTopHalfWidth * 1.05,
        y + height * 0.7,
        -nozzleTopHalfWidth,
        y + mountHeight,
      );
      context.closePath();
      context.fillStyle = cylinderGradient(
        context,
        -nozzleBottomHalfWidth,
        nozzleBottomHalfWidth,
        '#3d4046',
        '#9aa0a8',
        '#202226',
      );
      context.fill();
      context.stroke();
      if (options.glow > 0) {
        context.fillStyle = `rgba(255,150,60,${0.5 * options.glow})`;
        context.fillRect(-nozzleBottomHalfWidth * 0.8, y + height - 0.12, nozzleBottomHalfWidth * 1.6, 0.1);
      }
    } else if (partType.decoupler) {
      context.save();
      context.beginPath();
      context.rect(-halfWidth, y, width, height);
      context.clip();
      context.fillStyle = '#e8c33a';
      context.fillRect(-halfWidth, y, width, height);
      context.fillStyle = '#23252a';
      for (let stripeX = -halfWidth - height; stripeX < halfWidth; stripeX += 0.3) {
        context.beginPath();
        context.moveTo(stripeX, y + height);
        context.lineTo(stripeX + 0.15, y + height);
        context.lineTo(stripeX + 0.15 + height, y);
        context.lineTo(stripeX + height, y);
        context.fill();
      }
      context.restore();
      context.beginPath();
      context.rect(-halfWidth, y, width, height);
      context.stroke();
    } else if (partType.id === 'adapter') {
      trap(topHalfWidth, halfWidth, y, height);
      context.fillStyle = cylinderGradient(context, -halfWidth, halfWidth, '#a9adb3', '#d9dce0', '#5f646b');
      context.fill();
      context.stroke();
    } else if (partType.fin && partType.radial) {
      // root edge on the left (x = -hw), swept tip on the right
      context.beginPath();
      context.moveTo(-halfWidth, y);
      context.lineTo(halfWidth, y + height * 0.55);
      context.lineTo(halfWidth, y + height);
      context.lineTo(-halfWidth, y + height);
      context.closePath();
      const gradient = context.createLinearGradient(-halfWidth, 0, halfWidth, 0);
      gradient.addColorStop(0, '#24496d');
      gradient.addColorStop(0.5, '#3a6f9f');
      gradient.addColorStop(1, '#2f5d8a');
      context.fillStyle = gradient;
      context.fill();
      context.stroke();
      context.fillStyle = 'rgba(220,230,240,0.35)';
      context.fillRect(-halfWidth, y + height * 0.1, width * 0.12, height * 0.85);
    } else if (partType.fin) {
      context.beginPath();
      context.rect(-halfWidth, y, width, height);
      context.fillStyle = cylinderGradient(context, -halfWidth, halfWidth, '#8d939b', '#c3c8ce', '#4b5057');
      context.fill();
      context.stroke();
      context.fillStyle = '#2f5d8a';
      for (const side of [-1, 1]) {
        context.beginPath();
        context.moveTo(side * halfWidth, y);
        context.lineTo(side * (halfWidth + 0.75), y + height * 0.75);
        context.lineTo(side * (halfWidth + 0.75), y + height + 0.15);
        context.lineTo(side * halfWidth, y + height);
        context.closePath();
        context.fill();
        context.stroke();
      }
    } else {
      context.fillStyle = '#888';
      context.fillRect(-halfWidth, y, width, height);
    }
    if (options.selected) {
      context.strokeStyle = '#ffb547';
      context.lineWidth = pixelSize * 2.5;
      context.setLineDash([pixelSize * 6, pixelSize * 4]);
      context.strokeRect(
        -Math.max(halfWidth, topHalfWidth) - pixelSize * 4,
        y - pixelSize * 3,
        Math.max(width, topWidth) + pixelSize * 8,
        height + pixelSize * 6,
      );
      context.setLineDash([]);
    }
  };

  // Sample craft
  Flatspace.SAMPLE_CRAFT = Flatspace.DATA.sampleCraft;
})();
