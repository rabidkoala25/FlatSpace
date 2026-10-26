// data/parts.js — stats for every part, kept apart from code so packs can add more later.
// Masses in kg, lengths in metres, thrust in newtons, torque in N·m.
// dragArea = drag coefficient × area (m²). crash = crash tolerance (m/s).
// An 'id' is stored in saved craft: never change one without adding a migration in js/save.js.
window.Flatspace = window.Flatspace || {};
Flatspace.DATA = Flatspace.DATA || {};

Flatspace.DATA.parts = [
  { id: 'lark', name: 'Lark Capsule', category: 'Command', mass: 840, length: 1.3, width: 1.25, topWidth: 0.5, dragArea: 0.5, torque: 10000, crash: 14, command: true, crew: 1,
    description: 'One-seat capsule with a built-in reaction wheel.' },
  { id: 'sparrow', name: 'Sparrow Probe Core', category: 'Command', mass: 100, length: 0.45, width: 0.625, dragArea: 0.15, torque: 2000, crash: 12, command: true,
    description: 'Uncrewed guidance unit. Light, weak reaction wheel.' },
  { id: 'canopy', name: 'Canopy Parachute', category: 'Utility', mass: 100, length: 0.45, width: 0.6, dragArea: 0.15, crash: 12, chute: { halfOpen: 25, full: 1100 },
    description: 'Arms on staging. Semi-deploys in thick air, opens fully below 1 km.' },
  { id: 't100', name: 'Ferro Short Tank', category: 'Fuel', mass: 62.5, fuel: 500, length: 0.5, width: 1.25, dragArea: 0.25, crash: 8, stretch: true,
    description: 'Small liquid fuel tank.' },
  { id: 't400', name: 'Ferro Medium Tank', category: 'Fuel', mass: 250, fuel: 2000, length: 2, width: 1.25, dragArea: 0.3, crash: 8, stretch: true,
    description: 'Medium liquid fuel tank.' },
  { id: 't800', name: 'Ferro Long Tank', category: 'Fuel', mass: 500, fuel: 4000, length: 4, width: 1.25, dragArea: 0.35, crash: 8, stretch: true,
    description: 'Long liquid fuel tank.' },
  { id: 'x160', name: 'Ferro Heavy Tank', category: 'Fuel', mass: 2000, fuel: 16000, length: 4, width: 2.5, dragArea: 1.2, crash: 8, foam: true, stretch: true,
    description: 'Heavy 2.5 m tank for big first stages.' },
  { id: 'kestrel', name: 'Kestrel Engine', category: 'Engines', mass: 1500, length: 1.6, width: 1.25, dragArea: 0.3, crash: 9,
    engine: { vacuumThrust: 215000, seaLevelThrust: 167970, vacuumSpecificImpulse: 320, seaLevelSpecificImpulse: 250, gimbal: 3 }, description: 'Steerable lifter engine.' },
  { id: 'hornet', name: 'Hornet Engine', category: 'Engines', mass: 1250, length: 1.5, width: 1.25, dragArea: 0.3, crash: 9,
    engine: { vacuumThrust: 240000, seaLevelThrust: 205160, vacuumSpecificImpulse: 310, seaLevelSpecificImpulse: 265, gimbal: 0 }, description: 'Strong at sea level, no gimbal.' },
  { id: 'wren', name: 'Wren Engine', category: 'Engines', mass: 500, length: 1.1, width: 1.25, dragArea: 0.25, crash: 9, vacuum: true,
    engine: { vacuumThrust: 60000, seaLevelThrust: 14780, vacuumSpecificImpulse: 345, seaLevelSpecificImpulse: 85, gimbal: 4 }, description: 'Efficient upper stage engine. Weak in air.' },
  { id: 'gnat', name: 'Gnat Engine', category: 'Engines', mass: 130, length: 0.5, width: 0.625, dragArea: 0.1, crash: 9,
    engine: { vacuumThrust: 20000, seaLevelThrust: 16560, vacuumSpecificImpulse: 320, seaLevelSpecificImpulse: 265, gimbal: 3 }, description: 'Tiny engine for probes and landers.' },
  { id: 'bulwark', name: 'Bulwark 2.5 m Engine', category: 'Engines', mass: 6000, length: 3.2, width: 2.5, dragArea: 1.0, crash: 9,
    engine: { vacuumThrust: 1500000, seaLevelThrust: 1379030, vacuumSpecificImpulse: 310, seaLevelSpecificImpulse: 285, gimbal: 2 }, description: 'Heavy first-stage engine.' },
  { id: 'rumbler', name: 'Rumbler Solid Booster', category: 'Engines', mass: 750, solid: 2810, length: 3.6, width: 1.25, dragArea: 0.3, crash: 9,
    engine: { vacuumThrust: 227000, seaLevelThrust: 197900, vacuumSpecificImpulse: 195, seaLevelSpecificImpulse: 170, gimbal: 0, solid: true }, description: 'Burns to empty once lit. Cannot throttle.' },
  { id: 'decoupler', name: 'Stack Decoupler', category: 'Structural', mass: 40, length: 0.25, width: 'auto', dragArea: 0.05, crash: 9, decoupler: true,
    description: 'Splits the rocket into stages.' },
  { id: 'sidedecoupler', name: 'Side Decoupler', category: 'Structural', mass: 50, length: 0.6, width: 0.3, dragArea: 0.05, crash: 9, decoupler: true, radial: true,
    description: 'Holds a side booster and lets it go on staging.' },
  { id: 'adapter', name: 'Taper Adapter', category: 'Structural', mass: 120, length: 1.0, width: 2.5, topWidth: 1.25, dragArea: 0.2, crash: 8,
    description: 'Joins 1.25 m parts on top of 2.5 m parts.' },
  { id: 'sweptfin', name: 'Swept Fin', category: 'Structural', mass: 40, length: 1.0, width: 0.55, dragArea: 0.02, crash: 8, fin: 0.8, radial: true,
    description: 'A single fin for the side of a tank. Place them in mirrored pairs; tilt them to spin or steer.' },
  { id: 'fins', name: 'Tail Fin Collar', category: 'Structural', mass: 80, length: 0.7, width: 1.25, dragArea: 0.15, crash: 8, fin: 1.6,
    description: 'Keeps the rocket pointed into the airflow.' },
];

// Fuel tanks in the tray. Every tank can be stretched in 0.25 m steps and set to any of the
// six widths; these presets cover every stock KSP tank (see PARTS.md), each built from a base
// tank type above. All tanks hold 640 kg of fuel per metre of length per square metre of
// width², and weigh an eighth of their fuel when empty, so presets and stretched tanks agree.
Flatspace.DATA.tankPresets = [
  { name: 'Pip Tank', base: 't100', length: 0.5, size: 0.625, kerbalEquivalent: 'Oscar-B' },
  { name: 'Pip Long Tank', base: 't100', length: 1, size: 0.625, kerbalEquivalent: 'small 0.625 m tanks' },
  { name: 'Ferro Short Tank', base: 't100', length: 0.5, size: 1.25, kerbalEquivalent: 'FL-T100' },
  { name: 'Ferro Small Tank', base: 't400', length: 1, size: 1.25, kerbalEquivalent: 'FL-T200' },
  { name: 'Ferro Medium Tank', base: 't400', length: 2, size: 1.25, kerbalEquivalent: 'FL-T400' },
  { name: 'Ferro Long Tank', base: 't800', length: 4, size: 1.25, kerbalEquivalent: 'FL-T800' },
  { name: 'Ferro XL Tank 1 m', base: 't800', length: 1, size: 1.875, kerbalEquivalent: 'FL-TX220' },
  { name: 'Ferro XL Tank 2 m', base: 't800', length: 2, size: 1.875, kerbalEquivalent: 'FL-TX440' },
  { name: 'Ferro XL Tank 4 m', base: 't800', length: 4, size: 1.875, kerbalEquivalent: 'FL-TX900' },
  { name: 'Ferro XL Tank 8 m', base: 't800', length: 8, size: 1.875, kerbalEquivalent: 'FL-TX1800' },
  { name: 'Heavy Tank 1 m', base: 'x160', length: 1, size: 2.5, kerbalEquivalent: 'X200-8' },
  { name: 'Heavy Tank 2 m', base: 'x160', length: 2, size: 2.5, kerbalEquivalent: 'X200-16' },
  { name: 'Ferro Heavy Tank', base: 'x160', length: 4, size: 2.5, kerbalEquivalent: 'X200-32' },
  { name: 'Heavy Tank 8 m', base: 'x160', length: 8, size: 2.5, kerbalEquivalent: 'Jumbo-64' },
  { name: 'Titan Tank 2 m', base: 'x160', length: 2, size: 3.75, kerbalEquivalent: 'S3-3600' },
  { name: 'Titan Tank 4 m', base: 'x160', length: 4, size: 3.75, kerbalEquivalent: 'S3-7200' },
  { name: 'Titan Tank 8 m', base: 'x160', length: 8, size: 3.75, kerbalEquivalent: 'S3-14400' },
  { name: 'Colossus Tank 2 m', base: 'x160', length: 2, size: 5, kerbalEquivalent: 'S4-64' },
  { name: 'Colossus Tank 4 m', base: 'x160', length: 4, size: 5, kerbalEquivalent: 'S4-128' },
  { name: 'Colossus Tank 8 m', base: 'x160', length: 8, size: 5, kerbalEquivalent: 'S4-256' },
  { name: 'Colossus Tank 16 m', base: 'x160', length: 16, size: 5, kerbalEquivalent: 'S4-512' },
];

// Sample craft shown in the hangar's Load menu: 'parts' is a stack of part ids (top to
// bottom); 'tree' is a full part tree for craft with side-mounted parts.
Flatspace.DATA.sampleCraft = [
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
    {"id": "sidedecoupler", "parent": 7, "node": "surface", "x": 0.775, "y": -11.125},
    {"id": "rumbler", "parent": 9, "node": "surface", "x": 1.55, "y": -11.125},
    {"id": "sidedecoupler", "parent": 7, "node": "surface", "x": -0.775, "y": -11.125},
    {"id": "rumbler", "parent": 11, "node": "surface", "x": -1.55, "y": -11.125}
  ] },
];
