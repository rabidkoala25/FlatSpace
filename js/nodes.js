// nodes.js — maneuver nodes: placing them on any part of the predicted path, editing them,
// tracking the burn, and keeping them when the craft changes sphere of influence.
(function () {
  const V = FS.vec;
  const G = FS.game;

  // Seconds of burning needed for dv m/s with the current stage's engines.
  G.burnTime = (dv) => {
    const ves = G.vessel;
    if (!ves) return Infinity;
    let F = 0, mdot = 0;
    for (const q of ves.activeEngines()) {
      const th = FS.partThrust(q, FS.pressure(ves.body, ves.altitude), 1);
      F += th.F; mdot += th.mdot;
    }
    if (F <= 0) return Infinity;
    const ve = F / mdot;
    return ((ves.mass * ve) / F) * (1 - Math.exp(-dv / ve));
  };

  // Which predicted patch the path is on at time t, or null if the path doesn't reach t.
  G.patchAt = (t) => {
    const ps = G.patches;
    if (!ps) return null;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const start = i === 0 ? -Infinity : p.tStart;
      if (t >= start && t <= p.tEnd) return { patch: p, index: i };
    }
    return null;
  };

  G.createNode = (tNode) => {
    const keep = G.node && V.len(G.node.applied) < 0.01 ? { pro: G.node.pro, rad: G.node.rad } : { pro: 0, rad: 0 };
    G.node = { t: tNode, pro: keep.pro, rad: keep.rad, applied: { x: 0, y: 0 } };
    if (!G.refreshNode(true)) { G.node = null; return null; }
    return G.node;
  };

  G.deleteNode = () => {
    G.node = null;
    G.nodePatches = null;
    if (G.vessel && G.vessel.sasMode === 'maneuver') G.vessel.sasMode = 'stability';
  };

  // Recompute the node's position, burn direction and the planned path after it.
  // Returns false if the predicted path no longer reaches the node.
  G.refreshNode = (full) => {
    const nd = G.node;
    if (!nd) return false;
    const hit = G.patchAt(nd.t);
    if (!hit) return false;
    const st = FS.orbitState(hit.patch.orbit, nd.t);
    nd.body = hit.patch.body;
    nd.patchIndex = hit.index;
    // later patches are drawn around where their body is when the patch starts
    nd.originT = hit.index === 0 ? null : hit.patch.tStart;
    nd.r = st.r;
    const prog = V.norm(st.v);
    const rhat = V.norm(st.r);
    let radOut = V.sub(rhat, V.scale(prog, V.dot(rhat, prog)));
    radOut = V.len(radOut) > 1e-9 ? V.norm(radOut) : V.perp(prog);
    if (V.len(nd.applied) < 0.01 || full) nd.dvVec = V.add(V.scale(prog, nd.pro), V.scale(radOut, nd.rad));
    nd.remaining = V.sub(nd.dvVec, nd.applied);
    G.nodePatches = FS.predictPatches(nd.body, st.r, V.add(st.v, nd.remaining), nd.t, 3);
    return true;
  };

  // Change the node: k is 'pro', 'rad' (m/s) or 't' (seconds).
  G.editNode = (k, d) => {
    const nd = G.node;
    if (!nd) return;
    const before = { t: nd.t, pro: nd.pro, rad: nd.rad };
    if (k === 't') {
      const last = G.patches && G.patches[G.patches.length - 1];
      const tMax = last && isFinite(last.tEnd) ? last.tEnd - 1 : Infinity;
      nd.t = FS.clamp(nd.t + d, G.t + 1, tMax);
    } else {
      nd[k] += d;
    }
    nd.applied = { x: 0, y: 0 };
    nd.warned = false;
    if (!G.refreshNode(true)) { Object.assign(nd, before); G.refreshNode(true); }
  };

  G.warpToNode = () => {
    if (!G.node) return;
    const bt = G.burnTime(Math.hypot(G.node.pro, G.node.rad));
    if (!G.warpTo(G.node.t - (isFinite(bt) ? bt / 2 : 0) - 15)) G.message('Node is too close to warp to.', '', 1800);
  };

  // Count thrust towards the node's burn. Only while the node is on the current patch,
  // so a correction burn on the way doesn't use up a node planned for later.
  G.trackNodeBurn = (h) => {
    const nd = G.node, ves = G.vessel;
    if (nd && nd.patchIndex === 0 && ves.thrustNow > 0) nd.applied = V.add(nd.applied, V.scale(ves.thrustAccel, h));
  };

  G.updateNode = () => {
    const nd = G.node, ves = G.vessel;
    if (!nd) return;
    // Stop time warp shortly before the burn
    if (G.warpIdx > 0 && !nd.warned && nd.patchIndex === 0) {
      const bt = G.burnTime(V.len(nd.remaining || { x: nd.pro, y: nd.rad }));
      const start = nd.t - (isFinite(bt) ? bt / 2 : 0);
      if (G.t >= start - 10) { G.stopWarp(); nd.warned = true; G.message('Maneuver burn coming up.', '', 2500); }
    }
    // Burn progress
    nd.remaining = V.sub(nd.dvVec, nd.applied);
    const started = V.len(nd.applied) > 0.05;
    if (started && (V.len(nd.remaining) < 0.15 || V.dot(nd.remaining, nd.dvVec) < 0)) {
      ves.throttle = 0;
      G.deleteNode();
      G.message('Burn complete. Throttle cut.', '', 2500);
    }
  };

  // After an SOI change the predicted path is rebuilt; the node stays if the new path still reaches it.
  G.on('soi', ({ vessel }) => {
    if (vessel !== G.vessel || !G.node || vessel.landed) return;
    G.patches = FS.predictPatches(vessel.body, vessel.r, vessel.v, G.t, 3);
    if (!G.refreshNode(false)) {
      G.deleteNode();
      G.message('Maneuver node removed: your new path no longer reaches it.', '', 3000);
    }
  });
})();
