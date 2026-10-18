// build.js — the geometry behind drag-and-drop building, with no drawing or DOM, so the
// tests can drive it directly. The editor (editor.js) calls these while a part is held.
//
// Positions are in the craft frame (metres, +y towards the nose), as in partgraph.js.
// "Placed" parts are the craft being built; "held" parts are the part being dragged
// (its root is the part under the pointer) and everything attached below it.
(function () {
  const V = FS.vec;
  const B = (FS.Build = {});
  const right = (rot) => ({ x: Math.cos(rot), y: Math.sin(rot) });

  // Which stack nodes a part has. Side-only parts (Side Decoupler) have none; a
  // parachute has only its bottom node, as in KSP.
  B.hasNode = (d, node) => !d.radial && !(node === 'top' && d.chute);
  // Whether a part may be attached to the side of another, and whether others may be
  // attached to its sides.
  B.canSurface = (d) => !d.chute;
  B.takesSurface = (d) => !d.chute;

  B.nodePos = (p, node) => V.add(p.pos, V.scale(FS.partAxis(p.rot), (node === 'top' ? 1 : -1) * p.len / 2));

  // A stack node is taken by the parent (for the node facing it) or by a stack child.
  B.nodeFree = (parts, p, node, kids) => {
    if (!B.hasNode(p.def, node)) return false;
    const set = kids ? null : new Set(parts);
    const hasParent = p.parent && (kids ? kids.has(p.parent) : set.has(p.parent));
    if (hasParent && p.node === (node === 'top' ? 'bottom' : 'top')) return false;
    const ch = kids ? kids.get(p) || [] : parts.filter((c) => c.parent === p);
    return !ch.some((c) => c.node === node);
  };

  // Every free stack node on the placed parts: { part, node, pos }.
  B.freeNodes = (parts) => {
    const kids = FS.childrenOf(parts);
    const out = [];
    for (const p of parts) for (const node of ['top', 'bottom']) {
      if (B.nodeFree(parts, p, node, kids)) out.push({ part: p, node, pos: B.nodePos(p, node) });
    }
    return out;
  };

  // Half width of part p at height ly along its own axis (tapers from w at the bottom to tw at the top).
  const halfAt = (p, ly) => {
    const t = FS.clamp((ly + p.len / 2) / p.len, 0, 1);
    return FS.lerp(p.w, p.tw, t) / 2;
  };

  // The outline of a part as four corners in the craft frame, shrunk by eps so parts
  // that merely touch don't count as overlapping.
  B.quad = (p, eps = 0) => {
    const hl = Math.max(0.01, p.len / 2 - eps), hw = Math.max(0.01, p.w / 2 - eps), ht = Math.max(0.01, p.tw / 2 - eps);
    const ax = FS.partAxis(p.rot), rx = right(p.rot);
    const at = (x, y) => ({ x: p.pos.x + rx.x * x + ax.x * y, y: p.pos.y + rx.y * x + ax.y * y });
    return [at(-ht, hl), at(ht, hl), at(hw, -hl), at(-hw, -hl)];
  };

  function separated(a, b) {
    for (const poly of [a, b]) {
      for (let i = 0; i < poly.length; i++) {
        const p0 = poly[i], p1 = poly[(i + 1) % poly.length];
        const n = { x: p0.y - p1.y, y: p1.x - p0.x };
        let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
        for (const q of a) { const d = n.x * q.x + n.y * q.y; amin = Math.min(amin, d); amax = Math.max(amax, d); }
        for (const q of b) { const d = n.x * q.x + n.y * q.y; bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
        if (amax <= bmin || bmax <= amin) return true;
      }
    }
    return false;
  }
  B.overlap = (a, b, eps = 0.03) => !separated(B.quad(a, eps), B.quad(b, eps));

  // The part under a point (smallest wins, so side parts can be picked over a tank).
  // tol widens every part by that many metres, for fingers and thin parts.
  B.partAt = (parts, pt, tol = 0) => {
    let best = null, bestA = Infinity;
    for (const p of parts) {
      const rel = V.sub(pt, p.pos);
      const lx = V.dot(rel, right(p.rot)), ly = V.dot(rel, FS.partAxis(p.rot));
      const hl = p.len / 2;
      if (Math.abs(ly) > hl + tol) continue;
      let hw = halfAt(p, ly);
      if (p.def.fin && !p.def.radial) hw += 0.75;
      if (Math.abs(lx) > hw + tol) continue;
      const area = p.len * Math.max(p.w, p.tw);
      if (area < bestA) { best = p; bestA = area; }
    }
    return best;
  };

  // Lay out the held parts around their root, as a free-floating group at pos, turned to
  // the root's spin (the angle the player gave it with Q / E).
  B.placeHeld = (held, root, pos) => {
    root.parent = null;
    root.pos = { ...pos };
    root.rot = root.spin || 0;
    FS.relayout(held);
  };

  // The angle a held part takes on the side of p: its spin relative to p. A side-only part
  // on the left side is mirrored, so a fin tilted on the right tilts the mirror way on the left.
  const sideRot = (p, root, sd) => p.rot + (root.def.radial && sd < 0 ? -1 : 1) * (root.spin || 0);

  // The spot on side sd (+1 right, -1 left) of part p, at height ly along it, for the held
  // root turned to rot: its inner edge touches p's surface. Returns { pos, rot, ly }.
  B.surfaceSpot = (p, root, sd, ly, rot) => {
    const hlP = p.len / 2;
    const rr = rot - p.rot;
    const hl = root.len / 2, hw = root.w / 2, ht = root.tw / 2;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of [{ x: -ht, y: hl }, { x: ht, y: hl }, { x: hw, y: -hl }, { x: -hw, y: -hl }]) {
      const q = FS.rotV(c, rr);
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    }
    ly = FS.clamp(ly, -hlP, hlP);
    const span = [FS.clamp(ly + minY, -hlP, hlP), FS.clamp(ly + maxY, -hlP, hlP)];
    const hwP = Math.max(halfAt(p, span[0]), halfAt(p, span[1]));
    const off = sd * (hwP + (sd > 0 ? -minX : maxX));
    return { pos: V.add(p.pos, FS.rotV({ x: off, y: ly }, p.rot)), rot, ly, want: Math.abs(off) };
  };

  // Where the held group would attach if let go with its root's centre at freePos.
  // snap is the snapping distance in metres. Stack nodes within reach win over sides.
  // Among the spots in reach, the nearest free one is chosen; if every one is blocked,
  // the nearest is returned anyway so the editor can show it in red. With mirror on,
  // a spot only counts as free if the mirror twin fits too.
  // Returns null when there is nothing to attach to, or
  // { kind: 'root' | 'bottom' | 'top' | 'srf', parent, side, pos, rot, dist, node }.
  B.candidate = (placed, held, root, freePos, snap, mirror = false) => {
    if (!placed.length) return { kind: 'root', parent: null, pos: { ...freePos }, rot: root.spin || 0, dist: 0 };
    const pick = (list) => {
      if (!list.length) return null;
      list.sort((a, b) => a.dist - b.dist);
      return list.find((c) => !B.blocker(placed, held, root, c, mirror)) || list[0];
    };
    const hk = FS.childrenOf(held);
    const d = root.def, hl = root.len / 2;
    // stack nodes: the held root's top node meets a free bottom node, or the other way round
    const stack = [];
    const axH = FS.partAxis(root.spin || 0);
    for (const n of B.freeNodes(placed)) {
      const mine = n.node === 'bottom' ? 'top' : 'bottom';
      if (!B.nodeFree(held, root, mine, hk)) continue;
      const myPos = V.add(freePos, V.scale(axH, (mine === 'top' ? 1 : -1) * hl));
      const dist = V.len(V.sub(myPos, n.pos));
      if (dist > snap) continue;
      const ax = FS.partAxis(n.part.rot);
      const pos = V.add(n.part.pos, V.scale(ax, (n.node === 'top' ? 1 : -1) * (n.part.len / 2 + hl)));
      stack.push({ kind: n.node, parent: n.part, pos, rot: n.part.rot, dist, node: n });
    }
    const s = pick(stack);
    if (s || !B.canSurface(d)) return s;
    // surface attach: on the left or right side of a part, next to the pointer
    const side = [];
    for (const p of placed) {
      if (!B.takesSurface(p.def)) continue;
      const rel = V.sub(freePos, p.pos);
      const lx = V.dot(rel, right(p.rot));
      let ly = V.dot(rel, FS.partAxis(p.rot));
      const hlP = p.len / 2;
      if (Math.abs(ly) > hlP + snap * 0.5) continue;
      if (Math.abs(ly) < snap * 0.35) ly = 0; // snap to the middle of the side
      else ly = Math.round(ly * 20) / 20;
      const sd = lx < 0 ? -1 : 1;
      const spot = B.surfaceSpot(p, root, sd, ly, sideRot(p, root, sd));
      const dist = Math.abs(Math.abs(lx) - spot.want);
      if (dist > Math.max(root.w, root.tw) / 2 + snap) continue;
      side.push({ kind: 'srf', parent: p, side: sd, pos: spot.pos, rot: spot.rot, dist });
    }
    return pick(side);
  };

  // Attach the held group as described by cand (from B.candidate). Returns the merged part list.
  B.attach = (placed, held, root, cand) => {
    root.parent = cand.parent;
    root.node = cand.kind === 'root' ? 'bottom' : cand.kind;
    root.rot = cand.rot;
    root.pos = { ...cand.pos };
    if (cand.kind === 'srf') {
      if (root.def.radial) root.flip = cand.side < 0;
      FS.syncOffsets([root]);
    } else { delete root.srfOff; delete root.rel; }
    const all = placed.concat(held);
    FS.relayout(all);
    return all;
  };

  // ---------- Mirror symmetry ----------
  // A mirror is a line { m (a point), a (unit direction), twinParent }. A part attached
  // to a part that has a twin gets its own twin on the twin, mirrored across the line
  // halfway between them; a part on the side of a part without a twin is mirrored across
  // that part's axis, onto its other side. Stack parts on an unmirrored part have no twin.
  B.twinOf = (parts, p) => (p && p.sym ? parts.find((q) => q !== p && q.sym === p.sym) || null : null);

  B.mirrorFor = (placed, parent, kind) => {
    if (!parent) return null;
    const pt = B.twinOf(placed, parent);
    if (pt) {
      const d = V.norm(V.sub(pt.pos, parent.pos));
      return { m: V.scale(V.add(parent.pos, pt.pos), 0.5), a: V.perp(d), twinParent: pt };
    }
    if (kind === 'srf') return { m: { ...parent.pos }, a: FS.partAxis(parent.rot), twinParent: parent };
    return null;
  };
  B.reflect = (line, v) => {
    const r = V.sub(v, line.m);
    return V.add(line.m, V.sub(V.scale(line.a, 2 * V.dot(r, line.a)), r));
  };
  B.reflectRot = (line, rot) => FS.wrapAngle(2 * Math.atan2(-line.a.x, line.a.y) - rot);

  // Copies of parts (a group whose first part is its root), with mirror links renumbered.
  let symSeq = 1;
  B.newSym = () => 's' + Date.now().toString(36) + (symSeq++);
  B.clone = (group) => {
    const out = FS.partsFromSerial(FS.serialParts(group));
    const map = {};
    for (const p of out) if (p.sym) p.sym = map[p.sym] || (map[p.sym] = B.newSym());
    return out;
  };

  // The mirror twin of a held group that has just been attached (B.attach) as kind.
  B.makeTwin = (held, line, kind) => {
    const twin = B.clone(held);
    twin.forEach((t, i) => {
      const h = held[i];
      t.pos = B.reflect(line, h.pos);
      t.rot = B.reflectRot(line, h.rot);
      t.flip = !h.flip;
      t.node = h.node;
    });
    twin[0].parent = line.twinParent;
    twin[0].node = kind;
    FS.syncOffsets(twin);
    return twin;
  };

  // Link a group and its twin part for part, so they move, turn and go together.
  B.linkTwins = (a, b) => a.forEach((p, i) => { p.sym = b[i].sym = B.newSym(); });

  // Which placed part the held group (and its mirror twin, with mirror on) would overlap
  // if attached as cand, or null. Leaves the held parts where cand puts them.
  B.blocker = (placed, held, root, cand, mirror = false) => {
    B.attach(placed, held, root, cand);
    const line = mirror ? B.mirrorFor(placed, cand.parent, cand.kind) : null;
    let twin = [];
    if (line) {
      twin = B.makeTwin(held, line, cand.kind);
      FS.relayout(placed.concat(held, twin));
    }
    let hit = null;
    const groups = [[held, root, cand.parent], [twin, twin[0], line && line.twinParent]];
    for (const [grp, r, par] of groups) {
      for (const h of grp) {
        for (const p of placed) {
          if (h === r && p === par) continue;
          if (B.overlap(h, p)) { hit = p; break; }
        }
        if (!hit && line) for (const t of grp === held ? twin : []) if (B.overlap(h, t)) { hit = h; break; }
        if (hit) break;
      }
      if (hit) break;
    }
    B.detach(placed, held, root);
    return hit;
  };

  // Undo B.attach, leaving the held group where it was attached (so a snapped ghost stays put).
  B.detach = (placed, held, root) => {
    root.parent = null;
    FS.relayout(placed);
    FS.relayout(held);
  };

  // Put a part's mirror twin back in mirror position after the part moved or turned.
  B.syncTwin = (parts, p) => {
    const t = B.twinOf(parts, p);
    if (!t || !p.parent || !t.parent) return;
    const line = p.parent === t.parent
      ? { m: { ...p.parent.pos }, a: FS.partAxis(p.parent.rot) }
      : B.mirrorFor(parts, p.parent, p.node);
    if (!line) return;
    t.pos = B.reflect(line, p.pos);
    t.rot = B.reflectRot(line, p.rot);
    t.flip = !p.flip;
    FS.syncOffsets([t]);
    FS.relayout(parts);
  };

  // Whether part p (with everything below it) overlaps any other part, apart from its parent.
  B.collides = (parts, p) => {
    const mine = new Set(FS.subtree(parts, p));
    for (const h of mine) for (const q of parts) {
      if (mine.has(q) || (h === p && q === p.parent)) continue;
      if (B.overlap(h, q)) return q;
    }
    return null;
  };

  // Re-place a side part at height ly on its parent, turned to rot (absolute), keeping
  // its inner edge on the surface. Its twin follows. Refused (returns the part in the
  // way) if anything would overlap; then nothing changes.
  B.moveOnSurface = (parts, p, ly, rot) => {
    if (p.node !== 'srf' || !p.parent) return null;
    const saved = parts.map((q) => ({ q, pos: { ...q.pos }, rot: q.rot, flip: q.flip, srfOff: q.srfOff && { ...q.srfOff }, rel: q.rel }));
    const sd = p.srfOff && p.srfOff.x < 0 ? -1 : 1;
    const spot = B.surfaceSpot(p.parent, p, sd, ly, rot);
    p.pos = spot.pos; p.rot = spot.rot;
    FS.syncOffsets([p]);
    FS.relayout(parts);
    B.syncTwin(parts, p);
    const t = B.twinOf(parts, p);
    const hit = B.collides(parts, p) || (t && B.collides(parts, t));
    if (hit) {
      for (const s of saved) Object.assign(s.q, { pos: s.pos, rot: s.rot, flip: s.flip, srfOff: s.srfOff, rel: s.rel });
      FS.relayout(parts);
    }
    return hit;
  };

  // A side part's height along its parent (its offset in the parent's frame).
  B.surfaceHeight = (p) => (p.srfOff ? p.srfOff.y : 0);

  // Make part x the root: every link on the path from x up to the old root is reversed.
  B.reroot = (parts, x) => {
    const path = [];
    for (let c = x; c.parent; c = c.parent) path.push({ c, p: c.parent, node: c.node });
    for (const { c, p, node } of path) {
      p.parent = c;
      p.node = node === 'bottom' ? 'top' : node === 'top' ? 'bottom' : 'srf';
      if (p.node === 'srf') FS.syncOffsets([p]); else { delete p.srfOff; delete p.rel; }
    }
    x.parent = null;
    x.node = 'bottom';
    delete x.srfOff;
    delete x.rel;
    // keep the new root first, so saved craft list it first
    const i = parts.indexOf(x);
    if (i > 0) { parts.splice(i, 1); parts.unshift(x); }
    FS.relayout(parts);
    return parts;
  };
})();
