// warp.js — time warp: allowed rates, on-rails versus physics warp, and warping to a time.
(function () {
  const G = FS.game;
  const WARP = (FS.WARP_RATES = [1, 5, 10, 50, 100, 1000, 10000, 100000]); // on rails
  const PHYS_WARP = (FS.PHYS_WARP_RATES = [1, 2, 3, 4]);                    // physics warp

  // Highest warp level allowed for this craft where it is now.
  G.allowedWarpIdx = (ves) => {
    if (ves.landed) return 6;
    return Math.min(FS.maxWarpIndex(ves.body, ves.altitude), WARP.length - 1);
  };

  // Can the craft go on rails (coasting in vacuum, or landed)?
  G.canRails = (ves) => {
    if (ves.dead) return false;
    if (ves.landed) return true;
    if (ves.thrustNow > 0) return false;
    const b = ves.body;
    if (b.atmo && ves.altitude < b.atmo.height) return false;
    return G.allowedWarpIdx(ves) >= 1;
  };

  // Decide between rails and physics for this frame, and clamp the warp level to what's allowed.
  G.useRails = () => {
    const ves = G.vessel;
    const railsOK = G.warpIdx > 0 && G.canRails(ves);
    if (railsOK && G.warpIdx > G.allowedWarpIdx(ves)) G.warpIdx = G.allowedWarpIdx(ves);
    if (!railsOK && G.warpIdx > 3) G.warpIdx = 3;
    return railsOK && WARP[G.warpIdx] > 4;
  };

  G.effectiveRate = () => {
    if (!G.vessel || G.warpIdx === 0) return 1;
    return G.onRails ? WARP[G.warpIdx] : PHYS_WARP[Math.min(G.warpIdx, 3)];
  };

  G.changeWarp = (d) => {
    const ves = G.vessel;
    if (!ves) return;
    G.warpTarget = null;
    let idx = G.warpIdx + d;
    if (idx < 0) idx = 0;
    const max = G.canRails(ves) ? G.allowedWarpIdx(ves) : 3;
    if (idx > max) {
      idx = max;
      if (d > 0) G.message(ves.thrustNow > 0 ? 'Cannot warp faster while engines are firing.' : 'Too close to ' + ves.body.name + ' to warp faster.', '', 1800);
    }
    G.warpIdx = idx;
  };

  G.stopWarp = () => { G.warpIdx = 0; G.warpTarget = null; };

  // Warp until game time t, slowing down as it gets close.
  G.warpTo = (t) => {
    if (t <= G.t + 1) return false;
    G.warpTarget = t;
    return true;
  };

  G.updateWarpTarget = () => {
    if (G.warpTarget == null) return;
    const ves = G.vessel;
    const rem = G.warpTarget - G.t;
    if (rem <= 0.5) { G.stopWarp(); return; }
    let want = 0;
    for (let i = WARP.length - 1; i >= 0; i--) if (WARP[i] * 1.2 < rem) { want = i; break; }
    G.warpIdx = Math.min(want, G.canRails(ves) ? G.allowedWarpIdx(ves) : 3);
  };
})();
