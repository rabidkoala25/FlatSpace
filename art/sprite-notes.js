// art/sprite-notes.js — drawing notes for every part, shown in sprite-guide.html.
//
// Every part in data/parts.js needs an entry here (tests/test_sprite_notes.js checks).
// When a part is added or changed, add or update its entry in the same step.
//
//   plan:     'draw'      — drawn in Pixilart, saved as art/png/<id>.png
//             'generated' — made in code by js/sprites.js (no drawing needed)
//             'tank'      — made from the tank caps (art/png/tank-125-*.png, tank-250-*.png)
//   when:     which session or day it's scheduled for
//   box:      optional { w, h, note } in metres, when the sprite's box isn't just the
//             part's width × length (fins, for example)
//   profile:  the part's outline from top to bottom, in words
//   features: what to draw
//   improve:  ideas for later
window.FS = window.FS || {};
FS.SPRITE_NOTES = {
  lark: {
    plan: 'draw',
    when: 'Mon 26 Oct (Terra)',
    profile: 'A cone: 0.25 m half-width at the top widening evenly to 0.625 m at the bottom, with a heat-shield lip in the bottom 2 rows.',
    features: [
      'Grey hull (metal 4–5) with 1–2 faint panel lines running down the cone',
      'Heat shield: the bottom 2 rows in earth 2–3, slightly darker at the very edge',
      'One round window left of centre, about 4 px across: blue 5 with a single blue 7 glint pixel',
      'Docking ring or hatch at the top: 1–2 rows of metal 6–7',
      'A few RCS port dots (metal 1) on the sides',
    ],
    improve: [
      'Lit window at night (B3 adds lit windows)',
      'Scorched heat shield after reentry (B2 stretch: damage and scorch states)',
      'A face in the window once astronauts exist (H1)',
    ],
  },
  sparrow: {
    plan: 'generated',
    when: 'Mon 26 Oct (Terra), from profile() plus decals',
    profile: 'Almost a cylinder: the top is 80% of the bottom width (0.25 m half-width at the top, 0.31 m at the bottom).',
    features: [
      'Gold foil body (gold 2–3) with a few gold 4 crinkle pixels',
      'Blue status light (blue 6) as a 2 × 1 px stripe in the middle',
      'Antenna: the old art has a 0.5 m antenna above the top, which does not fit in the sprite box. Draw it as 1 px inside the top rows for now',
    ],
    improve: [
      'Let sprites stick out of their box (an origin offset per sprite), so the antenna can be full height',
      'Blinking status light (B5)',
    ],
  },
  canopy: {
    plan: 'generated',
    when: 'Mon 26 Oct (Terra), from profile() plus decals',
    profile: 'A rounded dome: a point at the top curving out to the full 0.3 m half-width at the bottom.',
    features: [
      'Orange cover (orange 3–4), lighter towards the top',
      'White strap down the middle (metal 7), 2 px wide',
      'Dark base ring in the bottom row (metal 1–2)',
    ],
    improve: [
      'Packed, armed and deployed states (B4 builds the canopy from segments, C3 adds the physics)',
      'Redraw the open canopy, which is still the baked chute sprite',
    ],
  },
  t100: {
    plan: 'tank',
    when: 'Sun 25 Oct (Session 2): the tank-125 caps',
    profile: 'A straight cylinder, 0.625 m half-width, any length in 0.25 m (4 px) steps.',
    features: [
      'Top cap: a weld seam row, then a rivet line (every 2nd pixel)',
      'Body slice (4 rows, repeats down the tank): mostly skin 0 with one skin −1 seam row',
      'Bottom cap: rivet line, then a darker band (skin −1 or −2)',
      'Use the skin markers for the hull, so all five skins work from one drawing',
    ],
    improve: [
      'A decal placed once in the middle of long tanks (a logo or stripe that does not repeat)',
      'Frost on cold tanks (E5 adds temperatures)',
    ],
  },
  t400: {
    plan: 'tank',
    when: 'Sun 25 Oct (Session 2): the tank-125 caps',
    profile: 'A straight cylinder, 0.625 m half-width, any length in 0.25 m (4 px) steps.',
    features: ['Same caps as the Ferro Short Tank (tank-125). Nothing extra to draw'],
    improve: ['The white skin\'s dark window panel in the old art could become a once-only decal'],
  },
  t800: {
    plan: 'tank',
    when: 'Sun 25 Oct (Session 2): the tank-125 caps',
    profile: 'A straight cylinder, 0.625 m half-width, any length in 0.25 m (4 px) steps.',
    features: ['Same caps as the Ferro Short Tank (tank-125). Nothing extra to draw'],
    improve: ['Stringers (vertical ribs) on long tanks, as a decal'],
  },
  x160: {
    plan: 'tank',
    when: 'Sun 25 Oct (Session 2): the tank-250 caps',
    profile: 'A straight cylinder, 1.25 m half-width, any length in 0.25 m (4 px) steps. Orange foam by default.',
    features: [
      'Caps 40 px wide: the same idea as tank-125, with room for two rivet lines and a thicker seam',
      'Foam looks best with a little texture: scatter a few skin −1 pixels in the body slice',
    ],
    improve: ['1.875 m, 3.75 m and 5 m tank widths (D5) need their own caps'],
  },
  kestrel: {
    plan: 'draw',
    when: 'Tue 27 Oct (Terra)',
    profile: 'Mount: the top 32% narrows from 0.625 m to 0.47 m half-width. Bell: starts at 0.2 m half-width under the mount and curves out to 0.53 m at the bottom.',
    features: [
      'Dark mount (metal 2–3) with a turbopump and 1–2 pipes, a little asymmetric so it reads as machinery',
      'Gimbal ring between mount and bell (metal 5, 1 row)',
      'Bell in metal 3–4 with a lighter metal 5 lip on the bottom row',
      'Keep the bell\'s wide end in the bottom quarter of the rows: that part glows when the engine fires',
    ],
    improve: [
      'The bell tilts when it steers (it has 3° of gimbal)',
      'Heat tint that stays on the bell for a while after firing (B2: nozzle heat tint)',
    ],
  },
  hornet: {
    plan: 'draw',
    when: 'Sat 24 Oct (Session 1)',
    profile: 'Same shape as the Kestrel, a bit shorter: the mount narrows from 0.625 m to 0.47 m over the top 32%, then the bell curves from 0.2 m out to 0.53 m half-width.',
    features: [
      'Make it look different from the Kestrel: it has no gimbal and is built for sea level, so give it a squat, heavy bell and a bolted mounting plate',
      'Flat base tones (metal 4–5): the lighting adds the shading',
      '1 px outline in metal 0–1',
      'A gold foil band (gold 2) around the top of the bell',
      'Wide end of the bell in the bottom quarter: it glows when firing',
    ],
    improve: ['A sooty bell exit after long burns'],
  },
  wren: {
    plan: 'draw',
    when: 'Tue 27 Oct (Terra)',
    profile: 'A vacuum engine: a short mount (top 25%), then a narrow throat (0.14 m half-width) flaring out to a wide, thin bell (0.5 m) at the bottom.',
    features: [
      'Small dark mount',
      'Long, thin bell: dark metal 2 near the throat getting lighter (metal 4–5) towards the exit, like a radiatively cooled nozzle extension',
      'A bright 1 px exit lip',
    ],
    improve: ['A nozzle extension that slides out once the stage separates'],
  },
  gnat: {
    plan: 'draw',
    when: 'Wed 28 Oct (Terra)',
    profile: 'A tiny engine: the mount narrows over the top 3 rows, then a small bell flares to the full width.',
    features: [
      'At 10 × 8 px every pixel counts: outline, a 1 px mount, a bell and a 1 px lip',
      'Leave out fine detail. Readability matters more than realism at this size',
    ],
    improve: ['Clusters of four (a multi-mount part, D5)'],
  },
  bulwark: {
    plan: 'generated',
    when: 'Mon 26 Oct (Terra), from profile() plus decals',
    profile: 'Like the Kestrel but 2.5 m wide and 3.2 m long: the mount narrows over the top 32%, then a large bell curves out to near full width.',
    features: [
      'Big turbopumps and pipe runs on the mount: the most detailed engine, so it reads as the heavy lifter',
      'Bell in metal 3–4 with bands every few rows',
      'If you\'d rather draw it than generate it, a hand-drawn art/png/bulwark.png takes priority automatically',
    ],
    improve: ['Four-nozzle variant for the biggest first stages (D5)'],
  },
  rumbler: {
    plan: 'generated',
    when: 'Mon 26 Oct (Terra), from profile() plus decals',
    profile: 'A straight 0.625 m half-width casing for the top 88%, then a small nozzle (0.22 to 0.34 m half-width) in the bottom 12%.',
    features: [
      'White casing (metal 6–7)',
      'Three red bands (orange 2, about 2 px each) at 12%, 40% and 68% of the length',
      'Dark nozzle (metal 1–2)',
    ],
    improve: ['The casing looks scorched once the booster burns out', 'Smoke trail (B4)'],
  },
  decoupler: {
    plan: 'generated',
    when: 'Sun 25 Oct (Session 2)',
    box: { note: 'The width follows whatever it is attached to (1.25 m or 2.5 m), so it is generated, not drawn.' },
    profile: 'A thin straight band, 0.25 m (4 px) tall.',
    features: [
      'The old art has yellow and black hazard stripes. Session 2 generates it plain (metal 3)',
    ],
    improve: ['Add the hazard stripes back as a decal in the generator (gold 3 and metal 1 diagonals)', 'A separation puff (B4)'],
  },
  radec: {
    plan: 'draw',
    when: 'Thu 29 Oct (Terra)',
    profile: 'A small upright block, 0.15 m half-width.',
    features: ['Hazard stripes (gold 3 and metal 1), on its 5 px width probably as 3 diagonal pixels', 'One bolt (metal 6) in the middle'],
    improve: ['A spring and puff when it fires (B4)'],
  },
  adapter: {
    plan: 'generated',
    when: 'Sun 25 Oct (Session 2)',
    profile: 'A straight cone: 0.625 m half-width at the top to 1.25 m at the bottom.',
    features: ['Generated in metal 5. Rivet rows at the top and bottom edge would be a good first decal'],
    improve: ['Radial panel lines', 'Adapters for the other widths (D5)'],
  },
  sweptfin: {
    plan: 'draw',
    when: 'Thu 29 Oct (Terra)',
    profile: 'The root edge (where it meets the tank) is the full left side. The leading edge sweeps from the top-left corner down to the right side 55% of the way down, then the tip edge runs straight down to the bottom.',
    features: [
      'Blue (blue 2–3) with a lighter leading edge (blue 5)',
      'A grey root fairing (metal 5) down the left column',
      'Draw it with the root on the left; the game mirrors it for the other side',
    ],
    improve: ['Flat shading: the lighting treats each row as a cylinder, which is wrong for a flat fin. Give sprites a flat option'],
  },
  fins: {
    plan: 'draw',
    when: 'Thu 29 Oct (Terra)',
    box: { w: 2.75, h: 0.7, note: 'The 1.25 m collar plus a 0.75 m fin each side. The old fins hang 0.15 m below the collar: keep them flush with the bottom, or the sprite comes out off-centre.' },
    profile: 'A short cylinder collar in the middle; each fin starts at the collar\'s top corner, slopes out to 0.75 m by 75% of the way down, then drops straight to the bottom.',
    features: ['Grey collar (metal 5) with a rivet row', 'Blue fins (blue 2–3) with a 1 px lighter leading edge'],
    improve: ['Let sprites stick out of their box, so the fins can hang below the collar again', 'Flat shading for the fins'],
  },
};
