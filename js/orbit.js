// orbit.js — 2D Kepler orbits, analytic propagation and patched-conic prediction.
(function () {
  const V = FS.vec;
  const TAU = FS.TAU;

  function solveElliptic(M, e) {
    M = FS.wrapAngle(M);
    let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
    for (let i = 0; i < 50; i++) {
      const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= d;
      if (Math.abs(d) < 1e-12) break;
    }
    return E;
  }
  function solveHyperbolic(M, e) {
    let F = Math.asinh(M / e);
    for (let i = 0; i < 60; i++) {
      const d = (e * Math.sinh(F) - F - M) / (e * Math.cosh(F) - 1);
      F -= d;
      if (Math.abs(d) < 1e-12) break;
    }
    return F;
  }

  // Build an orbit from position r and velocity v (relative to a body with
  // gravitational parameter mu) at time t.
  FS.orbitFromState = (r, v, mu, t) => {
    const rm = V.len(r);
    const v2 = V.dot(v, v);
    const h = V.cross(r, v);
    const rv = V.dot(r, v);
    const ex = ((v2 - mu / rm) * r.x - rv * v.x) / mu;
    const ey = ((v2 - mu / rm) * r.y - rv * v.y) / mu;
    let e = Math.hypot(ex, ey);
    const energy = v2 / 2 - mu / rm;
    const dir = h >= 0 ? 1 : -1;
    const p = (h * h) / mu;
    let a = -mu / (2 * energy);
    if (Math.abs(e - 1) < 1e-7) { e = e < 1 ? 1 - 1e-7 : 1 + 1e-7; a = p / (1 - e * e); }
    const phi = Math.atan2(r.y, r.x);
    const w = e > 1e-9 ? Math.atan2(ey, ex) : phi;
    const nu = FS.wrapAngle(dir * (phi - w));
    const o = { mu, a, e, w, dir, p, h, t0: t, energy };
    if (e < 1) {
      const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
      o.M0 = E - e * Math.sin(E);
      o.n = Math.sqrt(mu / (a * a * a));
      o.period = TAU / o.n;
    } else {
      const F = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
      o.M0 = e * Math.sinh(F) - F;
      o.n = Math.sqrt(mu / (-a * -a * -a));
      o.period = Infinity;
    }
    o.pe = o.a * (1 - e);                          // periapsis radius
    o.ap = e < 1 ? o.a * (1 + e) : Infinity;        // apoapsis radius
    return o;
  };

  // True anomaly → state vector (relative to the body).
  function stateAtNu(o, nu) {
    const r = o.p / (1 + o.e * Math.cos(nu));
    const phi = o.w + o.dir * nu;
    const c = Math.cos(phi), s = Math.sin(phi);
    const k = Math.sqrt(o.mu / o.p);
    const vr = k * o.e * Math.sin(nu);
    const vt = k * (1 + o.e * Math.cos(nu)) * o.dir;
    return { r: { x: c * r, y: s * r }, v: { x: vr * c - vt * s, y: vr * s + vt * c }, nu };
  }

  FS.meanAnomalyAt = (o, t) => o.M0 + o.n * (t - o.t0);

  FS.nuFromM = (o, M) => {
    const e = o.e;
    if (e < 1) {
      const E = solveElliptic(M, e);
      return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    }
    const F = solveHyperbolic(M, e);
    return 2 * Math.atan(Math.sqrt((e + 1) / (e - 1)) * Math.tanh(F / 2));
  };

  FS.orbitState = (o, t) => stateAtNu(o, FS.nuFromM(o, FS.meanAnomalyAt(o, t)));

  // Mean anomaly for a true anomaly.
  FS.mFromNu = (o, nu) => {
    const e = o.e;
    if (e < 1) {
      const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
      return E - e * Math.sin(E);
    }
    const F = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
    return e * Math.sinh(F) - F;
  };

  // Seconds from time t until the orbit next reaches true anomaly nu.
  FS.timeToNu = (o, nu, t) => {
    const Mt = FS.mFromNu(o, nu);
    const Mn = FS.meanAnomalyAt(o, t);
    if (o.e < 1) {
      let d = (Mt - Mn) % TAU;
      if (d < 0) d += TAU;
      return d / o.n;
    }
    return Mt > Mn ? (Mt - Mn) / o.n : Infinity;
  };

  // Radius → time from t until the craft reaches that radius going outward
  // (used for SOI exit). Returns Infinity if never.
  FS.timeToRadiusOutbound = (o, rad, t) => {
    if (o.e < 1 && rad > o.ap) return Infinity;
    if (rad < o.pe) return Infinity;
    const cosNu = (o.p / rad - 1) / o.e;
    const nu = Math.acos(FS.clamp(cosNu, -1, 1)); // positive branch = outbound
    return FS.timeToNu(o, nu, t);
  };

  // Sample the orbit for drawing from time t forward, up to tEnd (or one revolution).
  // Returns points relative to the body: {x, y, t}.
  FS.sampleOrbit = (o, t, tEnd, count) => {
    const pts = [];
    let span = tEnd - t;
    if (!isFinite(span)) span = o.e < 1 ? o.period : 1e7;
    if (o.e < 1) span = Math.min(span, o.period);
    // Sample uniformly in eccentric/hyperbolic anomaly for good shape.
    const e = o.e;
    const M0 = FS.meanAnomalyAt(o, t);
    const M1 = M0 + o.n * span;
    let A0, A1;
    if (e < 1) { A0 = solveElliptic(M0, e); A0 += M0 - FS.wrapAngle(M0); A1 = A0 + (M1 - M0) * 1.0; }
    else { A0 = solveHyperbolic(M0, e); A1 = solveHyperbolic(M1, e); }
    // For an ellipse, convert M range to E range (E increases with M)
    let E1 = e < 1 ? (() => { const base = M1 - FS.wrapAngle(M1); return solveElliptic(M1, e) + base; })() : A1;
    for (let i = 0; i <= count; i++) {
      const A = A0 + ((E1 - A0) * i) / count;
      let M, nu;
      if (e < 1) {
        M = A - e * Math.sin(A);
        nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(A / 2), Math.sqrt(1 - e) * Math.cos(A / 2));
      } else {
        M = e * Math.sinh(A) - A;
        nu = 2 * Math.atan(Math.sqrt((e + 1) / (e - 1)) * Math.tanh(A / 2));
      }
      const st = stateAtNu(o, nu);
      pts.push({ x: st.r.x, y: st.r.y, t: t + (M - M0) / o.n });
    }
    return pts;
  };

  // ---- Patched conics ----
  // Predict up to `maxPatches` conic segments starting from a state.
  // Each patch: {body, orbit, tStart, tEnd, end: 'encounter'|'escape'|'impact'|null, next body}
  FS.predictPatches = (body, r, v, t, maxPatches = 3) => {
    const patches = [];
    let cur = { body, r, v, t };
    for (let k = 0; k < maxPatches; k++) {
      const b = cur.body;
      const o = FS.orbitFromState(cur.r, cur.v, b.mu, cur.t);
      const patch = { body: b, orbit: o, tStart: cur.t, tEnd: Infinity, end: null };
      patches.push(patch);

      // Window to search: one orbit, or until SOI exit.
      let tExit = isFinite(b.soi) ? cur.t + FS.timeToRadiusOutbound(o, b.soi, cur.t) : Infinity;
      let horizon = o.e < 1 ? cur.t + o.period : tExit;
      if (!isFinite(horizon)) horizon = cur.t + 2e7;
      horizon = Math.min(horizon, tExit);

      // Impact with the surface (only meaningful if periapsis is below the surface)
      let tImpact = Infinity;
      if (o.pe < b.R + (b.terrain.amp * 0.5)) {
        const rad = b.R + (b.atmo ? 0 : 0);
        if (o.pe < rad) {
          // time until radius drops to rad on the inbound branch
          const cosNu = (o.p / rad - 1) / o.e;
          const nu = -Math.acos(FS.clamp(cosNu, -1, 1));
          tImpact = cur.t + FS.timeToNu(o, nu, cur.t);
        }
      }

      // Encounters with child bodies
      let tEnc = Infinity, encBody = null;
      if (b.children.length) {
        const N = 600;
        const tMax = Math.min(horizon, tImpact);
        const pts = FS.sampleOrbit(o, cur.t, tMax, N);
        for (const c of b.children) {
          let prevD = null, prevT = null;
          for (let i = 0; i < pts.length; i++) {
            const pt = pts[i];
            const cp = FS.bodyPos(c, pt.t);
            const d = Math.hypot(pt.x - cp.x, pt.y - cp.y) - c.soi;
            if (d < 0 && i > 0) {
              // bisection between prevT and pt.t
              let lo = prevT, hi = pt.t;
              for (let j = 0; j < 40; j++) {
                const mid = (lo + hi) / 2;
                const s = FS.orbitState(o, mid);
                const cm = FS.bodyPos(c, mid);
                if (Math.hypot(s.r.x - cm.x, s.r.y - cm.y) < c.soi) hi = mid; else lo = mid;
              }
              if (hi < tEnc) { tEnc = hi; encBody = c; }
              break;
            }
            if (d < 0 && i === 0) break; // already inside (shouldn't happen)
            prevD = d; prevT = pt.t;
          }
        }
      }

      const tEnd = Math.min(tExit, tImpact, tEnc);
      if (!isFinite(tEnd)) break;
      patch.tEnd = tEnd;
      if (tEnd === tImpact) { patch.end = 'impact'; break; }
      const s = FS.orbitState(o, tEnd);
      if (tEnd === tEnc) {
        patch.end = 'encounter'; patch.next = encBody;
        cur = {
          body: encBody,
          r: V.sub(s.r, FS.bodyPos(encBody, tEnd)),
          v: V.sub(s.v, FS.bodyVel(encBody, tEnd)),
          t: tEnd + 1e-6,
        };
      } else {
        patch.end = 'escape'; patch.next = b.parent;
        cur = {
          body: b.parent,
          r: V.add(s.r, FS.bodyPos(b, tEnd)),
          v: V.add(s.v, FS.bodyVel(b, tEnd)),
          t: tEnd + 1e-6,
        };
      }
    }
    return patches;
  };
})();
