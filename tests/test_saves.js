// Versioned saves: prototype saves load and upgrade; new saves are wrapped with a version.
const { loadGame, check, done } = require('./lib');
const FS = loadGame();

// A save written by the prototype (version 0: no wrapper, old part id).
localStorage.setItem('flatspace.current', JSON.stringify({ name: 'Old', parts: ['lark', 'thumper'] }));
localStorage.setItem('flatspace.crafts', JSON.stringify({ Old: ['canopy', 'lark', 'thumper'] }));
localStorage.setItem('flatspace.milestones', JSON.stringify(['launch', 'space']));

const idsOf = (tree) => tree.map((part) => part.id).join();
const current = FS.store.load('flatspace.current', null);
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
const crafts = FS.store.load('flatspace.crafts', {});
check(
  crafts.Old && idsOf(crafts.Old) === 'canopy,lark,rumbler',
  'prototype saved craft loads with the renamed booster',
);
check(
  FS.store.load('flatspace.milestones', []).join() === 'launch,space',
  'prototype milestones load unchanged',
);

// Saving writes the current version.
FS.store.save('flatspace.crafts', crafts);
const stored = JSON.parse(localStorage.getItem('flatspace.crafts'));
check(
  stored.v === FS.SAVE_VERSIONS['flatspace.crafts'] && stored.data.Old,
  'saves are wrapped with their format version',
);
check(
  JSON.stringify(FS.store.load('flatspace.crafts', {}).Old) === JSON.stringify(crafts.Old),
  'a saved craft reloads unchanged',
);

// Data from a newer version of the game is not misread.
localStorage.setItem('flatspace.crafts', JSON.stringify({ v: 99, data: {} }));
check(
  FS.store.load('flatspace.crafts', 'fallback') === 'fallback',
  'a save from a newer version falls back safely',
);

// Missing data gives the fallback.
check(FS.store.load('flatspace.nothing', 42) === 42, 'a missing key gives the fallback');

done();
