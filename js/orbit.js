// orbit.js — 2D Kepler orbits, analytic propagation and patched-conic prediction.
(function () {
  const Vector = FS.vec;
  const FULL_TURN = FS.TAU;

  function solveElliptic(meanAnomaly, eccentricity) {
    meanAnomaly = FS.wrapAngle(meanAnomaly);
    let eccentricAnomaly = eccentricity < 0.8 ? meanAnomaly : Math.PI * Math.sign(meanAnomaly || 1);
    for (let iteration = 0; iteration < 50; iteration++) {
      const correction =
        (eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly) - meanAnomaly) /
        (1 - eccentricity * Math.cos(eccentricAnomaly));
      eccentricAnomaly -= correction;
      if (Math.abs(correction) < 1e-12) {
        break;
      }
    }
    return eccentricAnomaly;
  }
  function solveHyperbolic(meanAnomaly, eccentricity) {
    let hyperbolicAnomaly = Math.asinh(meanAnomaly / eccentricity);
    for (let iteration = 0; iteration < 60; iteration++) {
      const correction =
        (eccentricity * Math.sinh(hyperbolicAnomaly) - hyperbolicAnomaly - meanAnomaly) /
        (eccentricity * Math.cosh(hyperbolicAnomaly) - 1);
      hyperbolicAnomaly -= correction;
      if (Math.abs(correction) < 1e-12) {
        break;
      }
    }
    return hyperbolicAnomaly;
  }

  // Build an orbit from position r and velocity v (relative to a body with
  // gravitational parameter mu) at time t.
  FS.orbitFromState = (position, velocity, gravParam, time) => {
    const distance = Vector.len(position);
    const speedSquared = Vector.dot(velocity, velocity);
    const angularMomentum = Vector.cross(position, velocity);
    const radialDot = Vector.dot(position, velocity);
    const eccentricityX =
      ((speedSquared - gravParam / distance) * position.x - radialDot * velocity.x) / gravParam;
    const eccentricityY =
      ((speedSquared - gravParam / distance) * position.y - radialDot * velocity.y) / gravParam;
    let eccentricity = Math.hypot(eccentricityX, eccentricityY);
    const energy = speedSquared / 2 - gravParam / distance;
    const direction = angularMomentum >= 0 ? 1 : -1;
    const semiLatusRectum = (angularMomentum * angularMomentum) / gravParam;
    let semiMajorAxis = -gravParam / (2 * energy);
    if (Math.abs(eccentricity - 1) < 1e-7) {
      eccentricity = eccentricity < 1 ? 1 - 1e-7 : 1 + 1e-7;
      semiMajorAxis = semiLatusRectum / (1 - eccentricity * eccentricity);
    }
    const positionAngle = Math.atan2(position.y, position.x);
    const periapsisAngle = eccentricity > 1e-9 ? Math.atan2(eccentricityY, eccentricityX) : positionAngle;
    const trueAnomaly = FS.wrapAngle(direction * (positionAngle - periapsisAngle));
    const orbit = {
      mu: gravParam,
      a: semiMajorAxis,
      e: eccentricity,
      w: periapsisAngle,
      dir: direction,
      p: semiLatusRectum,
      h: angularMomentum,
      t0: time,
      energy,
    };
    if (eccentricity < 1) {
      const eccentricAnomaly =
        2 *
        Math.atan2(
          Math.sqrt(1 - eccentricity) * Math.sin(trueAnomaly / 2),
          Math.sqrt(1 + eccentricity) * Math.cos(trueAnomaly / 2),
        );
      orbit.M0 = eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly);
      orbit.n = Math.sqrt(gravParam / (semiMajorAxis * semiMajorAxis * semiMajorAxis));
      orbit.period = FULL_TURN / orbit.n;
    } else {
      const hyperbolicAnomaly =
        2 * Math.atanh(Math.sqrt((eccentricity - 1) / (eccentricity + 1)) * Math.tan(trueAnomaly / 2));
      orbit.M0 = eccentricity * Math.sinh(hyperbolicAnomaly) - hyperbolicAnomaly;
      orbit.n = Math.sqrt(gravParam / (-semiMajorAxis * -semiMajorAxis * -semiMajorAxis));
      orbit.period = Infinity;
    }
    orbit.pe = orbit.a * (1 - eccentricity); // periapsis radius
    orbit.ap = eccentricity < 1 ? orbit.a * (1 + eccentricity) : Infinity; // apoapsis radius
    return orbit;
  };

  // True anomaly → state vector (relative to the body).
  function stateAtNu(orbit, trueAnomaly) {
    const distance = orbit.p / (1 + orbit.e * Math.cos(trueAnomaly));
    const positionAngle = orbit.w + orbit.dir * trueAnomaly;
    const cosAngle = Math.cos(positionAngle);
    const sinAngle = Math.sin(positionAngle);
    const speedScale = Math.sqrt(orbit.mu / orbit.p);
    const radialSpeed = speedScale * orbit.e * Math.sin(trueAnomaly);
    const sidewaysSpeed = speedScale * (1 + orbit.e * Math.cos(trueAnomaly)) * orbit.dir;
    return {
      r: { x: cosAngle * distance, y: sinAngle * distance },
      v: {
        x: radialSpeed * cosAngle - sidewaysSpeed * sinAngle,
        y: radialSpeed * sinAngle + sidewaysSpeed * cosAngle,
      },
      nu: trueAnomaly,
    };
  }

  FS.meanAnomalyAt = (orbit, time) => orbit.M0 + orbit.n * (time - orbit.t0);

  FS.nuFromM = (orbit, meanAnomaly) => {
    const eccentricity = orbit.e;
    if (eccentricity < 1) {
      const eccentricAnomaly = solveElliptic(meanAnomaly, eccentricity);
      return (
        2 *
        Math.atan2(
          Math.sqrt(1 + eccentricity) * Math.sin(eccentricAnomaly / 2),
          Math.sqrt(1 - eccentricity) * Math.cos(eccentricAnomaly / 2),
        )
      );
    }
    const hyperbolicAnomaly = solveHyperbolic(meanAnomaly, eccentricity);
    return (
      2 * Math.atan(Math.sqrt((eccentricity + 1) / (eccentricity - 1)) * Math.tanh(hyperbolicAnomaly / 2))
    );
  };

  FS.orbitState = (orbit, time) => stateAtNu(orbit, FS.nuFromM(orbit, FS.meanAnomalyAt(orbit, time)));

  // Mean anomaly for a true anomaly.
  FS.mFromNu = (orbit, trueAnomaly) => {
    const eccentricity = orbit.e;
    if (eccentricity < 1) {
      const eccentricAnomaly =
        2 *
        Math.atan2(
          Math.sqrt(1 - eccentricity) * Math.sin(trueAnomaly / 2),
          Math.sqrt(1 + eccentricity) * Math.cos(trueAnomaly / 2),
        );
      return eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly);
    }
    const hyperbolicAnomaly =
      2 * Math.atanh(Math.sqrt((eccentricity - 1) / (eccentricity + 1)) * Math.tan(trueAnomaly / 2));
    return eccentricity * Math.sinh(hyperbolicAnomaly) - hyperbolicAnomaly;
  };

  // Seconds from time t until the orbit next reaches true anomaly nu.
  FS.timeToNu = (orbit, trueAnomaly, time) => {
    const targetMeanAnomaly = FS.mFromNu(orbit, trueAnomaly);
    const currentMeanAnomaly = FS.meanAnomalyAt(orbit, time);
    if (orbit.e < 1) {
      let anomalyDifference = (targetMeanAnomaly - currentMeanAnomaly) % FULL_TURN;
      if (anomalyDifference < 0) {
        anomalyDifference += FULL_TURN;
      }
      return anomalyDifference / orbit.n;
    }
    return targetMeanAnomaly > currentMeanAnomaly
      ? (targetMeanAnomaly - currentMeanAnomaly) / orbit.n
      : Infinity;
  };

  // Radius → time from t until the craft reaches that radius going outward
  // (used for SOI exit). Returns Infinity if never.
  FS.timeToRadiusOutbound = (orbit, radius, time) => {
    if (orbit.e < 1 && radius > orbit.ap) {
      return Infinity;
    }
    if (radius < orbit.pe) {
      return Infinity;
    }
    const cosNu = (orbit.p / radius - 1) / orbit.e;
    const trueAnomaly = Math.acos(FS.clamp(cosNu, -1, 1)); // positive branch = outbound
    return FS.timeToNu(orbit, trueAnomaly, time);
  };

  // Sample the orbit for drawing from time t forward, up to tEnd (or one revolution).
  // Returns points relative to the body: {x, y, t}.
  FS.sampleOrbit = (orbit, time, tEnd, count) => {
    const points = [];
    let span = tEnd - time;
    if (!isFinite(span)) {
      span = orbit.e < 1 ? orbit.period : 1e7;
    }
    if (orbit.e < 1) {
      span = Math.min(span, orbit.period);
    }
    // Sample uniformly in eccentric/hyperbolic anomaly for good shape.
    const eccentricity = orbit.e;
    const startMeanAnomaly = FS.meanAnomalyAt(orbit, time);
    const endMeanAnomaly = startMeanAnomaly + orbit.n * span;
    let startAnomaly;
    let endAnomaly;
    if (eccentricity < 1) {
      startAnomaly = solveElliptic(startMeanAnomaly, eccentricity);
      startAnomaly += startMeanAnomaly - FS.wrapAngle(startMeanAnomaly);
      endAnomaly = startAnomaly + (endMeanAnomaly - startMeanAnomaly) * 1.0;
    } else {
      startAnomaly = solveHyperbolic(startMeanAnomaly, eccentricity);
      endAnomaly = solveHyperbolic(endMeanAnomaly, eccentricity);
    }
    // For an ellipse, convert M range to E range (E increases with M)
    let endEccentricAnomaly =
      eccentricity < 1
        ? (() => {
            const base = endMeanAnomaly - FS.wrapAngle(endMeanAnomaly);
            return solveElliptic(endMeanAnomaly, eccentricity) + base;
          })()
        : endAnomaly;
    for (let sampleIndex = 0; sampleIndex <= count; sampleIndex++) {
      const anomaly = startAnomaly + ((endEccentricAnomaly - startAnomaly) * sampleIndex) / count;
      let meanAnomaly;
      let trueAnomaly;
      if (eccentricity < 1) {
        meanAnomaly = anomaly - eccentricity * Math.sin(anomaly);
        trueAnomaly =
          2 *
          Math.atan2(
            Math.sqrt(1 + eccentricity) * Math.sin(anomaly / 2),
            Math.sqrt(1 - eccentricity) * Math.cos(anomaly / 2),
          );
      } else {
        meanAnomaly = eccentricity * Math.sinh(anomaly) - anomaly;
        trueAnomaly =
          2 * Math.atan(Math.sqrt((eccentricity + 1) / (eccentricity - 1)) * Math.tanh(anomaly / 2));
      }
      const state = stateAtNu(orbit, trueAnomaly);
      points.push({ x: state.r.x, y: state.r.y, t: time + (meanAnomaly - startMeanAnomaly) / orbit.n });
    }
    return points;
  };

  // ---- Patched conics ----
  // Predict up to `maxPatches` conic segments starting from a state.
  // Each patch: {body, orbit, tStart, tEnd, end: 'encounter'|'escape'|'impact'|null, next body}
  FS.predictPatches = (body, position, velocity, time, maxPatches = 3) => {
    const patches = [];
    let current = { body, r: position, v: velocity, t: time };
    for (let patchNumber = 0; patchNumber < maxPatches; patchNumber++) {
      const body = current.body;
      const orbit = FS.orbitFromState(current.r, current.v, body.mu, current.t);
      const patch = { body: body, orbit: orbit, tStart: current.t, tEnd: Infinity, end: null };
      patches.push(patch);

      // Window to search: one orbit, or until SOI exit.
      let tExit = isFinite(body.soi)
        ? current.t + FS.timeToRadiusOutbound(orbit, body.soi, current.t)
        : Infinity;
      let horizon = orbit.e < 1 ? current.t + orbit.period : tExit;
      if (!isFinite(horizon)) {
        horizon = current.t + 2e7;
      }
      horizon = Math.min(horizon, tExit);

      // Impact with the surface (only meaningful if periapsis is below the surface)
      let tImpact = Infinity;
      if (orbit.pe < body.R + body.terrain.amp * 0.5) {
        const surfaceRadius = body.R + (body.atmo ? 0 : 0);
        if (orbit.pe < surfaceRadius) {
          // time until radius drops to rad on the inbound branch
          const cosNu = (orbit.p / surfaceRadius - 1) / orbit.e;
          const trueAnomaly = -Math.acos(FS.clamp(cosNu, -1, 1));
          tImpact = current.t + FS.timeToNu(orbit, trueAnomaly, current.t);
        }
      }

      // Encounters with child bodies
      let tEnc = Infinity;
      let encBody = null;
      if (body.children.length) {
        const SAMPLE_COUNT = 600;
        const tMax = Math.min(horizon, tImpact);
        const points = FS.sampleOrbit(orbit, current.t, tMax, SAMPLE_COUNT);
        for (const moon of body.children) {
          let prevD = null;
          let prevT = null;
          for (let sampleIndex = 0; sampleIndex < points.length; sampleIndex++) {
            const sample = points[sampleIndex];
            const moonPosition = FS.bodyPos(moon, sample.t);
            const distanceInsideSoi =
              Math.hypot(sample.x - moonPosition.x, sample.y - moonPosition.y) - moon.soi;
            if (distanceInsideSoi < 0 && sampleIndex > 0) {
              // bisection between prevT and pt.t
              let lowTime = prevT;
              let highTime = sample.t;
              for (let iteration = 0; iteration < 40; iteration++) {
                const midTime = (lowTime + highTime) / 2;
                const midState = FS.orbitState(orbit, midTime);
                const moonAtMid = FS.bodyPos(moon, midTime);
                if (Math.hypot(midState.r.x - moonAtMid.x, midState.r.y - moonAtMid.y) < moon.soi) {
                  highTime = midTime;
                } else {
                  lowTime = midTime;
                }
              }
              if (highTime < tEnc) {
                tEnc = highTime;
                encBody = moon;
              }
              break;
            }
            if (distanceInsideSoi < 0 && sampleIndex === 0) {
              break;
            } // already inside (shouldn't happen)
            prevD = distanceInsideSoi;
            prevT = sample.t;
          }
        }
      }

      const tEnd = Math.min(tExit, tImpact, tEnc);
      if (!isFinite(tEnd)) {
        break;
      }
      patch.tEnd = tEnd;
      if (tEnd === tImpact) {
        patch.end = 'impact';
        break;
      }
      const endState = FS.orbitState(orbit, tEnd);
      if (tEnd === tEnc) {
        patch.end = 'encounter';
        patch.next = encBody;
        current = {
          body: encBody,
          r: Vector.sub(endState.r, FS.bodyPos(encBody, tEnd)),
          v: Vector.sub(endState.v, FS.bodyVel(encBody, tEnd)),
          t: tEnd + 1e-6,
        };
      } else {
        patch.end = 'escape';
        patch.next = body.parent;
        current = {
          body: body.parent,
          r: Vector.add(endState.r, FS.bodyPos(body, tEnd)),
          v: Vector.add(endState.v, FS.bodyVel(body, tEnd)),
          t: tEnd + 1e-6,
        };
      }
    }
    return patches;
  };
})();
