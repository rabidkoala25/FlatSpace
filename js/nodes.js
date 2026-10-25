// nodes.js — maneuver nodes: placing them on any part of the predicted path, editing them,
// tracking the burn, and keeping them when the craft changes sphere of influence.
(function () {
  const Vector = FS.vec;
  const game = FS.game;

  // Seconds of burning needed for dv m/s with the current stage's engines.
  game.burnTime = (deltaV) => {
    const vessel = game.vessel;
    if (!vessel) {
      return Infinity;
    }
    let totalThrust = 0;
    let massFlow = 0;
    for (const engine of vessel.activeEngines()) {
      const thrust = FS.partThrust(engine, FS.pressure(vessel.body, vessel.altitude), 1);
      totalThrust += thrust.F;
      massFlow += thrust.mdot;
    }
    if (totalThrust <= 0) {
      return Infinity;
    }
    const exhaustSpeed = totalThrust / massFlow;
    return ((vessel.mass * exhaustSpeed) / totalThrust) * (1 - Math.exp(-deltaV / exhaustSpeed));
  };

  // Which predicted patch the path is on at time t, or null if the path doesn't reach t.
  game.patchAt = (time) => {
    const patches = game.patches;
    if (!patches) {
      return null;
    }
    for (let patchIndex = 0; patchIndex < patches.length; patchIndex++) {
      const patch = patches[patchIndex];
      const start = patchIndex === 0 ? -Infinity : patch.tStart;
      if (time >= start && time <= patch.tEnd) {
        return { patch: patch, index: patchIndex };
      }
    }
    return null;
  };

  game.createNode = (tNode) => {
    const keep =
      game.node && Vector.len(game.node.applied) < 0.01
        ? { pro: game.node.pro, rad: game.node.rad }
        : { pro: 0, rad: 0 };
    game.node = { t: tNode, pro: keep.pro, rad: keep.rad, applied: { x: 0, y: 0 } };
    if (!game.refreshNode(true)) {
      game.node = null;
      return null;
    }
    return game.node;
  };

  game.deleteNode = () => {
    game.node = null;
    game.nodePatches = null;
    if (game.vessel && game.vessel.sasMode === 'maneuver') {
      game.vessel.sasMode = 'stability';
    }
  };

  // Recompute the node's position, burn direction and the planned path after it.
  // Returns false if the predicted path no longer reaches the node.
  game.refreshNode = (full) => {
    const node = game.node;
    if (!node) {
      return false;
    }
    const hit = game.patchAt(node.t);
    if (!hit) {
      return false;
    }
    const state = FS.orbitState(hit.patch.orbit, node.t);
    node.body = hit.patch.body;
    node.patchIndex = hit.index;
    // later patches are drawn around where their body is when the patch starts
    node.originT = hit.index === 0 ? null : hit.patch.tStart;
    node.r = state.r;
    const prog = Vector.norm(state.v);
    const rhat = Vector.norm(state.r);
    let radOut = Vector.sub(rhat, Vector.scale(prog, Vector.dot(rhat, prog)));
    radOut = Vector.len(radOut) > 1e-9 ? Vector.norm(radOut) : Vector.perp(prog);
    if (Vector.len(node.applied) < 0.01 || full) {
      node.dvVec = Vector.add(Vector.scale(prog, node.pro), Vector.scale(radOut, node.rad));
    }
    node.remaining = Vector.sub(node.dvVec, node.applied);
    game.nodePatches = FS.predictPatches(node.body, state.r, Vector.add(state.v, node.remaining), node.t, 3);
    return true;
  };

  // Change the node: k is 'pro', 'rad' (m/s) or 't' (seconds).
  game.editNode = (field, change) => {
    const node = game.node;
    if (!node) {
      return;
    }
    const before = { t: node.t, pro: node.pro, rad: node.rad };
    if (field === 't') {
      const last = game.patches && game.patches[game.patches.length - 1];
      const tMax = last && isFinite(last.tEnd) ? last.tEnd - 1 : Infinity;
      node.t = FS.clamp(node.t + change, game.t + 1, tMax);
    } else {
      node[field] += change;
    }
    node.applied = { x: 0, y: 0 };
    node.warned = false;
    if (!game.refreshNode(true)) {
      Object.assign(node, before);
      game.refreshNode(true);
    }
  };

  game.warpToNode = () => {
    if (!game.node) {
      return;
    }
    const burnSeconds = game.burnTime(Math.hypot(game.node.pro, game.node.rad));
    if (!game.warpTo(game.node.t - (isFinite(burnSeconds) ? burnSeconds / 2 : 0) - 15)) {
      game.message('Node is too close to warp to.', '', 1800);
    }
  };

  // Count thrust towards the node's burn. Only while the node is on the current patch,
  // so a correction burn on the way doesn't use up a node planned for later.
  game.trackNodeBurn = (timeStep) => {
    const node = game.node;
    const vessel = game.vessel;
    if (node && node.patchIndex === 0 && vessel.thrustNow > 0) {
      node.applied = Vector.add(node.applied, Vector.scale(vessel.thrustAccel, timeStep));
    }
  };

  game.updateNode = () => {
    const node = game.node;
    const vessel = game.vessel;
    if (!node) {
      return;
    }
    // Stop time warp shortly before the burn
    if (game.warpIdx > 0 && !node.warned && node.patchIndex === 0) {
      const burnSeconds = game.burnTime(Vector.len(node.remaining || { x: node.pro, y: node.rad }));
      const start = node.t - (isFinite(burnSeconds) ? burnSeconds / 2 : 0);
      if (game.t >= start - 10) {
        game.stopWarp();
        node.warned = true;
        game.message('Maneuver burn coming up.', '', 2500);
      }
    }
    // Burn progress
    node.remaining = Vector.sub(node.dvVec, node.applied);
    const started = Vector.len(node.applied) > 0.05;
    if (started && (Vector.len(node.remaining) < 0.15 || Vector.dot(node.remaining, node.dvVec) < 0)) {
      vessel.throttle = 0;
      game.deleteNode();
      game.message('Burn complete. Throttle cut.', '', 2500);
    }
  };

  // After an SOI change the predicted path is rebuilt; the node stays if the new path still reaches it.
  game.on('soi', ({ vessel }) => {
    if (vessel !== game.vessel || !game.node || vessel.landed) {
      return;
    }
    game.patches = FS.predictPatches(vessel.body, vessel.r, vessel.v, game.t, 3);
    if (!game.refreshNode(false)) {
      game.deleteNode();
      game.message('Maneuver node removed: your new path no longer reaches it.', '', 3000);
    }
  });
})();
