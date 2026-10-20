// art/palette.js — the game's colours: about 48, arranged as ramps from dark to light.
//
// Every ramp is hue-shifted: the dark end leans cool and purple, the light end warm, which
// is what makes pixel-art shading read as light rather than as "darker paint". Everything
// drawn by the WebGL renderer (baked sprites, sky, planets, particles) uses these colours,
// and gradients are made by ordered dithering between neighbouring entries, never by
// blending into in-between colours.
window.FS = window.FS || {};
(function () {
  const RAMPS = {
    // greys and metals: hull white at the top, deep shadow at the bottom
    metal: ['#0e0d1a', '#1d1c30', '#343449', '#4f5164', '#737683', '#9a9ca3', '#c4c3c2', '#eeeae0'],
    // rust, orange foam, warning paint
    orange: ['#3a1424', '#6e2a2a', '#a5432f', '#d8692f', '#f39a4a', '#ffd08a'],
    // gold foil, warning stripes, sunlight
    gold: ['#4a2f22', '#8a5a24', '#c9922e', '#f0c84a', '#fff0a0'],
    // grass and foliage
    green: ['#182a2e', '#1f4a35', '#2f6d3a', '#5a9440', '#a3c157'],
    // day sky, ocean, ice and windows
    blue: ['#0a1430', '#12204a', '#1a3a75', '#2a5ea8', '#3f86cf', '#6eb2e6', '#a8d8f2', '#e0f4ff'],
    // night sky and deep space
    night: ['#04050c', '#090c1c', '#111a33', '#1c2a4f'],
    // sunset and dusk
    dusk: ['#3c1f45', '#7a3354', '#c0505a', '#e9814f', '#f8b860'],
    // soil, rock and sand
    earth: ['#1c1420', '#33242a', '#523a32', '#765843', '#9c7d5c', '#c4a77c', '#e2d0a2'],
    // the pale teal of Pell
    teal: ['#24403f', '#3c5e5a', '#6f9e92', '#a9d4c4'],
    // fire and beacons
    red: ['#e2402f'],
  };

  const hexRGB = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const ramps = {};
  const all = [];
  for (const [name, list] of Object.entries(RAMPS)) {
    ramps[name] = list.map(hexRGB);
    for (const c of ramps[name]) all.push(c);
  }

  // 4×4 Bayer matrix: thresholds in (0, 1) for ordered dithering.
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const bayer = (x, y) => BAYER[(((y % 4) + 4) % 4) * 4 + (((x % 4) + 4) % 4)];

  // The palette colour closest to an RGB colour, weighted roughly for the eye; cached.
  const near = new Map();
  function nearest(r, g, b) {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let hit = near.get(key);
    if (hit) return hit;
    let best = all[0], bd = Infinity;
    for (const c of all) {
      const rm = (c[0] + r) / 2;
      const dr = c[0] - r, dg = c[1] - g, db = c[2] - b;
      const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
      if (d < bd) { bd = d; best = c; }
    }
    near.set(key, best);
    return best;
  }

  // Pick from a ramp at position t in [0, 1], dithering between the two nearest entries
  // with the Bayer threshold at pixel (x, y).
  function dither(ramp, t, x, y) {
    const f = Math.min(Math.max(t, 0), 1) * (ramp.length - 1);
    const i = Math.floor(f);
    return f - i > bayer(x, y) ? ramp[Math.min(i + 1, ramp.length - 1)] : ramp[i];
  }

  // Turn an antialiased drawing into pixel art in place: every pixel becomes either fully
  // transparent or fully opaque, and opaque pixels take the nearest palette colour.
  function snapImage(img, alphaCut = 0.4) {
    const d = img.data;
    const cut = alphaCut * 255;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a < cut) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; continue; }
      // un-premultiply partial pixels so edges keep their colour
      const k = a < 255 ? 255 / a : 1;
      const c = nearest(Math.min(255, d[i] * k), Math.min(255, d[i + 1] * k), Math.min(255, d[i + 2] * k));
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
    return img;
  }

  const css = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

  FS.Palette = { ramps, all, hex: RAMPS, BAYER, bayer, nearest, dither, snapImage, css };
})();
