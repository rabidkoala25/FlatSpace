// build.js — the geometry behind drag-and-drop building, with no drawing or DOM, so the
// tests can drive it directly. The editor (editor.js) calls these while a part is held.
//
// Positions are in the craft frame (metres, +y towards the nose), as in partgraph.js.
// "Placed" parts are the craft being built; "held" parts are the part being dragged
// (its root is the part under the pointer) and everything attached below it.
(function () {
  const Vector = FS.vec;
  const Build = (FS.Build = {});
  const right = (rotation) => ({ x: Math.cos(rotation), y: Math.sin(rotation) });

  // Which stack nodes a part has. Side-only parts (Side Decoupler) have none; a
  // parachute has only its bottom node, as in KSP.
  Build.hasNode = (partType, node) => !partType.radial && !(node === 'top' && partType.chute);
  // Whether a part may be attached to the side of another, and whether others may be
  // attached to its sides.
  Build.canSurface = (partType) => !partType.chute;
  Build.takesSurface = (partType) => !partType.chute;

  Build.nodePos = (part, node) =>
    Vector.add(part.pos, Vector.scale(FS.partAxis(part.rot), ((node === 'top' ? 1 : -1) * part.len) / 2));

  // A stack node is taken by the parent (for the node facing it) or by a stack child.
  Build.nodeFree = (parts, part, node, kids) => {
    if (!Build.hasNode(part.def, node)) {
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

  // Every free stack node on the placed parts: { part, node, pos }.
  Build.freeNodes = (parts) => {
    const kids = FS.childrenOf(parts);
    const out = [];
    for (const part of parts) {
      for (const node of ['top', 'bottom']) {
        if (Build.nodeFree(parts, part, node, kids)) {
          out.push({ part: part, node, pos: Build.nodePos(part, node) });
        }
      }
    }
    return out;
  };

  // Half width of part p at height ly along its own axis (tapers from w at the bottom to tw at the top).
  const halfAt = (part, alongY) => {
    const fraction = FS.clamp((alongY + part.len / 2) / part.len, 0, 1);
    return FS.lerp(part.w, part.tw, fraction) / 2;
  };

  // The outline of a part as four corners in the craft frame, shrunk by eps so parts
  // that merely touch don't count as overlapping.
  Build.quad = (part, shrink = 0) => {
    const halfLength = Math.max(0.01, part.len / 2 - shrink);
    const halfWidth = Math.max(0.01, part.w / 2 - shrink);
    const topHalfWidth = Math.max(0.01, part.tw / 2 - shrink);
    const axis = FS.partAxis(part.rot);
    const rightAxis = right(part.rot);
    const cornerAt = (acrossX, alongY) => ({
      x: part.pos.x + rightAxis.x * acrossX + axis.x * alongY,
      y: part.pos.y + rightAxis.y * acrossX + axis.y * alongY,
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
        let amin = Infinity;
        let amax = -Infinity;
        let bmin = Infinity;
        let bmax = -Infinity;
        for (const corner of polygonA) {
          const projection = edgeNormal.x * corner.x + edgeNormal.y * corner.y;
          amin = Math.min(amin, projection);
          amax = Math.max(amax, projection);
        }
        for (const corner of polygonB) {
          const projection = edgeNormal.x * corner.x + edgeNormal.y * corner.y;
          bmin = Math.min(bmin, projection);
          bmax = Math.max(bmax, projection);
        }
        if (amax <= bmin || bmax <= amin) {
          return true;
        }
      }
    }
    return false;
  }
  Build.overlap = (partA, partB, shrink = 0.03) =>
    !separated(Build.quad(partA, shrink), Build.quad(partB, shrink));

  // The part under a point (smallest wins, so side parts can be picked over a tank).
  // tol widens every part by that many metres, for fingers and thin parts.
  Build.partAt = (parts, point, tolerance = 0) => {
    let best = null;
    let bestA = Infinity;
    for (const part of parts) {
      const relative = Vector.sub(point, part.pos);
      const acrossX = Vector.dot(relative, right(part.rot));
      const alongY = Vector.dot(relative, FS.partAxis(part.rot));
      const halfLength = part.len / 2;
      if (Math.abs(alongY) > halfLength + tolerance) {
        continue;
      }
      let halfWidth = halfAt(part, alongY);
      if (part.def.fin && !part.def.radial) {
        halfWidth += 0.75;
      }
      if (Math.abs(acrossX) > halfWidth + tolerance) {
        continue;
      }
      const area = part.len * Math.max(part.w, part.tw);
      if (area < bestA) {
        best = part;
        bestA = area;
      }
    }
    return best;
  };

  // Lay out the held parts around their root, as a free-floating group at pos, turned to
  // the root's spin (the angle the player gave it with Q / E).
  Build.placeHeld = (held, root, position) => {
    root.parent = null;
    root.pos = { ...position };
    root.rot = root.spin || 0;
    FS.relayout(held);
  };

  // How much the side faces of part p lean in from its axis (radians): a part that is
  // narrower at the top (a capsule, an adapter) has faces that lean inwards. The right
  // face leans by +tilt, the left by -tilt.
  Build.faceTilt = (part) => Math.atan2((part.w - part.tw) / 2, part.len);

  // The angle a held part takes on side sd of p: lined up with that face, plus the spin the
  // player gave it. A side-only part on the left is mirrored, so a fin tilted on the right
  // tilts the mirror way on the left.
  const sideRot = (part, root, side) =>
    part.rot + side * Build.faceTilt(part) + (root.def.radial && side < 0 ? -1 : 1) * (root.spin || 0);

  // The spot on side sd (+1 right, -1 left) of part p, at height ly along it, for the held
  // root turned to rot: pushed out from the face along its normal until its nearest corner
  // touches it, so it sits flush on sloped faces too. Returns { pos, rot, ly, want }.
  Build.surfaceSpot = (part, root, side, alongY, rotation) => {
    const partHalfLength = part.len / 2;
    alongY = FS.clamp(alongY, -partHalfLength, partHalfLength);
    const tilt = Build.faceTilt(part);
    const faceNormal = { x: side * Math.cos(tilt), y: Math.sin(tilt) }; // the face's outward normal, in p's frame
    const relativeRotation = rotation - part.rot;
    const halfLength = root.len / 2;
    const halfWidth = root.w / 2;
    const topHalfWidth = root.tw / 2;
    let inner = 0;
    for (const corner of [
      { x: -topHalfWidth, y: halfLength },
      { x: topHalfWidth, y: halfLength },
      { x: halfWidth, y: -halfLength },
      { x: -halfWidth, y: -halfLength },
    ]) {
      const rotatedCorner = FS.rotV(corner, relativeRotation);
      inner = Math.max(inner, -(rotatedCorner.x * faceNormal.x + rotatedCorner.y * faceNormal.y));
    }
    const face = { x: side * halfAt(part, alongY), y: alongY };
    const local = { x: face.x + faceNormal.x * inner, y: face.y + faceNormal.y * inner };
    return {
      pos: Vector.add(part.pos, FS.rotV(local, part.rot)),
      rot: rotation,
      ly: alongY,
      want: Math.abs(local.x),
    };
  };

  // Where the held group would attach if let go with its root's centre at freePos.
  // snap is the snapping distance in metres. Stack nodes within reach win over sides.
  // Among the spots in reach, the nearest free one is chosen; if every one is blocked,
  // the nearest is returned anyway so the editor can show it in red. With mirror on,
  // a spot only counts as free if the mirror twin fits too.
  // Returns null when there is nothing to attach to, or
  // { kind: 'root' | 'bottom' | 'top' | 'srf', parent, side, pos, rot, dist, node }.
  Build.candidate = (placed, held, root, freePos, snap, mirror = false) => {
    if (!placed.length) {
      return { kind: 'root', parent: null, pos: { ...freePos }, rot: root.spin || 0, dist: 0 };
    }
    const pick = (list) => {
      if (!list.length) {
        return null;
      }
      list.sort((first, second) => first.dist - second.dist);
      return list.find((candidate) => !Build.blocker(placed, held, root, candidate, mirror)) || list[0];
    };
    const heldChildren = FS.childrenOf(held);
    const rootType = root.def;
    const halfLength = root.len / 2;
    // stack nodes: the held root's top node meets a free bottom node, or the other way round
    const stack = [];
    const heldAxis = FS.partAxis(root.spin || 0);
    for (const freeNode of Build.freeNodes(placed)) {
      const mine = freeNode.node === 'bottom' ? 'top' : 'bottom';
      if (!Build.nodeFree(held, root, mine, heldChildren)) {
        continue;
      }
      const myPos = Vector.add(freePos, Vector.scale(heldAxis, (mine === 'top' ? 1 : -1) * halfLength));
      const dist = Vector.len(Vector.sub(myPos, freeNode.pos));
      if (dist > snap) {
        continue;
      }
      const axis = FS.partAxis(freeNode.part.rot);
      const position = Vector.add(
        freeNode.part.pos,
        Vector.scale(axis, (freeNode.node === 'top' ? 1 : -1) * (freeNode.part.len / 2 + halfLength)),
      );
      stack.push({
        kind: freeNode.node,
        parent: freeNode.part,
        pos: position,
        rot: freeNode.part.rot,
        dist,
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
      if (!Build.takesSurface(part.def)) {
        continue;
      }
      const relative = Vector.sub(freePos, part.pos);
      const acrossX = Vector.dot(relative, right(part.rot));
      let alongY = Vector.dot(relative, FS.partAxis(part.rot));
      const partHalfLength = part.len / 2;
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
      const spot = Build.surfaceSpot(part, root, faceSide, alongY, sideRot(part, root, faceSide));
      const dist = Math.abs(Math.abs(acrossX) - spot.want);
      if (dist > Math.max(root.w, root.tw) / 2 + snap) {
        continue;
      }
      side.push({ kind: 'srf', parent: part, side: faceSide, pos: spot.pos, rot: spot.rot, dist });
    }
    return pick(side);
  };

  // Attach the held group as described by cand (from B.candidate). Returns the merged part list.
  Build.attach = (placed, held, root, cand) => {
    root.parent = cand.parent;
    root.node = cand.kind === 'root' ? 'bottom' : cand.kind;
    root.rot = cand.rot;
    root.pos = { ...cand.pos };
    if (cand.kind === 'srf') {
      if (root.def.radial) {
        root.flip = cand.side < 0;
      }
      FS.syncOffsets([root]);
    } else {
      delete root.srfOff;
      delete root.rel;
    }
    const all = placed.concat(held);
    FS.relayout(all);
    return all;
  };

  // ---------- Mirror symmetry ----------
  // A mirror is a line { m (a point), a (unit direction), twinParent }. A part attached
  // to a part that has a twin gets its own twin on the twin, mirrored across the line
  // halfway between them; a part on the side of a part without a twin is mirrored across
  // that part's axis, onto its other side. Stack parts on an unmirrored part have no twin.
  Build.twinOf = (parts, part) =>
    part && part.sym ? parts.find((other) => other !== part && other.sym === part.sym) || null : null;

  Build.mirrorFor = (placed, parent, kind) => {
    if (!parent) {
      return null;
    }
    const parentTwin = Build.twinOf(placed, parent);
    if (parentTwin) {
      const direction = Vector.norm(Vector.sub(parentTwin.pos, parent.pos));
      return {
        m: Vector.scale(Vector.add(parent.pos, parentTwin.pos), 0.5),
        a: Vector.perp(direction),
        twinParent: parentTwin,
      };
    }
    if (kind === 'srf') {
      return { m: { ...parent.pos }, a: FS.partAxis(parent.rot), twinParent: parent };
    }
    return null;
  };
  Build.reflect = (line, point) => {
    const relative = Vector.sub(point, line.m);
    return Vector.add(line.m, Vector.sub(Vector.scale(line.a, 2 * Vector.dot(relative, line.a)), relative));
  };
  Build.reflectRot = (line, rotation) => FS.wrapAngle(2 * Math.atan2(-line.a.x, line.a.y) - rotation);

  // Copies of parts (a group whose first part is its root), with mirror links renumbered.
  let symSeq = 1;
  Build.newSym = () => 's' + Date.now().toString(36) + symSeq++;
  Build.clone = (group) => {
    const out = FS.partsFromSerial(FS.serialParts(group));
    const map = {};
    for (const part of out) {
      if (part.sym) {
        part.sym = map[part.sym] || (map[part.sym] = Build.newSym());
      }
    }
    return out;
  };

  // The mirror twin of a held group that has just been attached (B.attach) as kind.
  Build.makeTwin = (held, line, kind) => {
    const twin = Build.clone(held);
    twin.forEach((twinPart, index) => {
      const heldPart = held[index];
      twinPart.pos = Build.reflect(line, heldPart.pos);
      twinPart.rot = Build.reflectRot(line, heldPart.rot);
      twinPart.flip = !heldPart.flip;
      twinPart.node = heldPart.node;
    });
    twin[0].parent = line.twinParent;
    twin[0].node = kind;
    FS.syncOffsets(twin);
    return twin;
  };

  // Link a group and its twin part for part, so they move, turn and go together.
  Build.linkTwins = (groupA, groupB) =>
    groupA.forEach((part, index) => {
      part.sym = groupB[index].sym = Build.newSym();
    });

  // Which placed part the held group (and its mirror twin, with mirror on) would overlap
  // if attached as cand, or null. Leaves the held parts where cand puts them.
  Build.blocker = (placed, held, root, cand, mirror = false) => {
    Build.attach(placed, held, root, cand);
    const line = mirror ? Build.mirrorFor(placed, cand.parent, cand.kind) : null;
    let twin = [];
    if (line) {
      twin = Build.makeTwin(held, line, cand.kind);
      FS.relayout(placed.concat(held, twin));
    }
    let hit = null;
    const groups = [
      [held, root, cand.parent],
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
    FS.relayout(placed);
    FS.relayout(held);
  };

  // Put a part's mirror twin back in mirror position after the part moved or turned.
  Build.syncTwin = (parts, part) => {
    const twin = Build.twinOf(parts, part);
    if (!twin || !part.parent || !twin.parent) {
      return;
    }
    const line =
      part.parent === twin.parent
        ? { m: { ...part.parent.pos }, a: FS.partAxis(part.parent.rot) }
        : Build.mirrorFor(parts, part.parent, part.node);
    if (!line) {
      return;
    }
    twin.pos = Build.reflect(line, part.pos);
    twin.rot = Build.reflectRot(line, part.rot);
    twin.flip = !part.flip;
    FS.syncOffsets([twin]);
    FS.relayout(parts);
  };

  // Whether part p (with everything below it) overlaps any other part, apart from its parent.
  Build.collides = (parts, part) => {
    const mine = new Set(FS.subtree(parts, part));
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

  // Re-place a side part at height ly on its parent, turned to rot (absolute), keeping
  // its inner edge on the surface. Its twin follows. Refused (returns the part in the
  // way) if anything would overlap; then nothing changes.
  Build.moveOnSurface = (parts, part, alongY, rotation) => {
    if (part.node !== 'srf' || !part.parent) {
      return null;
    }
    const saved = parts.map((part) => ({
      q: part,
      pos: { ...part.pos },
      rot: part.rot,
      flip: part.flip,
      srfOff: part.srfOff && { ...part.srfOff },
      rel: part.rel,
    }));
    const side = part.srfOff && part.srfOff.x < 0 ? -1 : 1;
    const spot = Build.surfaceSpot(part.parent, part, side, alongY, rotation);
    part.pos = spot.pos;
    part.rot = spot.rot;
    FS.syncOffsets([part]);
    FS.relayout(parts);
    Build.syncTwin(parts, part);
    const twin = Build.twinOf(parts, part);
    const hit = Build.collides(parts, part) || (twin && Build.collides(parts, twin));
    if (hit) {
      for (const savedState of saved) {
        Object.assign(savedState.q, {
          pos: savedState.pos,
          rot: savedState.rot,
          flip: savedState.flip,
          srfOff: savedState.srfOff,
          rel: savedState.rel,
        });
      }
      FS.relayout(parts);
    }
    return hit;
  };

  // A side part's height along its parent (its offset in the parent's frame).
  Build.surfaceHeight = (part) => (part.srfOff ? part.srfOff.y : 0);

  // Make part x the root: every link on the path from x up to the old root is reversed.
  Build.reroot = (parts, newRoot) => {
    const path = [];
    for (let child = newRoot; child.parent; child = child.parent) {
      path.push({ c: child, p: child.parent, node: child.node });
    }
    for (const { c: child, p: parentPart, node } of path) {
      parentPart.parent = child;
      parentPart.node = node === 'bottom' ? 'top' : node === 'top' ? 'bottom' : 'srf';
      if (parentPart.node === 'srf') {
        FS.syncOffsets([parentPart]);
      } else {
        delete parentPart.srfOff;
        delete parentPart.rel;
      }
    }
    newRoot.parent = null;
    newRoot.node = 'bottom';
    delete newRoot.srfOff;
    delete newRoot.rel;
    // keep the new root first, so saved craft list it first
    const rootIndex = parts.indexOf(newRoot);
    if (rootIndex > 0) {
      parts.splice(rootIndex, 1);
      parts.unshift(newRoot);
    }
    FS.relayout(parts);
    return parts;
  };
})();
