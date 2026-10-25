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

  const hexRGB = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const ramps = {};
  const all = [];
  for (const [name, list] of Object.entries(RAMPS)) {
    ramps[name] = list.map(hexRGB);
    for (const colour of ramps[name]) {
      all.push(colour);
    }
  }

  // 4×4 Bayer matrix: thresholds in (0, 1) for ordered dithering.
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => (value + 0.5) / 16);
  const bayer = (pixelX, pixelY) => BAYER[(((pixelY % 4) + 4) % 4) * 4 + (((pixelX % 4) + 4) % 4)];

  // The palette colour closest to an RGB colour, weighted roughly for the eye; cached.
  const near = new Map();
  function nearest(red, green, blue) {
    const key = ((red >> 2) << 12) | ((green >> 2) << 6) | (blue >> 2);
    let hit = near.get(key);
    if (hit) {
      return hit;
    }
    let best = all[0];
    let bestDistance = Infinity;
    for (const colour of all) {
      const meanRed = (colour[0] + red) / 2;
      const deltaRed = colour[0] - red;
      const deltaGreen = colour[1] - green;
      const deltaBlue = colour[2] - blue;
      const distance =
        (2 + meanRed / 256) * deltaRed * deltaRed +
        4 * deltaGreen * deltaGreen +
        (2 + (255 - meanRed) / 256) * deltaBlue * deltaBlue;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = colour;
      }
    }
    near.set(key, best);
    return best;
  }

  // Pick from a ramp at position t in [0, 1], dithering between the two nearest entries
  // with the Bayer threshold at pixel (x, y).
  function dither(ramp, fraction, pixelX, pixelY) {
    const position = Math.min(Math.max(fraction, 0), 1) * (ramp.length - 1);
    const index = Math.floor(position);
    return position - index > bayer(pixelX, pixelY)
      ? ramp[Math.min(index + 1, ramp.length - 1)]
      : ramp[index];
  }

  // Turn an antialiased drawing into pixel art in place: every pixel becomes either fully
  // transparent or fully opaque, and opaque pixels take the nearest palette colour.
  function snapImage(image, alphaCut = 0.4) {
    const pixels = image.data;
    const alphaLimit = alphaCut * 255;
    for (let byte = 0; byte < pixels.length; byte += 4) {
      const alpha = pixels[byte + 3];
      if (alpha < alphaLimit) {
        pixels[byte] = pixels[byte + 1] = pixels[byte + 2] = pixels[byte + 3] = 0;
        continue;
      }
      // un-premultiply partial pixels so edges keep their colour
      const unpremultiply = alpha < 255 ? 255 / alpha : 1;
      const colour = nearest(
        Math.min(255, pixels[byte] * unpremultiply),
        Math.min(255, pixels[byte + 1] * unpremultiply),
        Math.min(255, pixels[byte + 2] * unpremultiply),
      );
      pixels[byte] = colour[0];
      pixels[byte + 1] = colour[1];
      pixels[byte + 2] = colour[2];
      pixels[byte + 3] = 255;
    }
    return image;
  }

  const toCss = (colour) => `rgb(${colour[0]},${colour[1]},${colour[2]})`;

  FS.Palette = { ramps, all, hex: RAMPS, BAYER, bayer, nearest, dither, snapImage, css: toCss };
})();
