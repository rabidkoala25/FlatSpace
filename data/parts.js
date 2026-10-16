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
  { id: 't100', name: 'Ferro Short Tank', cat: 'Fuel', mass: 62.5, fuel: 500, len: 0.75, w: 1.25, cda: 0.25, crash: 8,
    desc: 'Small liquid fuel tank.' },
  { id: 't400', name: 'Ferro Medium Tank', cat: 'Fuel', mass: 250, fuel: 2000, len: 1.9, w: 1.25, cda: 0.3, crash: 8,
    desc: 'Medium liquid fuel tank.' },
  { id: 't800', name: 'Ferro Long Tank', cat: 'Fuel', mass: 500, fuel: 4000, len: 3.75, w: 1.25, cda: 0.35, crash: 8,
    desc: 'Long liquid fuel tank.' },
  { id: 'x160', name: 'Ferro Heavy Tank', cat: 'Fuel', mass: 2000, fuel: 16000, len: 7.5, w: 2.5, cda: 1.2, crash: 8, foam: true,
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
  { id: 'fins', name: 'Tail Fin Collar', cat: 'Structural', mass: 80, len: 0.7, w: 1.25, cda: 0.15, crash: 8, fin: 1.6,
    desc: 'Keeps the rocket pointed into the airflow.' },
];

// Sample craft shown in the hangar's Load menu: 'parts' is a stack of part ids (top to
// bottom); 'tree' is a full part tree for craft with side-mounted parts.
FS.DATA.sampleCraft = [
  { name: 'Hopper', parts: ['canopy', 'lark', 't400', 'fins', 'hornet'] },
  { name: 'Orbiter I', parts: ['canopy', 'lark', 'decoupler', 't400', 't100', 'wren', 'decoupler', 't800', 't800', 'fins', 'kestrel'] },
  { name: 'Mira Voyager', parts: ['canopy', 'lark', 'decoupler', 't800', 't400', 'wren', 'decoupler', 't800', 't800', 'kestrel', 'decoupler', 'adapter', 'x160', 'x160', 'bulwark'] },
  // Built with side boosters on Side Decouplers. 'tree' is a saved part tree (see js/partgraph.js).
  { name: 'Twin Boosters', tree: [
    {"id": "canopy", "parent": -1, "node": "bottom", "x": 0, "y": 0},
    {"id": "lark", "parent": 0, "node": "bottom", "x": 0, "y": -0.875},
    {"id": "decoupler", "parent": 1, "node": "bottom", "x": 0, "y": -1.65},
    {"id": "t400", "parent": 2, "node": "bottom", "x": 0, "y": -2.725},
    {"id": "wren", "parent": 3, "node": "bottom", "x": 0, "y": -4.225},
    {"id": "decoupler", "parent": 4, "node": "bottom", "x": 0, "y": -4.9},
    {"id": "t800", "parent": 5, "node": "bottom", "x": 0, "y": -6.9},
    {"id": "t800", "parent": 6, "node": "bottom", "x": 0, "y": -10.65},
    {"id": "kestrel", "parent": 7, "node": "bottom", "x": 0, "y": -13.325},
    {"id": "radec", "parent": 7, "node": "srf", "x": 0.775, "y": -10.65},
    {"id": "rumbler", "parent": 9, "node": "srf", "x": 1.55, "y": -10.65},
    {"id": "radec", "parent": 7, "node": "srf", "x": -0.775, "y": -10.65},
    {"id": "rumbler", "parent": 11, "node": "srf", "x": -1.55, "y": -10.65}
  ] },
];
