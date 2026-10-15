// data/bodies.js — planets and moons. Units: metres, seconds, m³/s² for mu (= G·M).
// A negative rotation period means the body turns clockwise (east is to the right at launch).
window.FS = window.FS || {};
FS.DATA = FS.DATA || {};

FS.DATA.bodies = [
  {
    name: 'Aster', R: 600000, mu: 3.5316e12, parent: null,
    rotPeriod: -21549.425, rot0: 0, // negative = turns clockwise, so 'east' is to the right on screen
    atmo: { height: 70000, H: 5600, p0: 1.0, rho0: 1.225, color: [96, 160, 236] },
    ocean: true,
    terrain: { seed: 11, base: 5, octaves: 12, amp: 2600, persist: 0.52, bias: 350 },
    colors: { land: '#4f7a3a', landDeep: '#2d4626', rock: '#7c7a6b', sand: '#c9b77e', ocean: '#1f4f8f', oceanDeep: '#163a6c', disc: '#3d6fae', snow: '#e8eef2' },
    pad: { lon: 0.35, height: 72 },
    warpAlt: [0, 70000, 70000, 70000, 120000, 240000, 480000, 2000000, 6000000],
  },
  {
    name: 'Mira', R: 200000, mu: 6.5138398e10, parent: 'Aster',
    a: 12000000, phase0: 1.7, rot0: 0,
    atmo: null, ocean: false,
    terrain: { seed: 23, base: 6, octaves: 11, amp: 2400, persist: 0.5, bias: 0, craters: 70 },
    colors: { land: '#8d8b86', landDeep: '#4a4946', rock: '#9e9b94', disc: '#a9a6a0' },
    warpAlt: [0, 5000, 10000, 25000, 50000, 100000, 200000, 400000, 800000],
  },
  {
    name: 'Pell', R: 60000, mu: 1.7658e9, parent: 'Aster',
    a: 47000000, phase0: 0.9, rotPeriod: -40400, rot0: 0,
    atmo: null, ocean: false,
    terrain: { seed: 37, base: 4, octaves: 10, amp: 1600, persist: 0.5, bias: 300, flats: true },
    colors: { land: '#9fc7b8', landDeep: '#5f8a7c', rock: '#b8ddd0', disc: '#a8d4c4' },
    warpAlt: [0, 3000, 6000, 8000, 12000, 30000, 60000, 120000, 240000],
  },
]
