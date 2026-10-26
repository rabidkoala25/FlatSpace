// partgraph.js — the part tree.
// A craft is a list of parts. Every part except the root hangs from a parent at an attach
// node: 'bottom' (below the parent), 'top' (above it) or 'srf' (on its side).
// Positions use the craft frame: metres, +y towards the nose, +x to the right of it.
// rotation is counter-clockwise in radians (0 = upright); flip mirrors a part left-right.
//
// Saved craft store parts as { id, parent (index or -1), node, x, y, rotation, flip, symmetryGroup }.
// x, y and rotation are absolute (craft frame). In memory a side-attached part also keeps
// surfaceOffset (its offset in the parent's own frame) and relativeRotation (its angle relative to the
// parent), so turning a parent carries its side parts round with it. symmetryGroup links a part
// to its mirror twin (editor symmetry).
(function () {
  const Vector = Flatspace.Vector;
  const roundTo3 = (value) => Math.round(value * 1000) / 1000;
  // rotate v counter-clockwise by angle a
  const rotateVector = (vector, angle) => {
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);
    return { x: vector.x * cosAngle - vector.y * sinAngle, y: vector.x * sinAngle + vector.y * cosAngle };
  };
  Flatspace.rotateVector = rotateVector;

  // Recompute the stored offset and relative angle of side parts from their absolute pose.
  Flatspace.syncOffsets = (list) => {
    for (const part of list) {
      if (part.node !== 'surface' || !part.parent) {
        continue;
      }
      part.surfaceOffset = rotateVector(
        Vector.subtract(part.position, part.parent.position),
        -part.parent.rotation,
      );
      part.relativeRotation = part.rotation - part.parent.rotation;
    }
  };

  // ---------- Making parts ----------
  // Every part instance carries its own size and settings, so tanks can be stretched and
  // engines throttled down part by part (step A4):
  //   length, size  length and width (m); only stretchable tanks differ from their type
  //   dry, fuelCapacity, dragArea  dry mass (kg), fuel capacity (kg) and front drag area, scaled with volume
  //   fill          how full the tanks start (0..1)
  //   skin          a tank's look: white, gold, foam, roll, steel
  //   limit         an engine's thrust limit (0..1); gimbal its gimbal range (0..1)
  //   crossfeed     a decoupler lets fuel flow across it
  //   chuteAltitude      height above ground at which a parachute opens fully (m)
  //   stage         custom staging: the stage it fires in (-1 = not staged); absent = automatic
  //   loose         on the root of a floating group (not the craft's root): 'keep' launches it
  //                 with the craft where it was placed, 'drop' leaves it behind
  Flatspace.TANK_WIDTHS = [0.625, 1.25, 1.875, 2.5, 3.75, 5];
  Flatspace.TANK_SKINS = ['white', 'gold', 'foam', 'roll', 'steel'];
  Flatspace.LENGTH_STEP = 0.25;
  Flatspace.MAX_TANK_LENGTH = 24;
  let nextUniqueId = 1;
  Flatspace.newPart = (partId, options = {}) => {
    const partType = Flatspace.PART[partId];
    if (!partType) {
      return null;
    }
    const part = {
      uniqueId: nextUniqueId++,
      type: partType,
      parent: null,
      node: 'bottom',
      position: { x: 0, y: 0 },
      rotation: 0,
      flip: false,
      fuel: 0,
      solid: partType.solid || 0,
      lit: false,
      chute: partType.chute ? 'stowed' : null,
      length: partType.length,
      size: partType.width === 'auto' ? null : partType.width,
      fill: 1,
    };
    if (partType.fuel) {
      part.skin = partType.foam ? 'foam' : 'white';
    }
    if (partType.engine) {
      part.limit = 1;
      part.gimbal = 1;
    }
    if (partType.chute) {
      part.chuteAltitude = 1000;
    }
    for (const option of [
      'length',
      'size',
      'fill',
      'skin',
      'limit',
      'gimbal',
      'crossfeed',
      'chuteAltitude',
      'stage',
      'loose',
    ]) {
      if (options[option] !== undefined) {
        part[option] = options[option];
      }
    }
    Flatspace.applySize(part, true);
    return part;
  };

  // Work out a part's mass, fuel capacity and drag from its size. A stretched tank keeps its
  // type's density: fuel and dry mass scale with length × width², front drag with width².
  // refill: set the fuel to capacity × fill (the editor does this after any change).
  Flatspace.applySize = (part, refill = true) => {
    const partType = part.type;
    if (partType.stretch) {
      part.length = Flatspace.clamp(
        Math.round(part.length / Flatspace.LENGTH_STEP) * Flatspace.LENGTH_STEP,
        Flatspace.LENGTH_STEP,
        Flatspace.MAX_TANK_LENGTH,
      );
      if (!Flatspace.TANK_WIDTHS.includes(part.size)) {
        part.size = partType.width;
      }
    } else {
      part.length = partType.length;
      if (partType.width !== 'auto') {
        part.size = partType.width;
      }
    }
    const widthRatio = partType.stretch ? part.size / partType.width : 1;
    const sizeFactor = partType.stretch ? (part.length / partType.length) * widthRatio * widthRatio : 1;
    part.dry = partType.mass * sizeFactor;
    part.fuelCapacity = (partType.fuel || 0) * sizeFactor;
    part.dragArea = partType.dragArea * widthRatio * widthRatio;
    if (refill) {
      part.fuel = part.fuelCapacity * Flatspace.clamp(part.fill ?? 1, 0, 1);
    }
    return part;
  };

  // Thrust and mass flow of an engine part, with its thrust limit.
  Flatspace.partThrust = (part, pressure, throttle = 1) =>
    Flatspace.engineThrust(part.type.engine, pressure, throttle * (part.limit ?? 1));

  // A straight stack of part ids (top to bottom): each part hangs below the one above.
  Flatspace.stackToParts = (partIds) => {
    const parts = [];
    for (const partId of partIds) {
      const part = Flatspace.newPart(partId);
      if (!part) {
        continue;
      }
      if (parts.length) {
        part.parent = parts[parts.length - 1];
      }
      parts.push(part);
    }
    Flatspace.relayout(parts);
    return parts;
  };

  // Attach a new part to the side of a parent at a craft-frame position (tests and editor).
  Flatspace.attachPart = (parts, partId, parent, position, rotation = 0, flip = false) => {
    const part = Flatspace.newPart(partId);
    if (!part) {
      return null;
    }
    Object.assign(part, { parent, node: 'surface', position: { ...position }, rotation, flip });
    Flatspace.syncOffsets([part]);
    parts.push(part);
    Flatspace.relayout(parts);
    return part;
  };

  Flatspace.serialParts = (parts) => {
    const indexOf = new Map(parts.map((part, index) => [part, index]));
    return parts.map((part) => {
      const serial = {
        id: part.type.id,
        parent: part.parent && indexOf.has(part.parent) ? indexOf.get(part.parent) : -1,
        node: part.node,
        x: roundTo3(part.position.x),
        y: roundTo3(part.position.y),
      };
      if (part.rotation) {
        serial.rotation = roundTo3(part.rotation);
      }
      if (part.flip) {
        serial.flip = true;
      }
      if (part.symmetryGroup) {
        serial.symmetryGroup = part.symmetryGroup;
      }
      const partType = part.type;
      if (partType.stretch && part.length !== partType.length) {
        serial.length = part.length;
      }
      if (partType.stretch && part.size !== partType.width) {
        serial.size = part.size;
      }
      if (part.skin && part.skin !== (partType.foam ? 'foam' : 'white')) {
        serial.skin = part.skin;
      }
      if (part.fill !== undefined && part.fill < 1) {
        serial.fill = roundTo3(part.fill);
      }
      if (part.limit !== undefined && part.limit < 1) {
        serial.limit = roundTo3(part.limit);
      }
      if (part.gimbal !== undefined && part.gimbal < 1) {
        serial.gimbal = roundTo3(part.gimbal);
      }
      if (part.crossfeed) {
        serial.crossfeed = true;
      }
      if (part.chuteAltitude !== undefined && part.chuteAltitude !== 1000) {
        serial.chuteAltitude = part.chuteAltitude;
      }
      if (typeof part.stage === 'number') {
        serial.stage = part.stage;
      }
      if (part.loose && serial.parent < 0) {
        serial.loose = part.loose;
      }
      return serial;
    });
  };

  Flatspace.partsFromSerial = (list) => {
    const parts = list.map((serial) => {
      const part = Flatspace.newPart(serial.id, serial);
      if (part) {
        Object.assign(part, {
          position: { x: serial.x || 0, y: serial.y || 0 },
          rotation: serial.rotation || 0,
          flip: !!serial.flip,
          node: serial.node || 'bottom',
        });
      }
      if (part && serial.symmetryGroup) {
        part.symmetryGroup = serial.symmetryGroup;
      }
      return part;
    });
    list.forEach((serial, index) => {
      if (parts[index] && serial.parent >= 0 && parts[serial.parent]) {
        parts[index].parent = parts[serial.parent];
      }
    });
    const out = parts.filter(Boolean);
    Flatspace.syncOffsets(out);
    Flatspace.relayout(out);
    return out;
  };

  // Accept part ids (a stack), saved parts, or live part objects.
  Flatspace.toParts = (source) => {
    if (!source || !source.length) {
      return [];
    }
    if (typeof source[0] === 'string') {
      return Flatspace.stackToParts(source);
    }
    if (source[0].type) {
      const set = new Set(source);
      for (const part of source) {
        if (part.parent && !set.has(part.parent)) {
          part.parent = null;
        }
      }
      return source;
    }
    return Flatspace.partsFromSerial(source);
  };

  // ---------- Tree helpers ----------
  Flatspace.childrenOf = (parts) => {
    const children = new Map(parts.map((part) => [part, []]));
    for (const part of parts) {
      if (part.parent && children.has(part.parent)) {
        children.get(part.parent).push(part);
      }
    }
    return children;
  };
  Flatspace.rootOf = (parts) => {
    const set = new Set(parts);
    return parts.find((part) => !part.parent || !set.has(part.parent)) || null;
  };
  Flatspace.subtree = (parts, top) => {
    const kids = Flatspace.childrenOf(parts);
    const out = [];
    const walk = (part) => {
      out.push(part);
      for (const child of kids.get(part) || []) {
        walk(child);
      }
    };
    walk(top);
    return out;
  };
  Flatspace.partAxis = (rotation) => ({ x: -Math.sin(rotation), y: Math.cos(rotation) });

  // Recompute widths of auto-sized parts and the positions of stack-attached parts.
  // Side-attached parts keep their offset from their parent.
  Flatspace.relayout = (parts) => {
    const kids = Flatspace.childrenOf(parts);
    const set = new Set(parts);
    for (const part of parts) {
      if (part.type.width !== 'auto') {
        part.width = part.size || part.type.width;
      }
    }
    for (const part of parts) {
      if (part.type.width !== 'auto') {
        continue;
      }
      const widths = [];
      if (
        part.parent &&
        set.has(part.parent) &&
        part.node !== 'surface' &&
        part.parent.type.width !== 'auto'
      ) {
        widths.push(part.parent.width);
      }
      for (const child of kids.get(part)) {
        if (child.node !== 'surface' && child.type.width !== 'auto') {
          widths.push(child.type.topWidth || child.width);
        }
      }
      part.width = Math.max(0.625, ...widths);
    }
    for (const part of parts) {
      part.topWidth = part.type.topWidth || part.width;
    }

    const place = (part) => {
      for (const child of kids.get(part)) {
        if (child.node === 'surface') {
          if (!child.surfaceOffset) {
            Flatspace.syncOffsets([child]);
          }
          child.position = Vector.add(part.position, rotateVector(child.surfaceOffset, part.rotation));
          child.rotation = part.rotation + (child.relativeRotation || 0);
        } else {
          const offset = (child.node === 'top' ? 1 : -1) * (part.length / 2 + child.length / 2);
          child.rotation = part.rotation;
          child.position = Vector.add(part.position, Vector.scale(Flatspace.partAxis(part.rotation), offset));
        }
        place(child);
      }
    };
    for (const part of parts) {
      if (!part.parent || !set.has(part.parent)) {
        place(part);
      }
    }
    return parts;
  };

  // The outline of a part in its own frame (centre at 0,0, +y up), before rotation.
  Flatspace.partHull = (part) => {
    const partType = part.type;
    const halfLength = part.length / 2;
    const halfWidth = part.width / 2;
    const topHalfWidth = part.topWidth / 2;
    // a side fin: the root edge (left, x = -hw) is fixed to the parent, the tip is swept back
    if (partType.fin && partType.radial) {
      return [
        { x: -halfWidth, y: halfLength },
        { x: halfWidth, y: halfLength - part.length * 0.55 },
        { x: halfWidth, y: -halfLength },
        { x: -halfWidth, y: -halfLength },
      ];
    }
    const points = [
      { x: -topHalfWidth, y: halfLength },
      { x: topHalfWidth, y: halfLength },
      { x: halfWidth, y: -halfLength },
      { x: -halfWidth, y: -halfLength },
    ];
    if (partType.fin) {
      points.push(
        { x: halfWidth + 0.75, y: -halfLength - 0.15 },
        { x: -halfWidth - 0.75, y: -halfLength - 0.15 },
      );
    }
    return points;
  };

  // Mass, centre of mass, moment of inertia and bounds. Also sets, on every part,
  // centreOffset (centre relative to the centre of mass), axis (its +y direction) and centredHull (outline
  // points relative to the centre of mass), all in the craft frame.
  Flatspace.massLayout = (parts) => {
    let mass = 0;
    let massX = 0;
    let massY = 0;
    for (const part of parts) {
      const partMass = Flatspace.partMass(part);
      mass += partMass;
      massX += partMass * part.position.x;
      massY += partMass * part.position.y;
    }
    const centreOfMass = mass > 0 ? { x: massX / mass, y: massY / mass } : { x: 0, y: 0 };
    let inertia = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const part of parts) {
      const partMass = Flatspace.partMass(part);
      part.centreOffset = Vector.subtract(part.position, centreOfMass);
      part.axis = Flatspace.partAxis(part.rotation);
      inertia +=
        partMass *
        (Vector.dot(part.centreOffset, part.centreOffset) +
          (part.length * part.length + part.width * part.width) / 12);
      const cosRotation = Math.cos(part.rotation);
      const sinRotation = Math.sin(part.rotation);
      part.centredHull = Flatspace.partHull(part).map((hullPoint) => {
        const hullX = part.flip ? -hullPoint.x : hullPoint.x;
        return {
          x: part.centreOffset.x + hullX * cosRotation - hullPoint.y * sinRotation,
          y: part.centreOffset.y + hullX * sinRotation + hullPoint.y * cosRotation,
        };
      });
      for (const hullPoint of part.centredHull) {
        minX = Math.min(minX, hullPoint.x);
        maxX = Math.max(maxX, hullPoint.x);
        minY = Math.min(minY, hullPoint.y);
        maxY = Math.max(maxY, hullPoint.y);
      }
    }
    if (!parts.length) {
      minX = maxX = minY = maxY = 0;
    }
    return {
      mass,
      centreOfMass,
      momentOfInertia: Math.max(inertia, 1),
      minX,
      maxX,
      minY,
      maxY,
      height: maxY - minY,
      width: maxX - minX,
    };
  };

  // ---------- Aerodynamics (shared by flight and the editor) ----------

  // The air's force on one part per unit dynamic pressure (m², so multiply by the dynamic pressure), in the
  // craft frame. u is the craft's direction of motion through the air (unit, craft frame);
  // extra is drag area added along the flow (an open parachute). Two parts:
  // - drag straight back along the flow: front area × how head-on the air meets the part;
  // - a push sideways, across the part: bodies only feel it as the air meets them side-on
  //   (it grows with the square of the angle), but fins work like small wings and push back
  //   from the first degree (2·sin·cos, as a thin wing does), so fins at the tail keep a
  //   rocket pointed into the airflow. (Fuller lift, Mach and shielding come in C4.)
  Flatspace.partAerodynamics = (part, airDirection, extra = 0) => {
    const axis = part.axis || Flatspace.partAxis(part.rotation);
    const cosAttack = Vector.dot(axis, airDirection);
    const cosA = Math.abs(cosAttack);
    const across = Vector.subtract(airDirection, Vector.scale(axis, cosAttack)); // the part of the flow that crosses the part
    const sinA = Vector.length(across);
    let force = Vector.scale(airDirection, -(part.dragArea * cosA + extra));
    if (sinA > 1e-9) {
      const body = 0.3 * part.length * part.width;
      const finArea = part.type.fin || 0;
      const normalCoefficient = body * sinA * sinA + finArea * (2 * sinA * cosA + sinA * sinA);
      force = Vector.add(force, Vector.scale(across, -normalCoefficient / sinA));
    }
    return force;
  };

  // Where the air's forces act when the craft flies nose-first a few degrees off the
  // airflow (aoa radians), from Flatspace.partAerodynamics. Returned as a point on the line through the
  // centre of mass along +y, in the craft frame: { position, ahead, centreOfMass }, where ahead is how far
  // in front of the centre of mass it sits (m; negative = behind, which is stable).
  // null when there is nothing for the air to push on.
  Flatspace.centreOfPressure = (parts, angleOfAttack = 0.09) => {
    if (!parts.length) {
      return null;
    }
    const layout = Flatspace.massLayout(parts);
    const airDirection = { x: Math.sin(angleOfAttack), y: Math.cos(angleOfAttack) }; // the craft's motion through the air
    let sideForce = 0;
    let torque = 0;
    for (const part of parts) {
      const force = Flatspace.partAerodynamics(part, airDirection);
      sideForce += force.x;
      torque += Vector.cross(part.centreOffset, force);
    }
    if (Math.abs(sideForce) < 1e-9) {
      return null;
    }
    const ahead = -torque / sideForce; // cross((0, s), F) = -s·Fx = tau
    return {
      position: { x: layout.centreOfMass.x, y: layout.centreOfMass.y + ahead },
      ahead,
      centreOfMass: layout.centreOfMass,
    };
  };

  // Where the engines of a stage push: the thrust-weighted centre of the engines and the
  // direction of their combined thrust, in the craft frame. null without engines.
  Flatspace.centreOfThrust = (engines) => {
    let totalThrust = 0;
    let thrustX = 0;
    let thrustY = 0;
    let direction = { x: 0, y: 0 };
    for (const engine of engines) {
      const thrust = engine.type.engine.vacuumThrust;
      const axis = Flatspace.partAxis(engine.rotation);
      totalThrust += thrust;
      thrustX += thrust * engine.position.x;
      thrustY += thrust * engine.position.y;
      direction = Vector.add(direction, Vector.scale(axis, thrust));
    }
    if (!totalThrust) {
      return null;
    }
    return {
      position: { x: thrustX / totalThrust, y: thrustY / totalThrust },
      direction: Vector.normalise(direction),
      thrust: totalThrust,
    };
  };

  // ---------- Fuel flow ----------
  // Groups of parts that share fuel: the tree cut wherever a decoupler meets its parent,
  // unless the decoupler has crossfeed on. (A decoupler belongs to the side that falls away with it.)
  Flatspace.flowGroups = (parts) => {
    const indexOf = new Map(parts.map((part, index) => [part, index]));
    const parentOf = parts.map((part, index) => index);
    const find = (index) => (parentOf[index] === index ? index : (parentOf[index] = find(parentOf[index])));
    for (const part of parts) {
      if (part.parent && indexOf.has(part.parent) && (!part.type.decoupler || part.crossfeed)) {
        parentOf[find(indexOf.get(part))] = find(indexOf.get(part.parent));
      }
    }
    const groups = new Map();
    parts.forEach((part, index) => {
      const root = find(index);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root).push(part);
    });
    return [...groups.values()];
  };

  // ---------- Staging ----------
  // Default stage list, KSP-style. Groups are numbered by how many decouplers separate
  // them from the root. The deepest groups light first; side boosters (on radial
  // decouplers) light together with the group they hang from, and drop first.
  // Each event: { decouple, ignite, chutes, decouplers, engines, chuteParts, parts }.
  // Parts that do something when staged.
  Flatspace.stageable = (part) => !!(part.type.engine || part.type.decoupler || part.type.chute);
  // Whether the player has edited the staging (any part carries a stage number).
  Flatspace.customStaging = (parts) => parts.some((part) => typeof part.stage === 'number');

  // Stage events from custom staging: stage number n fires every part with stage === n.
  // keepEmpty keeps stages with no parts (the editor shows them; flight skips them).
  Flatspace.customStages = (parts, keepEmpty = false) => {
    const stageCount =
      Math.max(-1, ...parts.map((part) => (typeof part.stage === 'number' ? part.stage : -1))) + 1;
    const events = [];
    for (let stage = 0; stage < stageCount; stage++) {
      const inStage = parts.filter((part) => part.stage === stage && Flatspace.stageable(part));
      const decouplers = inStage.filter((part) => part.type.decoupler);
      const engines = inStage.filter((part) => part.type.engine);
      const chuteParts = inStage.filter((part) => part.type.chute);
      if (!inStage.length && !keepEmpty) {
        continue;
      }
      events.push({
        decouple: decouplers.length > 0,
        ignite: engines.length > 0,
        chutes: chuteParts.length > 0,
        decouplers,
        engines,
        chuteParts,
        parts: inStage,
        index: stage,
      });
    }
    return events;
  };

  // Turn the automatic stage list into custom staging (the editor does this when the player
  // first edits a stage), so the craft keeps exactly the stages it had.
  Flatspace.freezeStaging = (parts) => {
    const auto = Flatspace.stagesOf(parts);
    for (const part of parts) {
      if (Flatspace.stageable(part)) {
        part.stage = -1;
      }
    }
    auto.forEach((stage, stageIndex) => stage.parts.forEach((part) => (part.stage = stageIndex)));
    return parts;
  };
  Flatspace.resetStaging = (parts) => {
    for (const part of parts) {
      delete part.stage;
    }
    return parts;
  };

  Flatspace.stagesOf = (parts) => {
    if (Flatspace.customStaging(parts)) {
      return Flatspace.customStages(parts);
    }
    const groups = Flatspace.flowGroups(parts);
    const groupOf = new Map();
    groups.forEach((group, groupIndex) => group.forEach((part) => groupOf.set(part, groupIndex)));
    const info = groups.map((group, groupIndex) => {
      const decoupler =
        group.find(
          (part) =>
            part.type.decoupler &&
            part.parent &&
            groupOf.has(part.parent) &&
            groupOf.get(part.parent) !== groupIndex,
        ) || null;
      return {
        parts: group,
        decoupler,
        parent: decoupler ? groupOf.get(decoupler.parent) : -1,
        engines: group.filter((part) => part.type.engine),
      };
    });
    const depth = (groupIndex) => (info[groupIndex].parent < 0 ? 0 : 1 + depth(info[groupIndex].parent));
    info.forEach((group, groupIndex) => (group.depth = depth(groupIndex)));
    const ignition = (groupIndex) => {
      let depth = info[groupIndex].depth;
      info.forEach((other, otherIndex) => {
        if (other.parent === groupIndex && other.decoupler.type.radial && other.engines.length) {
          depth = Math.max(depth, ignition(otherIndex));
        }
      });
      return depth;
    };
    info.forEach((group, groupIndex) => (group.ignition = group.engines.length ? ignition(groupIndex) : -1));
    const deepest = Math.max(0, ...info.map((group) => group.depth));
    const events = [];
    for (let depth = deepest; depth >= 0; depth--) {
      const decouplers = info
        .filter((group) => group.depth === depth + 1 && group.decoupler)
        .map((group) => group.decoupler);
      const engines = info.filter((group) => group.ignition === depth).flatMap((group) => group.engines);
      if (decouplers.length || engines.length) {
        events.push({
          decouple: decouplers.length > 0,
          ignite: engines.length > 0,
          chutes: false,
          decouplers,
          engines,
          chuteParts: [],
          parts: [...decouplers, ...engines],
        });
      }
    }
    const chuteParts = parts.filter((part) => part.type.chute);
    if (chuteParts.length) {
      events.push({
        decouple: false,
        ignite: false,
        chutes: true,
        decouplers: [],
        engines: [],
        chuteParts,
        parts: chuteParts,
      });
    }
    return events;
  };

  // ---------- Δv per stage ----------
  // Simulates the stage list from stages[startIdx] on, without changing the parts.
  // Each stage burns its lit engines until the parts the next stage drops run dry
  // (or until everything lit is dry, if the next stage drops nothing with fuel).
  // Returns { current, events, total }: current is what is burning now, before the next
  // stage; events[n] is stage startIndex + n. Each has { deltaV, time, thrust, mass, thrustToWeight }.
  Flatspace.stageStats = (parts, stages, startIndex, pressure, gravity) => {
    const fuelLeft = new Map(parts.map((part) => [part, { fuel: part.fuel, solid: part.solid }]));
    let attached = parts.slice();
    const litEngines = new Set(parts.filter((part) => part.lit && part.type.engine));
    const massNow = () =>
      attached.reduce((sum, part) => sum + part.dry + fuelLeft.get(part).fuel + fuelLeft.get(part).solid, 0);
    const dropOf = (stage) => {
      if (!stage || !stage.decouple) {
        return null;
      }
      const set = new Set();
      for (const decoupler of stage.decouplers) {
        if (attached.includes(decoupler)) {
          Flatspace.subtree(attached, decoupler).forEach((part) => set.add(part));
        }
      }
      return set.size ? set : null;
    };

    function burn(dropSet) {
      const startMass = massNow();
      let mass = startMass;
      let deltaV = 0;
      let time = 0;
      let startThrust = null;
      const groups = Flatspace.flowGroups(attached);
      if (
        dropSet &&
        ![...dropSet].some((part) => fuelLeft.get(part).fuel + fuelLeft.get(part).solid > 1e-6)
      ) {
        dropSet = null;
      }
      for (let guard = 0; guard < 40; guard++) {
        const active = [];
        for (const fuelGroup of groups) {
          const liquidEngines = fuelGroup.filter((part) => litEngines.has(part) && !part.type.engine.solid);
          const tanks = fuelGroup.filter((part) => part.type.fuel);
          const fuel = tanks.reduce((sum, tank) => sum + fuelLeft.get(tank).fuel, 0);
          if (liquidEngines.length && fuel > 1e-6) {
            let flow = 0;
            let thrust = 0;
            for (const engine of liquidEngines) {
              const engineThrust = Flatspace.partThrust(engine, pressure);
              flow += engineThrust.massFlowRate;
              thrust += engineThrust.force;
            }
            active.push({ massFlow: flow, thrust, fuel, tanks, members: fuelGroup });
          }
          for (const part of fuelGroup) {
            if (litEngines.has(part) && part.type.engine.solid && fuelLeft.get(part).solid > 1e-6) {
              const engineThrust = Flatspace.partThrust(part, pressure);
              active.push({
                massFlow: engineThrust.massFlowRate,
                thrust: engineThrust.force,
                fuel: fuelLeft.get(part).solid,
                solidPart: part,
                members: [part],
              });
            }
          }
        }
        if (startThrust === null) {
          startThrust = active.reduce((sum, burner) => sum + burner.thrust, 0);
        }
        if (!active.length) {
          break;
        }
        if (dropSet && !active.some((burner) => burner.members.some((part) => dropSet.has(part)))) {
          break;
        }
        const timeUntilFirstEmpty = Math.min(...active.map((burner) => burner.fuel / burner.massFlow));
        const totalFlow = active.reduce((sum, burner) => sum + burner.massFlow, 0);
        const totalThrust = active.reduce((sum, burner) => sum + burner.thrust, 0);
        const endMass = mass - totalFlow * timeUntilFirstEmpty;
        if (totalThrust > 0 && endMass > 0) {
          deltaV += (totalThrust / totalFlow) * Math.log(mass / endMass);
        }
        for (const burner of active) {
          const used = burner.massFlow * timeUntilFirstEmpty;
          if (burner.solidPart) {
            fuelLeft.get(burner.solidPart).solid = Math.max(0, fuelLeft.get(burner.solidPart).solid - used);
          } else {
            for (const tank of burner.tanks) {
              const tankLeft = fuelLeft.get(tank);
              tankLeft.fuel = Math.max(0, tankLeft.fuel - used * (tankLeft.fuel / burner.fuel));
            }
          }
        }
        mass = endMass;
        time += timeUntilFirstEmpty;
      }
      const thrust = startThrust || 0;
      return { deltaV, time, thrust, mass: startMass, thrustToWeight: thrust / (startMass * gravity) };
    }

    const current = burn(dropOf(stages[startIndex]));
    const events = [];
    for (let stageIndex = startIndex; stageIndex < stages.length; stageIndex++) {
      const stage = stages[stageIndex];
      const drop = dropOf(stage);
      if (drop) {
        attached = attached.filter((part) => !drop.has(part));
      }
      if (stage.ignite) {
        for (const engine of stage.engines) {
          if (attached.includes(engine)) {
            litEngines.add(engine);
          }
        }
      }
      events.push(burn(dropOf(stages[stageIndex + 1])));
    }
    return {
      current,
      events,
      total: current.deltaV + events.reduce((sum, stageEvent) => sum + stageEvent.deltaV, 0),
    };
  };
})();
