// orbit.js — 2D Kepler orbits, analytic propagation and patched-conic prediction.
(function () {
  const Vector = Flatspace.Vector;
  const FULL_TURN = Flatspace.TAU;

  function solveElliptic(meanAnomaly, eccentricity) {
    meanAnomaly = Flatspace.wrapAngle(meanAnomaly);
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

  // Build an orbit from a position and velocity (relative to a body with
  // gravitational parameter gravityParameter) at a time.
  Flatspace.orbitFromState = (position, velocity, gravityParameter, time) => {
    const distance = Vector.length(position);
    const speedSquared = Vector.dot(velocity, velocity);
    const angularMomentum = Vector.cross(position, velocity);
    const radialDot = Vector.dot(position, velocity);
    const eccentricityX =
      ((speedSquared - gravityParameter / distance) * position.x - radialDot * velocity.x) / gravityParameter;
    const eccentricityY =
      ((speedSquared - gravityParameter / distance) * position.y - radialDot * velocity.y) / gravityParameter;
    let eccentricity = Math.hypot(eccentricityX, eccentricityY);
    const energy = speedSquared / 2 - gravityParameter / distance;
    const direction = angularMomentum >= 0 ? 1 : -1;
    const semiLatusRectum = (angularMomentum * angularMomentum) / gravityParameter;
    let semiMajorAxis = -gravityParameter / (2 * energy);
    if (Math.abs(eccentricity - 1) < 1e-7) {
      eccentricity = eccentricity < 1 ? 1 - 1e-7 : 1 + 1e-7;
      semiMajorAxis = semiLatusRectum / (1 - eccentricity * eccentricity);
    }
    const positionAngle = Math.atan2(position.y, position.x);
    const periapsisAngle = eccentricity > 1e-9 ? Math.atan2(eccentricityY, eccentricityX) : positionAngle;
    const trueAnomaly = Flatspace.wrapAngle(direction * (positionAngle - periapsisAngle));
    const orbit = {
      gravityParameter,
      semiMajorAxis,
      eccentricity,
      periapsisAngle,
      direction,
      semiLatusRectum,
      angularMomentum,
      epoch: time,
      energy,
    };
    if (eccentricity < 1) {
      const eccentricAnomaly =
        2 *
        Math.atan2(
          Math.sqrt(1 - eccentricity) * Math.sin(trueAnomaly / 2),
          Math.sqrt(1 + eccentricity) * Math.cos(trueAnomaly / 2),
        );
      orbit.meanAnomalyAtEpoch = eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly);
      orbit.meanMotion = Math.sqrt(gravityParameter / (semiMajorAxis * semiMajorAxis * semiMajorAxis));
      orbit.period = FULL_TURN / orbit.meanMotion;
    } else {
      const hyperbolicAnomaly =
        2 * Math.atanh(Math.sqrt((eccentricity - 1) / (eccentricity + 1)) * Math.tan(trueAnomaly / 2));
      orbit.meanAnomalyAtEpoch = eccentricity * Math.sinh(hyperbolicAnomaly) - hyperbolicAnomaly;
      orbit.meanMotion = Math.sqrt(gravityParameter / (-semiMajorAxis * -semiMajorAxis * -semiMajorAxis));
      orbit.period = Infinity;
    }
    orbit.periapsis = orbit.semiMajorAxis * (1 - eccentricity); // periapsis radius
    orbit.apoapsis = eccentricity < 1 ? orbit.semiMajorAxis * (1 + eccentricity) : Infinity; // apoapsis radius
    return orbit;
  };

  // True anomaly → state vector (relative to the body).
  function stateAtNu(orbit, trueAnomaly) {
    const distance = orbit.semiLatusRectum / (1 + orbit.eccentricity * Math.cos(trueAnomaly));
    const positionAngle = orbit.periapsisAngle + orbit.direction * trueAnomaly;
    const cosAngle = Math.cos(positionAngle);
    const sinAngle = Math.sin(positionAngle);
    const speedScale = Math.sqrt(orbit.gravityParameter / orbit.semiLatusRectum);
    const radialSpeed = speedScale * orbit.eccentricity * Math.sin(trueAnomaly);
    const sidewaysSpeed = speedScale * (1 + orbit.eccentricity * Math.cos(trueAnomaly)) * orbit.direction;
    return {
      position: { x: cosAngle * distance, y: sinAngle * distance },
      velocity: {
        x: radialSpeed * cosAngle - sidewaysSpeed * sinAngle,
        y: radialSpeed * sinAngle + sidewaysSpeed * cosAngle,
      },
      trueAnomaly,
    };
  }

  Flatspace.meanAnomalyAt = (orbit, time) =>
    orbit.meanAnomalyAtEpoch + orbit.meanMotion * (time - orbit.epoch);

  Flatspace.trueAnomalyFromMean = (orbit, meanAnomaly) => {
    const eccentricity = orbit.eccentricity;
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

  Flatspace.orbitState = (orbit, time) =>
    stateAtNu(orbit, Flatspace.trueAnomalyFromMean(orbit, Flatspace.meanAnomalyAt(orbit, time)));

  // Mean anomaly for a true anomaly.
  Flatspace.meanAnomalyFromTrue = (orbit, trueAnomaly) => {
    const eccentricity = orbit.eccentricity;
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

  // Seconds from a time until the orbit next reaches a true anomaly.
  Flatspace.timeToTrueAnomaly = (orbit, trueAnomaly, time) => {
    const targetMeanAnomaly = Flatspace.meanAnomalyFromTrue(orbit, trueAnomaly);
    const currentMeanAnomaly = Flatspace.meanAnomalyAt(orbit, time);
    if (orbit.eccentricity < 1) {
      let anomalyDifference = (targetMeanAnomaly - currentMeanAnomaly) % FULL_TURN;
      if (anomalyDifference < 0) {
        anomalyDifference += FULL_TURN;
      }
      return anomalyDifference / orbit.meanMotion;
    }
    return targetMeanAnomaly > currentMeanAnomaly
      ? (targetMeanAnomaly - currentMeanAnomaly) / orbit.meanMotion
      : Infinity;
  };

  // Radius → time from a start time until the craft reaches that radius going outward
  // (used for SOI exit). Returns Infinity if never.
  Flatspace.timeToRadiusOutbound = (orbit, radius, time) => {
    if (orbit.eccentricity < 1 && radius > orbit.apoapsis) {
      return Infinity;
    }
    if (radius < orbit.periapsis) {
      return Infinity;
    }
    const cosNu = (orbit.semiLatusRectum / radius - 1) / orbit.eccentricity;
    const trueAnomaly = Math.acos(Flatspace.clamp(cosNu, -1, 1)); // positive branch = outbound
    return Flatspace.timeToTrueAnomaly(orbit, trueAnomaly, time);
  };

  // Sample the orbit for drawing from a time forward, up to endTime (or one revolution).
  // Returns points relative to the body: {x, y, time}.
  Flatspace.sampleOrbit = (orbit, time, endTime, count) => {
    const points = [];
    let span = endTime - time;
    if (!isFinite(span)) {
      span = orbit.eccentricity < 1 ? orbit.period : 1e7;
    }
    if (orbit.eccentricity < 1) {
      span = Math.min(span, orbit.period);
    }
    // Sample uniformly in eccentric/hyperbolic anomaly for good shape.
    const eccentricity = orbit.eccentricity;
    const startMeanAnomaly = Flatspace.meanAnomalyAt(orbit, time);
    const endMeanAnomaly = startMeanAnomaly + orbit.meanMotion * span;
    let startAnomaly;
    let endAnomaly;
    if (eccentricity < 1) {
      startAnomaly = solveElliptic(startMeanAnomaly, eccentricity);
      startAnomaly += startMeanAnomaly - Flatspace.wrapAngle(startMeanAnomaly);
      endAnomaly = startAnomaly + (endMeanAnomaly - startMeanAnomaly) * 1.0;
    } else {
      startAnomaly = solveHyperbolic(startMeanAnomaly, eccentricity);
      endAnomaly = solveHyperbolic(endMeanAnomaly, eccentricity);
    }
    // For an ellipse, convert the mean anomaly range to the eccentric anomaly range (which increases with it)
    let endEccentricAnomaly =
      eccentricity < 1
        ? (() => {
            const base = endMeanAnomaly - Flatspace.wrapAngle(endMeanAnomaly);
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
      points.push({
        x: state.position.x,
        y: state.position.y,
        time: time + (meanAnomaly - startMeanAnomaly) / orbit.meanMotion,
      });
    }
    return points;
  };

  // ---- Patched conics ----
  // Predict up to `maxPatches` conic segments starting from a state.
  // Each patch: {body, orbit, startTime, endTime, end: 'encounter'|'escape'|'impact'|null, next body}
  Flatspace.predictPatches = (body, position, velocity, time, maxPatches = 3) => {
    const patches = [];
    let current = { body, position, velocity, time };
    for (let patchNumber = 0; patchNumber < maxPatches; patchNumber++) {
      const body = current.body;
      const orbit = Flatspace.orbitFromState(
        current.position,
        current.velocity,
        body.gravityParameter,
        current.time,
      );
      const patch = { body, orbit, startTime: current.time, endTime: Infinity, end: null };
      patches.push(patch);

      // Window to search: one orbit, or until SOI exit.
      let exitTime = isFinite(body.sphereOfInfluence)
        ? current.time + Flatspace.timeToRadiusOutbound(orbit, body.sphereOfInfluence, current.time)
        : Infinity;
      let horizon = orbit.eccentricity < 1 ? current.time + orbit.period : exitTime;
      if (!isFinite(horizon)) {
        horizon = current.time + 2e7;
      }
      horizon = Math.min(horizon, exitTime);

      // Impact with the surface (only meaningful if periapsis is below the surface)
      let impactTime = Infinity;
      if (orbit.periapsis < body.radius + body.terrain.amplitude * 0.5) {
        const surfaceRadius = body.radius + (body.atmosphere ? 0 : 0);
        if (orbit.periapsis < surfaceRadius) {
          // time until radius drops to surfaceRadius on the inbound branch
          const cosNu = (orbit.semiLatusRectum / surfaceRadius - 1) / orbit.eccentricity;
          const trueAnomaly = -Math.acos(Flatspace.clamp(cosNu, -1, 1));
          impactTime = current.time + Flatspace.timeToTrueAnomaly(orbit, trueAnomaly, current.time);
        }
      }

      // Encounters with child bodies
      let encounterTime = Infinity;
      let encounterBody = null;
      if (body.children.length) {
        const SAMPLE_COUNT = 600;
        const searchEndTime = Math.min(horizon, impactTime);
        const points = Flatspace.sampleOrbit(orbit, current.time, searchEndTime, SAMPLE_COUNT);
        for (const moon of body.children) {
          let previousDistance = null;
          let previousTime = null;
          for (let sampleIndex = 0; sampleIndex < points.length; sampleIndex++) {
            const sample = points[sampleIndex];
            const moonPosition = Flatspace.bodyPosition(moon, sample.time);
            const distanceInsideSphere =
              Math.hypot(sample.x - moonPosition.x, sample.y - moonPosition.y) - moon.sphereOfInfluence;
            if (distanceInsideSphere < 0 && sampleIndex > 0) {
              // bisection between previousTime and point.time
              let lowTime = previousTime;
              let highTime = sample.time;
              for (let iteration = 0; iteration < 40; iteration++) {
                const midTime = (lowTime + highTime) / 2;
                const midState = Flatspace.orbitState(orbit, midTime);
                const moonAtMid = Flatspace.bodyPosition(moon, midTime);
                if (
                  Math.hypot(midState.position.x - moonAtMid.x, midState.position.y - moonAtMid.y) <
                  moon.sphereOfInfluence
                ) {
                  highTime = midTime;
                } else {
                  lowTime = midTime;
                }
              }
              if (highTime < encounterTime) {
                encounterTime = highTime;
                encounterBody = moon;
              }
              break;
            }
            if (distanceInsideSphere < 0 && sampleIndex === 0) {
              break;
            } // already inside (shouldn't happen)
            previousDistance = distanceInsideSphere;
            previousTime = sample.time;
          }
        }
      }

      const endTime = Math.min(exitTime, impactTime, encounterTime);
      if (!isFinite(endTime)) {
        break;
      }
      patch.endTime = endTime;
      if (endTime === impactTime) {
        patch.end = 'impact';
        break;
      }
      const endState = Flatspace.orbitState(orbit, endTime);
      if (endTime === encounterTime) {
        patch.end = 'encounter';
        patch.next = encounterBody;
        current = {
          body: encounterBody,
          position: Vector.subtract(endState.position, Flatspace.bodyPosition(encounterBody, endTime)),
          velocity: Vector.subtract(endState.velocity, Flatspace.bodyVelocity(encounterBody, endTime)),
          time: endTime + 1e-6,
        };
      } else {
        patch.end = 'escape';
        patch.next = body.parent;
        current = {
          body: body.parent,
          position: Vector.add(endState.position, Flatspace.bodyPosition(body, endTime)),
          velocity: Vector.add(endState.velocity, Flatspace.bodyVelocity(body, endTime)),
          time: endTime + 1e-6,
        };
      }
    }
    return patches;
  };
})();
