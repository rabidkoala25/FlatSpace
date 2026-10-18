// data/parts.js — stats for every part, kept apart from code so packs can add more later.
// Masses in kg, lengths in metres, thrust in newtons, torque in N·m.
// cda = drag coefficient × area (m²). crash = crash tolerance (m/s).
// An 'id' is stored in saved craft: never change one without adding a migration in js/save.js.
window.FS = window.FS || {};
FS.DATA = FS.DATA || {};

FS.DATA.parts = [
  { id: 'lark', name: 'Lark Capsule', cat: 'Command', mass: 840, len: 1.3, w: 1.25, topW: 0.5, cda: 0.5, torque: 10000, crash: 14, command: true, crew: 1,
    desc: 'One-seat capsule with a built-in reaction wheel.' },
  { id: 'sparrow', name: 'Sparrow Probe Core', cat: 'Command', mass: 100, len: 0.45, w: 0.625, cda: 0.15, torque: 2000, crash: 12, command: true,
    desc: 'Uncrewed guidance unit. Light, weak reaction wheel.' },
  { id: 'canopy', name: 'Canopy Parachute', cat: 'Utility', mass: 100, len: 0.45, w: 0.6, cda: 0.15, crash: 12, chute: { semi: 25, full: 1100 },
    desc: 'Arms on staging. Semi-deploys in thick air, opens fully below 1 km.' },
  { id: 't100', name: 'Ferro Short Tank', cat: 'Fuel', mass: 62.5, fuel: 500, len: 0.5, w: 1.25, cda: 0.25, crash: 8, stretch: true,
    desc: 'Small liquid fuel tank.' },
  { id: 't400', name: 'Ferro Medium Tank', cat: 'Fuel', mass: 250, fuel: 2000, len: 2, w: 1.25, cda: 0.3, crash: 8, stretch: true,
    desc: 'Medium liquid fuel tank.' },
  { id: 't800', name: 'Ferro Long Tank', cat: 'Fuel', mass: 500, fuel: 4000, len: 4, w: 1.25, cda: 0.35, crash: 8, stretch: true,
    desc: 'Long liquid fuel tank.' },
  { id: 'x160', name: 'Ferro Heavy Tank', cat: 'Fuel', mass: 2000, fuel: 16000, len: 4, w: 2.5, cda: 1.2, crash: 8, foam: true, stretch: true,
    desc: 'Heavy 2.5 m tank for big first stages.' },
  { id: 'kestrel', name: 'Kestrel Engine', cat: 'Engines', mass: 1500, len: 1.6, w: 1.25, cda: 0.3, crash: 9,
    engine: { vac: 215000, asl: 167970, ispVac: 320, ispAsl: 250, gimbal: 3 }, desc: 'Steerable lifter engine.' },
  { id: 'hornet', name: 'Hornet Engine', cat: 'Engines', mass: 1250, len: 1.5, w: 1.25, cda: 0.3, crash: 9,
    engine: { vac: 240000, asl: 205160, ispVac: 310, ispAsl: 265, gimbal: 0 }, desc: 'Strong at sea level, no gimbal.' },
  { id: 'wren', name: 'Wren Engine', cat: 'Engines', mass: 500, len: 1.1, w: 1.25, cda: 0.25, crash: 9, vacuum: true,
    engine: { vac: 60000, asl: 14780, ispVac: 345, ispAsl: 85, gimbal: 4 }, desc: 'Efficient upper stage engine. Weak in air.' },
  { id: 'gnat', name: 'Gnat Engine', cat: 'Engines', mass: 130, len: 0.5, w: 0.625, cda: 0.1, crash: 9,
    engine: { vac: 20000, asl: 16560, ispVac: 320, ispAsl: 265, gimbal: 3 }, desc: 'Tiny engine for probes and landers.' },
  { id: 'bulwark', name: 'Bulwark 2.5 m Engine', cat: 'Engines', mass: 6000, len: 3.2, w: 2.5, cda: 1.0, crash: 9,
    engine: { vac: 1500000, asl: 1379030, ispVac: 310, ispAsl: 285, gimbal: 2 }, desc: 'Heavy first-stage engine.' },
  { id: 'rumbler', name: 'Rumbler Solid Booster', cat: 'Engines', mass: 750, solid: 2810, len: 3.6, w: 1.25, cda: 0.3, crash: 9,
    engine: { vac: 227000, asl: 197900, ispVac: 195, ispAsl: 170, gimbal: 0, solid: true }, desc: 'Burns to empty once lit. Cannot throttle.' },
  { id: 'decoupler', name: 'Stack Decoupler', cat: 'Structural', mass: 40, len: 0.25, w: 'auto', cda: 0.05, crash: 9, decoupler: true,
    desc: 'Splits the rocket into stages.' },
  { id: 'radec', name: 'Side Decoupler', cat: 'Structural', mass: 50, len: 0.6, w: 0.3, cda: 0.05, crash: 9, decoupler: true, radial: true,
    desc: 'Holds a side booster and lets it go on staging.' },
  { id: 'adapter', name: 'Taper Adapter', cat: 'Structural', mass: 120, len: 1.0, w: 2.5, topW: 1.25, cda: 0.2, crash: 8,
    desc: 'Joins 1.25 m parts on top of 2.5 m parts.' },
  { id: 'sweptfin', name: 'Swept Fin', cat: 'Structural', mass: 40, len: 1.0, w: 0.55, cda: 0.02, crash: 8, fin: 0.8, radial: true,
    desc: 'A single fin for the side of a tank. Place them in mirrored pairs; tilt them to spin or steer.' },
  { id: 'fins', name: 'Tail Fin Collar', cat: 'Structural', mass: 80, len: 0.7, w: 1.25, cda: 0.15, crash: 8, fin: 1.6,
    desc: 'Keeps the rocket pointed into the airflow.' },
];

// Fuel tanks in the tray. Every tank can be stretched in 0.25 m steps and set to any of the
// six widths; these presets cover every stock KSP tank (see PARTS.md), each built from a base
// tank type above. All tanks hold 640 kg of fuel per metre of length per square metre of
// width², and weigh an eighth of their fuel when empty, so presets and stretched tanks agree.
FS.DATA.tankPresets = [
  { name: 'Pip Tank', base: 't100', len: 0.5, size: 0.625, ksp: 'Oscar-B' },
  { name: 'Pip Long Tank', base: 't100', len: 1, size: 0.625, ksp: 'small 0.625 m tanks' },
  { name: 'Ferro Short Tank', base: 't100', len: 0.5, size: 1.25, ksp: 'FL-T100' },
  { name: 'Ferro Small Tank', base: 't400', len: 1, size: 1.25, ksp: 'FL-T200' },
  { name: 'Ferro Medium Tank', base: 't400', len: 2, size: 1.25, ksp: 'FL-T400' },
  { name: 'Ferro Long Tank', base: 't800', len: 4, size: 1.25, ksp: 'FL-T800' },
  { name: 'Ferro XL Tank 1 m', base: 't800', len: 1, size: 1.875, ksp: 'FL-TX220' },
  { name: 'Ferro XL Tank 2 m', base: 't800', len: 2, size: 1.875, ksp: 'FL-TX440' },
  { name: 'Ferro XL Tank 4 m', base: 't800', len: 4, size: 1.875, ksp: 'FL-TX900' },
  { name: 'Ferro XL Tank 8 m', base: 't800', len: 8, size: 1.875, ksp: 'FL-TX1800' },
  { name: 'Heavy Tank 1 m', base: 'x160', len: 1, size: 2.5, ksp: 'X200-8' },
  { name: 'Heavy Tank 2 m', base: 'x160', len: 2, size: 2.5, ksp: 'X200-16' },
  { name: 'Ferro Heavy Tank', base: 'x160', len: 4, size: 2.5, ksp: 'X200-32' },
  { name: 'Heavy Tank 8 m', base: 'x160', len: 8, size: 2.5, ksp: 'Jumbo-64' },
  { name: 'Titan Tank 2 m', base: 'x160', len: 2, size: 3.75, ksp: 'S3-3600' },
  { name: 'Titan Tank 4 m', base: 'x160', len: 4, size: 3.75, ksp: 'S3-7200' },
  { name: 'Titan Tank 8 m', base: 'x160', len: 8, size: 3.75, ksp: 'S3-14400' },
  { name: 'Colossus Tank 2 m', base: 'x160', len: 2, size: 5, ksp: 'S4-64' },
  { name: 'Colossus Tank 4 m', base: 'x160', len: 4, size: 5, ksp: 'S4-128' },
  { name: 'Colossus Tank 8 m', base: 'x160', len: 8, size: 5, ksp: 'S4-256' },
  { name: 'Colossus Tank 16 m', base: 'x160', len: 16, size: 5, ksp: 'S4-512' },
];

// Sample craft shown in the hangar's Load menu: 'parts' is a stack of part ids (top to
// bottom); 'tree' is a full part tree for craft with side-mounted parts.
FS.DATA.sampleCraft = [
  { name: 'Hopper', parts: ['canopy', 'lark', 't100', 'fins', 'hornet'] },
  { name: 'Orbiter I', parts: ['canopy', 'lark', 'decoupler', 't400', 't100', 'wren', 'decoupler', 't800', 't800', 'fins', 'kestrel'] },
  { name: 'Mira Voyager', parts: ['canopy', 'lark', 'decoupler', 't800', 't400', 'wren', 'decoupler', 't800', 't800', 'kestrel', 'decoupler', 'adapter', 'x160', 'x160', 'bulwark'] },
  // Built with side boosters on Side Decouplers. 'tree' is a saved part tree (see js/partgraph.js).
  { name: 'Twin Boosters', tree: [
    {"id": "canopy", "parent": -1, "node": "bottom", "x": 0, "y": 0},
    {"id": "lark", "parent": 0, "node": "bottom", "x": 0, "y": -0.875},
    {"id": "decoupler", "parent": 1, "node": "bottom", "x": 0, "y": -1.65},
    {"id": "t400", "parent": 2, "node": "bottom", "x": 0, "y": -2.775},
    {"id": "wren", "parent": 3, "node": "bottom", "x": 0, "y": -4.325},
    {"id": "decoupler", "parent": 4, "node": "bottom", "x": 0, "y": -5},
    {"id": "t800", "parent": 5, "node": "bottom", "x": 0, "y": -7.125},
    {"id": "t800", "parent": 6, "node": "bottom", "x": 0, "y": -11.125},
    {"id": "kestrel", "parent": 7, "node": "bottom", "x": 0, "y": -13.925},
    {"id": "radec", "parent": 7, "node": "srf", "x": 0.775, "y": -11.125},
    {"id": "rumbler", "parent": 9, "node": "srf", "x": 1.55, "y": -11.125},
    {"id": "radec", "parent": 7, "node": "srf", "x": -0.775, "y": -11.125},
    {"id": "rumbler", "parent": 11, "node": "srf", "x": -1.55, "y": -11.125}
  ] },
];
