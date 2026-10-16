// hud.js — flight instruments: attitude dial, readouts, stage list, node panel.
(function () {
  const V = FS.vec;
  const H = (FS.HUD = {});
  const $ = (id) => document.getElementById(id);
  let dial, dctx, textTimer = 0;

  H.init = () => {
    dial = $('dial');
    dctx = dial.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    dial.width = 200 * dpr; dial.height = 200 * dpr;
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  // Whether speed is shown relative to the surface or the orbit (KSP-style auto switch).
  H.surfaceMode = (ves) => {
    if (ves.landed) return true;
    const b = ves.body;
    return ves.altitude < (b.atmo ? b.atmo.height * 0.5 : 10000);
  };

  H.update = (game, dt) => {
    drawDial(game);
    textTimer -= dt;
    if (textTimer > 0) return;
    textTimer = 0.12;
    const ves = game.vessel;
    const b = ves.body;
    const t = game.t;
    const alt = ves.altitude;
    $('hAlt').textContent = FS.fmtDist(alt);
    $('hMET').textContent = (ves.stats.launched ? 'T+ ' : 'T− ') + FS.fmtTime(t - game.launchT);
    const rate = game.effectiveRate();
    $('hWarp').textContent = rate + '×' + (game.onRails ? '' : rate > 1 ? ' phys' : '');
    $('hWarp').style.color = rate > 1 ? 'var(--amber)' : '';
    $('hSit').textContent = ves.situation();

    const surf = H.surfaceMode(ves);
    const vSurf = V.sub(ves.v, FS.airVel(b, ves.r));
    $('hSpdMode').textContent = surf ? 'Surface' : 'Orbit';
    $('hSpd').textContent = FS.fmtSpeed(V.len(surf ? vSurf : ves.v));
    $('gThrottle').style.height = (ves.throttle * 100).toFixed(0) + '%';

    // Stage stats (live)
    const p = FS.pressure(b, alt);
    const gHere = b.mu / V.dot(ves.r, ves.r);
    // What's burning now (current) and each stage still to fire (events), here and in vacuum
    const live = FS.stageStats(ves.parts, ves.stages, ves.stageIdx, p, gHere);
    const liveVac = FS.stageStats(ves.parts, ves.stages, ves.stageIdx, 0, gHere);
    const nowStats = live.current.dv > 0 ? live.current : live.events.find((e) => e.dv > 0) || live.current;
    const fuel = ves.stageFuel();
    $('gFuel').style.height = (fuel.max > 0 ? (fuel.now / fuel.max) * 100 : 0).toFixed(0) + '%';

    // Flight data
    const o = FS.orbitFromState(ves.r, ves.v, b.mu, t);
    const rows = [];
    const orbitInfo = !ves.landed;
    if (orbitInfo) {
      if (o.e < 1) rows.push(['Apoapsis', FS.fmtDist(o.ap - b.R), 'orb'], ['Time to Ap', FS.fmtTime(FS.timeToNu(o, Math.PI, t)), 'orb']);
      else rows.push(['Apoapsis', 'escape', 'orb']);
      rows.push(['Periapsis', FS.fmtDist(o.pe - b.R), o.pe < b.R ? 'warn' : 'orb']);
      rows.push(['Time to Pe', FS.fmtTime(FS.timeToNu(o, 0, t)), 'orb']);
      if (o.e < 1) rows.push(['Period', FS.fmtTime(o.period), 'orb']);
    }
    const rhat = V.norm(ves.r);
    rows.push(['Vertical speed', FS.fmtSpeed(V.dot(vSurf, rhat))]);
    rows.push(['Horizontal speed', FS.fmtSpeed(Math.abs(V.cross(rhat, vSurf)))]);
    const lon = FS.lonAt(b, V.angle(ves.r), t);
    rows.push(['Above terrain', FS.fmtDist(Math.max(0, alt - FS.surfaceHeight(b, lon) - ves.bottomDist))]);
    rows.push(['Stage Δv', nowStats.dv.toFixed(0) + ' m/s']);
    rows.push(['Total Δv (vac)', liveVac.total.toFixed(0) + ' m/s']);
    rows.push(['TWR', (ves.thrustNow / (ves.mass * gHere)).toFixed(2) + ' / ' + nowStats.twr.toFixed(2)]);
    rows.push(['Mass', (ves.mass / 1000).toFixed(2) + ' t']);
    if (b.atmo) {
      rows.push(['Pressure', p.toFixed(3) + ' atm']);
      rows.push(['Dynamic pressure', (ves.q / 1000).toFixed(1) + ' kPa']);
    }
    rows.push(['G-force', (ves.gForce || 0).toFixed(2) + ' g']);
    if (ves.flameout) rows.push(['Engines', 'flameout', 'warn']);
    $('fData').innerHTML = rows.map(([k, v, c]) => `<dt>${k}</dt><dd${c ? ` class="${c}"` : ''}>${v}</dd>`).join('');

    // Stage list
    const ul = $('fStages');
    let html = '';
    ves.stages.forEach((ev, k) => {
      const fired = k < ves.stageIdx;
      // the last stage fired is still burning while the current burn has Δv left
      const burning = fired && k === ves.stageIdx - 1 && liveVac.current.dv > 0.5;
      const cls = burning ? 'burning' : fired ? 'done' : k === ves.stageIdx ? 'next' : '';
      const nEng = ev.engines.length;
      const what = [];
      if (ev.decouple) what.push('Decouple' + (ev.decouplers.length > 1 ? ' ×' + ev.decouplers.length : ''));
      if (ev.ignite) what.push('Ignite ' + nEng + ' engine' + (nEng > 1 ? 's' : ''));
      if (ev.chutes) what.push('Parachutes');
      const st = burning ? liveVac.current : !fired ? liveVac.events[k - ves.stageIdx] : null;
      const dv = st && st.dv > 0.5 ? st.dv.toFixed(0) + ' m/s' : '';
      html += `<li class="${cls}"><div class="sn"><span>Stage ${k + 1}</span><span>${dv}</span></div><div class="what">${what.join(' · ')}</div></li>`;
    });
    ul.innerHTML = html || '<li class="done"><div class="what">No stages</div></li>';

    // SAS buttons
    document.querySelectorAll('.sasbtn').forEach((btn) => {
      const m = btn.dataset.mode;
      if (m === 'toggle') btn.classList.toggle('on', ves.sas);
      else {
        btn.classList.toggle('on', ves.sas && ves.sasMode === m);
        btn.disabled = m === 'maneuver' && !game.node;
      }
    });

    $('btnRecover').hidden = !(ves.landed && b === FS.root && ves.stats.launched);
    H.updateNode(game);
  };

  H.updateNode = (game) => {
    const nd = game.node;
    $('nodePanel').hidden = !nd;
    document.querySelector('.data-panel').hidden = !!nd;
    if (!nd) return;
    $('nPro').textContent = nd.pro.toFixed(1);
    $('nRad').textContent = nd.rad.toFixed(1);
    $('nT').textContent = 'T−' + FS.fmtTime(nd.t - game.t, false);
    const rows = [];
    const rem = nd.remaining ? V.len(nd.remaining) : Math.hypot(nd.pro, nd.rad);
    rows.push(['Δv remaining', rem.toFixed(1) + ' m/s']);
    const bt = game.burnTime(rem);
    rows.push(['Burn time', isFinite(bt) ? FS.fmtDuration(bt) : 'no thrust']);
    rows.push(['Start burn in', FS.fmtTime(nd.t - game.t - (isFinite(bt) ? bt / 2 : 0), false)]);
    const pp = game.nodePatches;
    if (pp && pp[0]) {
      const o = pp[0].orbit, b = pp[0].body;
      rows.push(['New apoapsis', o.e < 1 ? FS.fmtDist(o.ap - b.R) : 'escape']);
      rows.push(['New periapsis', FS.fmtDist(o.pe - b.R)]);
      const enc = pp.find((x) => x.end === 'encounter');
      if (enc) rows.push(['Encounter', enc.next.name]);
    }
    $('nInfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  };

  // ---- Attitude dial (a 2D navball) ----
  function drawDial(game) {
    const ves = game.vessel;
    const c = dctx;
    const S = 200, cx = 100, cy = 100, Rr = 92;
    c.clearRect(0, 0, S, S);
    const radial = V.angle(ves.r);
    const C = radial - Math.PI / 2;
    const toScreen = (a) => -(a - C); // world angle → canvas angle (y down)

    c.save();
    c.beginPath(); c.arc(cx, cy, Rr, 0, FS.TAU); c.clip();
    const sky = c.createLinearGradient(0, cy - Rr, 0, cy);
    sky.addColorStop(0, '#1d5fa6'); sky.addColorStop(1, '#3f8fd6');
    c.fillStyle = sky; c.fillRect(0, 0, S, cy);
    const gnd = c.createLinearGradient(0, cy, 0, cy + Rr);
    gnd.addColorStop(0, '#8a5a2e'); gnd.addColorStop(1, '#4a2f17');
    c.fillStyle = gnd; c.fillRect(0, cy, S, S - cy);
    c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(0, cy); c.lineTo(S, cy); c.stroke();
    // inner shading
    const sh = c.createRadialGradient(cx - 30, cy - 30, 10, cx, cy, Rr);
    sh.addColorStop(0, 'rgba(255,255,255,0.12)'); sh.addColorStop(1, 'rgba(0,0,0,0.45)');
    c.fillStyle = sh; c.fillRect(0, 0, S, S);
    c.restore();

    // pitch ticks every 10°, labels every 30°
    c.font = '600 9px "IBM Plex Mono", monospace';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 10) {
      const a = (d * Math.PI) / 180;
      const long = d % 30 === 0;
      const r0 = Rr - (long ? 9 : 5);
      c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = long ? 1.5 : 1;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      c.lineTo(cx + Math.cos(a) * Rr, cy + Math.sin(a) * Rr);
      c.stroke();
      if (long && d % 90 !== 0) {
        const pitch = d <= 180 ? (d <= 90 ? -d : -(180 - d)) : (d <= 270 ? d - 180 : 360 - d);
        c.fillStyle = 'rgba(255,255,255,0.75)';
        c.fillText(String(pitch), cx + Math.cos(a) * (Rr - 18), cy + Math.sin(a) * (Rr - 18));
      }
    }

    // markers on the rim
    const surf = H.surfaceMode(ves);
    const vel = surf ? V.sub(ves.v, FS.airVel(ves.body, ves.r)) : ves.v;
    const rm = Rr - 30;
    const at = (a) => ({ x: cx + Math.cos(toScreen(a)) * rm, y: cy + Math.sin(toScreen(a)) * rm });
    if (V.len(vel) > 0.5) {
      const va = V.angle(vel);
      const p1 = at(va);
      c.strokeStyle = '#ffd84a'; c.lineWidth = 2;
      c.beginPath(); c.arc(p1.x, p1.y, 7, 0, FS.TAU); c.stroke();
      c.beginPath(); c.arc(p1.x, p1.y, 1.8, 0, FS.TAU); c.fillStyle = '#ffd84a'; c.fill();
      for (const k of [0, 1, 2]) {
        const aa = [-Math.PI / 2, 0, Math.PI][k];
        c.beginPath(); c.moveTo(p1.x + Math.cos(aa) * 7, p1.y + Math.sin(aa) * 7); c.lineTo(p1.x + Math.cos(aa) * 11, p1.y + Math.sin(aa) * 11); c.stroke();
      }
      const p2 = at(va + Math.PI);
      c.beginPath(); c.arc(p2.x, p2.y, 7, 0, FS.TAU); c.stroke();
      c.beginPath(); c.moveTo(p2.x - 4, p2.y - 4); c.lineTo(p2.x + 4, p2.y + 4); c.moveTo(p2.x + 4, p2.y - 4); c.lineTo(p2.x - 4, p2.y + 4); c.stroke();
    }
    if (game.node && game.node.remaining && V.len(game.node.remaining) > 0.05) {
      const p3 = at(V.angle(game.node.remaining));
      c.strokeStyle = '#6fa3ff'; c.lineWidth = 2.2;
      c.beginPath(); c.arc(p3.x, p3.y, 8, 0, FS.TAU); c.stroke();
      c.beginPath(); c.moveTo(p3.x, p3.y - 12); c.lineTo(p3.x, p3.y - 8); c.moveTo(p3.x - 12, p3.y); c.lineTo(p3.x - 8, p3.y); c.moveTo(p3.x + 12, p3.y); c.lineTo(p3.x + 8, p3.y); c.stroke();
    }

    // vessel heading needle
    const ha = toScreen(ves.angle);
    c.save();
    c.translate(cx, cy);
    c.rotate(ha);
    c.strokeStyle = '#ffb547'; c.lineWidth = 3; c.lineCap = 'round';
    c.beginPath(); c.moveTo(-14, 0); c.lineTo(Rr - 34, 0); c.stroke();
    c.fillStyle = '#ffb547';
    c.beginPath(); c.moveTo(Rr - 24, 0); c.lineTo(Rr - 36, -7); c.lineTo(Rr - 36, 7); c.closePath(); c.fill();
    c.restore();
    c.fillStyle = '#ffb547';
    c.beginPath(); c.arc(cx, cy, 4, 0, FS.TAU); c.fill();

    // bezel
    c.strokeStyle = 'rgba(20,28,48,1)'; c.lineWidth = 5;
    c.beginPath(); c.arc(cx, cy, Rr + 2, 0, FS.TAU); c.stroke();
    c.strokeStyle = 'rgba(160,190,240,0.5)'; c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, Rr + 5, 0, FS.TAU); c.stroke();

    // pitch readout
    const pitch = (FS.wrapAngle(ves.angle - radial) * 180) / Math.PI;
    const el = 90 - Math.abs(pitch);
    c.font = '600 11px "IBM Plex Mono", monospace';
    c.fillStyle = 'rgba(5,8,16,0.75)';
    c.fillRect(cx - 28, cy + 22, 56, 16);
    c.fillStyle = '#fff';
    c.fillText(el.toFixed(0) + '°', cx, cy + 30.5);
  }
})();
