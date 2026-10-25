// warp.js — time warp: allowed rates, on-rails versus physics warp, and warping to a time.
(function () {
  const game = FS.game;
  const WARP = (FS.WARP_RATES = [1, 5, 10, 50, 100, 1000, 10000, 100000]); // on rails
  const PHYS_WARP = (FS.PHYS_WARP_RATES = [1, 2, 3, 4]); // physics warp

  // Highest warp level allowed for this craft where it is now.
  game.allowedWarpIdx = (vessel) => {
    if (vessel.landed) {
      return 6;
    }
    return Math.min(FS.maxWarpIndex(vessel.body, vessel.altitude), WARP.length - 1);
  };

  // Can the craft go on rails (coasting in vacuum, or landed)?
  game.canRails = (vessel) => {
    if (vessel.dead) {
      return false;
    }
    if (vessel.landed) {
      return true;
    }
    if (vessel.thrustNow > 0) {
      return false;
    }
    const body = vessel.body;
    if (body.atmo && vessel.altitude < body.atmo.height) {
      return false;
    }
    return game.allowedWarpIdx(vessel) >= 1;
  };

  // Decide between rails and physics for this frame, and clamp the warp level to what's allowed.
  game.useRails = () => {
    const vessel = game.vessel;
    const railsOK = game.warpIdx > 0 && game.canRails(vessel);
    if (railsOK && game.warpIdx > game.allowedWarpIdx(vessel)) {
      game.warpIdx = game.allowedWarpIdx(vessel);
    }
    if (!railsOK && game.warpIdx > 3) {
      game.warpIdx = 3;
    }
    return railsOK && WARP[game.warpIdx] > 4;
  };

  game.effectiveRate = () => {
    if (!game.vessel || game.warpIdx === 0) {
      return 1;
    }
    return game.onRails ? WARP[game.warpIdx] : PHYS_WARP[Math.min(game.warpIdx, 3)];
  };

  game.changeWarp = (change) => {
    const vessel = game.vessel;
    if (!vessel) {
      return;
    }
    game.warpTarget = null;
    let newIndex = game.warpIdx + change;
    if (newIndex < 0) {
      newIndex = 0;
    }
    const max = game.canRails(vessel) ? game.allowedWarpIdx(vessel) : 3;
    if (newIndex > max) {
      newIndex = max;
      if (change > 0) {
        game.message(
          vessel.thrustNow > 0
            ? 'Cannot warp faster while engines are firing.'
            : 'Too close to ' + vessel.body.name + ' to warp faster.',
          '',
          1800,
        );
      }
    }
    game.warpIdx = newIndex;
  };

  game.stopWarp = () => {
    game.warpIdx = 0;
    game.warpTarget = null;
  };

  // Warp until game time t, slowing down as it gets close.
  game.warpTo = (targetTime) => {
    if (targetTime <= game.t + 1) {
      return false;
    }
    game.warpTarget = targetTime;
    return true;
  };

  game.updateWarpTarget = () => {
    if (game.warpTarget == null) {
      return;
    }
    const vessel = game.vessel;
    const timeLeft = game.warpTarget - game.t;
    if (timeLeft <= 0.5) {
      game.stopWarp();
      return;
    }
    let want = 0;
    for (let rateIndex = WARP.length - 1; rateIndex >= 0; rateIndex--) {
      if (WARP[rateIndex] * 1.2 < timeLeft) {
        want = rateIndex;
        break;
      }
    }
    game.warpIdx = Math.min(want, game.canRails(vessel) ? game.allowedWarpIdx(vessel) : 3);
  };
})();
