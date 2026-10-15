// Versioned saves: prototype saves load and upgrade; new saves are wrapped with a version.
const { loadGame, check, done } = require('./lib');
const FS = loadGame();

// A save written by the prototype (version 0: no wrapper, old part id).
localStorage.setItem('flatspace.current', JSON.stringify({ name: 'Old', parts: ['lark', 'thumper'] }));
localStorage.setItem('flatspace.crafts', JSON.stringify({ Old: ['canopy', 'lark', 'thumper'] }));
localStorage.setItem('flatspace.milestones', JSON.stringify(['launch', 'space']));

const cur = FS.store.load('flatspace.current', null);
check(cur && cur.parts.join() === 'lark,rumbler', 'prototype current craft loads with the renamed booster');
const crafts = FS.store.load('flatspace.crafts', {});
check(crafts.Old && crafts.Old.join() === 'canopy,lark,rumbler', 'prototype saved craft loads with the renamed booster');
check(FS.store.load('flatspace.milestones', []).join() === 'launch,space', 'prototype milestones load unchanged');

// Saving writes the current version.
FS.store.save('flatspace.crafts', crafts);
const raw = JSON.parse(localStorage.getItem('flatspace.crafts'));
check(raw.v === FS.SAVE_VERSIONS['flatspace.crafts'] && raw.data.Old, 'saves are wrapped with their format version');
check(FS.store.load('flatspace.crafts', {}).Old.join() === 'canopy,lark,rumbler', 'a saved craft reloads unchanged');

// Data from a newer version of the game is not misread.
localStorage.setItem('flatspace.crafts', JSON.stringify({ v: 99, data: {} }));
check(FS.store.load('flatspace.crafts', 'fallback') === 'fallback', 'a save from a newer version falls back safely');

// Missing data gives the fallback.
check(FS.store.load('flatspace.nothing', 42) === 42, 'a missing key gives the fallback');

done();
