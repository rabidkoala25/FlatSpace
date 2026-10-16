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

  B.nodePos = (p, node) => V.add(p.pos, V.scale(FS.partAxis(p.rot), (node === 'top' ? 1 : -1) * p.def.len / 2));

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
    const t = FS.clamp((ly + p.def.len / 2) / p.def.len, 0, 1);
    return FS.lerp(p.w, p.tw, t) / 2;
  };

  // The outline of a part as four corners in the craft frame, shrunk by eps so parts
  // that merely touch don't count as overlapping.
  B.quad = (p, eps = 0) => {
    const hl = Math.max(0.01, p.def.len / 2 - eps), hw = Math.max(0.01, p.w / 2 - eps), ht = Math.max(0.01, p.tw / 2 - eps);
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
      const hl = p.def.len / 2;
      if (Math.abs(ly) > hl + tol) continue;
      let hw = halfAt(p, ly);
      if (p.def.fin) hw += 0.75;
      if (Math.abs(lx) > hw + tol) continue;
      const area = p.def.len * Math.max(p.w, p.tw);
      if (area < bestA) { best = p; bestA = area; }
    }
    return best;
  };

  // Lay out the held parts around their root, as a free-floating group at pos.
  B.placeHeld = (held, root, pos) => {
    root.parent = null;
    root.pos = { ...pos };
    FS.relayout(held);
  };

  // Where the held group would attach if let go with its root's centre at freePos.
  // snap is the snapping distance in metres. Stack nodes within reach win over sides.
  // Among the spots in reach, the nearest free one is chosen; if every one is blocked,
  // the nearest is returned anyway so the editor can show it in red.
  // Returns null when there is nothing to attach to, or
  // { kind: 'root' | 'bottom' | 'top' | 'srf', parent, side, pos, rot, dist, node }.
  B.candidate = (placed, held, root, freePos, snap) => {
    if (!placed.length) return { kind: 'root', parent: null, pos: { ...freePos }, rot: root.rot, dist: 0 };
    const pick = (list) => {
      if (!list.length) return null;
      list.sort((a, b) => a.dist - b.dist);
      return list.find((c) => !B.blocker(placed, held, root, c)) || list[0];
    };
    const hk = FS.childrenOf(held);
    const d = root.def, hl = d.len / 2;
    // stack nodes: the held root's top node meets a free bottom node, or the other way round
    const stack = [];
    const axH = FS.partAxis(root.rot);
    for (const n of B.freeNodes(placed)) {
      const mine = n.node === 'bottom' ? 'top' : 'bottom';
      if (!B.nodeFree(held, root, mine, hk)) continue;
      const myPos = V.add(freePos, V.scale(axH, (mine === 'top' ? 1 : -1) * hl));
      const dist = V.len(V.sub(myPos, n.pos));
      if (dist > snap) continue;
      const ax = FS.partAxis(n.part.rot);
      const pos = V.add(n.part.pos, V.scale(ax, (n.node === 'top' ? 1 : -1) * (n.part.def.len / 2 + hl)));
      stack.push({ kind: n.node, parent: n.part, pos, rot: n.part.rot, dist, node: n });
    }
    const s = pick(stack);
    if (s || !B.canSurface(d)) return s;
    // surface attach: on the left or right side of a part, next to the pointer
    const side = [];
    const hwH = Math.max(root.w, root.tw) / 2;
    for (const p of placed) {
      if (!B.takesSurface(p.def)) continue;
      const rel = V.sub(freePos, p.pos);
      const rx = right(p.rot), ax = FS.partAxis(p.rot);
      const lx = V.dot(rel, rx);
      let ly = V.dot(rel, ax);
      const hlP = p.def.len / 2;
      if (Math.abs(ly) > hlP + snap * 0.5) continue;
      ly = FS.clamp(ly, -hlP, hlP);
      if (Math.abs(ly) < snap * 0.35) ly = 0; // snap to the middle of the side
      else ly = Math.round(ly * 20) / 20;
      const span = [FS.clamp(ly - hl, -hlP, hlP), FS.clamp(ly + hl, -hlP, hlP)];
      const hwP = Math.max(halfAt(p, span[0]), halfAt(p, span[1]));
      const sd = lx < 0 ? -1 : 1;
      const want = hwP + hwH;
      const dist = Math.abs(Math.abs(lx) - want);
      if (dist > hwH + snap) continue;
      const pos = V.add(p.pos, V.add(V.scale(rx, sd * want), V.scale(ax, ly)));
      side.push({ kind: 'srf', parent: p, side: sd, pos, rot: p.rot, dist });
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
      root.srfOff = V.sub(cand.pos, cand.parent.pos);
      if (root.def.radial) root.flip = cand.side < 0;
    } else delete root.srfOff;
    const all = placed.concat(held);
    FS.relayout(all);
    return all;
  };

  // Which placed part the held group would overlap if attached as cand, or null.
  // Leaves the held parts where cand puts them.
  B.blocker = (placed, held, root, cand) => {
    B.attach(placed, held, root, cand);
    let hit = null;
    for (const h of held) {
      for (const p of placed) {
        if (h === root && p === cand.parent) continue;
        if (B.overlap(h, p)) { hit = p; break; }
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

  // Make part x the root: every link on the path from x up to the old root is reversed.
  B.reroot = (parts, x) => {
    const path = [];
    for (let c = x; c.parent; c = c.parent) path.push({ c, p: c.parent, node: c.node });
    for (const { c, p, node } of path) {
      p.parent = c;
      p.node = node === 'bottom' ? 'top' : node === 'top' ? 'bottom' : 'srf';
      if (p.node === 'srf') p.srfOff = V.sub(p.pos, c.pos); else delete p.srfOff;
    }
    x.parent = null;
    x.node = 'bottom';
    delete x.srfOff;
    // keep the new root first, so saved craft list it first
    const i = parts.indexOf(x);
    if (i > 0) { parts.splice(i, 1); parts.unshift(x); }
    FS.relayout(parts);
    return parts;
  };
})();
