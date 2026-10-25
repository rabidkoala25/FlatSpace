// input.js — keyboard, mouse and touch controls for the flight scene.
// Turns player input into changes on the game state (FS.game) and calls the page
// helpers in FS.UI (set up by main.js) for menus and map actions.
(function () {
  const game = FS.game;
  const byId = (elementId) => document.getElementById(elementId);
  const Input = (FS.Input = {});

  // Held controls, applied every frame before the simulation steps.
  Input.apply = (timeStep) => {
    const vessel = game.vessel;
    if (!vessel) {
      return;
    }
    const keys = game.keys;
    const touch = game.touch;
    if (keys.Shift || touch.thrUp) {
      vessel.throttle = Math.min(1, vessel.throttle + timeStep * 0.9);
    }
    if (keys.Control || touch.thrDown) {
      vessel.throttle = Math.max(0, vessel.throttle - timeStep * 0.9);
    }
    vessel.rot =
      (keys.a || keys.ArrowLeft || touch.left ? 1 : 0) - (keys.d || keys.ArrowRight || touch.right ? 1 : 0);
  };

  function stage() {
    const vessel = game.vessel;
    if (vessel && !vessel.dead) {
      vessel.stage(game);
    }
  }

  function onKey(event, down) {
    if (game.scene !== 'flight') {
      return;
    }
    if (event.target.tagName === 'INPUT') {
      return;
    }
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    game.keys[key] = down;
    if (event.key === 'Shift') {
      game.keys.Shift = down;
    }
    if (event.key === 'Control') {
      game.keys.Control = down;
    }
    if (!down || event.repeat) {
      if ([' ', 'Tab'].includes(event.key)) {
        event.preventDefault();
      }
      return;
    }
    const vessel = game.vessel;
    if (!byId('dialog').hidden) {
      if (event.key === 'Escape') {
        FS.UI.hideDialog();
      }
      return;
    }
    switch (key) {
      case ' ':
        event.preventDefault();
        stage();
        break;
      case 'z':
        vessel.throttle = 1;
        break;
      case 'x':
        vessel.throttle = 0;
        break;
      case 't':
        vessel.sas = !vessel.sas;
        vessel.sasTarget = vessel.angle;
        break;
      case 'm':
        FS.UI.setMapMode(!game.mapMode);
        break;
      case '.':
        game.changeWarp(1);
        break;
      case ',':
        game.changeWarp(-1);
        break;
      case '/':
        game.stopWarp();
        break;
      case 'p':
        if (vessel.deployChutes()) {
          game.message('Parachutes armed.', '', 1500);
        }
        break;
      case 'h':
        byId('help').hidden = !byId('help').hidden;
        break;
      case 'Tab':
        event.preventDefault();
        if (game.mapMode) {
          FS.UI.cycleFocus();
        }
        break;
      case 'Escape':
        FS.UI.menu();
        break;
      case 'F3':
        event.preventDefault();
        byId('devOverlay').hidden = !byId('devOverlay').hidden;
        break;
    }
  }

  // Click or tap in the flight view: open the pop-up of the part under the pointer (in flight,
  // some settings can still change, and engines, decouplers and parachutes can be used).
  function pickPart(x, y) {
    const vessel = game.vessel;
    if (!vessel || game.mapMode) {
      return;
    }
    const local = FS.Renderer.screenToPart(game.cam, vessel, game.t, x, y);
    const point = FS.vec.add(local, vessel.layout.com);
    const hit = FS.Build.partAt(vessel.parts, point, 8 / Math.max(game.cam.s, 0.01));
    FS.PartPanel.select(hit, 'flight');
  }

  // Zoom the map or the flight view by factor f.
  function zoomBy(factor) {
    if (game.mapMode) {
      game.mapCam.s = FS.clamp(game.mapCam.s * factor, 1e-7, 0.5);
    } else {
      game.zoom = FS.clamp(game.zoom * factor, 1e-6, 30);
    }
  }

  // Mouse and touch on the view: drag to pan the map, click to add a node, pinch to zoom.
  function setupPointer(view) {
    const pointers = new Map();
    let drag = null;
    let pinch = null;
    const spread = () => {
      const [firstPointer, secondPointer] = [...pointers.values()];
      return Math.hypot(firstPointer.x - secondPointer.x, firstPointer.y - secondPointer.y) || 1;
    };

    view.addEventListener('pointerdown', (event) => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      view.setPointerCapture(event.pointerId);
      if (pointers.size === 2) {
        pinch = { d: spread(), last: 1 };
        drag = null;
      } else if (pointers.size === 1 && game.mapMode) {
        drag = { x: event.clientX, y: event.clientY, moved: false, pan: { ...game.mapPan } };
      } else if (pointers.size === 1) {
        drag = { x: event.clientX, y: event.clientY, moved: false, flight: true };
      }
    });
    view.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId)) {
        return;
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinch && pointers.size >= 2) {
        const ratio = spread() / pinch.d;
        zoomBy(ratio / pinch.last);
        pinch.last = ratio;
        return;
      }
      if (!drag) {
        return;
      }
      const deltaX = event.clientX - drag.x;
      const deltaY = event.clientY - drag.y;
      if (Math.hypot(deltaX, deltaY) > 4) {
        drag.moved = true;
      }
      if (drag.moved && !drag.flight) {
        game.mapPan = { x: drag.pan.x - deltaX / game.mapCam.s, y: drag.pan.y + deltaY / game.mapCam.s };
      }
    });
    const end = (event) => {
      pointers.delete(event.pointerId);
      if (pinch) {
        if (pointers.size < 2) {
          pinch = null;
        }
        drag = null; // lifting a finger after a pinch is not a click
        return;
      }
      if (drag && !drag.moved && event.type === 'pointerup') {
        const bounds = view.getBoundingClientRect();
        if (drag.flight) {
          pickPart(event.clientX - bounds.left, event.clientY - bounds.top);
        } else {
          FS.UI.mapClick(event.clientX - bounds.left, event.clientY - bounds.top);
        }
      }
      drag = null;
    };
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);

    // right-click a part for its pop-up, as in the hangar
    view.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (game.mapMode) {
        return;
      }
      const bounds = view.getBoundingClientRect();
      pickPart(event.clientX - bounds.left, event.clientY - bounds.top);
    });

    view.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        zoomBy(Math.pow(1.0015, -event.deltaY));
      },
      { passive: false },
    );
  }

  Input.init = () => {
    window.addEventListener('keydown', (event) => onKey(event, true));
    window.addEventListener('keyup', (event) => onKey(event, false));
    window.addEventListener('blur', () => {
      game.keys = {};
      game.touch = {};
    });
    setupPointer(byId('view'));

    byId('btnMap').addEventListener('click', () => FS.UI.setMapMode(!game.mapMode));
    byId('btnWarpUp').addEventListener('click', () => game.changeWarp(1));
    byId('btnWarpDown').addEventListener('click', () => game.changeWarp(-1));
    byId('btnRecover').addEventListener('click', () => FS.UI.recover());
    byId('btnMenu').addEventListener('click', () => FS.UI.menu());
    byId('btnNodeWarp').addEventListener('click', game.warpToNode);
    byId('btnNodeDel').addEventListener('click', game.deleteNode);
    document.querySelectorAll('#nodePanel .stepper button').forEach((button) =>
      button.addEventListener('click', () => {
        game.editNode(button.dataset.k, parseFloat(button.dataset.d));
        FS.HUD.updateNode(game);
      }),
    );
    document.querySelectorAll('.sasbtn').forEach((button) =>
      button.addEventListener('click', () => {
        const vessel = game.vessel;
        if (!vessel) {
          return;
        }
        const mode = button.dataset.mode;
        if (mode === 'toggle') {
          vessel.sas = !vessel.sas;
          vessel.sasTarget = vessel.angle;
        } else {
          vessel.sas = true;
          vessel.sasMode = mode;
          vessel.sasTarget = vessel.angle;
        }
      }),
    );
    document.querySelectorAll('.tbtn').forEach((button) => {
      const touchName = button.dataset.touch;
      if (touchName === 'stage') {
        button.addEventListener('click', stage);
        return;
      }
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        game.touch[touchName] = true;
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((eventName) =>
        button.addEventListener(eventName, () => (game.touch[touchName] = false)),
      );
    });

    // Buttons should not keep keyboard focus in flight, or Space would press them.
    document.addEventListener('click', (event) => {
      const button = event.target.closest && event.target.closest('#flight button');
      if (button) {
        button.blur();
      }
    });
  };
})();
