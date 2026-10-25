// hud.js — flight instruments: attitude dial, readouts, stage list, node panel.
(function () {
  const Vector = FS.vec;
  const hud = (FS.HUD = {});
  const byId = (elementId) => document.getElementById(elementId);
  let dial;
  let dctx;
  let textTimer = 0;

  hud.init = () => {
    dial = byId('dial');
    dctx = dial.getContext('2d');
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    dial.width = 200 * pixelRatio;
    dial.height = 200 * pixelRatio;
    dctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  };

  // Whether speed is shown relative to the surface or the orbit (KSP-style auto switch).
  hud.surfaceMode = (vessel) => {
    if (vessel.landed) {
      return true;
    }
    const body = vessel.body;
    return vessel.altitude < (body.atmo ? body.atmo.height * 0.5 : 10000);
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
    const time = game.t;
    const altitude = vessel.altitude;
    byId('hAlt').textContent = FS.fmtDist(altitude);
    byId('hMET').textContent = (vessel.stats.launched ? 'T+ ' : 'T− ') + FS.fmtTime(time - game.launchT);
    const rate = game.effectiveRate();
    byId('hWarp').textContent = rate + '×' + (game.onRails ? '' : rate > 1 ? ' phys' : '');
    byId('hWarp').style.color = rate > 1 ? 'var(--amber)' : '';
    byId('hSit').textContent = vessel.situation();

    const surf = hud.surfaceMode(vessel);
    const vSurf = Vector.sub(vessel.v, FS.airVel(body, vessel.r));
    byId('hSpdMode').textContent = surf ? 'Surface' : 'Orbit';
    byId('hSpd').textContent = FS.fmtSpeed(Vector.len(surf ? vSurf : vessel.v));
    byId('gThrottle').style.height = (vessel.throttle * 100).toFixed(0) + '%';

    // Stage stats (live)
    const pressure = FS.pressure(body, altitude);
    const gHere = body.mu / Vector.dot(vessel.r, vessel.r);
    // What's burning now (current) and each stage still to fire (events), here and in vacuum
    const live = FS.stageStats(vessel.parts, vessel.stages, vessel.stageIdx, pressure, gHere);
    const liveVac = FS.stageStats(vessel.parts, vessel.stages, vessel.stageIdx, 0, gHere);
    const nowStats =
      live.current.dv > 0 ? live.current : live.events.find((event) => event.dv > 0) || live.current;
    const fuel = vessel.stageFuel();
    byId('gFuel').style.height = (fuel.max > 0 ? (fuel.now / fuel.max) * 100 : 0).toFixed(0) + '%';

    // Flight data
    const orbit = FS.orbitFromState(vessel.r, vessel.v, body.mu, time);
    const rows = [];
    const orbitInfo = !vessel.landed;
    if (orbitInfo) {
      if (orbit.e < 1) {
        rows.push(
          ['Apoapsis', FS.fmtDist(orbit.ap - body.R), 'orb'],
          ['Time to Ap', FS.fmtTime(FS.timeToNu(orbit, Math.PI, time)), 'orb'],
        );
      } else {
        rows.push(['Apoapsis', 'escape', 'orb']);
      }
      rows.push(['Periapsis', FS.fmtDist(orbit.pe - body.R), orbit.pe < body.R ? 'warn' : 'orb']);
      rows.push(['Time to Pe', FS.fmtTime(FS.timeToNu(orbit, 0, time)), 'orb']);
      if (orbit.e < 1) {
        rows.push(['Period', FS.fmtTime(orbit.period), 'orb']);
      }
    }
    const rhat = Vector.norm(vessel.r);
    rows.push(['Vertical speed', FS.fmtSpeed(Vector.dot(vSurf, rhat))]);
    rows.push(['Horizontal speed', FS.fmtSpeed(Math.abs(Vector.cross(rhat, vSurf)))]);
    const longitude = FS.lonAt(body, Vector.angle(vessel.r), time);
    rows.push([
      'Above terrain',
      FS.fmtDist(Math.max(0, altitude - FS.surfaceHeight(body, longitude) - vessel.bottomDist)),
    ]);
    rows.push(['Stage Δv', nowStats.dv.toFixed(0) + ' m/s']);
    rows.push(['Total Δv (vac)', liveVac.total.toFixed(0) + ' m/s']);
    rows.push([
      'TWR',
      (vessel.thrustNow / (vessel.mass * gHere)).toFixed(2) + ' / ' + nowStats.twr.toFixed(2),
    ]);
    rows.push(['Mass', (vessel.mass / 1000).toFixed(2) + ' t']);
    if (body.atmo) {
      rows.push(['Pressure', pressure.toFixed(3) + ' atm']);
      rows.push(['Dynamic pressure', (vessel.q / 1000).toFixed(1) + ' kPa']);
    }
    rows.push(['G-force', (vessel.gForce || 0).toFixed(2) + ' g']);
    if (vessel.flameout) {
      rows.push(['Engines', 'flameout', 'warn']);
    }
    byId('fData').innerHTML = rows
      .map(
        ([label, value, cssClass]) =>
          `<dt>${label}</dt><dd${cssClass ? ` class="${cssClass}"` : ''}>${value}</dd>`,
      )
      .join('');

    // Stage list
    const stageList = byId('fStages');
    let html = '';
    vessel.stages.forEach((stage, stageIndex) => {
      const fired = stageIndex < vessel.stageIdx;
      // the last stage fired is still burning while the current burn has Δv left
      const burning = fired && stageIndex === vessel.stageIdx - 1 && liveVac.current.dv > 0.5;
      const className = burning ? 'burning' : fired ? 'done' : stageIndex === vessel.stageIdx ? 'next' : '';
      const nEng = stage.engines.length;
      const what = [];
      if (stage.decouple) {
        what.push('Decouple' + (stage.decouplers.length > 1 ? ' ×' + stage.decouplers.length : ''));
      }
      if (stage.ignite) {
        what.push('Ignite ' + nEng + ' engine' + (nEng > 1 ? 's' : ''));
      }
      if (stage.chutes) {
        what.push('Parachutes');
      }
      const stageStats = burning
        ? liveVac.current
        : !fired
          ? liveVac.events[stageIndex - vessel.stageIdx]
          : null;
      const deltaVText = stageStats && stageStats.dv > 0.5 ? stageStats.dv.toFixed(0) + ' m/s' : '';
      html += `<li class="${className}"><div class="sn"><span>Stage ${stageIndex + 1}</span><span>${deltaVText}</span></div><div class="what">${what.join(' · ')}</div></li>`;
    });
    stageList.innerHTML = html || '<li class="done"><div class="what">No stages</div></li>';

    // SAS buttons
    document.querySelectorAll('.sasbtn').forEach((button) => {
      const mode = button.dataset.mode;
      if (mode === 'toggle') {
        button.classList.toggle('on', vessel.sas);
      } else {
        button.classList.toggle('on', vessel.sas && vessel.sasMode === mode);
        button.disabled = mode === 'maneuver' && !game.node;
      }
    });

    byId('btnRecover').hidden = !(vessel.landed && body === FS.root && vessel.stats.launched);
    hud.updateNode(game);
  };

  hud.updateNode = (game) => {
    const node = game.node;
    byId('nodePanel').hidden = !node;
    document.querySelector('.data-panel').hidden = !!node;
    if (!node) {
      return;
    }
    byId('nPro').textContent = node.pro.toFixed(1);
    byId('nRad').textContent = node.rad.toFixed(1);
    byId('nT').textContent = 'T−' + FS.fmtTime(node.t - game.t, false);
    const rows = [];
    const remaining = node.remaining ? Vector.len(node.remaining) : Math.hypot(node.pro, node.rad);
    rows.push(['Δv remaining', remaining.toFixed(1) + ' m/s']);
    const burnSeconds = game.burnTime(remaining);
    rows.push(['Burn time', isFinite(burnSeconds) ? FS.fmtDuration(burnSeconds) : 'no thrust']);
    rows.push([
      'Start burn in',
      FS.fmtTime(node.t - game.t - (isFinite(burnSeconds) ? burnSeconds / 2 : 0), false),
    ]);
    const patches = game.nodePatches;
    if (patches && patches[0]) {
      const orbit = patches[0].orbit;
      const body = patches[0].body;
      rows.push(['New apoapsis', orbit.e < 1 ? FS.fmtDist(orbit.ap - body.R) : 'escape']);
      rows.push(['New periapsis', FS.fmtDist(orbit.pe - body.R)]);
      const encounter = patches.find((patch) => patch.end === 'encounter');
      if (encounter) {
        rows.push(['Encounter', encounter.next.name]);
      }
    }
    byId('nInfo').innerHTML = rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('');
  };

  // ---- Attitude dial (a 2D navball) ----
  function drawDial(game) {
    const vessel = game.vessel;
    const context = dctx;
    const SIZE = 200;
    const centreX = 100;
    const centreY = 100;
    const ballRadius = 92;
    context.clearRect(0, 0, SIZE, SIZE);
    const radial = Vector.angle(vessel.r);
    const rollOffset = radial - Math.PI / 2;
    const toScreen = (angle) => -(angle - rollOffset); // world angle → canvas angle (y down)

    context.save();
    context.beginPath();
    context.arc(centreX, centreY, ballRadius, 0, FS.TAU);
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
    const surf = hud.surfaceMode(vessel);
    const velocity = surf ? Vector.sub(vessel.v, FS.airVel(vessel.body, vessel.r)) : vessel.v;
    const markerRadius = ballRadius - 30;
    const pointAt = (angle) => ({
      x: centreX + Math.cos(toScreen(angle)) * markerRadius,
      y: centreY + Math.sin(toScreen(angle)) * markerRadius,
    });
    if (Vector.len(velocity) > 0.5) {
      const velocityAngle = Vector.angle(velocity);
      const progradePoint = pointAt(velocityAngle);
      context.strokeStyle = '#ffd84a';
      context.lineWidth = 2;
      context.beginPath();
      context.arc(progradePoint.x, progradePoint.y, 7, 0, FS.TAU);
      context.stroke();
      context.beginPath();
      context.arc(progradePoint.x, progradePoint.y, 1.8, 0, FS.TAU);
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
      context.arc(retrogradePoint.x, retrogradePoint.y, 7, 0, FS.TAU);
      context.stroke();
      context.beginPath();
      context.moveTo(retrogradePoint.x - 4, retrogradePoint.y - 4);
      context.lineTo(retrogradePoint.x + 4, retrogradePoint.y + 4);
      context.moveTo(retrogradePoint.x + 4, retrogradePoint.y - 4);
      context.lineTo(retrogradePoint.x - 4, retrogradePoint.y + 4);
      context.stroke();
    }
    if (game.node && game.node.remaining && Vector.len(game.node.remaining) > 0.05) {
      const nodePoint = pointAt(Vector.angle(game.node.remaining));
      context.strokeStyle = '#6fa3ff';
      context.lineWidth = 2.2;
      context.beginPath();
      context.arc(nodePoint.x, nodePoint.y, 8, 0, FS.TAU);
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
    context.arc(centreX, centreY, 4, 0, FS.TAU);
    context.fill();

    // bezel
    context.strokeStyle = 'rgba(20,28,48,1)';
    context.lineWidth = 5;
    context.beginPath();
    context.arc(centreX, centreY, ballRadius + 2, 0, FS.TAU);
    context.stroke();
    context.strokeStyle = 'rgba(160,190,240,0.5)';
    context.lineWidth = 1;
    context.beginPath();
    context.arc(centreX, centreY, ballRadius + 5, 0, FS.TAU);
    context.stroke();

    // pitch readout
    const pitch = (FS.wrapAngle(vessel.angle - radial) * 180) / Math.PI;
    const elevation = 90 - Math.abs(pitch);
    context.font = '600 11px "IBM Plex Mono", monospace';
    context.fillStyle = 'rgba(5,8,16,0.75)';
    context.fillRect(centreX - 28, centreY + 22, 56, 16);
    context.fillStyle = '#fff';
    context.fillText(elevation.toFixed(0) + '°', centreX, centreY + 30.5);
  }
})();
