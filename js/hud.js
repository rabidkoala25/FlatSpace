// hud.js — flight instruments: attitude dial, readouts, stage list, node panel.
(function () {
  const Vector = Flatspace.Vector;
  const hud = (Flatspace.HUD = {});
  const byId = (elementId) => document.getElementById(elementId);
  let dial;
  let dialContext;
  let textTimer = 0;

  hud.initialise = () => {
    dial = byId('dial');
    dialContext = dial.getContext('2d');
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    dial.width = 200 * pixelRatio;
    dial.height = 200 * pixelRatio;
    dialContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  };

  // Whether speed is shown relative to the surface or the orbit (KSP-style auto switch).
  hud.surfaceMode = (vessel) => {
    if (vessel.landed) {
      return true;
    }
    const body = vessel.body;
    return vessel.altitude < (body.atmosphere ? body.atmosphere.height * 0.5 : 10000);
  };

  hud.update = (game, timeStep) => {
    drawDial(game);
    textTimer -= timeStep;
    if (textTimer > 0) {
      return;
    }
    textTimer = 0.12;
    const vessel = game.vessel;
    const body = vessel.body;
    const time = game.time;
    const altitude = vessel.altitude;
    byId('hudAltitude').textContent = Flatspace.formatDistance(altitude);
    byId('hudMissionTime').textContent =
      (vessel.stats.launched ? 'T+ ' : 'T− ') + Flatspace.formatTime(time - game.launchTime);
    const rate = game.effectiveRate();
    byId('hudWarp').textContent = rate + '×' + (game.onRails ? '' : rate > 1 ? ' phys' : '');
    byId('hudWarp').style.color = rate > 1 ? 'var(--amber)' : '';
    byId('hudSituation').textContent = vessel.situation();

    const surfaceMode = hud.surfaceMode(vessel);
    const surfaceVelocity = Vector.subtract(vessel.velocity, Flatspace.airVelocity(body, vessel.position));
    byId('hudSpeedMode').textContent = surfaceMode ? 'Surface' : 'Orbit';
    byId('hudSpeed').textContent = Flatspace.formatSpeed(
      Vector.length(surfaceMode ? surfaceVelocity : vessel.velocity),
    );
    byId('throttleGauge').style.height = (vessel.throttle * 100).toFixed(0) + '%';

    // Stage stats (live)
    const pressure = Flatspace.pressure(body, altitude);
    const localGravity = body.gravityParameter / Vector.dot(vessel.position, vessel.position);
    // What's burning now (current) and each stage still to fire (events), here and in vacuum
    const live = Flatspace.stageStats(vessel.parts, vessel.stages, vessel.stageIndex, pressure, localGravity);
    const liveVacuumStats = Flatspace.stageStats(
      vessel.parts,
      vessel.stages,
      vessel.stageIndex,
      0,
      localGravity,
    );
    const nowStats =
      live.current.deltaV > 0 ? live.current : live.events.find((event) => event.deltaV > 0) || live.current;
    const fuel = vessel.stageFuel();
    byId('fuelGauge').style.height = (fuel.max > 0 ? (fuel.now / fuel.max) * 100 : 0).toFixed(0) + '%';

    // Flight data
    const orbit = Flatspace.orbitFromState(vessel.position, vessel.velocity, body.gravityParameter, time);
    const rows = [];
    const orbitInfo = !vessel.landed;
    if (orbitInfo) {
      if (orbit.eccentricity < 1) {
        rows.push(
          ['Apoapsis', Flatspace.formatDistance(orbit.apoapsis - body.radius), 'orb'],
          ['Time to Ap', Flatspace.formatTime(Flatspace.timeToTrueAnomaly(orbit, Math.PI, time)), 'orb'],
        );
      } else {
        rows.push(['Apoapsis', 'escape', 'orb']);
      }
      rows.push([
        'Periapsis',
        Flatspace.formatDistance(orbit.periapsis - body.radius),
        orbit.periapsis < body.radius ? 'warn' : 'orb',
      ]);
      rows.push(['Time to Pe', Flatspace.formatTime(Flatspace.timeToTrueAnomaly(orbit, 0, time)), 'orb']);
      if (orbit.eccentricity < 1) {
        rows.push(['Period', Flatspace.formatTime(orbit.period), 'orb']);
      }
    }
    const upDirection = Vector.normalise(vessel.position);
    rows.push(['Vertical speed', Flatspace.formatSpeed(Vector.dot(surfaceVelocity, upDirection))]);
    rows.push([
      'Horizontal speed',
      Flatspace.formatSpeed(Math.abs(Vector.cross(upDirection, surfaceVelocity))),
    ]);
    const longitude = Flatspace.longitudeAt(body, Vector.angle(vessel.position), time);
    rows.push([
      'Above terrain',
      Flatspace.formatDistance(
        Math.max(0, altitude - Flatspace.surfaceHeight(body, longitude) - vessel.bottomDistance),
      ),
    ]);
    rows.push(['Stage Δv', nowStats.deltaV.toFixed(0) + ' m/s']);
    rows.push(['Total Δv (vac)', liveVacuumStats.total.toFixed(0) + ' m/s']);
    rows.push([
      'TWR',
      (vessel.thrustNow / (vessel.mass * localGravity)).toFixed(2) +
        ' / ' +
        nowStats.thrustToWeight.toFixed(2),
    ]);
    rows.push(['Mass', (vessel.mass / 1000).toFixed(2) + ' t']);
    if (body.atmosphere) {
      rows.push(['Pressure', pressure.toFixed(3) + ' atm']);
      rows.push(['Dynamic pressure', (vessel.dynamicPressure / 1000).toFixed(1) + ' kPa']);
    }
    rows.push(['G-force', (vessel.gForce || 0).toFixed(2) + ' g']);
    if (vessel.flameout) {
      rows.push(['Engines', 'flameout', 'warn']);
    }
    byId('flightData').innerHTML = rows
      .map(
        ([label, value, cssClass]) =>
          `<dt>${label}</dt><dd${cssClass ? ` class="${cssClass}"` : ''}>${value}</dd>`,
      )
      .join('');

    // Stage list
    const stageList = byId('flightStages');
    let html = '';
    vessel.stages.forEach((stage, stageIndex) => {
      const fired = stageIndex < vessel.stageIndex;
      // the last stage fired is still burning while the current burn has Δv left
      const burning = fired && stageIndex === vessel.stageIndex - 1 && liveVacuumStats.current.deltaV > 0.5;
      const className = burning ? 'burning' : fired ? 'done' : stageIndex === vessel.stageIndex ? 'next' : '';
      const engineCount = stage.engines.length;
      const what = [];
      if (stage.decouple) {
        what.push('Decouple' + (stage.decouplers.length > 1 ? ' ×' + stage.decouplers.length : ''));
      }
      if (stage.ignite) {
        what.push('Ignite ' + engineCount + ' engine' + (engineCount > 1 ? 's' : ''));
      }
      if (stage.chutes) {
        what.push('Parachutes');
      }
      const stageStats = burning
        ? liveVacuumStats.current
        : !fired
          ? liveVacuumStats.events[stageIndex - vessel.stageIndex]
          : null;
      const deltaVText = stageStats && stageStats.deltaV > 0.5 ? stageStats.deltaV.toFixed(0) + ' m/s' : '';
      html += `<li class="${className}"><div class="stage-number"><span>Stage ${stageIndex + 1}</span><span>${deltaVText}</span></div><div class="what">${what.join(' · ')}</div></li>`;
    });
    stageList.innerHTML = html || '<li class="done"><div class="what">No stages</div></li>';

    // SAS buttons
    document.querySelectorAll('.stability-assist-button').forEach((button) => {
      const mode = button.dataset.mode;
      if (mode === 'toggle') {
        button.classList.toggle('on', vessel.stabilityAssist);
      } else {
        button.classList.toggle('on', vessel.stabilityAssist && vessel.stabilityAssistMode === mode);
        button.disabled = mode === 'maneuver' && !game.node;
      }
    });

    byId('recoverButton').hidden = !(vessel.landed && body === Flatspace.root && vessel.stats.launched);
    hud.updateNode(game);
  };

  hud.updateNode = (game) => {
    const node = game.node;
    byId('nodePanel').hidden = !node;
    document.querySelector('.data-panel').hidden = !!node;
    if (!node) {
      return;
    }
    byId('nodePrograde').textContent = node.prograde.toFixed(1);
    byId('nodeRadial').textContent = node.radial.toFixed(1);
    byId('nodeTime').textContent = 'T−' + Flatspace.formatTime(node.time - game.time, false);
    const rows = [];
    const remaining = node.remaining ? Vector.length(node.remaining) : Math.hypot(node.prograde, node.radial);
    rows.push(['Δv remaining', remaining.toFixed(1) + ' m/s']);
    const burnSeconds = game.burnTime(remaining);
    rows.push(['Burn time', isFinite(burnSeconds) ? Flatspace.formatDuration(burnSeconds) : 'no thrust']);
    rows.push([
      'Start burn in',
      Flatspace.formatTime(node.time - game.time - (isFinite(burnSeconds) ? burnSeconds / 2 : 0), false),
    ]);
    const patches = game.nodePatches;
    if (patches && patches[0]) {
      const orbit = patches[0].orbit;
      const body = patches[0].body;
      rows.push([
        'New apoapsis',
        orbit.eccentricity < 1 ? Flatspace.formatDistance(orbit.apoapsis - body.radius) : 'escape',
      ]);
      rows.push(['New periapsis', Flatspace.formatDistance(orbit.periapsis - body.radius)]);
      const encounter = patches.find((patch) => patch.end === 'encounter');
      if (encounter) {
        rows.push(['Encounter', encounter.next.name]);
      }
    }
    byId('nodeInfo').innerHTML = rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('');
  };

  // ---- Attitude dial (a 2D navball) ----
  function drawDial(game) {
    const vessel = game.vessel;
    const context = dialContext;
    const SIZE = 200;
    const centreX = 100;
    const centreY = 100;
    const ballRadius = 92;
    context.clearRect(0, 0, SIZE, SIZE);
    const radial = Vector.angle(vessel.position);
    const rollOffset = radial - Math.PI / 2;
    const toScreen = (angle) => -(angle - rollOffset); // world angle → canvas angle (y down)

    context.save();
    context.beginPath();
    context.arc(centreX, centreY, ballRadius, 0, Flatspace.TAU);
    context.clip();
    const skyGradient = context.createLinearGradient(0, centreY - ballRadius, 0, centreY);
    skyGradient.addColorStop(0, '#1d5fa6');
    skyGradient.addColorStop(1, '#3f8fd6');
    context.fillStyle = skyGradient;
    context.fillRect(0, 0, SIZE, centreY);
    const groundGradient = context.createLinearGradient(0, centreY, 0, centreY + ballRadius);
    groundGradient.addColorStop(0, '#8a5a2e');
    groundGradient.addColorStop(1, '#4a2f17');
    context.fillStyle = groundGradient;
    context.fillRect(0, centreY, SIZE, SIZE - centreY);
    context.strokeStyle = 'rgba(255,255,255,0.85)';
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(0, centreY);
    context.lineTo(SIZE, centreY);
    context.stroke();
    // inner shading
    const shine = context.createRadialGradient(centreX - 30, centreY - 30, 10, centreX, centreY, ballRadius);
    shine.addColorStop(0, 'rgba(255,255,255,0.12)');
    shine.addColorStop(1, 'rgba(0,0,0,0.45)');
    context.fillStyle = shine;
    context.fillRect(0, 0, SIZE, SIZE);
    context.restore();

    // pitch ticks every 10°, labels every 30°
    context.font = '600 9px "IBM Plex Mono", monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (let degreesMark = 0; degreesMark < 360; degreesMark += 10) {
      const angle = (degreesMark * Math.PI) / 180;
      const long = degreesMark % 30 === 0;
      const innerRadius = ballRadius - (long ? 9 : 5);
      context.strokeStyle = 'rgba(255,255,255,0.7)';
      context.lineWidth = long ? 1.5 : 1;
      context.beginPath();
      context.moveTo(centreX + Math.cos(angle) * innerRadius, centreY + Math.sin(angle) * innerRadius);
      context.lineTo(centreX + Math.cos(angle) * ballRadius, centreY + Math.sin(angle) * ballRadius);
      context.stroke();
      if (long && degreesMark % 90 !== 0) {
        const pitch =
          degreesMark <= 180
            ? degreesMark <= 90
              ? -degreesMark
              : -(180 - degreesMark)
            : degreesMark <= 270
              ? degreesMark - 180
              : 360 - degreesMark;
        context.fillStyle = 'rgba(255,255,255,0.75)';
        context.fillText(
          String(pitch),
          centreX + Math.cos(angle) * (ballRadius - 18),
          centreY + Math.sin(angle) * (ballRadius - 18),
        );
      }
    }

    // markers on the rim
    const surfaceMode = hud.surfaceMode(vessel);
    const velocity = surfaceMode
      ? Vector.subtract(vessel.velocity, Flatspace.airVelocity(vessel.body, vessel.position))
      : vessel.velocity;
    const markerRadius = ballRadius - 30;
    const pointAt = (angle) => ({
      x: centreX + Math.cos(toScreen(angle)) * markerRadius,
      y: centreY + Math.sin(toScreen(angle)) * markerRadius,
    });
    if (Vector.length(velocity) > 0.5) {
      const velocityAngle = Vector.angle(velocity);
      const progradePoint = pointAt(velocityAngle);
      context.strokeStyle = '#ffd84a';
      context.lineWidth = 2;
      context.beginPath();
      context.arc(progradePoint.x, progradePoint.y, 7, 0, Flatspace.TAU);
      context.stroke();
      context.beginPath();
      context.arc(progradePoint.x, progradePoint.y, 1.8, 0, Flatspace.TAU);
      context.fillStyle = '#ffd84a';
      context.fill();
      for (const index of [0, 1, 2]) {
        const markerAngle = [-Math.PI / 2, 0, Math.PI][index];
        context.beginPath();
        context.moveTo(
          progradePoint.x + Math.cos(markerAngle) * 7,
          progradePoint.y + Math.sin(markerAngle) * 7,
        );
        context.lineTo(
          progradePoint.x + Math.cos(markerAngle) * 11,
          progradePoint.y + Math.sin(markerAngle) * 11,
        );
        context.stroke();
      }
      const retrogradePoint = pointAt(velocityAngle + Math.PI);
      context.beginPath();
      context.arc(retrogradePoint.x, retrogradePoint.y, 7, 0, Flatspace.TAU);
      context.stroke();
      context.beginPath();
      context.moveTo(retrogradePoint.x - 4, retrogradePoint.y - 4);
      context.lineTo(retrogradePoint.x + 4, retrogradePoint.y + 4);
      context.moveTo(retrogradePoint.x + 4, retrogradePoint.y - 4);
      context.lineTo(retrogradePoint.x - 4, retrogradePoint.y + 4);
      context.stroke();
    }
    if (game.node && game.node.remaining && Vector.length(game.node.remaining) > 0.05) {
      const nodePoint = pointAt(Vector.angle(game.node.remaining));
      context.strokeStyle = '#6fa3ff';
      context.lineWidth = 2.2;
      context.beginPath();
      context.arc(nodePoint.x, nodePoint.y, 8, 0, Flatspace.TAU);
      context.stroke();
      context.beginPath();
      context.moveTo(nodePoint.x, nodePoint.y - 12);
      context.lineTo(nodePoint.x, nodePoint.y - 8);
      context.moveTo(nodePoint.x - 12, nodePoint.y);
      context.lineTo(nodePoint.x - 8, nodePoint.y);
      context.moveTo(nodePoint.x + 12, nodePoint.y);
      context.lineTo(nodePoint.x + 8, nodePoint.y);
      context.stroke();
    }

    // vessel heading needle
    const headingAngle = toScreen(vessel.angle);
    context.save();
    context.translate(centreX, centreY);
    context.rotate(headingAngle);
    context.strokeStyle = '#ffb547';
    context.lineWidth = 3;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(-14, 0);
    context.lineTo(ballRadius - 34, 0);
    context.stroke();
    context.fillStyle = '#ffb547';
    context.beginPath();
    context.moveTo(ballRadius - 24, 0);
    context.lineTo(ballRadius - 36, -7);
    context.lineTo(ballRadius - 36, 7);
    context.closePath();
    context.fill();
    context.restore();
    context.fillStyle = '#ffb547';
    context.beginPath();
    context.arc(centreX, centreY, 4, 0, Flatspace.TAU);
    context.fill();

    // bezel
    context.strokeStyle = 'rgba(20,28,48,1)';
    context.lineWidth = 5;
    context.beginPath();
    context.arc(centreX, centreY, ballRadius + 2, 0, Flatspace.TAU);
    context.stroke();
    context.strokeStyle = 'rgba(160,190,240,0.5)';
    context.lineWidth = 1;
    context.beginPath();
    context.arc(centreX, centreY, ballRadius + 5, 0, Flatspace.TAU);
    context.stroke();

    // pitch readout
    const pitch = (Flatspace.wrapAngle(vessel.angle - radial) * 180) / Math.PI;
    const elevation = 90 - Math.abs(pitch);
    context.font = '600 11px "IBM Plex Mono", monospace';
    context.fillStyle = 'rgba(5,8,16,0.75)';
    context.fillRect(centreX - 28, centreY + 22, 56, 16);
    context.fillStyle = '#fff';
    context.fillText(elevation.toFixed(0) + '°', centreX, centreY + 30.5);
  }
})();
