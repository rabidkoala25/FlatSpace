// partgraph.js — the part tree.
// A craft is a list of parts. Every part except the root hangs from a parent at an attach
// node: 'bottom' (below the parent), 'top' (above it) or 'srf' (on its side).
// Positions use the craft frame: metres, +y towards the nose, +x to the right of it.
// rot is counter-clockwise in radians (0 = upright); flip mirrors a part left-right.
//
// Saved craft store parts as { id, parent (index or -1), node, x, y, rot, flip, sym }.
// x, y and rot are absolute (craft frame). In memory a side-attached part also keeps
// srfOff (its offset in the parent's own frame) and rel (its angle relative to the
// parent), so turning a parent carries its side parts round with it. sym links a part
// to its mirror twin (editor symmetry).
(function () {
  const Vector = FS.vec;
  const roundTo3 = (value) => Math.round(value * 1000) / 1000;
  // rotate v counter-clockwise by angle a
  const rotV = (vector, angle) => {
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);
    return { x: vector.x * cosAngle - vector.y * sinAngle, y: vector.x * sinAngle + vector.y * cosAngle };
  };
  FS.rotV = rotV;

  // Recompute the stored offset and relative angle of side parts from their absolute pose.
  FS.syncOffsets = (list) => {
    for (const part of list) {
      if (part.node !== 'srf' || !part.parent) {
        continue;
      }
      part.srfOff = rotV(Vector.sub(part.pos, part.parent.pos), -part.parent.rot);
      part.rel = part.rot - part.parent.rot;
    }
  };

  // ---------- Making parts ----------
  // Every part instance carries its own size and settings, so tanks can be stretched and
  // engines throttled down part by part (step A4):
  //   len, size     length and width (m); only stretchable tanks differ from their type
  //   dry, cap, cda dry mass (kg), fuel capacity (kg) and front drag area, scaled with volume
  //   fill          how full the tanks start (0..1)
  //   skin          a tank's look: white, gold, foam, roll, steel
  //   limit         an engine's thrust limit (0..1); gimbal its gimbal range (0..1)
  //   crossfeed     a decoupler lets fuel flow across it
  //   chuteAlt      height above ground at which a parachute opens fully (m)
  //   stage         custom staging: the stage it fires in (-1 = not staged); absent = automatic
  //   loose         on the root of a floating group (not the craft's root): 'keep' launches it
  //                 with the craft where it was placed, 'drop' leaves it behind
  FS.TANK_WIDTHS = [0.625, 1.25, 1.875, 2.5, 3.75, 5];
  FS.TANK_SKINS = ['white', 'gold', 'foam', 'roll', 'steel'];
  FS.LEN_STEP = 0.25;
  FS.MAX_TANK_LEN = 24;
  let nextUid = 1;
  FS.newPart = (partId, opts = {}) => {
    const partType = FS.PART[partId];
    if (!partType) {
      return null;
    }
    const part = {
      uid: nextUid++,
      def: partType,
      parent: null,
      node: 'bottom',
      pos: { x: 0, y: 0 },
      rot: 0,
      flip: false,
      fuel: 0,
      solid: partType.solid || 0,
      lit: false,
      chute: partType.chute ? 'stowed' : null,
      len: partType.len,
      size: partType.w === 'auto' ? null : partType.w,
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
      part.chuteAlt = 1000;
    }
    for (const option of [
      'len',
      'size',
      'fill',
      'skin',
      'limit',
      'gimbal',
      'crossfeed',
      'chuteAlt',
      'stage',
      'loose',
    ]) {
      if (opts[option] !== undefined) {
        part[option] = opts[option];
      }
    }
    FS.applySize(part, true);
    return part;
  };

  // Work out a part's mass, fuel capacity and drag from its size. A stretched tank keeps its
  // type's density: fuel and dry mass scale with length × width², front drag with width².
  // refill: set the fuel to capacity × fill (the editor does this after any change).
  FS.applySize = (part, refill = true) => {
    const partType = part.def;
    if (partType.stretch) {
      part.len = FS.clamp(Math.round(part.len / FS.LEN_STEP) * FS.LEN_STEP, FS.LEN_STEP, FS.MAX_TANK_LEN);
      if (!FS.TANK_WIDTHS.includes(part.size)) {
        part.size = partType.w;
      }
    } else {
      part.len = partType.len;
      if (partType.w !== 'auto') {
        part.size = partType.w;
      }
    }
    const widthRatio = partType.stretch ? part.size / partType.w : 1;
    const sizeFactor = partType.stretch ? (part.len / partType.len) * widthRatio * widthRatio : 1;
    part.dry = partType.mass * sizeFactor;
    part.cap = (partType.fuel || 0) * sizeFactor;
    part.cda = partType.cda * widthRatio * widthRatio;
    if (refill) {
      part.fuel = part.cap * FS.clamp(part.fill ?? 1, 0, 1);
    }
    return part;
  };

  // Thrust and mass flow of an engine part, with its thrust limit.
  FS.partThrust = (part, pressure, throttle = 1) =>
    FS.engineThrust(part.def.engine, pressure, throttle * (part.limit ?? 1));

  // A straight stack of part ids (top to bottom): each part hangs below the one above.
  FS.stackToParts = (partIds) => {
    const parts = [];
    for (const partId of partIds) {
      const part = FS.newPart(partId);
      if (!part) {
        continue;
      }
      if (parts.length) {
        part.parent = parts[parts.length - 1];
      }
      parts.push(part);
    }
    FS.relayout(parts);
    return parts;
  };

  // Attach a new part to the side of a parent at craft-frame position pos (tests and editor).
  FS.attachPart = (parts, partId, parent, position, rotation = 0, flip = false) => {
    const part = FS.newPart(partId);
    if (!part) {
      return null;
    }
    Object.assign(part, { parent, node: 'srf', pos: { ...position }, rot: rotation, flip });
    FS.syncOffsets([part]);
    parts.push(part);
    FS.relayout(parts);
    return part;
  };

  FS.serialParts = (parts) => {
    const indexOf = new Map(parts.map((part, index) => [part, index]));
    return parts.map((part) => {
      const serial = {
        id: part.def.id,
        parent: part.parent && indexOf.has(part.parent) ? indexOf.get(part.parent) : -1,
        node: part.node,
        x: roundTo3(part.pos.x),
        y: roundTo3(part.pos.y),
      };
      if (part.rot) {
        serial.rot = roundTo3(part.rot);
      }
      if (part.flip) {
        serial.flip = true;
      }
      if (part.sym) {
        serial.sym = part.sym;
      }
      const partType = part.def;
      if (partType.stretch && part.len !== partType.len) {
        serial.len = part.len;
      }
      if (partType.stretch && part.size !== partType.w) {
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
      if (part.chuteAlt !== undefined && part.chuteAlt !== 1000) {
        serial.chuteAlt = part.chuteAlt;
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

  FS.partsFromSerial = (list) => {
    const parts = list.map((serial) => {
      const part = FS.newPart(serial.id, serial);
      if (part) {
        Object.assign(part, {
          pos: { x: serial.x || 0, y: serial.y || 0 },
          rot: serial.rot || 0,
          flip: !!serial.flip,
          node: serial.node || 'bottom',
        });
      }
      if (part && serial.sym) {
        part.sym = serial.sym;
      }
      return part;
    });
    list.forEach((serial, index) => {
      if (parts[index] && serial.parent >= 0 && parts[serial.parent]) {
        parts[index].parent = parts[serial.parent];
      }
    });
    const out = parts.filter(Boolean);
    FS.syncOffsets(out);
    FS.relayout(out);
    return out;
  };

  // Accept part ids (a stack), saved parts, or live part objects.
  FS.toParts = (source) => {
    if (!source || !source.length) {
      return [];
    }
    if (typeof source[0] === 'string') {
      return FS.stackToParts(source);
    }
    if (source[0].def) {
      const set = new Set(source);
      for (const part of source) {
        if (part.parent && !set.has(part.parent)) {
          part.parent = null;
        }
      }
      return source;
    }
    return FS.partsFromSerial(source);
  };

  // ---------- Tree helpers ----------
  FS.childrenOf = (parts) => {
    const children = new Map(parts.map((part) => [part, []]));
    for (const part of parts) {
      if (part.parent && children.has(part.parent)) {
        children.get(part.parent).push(part);
      }
    }
    return children;
  };
  FS.rootOf = (parts) => {
    const set = new Set(parts);
    return parts.find((part) => !part.parent || !set.has(part.parent)) || null;
  };
  FS.subtree = (parts, top) => {
    const kids = FS.childrenOf(parts);
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
  FS.partAxis = (rotation) => ({ x: -Math.sin(rotation), y: Math.cos(rotation) });

  // Recompute widths of auto-sized parts and the positions of stack-attached parts.
  // Side-attached parts keep their offset from their parent.
  FS.relayout = (parts) => {
    const kids = FS.childrenOf(parts);
    const set = new Set(parts);
    for (const part of parts) {
      if (part.def.w !== 'auto') {
        part.w = part.size || part.def.w;
      }
    }
    for (const part of parts) {
      if (part.def.w !== 'auto') {
        continue;
      }
      const widths = [];
      if (part.parent && set.has(part.parent) && part.node !== 'srf' && part.parent.def.w !== 'auto') {
        widths.push(part.parent.w);
      }
      for (const child of kids.get(part)) {
        if (child.node !== 'srf' && child.def.w !== 'auto') {
          widths.push(child.def.topW || child.w);
        }
      }
      part.w = Math.max(0.625, ...widths);
    }
    for (const part of parts) {
      part.tw = part.def.topW || part.w;
    }

    const place = (part) => {
      for (const child of kids.get(part)) {
        if (child.node === 'srf') {
          if (!child.srfOff) {
            FS.syncOffsets([child]);
          }
          child.pos = Vector.add(part.pos, rotV(child.srfOff, part.rot));
          child.rot = part.rot + (child.rel || 0);
        } else {
          const offset = (child.node === 'top' ? 1 : -1) * (part.len / 2 + child.len / 2);
          child.rot = part.rot;
          child.pos = Vector.add(part.pos, Vector.scale(FS.partAxis(part.rot), offset));
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
  FS.partHull = (part) => {
    const partType = part.def;
    const halfLength = part.len / 2;
    const halfWidth = part.w / 2;
    const topHalfWidth = part.tw / 2;
    // a side fin: the root edge (left, x = -hw) is fixed to the parent, the tip is swept back
    if (partType.fin && partType.radial) {
      return [
        { x: -halfWidth, y: halfLength },
        { x: halfWidth, y: halfLength - part.len * 0.55 },
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
  // c (centre relative to the centre of mass), axis (its +y direction) and hullC (outline
  // points relative to the centre of mass), all in the craft frame.
  FS.massLayout = (parts) => {
    let mass = 0;
    let massX = 0;
    let massY = 0;
    for (const part of parts) {
      const partMass = FS.partMass(part);
      mass += partMass;
      massX += partMass * part.pos.x;
      massY += partMass * part.pos.y;
    }
    const centreOfMass = mass > 0 ? { x: massX / mass, y: massY / mass } : { x: 0, y: 0 };
    let inertia = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const part of parts) {
      const partMass = FS.partMass(part);
      part.c = Vector.sub(part.pos, centreOfMass);
      part.axis = FS.partAxis(part.rot);
      inertia += partMass * (Vector.dot(part.c, part.c) + (part.len * part.len + part.w * part.w) / 12);
      const cosRot = Math.cos(part.rot);
      const sinRot = Math.sin(part.rot);
      part.hullC = FS.partHull(part).map((hullPoint) => {
        const hullX = part.flip ? -hullPoint.x : hullPoint.x;
        return {
          x: part.c.x + hullX * cosRot - hullPoint.y * sinRot,
          y: part.c.y + hullX * sinRot + hullPoint.y * cosRot,
        };
      });
      for (const hullPoint of part.hullC) {
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
      com: centreOfMass,
      I: Math.max(inertia, 1),
      minX,
      maxX,
      minY,
      maxY,
      height: maxY - minY,
      width: maxX - minX,
    };
  };

  // ---------- Aerodynamics (shared by flight and the editor) ----------

  // The air's force on one part per unit dynamic pressure (m², so multiply by q), in the
  // craft frame. u is the craft's direction of motion through the air (unit, craft frame);
  // extra is drag area added along the flow (an open parachute). Two parts:
  // - drag straight back along the flow: front area × how head-on the air meets the part;
  // - a push sideways, across the part: bodies only feel it as the air meets them side-on
  //   (it grows with the square of the angle), but fins work like small wings and push back
  //   from the first degree (2·sin·cos, as a thin wing does), so fins at the tail keep a
  //   rocket pointed into the airflow. (Fuller lift, Mach and shielding come in C4.)
  FS.partAero = (part, airDirection, extra = 0) => {
    const axis = part.axis || FS.partAxis(part.rot);
    const cosAttack = Vector.dot(axis, airDirection);
    const cosA = Math.abs(cosAttack);
    const across = Vector.sub(airDirection, Vector.scale(axis, cosAttack)); // the part of the flow that crosses the part
    const sinA = Vector.len(across);
    let force = Vector.scale(airDirection, -(part.cda * cosA + extra));
    if (sinA > 1e-9) {
      const body = 0.3 * part.len * part.w;
      const finArea = part.def.fin || 0;
      const normalCoefficient = body * sinA * sinA + finArea * (2 * sinA * cosA + sinA * sinA);
      force = Vector.add(force, Vector.scale(across, -normalCoefficient / sinA));
    }
    return force;
  };

  // Where the air's forces act when the craft flies nose-first a few degrees off the
  // airflow (aoa radians), from FS.partAero. Returned as a point on the line through the
  // centre of mass along +y, in the craft frame: { pos, ahead, com }, where ahead is how far
  // in front of the centre of mass it sits (m; negative = behind, which is stable).
  // null when there is nothing for the air to push on.
  FS.centreOfPressure = (parts, angleOfAttack = 0.09) => {
    if (!parts.length) {
      return null;
    }
    const layout = FS.massLayout(parts);
    const airDirection = { x: Math.sin(angleOfAttack), y: Math.cos(angleOfAttack) }; // the craft's motion through the air
    let sideForce = 0;
    let torque = 0;
    for (const part of parts) {
      const force = FS.partAero(part, airDirection);
      sideForce += force.x;
      torque += Vector.cross(part.c, force);
    }
    if (Math.abs(sideForce) < 1e-9) {
      return null;
    }
    const ahead = -torque / sideForce; // cross((0, s), F) = -s·Fx = tau
    return { pos: { x: layout.com.x, y: layout.com.y + ahead }, ahead, com: layout.com };
  };

  // Where the engines of a stage push: the thrust-weighted centre of the engines and the
  // direction of their combined thrust, in the craft frame. null without engines.
  FS.centreOfThrust = (engines) => {
    let totalThrust = 0;
    let thrustX = 0;
    let thrustY = 0;
    let direction = { x: 0, y: 0 };
    for (const engine of engines) {
      const thrust = engine.def.engine.vac;
      const axis = FS.partAxis(engine.rot);
      totalThrust += thrust;
      thrustX += thrust * engine.pos.x;
      thrustY += thrust * engine.pos.y;
      direction = Vector.add(direction, Vector.scale(axis, thrust));
    }
    if (!totalThrust) {
      return null;
    }
    return {
      pos: { x: thrustX / totalThrust, y: thrustY / totalThrust },
      dir: Vector.norm(direction),
      thrust: totalThrust,
    };
  };

  // ---------- Fuel flow ----------
  // Groups of parts that share fuel: the tree cut wherever a decoupler meets its parent,
  // unless the decoupler has crossfeed on. (A decoupler belongs to the side that falls away with it.)
  FS.flowGroups = (parts) => {
    const indexOf = new Map(parts.map((part, index) => [part, index]));
    const parentOf = parts.map((part, index) => index);
    const find = (index) => (parentOf[index] === index ? index : (parentOf[index] = find(parentOf[index])));
    for (const part of parts) {
      if (part.parent && indexOf.has(part.parent) && (!part.def.decoupler || part.crossfeed)) {
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
  FS.stageable = (part) => !!(part.def.engine || part.def.decoupler || part.def.chute);
  // Whether the player has edited the staging (any part carries a stage number).
  FS.customStaging = (parts) => parts.some((part) => typeof part.stage === 'number');

  // Stage events from custom staging: stage k fires every part with stage === k.
  // keepEmpty keeps stages with no parts (the editor shows them; flight skips them).
  FS.customStages = (parts, keepEmpty = false) => {
    const stageCount =
      Math.max(-1, ...parts.map((part) => (typeof part.stage === 'number' ? part.stage : -1))) + 1;
    const events = [];
    for (let stage = 0; stage < stageCount; stage++) {
      const inStage = parts.filter((part) => part.stage === stage && FS.stageable(part));
      const decouplers = inStage.filter((part) => part.def.decoupler);
      const engines = inStage.filter((part) => part.def.engine);
      const chuteParts = inStage.filter((part) => part.def.chute);
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
  FS.freezeStaging = (parts) => {
    const auto = FS.stagesOf(parts);
    for (const part of parts) {
      if (FS.stageable(part)) {
        part.stage = -1;
      }
    }
    auto.forEach((stage, stageIndex) => stage.parts.forEach((part) => (part.stage = stageIndex)));
    return parts;
  };
  FS.resetStaging = (parts) => {
    for (const part of parts) {
      delete part.stage;
    }
    return parts;
  };

  FS.stagesOf = (parts) => {
    if (FS.customStaging(parts)) {
      return FS.customStages(parts);
    }
    const groups = FS.flowGroups(parts);
    const groupOf = new Map();
    groups.forEach((group, groupIndex) => group.forEach((part) => groupOf.set(part, groupIndex)));
    const info = groups.map((group, groupIndex) => {
      const decoupler =
        group.find(
          (part) =>
            part.def.decoupler &&
            part.parent &&
            groupOf.has(part.parent) &&
            groupOf.get(part.parent) !== groupIndex,
        ) || null;
      return {
        parts: group,
        dec: decoupler,
        parent: decoupler ? groupOf.get(decoupler.parent) : -1,
        engines: group.filter((part) => part.def.engine),
      };
    });
    const depth = (groupIndex) => (info[groupIndex].parent < 0 ? 0 : 1 + depth(info[groupIndex].parent));
    info.forEach((group, groupIndex) => (group.depth = depth(groupIndex)));
    const ignition = (groupIndex) => {
      let depth = info[groupIndex].depth;
      info.forEach((other, otherIndex) => {
        if (other.parent === groupIndex && other.dec.def.radial && other.engines.length) {
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
        .filter((group) => group.depth === depth + 1 && group.dec)
        .map((group) => group.dec);
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
    const chuteParts = parts.filter((part) => part.def.chute);
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
  // stage; events[k] is stage startIdx + k. Each has { dv, time, thrust, mass, twr }.
  FS.stageStats = (parts, stages, startIdx, pressure, gravity) => {
    const fuelLeft = new Map(parts.map((part) => [part, { fuel: part.fuel, solid: part.solid }]));
    let attached = parts.slice();
    const litEngines = new Set(parts.filter((part) => part.lit && part.def.engine));
    const massNow = () =>
      attached.reduce((sum, part) => sum + part.dry + fuelLeft.get(part).fuel + fuelLeft.get(part).solid, 0);
    const dropOf = (stage) => {
      if (!stage || !stage.decouple) {
        return null;
      }
      const set = new Set();
      for (const decoupler of stage.decouplers) {
        if (attached.includes(decoupler)) {
          FS.subtree(attached, decoupler).forEach((part) => set.add(part));
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
      const groups = FS.flowGroups(attached);
      if (
        dropSet &&
        ![...dropSet].some((part) => fuelLeft.get(part).fuel + fuelLeft.get(part).solid > 1e-6)
      ) {
        dropSet = null;
      }
      for (let guard = 0; guard < 40; guard++) {
        const active = [];
        for (const fuelGroup of groups) {
          const liquidEngines = fuelGroup.filter((part) => litEngines.has(part) && !part.def.engine.solid);
          const tanks = fuelGroup.filter((part) => part.def.fuel);
          const fuel = tanks.reduce((sum, tank) => sum + fuelLeft.get(tank).fuel, 0);
          if (liquidEngines.length && fuel > 1e-6) {
            let flow = 0;
            let thrust = 0;
            for (const engine of liquidEngines) {
              const engineThrust = FS.partThrust(engine, pressure);
              flow += engineThrust.mdot;
              thrust += engineThrust.F;
            }
            active.push({ md: flow, f: thrust, fuel, tanks, members: fuelGroup });
          }
          for (const part of fuelGroup) {
            if (litEngines.has(part) && part.def.engine.solid && fuelLeft.get(part).solid > 1e-6) {
              const engineThrust = FS.partThrust(part, pressure);
              active.push({
                md: engineThrust.mdot,
                f: engineThrust.F,
                fuel: fuelLeft.get(part).solid,
                solidPart: part,
                members: [part],
              });
            }
          }
        }
        if (startThrust === null) {
          startThrust = active.reduce((sum, burner) => sum + burner.f, 0);
        }
        if (!active.length) {
          break;
        }
        if (dropSet && !active.some((burner) => burner.members.some((part) => dropSet.has(part)))) {
          break;
        }
        const tmin = Math.min(...active.map((burner) => burner.fuel / burner.md));
        const totalFlow = active.reduce((sum, burner) => sum + burner.md, 0);
        const totalThrust = active.reduce((sum, burner) => sum + burner.f, 0);
        const endMass = mass - totalFlow * tmin;
        if (totalThrust > 0 && endMass > 0) {
          deltaV += (totalThrust / totalFlow) * Math.log(mass / endMass);
        }
        for (const burner of active) {
          const used = burner.md * tmin;
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
        time += tmin;
      }
      const thrust = startThrust || 0;
      return { dv: deltaV, time, thrust, mass: startMass, twr: thrust / (startMass * gravity) };
    }

    const current = burn(dropOf(stages[startIdx]));
    const events = [];
    for (let stageIndex = startIdx; stageIndex < stages.length; stageIndex++) {
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
      total: current.dv + events.reduce((sum, stageEvent) => sum + stageEvent.dv, 0),
    };
  };
})();
