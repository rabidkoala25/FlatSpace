// parts.js — part lookup, engine maths and how parts are drawn.
// The part stats live in data/parts.js; the part tree, staging and Δv are in partgraph.js.
(function () {
  const G0 = FS.G0;

  const PARTS = FS.DATA.parts; // stats live in data/parts.js
  const BY_ID = {};
  PARTS.forEach((p) => (BY_ID[p.id] = p));
  FS.PARTS = PARTS;
  FS.PART = BY_ID;
  FS.PART_CATS = ['Command', 'Fuel', 'Engines', 'Structural', 'Utility'];

  FS.partMass = (p) => p.def.mass + p.fuel + p.solid;

  // Engine thrust and mass flow at a given pressure (atm).
  FS.engineThrust = (eng, p, throttle = 1) => {
    const mdot = (eng.vac / (eng.ispVac * G0)) * throttle;
    const isp = Math.max(0, eng.ispVac - (eng.ispVac - eng.ispAsl) * p);
    return { F: mdot * isp * G0, mdot, isp };
  };

  // ---- Drawing ----
  function cyl(ctx, x0, x1, base, light, dark) {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, dark); g.addColorStop(0.35, light); g.addColorStop(0.55, base); g.addColorStop(1, dark);
    return g;
  }

  // Draw part p with its top at y, its axis along +y pointing down the rocket, centred on x = 0.
  // Widths come from FS.relayout (p.w, p.tw). px = size of one screen pixel in metres.
  FS.drawPart = (ctx, p, y, px, opts = {}) => {
    const d = p.def;
    const w = p.w || (d.w === 'auto' ? 1.25 : d.w);
    const tw = p.tw || d.topW || w;
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
    } else if (d.fin && d.radial) {
      // root edge on the left (x = -hw), swept tip on the right
      ctx.beginPath();
      ctx.moveTo(-hw, y); ctx.lineTo(hw, y + h * 0.55); ctx.lineTo(hw, y + h); ctx.lineTo(-hw, y + h); ctx.closePath();
      const g = ctx.createLinearGradient(-hw, 0, hw, 0);
      g.addColorStop(0, '#24496d'); g.addColorStop(0.5, '#3a6f9f'); g.addColorStop(1, '#2f5d8a');
      ctx.fillStyle = g; ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(220,230,240,0.35)'; ctx.fillRect(-hw, y + h * 0.1, w * 0.12, h * 0.85);
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

  // Sample craft
  FS.SAMPLE_CRAFT = FS.DATA.sampleCraft;
})();
