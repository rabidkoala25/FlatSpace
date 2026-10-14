// parts.js — the part catalogue, how parts are drawn, staging and Δv maths.
(function () {
  const G0 = FS.G0;

  // Masses in kg, lengths in metres, thrust in newtons, torque in N·m.
  // cda = drag coefficient × area (m²). crash = crash tolerance (m/s).
  const PARTS = [
    { id: 'lark', name: 'Lark Capsule', cat: 'Command', mass: 840, len: 1.3, w: 1.25, topW: 0.5, cda: 0.5, torque: 10000, crash: 14, command: true, crew: 1,
      desc: 'One-seat capsule with a built-in reaction wheel.' },
    { id: 'sparrow', name: 'Sparrow Probe Core', cat: 'Command', mass: 100, len: 0.45, w: 0.625, cda: 0.15, torque: 2000, crash: 12, command: true,
      desc: 'Uncrewed guidance unit. Light, weak reaction wheel.' },
    { id: 'canopy', name: 'Canopy Parachute', cat: 'Utility', mass: 100, len: 0.45, w: 0.6, cda: 0.15, crash: 12, chute: { semi: 25, full: 750 },
      desc: 'Arms on staging. Semi-deploys in thick air, opens fully below 1 km.' },
    { id: 't100', name: 'Ferro T-100 Tank', cat: 'Fuel', mass: 62.5, fuel: 500, len: 0.75, w: 1.25, cda: 0.25, crash: 8,
      desc: 'Small liquid fuel tank.' },
    { id: 't400', name: 'Ferro T-400 Tank', cat: 'Fuel', mass: 250, fuel: 2000, len: 1.9, w: 1.25, cda: 0.3, crash: 8,
      desc: 'Medium liquid fuel tank.' },
    { id: 't800', name: 'Ferro T-800 Tank', cat: 'Fuel', mass: 500, fuel: 4000, len: 3.75, w: 1.25, cda: 0.35, crash: 8,
      desc: 'Long liquid fuel tank.' },
    { id: 'x160', name: 'Ferro X-160 Tank', cat: 'Fuel', mass: 2000, fuel: 16000, len: 7.5, w: 2.5, cda: 1.2, crash: 8, foam: true,
      desc: 'Heavy 2.5 m tank for big first stages.' },
    { id: 'kestrel', name: 'Kestrel LV-30 Engine', cat: 'Engines', mass: 1500, len: 1.6, w: 1.25, cda: 0.3, crash: 9,
      engine: { vac: 215000, asl: 167970, ispVac: 320, ispAsl: 250, gimbal: 3 }, desc: 'Steerable lifter engine.' },
    { id: 'hornet', name: 'Hornet LV-45 Engine', cat: 'Engines', mass: 1250, len: 1.5, w: 1.25, cda: 0.3, crash: 9,
      engine: { vac: 240000, asl: 205160, ispVac: 310, ispAsl: 265, gimbal: 0 }, desc: 'Strong at sea level, no gimbal.' },
    { id: 'wren', name: 'Wren LV-909 Engine', cat: 'Engines', mass: 500, len: 1.1, w: 1.25, cda: 0.25, crash: 9, vacuum: true,
      engine: { vac: 60000, asl: 14780, ispVac: 345, ispAsl: 85, gimbal: 4 }, desc: 'Efficient upper stage engine. Weak in air.' },
    { id: 'gnat', name: 'Gnat Engine', cat: 'Engines', mass: 130, len: 0.5, w: 0.625, cda: 0.1, crash: 9,
      engine: { vac: 20000, asl: 16560, ispVac: 320, ispAsl: 265, gimbal: 3 }, desc: 'Tiny engine for probes and landers.' },
    { id: 'bulwark', name: 'Bulwark 2.5 m Engine', cat: 'Engines', mass: 6000, len: 3.2, w: 2.5, cda: 1.0, crash: 9,
      engine: { vac: 1500000, asl: 1379030, ispVac: 310, ispAsl: 285, gimbal: 2 }, desc: 'Heavy first-stage engine.' },
    { id: 'thumper', name: 'Thumper Solid Booster', cat: 'Engines', mass: 750, solid: 2810, len: 3.6, w: 1.25, cda: 0.3, crash: 9,
      engine: { vac: 227000, asl: 197900, ispVac: 195, ispAsl: 170, gimbal: 0, solid: true }, desc: 'Burns to empty once lit. Cannot throttle.' },
    { id: 'decoupler', name: 'Stack Decoupler', cat: 'Structural', mass: 40, len: 0.25, w: 'auto', cda: 0.05, crash: 9, decoupler: true,
      desc: 'Splits the rocket into stages.' },
    { id: 'adapter', name: 'Taper Adapter', cat: 'Structural', mass: 120, len: 1.0, w: 2.5, topW: 1.25, cda: 0.2, crash: 8,
      desc: 'Joins 1.25 m parts on top of 2.5 m parts.' },
    { id: 'fins', name: 'Tail Fin Collar', cat: 'Structural', mass: 80, len: 0.7, w: 1.25, cda: 0.15, crash: 8, fin: 1.6,
      desc: 'Keeps the rocket pointed into the airflow.' },
  ];
  const BY_ID = {};
  PARTS.forEach((p) => (BY_ID[p.id] = p));
  FS.PARTS = PARTS;
  FS.PART = BY_ID;
  FS.PART_CATS = ['Command', 'Fuel', 'Engines', 'Structural', 'Utility'];

  // Make live part instances from a list of ids (top → bottom).
  FS.makeParts = (ids) => ids.filter((id) => BY_ID[id]).map((id) => {
    const d = BY_ID[id];
    return { def: d, fuel: d.fuel || 0, solid: d.solid || 0, lit: false, chute: d.chute ? 'stowed' : null };
  });

  FS.partWidth = (parts, i) => {
    const d = parts[i].def;
    if (d.w !== 'auto') return d.w;
    const below = parts[i + 1] ? FS.partWidth(parts, i + 1) : 0;
    const above = parts[i - 1] ? (parts[i - 1].def.w === 'auto' ? 1.25 : parts[i - 1].def.w) : 0;
    return Math.max(below, above, 0.625);
  };
  FS.partTopWidth = (parts, i) => {
    const d = parts[i].def;
    return d.topW || FS.partWidth(parts, i);
  };

  FS.partMass = (p) => p.def.mass + p.fuel + p.solid;

  // Split a part list into segments at decouplers. Segment 0 is the bottom one;
  // a decoupler goes with the segment below it (it falls away with it).
  FS.segmentsOf = (parts) => {
    const segs = [];
    let cur = [];
    for (let i = parts.length - 1; i >= 0; i--) {
      cur.unshift(parts[i]);
      if (parts[i].def.decoupler && i > 0) { segs.push(cur); cur = []; }
    }
    if (cur.length) segs.push(cur);
    return segs;
  };

  // The staging sequence for a part list: an ordered list of events.
  FS.stagesOf = (parts) => {
    const segs = FS.segmentsOf(parts);
    const ev = [];
    segs.forEach((seg, i) => {
      const engines = seg.filter((p) => p.def.engine);
      const e = { seg: i, decouple: i > 0, ignite: engines.length > 0, parts: [] };
      if (i > 0) e.parts.push(...segs[i - 1].filter((p) => p.def.decoupler));
      e.parts.push(...engines);
      if (e.decouple || e.ignite) ev.push(e);
    });
    if (parts.some((p) => p.def.chute)) ev.push({ chutes: true, parts: parts.filter((p) => p.def.chute) });
    return ev;
  };

  // Engine thrust and mass flow at a given pressure (atm).
  FS.engineThrust = (eng, p, throttle = 1) => {
    const mdot = (eng.vac / (eng.ispVac * G0)) * throttle;
    const isp = Math.max(0, eng.ispVac - (eng.ispVac - eng.ispAsl) * p);
    return { F: mdot * isp * G0, mdot, isp };
  };

  // Δv, TWR and burn time for each segment, firing from the bottom.
  // segs: from FS.segmentsOf; p: pressure (atm); g: surface gravity for TWR.
  FS.segmentStats = (segs, p, g) => {
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      let mass = 0;
      for (let j = i; j < segs.length; j++) for (const q of segs[j]) mass += FS.partMass(q);
      const seg = segs[i];
      const groups = [];
      const liquid = seg.filter((q) => q.def.engine && !q.def.engine.solid);
      const liquidFuel = seg.reduce((s, q) => s + q.fuel, 0);
      if (liquid.length && liquidFuel > 0) {
        let mdot = 0, F = 0;
        for (const q of liquid) { const t = FS.engineThrust(q.def.engine, p); mdot += t.mdot; F += t.F; }
        groups.push({ mdot, F, fuel: liquidFuel });
      }
      for (const q of seg) {
        if (q.def.engine && q.def.engine.solid && q.solid > 0) {
          const t = FS.engineThrust(q.def.engine, p);
          groups.push({ mdot: t.mdot, F: t.F, fuel: q.solid });
        }
      }
      const F0 = groups.reduce((s, gq) => s + gq.F, 0);
      let m = mass, dv = 0, time = 0;
      for (let guard = 0; guard < 10; guard++) {
        const act = groups.filter((gq) => gq.fuel > 1e-6);
        if (!act.length) break;
        const tmin = Math.min(...act.map((gq) => gq.fuel / gq.mdot));
        const md = act.reduce((s, gq) => s + gq.mdot, 0);
        const F = act.reduce((s, gq) => s + gq.F, 0);
        const m1 = m - md * tmin;
        if (F > 0) dv += (F / md) * Math.log(m / m1);
        act.forEach((gq) => (gq.fuel -= gq.mdot * tmin));
        m = m1; time += tmin;
      }
      out.push({ dv, time, twr: F0 / (mass * g), mass, thrust: F0 });
    }
    return out;
  };

  // ---- Drawing ----
  // Draw one part in a context whose units are metres, x centred, y pointing
  // down the rocket. px = size of one screen pixel in metres.
  function cyl(ctx, x0, x1, base, light, dark) {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, dark); g.addColorStop(0.35, light); g.addColorStop(0.55, base); g.addColorStop(1, dark);
    return g;
  }

  FS.drawPart = (ctx, parts, i, y, px, opts = {}) => {
    const p = parts[i];
    const d = p.def;
    const w = FS.partWidth(parts, i);
    const tw = FS.partTopWidth(parts, i);
    const h = d.len;
    const hw = w / 2, thw = tw / 2;
    ctx.lineWidth = px * 1.2;
    ctx.strokeStyle = 'rgba(10,14,22,0.75)';
    ctx.lineJoin = 'round';

    const trap = (topHalf, botHalf, yy, hh) => {
      ctx.beginPath();
      ctx.moveTo(-topHalf, yy); ctx.lineTo(topHalf, yy); ctx.lineTo(botHalf, yy + hh); ctx.lineTo(-botHalf, yy + hh); ctx.closePath();
    };

    if (d.id === 'lark') {
      trap(thw, hw, y, h);
      ctx.fillStyle = cyl(ctx, -hw, hw, '#6d737c', '#a7adb6', '#3a3f46'); ctx.fill(); ctx.stroke();
      // heat shield lip
      ctx.fillStyle = '#5a3d2a'; ctx.fillRect(-hw, y + h - 0.12, w, 0.12);
      // window
      ctx.beginPath(); ctx.arc(-0.08, y + h * 0.45, 0.15, 0, FS.TAU);
      ctx.fillStyle = '#9fd8ff'; ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e9edf2'; ctx.fillRect(-thw * 0.6, y - 0.08, thw * 1.2, 0.1);
    } else if (d.id === 'sparrow') {
      trap(hw * 0.8, hw, y, h);
      ctx.fillStyle = cyl(ctx, -hw, hw, '#c9a24a', '#f0d690', '#7a5d22'); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hw * 0.4, y); ctx.lineTo(hw * 0.4, y - 0.5); ctx.strokeStyle = '#ccc'; ctx.lineWidth = px * 1.5; ctx.stroke();
      ctx.fillStyle = '#5ec6ff'; ctx.fillRect(-0.12, y + h * 0.35, 0.24, 0.1);
    } else if (d.id === 'canopy') {
      ctx.beginPath();
      ctx.moveTo(-hw, y + h); ctx.quadraticCurveTo(-hw, y, 0, y); ctx.quadraticCurveTo(hw, y, hw, y + h); ctx.closePath();
      ctx.fillStyle = cyl(ctx, -hw, hw, '#d8642b', '#f0955c', '#8d3a15');
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#f2efe8'; ctx.fillRect(-hw * 0.25, y + h * 0.15, hw * 0.5, h * 0.85);
    } else if (d.fuel) {
      ctx.beginPath(); ctx.rect(-hw, y, w, h);
      if (d.foam) ctx.fillStyle = cyl(ctx, -hw, hw, '#c46a2c', '#e8995b', '#7a3c14');
      else ctx.fillStyle = cyl(ctx, -hw, hw, '#d9d6cc', '#fbfaf5', '#8e8b82');
      ctx.fill(); ctx.stroke();
      const band = Math.min(0.14, h * 0.12);
      ctx.fillStyle = d.foam ? 'rgba(80,40,15,0.6)' : '#c8692b';
      ctx.fillRect(-hw, y, w, band); ctx.fillRect(-hw, y + h - band, w, band);
      if (!d.foam && h > 1) { ctx.fillStyle = 'rgba(40,50,70,0.55)'; ctx.fillRect(-hw * 0.15, y + h * 0.3, hw * 0.3, h * 0.4); }
      // fuel gauge overlay
      if (opts.showFuel && d.fuel) {
        const f = p.fuel / d.fuel;
        ctx.fillStyle = 'rgba(255,190,80,0.18)';
        ctx.fillRect(-hw, y + h * (1 - f), w, h * f);
      }
    } else if (d.engine && d.engine.solid) {
      ctx.beginPath(); ctx.rect(-hw, y, w, h * 0.88);
      ctx.fillStyle = cyl(ctx, -hw, hw, '#e6e3db', '#ffffff', '#8f8c85'); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#b8342a';
      for (let k = 0; k < 3; k++) ctx.fillRect(-hw, y + h * (0.12 + k * 0.28), w, 0.12);
      trap(hw * 0.35, hw * 0.55, y + h * 0.88, h * 0.12);
      ctx.fillStyle = '#3b3e44'; ctx.fill(); ctx.stroke();
    } else if (d.engine) {
      const mountH = h * (d.vacuum ? 0.25 : 0.32);
      trap(thw, hw * 0.75, y, mountH);
      ctx.fillStyle = cyl(ctx, -hw, hw, '#50555d', '#848a93', '#2c2f34'); ctx.fill(); ctx.stroke();
      const nTop = d.vacuum ? hw * 0.22 : hw * 0.32;
      const nBot = d.vacuum ? hw * 0.8 : hw * 0.85;
      ctx.beginPath();
      ctx.moveTo(-nTop, y + mountH);
      ctx.lineTo(nTop, y + mountH);
      ctx.quadraticCurveTo(nTop * 1.05, y + h * 0.7, nBot, y + h);
      ctx.lineTo(-nBot, y + h);
      ctx.quadraticCurveTo(-nTop * 1.05, y + h * 0.7, -nTop, y + mountH);
      ctx.closePath();
      ctx.fillStyle = cyl(ctx, -nBot, nBot, '#3d4046', '#9aa0a8', '#202226'); ctx.fill(); ctx.stroke();
      if (opts.glow > 0) {
        ctx.fillStyle = `rgba(255,150,60,${0.5 * opts.glow})`;
        ctx.fillRect(-nBot * 0.8, y + h - 0.12, nBot * 1.6, 0.1);
      }
    } else if (d.decoupler) {
      ctx.save();
      ctx.beginPath(); ctx.rect(-hw, y, w, h); ctx.clip();
      ctx.fillStyle = '#e8c33a'; ctx.fillRect(-hw, y, w, h);
      ctx.fillStyle = '#23252a';
      for (let x = -hw - h; x < hw; x += 0.3) {
        ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + 0.15, y + h); ctx.lineTo(x + 0.15 + h, y); ctx.lineTo(x + h, y); ctx.fill();
      }
      ctx.restore();
      ctx.beginPath(); ctx.rect(-hw, y, w, h); ctx.stroke();
    } else if (d.id === 'adapter') {
      trap(thw, hw, y, h);
      ctx.fillStyle = cyl(ctx, -hw, hw, '#a9adb3', '#d9dce0', '#5f646b'); ctx.fill(); ctx.stroke();
    } else if (d.fin) {
      ctx.beginPath(); ctx.rect(-hw, y, w, h);
      ctx.fillStyle = cyl(ctx, -hw, hw, '#8d939b', '#c3c8ce', '#4b5057'); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#2f5d8a';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * hw, y); ctx.lineTo(s * (hw + 0.75), y + h * 0.75); ctx.lineTo(s * (hw + 0.75), y + h + 0.15); ctx.lineTo(s * hw, y + h);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    } else {
      ctx.fillStyle = '#888'; ctx.fillRect(-hw, y, w, h);
    }
    if (opts.selected) {
      ctx.strokeStyle = '#ffb547'; ctx.lineWidth = px * 2.5;
      ctx.setLineDash([px * 6, px * 4]);
      ctx.strokeRect(-Math.max(hw, thw) - px * 4, y - px * 3, Math.max(w, tw) + px * 8, h + px * 6);
      ctx.setLineDash([]);
    }
  };

  // Layout: y offset of each part's top, measured from the top of the stack.
  FS.stackLayout = (parts) => {
    let y = 0;
    const tops = [];
    let massSum = 0, momentSum = 0;
    for (const p of parts) {
      tops.push(y);
      const m = FS.partMass(p);
      massSum += m;
      momentSum += m * (y + p.def.len / 2);
      y += p.def.len;
    }
    const com = massSum > 0 ? momentSum / massSum : y / 2;
    // moment of inertia about the centre of mass
    let I = 0;
    parts.forEach((p, i) => {
      const m = FS.partMass(p);
      const d = tops[i] + p.def.len / 2 - com;
      I += m * (d * d + (p.def.len * p.def.len) / 12);
    });
    return { tops, height: y, com, mass: massSum, I: Math.max(I, 1) };
  };

  // Sample craft
  FS.SAMPLE_CRAFT = [
    { name: 'Hopper', parts: ['canopy', 'lark', 't400', 'fins', 'hornet'] },
    { name: 'Orbiter I', parts: ['canopy', 'lark', 'decoupler', 't400', 't100', 'wren', 'decoupler', 't800', 't800', 'fins', 'kestrel'] },
    { name: 'Mira Voyager', parts: ['canopy', 'lark', 'decoupler', 't800', 't400', 'wren', 'decoupler', 't800', 't800', 'kestrel', 'decoupler', 'adapter', 'x160', 'x160', 'bulwark'] },
  ];
})();
