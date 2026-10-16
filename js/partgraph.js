// partgraph.js — the part tree.
// A craft is a list of parts. Every part except the root hangs from a parent at an attach
// node: 'bottom' (below the parent), 'top' (above it) or 'srf' (on its side).
// Positions use the craft frame: metres, +y towards the nose, +x to the right of it.
// rot is counter-clockwise in radians (0 = upright); flip mirrors a part left-right.
//
// Saved craft store parts as { id, parent (index or -1), node, x, y, rot, flip }.
(function () {
  const V = FS.vec;
  const r3 = (x) => Math.round(x * 1000) / 1000;

  // ---------- Making parts ----------
  let uid = 1;
  FS.newPart = (id) => {
    const d = FS.PART[id];
    if (!d) return null;
    return {
      uid: uid++, def: d, parent: null, node: 'bottom',
      pos: { x: 0, y: 0 }, rot: 0, flip: false,
      fuel: d.fuel || 0, solid: d.solid || 0, lit: false, chute: d.chute ? 'stowed' : null,
    };
  };

  // A straight stack of part ids (top to bottom): each part hangs below the one above.
  FS.stackToParts = (ids) => {
    const parts = [];
    for (const id of ids) {
      const p = FS.newPart(id);
      if (!p) continue;
      if (parts.length) p.parent = parts[parts.length - 1];
      parts.push(p);
    }
    FS.relayout(parts);
    return parts;
  };

  // Attach a new part to the side of a parent at craft-frame position pos (tests and editor).
  FS.attachPart = (parts, id, parent, pos, rot = 0, flip = false) => {
    const p = FS.newPart(id);
    if (!p) return null;
    Object.assign(p, { parent, node: 'srf', pos: { ...pos }, rot, flip });
    p.srfOff = V.sub(p.pos, parent.pos);
    parts.push(p);
    FS.relayout(parts);
    return p;
  };

  FS.serialParts = (parts) => {
    const idx = new Map(parts.map((p, i) => [p, i]));
    return parts.map((p) => {
      const s = { id: p.def.id, parent: p.parent && idx.has(p.parent) ? idx.get(p.parent) : -1, node: p.node, x: r3(p.pos.x), y: r3(p.pos.y) };
      if (p.rot) s.rot = r3(p.rot);
      if (p.flip) s.flip = true;
      return s;
    });
  };

  FS.partsFromSerial = (list) => {
    const parts = list.map((s) => {
      const p = FS.newPart(s.id);
      if (p) Object.assign(p, { pos: { x: s.x || 0, y: s.y || 0 }, rot: s.rot || 0, flip: !!s.flip, node: s.node || 'bottom' });
      return p;
    });
    list.forEach((s, i) => { if (parts[i] && s.parent >= 0 && parts[s.parent]) parts[i].parent = parts[s.parent]; });
    const out = parts.filter(Boolean);
    for (const p of out) if (p.node === 'srf' && p.parent) p.srfOff = V.sub(p.pos, p.parent.pos);
    FS.relayout(out);
    return out;
  };

  // Accept part ids (a stack), saved parts, or live part objects.
  FS.toParts = (source) => {
    if (!source || !source.length) return [];
    if (typeof source[0] === 'string') return FS.stackToParts(source);
    if (source[0].def) {
      const set = new Set(source);
      for (const p of source) if (p.parent && !set.has(p.parent)) p.parent = null;
      return source;
    }
    return FS.partsFromSerial(source);
  };

  // ---------- Tree helpers ----------
  FS.childrenOf = (parts) => {
    const m = new Map(parts.map((p) => [p, []]));
    for (const p of parts) if (p.parent && m.has(p.parent)) m.get(p.parent).push(p);
    return m;
  };
  FS.rootOf = (parts) => {
    const set = new Set(parts);
    return parts.find((p) => !p.parent || !set.has(p.parent)) || null;
  };
  FS.subtree = (parts, top) => {
    const kids = FS.childrenOf(parts);
    const out = [];
    const walk = (p) => { out.push(p); for (const c of kids.get(p) || []) walk(c); };
    walk(top);
    return out;
  };
  FS.partAxis = (rot) => ({ x: -Math.sin(rot), y: Math.cos(rot) });

  // Recompute widths of auto-sized parts and the positions of stack-attached parts.
  // Side-attached parts keep their offset from their parent.
  FS.relayout = (parts) => {
    const kids = FS.childrenOf(parts);
    const set = new Set(parts);
    for (const p of parts) if (p.def.w !== 'auto') p.w = p.def.w;
    for (const p of parts) {
      if (p.def.w !== 'auto') continue;
      const widths = [];
      if (p.parent && set.has(p.parent) && p.node !== 'srf' && p.parent.def.w !== 'auto') widths.push(p.parent.def.w);
      for (const c of kids.get(p)) if (c.node !== 'srf' && c.def.w !== 'auto') widths.push(c.def.topW || c.def.w);
      p.w = Math.max(0.625, ...widths);
    }
    for (const p of parts) p.tw = p.def.topW || p.w;

    const place = (p) => {
      for (const c of kids.get(p)) {
        if (c.node === 'srf') {
          if (!c.srfOff) c.srfOff = V.sub(c.pos, p.pos);
          c.pos = V.add(p.pos, c.srfOff);
        } else {
          const d = (c.node === 'top' ? 1 : -1) * (p.def.len / 2 + c.def.len / 2);
          c.rot = p.rot;
          c.pos = V.add(p.pos, V.scale(FS.partAxis(p.rot), d));
        }
        place(c);
      }
    };
    for (const p of parts) if (!p.parent || !set.has(p.parent)) place(p);
    return parts;
  };

  // The outline of a part in its own frame (centre at 0,0, +y up), before rotation.
  FS.partHull = (p) => {
    const d = p.def, hl = d.len / 2, hw = p.w / 2, ht = p.tw / 2;
    const pts = [{ x: -ht, y: hl }, { x: ht, y: hl }, { x: hw, y: -hl }, { x: -hw, y: -hl }];
    if (d.fin) pts.push({ x: hw + 0.75, y: -hl - 0.15 }, { x: -hw - 0.75, y: -hl - 0.15 });
    return pts;
  };

  // Mass, centre of mass, moment of inertia and bounds. Also sets, on every part,
  // c (centre relative to the centre of mass), axis (its +y direction) and hullC (outline
  // points relative to the centre of mass), all in the craft frame.
  FS.massLayout = (parts) => {
    let mass = 0, mx = 0, my = 0;
    for (const p of parts) {
      const m = FS.partMass(p);
      mass += m; mx += m * p.pos.x; my += m * p.pos.y;
    }
    const com = mass > 0 ? { x: mx / mass, y: my / mass } : { x: 0, y: 0 };
    let I = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of parts) {
      const m = FS.partMass(p);
      p.c = V.sub(p.pos, com);
      p.axis = FS.partAxis(p.rot);
      I += m * (V.dot(p.c, p.c) + (p.def.len * p.def.len + p.w * p.w) / 12);
      const cs = Math.cos(p.rot), sn = Math.sin(p.rot);
      p.hullC = FS.partHull(p).map((h) => {
        const x = p.flip ? -h.x : h.x;
        return { x: p.c.x + x * cs - h.y * sn, y: p.c.y + x * sn + h.y * cs };
      });
      for (const h of p.hullC) {
        minX = Math.min(minX, h.x); maxX = Math.max(maxX, h.x);
        minY = Math.min(minY, h.y); maxY = Math.max(maxY, h.y);
      }
    }
    if (!parts.length) minX = maxX = minY = maxY = 0;
    return { mass, com, I: Math.max(I, 1), minX, maxX, minY, maxY, height: maxY - minY, width: maxX - minX };
  };

  // ---------- Fuel flow ----------
  // Groups of parts that share fuel: the tree cut wherever a decoupler meets its parent.
  // (A decoupler belongs to the side that falls away with it.)
  FS.flowGroups = (parts) => {
    const idx = new Map(parts.map((p, i) => [p, i]));
    const up = parts.map((_, i) => i);
    const find = (i) => (up[i] === i ? i : (up[i] = find(up[i])));
    for (const p of parts) {
      if (p.parent && idx.has(p.parent) && !p.def.decoupler) up[find(idx.get(p))] = find(idx.get(p.parent));
    }
    const groups = new Map();
    parts.forEach((p, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(p);
    });
    return [...groups.values()];
  };

  // ---------- Staging ----------
  // Default stage list, KSP-style. Groups are numbered by how many decouplers separate
  // them from the root. The deepest groups light first; side boosters (on radial
  // decouplers) light together with the group they hang from, and drop first.
  // Each event: { decouple, ignite, chutes, decouplers, engines, chuteParts, parts }.
  FS.stagesOf = (parts) => {
    const groups = FS.flowGroups(parts);
    const gOf = new Map();
    groups.forEach((g, i) => g.forEach((p) => gOf.set(p, i)));
    const info = groups.map((g, i) => {
      const dec = g.find((p) => p.def.decoupler && p.parent && gOf.has(p.parent) && gOf.get(p.parent) !== i) || null;
      return { parts: g, dec, parent: dec ? gOf.get(dec.parent) : -1, engines: g.filter((p) => p.def.engine) };
    });
    const depth = (i) => (info[i].parent < 0 ? 0 : 1 + depth(info[i].parent));
    info.forEach((g, i) => (g.depth = depth(i)));
    const ignition = (i) => {
      let d = info[i].depth;
      info.forEach((c, j) => {
        if (c.parent === i && c.dec.def.radial && c.engines.length) d = Math.max(d, ignition(j));
      });
      return d;
    };
    info.forEach((g, i) => (g.ignition = g.engines.length ? ignition(i) : -1));
    const D = Math.max(0, ...info.map((g) => g.depth));
    const events = [];
    for (let d = D; d >= 0; d--) {
      const decouplers = info.filter((g) => g.depth === d + 1 && g.dec).map((g) => g.dec);
      const engines = info.filter((g) => g.ignition === d).flatMap((g) => g.engines);
      if (decouplers.length || engines.length) {
        events.push({ decouple: decouplers.length > 0, ignite: engines.length > 0, chutes: false, decouplers, engines, chuteParts: [], parts: [...decouplers, ...engines] });
      }
    }
    const chuteParts = parts.filter((p) => p.def.chute);
    if (chuteParts.length) events.push({ decouple: false, ignite: false, chutes: true, decouplers: [], engines: [], chuteParts, parts: chuteParts });
    return events;
  };

  // ---------- Δv per stage ----------
  // Simulates the stage list from stages[startIdx] on, without changing the parts.
  // Each stage burns its lit engines until the parts the next stage drops run dry
  // (or until everything lit is dry, if the next stage drops nothing with fuel).
  // Returns { current, events, total }: current is what is burning now, before the next
  // stage; events[k] is stage startIdx + k. Each has { dv, time, thrust, mass, twr }.
  FS.stageStats = (parts, stages, startIdx, pressure, g) => {
    const st = new Map(parts.map((q) => [q, { fuel: q.fuel, solid: q.solid }]));
    let attached = parts.slice();
    const lit = new Set(parts.filter((q) => q.lit && q.def.engine));
    const massNow = () => attached.reduce((s, q) => s + q.def.mass + st.get(q).fuel + st.get(q).solid, 0);
    const dropOf = (ev) => {
      if (!ev || !ev.decouple) return null;
      const set = new Set();
      for (const d of ev.decouplers) if (attached.includes(d)) FS.subtree(attached, d).forEach((q) => set.add(q));
      return set.size ? set : null;
    };

    function burn(dropSet) {
      const m0 = massNow();
      let m = m0, dv = 0, time = 0, F0 = null;
      const groups = FS.flowGroups(attached);
      if (dropSet && ![...dropSet].some((q) => st.get(q).fuel + st.get(q).solid > 1e-6)) dropSet = null;
      for (let guard = 0; guard < 40; guard++) {
        const active = [];
        for (const gr of groups) {
          const liq = gr.filter((q) => lit.has(q) && !q.def.engine.solid);
          const tanks = gr.filter((q) => q.def.fuel);
          const fuel = tanks.reduce((s, q) => s + st.get(q).fuel, 0);
          if (liq.length && fuel > 1e-6) {
            let md = 0, f = 0;
            for (const q of liq) { const t = FS.engineThrust(q.def.engine, pressure); md += t.mdot; f += t.F; }
            active.push({ md, f, fuel, tanks, members: gr });
          }
          for (const q of gr) {
            if (lit.has(q) && q.def.engine.solid && st.get(q).solid > 1e-6) {
              const t = FS.engineThrust(q.def.engine, pressure);
              active.push({ md: t.mdot, f: t.F, fuel: st.get(q).solid, solidPart: q, members: [q] });
            }
          }
        }
        if (F0 === null) F0 = active.reduce((s, a) => s + a.f, 0);
        if (!active.length) break;
        if (dropSet && !active.some((a) => a.members.some((q) => dropSet.has(q)))) break;
        const tmin = Math.min(...active.map((a) => a.fuel / a.md));
        const md = active.reduce((s, a) => s + a.md, 0);
        const F = active.reduce((s, a) => s + a.f, 0);
        const m1 = m - md * tmin;
        if (F > 0 && m1 > 0) dv += (F / md) * Math.log(m / m1);
        for (const a of active) {
          const used = a.md * tmin;
          if (a.solidPart) st.get(a.solidPart).solid = Math.max(0, st.get(a.solidPart).solid - used);
          else for (const tk of a.tanks) { const s = st.get(tk); s.fuel = Math.max(0, s.fuel - used * (s.fuel / a.fuel)); }
        }
        m = m1;
        time += tmin;
      }
      const thrust = F0 || 0;
      return { dv, time, thrust, mass: m0, twr: thrust / (m0 * g) };
    }

    const current = burn(dropOf(stages[startIdx]));
    const events = [];
    for (let k = startIdx; k < stages.length; k++) {
      const ev = stages[k];
      const drop = dropOf(ev);
      if (drop) attached = attached.filter((q) => !drop.has(q));
      if (ev.ignite) for (const e of ev.engines) if (attached.includes(e)) lit.add(e);
      events.push(burn(dropOf(stages[k + 1])));
    }
    return { current, events, total: current.dv + events.reduce((s, e) => s + e.dv, 0) };
  };
})();
