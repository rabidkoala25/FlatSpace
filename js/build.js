// build.js — the geometry behind drag-and-drop building, with no drawing or DOM, so the
// tests can drive it directly. The editor (editor.js) calls these while a part is held.
//
// Positions are in the craft frame (metres, +y towards the nose), as in partgraph.js.
// "Placed" parts are the craft being built; "held" parts are the part being dragged
// (its root is the part under the pointer) and everything attached below it.
(function () {
  const Vector = Flatspace.Vector;
  const Build = (Flatspace.Build = {});
  const right = (rotation) => ({ x: Math.cos(rotation), y: Math.sin(rotation) });

  // Which stack nodes a part has. Side-only parts (Side Decoupler) have none; a
  // parachute has only its bottom node, as in KSP.
  Build.hasNode = (partType, node) => !partType.radial && !(node === 'top' && partType.chute);
  // Whether a part may be attached to the side of another, and whether others may be
  // attached to its sides.
  Build.canSurface = (partType) => !partType.chute;
  Build.takesSurface = (partType) => !partType.chute;

  Build.nodePosition = (part, node) =>
    Vector.add(
      part.position,
      Vector.scale(Flatspace.partAxis(part.rotation), ((node === 'top' ? 1 : -1) * part.length) / 2),
    );

  // A stack node is taken by the parent (for the node facing it) or by a stack child.
  Build.nodeFree = (parts, part, node, kids) => {
    if (!Build.hasNode(part.type, node)) {
      return false;
    }
    const set = kids ? null : new Set(parts);
    const hasParent = part.parent && (kids ? kids.has(part.parent) : set.has(part.parent));
    if (hasParent && part.node === (node === 'top' ? 'bottom' : 'top')) {
      return false;
    }
    const children = kids ? kids.get(part) || [] : parts.filter((child) => child.parent === part);
    return !children.some((child) => child.node === node);
  };

  // Every free stack node on the placed parts: { part, node, position }.
  Build.freeNodes = (parts) => {
    const kids = Flatspace.childrenOf(parts);
    const out = [];
    for (const part of parts) {
      for (const node of ['top', 'bottom']) {
        if (Build.nodeFree(parts, part, node, kids)) {
          out.push({ part, node, position: Build.nodePosition(part, node) });
        }
      }
    }
    return out;
  };

  // Half width of a part at height alongY along its own axis (tapers from width at the bottom to topWidth at the top).
  const halfAt = (part, alongY) => {
    const fraction = Flatspace.clamp((alongY + part.length / 2) / part.length, 0, 1);
    return Flatspace.interpolate(part.width, part.topWidth, fraction) / 2;
  };

  // The outline of a part as four corners in the craft frame, shrunk by eps so parts
  // that merely touch don't count as overlapping.
  Build.corners = (part, shrink = 0) => {
    const halfLength = Math.max(0.01, part.length / 2 - shrink);
    const halfWidth = Math.max(0.01, part.width / 2 - shrink);
    const topHalfWidth = Math.max(0.01, part.topWidth / 2 - shrink);
    const axis = Flatspace.partAxis(part.rotation);
    const rightAxis = right(part.rotation);
    const cornerAt = (acrossX, alongY) => ({
      x: part.position.x + rightAxis.x * acrossX + axis.x * alongY,
      y: part.position.y + rightAxis.y * acrossX + axis.y * alongY,
    });
    return [
      cornerAt(-topHalfWidth, halfLength),
      cornerAt(topHalfWidth, halfLength),
      cornerAt(halfWidth, -halfLength),
      cornerAt(-halfWidth, -halfLength),
    ];
  };

  function separated(polygonA, polygonB) {
    for (const poly of [polygonA, polygonB]) {
      for (let index = 0; index < poly.length; index++) {
        const edgeStart = poly[index];
        const edgeEnd = poly[(index + 1) % poly.length];
        const edgeNormal = { x: edgeStart.y - edgeEnd.y, y: edgeEnd.x - edgeStart.x };
        let minA = Infinity;
        let maxA = -Infinity;
        let minB = Infinity;
        let maxB = -Infinity;
        for (const corner of polygonA) {
          const projection = edgeNormal.x * corner.x + edgeNormal.y * corner.y;
          minA = Math.min(minA, projection);
          maxA = Math.max(maxA, projection);
        }
        for (const corner of polygonB) {
          const projection = edgeNormal.x * corner.x + edgeNormal.y * corner.y;
          minB = Math.min(minB, projection);
          maxB = Math.max(maxB, projection);
        }
        if (maxA <= minB || maxB <= minA) {
          return true;
        }
      }
    }
    return false;
  }
  Build.overlap = (partA, partB, shrink = 0.03) =>
    !separated(Build.corners(partA, shrink), Build.corners(partB, shrink));

  // The part under a point (smallest wins, so side parts can be picked over a tank).
  // tol widens every part by that many metres, for fingers and thin parts.
  Build.partAt = (parts, point, tolerance = 0) => {
    let best = null;
    let bestA = Infinity;
    for (const part of parts) {
      const relative = Vector.subtract(point, part.position);
      const acrossX = Vector.dot(relative, right(part.rotation));
      const alongY = Vector.dot(relative, Flatspace.partAxis(part.rotation));
      const halfLength = part.length / 2;
      if (Math.abs(alongY) > halfLength + tolerance) {
        continue;
      }
      let halfWidth = halfAt(part, alongY);
      if (part.type.fin && !part.type.radial) {
        halfWidth += 0.75;
      }
      if (Math.abs(acrossX) > halfWidth + tolerance) {
        continue;
      }
      const area = part.length * Math.max(part.width, part.topWidth);
      if (area < bestA) {
        best = part;
        bestA = area;
      }
    }
    return best;
  };

  // Lay out the held parts around their root, as a free-floating group at freePosition, turned to
  // the root's spin (the angle the player gave it with Q / E).
  Build.placeHeld = (held, root, position) => {
    root.parent = null;
    root.position = { ...position };
    root.rotation = root.spin || 0;
    Flatspace.relayout(held);
  };

  // How much the side faces of a part lean in from its axis (radians): a part that is
  // narrower at the top (a capsule, an adapter) has faces that lean inwards. The right
  // face leans by +tilt, the left by -tilt.
  Build.faceTilt = (part) => Math.atan2((part.width - part.topWidth) / 2, part.length);

  // The angle a held part takes on one side of a part: lined up with that face, plus the spin the
  // player gave it. A side-only part on the left is mirrored, so a fin tilted on the right
  // tilts the mirror way on the left.
  const sideRotation = (part, root, side) =>
    part.rotation + side * Build.faceTilt(part) + (root.type.radial && side < 0 ? -1 : 1) * (root.spin || 0);

  // The spot on one side (+1 right, -1 left) of a part, at height alongY along it, for the held
  // root turned to rotation: pushed out from the face along its normal until its nearest corner
  // touches it, so it sits flush on sloped faces too. Returns { position, rotation, alongY, want }.
  Build.surfaceSpot = (part, root, side, alongY, rotation) => {
    const partHalfLength = part.length / 2;
    alongY = Flatspace.clamp(alongY, -partHalfLength, partHalfLength);
    const tilt = Build.faceTilt(part);
    const faceNormal = { x: side * Math.cos(tilt), y: Math.sin(tilt) }; // the face's outward normal, in p's frame
    const relativeRotation = rotation - part.rotation;
    const halfLength = root.length / 2;
    const halfWidth = root.width / 2;
    const topHalfWidth = root.topWidth / 2;
    let inner = 0;
    for (const corner of [
      { x: -topHalfWidth, y: halfLength },
      { x: topHalfWidth, y: halfLength },
      { x: halfWidth, y: -halfLength },
      { x: -halfWidth, y: -halfLength },
    ]) {
      const rotatedCorner = Flatspace.rotateVector(corner, relativeRotation);
      inner = Math.max(inner, -(rotatedCorner.x * faceNormal.x + rotatedCorner.y * faceNormal.y));
    }
    const face = { x: side * halfAt(part, alongY), y: alongY };
    const local = { x: face.x + faceNormal.x * inner, y: face.y + faceNormal.y * inner };
    return {
      position: Vector.add(part.position, Flatspace.rotateVector(local, part.rotation)),
      rotation,
      alongY,
      want: Math.abs(local.x),
    };
  };

  // Where the held group would attach if let go with its root's centre at freePos.
  // snap is the snapping distance in metres. Stack nodes within reach win over sides.
  // Among the spots in reach, the nearest free one is chosen; if every one is blocked,
  // the nearest is returned anyway so the editor can show it in red. With mirror on,
  // a spot only counts as free if the mirror twin fits too.
  // Returns null when there is nothing to attach to, or
  // { kind: 'root' | 'bottom' | 'top' | 'surface', parent, side, position, rotation, distance, node }.
  Build.candidate = (placed, held, root, freePosition, snap, mirror = false) => {
    if (!placed.length) {
      return {
        kind: 'root',
        parent: null,
        position: { ...freePosition },
        rotation: root.spin || 0,
        distance: 0,
      };
    }
    const pick = (list) => {
      if (!list.length) {
        return null;
      }
      list.sort((first, second) => first.distance - second.distance);
      return list.find((candidate) => !Build.blocker(placed, held, root, candidate, mirror)) || list[0];
    };
    const heldChildren = Flatspace.childrenOf(held);
    const rootType = root.type;
    const halfLength = root.length / 2;
    // stack nodes: the held root's top node meets a free bottom node, or the other way round
    const stack = [];
    const heldAxis = Flatspace.partAxis(root.spin || 0);
    for (const freeNode of Build.freeNodes(placed)) {
      const mine = freeNode.node === 'bottom' ? 'top' : 'bottom';
      if (!Build.nodeFree(held, root, mine, heldChildren)) {
        continue;
      }
      const ownNodePosition = Vector.add(
        freePosition,
        Vector.scale(heldAxis, (mine === 'top' ? 1 : -1) * halfLength),
      );
      const distance = Vector.length(Vector.subtract(ownNodePosition, freeNode.position));
      if (distance > snap) {
        continue;
      }
      const axis = Flatspace.partAxis(freeNode.part.rotation);
      const position = Vector.add(
        freeNode.part.position,
        Vector.scale(axis, (freeNode.node === 'top' ? 1 : -1) * (freeNode.part.length / 2 + halfLength)),
      );
      stack.push({
        kind: freeNode.node,
        parent: freeNode.part,
        position,
        rotation: freeNode.part.rotation,
        distance,
        node: freeNode,
      });
    }
    const choice = pick(stack);
    if (choice || !Build.canSurface(rootType)) {
      return choice;
    }
    // surface attach: on the left or right side of a part, next to the pointer
    const side = [];
    for (const part of placed) {
      if (!Build.takesSurface(part.type)) {
        continue;
      }
      const relative = Vector.subtract(freePosition, part.position);
      const acrossX = Vector.dot(relative, right(part.rotation));
      let alongY = Vector.dot(relative, Flatspace.partAxis(part.rotation));
      const partHalfLength = part.length / 2;
      if (Math.abs(alongY) > partHalfLength + snap * 0.5) {
        continue;
      }
      if (Math.abs(alongY) < snap * 0.35) {
        alongY = 0;
      } // snap to the middle of the side
      else {
        alongY = Math.round(alongY * 20) / 20;
      }
      const faceSide = acrossX < 0 ? -1 : 1;
      const spot = Build.surfaceSpot(part, root, faceSide, alongY, sideRotation(part, root, faceSide));
      const distance = Math.abs(Math.abs(acrossX) - spot.want);
      if (distance > Math.max(root.width, root.topWidth) / 2 + snap) {
        continue;
      }
      side.push({
        kind: 'surface',
        parent: part,
        side: faceSide,
        position: spot.position,
        rotation: spot.rotation,
        distance,
      });
    }
    return pick(side);
  };

  // Attach the held group as described by candidate (from Build.candidate). Returns the merged part list.
  Build.attach = (placed, held, root, candidate) => {
    root.parent = candidate.parent;
    root.node = candidate.kind === 'root' ? 'bottom' : candidate.kind;
    root.rotation = candidate.rotation;
    root.position = { ...candidate.position };
    if (candidate.kind === 'surface') {
      if (root.type.radial) {
        root.flip = candidate.side < 0;
      }
      Flatspace.syncOffsets([root]);
    } else {
      delete root.surfaceOffset;
      delete root.relativeRotation;
    }
    const all = placed.concat(held);
    Flatspace.relayout(all);
    return all;
  };

  // ---------- Mirror symmetry ----------
  // A mirror is a line { m (a point), a (unit direction), twinParent }. A part attached
  // to a part that has a twin gets its own twin on the twin, mirrored across the line
  // halfway between them; a part on the side of a part without a twin is mirrored across
  // that part's axis, onto its other side. Stack parts on an unmirrored part have no twin.
  Build.twinOf = (parts, part) =>
    part && part.symmetryGroup
      ? parts.find((other) => other !== part && other.symmetryGroup === part.symmetryGroup) || null
      : null;

  Build.mirrorFor = (placed, parent, kind) => {
    if (!parent) {
      return null;
    }
    const parentTwin = Build.twinOf(placed, parent);
    if (parentTwin) {
      const direction = Vector.normalise(Vector.subtract(parentTwin.position, parent.position));
      return {
        point: Vector.scale(Vector.add(parent.position, parentTwin.position), 0.5),
        axis: Vector.perpendicular(direction),
        twinParent: parentTwin,
      };
    }
    if (kind === 'surface') {
      return { point: { ...parent.position }, axis: Flatspace.partAxis(parent.rotation), twinParent: parent };
    }
    return null;
  };
  Build.reflect = (line, point) => {
    const relative = Vector.subtract(point, line.point);
    return Vector.add(
      line.point,
      Vector.subtract(Vector.scale(line.axis, 2 * Vector.dot(relative, line.axis)), relative),
    );
  };
  Build.reflectRotation = (line, rotation) =>
    Flatspace.wrapAngle(2 * Math.atan2(-line.axis.x, line.axis.y) - rotation);

  // Copies of parts (a group whose first part is its root), with mirror links renumbered.
  let nextSymmetryGroup = 1;
  Build.newSymmetryGroup = () => 's' + Date.now().toString(36) + nextSymmetryGroup++;
  Build.clone = (group) => {
    const out = Flatspace.partsFromSerial(Flatspace.serialParts(group));
    const map = {};
    for (const part of out) {
      if (part.symmetryGroup) {
        part.symmetryGroup = map[part.symmetryGroup] || (map[part.symmetryGroup] = Build.newSymmetryGroup());
      }
    }
    return out;
  };

  // The mirror twin of a held group that has just been attached (B.attach) as kind.
  Build.makeTwin = (held, line, kind) => {
    const twin = Build.clone(held);
    twin.forEach((twinPart, index) => {
      const heldPart = held[index];
      twinPart.position = Build.reflect(line, heldPart.position);
      twinPart.rotation = Build.reflectRotation(line, heldPart.rotation);
      twinPart.flip = !heldPart.flip;
      twinPart.node = heldPart.node;
    });
    twin[0].parent = line.twinParent;
    twin[0].node = kind;
    Flatspace.syncOffsets(twin);
    return twin;
  };

  // Link a group and its twin part for part, so they move, turn and go together.
  Build.linkTwins = (groupA, groupB) =>
    groupA.forEach((part, index) => {
      part.symmetryGroup = groupB[index].symmetryGroup = Build.newSymmetryGroup();
    });

  // Which placed part the held group (and its mirror twin, with mirror on) would overlap
  // if attached as candidate, or null. Leaves the held parts where candidate puts them.
  Build.blocker = (placed, held, root, candidate, mirror = false) => {
    Build.attach(placed, held, root, candidate);
    const line = mirror ? Build.mirrorFor(placed, candidate.parent, candidate.kind) : null;
    let twin = [];
    if (line) {
      twin = Build.makeTwin(held, line, candidate.kind);
      Flatspace.relayout(placed.concat(held, twin));
    }
    let hit = null;
    const groups = [
      [held, root, candidate.parent],
      [twin, twin[0], line && line.twinParent],
    ];
    for (const [group, groupRoot, groupParent] of groups) {
      for (const heldPart of group) {
        for (const part of placed) {
          if (heldPart === groupRoot && part === groupParent) {
            continue;
          }
          if (Build.overlap(heldPart, part)) {
            hit = part;
            break;
          }
        }
        if (!hit && line) {
          for (const twinPart of group === held ? twin : []) {
            if (Build.overlap(heldPart, twinPart)) {
              hit = heldPart;
              break;
            }
          }
        }
        if (hit) {
          break;
        }
      }
      if (hit) {
        break;
      }
    }
    Build.detach(placed, held, root);
    return hit;
  };

  // Undo B.attach, leaving the held group where it was attached (so a snapped ghost stays put).
  Build.detach = (placed, held, root) => {
    root.parent = null;
    Flatspace.relayout(placed);
    Flatspace.relayout(held);
  };

  // Put a part's mirror twin back in mirror position after the part moved or turned.
  Build.syncTwin = (parts, part) => {
    const twin = Build.twinOf(parts, part);
    if (!twin || !part.parent || !twin.parent) {
      return;
    }
    const line =
      part.parent === twin.parent
        ? { point: { ...part.parent.position }, axis: Flatspace.partAxis(part.parent.rotation) }
        : Build.mirrorFor(parts, part.parent, part.node);
    if (!line) {
      return;
    }
    twin.position = Build.reflect(line, part.position);
    twin.rotation = Build.reflectRotation(line, part.rotation);
    twin.flip = !part.flip;
    Flatspace.syncOffsets([twin]);
    Flatspace.relayout(parts);
  };

  // Whether a part (with everything below it) overlaps any other part, apart from its parent.
  Build.collides = (parts, part) => {
    const mine = new Set(Flatspace.subtree(parts, part));
    for (const myPart of mine) {
      for (const other of parts) {
        if (mine.has(other) || (myPart === part && other === part.parent)) {
          continue;
        }
        if (Build.overlap(myPart, other)) {
          return other;
        }
      }
    }
    return null;
  };

  // Re-place a side part at height alongY on its parent, turned to rotation (absolute), keeping
  // its inner edge on the surface. Its twin follows. Refused (returns the part in the
  // way) if anything would overlap; then nothing changes.
  Build.moveOnSurface = (parts, part, alongY, rotation) => {
    if (part.node !== 'surface' || !part.parent) {
      return null;
    }
    const saved = parts.map((part) => ({
      part,
      position: { ...part.position },
      rotation: part.rotation,
      flip: part.flip,
      surfaceOffset: part.surfaceOffset && { ...part.surfaceOffset },
      relativeRotation: part.relativeRotation,
    }));
    const side = part.surfaceOffset && part.surfaceOffset.x < 0 ? -1 : 1;
    const spot = Build.surfaceSpot(part.parent, part, side, alongY, rotation);
    part.position = spot.position;
    part.rotation = spot.rotation;
    Flatspace.syncOffsets([part]);
    Flatspace.relayout(parts);
    Build.syncTwin(parts, part);
    const twin = Build.twinOf(parts, part);
    const hit = Build.collides(parts, part) || (twin && Build.collides(parts, twin));
    if (hit) {
      for (const savedState of saved) {
        Object.assign(savedState.part, {
          position: savedState.position,
          rotation: savedState.rotation,
          flip: savedState.flip,
          surfaceOffset: savedState.surfaceOffset,
          relativeRotation: savedState.relativeRotation,
        });
      }
      Flatspace.relayout(parts);
    }
    return hit;
  };

  // A side part's height along its parent (its offset in the parent's frame).
  Build.surfaceHeight = (part) => (part.surfaceOffset ? part.surfaceOffset.y : 0);

  // Make part x the root: every link on the path from x up to the old root is reversed.
  Build.reroot = (parts, newRoot) => {
    const path = [];
    for (let child = newRoot; child.parent; child = child.parent) {
      path.push({ child, parent: child.parent, node: child.node });
    }
    for (const { child, parent: parentPart, node } of path) {
      parentPart.parent = child;
      parentPart.node = node === 'bottom' ? 'top' : node === 'top' ? 'bottom' : 'surface';
      if (parentPart.node === 'surface') {
        Flatspace.syncOffsets([parentPart]);
      } else {
        delete parentPart.surfaceOffset;
        delete parentPart.relativeRotation;
      }
    }
    newRoot.parent = null;
    newRoot.node = 'bottom';
    delete newRoot.surfaceOffset;
    delete newRoot.relativeRotation;
    // keep the new root first, so saved craft list it first
    const rootIndex = parts.indexOf(newRoot);
    if (rootIndex > 0) {
      parts.splice(rootIndex, 1);
      parts.unshift(newRoot);
    }
    Flatspace.relayout(parts);
    return parts;
  };
})();
