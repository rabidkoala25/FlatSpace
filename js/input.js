// input.js — keyboard, mouse and touch controls for the flight scene.
// Turns player input into changes on the game state (FS.game) and calls the page
// helpers in FS.UI (set up by main.js) for menus and map actions.
(function () {
  const G = FS.game;
  const $ = (id) => document.getElementById(id);
  const I = (FS.Input = {});

  // Held controls, applied every frame before the simulation steps.
  I.apply = (dt) => {
    const ves = G.vessel;
    if (!ves) return;
    const k = G.keys, tc = G.touch;
    if (k.Shift || tc.thrUp) ves.throttle = Math.min(1, ves.throttle + dt * 0.9);
    if (k.Control || tc.thrDown) ves.throttle = Math.max(0, ves.throttle - dt * 0.9);
    ves.rot = ((k.a || k.ArrowLeft || tc.left) ? 1 : 0) - ((k.d || k.ArrowRight || tc.right) ? 1 : 0);
  };

  function stage() {
    const ves = G.vessel;
    if (ves && !ves.dead) ves.stage(G);
  }

  function onKey(e, down) {
    if (G.scene !== 'flight') return;
    if (e.target.tagName === 'INPUT') return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    G.keys[key] = down;
    if (e.key === 'Shift') G.keys.Shift = down;
    if (e.key === 'Control') G.keys.Control = down;
    if (!down || e.repeat) {
      if ([' ', 'Tab'].includes(e.key)) e.preventDefault();
      return;
    }
    const ves = G.vessel;
    if (!$('dialog').hidden) {
      if (e.key === 'Escape') FS.UI.hideDialog();
      return;
    }
    switch (key) {
      case ' ': e.preventDefault(); stage(); break;
      case 'z': ves.throttle = 1; break;
      case 'x': ves.throttle = 0; break;
      case 't': ves.sas = !ves.sas; ves.sasTarget = ves.angle; break;
      case 'm': FS.UI.setMapMode(!G.mapMode); break;
      case '.': G.changeWarp(1); break;
      case ',': G.changeWarp(-1); break;
      case '/': G.stopWarp(); break;
      case 'p': if (ves.deployChutes()) G.message('Parachutes armed.', '', 1500); break;
      case 'h': $('help').hidden = !$('help').hidden; break;
      case 'Tab': e.preventDefault(); if (G.mapMode) FS.UI.cycleFocus(); break;
      case 'Escape': FS.UI.menu(); break;
      case 'F3': e.preventDefault(); $('devOverlay').hidden = !$('devOverlay').hidden; break;
    }
  }

  // Click or tap in the flight view: open the pop-up of the part under the pointer (in flight,
  // some settings can still change, and engines, decouplers and parachutes can be used).
  function pickPart(x, y) {
    const ves = G.vessel;
    if (!ves || G.mapMode) return;
    const local = FS.Renderer.screenToPart(G.cam, ves, G.t, x, y);
    const pt = FS.vec.add(local, ves.layout.com);
    const hit = FS.Build.partAt(ves.parts, pt, 8 / Math.max(G.cam.s, 0.01));
    FS.PartPanel.select(hit, 'flight');
  }

  // Zoom the map or the flight view by factor f.
  function zoomBy(f) {
    if (G.mapMode) G.mapCam.s = FS.clamp(G.mapCam.s * f, 1e-7, 0.5);
    else G.zoom = FS.clamp(G.zoom * f, 1e-6, 30);
  }

  // Mouse and touch on the view: drag to pan the map, click to add a node, pinch to zoom.
  function setupPointer(view) {
    const pointers = new Map();
    let drag = null, pinch = null;
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y) || 1;
    };

    view.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      view.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        pinch = { d: spread(), last: 1 };
        drag = null;
      } else if (pointers.size === 1 && G.mapMode) {
        drag = { x: e.clientX, y: e.clientY, moved: false, pan: { ...G.mapPan } };
      } else if (pointers.size === 1) {
        drag = { x: e.clientX, y: e.clientY, moved: false, flight: true };
      }
    });
    view.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const ratio = spread() / pinch.d;
        zoomBy(ratio / pinch.last);
        pinch.last = ratio;
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved && !drag.flight) G.mapPan = { x: drag.pan.x - dx / G.mapCam.s, y: drag.pan.y + dy / G.mapCam.s };
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pinch) {
        if (pointers.size < 2) pinch = null;
        drag = null; // lifting a finger after a pinch is not a click
        return;
      }
      if (drag && !drag.moved && e.type === 'pointerup') {
        const r = view.getBoundingClientRect();
        if (drag.flight) pickPart(e.clientX - r.left, e.clientY - r.top);
        else FS.UI.mapClick(e.clientX - r.left, e.clientY - r.top);
      }
      drag = null;
    };
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);

    // right-click a part for its pop-up, as in the hangar
    view.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (G.mapMode) return;
      const r = view.getBoundingClientRect();
      pickPart(e.clientX - r.left, e.clientY - r.top);
    });

    view.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomBy(Math.pow(1.0015, -e.deltaY));
    }, { passive: false });
  }

  I.init = () => {
    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => { G.keys = {}; G.touch = {}; });
    setupPointer($('view'));

    $('btnMap').addEventListener('click', () => FS.UI.setMapMode(!G.mapMode));
    $('btnWarpUp').addEventListener('click', () => G.changeWarp(1));
    $('btnWarpDown').addEventListener('click', () => G.changeWarp(-1));
    $('btnRecover').addEventListener('click', () => FS.UI.recover());
    $('btnMenu').addEventListener('click', () => FS.UI.menu());
    $('btnNodeWarp').addEventListener('click', G.warpToNode);
    $('btnNodeDel').addEventListener('click', G.deleteNode);
    document.querySelectorAll('#nodePanel .stepper button').forEach((b) =>
      b.addEventListener('click', () => {
        G.editNode(b.dataset.k, parseFloat(b.dataset.d));
        FS.HUD.updateNode(G);
      }));
    document.querySelectorAll('.sasbtn').forEach((b) =>
      b.addEventListener('click', () => {
        const ves = G.vessel;
        if (!ves) return;
        const m = b.dataset.mode;
        if (m === 'toggle') { ves.sas = !ves.sas; ves.sasTarget = ves.angle; }
        else { ves.sas = true; ves.sasMode = m; ves.sasTarget = ves.angle; }
      }));
    document.querySelectorAll('.tbtn').forEach((b) => {
      const k = b.dataset.touch;
      if (k === 'stage') { b.addEventListener('click', stage); return; }
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); G.touch[k] = true; });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => (G.touch[k] = false)));
    });

    // Buttons should not keep keyboard focus in flight, or Space would press them.
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('#flight button');
      if (b) b.blur();
    });
  };
})();
