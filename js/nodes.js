// nodes.js — maneuver nodes: placing them on any part of the predicted path, editing them,
// tracking the burn, and keeping them when the craft changes sphere of influence.
(function () {
  const Vector = Flatspace.Vector;
  const game = Flatspace.game;

  // Seconds of burning needed for a Δv (m/s) with the current stage's engines.
  game.burnTime = (deltaV) => {
    const vessel = game.vessel;
    if (!vessel) {
      return Infinity;
    }
    let totalThrust = 0;
    let massFlow = 0;
    for (const engine of vessel.activeEngines()) {
      const thrust = Flatspace.partThrust(engine, Flatspace.pressure(vessel.body, vessel.altitude), 1);
      totalThrust += thrust.force;
      massFlow += thrust.massFlowRate;
    }
    if (totalThrust <= 0) {
      return Infinity;
    }
    const exhaustSpeed = totalThrust / massFlow;
    return ((vessel.mass * exhaustSpeed) / totalThrust) * (1 - Math.exp(-deltaV / exhaustSpeed));
  };

  // Which predicted patch the path is on at a given time, or null if the path doesn't reach it.
  game.patchAt = (time) => {
    const patches = game.patches;
    if (!patches) {
      return null;
    }
    for (let patchIndex = 0; patchIndex < patches.length; patchIndex++) {
      const patch = patches[patchIndex];
      const start = patchIndex === 0 ? -Infinity : patch.startTime;
      if (time >= start && time <= patch.endTime) {
        return { patch, index: patchIndex };
      }
    }
    return null;
  };

  game.createNode = (nodeTime) => {
    const keep =
      game.node && Vector.length(game.node.applied) < 0.01
        ? { prograde: game.node.prograde, radial: game.node.radial }
        : { prograde: 0, radial: 0 };
    game.node = { time: nodeTime, prograde: keep.prograde, radial: keep.radial, applied: { x: 0, y: 0 } };
    if (!game.refreshNode(true)) {
      game.node = null;
      return null;
    }
    return game.node;
  };

  game.deleteNode = () => {
    game.node = null;
    game.nodePatches = null;
    if (game.vessel && game.vessel.stabilityAssistMode === 'maneuver') {
      game.vessel.stabilityAssistMode = 'stability';
    }
  };

  // Recompute the node's position, burn direction and the planned path after it.
  // Returns false if the predicted path no longer reaches the node.
  game.refreshNode = (full) => {
    const node = game.node;
    if (!node) {
      return false;
    }
    const hit = game.patchAt(node.time);
    if (!hit) {
      return false;
    }
    const state = Flatspace.orbitState(hit.patch.orbit, node.time);
    node.body = hit.patch.body;
    node.patchIndex = hit.index;
    // later patches are drawn around where their body is when the patch starts
    node.originTime = hit.index === 0 ? null : hit.patch.startTime;
    node.position = state.position;
    const progradeDirection = Vector.normalise(state.velocity);
    const upDirection = Vector.normalise(state.position);
    let radialOutDirection = Vector.subtract(
      upDirection,
      Vector.scale(progradeDirection, Vector.dot(upDirection, progradeDirection)),
    );
    radialOutDirection =
      Vector.length(radialOutDirection) > 1e-9
        ? Vector.normalise(radialOutDirection)
        : Vector.perpendicular(progradeDirection);
    if (Vector.length(node.applied) < 0.01 || full) {
      node.burnVector = Vector.add(
        Vector.scale(progradeDirection, node.prograde),
        Vector.scale(radialOutDirection, node.radial),
      );
    }
    node.remaining = Vector.subtract(node.burnVector, node.applied);
    game.nodePatches = Flatspace.predictPatches(
      node.body,
      state.position,
      Vector.add(state.velocity, node.remaining),
      node.time,
      3,
    );
    return true;
  };

  // Change the node: field is 'prograde', 'radial' (m/s) or 'time' (seconds).
  game.editNode = (field, change) => {
    const node = game.node;
    if (!node) {
      return;
    }
    const before = { time: node.time, prograde: node.prograde, radial: node.radial };
    if (field === 'time') {
      const last = game.patches && game.patches[game.patches.length - 1];
      const latestTime = last && isFinite(last.endTime) ? last.endTime - 1 : Infinity;
      node.time = Flatspace.clamp(node.time + change, game.time + 1, latestTime);
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
    const burnSeconds = game.burnTime(Math.hypot(game.node.prograde, game.node.radial));
    if (!game.warpTo(game.node.time - (isFinite(burnSeconds) ? burnSeconds / 2 : 0) - 15)) {
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
    if (game.warpIndex > 0 && !node.warned && node.patchIndex === 0) {
      const burnSeconds = game.burnTime(
        Vector.length(node.remaining || { x: node.prograde, y: node.radial }),
      );
      const start = node.time - (isFinite(burnSeconds) ? burnSeconds / 2 : 0);
      if (game.time >= start - 10) {
        game.stopWarp();
        node.warned = true;
        game.message('Maneuver burn coming up.', '', 2500);
      }
    }
    // Burn progress
    node.remaining = Vector.subtract(node.burnVector, node.applied);
    const started = Vector.length(node.applied) > 0.05;
    if (
      started &&
      (Vector.length(node.remaining) < 0.15 || Vector.dot(node.remaining, node.burnVector) < 0)
    ) {
      vessel.throttle = 0;
      game.deleteNode();
      game.message('Burn complete. Throttle cut.', '', 2500);
    }
  };

  // After an SOI change the predicted path is rebuilt; the node stays if the new path still reaches it.
  game.on('sphere-change', ({ vessel }) => {
    if (vessel !== game.vessel || !game.node || vessel.landed) {
      return;
    }
    game.patches = Flatspace.predictPatches(vessel.body, vessel.position, vessel.velocity, game.time, 3);
    if (!game.refreshNode(false)) {
      game.deleteNode();
      game.message('Maneuver node removed: your new path no longer reaches it.', '', 3000);
    }
  });
})();
