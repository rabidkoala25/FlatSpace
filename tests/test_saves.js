// Versioned saves: prototype saves load and upgrade; new saves are wrapped with a version.
const { loadGame, check, done } = require('./lib');
const Flatspace = loadGame();

// A save written by the prototype (version 0: no wrapper, old part id).
localStorage.setItem('flatspace.current', JSON.stringify({ name: 'Old', parts: ['lark', 'thumper'] }));
localStorage.setItem('flatspace.crafts', JSON.stringify({ Old: ['canopy', 'lark', 'thumper'] }));
localStorage.setItem('flatspace.milestones', JSON.stringify(['launch', 'space']));

const idsOf = (tree) => tree.map((part) => part.id).join();
const current = Flatspace.store.load('flatspace.current', null);
check(
  current && idsOf(current.parts) === 'lark,rumbler',
  'prototype current craft loads with the renamed booster',
);
check(
  current && current.parts[1].parent === 0 && current.parts[1].node === 'bottom',
  'a prototype stack becomes a part tree (each part below the one above)',
);
check(
  current && Math.abs(current.parts[1].y - -(1.3 / 2 + 3.6 / 2)) < 1e-6,
  'stacked parts get positions from their lengths',
);
const crafts = Flatspace.store.load('flatspace.crafts', {});
check(
  crafts.Old && idsOf(crafts.Old) === 'canopy,lark,rumbler',
  'prototype saved craft loads with the renamed booster',
);
check(
  Flatspace.store.load('flatspace.milestones', []).join() === 'launch,space',
  'prototype milestones load unchanged',
);

// Saving writes the current version.
Flatspace.store.save('flatspace.crafts', crafts);
const stored = JSON.parse(localStorage.getItem('flatspace.crafts'));
check(
  stored.version === Flatspace.SAVE_VERSIONS['flatspace.crafts'] && stored.data.Old,
  'saves are wrapped with their format version',
);
check(
  JSON.stringify(Flatspace.store.load('flatspace.crafts', {}).Old) === JSON.stringify(crafts.Old),
  'a saved craft reloads unchanged',
);

// A version 3 save (before 0.8) used short field names, 'srf' and 'radec'.
localStorage.setItem(
  'flatspace.current',
  JSON.stringify({
    v: 3,
    data: {
      name: 'Short names',
      parts: [
        { id: 'lark', parent: -1, node: 'bottom', x: 0, y: 0 },
        { id: 't800', parent: 0, node: 'bottom', x: 0, y: -2.65, len: 6 },
        { id: 'radec', parent: 1, node: 'srf', x: 0.775, y: -2.65, rot: -1.571, sym: 's1', chuteAlt: 500 },
      ],
    },
  }),
);
const upgraded = Flatspace.store.load('flatspace.current', null);
const sideDecoupler = upgraded && upgraded.parts[2];
check(
  upgraded &&
    upgraded.parts[1].length === 6 &&
    sideDecoupler.id === 'sidedecoupler' &&
    sideDecoupler.node === 'surface' &&
    sideDecoupler.rotation === -1.571 &&
    sideDecoupler.symmetryGroup === 's1' &&
    sideDecoupler.chuteAltitude === 500 &&
    !('rot' in sideDecoupler) &&
    !('len' in upgraded.parts[1]),
  'a version 3 save loads with the full field names',
);
const rebuilt = Flatspace.partsFromSerial(upgraded.parts);
check(
  rebuilt.length === 3 && rebuilt[1].length === 6 && rebuilt[2].node === 'surface',
  '…and builds the same craft',
);

// Data from a newer version of the game is not misread.
localStorage.setItem('flatspace.crafts', JSON.stringify({ v: 99, data: {} }));
check(
  Flatspace.store.load('flatspace.crafts', 'fallback') === 'fallback',
  'a save from a newer version falls back safely',
);

// Missing data gives the fallback.
check(Flatspace.store.load('flatspace.nothing', 42) === 42, 'a missing key gives the fallback');

done();
