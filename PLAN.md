# Flatspace Program — Design Plan

A 2D spaceflight and rocket-building sandbox, inspired by Kerbal Space Program (KSP), that runs entirely in the browser and deploys as a static site on GitHub Pages.

This document has five parts:

1. How the program works (architecture, physics, the building system and the art direction)
2. Every KSP feature, and how it maps to 2D, plus features that go beyond KSP and Spaceflight Simulator (2.8)
3. The most popular KSP mods, and which of their ideas to build in
4. The roadmap, split into steps that each fit in one work session
5. Controls and deployment

A companion file, **`PARTS.md`**, lists every stock KSP part (base game and both expansions) and the popular mod part families, each mapped to a Flatspace equivalent and the step that builds it.

All names (planets, parts, crew) are original. The game borrows mechanics, not KSP's names or art.

---

## 1. How the program works

### 1.1 Platform

| Concern | Choice | Why |
|---|---|---|
| Hosting | GitHub Pages, static files only | Free, no server, push-to-deploy |
| Language | Plain JavaScript (ES2020), no build step | Open `index.html` and it runs; easy for anyone to read and mod |
| Rendering | Canvas 2D in the prototype; a small WebGL2 renderer from step B1 | WebGL shaders give crisp rotating pixel art and cheap per-pixel lighting |
| Physics | Hand-written in the prototype; a 2D rigid-body engine from step C1 (planck.js, a JavaScript port of Box2D, MIT licence, kept in `lib/`) | Collisions, contacts and joints without writing a solver from scratch |
| UI | HTML/CSS overlay, styled as pixel art from step B5 | Text stays readable and accessible |
| Saves | `localStorage` (craft and save games), JSON export/import, versioned from step A0 | Works offline; files can be shared |
| Code layout | One global namespace `FS`, one file per system | Loaded with plain `<script>` tags in order |
| Tests | Headless checks run with Node (`node tests/run.js`, from step A0) | Every step can prove nothing broke |

### 1.2 Code structure

The code today (after step A0):

```
index.html          page shell, HUD markup, script tags
css/style.css       all styling (HUD, editor, panels)
data/parts.js       part stats as plain data (packs will add more in G1)
data/bodies.js      planet and moon data
js/util.js          version number, vectors, formatting, storage helpers
js/save.js          versioned saves and migrations
js/bodies.js        planets & moons: orbits, rotation, terrain, atmosphere
js/orbit.js         Kepler orbits, propagation, patched conics, encounters
js/parts.js         part lookup, engine maths and part drawing
js/partgraph.js     the part tree: attach nodes, positions, mass, fuel flow, staging, Δv per stage
js/vessel.js        a flying craft: forces, fuel, staging, landing, crashing; reports events
js/sim.js           game state, the event bus, stepping craft and debris (physics or on rails)
js/warp.js          time warp rates and limits, warping to a time
js/nodes.js         maneuver nodes on any patch of the predicted path
js/render.js        the Canvas 2D renderer (FS.Renderer interface): flight, map, particles
js/hud.js           flight instruments: attitude dial, readouts, stage list
js/editor.js        the Vehicle Assembly hangar
js/input.js         keyboard, mouse and touch (including pinch zoom)
js/main.js          scenes, messages and dialogs, milestones, camera, frame loop
tests/              headless checks: node tests/run.js (npm install once for the page test)
tools/roadmap.js    redraws docs/roadmap.svg (the README's roadmap) from the status table below
```

Simulation code (`data/`, `save.js` to `nodes.js`) never touches the page. It reports what happens through events (`staged`, `touchdown`, `exploded`, `soi`, `message`), which the renderer and `main.js` listen to. The tests load exactly these files in Node.

Added by the roadmap:

```
js/gl/                          B1  WebGL2 renderer: sprite batch, meshes, shaders
art/palette.js                  B1  the master palette
art/sprites/*.js                B2  palette-indexed sprites written as text grids
art/overrides/                  B2  hand-made PNGs that replace generated sprites
art.html                        B1  sprite gallery for reviewing art
lib/planck.min.js, js/physics.js   C1  rigid-body engine and its integration
js/joints.js                    C2  structural loads and articulated joints
js/ropes.js                     C3  ropes, cables and physical parachutes
js/aero.js                      C4  atmosphere, drag, lift, buoyancy
```

Later steps add `science.js`, `career.js`, `comms.js`, `resources.js`, `crew.js`, `thermal.js`, `autopilot.js`, `missions.js`, `packs.js`.

### 1.3 Physics model

**Units.** Everything is SI: metres, seconds, kilograms, newtons.

**Gravity: patched conics (like stock KSP).** Every craft is inside exactly one body's sphere of influence (SOI) and feels only that body's gravity. The SOI radius is `a · (μ_body / μ_parent)^(2/5)`. When the craft crosses an SOI boundary, its position and velocity are re-expressed relative to the new body. Moons move on fixed circular "rails". The whole system turns clockwise, so east (prograde) is to the right of the screen at launch. An optional n-body mode comes in step G4.

**Two integrators.**
- *Physics mode* (thrusting, in atmosphere, near the ground, or time warp ≤ 4×): forces are integrated at a fixed 20 ms step. Forces: gravity, engine thrust, aerodynamic drag, parachute drag; torques from reaction wheels, engine gimbal, off-centre thrust, fins and the SAS controller.
- *On-rails mode* (coasting in vacuum, time warp up to 100,000×): the craft's state is converted to Kepler elements and propagated analytically (Kepler's equation, solved with Newton's method, for ellipses and hyperbolas). This is exact and costs almost nothing, so very high warp is stable.

**Orbit prediction.** From the current state the game builds up to three conic "patches": it samples the current orbit, checks each moon's position at the same moment, and finds the first SOI entry (encounter) or exit (escape) by bisection. The map draws each patch, plus Ap/Pe, encounter, escape and impact markers.

**Atmosphere.** Exponential pressure profile `p(h) = p₀·e^(−h/H)`, rescaled to reach exactly zero at the atmosphere's top. The atmosphere rotates with the planet, so drag uses air-relative velocity. Drag force is `½ ρ v² · ΣCdA` over all parts.

**Engines.** Each engine has vacuum and sea-level thrust and specific impulse. Mass flow is fixed by vacuum values; thrust at pressure *p* is `ṁ · Isp(p) · g₀`, so engines lose thrust low in the atmosphere, as in KSP. Liquid engines throttle and can be shut down; solid boosters burn at full power until empty.

**Vessel structure.** *Prototype:* a single vertical stack. *From step A1:* a tree of parts. Each part has a parent, the attach node it hangs from, a position and rotation relative to the root, and an optional mirror flip. Mass, centre of mass and moment of inertia are summed from every part's position. Each engine pushes along its own thrust line, so side boosters that burn unevenly, or an engine mounted off-centre, turn the craft. Drag area depends on the angle of attack. The tree is designed as a compound rigid body from the start, so the rigid-body engine in step C1 can take it over directly.

**Fuel flow.** Engines draw from tanks connected to them through the tree, stopping at decouplers (KSP's rule). Fuel lines and crossfeed toggles (step D2) change the routing.

**Staging.** Pressing Stage fires the next event in the stage list: ignite engines, fire decouplers, arm parachutes. When a decoupler fires, the tree splits in two and the dropped half becomes a separate vessel that keeps flying and can crash. The stage list is generated automatically from the tree until the player edits it (step A4).

**Δv maths (editor and in-flight readouts).** Each stage is solved analytically: all burning groups (engines sharing the same tanks, and each solid booster) are burned in phases until each runs dry, adding `Isp_eff · g₀ · ln(m₀/m₁)` per phase.

**Landing and crashing.** *Prototype:* the top and bottom of the stack are tested against the terrain. *From step C1:* every part's hull collides with the ground and with other vessels, so craft can rest on legs, tip over, roll and bump into each other. *From step C2:* a joint that takes more load than it can bear breaks, so a part that hits too hard snaps off and the rest of the craft can survive.

**Terrain.** Each body's surface is a periodic fractal noise function of longitude, with craters on moons, flattened around the launch site. It's computed on the fly at whatever detail the zoom level needs, so there are no tiles to store. *From step E10:* realistic landforms (ridges, eroded valleys, cliffs, mesas, canyons, dunes, crater rims with ejecta), detail down to 0.25 m up close, collidable boulders, and several layers of distant terrain drawn behind for true parallax depth (the idea behind KSP's Parallax mod).

**Moving parts are simulated, not animated (from Phase C).** Anything that swings, folds, hangs or stretches is a real physics object with mass, joined to the craft by constraints. Its motion comes from the simulation, not from a canned animation or a force added to one rigid body:
- parachute canopies on their rigging lines;
- ropes, cables and tethers;
- hinges, pistons and rotors;
- landing-leg and gear suspension, and wheels;
- bay doors, fairing halves, and deployable solar panels and antennas.

So a craft swings under its parachute, a rope pulls on both things it connects, a solar panel left open in thick air bends and snaps off, and a fairing half tumbles away. Parts that never move relative to each other stay welded into one rigid body, so ordinary rockets stay fast to simulate.

#### The physics upgrade (Phase C)

The prototype's physics is enough for a single rigid rocket in flight. Phase C replaces it with a fuller model, before the parts that depend on it (legs, parachutes, ropes, wheels, docking, wings, robotics) are built.

| Area | Prototype | After Phase C |
|---|---|---|
| Bodies and contacts | One rigid rocket; two ground test points | Rigid-body engine (planck.js): every part's hull collides with terrain, debris and other vessels; friction, tipping, rolling, bouncing (C1) |
| Large distances and speeds | Positions relative to the planet | Floating origin plus a moving reference frame (the idea behind KSP's "Krakensbane"): the solver only sees small coordinates and the speeds relative to the active craft, so orbital velocity doesn't break the rigid-body engine's limits (C1) |
| Structure | Unbreakable | Loads computed at every joint from thrust, drag and inertia; joints have strengths by size; overloaded joints break (C2) |
| Mechanisms | None | Articulated parts: anything with a hinge, slider, spring or wheel is its own body joined to the craft, with motors, limits, springs and damping. Used by legs, gear, wheels, doors, solar panels, robotics and docking (C2) |
| Separation | Parts jump apart | Decouplers push with a real ejection force; fairing halves and bay doors are bodies that hinge open and fly off (C2) |
| Parachutes | A drag number added to the craft | A canopy body on rigging lines. It opens in stages with an opening shock; the craft swings beneath it; it drifts with the air, collapses and drapes on landing, and can be cut away (C3) |
| Ropes and cables | None | Ropes of linked segments with slack, tension, stretch and a breaking strength; they collide with the ground and pull on both ends (C3) |
| Atmosphere | Pressure only | Temperature profile, density from pressure and temperature, speed of sound and Mach number (C4) |
| Aerodynamics | One drag sum and a fin hack | Per-part drag with shielding (parts behind others or inside fairings get less drag), Mach drag rise, lift on fins, wings and bodies, aerodynamic torque from where each force acts (C4) |
| Water | Splashdown only | Buoyancy and water drag: craft float, tip and sink (C4) |
| Integration | Semi-implicit Euler | A symplectic integrator that conserves orbital energy; clean hand-off between physics and on-rails; spin kept through time warp; optional thrust during warp for low-thrust engines (C5) |
| Prediction | 3 patches | Root-finding encounter search, more patches, KSP-style display modes (C5) |

### 1.4 Building: drag-and-drop assembly (steps A1–A4)

The prototype's click-to-stack editor is replaced by a drag-and-drop builder that combines KSP's Vehicle Assembly Building with Spaceflight Simulator's freer, stretchable parts.

**Layout.** Part tray on the left (category tabs with pixel icons, a hover card with each part's stats), an open build area in the middle with pan and zoom and no size limit, and the staging list and engineering stats on the right.

**Placing parts.**
- Drag a part from the tray. A ghost follows the pointer and nearby attach points light up.
- Stack nodes snap parts end to end. Surface attach places a part on the side of a tank or structure.
- An invalid spot (overlap, nothing to attach to) shows the ghost in red, and releasing returns the part to the tray.
- The first part placed becomes the root.

**Moving and removing.** Picking up a placed part carries everything attached below it. Dropping it onto the tray deletes it. Alt-click copies a part with everything attached to it (as in KSP).

**Precision tools.**
- **Mirror symmetry** (X): side parts are placed in mirrored pairs. Mirror symmetry is the only kind that exists in 2D.
- **Rotate** (Q / E, 15° steps; Shift for 5°) and **flip** (F) for fins, side engines and other asymmetric parts.
- **Offset** (Alt-drag): slide a placed part along its parent's surface, with a snap toggle.
- **Undo / redo** (Ctrl+Z / Ctrl+Y).
- **Overlays:** centre of mass, centre of thrust with its thrust line, and centre of pressure (where the air's forces act; it must sit behind the centre of mass for a rocket to fly straight). Centre of lift joins them in F6.

**Stretchable parts and skins (from Spaceflight Simulator).**
- Fuel tanks have handles to change their length in 0.25 m steps. Width comes in fixed sizes: 0.625, 1.25, 1.875, 2.5, 3.75 and 5 m.
- Mass and fuel scale with volume. Engines keep fixed sizes and stats, as in KSP.
- Each tank can wear a skin: white, gold foil, orange foam, black-and-white roll pattern, or bare steel.
- KSP's fixed tank lengths (FL-T100 to FL-T800 and so on) appear in the tray as presets, so every stock tank still has its own entry (see `PARTS.md`).

**Staging and tweakables.**
- Drag parts between stages, and add or remove stages.
- Right-click a part (on touch, tap the selected part again; a long-press picks parts up) to set fuel level, thrust limit, gimbal, crossfeed and parachute deploy altitude.

**Touch.** Long-press to pick up a part; two fingers to pan and pinch to zoom.

### 1.5 Art direction: rotating pixel art (steps B1–B5)

**The goal.** Pixel art that looks genuinely beautiful and deliberate, in the league of Hyper Light Drifter, Celeste, Eastward or Sea of Stars, not a Flash game. Every sprite is drawn on a pixel grid, but objects rotate freely: **when a rocket turns, its pixels turn with it as crisp squares.** The world is never re-pixelated to the screen grid. This keeps motion smooth, which matters in a game where the rocket is always making small SAS corrections and the flight camera turns as you orbit. The alternative, redrawing everything onto a fixed screen grid each frame, makes edges crawl ("pixel boil") during slow rotation.

**What separates this from a Flash game.**
- No soft vector gradients or glossy "plastic" shading.
- No pixels of different sizes side by side, such as a part scaled 2× next to parts at 1×.
- No blurry, smoothed-out bitmaps.
- No particles drawn as soft blobs.
- No default fonts.

**Rules that apply to every sprite and effect.**

| Rule | How it's enforced |
|---|---|
| One pixel size | All world art is authored at 16 art pixels per metre (a 1.25 m tank is 20 px wide) and every object is drawn at the same on-screen pixel size at a given zoom. Nothing gets its own scale factor. |
| Crisp squares at any angle | Rendering moves to WebGL2 in step B1. Sprites are drawn with a "sharp pixel" shader: each art pixel is a solid square, with a blend one screen pixel wide only along its edges. Squares stay crisp at any angle and don't shimmer when an object moves by a fraction of a pixel or turns slowly. |
| Smooth zoom | Zoom is continuous. When art pixels shrink below about one screen pixel, the renderer switches to prepared ½ and ¼ versions (downscaled with pixel-art rules), then to a pixel icon. |
| A limited palette | About 48 colours in `art/palette.js`, built as hue-shifted ramps (shadows lean cool and purple, highlights warm). Effects and UI use the same palette. |
| No smooth gradients | Sky, atmosphere rims, night-side terminators and smoke use banded colours with ordered dithering, at the same pixel size as the art. |
| Consistent light | Each part has a colour layer and a "shape" layer (the surface direction at each pixel). The shader lights it from the real sun direction with 4–5 tone ramps and a specular pixel. The lit side moves as the rocket turns, the craft goes dark in a planet's shadow, and engine fire lights nearby parts. |
| Ground and planets in the same style | Terrain is a mesh textured with pixel-art material tiles (grass, soil strata, rock, sand, snow) that follow the curve of the ground. Planets seen from orbit are pixel-art textures that turn with the planet. |
| Pixel effects | Particles are single art pixels or small clusters, coloured from palette ramps, fading by dither pattern instead of transparency. |
| Hand-timed animation | Small details on few frames: blinking pad beacons, drifting clouds, wave foam, tower arms swinging away at launch, parachute sway. |

**How sprites are made.**
- Sprites are written as palette-indexed text grids in `art/sprites/`. They are readable, editable by hand, and diffs show what changed.
- Most parts are cylinders and cones, so they are generated from a profile (width along the length) plus hand-drawn decals: windows, hatches, rivets, stripes and logos. This keeps every part consistent and lets stretched tanks stay crisp at any length. Each tank is a top cap, a repeating body slice and a bottom cap. Skins are palette swaps.
- `art.html` shows every sprite at 1× and 4×, rotating, under several sun angles, for review.
- Any generated sprite can be replaced by dropping a PNG with the same name and size into `art/overrides/`. If you, or a pixel artist you work with, want to hand-draw sprites later, it needs no code changes.

**An honest note.** Art quality is the riskiest part of this plan, because sprites made in code can look mechanical. The rules above keep them consistent. Step B2 ends with a checkpoint where you review the gallery and give direction before the world and effects are drawn.

### 1.6 Rendering

- **Flight view.** The camera follows the craft and rotates so "local up" points up the screen, the same feel as KSP's flight camera. The sky changes with altitude and sun angle (dithered bands, sunsets near the terminator); stars fade in; the planet's limb, atmosphere rim and moons in the sky are drawn; terrain is drawn around the craft.
- **Map view.** Top-down inertial view of the whole system with orbits, SOI rings and the craft's predicted path. Zoom and pan; focus any body. From step B1, bodies are drawn by the WebGL renderer, and orbit lines and labels on a crisp overlay canvas.
- **Precision.** All drawing is done relative to the camera position (subtracting in double precision before the GPU sees the numbers), so nothing jitters far from the planet.
- **Effects.** Exhaust, smoke, explosions, reentry glow, parachutes and staging debris. From step B4 they are pixel effects built to the rules above.

### 1.7 Performance and size: why it stays one static site

A separate downloadable executable (for example Electron or Tauri) was considered and is **not needed**:

- **Speed doesn't depend on hosting.** Electron and Tauri run the same JavaScript in the same browser engine, so the game would run no faster as an executable. Only rewriting the simulation in a native language would, which isn't worth it for a 2D game.
- **The content is small.** Pixel-art sprites, procedural terrain and part data amount to a few megabytes; compressed audio adds perhaps 20–50 MB. GitHub Pages allows 1 GB per site and 100 MB per file.
- **The heavy parts have browser-side fixes:**
  - big articulated craft (C2), ropes (C3) and many nearby vessels (E6) can move physics to a Web Worker, so drawing stays smooth;
  - hot loops (the rope solver, the n-body integrator in G4) can move to WebAssembly if profiling shows a need;
  - a part-count limit per craft (as in KSP's career facilities) keeps the worst case bounded.
- **Storage and offline play:**
  - saves move to IndexedDB, with room for hundreds of craft and save games (D3);
  - the site becomes an installable web app that works offline, much like a desktop app without a separate download (E9);
  - mods load from a file picker or a GitHub link (G1).
- **Budget:** 60 frames per second on a mid-range laptop with a 200-part craft. The F3 overlay tracks frame and physics time, and C5 includes a performance pass.

If the budget still can't be met after those fixes, revisit this decision.

---

## 2. Every KSP feature, mapped to 2D

Legend: **P** = in the prototype now · **A0–G8** = the roadmap step that delivers it (section 4) · **✗** = left out on purpose (needs a third dimension). Individual parts are tracked in `PARTS.md`.

### 2.1 Building

| KSP feature | 2D version | Step |
|---|---|---|
| Vehicle Assembly Building | Drag-and-drop side-on hangar (section 1.4) | **P** (click-to-stack) / A2 |
| Every stock part | One equivalent per KSP part | See `PARTS.md` (finished by G8) |
| Stack attachment | Top/bottom nodes | **P** / A1 |
| Radial (surface) attachment | Parts on the sides of tanks and structure | A1, A2 |
| Symmetry | Mirror pairs (the only symmetry in 2D) | A3 |
| Side boosters (radial decouplers) | Mirrored boosters on radial decouplers | A1 (stretch) / D5 |
| Adapters and sizes (0.625–5 m) | Tapered adapters and stretchable tanks in every width | **P** (1.25↔2.5) / A4 / D5 |
| Rotate, offset, re-root tools | Rotate/flip, Alt-drag offset, re-root | A3 / A2 (re-root, stretch) |
| Subassemblies, copy, undo/redo | Alt-click copy, saved subassemblies, 100-step history | A3 |
| Centre of mass / thrust / pressure / lift markers | Editor overlays (and in flight, toggled) | A3 (mass, thrust, pressure) / F6 (lift) |
| Stage editor | Drag parts between stages; per-part "include in staging" | A4 |
| Part tweakables | Fuel level, thrust limit, gimbal, crossfeed, deploy altitude | A4 |
| Δv per stage, TWR, burn time | Right-hand panel in the editor | **P** |
| Craft save / load / share | Local saves, JSON file export/import, copy-paste text | **P** (local) / A4 |
| Spaceplane Hangar + runway | Horizontal build mode | F6 |
| Construction mode (move parts in flight) | EVA engineer attaches and detaches parts | G3 |

### 2.2 Flight

| KSP feature | 2D version | Step |
|---|---|---|
| Throttle, staging, engine ignition & flameout | Same | **P** |
| Liquid, solid, monopropellant, xenon (ion) fuels | Separate resources and tank types | **P** (liquid, solid) / D2 (mono) / E5 (xenon) |
| Reaction wheels, gimbal, fins | Torque sources about the one rotation axis | **P** / D2 (all wheel sizes) |
| Off-centre and uneven thrust | Each engine has its own thrust line | A1 |
| Collisions between vessels and debris | Rigid-body contacts | C1 |
| Structural failure | Joints break under load | C2 |
| RCS thrusters | Rotation plus translation forward/back and left/right | D2 |
| SAS modes | Normal/anti-normal don't exist in 2D; all others kept | **P** (stability, pro, retro, radial ±, maneuver) / D4 (target) |
| Navball | 2D attitude dial with horizon and markers | **P** / B5 (pixel art) |
| Surface / orbit / target speed modes | Auto-switch by altitude, click to toggle | **P** (auto) / D4 |
| Aerodynamics: drag, lift, stability | Angle-dependent drag (A1); shielding, Mach effects, lift (C4) | **P** / A1 / C4 |
| Reentry heating & part temperature | Per-part temperature, heat shields with ablator | E5 |
| Parachutes (semi-deploy, full deploy, cut) | Physically simulated canopies on rigging lines (C3); all stack and radial chutes (D1) | **P** / C3 / D1 |
| Ropes, tethers, winches, towing | Rope physics (C3); winch, tether and tow parts (G3) | C3 / G3 |
| Moving parts (legs, doors, panels, hinges) | Real bodies on joints, not animations | C2 |
| Landing legs | Legs with spring suspension | D1 |
| Wheels and rovers | Wheels driving along the terrain | F8 |
| Splashdown, floating | Splashdown now; buoyancy in C4 | **P** / C4 |
| Action groups (Gear, Lights, Brakes, Abort, 1–9) | Same | D2 |
| Time warp, physics warp, warp limits by altitude | Same; thrust during warp option for low-thrust engines | **P** / C5 |
| Debris and multiple vessels; switching vessels | Vessel list; `[` `]` to switch | **P** (debris) / D3 |
| Tracking Station | Vessel list plus map | D3 |
| Rendezvous: target, closest approach markers | Same | D4 |
| Docking ports and docking | Ports on stack ends; dock by matching position and speed | E6 |
| EVA (jetpack, flag, ladder, walk) | Pixel astronaut as a small physics body | E7 |
| Fuel transfer, crossfeed, fuel lines | In-flight part menu | D2 |
| Payload fairings, service bays, cargo bays | Fairings that split on staging; bays that open | F7 |
| Inventory / cargo parts | Cargo containers, EVA items | E7 |
| Grabbing unit, asteroids & comets | Grab and redirect | F9 |
| Robotics: hinges, pistons, rotors, controller | 2D hinges and pistons with a keyframe controller | G3 |
| Propellers / rotor flight | Rotor thrust model | G3 |

### 2.3 Orbital mechanics and planning

| KSP feature | 2D version | Step |
|---|---|---|
| Patched conics with SOI changes | Same | **P** / C5 (better predictor) |
| Ap/Pe, time to Ap/Pe, period | Same | **P** |
| Encounters and multi-patch prediction | 3 patches now; more in C5 | **P** / C5 |
| Maneuver nodes | Prograde + radial only, since a 2D orbit has no plane to change | **P** / A0 (nodes survive SOI changes) |
| Maneuver Mode (exact node inputs) | Node panel with ±1/10/100 buttons and time shifting | **P** / D4 (drag handles on the map) |
| Maneuver Tool (Hohmann, circularize, change Ap/Pe) | One-click node generators | D4 |
| Auto-execute maneuver nodes (MechJeb's node executor idea) | One button: point at the burn, warp to it, start on time, throttle down near the end, cut at zero | D4 |
| Alarm Clock | Alarms for nodes, SOI changes, Ap/Pe | D4 |
| Inclination, ascending/descending nodes | An orbit can only be clockwise or counter-clockwise | ✗ |
| Gravity assists | Work naturally with patched conics | **P** (moons) / E1 (planets) |
| Interplanetary transfers, phase angles, transfer windows | Sun-centred system with planets | E1 |

### 2.4 Solar system

| KSP feature | 2D version | Step |
|---|---|---|
| Home planet with rotation, oceans, atmosphere | **Aster**: 600 km radius, 70 km atmosphere, 6-hour day, oceans | **P** / B3 (pixel art) |
| Large nearby moon | **Mira**: 200 km, cratered, airless | **P** / E2 (pixel art) |
| Small distant moon | **Pell**: 60 km, low gravity, flat plains | **P** / E2 (pixel art) |
| Star and multiple planets | A sun with 6 planets and their moons, all original, each with a twist | E1 (physics) / E2 (art) |
| Biomes | Longitude bands per body | E2 |
| Easter eggs / anomalies | Hidden monuments on terrain | F8 |
| Surface features (craters, rocks, cryovolcanoes) | Scannable features on the terrain | F8 |

### 2.5 Game modes and progression

| KSP feature | 2D version | Step |
|---|---|---|
| Sandbox | Same | **P** |
| Science mode | Experiments unlock the tech tree | E3, E4 |
| Career mode | Funds, reputation, contracts, facilities | F1–F3 |
| Science: experiments × situations × biomes; transmit vs recover | Situations: Landed, Splashed, Flying Low, Flying High, Space Low, Space High | E3 |
| Deployed science | Ground stations generate science over time | F8 |
| Tech tree | Node graph unlocking part groups | E4 |
| Contracts | Generated goals: reach altitude, orbit X, land on Y, rescue, test part, satellite | F2 |
| Funds, part costs, recovery value | Refund by distance from the launch site | F1 |
| Reputation | Same | F1 |
| Strategies (Administration) | Same | F3 |
| Facility upgrades | Part count, mass limits, patched conic depth, maneuver nodes | F3 |
| Crew: roster, traits, XP | Pilot / engineer / scientist | E7 (roster) / F3 (hiring, traits, XP) |
| Milestones / "world firsts" | Toasts for first space, orbit, encounter, landing, return | **P** |
| Mission Builder | Missions with triggers and win/lose conditions, shareable | G2 |
| History pack missions | Scripted historical-style missions | G2 |
| Alternative launch sites | Several pads around Aster | D3 |
| Difficulty settings | Settings panel | E9 |
| *(not in KSP)* Competition mode | A physics club or class builds to shared rules and budgets; flights are re-run to check the scores; leaderboard, projector view, flight data graphs, model rocket motors | D8 |
| Tutorials | Interactive tutorials | E9 |

### 2.6 Communications and resources

| KSP feature | 2D version | Step |
|---|---|---|
| CommNet: antennas, relays, ground stations, line-of-sight | A planet blocks a straight line between two points | F4 |
| Probe control requires connection | Same | F4 |
| Electric charge, batteries, solar panels | Sun angle and planet shadow | E5 |
| Ore, scanner, drills, ISRU | Ore by longitude; drill → ore tank → converter → fuel | F5 |

### 2.7 Presentation

| KSP feature | 2D version | Step |
|---|---|---|
| Space Center hub | Clickable pixel-art buildings | D3 |
| Day/night lighting from the sun | Lit sprites, terminator, dark sky at night | B1–B3 / E1 (real sun position) |
| Engine plumes, explosions, smoke | Pixel effects | **P** / B4 |
| Sound | Web Audio, started from a click | E9 |
| Flight log after a flight | Mission summary on recovery | **P** |
| Title screen | Animated pixel scene | B5 |

### 2.8 Beyond KSP and Spaceflight Simulator

Features neither game has in stock, which a 2D game is well placed to do: interiors are easy to show in a side view, and everything is cheap enough to simulate at once. They are built in Phase H, after the full KSP feature set.

| Feature | How it works in 2D | Step |
|---|---|---|
| Astronauts with character | Rigged pixel-art astronauts with faces, traits and reactions; a ragdoll when they fall | H1 |
| Interiors (IVA) you can move around in | A cutaway view of every crewed part; astronauts walk, climb and float between modules, and through docking ports into other vessels | H2 |
| Hands-on interaction | Grab, carry, throw and hand over objects; flip switches and turn valves on parts; work at lab benches | H3 |
| Damage and repairs | Parts get damaged instead of only exploding; hull breaches vent air; leaks; astronauts patch and repair inside and on EVA | H4 |
| Life on board and spin gravity | Simple needs (air, food, sleep, morale); rotating rings where astronauts walk on the inside of the rim | H5 |
| Self-landing rockets | Grid fins, booster legs, relightable engines; dropped stages fly home by themselves while you fly the upper stage | H6 |
| Launch and recovery infrastructure | Launch towers with umbilicals, a tower that catches boosters with its arms, recovery ships, your own launch sites | H7 |
| Tethers, sails and mass drivers | Rotating momentum-exchange tethers, solar sails, an electromagnetic launch track, fuel depots | H8 |
| Flight recorder and replays | Every flight recorded; scrub, slow-mo, follow any vessel, cinematic cameras, GIF export, race your own ghost | H9 |

---

## 3. Popular mods and what to build in

The community's most-recommended mods (from KSP forum and Reddit mod surveys, PC Gamer's list, and CKAN usage) fall into clear groups. Their ideas are built in as features or options, so the 2D game has a "modded" depth. Mod part families are tracked in `PARTS.md`.

| Mod | What it does in KSP | 2D version in Flatspace | Step |
|---|---|---|---|
| **Kerbal Engineer Redux** | Detailed flight and build readouts | Flight data panel and editor stats | **P** |
| **Editor Extensions Redux** | Finer angle snap, offset and snap control in the editor | Rotation steps, offset snap toggle | A3 |
| **Hangar Extender** | Build outside the hangar's walls | Unlimited, pannable build area | A2 |
| **Scatterer / EVE / Astronomer's Visual Pack** | Atmospheric scattering, clouds, better planets | Dithered sunset skies, pixel cloud layer, lit planets | B1 / B3 |
| **Parallax** | Detailed, tessellated terrain; high-detail surface textures; collidable ground scatter (rocks, grass, trees) | Realistic landforms with fine detail up close, rock strata shown in the ground's cut face, scatter by biome with collidable boulders, several layers of distant terrain for real parallax depth | B3 (basic) / E10 |
| **RealPlume / Waterfall** | Exhaust that widens in vacuum | Animated pixel plumes, Mach diamonds in air | **P** (basic) / B4 |
| **Collision FX** | Sparks and debris on impact | Pixel sparks, debris and scorch marks | B4 |
| **Kerbal Joint Reinforcement** | Stiffer joints | Joint strengths in C2; optional flex model in G4 | C2 / G4 |
| **Ferram Aerospace Research (FAR)** | Realistic aerodynamics | Shielding, Mach drag rise and lift (C4); extra "advanced aero" detail with spaceplanes (F6) | C4 / F6 |
| **Persistent Thrust** | Low-thrust engines keep burning during time warp | Thrust-during-warp option | C5 |
| **Kerbal Alarm Clock** | Alarms that stop warp | Alarm list with auto-stop | D4 |
| **MechJeb 2** | Autopilots and maneuver planner | Node auto-execution (D4); autopilot panel: ascent, circularize, landing (E8) | D4 / E8 |
| **Trajectories** | Predicted path including drag; landing spot | Drag-aware impact prediction | E8 |
| **DMagic Orbital Science** | More science experiments | Extra experiments | E3 (stretch) / G8 |
| **Chatterer** | Radio chatter and ambient sound | Sound design | E9 |
| **Transfer Window Planner** | Porkchop plots | Porkchop planner (simpler in 2D) | F10 |
| **RemoteTech** | Signal delay and dish targeting | CommNet signal delay option, dish parts | F4 |
| **SCANsat** | Orbital mapping of terrain, biomes, resources | Scanner parts that map the surface as you orbit | F5 |
| **TAC Life Support / Kerbalism / USI-LS** | Food, water, oxygen | Life-support option (F10) and its parts (G7) | F10 / G7 |
| **Kerbal Construction Time / RP-1 build times** | Building and research take time | Career option | F10 |
| **CKAN** | Mod manager | Built-in Packs menu | G1 |
| **Outer Planets Mod / Galaxies Unbound** | More planets and stars | Planet packs (an example planet pack ships with G1) | G1 |
| **RealChute** | Realistic parachutes: staged deployment, sizing, opening shock | Physical canopies with staged opening and shock (C3); deploy settings and canopy sizing (D1) | C3 / D1 |
| **KIS / KAS** | Carry parts on EVA, winches, pipes | Inventory, tethers, winches and towing on C3 ropes; construction on EVA | G3 |
| **Principia** | N-body gravity, Lagrange points | "N-body" option with a numerical integrator | G4 |
| **Real Solar System + Realism Overhaul + RP-1** | Earth-scale system, realistic engines | Realism preset: 10× scale, limited ignitions, ullage | G4 |
| **Dang It! / Kerbalism failures** | Random part failures | Reliability option | G4 |
| **kOS** | Programmable autopilot scripts | Scripting console (sandboxed JS) | G5 |
| **Near Future Technologies** | Electric propulsion, reactors, big solar arrays, trusses | Near Future-style pack | G6 |
| **Kerbal Planetary Base Systems / Station Parts Expansion / USI Kolonization** | Bases, stations, colonies | Bases and colonies pack | G7 |
| **Bluedog Design Bureau / Tantares** | Historical-style rockets and spacecraft | Classic rockets pack (original names) | G8 |

### Modding support (the CKAN idea, built in)

Parts, bodies and missions are plain data plus sprite sheets (separated from code in step A0). Step G1 adds a loader so a "pack" can be dropped in or loaded from a GitHub URL, with a manifest listing what it adds. The mod packs in G6–G8 are built with the same loader.

---

## 4. Roadmap

### 4.1 How the steps are sized

Each step is meant to fit in **one session within a single 5-hour usage limit on Opus 5.5**. I sized every step to roughly the amount of work that built the prototype: one major system (about 1,000–2,000 lines written or rewritten), or one batch of parts with their art, plus testing and a playable build. Usage can't be measured exactly ahead of time, since it depends on your plan and how much back-and-forth a session has. So every step has:

- **Must**: the core that fits comfortably;
- **Stretch**: extras, done only if budget remains, and the first thing to drop;
- **Done when**: a check that proves the step works.

### 4.2 How to run a step

1. Start a fresh session with: *"Continue Flatspace Program: read PLAN.md and PARTS.md, then do step A0 only."* Attach the latest project zip. Better still, after step A0 puts the project on GitHub, add the repository to each session, so every session starts from the current code.
2. The session works through the Must list, then Stretch if there is budget left.
3. Before finishing, it:
   - runs `node tests/run.js` and takes screenshots;
   - ticks the step in the status table below, ticks any finished rows in `PARTS.md`, and adds a line to the changelog at the end of this file;
   - from E4 on, if the step added parts or features: notes in its Result which tech node each belongs in and ideas for contracts that use it, for the next "Tech and contracts" step (section 4.4);
   - bumps `FS.VERSION` in `js/util.js` and the matching `?v=` tags on every script and style link in `index.html` (so browsers never mix cached old files with new ones; the page test checks they match);
   - runs `node tools/roadmap.js` to redraw the roadmap graphic in the README;
   - republishes the playable page and hands back the updated project.
4. If a session runs short, unfinished Must items move to the top of the next step. The game must run at the end of every session, so nothing is left half-built.

### 4.3 Why this order

1. **Prepare the prototype (A0).** Separate the simulation from the drawing and set up tests, so the renderer, the physics and the editor can each be replaced later without tangling.
2. **Building (A1–A4).** The part tree changes the data every later system reads (mass, drag, contact points, staging), so it comes next.
3. **Art (B1–B5).** Before any new parts are added, so every part from then on is drawn once, in pixel art.
4. **Physics (C1–C5).** Before legs, parachutes, wheels, docking, wings and robotics, which all need contacts, joints, ropes and lift.
5. **Content (D–G).** The parts catalogue is built alongside the features that use it, with dedicated parts steps (D5, D6, D7, F7) for the big families. Mod packs come next, on top of the pack loader. Competition mode (D8) closes Phase D: by then the physics is final, saves and craft codes exist, and the parts list is big enough for interesting rules, but it doesn't wait for science or career.
6. **Tech and contracts at the end of each phase (E11, F11, G9, H10).** Every new technology gets a logical place in the tech tree and contracts of its own (section 4.4).
7. **Beyond KSP (H1–H9).** Last, because each one builds on the rest: astronauts on EVA (E7), joints, ropes and water (Phase C), docking (E6), the autopilot (E8), stations and life support (G7).

### 4.4 Tech and contracts for everything new

The tech tree arrives in E4 and contracts in F2. Everything after that must fit into both, so no part or feature is left outside progression:

- **Every step from E4 on** that adds a part or feature notes, in its Result, which tech node it belongs in and ideas for contracts that use it.
- **Each phase from E on ends with a "Tech and contracts" step:** E11, F11, G9 and H10. That step:
  - adds the tech nodes, in a logical place in the tree (a part never unlocks before the parts it depends on);
  - adds contract templates that ask the player to use the new things;
  - balances science costs and rewards, so a new save still progresses at the intended pace.
- **Automated checks**, added in E11 and run by `node tests/run.js` from then on:
  - every part belongs to exactly one tech node;
  - every tech node can be reached;
  - from F11 on, every major feature is used by at least one contract template.
- **Data:** tech nodes (`data/tech.js`) and contract templates (`data/contracts.js`) are data, so packs add their own (G1, G9).
- **Earlier content:** parts and features from Phases A–D are placed by E4 itself; everything before F2 gets contracts in F2.

### 4.5 Status

| Step | Name | Status |
|---|---|---|
| P | Prototype | ✅ done |
| **A** | **Prepare and rebuild the builder** | |
| A0 | Prepare the prototype | ✅ done (v0.2.0) |
| A1 | Part tree and vessel physics | ✅ done (v0.3.0) |
| A2 | Drag-and-drop editor | ✅ done (v0.4.0) |
| A3 | Editor tools | ✅ done (v0.5.0) |
| A4 | Staging, tweakables, stretchable tanks, craft files | ✅ done (v0.6.0; follow-up v0.6.1) |
| **B** | **Pixel art overhaul** | |
| B1 | WebGL renderer, palette and sky | ✅ done (v0.7.0) |
| B2 | Part sprites and lighting | ☐ |
| B3 | The world up close | ☐ |
| B4 | Effects and motion | ☐ |
| B5 | Interface reskin and title screen | ☐ |
| **C** | **Physics upgrade** | |
| C1 | Rigid bodies, collisions, floating origin | ☐ |
| C2 | Joints, articulated parts and breaking | ☐ |
| C3 | Ropes, cables and parachutes | ☐ |
| C4 | Atmosphere, aerodynamics and water | ☐ |
| C5 | Orbit precision and prediction | ☐ |
| **D** | **Complete sandbox** | |
| D1 | Landing legs and parachutes | ☐ |
| D2 | RCS, control parts, action groups, fuel control | ☐ |
| D3 | Space Center, saves, multiple vessels | ☐ |
| D4 | Targets and planning tools | ☐ |
| D5 | Parts: sizes, coupling and structure | ☐ |
| D6 | Parts: engines | ☐ |
| D7 | Parts: command pods, probes and cabins | ☐ |
| D8 | Competition mode (physics club) | ☐ |
| **E** | **Solar system and science** | |
| E1 | The solar system | ☐ |
| E2 | Planet art and biomes | ☐ |
| E3 | Science | ☐ |
| E4 | Tech tree and Science mode | ☐ |
| E5 | Power and heat | ☐ |
| E6 | Docking and rendezvous | ☐ |
| E7 | EVA, crew and inventory | ☐ |
| E8 | Autopilot and trajectory prediction | ☐ |
| E9 | Sound, settings, tutorials | ☐ |
| E10 | Terrain detail (Parallax idea) | ☐ |
| E11 | Tech and contracts: Phase E additions | ☐ |
| **F** | **Career** | |
| F1 | Funds, costs and Career start | ☐ |
| F2 | Contracts | ☐ |
| F3 | Facilities, crew and strategies | ☐ |
| F4 | CommNet | ☐ |
| F5 | Resources and scanning | ☐ |
| F6 | Spaceplanes: flight and ground handling | ☐ |
| F7 | Parts: spaceplanes, fairings and bays | ☐ |
| F8 | Rovers and surface science | ☐ |
| F9 | Asteroids and comets | ☐ |
| F10 | Planner and hardcore options | ☐ |
| F11 | Tech and contracts: Phase F additions | ☐ |
| **G** | **Modded** | |
| G1 | Packs and mods menu | ☐ |
| G2 | Mission Builder | ☐ |
| G3 | Robotics and construction | ☐ |
| G4 | Realism options | ☐ |
| G5 | Scripting console | ☐ |
| G6 | Near Future pack | ☐ |
| G7 | Bases, stations and colonies pack | ☐ |
| G8 | Classic rockets pack and final parts audit | ☐ |
| G9 | Tech and contracts: packs | ☐ |
| **H** | **Beyond KSP** | |
| H1 | Living astronauts | ☐ |
| H2 | Interiors (IVA) | ☐ |
| H3 | Hands-on: objects, tools and cargo | ☐ |
| H4 | Damage, failures and repairs | ☐ |
| H5 | Life on board and spin gravity | ☐ |
| H6 | Self-landing rockets | ☐ |
| H7 | Launch and recovery infrastructure | ☐ |
| H8 | Tethers, sails and mass drivers | ☐ |
| H9 | Flight recorder, replays and photo mode | ☐ |
| H10 | Tech and contracts: beyond KSP | ☐ |

64 steps after the prototype.

### Prototype (done)

- **Hangar:** 16 parts in 5 categories, stack building, live Δv/TWR/burn time per stage, save/load, three sample craft.
- **Flight:** throttle, staging, solid and liquid engines, reaction wheels, engine gimbal, fins, drag, parachutes, debris.
- **SAS:** stability, prograde, retrograde, radial in/out, maneuver.
- **Bodies:** Aster (rotating planet, ocean, atmosphere) with moons Mira and Pell.
- **Orbits:** patched conics with SOI transitions, encounters, escapes, impacts, and up to 3 predicted patches.
- **Map view:** zoom, pan, focus switching.
- **Maneuver nodes:** node editor, burn timer, "warp to node", and a dial marker.
- **Time warp:** up to 100,000× with altitude limits; physics warp to 4×.
- **Endings:** landing, splashdown, crashing with explosions, and recovery with a flight summary.
- **Extras:** milestones for first space, orbit, encounters, landings and return; touch controls for phones and tablets.

---

### Phase A — Prepare and rebuild the builder

#### A0 · Prepare the prototype
**Goal:** reshape the prototype's code so every later phase can build on it without rewrites piling up. No new gameplay; the game should play exactly as it does now.

**Must:**
- **Repository:** put the project on GitHub with Pages turned on, so later sessions can start from the repository. Show a version number in the menu.
- **Tests:** turn the checks used while building the prototype into a `tests/` folder with one command, `node tests/run.js`. It covers:
  - automated ascent to orbit;
  - a hopper flight with parachute landing;
  - capsule reentry;
  - on-rails accuracy over one orbit;
  - a Mira encounter and SOI change;
  - Δv numbers for the sample craft;
  - a headless page smoke test.
- **Simulation separate from drawing:**
  - vessels and the game loop emit events (staged, exploded, touched down, changed SOI) instead of calling the renderer and toasts directly;
  - the renderer only reads state.
  - This is what lets B1 swap in the WebGL renderer and C1 swap in the rigid-body engine.
- **Split `main.js`:** into `sim.js` (stepping vessels and debris), `input.js`, `warp.js` (time warp and rails) and `nodes.js` (maneuver nodes).
- **Renderer interface:** `render.js` becomes the Canvas 2D implementation of a small interface (draw flight, draw map, particles) that the WebGL renderer implements in B1.
- **Data separate from code:** part stats and body data move to `data/parts.js` and `data/bodies.js`, with drawing code kept apart. This is the first step towards packs (G1).
- **Versioned saves:** every stored craft and setting carries a format version, with a migration hook (A1 uses it for the part tree).
- **Fix prototype limits that later steps assume are gone:**
  - maneuver nodes are deleted on any SOI change; keep nodes that sit on later patches;
  - nodes can only be placed on the first patch; allow them on every patch;
  - debris is deleted when time warp goes on rails; keep it, on rails;
  - touch screens can't zoom; add pinch zoom in flight and in the map;
  - the solid booster shares KSP's nickname "Thumper"; give it an original name.
- **Dev overlay:** F3 shows frame time, physics steps per frame and particle count, to watch performance as later steps add load.

**Stretch:** a `?debug` address flag that starts a flight already in orbit, to speed up testing.

**Done when:** the game plays as before; `node tests/run.js` passes; the file layout matches section 1.2; the game is live on GitHub Pages.

**Result (v0.2.0):** done, except turning on GitHub Pages, which you do in the repository's Settings → Pages.
- **First half (v0.1.1):**
  - tests;
  - part and body data in `data/`;
  - versioned saves;
  - version number;
  - F3 overlay;
  - part renames ("Thumper" → "Rumbler", and plain tank and engine names).
- **Second half (v0.2.0):**
  - **Split:** `main.js` split into `sim.js`, `warp.js`, `nodes.js` and `input.js`.
  - **Events:** craft report events instead of calling the page.
  - **Renderer interface:** `FS.Renderer`, which `main.js` checks at start-up.
  - **Maneuver nodes:** they survive SOI changes and can be placed on any patch.
  - **Debris:** kept, on rails, during time warp.
  - **Touch:** pinch zoom in flight and the map.
  - **Debug flag:** `?debug` starts in orbit.
- **Tests:** 6 test files, including new ones for debris on rails, a node surviving a Mira encounter, and pinch zoom.

#### A1 · Part tree and vessel physics
**Goal:** replace the single vertical stack with a tree of parts that can sit anywhere, so side boosters and asymmetric craft fly correctly.

**Must:**
- **Part definitions:** attach nodes (top, bottom, surface) and a hull outline for drag and collisions.
- **Vessel data:** a tree of part instances with parent, attach node, position, rotation and flip. Saved as craft format v2; old stacks convert through the A0 migration hook.
- **Physics from the tree:** mass, centre of mass, moment of inertia, angle-dependent drag area, and a thrust line per engine (off-centre thrust makes torque). Structured as a compound rigid body, ready for C1.
- **Fuel flow:** engines draw through the tree, stopping at decouplers.
- **Decoupling:** splits the tree into two vessels, each keeping its velocity and spin.
- **Staging:** the stage list is generated from the tree.
- **Editor:** the current click-to-stack editor keeps working on the new model.
- **Tests:** new tests for asymmetric thrust, decoupling and craft migration.

**Stretch:** radial decoupler parts, to fly a pair of side boosters.

**Done when:** the three sample craft fly as before; a hand-written craft file with off-centre parts flies and stages correctly; tests pass.

**Result (v0.3.0):** done, including the stretch.
- **Part tree:** `js/partgraph.js` holds the tree, the default staging and a stage-by-stage Δv calculator.
  - Side boosters light with their core and drop first (stages "I D DI D C").
  - The calculator handles parallel burns.
- **Vessel physics:**
  - each engine pushes along its own line;
  - drag is worked out part by part from the angle of the airflow, so fins stabilise by having side area rather than by a fixed rule;
  - every part's outline is checked for ground contact;
  - a decoupler anywhere splits the craft, keeping its motion and spin.
- **Saves:** format 3 (part trees); old stacks convert automatically.
- **New part and sample:** the Side Decoupler, and a "Twin Boosters" sample that reaches orbit.
- **Tuning:** fins no longer add head-on drag (they wrongly added 1.6 m² before). Rockets now fly higher, so the main parachute was enlarged to keep landings under crash speed.
- **Tests:** 7 test files, including off-centre thrust, booster separation and a Twin Boosters flight to orbit.

#### A2 · Drag-and-drop editor
**Goal:** build rockets by dragging parts, as in KSP and Spaceflight Simulator (section 1.4).

**Must:**
- **Layout:** tray with category tabs and hover cards, a pannable/zoomable build area with no size limit, and a stats panel.
- **Placing:** a ghost follows the pointer; stack and surface attach points snap; invalid drops show red and return to the tray.
- **Moving:** picking up a part carries its children; dropping onto the tray deletes; the first part becomes the root.
- **Live stats:** Δv, TWR, mass and height update while dragging.
- **Touch:** long-press to pick up; two-finger pan and pinch zoom.

**Stretch:** re-root (make another part the root).

**Done when:** the three sample rockets can be rebuilt from scratch by dragging alone, on desktop and on a phone-sized screen.

**Result (v0.4.0):** done, including the stretch.
- **Building geometry** in a new `js/build.js`, with no drawing, so tests drive it directly:
  - stack nodes snap end to end; a parachute has only a bottom node and side-only parts (the Side Decoupler) have none;
  - surface attach on the left or right side of any part, snapping to the middle of the side;
  - among the spots in reach, the nearest free one wins; a spot that would overlap another part is refused.
- **Editor** (`js/editor.js`, rewritten):
  - **tray:** category tabs and a hover card with full stats; side parts are now in the tray;
  - **build area:** pan and zoom with no size limit, a grid fixed to the craft, attach points lit while carrying a part, the ghost blue when it fits and red when it doesn't;
  - **carrying:** a placed part comes away with everything below it; dropping on the tray removes it; a refused drop sends a new part back to the tray and a placed part back where it was;
  - **live stats:** Δv, launch TWR, mass and height update while a part is carried, as if it were dropped there;
  - **touch:** hold a part to pick it up, drag from the tray, one finger pans, two fingers pan and pinch;
  - **extras:** click or tap a tray part to add it at the lowest free attach point; Fit (Home); Make root (the stretch goal).
- **Tests:** 8 files. A new building test rebuilds all four sample craft by simulated drags, sloppy by up to half a metre, and checks they match part for part with the same Δv and staging. The page test rebuilds Hopper with pointer events and covers long-press, drop on tray, pinch, a bad drop and re-rooting. Real finger drags on a phone-sized page were checked in Chromium.
- **Plan change:** on touch, part settings (A4) open by tapping the selected part again, since a long-press now picks parts up.

#### A3 · Editor tools
**Goal:** the precision tools that make building fast.

**Must:**
- **Symmetry:** mirror symmetry (X).
- **Rotate and flip:** rotate (Q/E, 15°; Shift 5°) and flip (F).
- **Offset:** Alt-drag along the parent surface, with a snap toggle.
- **History:** undo/redo with 100 steps.
- **Copy:** Alt-click to copy a subassembly; save subassemblies to a list.
- **Overlays:** centre of mass, centre of thrust (with its thrust line) and centre of pressure, each switchable; a warning when the centre of pressure sits ahead of the centre of mass.

**Stretch:** angle snap settings; vertical snap.

**Done when:** a rocket with mirrored side boosters, angled fins and an offset part can be built in about a minute, and undo reverses every action.

**Result (v0.5.0):** done, with the vertical-snap stretch (the Snap switch); angle snap settings were not done (Shift gives 5° steps).
- **Tool rail** on the left of the build area, with a button for every key, so touch screens get every tool:
  - undo / redo (100 steps; loading a craft can be undone too);
  - mirror, rotate, flip;
  - offset and snap;
  - copy and "save sub".
- **Mirror (X):**
  - a part on the side of a part comes with a twin on the other side;
  - a part on a twin gets its own twin on the other twin, so boosters, their decouplers and anything on them come in pairs;
  - twins move, turn, slide and are removed together, and the links are saved with the craft.
- **Rotate (Q / E, Shift for 5°) and flip (F):**
  - turn the carried part, or a placed side part, which stays touching its parent's surface;
  - side parts now keep their offset and angle in their parent's own frame, so turning a part carries its side parts round with it.
- **Offset (Alt-drag, or the Offset switch on touch):** slides a side part along its parent, in 0.25 m steps that catch the middle when Snap is on; overlaps are refused.
- **Copy and subassemblies:**
  - Alt-click (or Copy) picks up a copy of a part and everything below it, which follows the pointer until the next click or tap; Alt-drag drags a copy;
  - "Save sub" keeps the selected part and everything below it in a new Subassemblies tab in the tray, to drag into any craft (saved as `flatspace.subassemblies` v1).
- **Overlays:** switches for the centre of mass, the centre of thrust with its thrust line, and the centre of pressure; warnings when the centre of pressure is ahead of the centre of mass, or the thrust line misses it.
- **New part:** Swept Fin, a single side fin (covers KSP's Basic Fin).
- **Physics change brought forward from C4:**
  - The overlay showed the drag-only model gave fins almost no straightening force at small angles; with SAS off, every sample rocket turned away from the airflow.
  - Each part now also feels a sideways push across it. On bodies it grows with the square of the angle; fins act like small wings and push back from the first degree.
  - Flight and the editor share one function (`FS.partAero`), so the overlay matches how the craft flies.
  - Now a finned rocket straightens itself and a finless one doesn't, matching its centre of pressure.
- **Sample change:** finned rockets now fall nose-first and fast. The Hopper went 33 km up and came down too fast for its parachute, so it now uses the short tank and makes a 2.4 km hop.
- **Tests:** 8 files, about 60 new checks. They cover mirrored boosters and their staging, tilted fins touching the tank, offset with its twin, overlaps refused, save and load of angles and mirror links, the centre of pressure moving behind the centre of mass with fins, and flight agreeing. The page test builds the done-when rocket with pointer events and keys, then Ctrl+Z reverses every step and Ctrl+Y restores them.

#### A4 · Staging, tweakables, stretchable tanks, craft files
**Goal:** control over each stage, and Spaceflight Simulator-style flexible tanks.

**Must:**
- **Staging editor:** drag parts between stages, add/remove stages, "include in staging" toggle; automatic until edited.
- **Tweakables panel:** fuel level, thrust limit, gimbal, crossfeed, parachute deploy altitude.
- **Stretchable tanks:** length in 0.25 m steps and six widths; mass and fuel scale with volume.
- **Presets:** every stock KSP tank length appears as a preset in the tray.
- **Tank skins:** white, gold foil, orange foam, roll pattern, steel.
- **Craft files:** export/import as JSON files, and share by copy-paste text.

**Stretch:** craft thumbnails in the load menu.

**Done when:** a craft with custom staging, a 9 m stretched tank and custom skins saves, reloads, exports, imports and flies as configured.

**Result (v0.6.0):** done; the stretch goal (thumbnails in the load menu) was not done.
- **Every part carries its own size and settings:** length, width, dry mass, fuel capacity and drag area, plus fuel level, look, thrust limit, gimbal range, crossfeed, parachute height and stage. Flight, the Δv maths and the overlays all read them.
- **Stretchable tanks:**
  - drag the handle at a selected tank's free end, or use its settings, to set the length in 0.25 m steps (up to 24 m) and any of the six widths;
  - the attached end stays put, side parts stay on the surface, and mirror twins change too;
  - a change that would make parts overlap is refused.
- **Tank sizes now share one density** (640 kg of fuel per m of length per m² of width², empty mass an eighth of that), so presets and stretched tanks agree. Every existing tank kept its fuel and mass, so Δv is unchanged, but lengths moved to the 0.25 m grid:
  - Short 0.5 m (was 0.75);
  - Medium 2 m (was 1.9);
  - Long 4 m (was 3.75);
  - Heavy 4 m (was 7.5, which held only half the fuel its size suggested).
- **Presets:** the Fuel tab lists 21 tank presets in six widths, covering every stock KSP tank length (the 5 m family brought forward from D5). Each is a stretchable tank.
- **Looks:** white, gold foil, orange foam, roll pattern and bare steel.
- **Part settings panel:** right-click a part, tap a selected part again, or press ⚙ on the tool rail. Sliders don't add an undo step until let go.
  - tanks: length, width, look, fuel at launch;
  - engines: thrust limit, gimbal range;
  - decouplers: crossfeed;
  - parachutes: the height at which they open fully;
  - every stageable part: "fires in staging".
- **Staging editor:**
  - the stage list stays automatic until the first edit, then turns custom, keeping the stages it had;
  - parts show as chips; drag a chip between stages (or press [ and ] on it), move stages up and down, add and remove stages, drop parts in "Not staged", and reset to automatic;
  - in custom staging, newly added parts go into a new last stage, with a message;
  - stage numbers are saved on the parts; subassemblies leave them out.
- **Craft files (Files button):** download a `.craft.json` file, open one, copy the craft as one line of text, or paste text to load it. Older formats are upgraded on import; unknown parts are left out with everything attached to them, and the dialog says how many.
- **Tests:** 9 files. A new craft test covers tank scaling and presets, saving every setting, thrust limit, fuel level, crossfeed, custom staging, parachute height and craft files. It also flies the done-when craft (9 m roll-pattern tank, gold upper tank, decouple and ignite as separate stages) from share text to space. The page test does the done-when steps through the real interface: right-click settings, dragging the stretch handle to 9 m, gold foil, moving a stage chip, saving and reloading, then copying as text and pasting it back.

**Follow-up (v0.6.1):** part pop-ups, floating parts and settings in flight.
- **Parts on sloped faces line up with the face:** a fin or booster on a tapered part (a capsule, a nose cone, an adapter) leans to match the face's slope and sits flush against it, rather than standing upright and touching at one corner.
- **Floating parts:** a part dragged into empty space stays there instead of being refused. It is drawn faded with a dashed outline and isn't counted in the stats, staging or overlays. Its pop-up chooses what happens at launch:
  - **Leave behind** (the default): it stays in the hangar and is saved with the craft;
  - **Launch with the craft:** it appears beside the craft on the pad, in the same place relative to it, as a separate uncontrolled object (D3 makes these vessels you can switch to).
  - Dragging it back onto the craft attaches it again. Copies (Alt-click) dropped in empty space float too.
- **Part pop-ups replace the fixed settings panel:**
  - selecting a part opens its pop-up beside it, with a dashed pointer line to the part;
  - selecting another part swaps an unpinned pop-up for the new one; the 📌 button pins it, so several can stay open;
  - drag the title bar to move one; it then keeps that spot relative to the part as you pan and zoom;
  - `js/part-panel.js` is now a pop-up manager used by both the hangar and flight.
- **In flight:** click or tap a part (or right-click it) to open its pop-up. It shows the part's state and lets you change, mid-flight:
  - an engine's thrust limit and gimbal range; shut it down or start it again (solid boosters can only be lit);
  - a decoupler's crossfeed, or fire it now;
  - a parachute's opening height, or arm it now.
  Pop-ups close when their part is staged away or destroyed.
- **Renderer interface:** `partToScreen` and `screenToPart`, so flight input can find parts under the pointer.
- **Vessel:** `act(part, action)` for decouple, ignite, shut down and deploy, with a `part-action` event; the vessel built for flight uses only the main craft.
- **Tests:** the craft test checks face alignment, floating parts saving and launching in the right spot, and in-flight actions. The page test opens, swaps, pins, drags and closes pop-ups, floats an engine and launches it with the craft, and changes a thrust limit from a pop-up in flight.
- **Moved to later steps:** see D2 (more in-flight actions), D3 (floating groups as vessels), C3 (cutting and repacking chutes), E5 (temperatures in pop-ups), B5 (pixel-art pop-ups) and D5 (alignment on curved faces).

---

### Phase B — Pixel art overhaul

All steps follow the art rules in section 1.5: sprites rotate freely, and their pixels turn with them as crisp squares.

#### B1 · WebGL renderer, palette and sky
**Goal:** the rendering foundation every later art step builds on.

**Must:**
- **WebGL2 renderer:** behind the A0 renderer interface, with:
  - a sprite batcher and the sharp-pixel shader (crisp squares at any angle, no shimmer);
  - meshes for terrain and planets;
  - a particle buffer;
  - lighting uniforms;
  - an overlay canvas for orbit lines and labels;
  - a clear message if the browser lacks WebGL2.
- **Palette and dithering:** `art/palette.js` with about 48 colours in hue-shifted ramps, plus an ordered-dither helper for gradients.
- **Sky:** banded and dithered by altitude and sun angle, with sunsets; a pixel star field with a few twinkling stars and a galaxy band.
- **Planets from afar:** pixel-art textures for each body, turning with the body, with a dithered atmosphere rim and night side, in both flight and map.
- **Temporary art:** the prototype's vector parts and terrain are baked into 16 px/m textures at load, so the game stays playable until B2 and B3 replace them.
- **Gallery:** an `art.html` page showing the palette and sprites, rotating.

**Stretch:** a pixel-size setting.

**Done when:** a slow-rotation recording at two zoom levels shows crisp, shimmer-free squares, and nothing in the game view is blurred.

**Result (v0.7.0):** done, including the stretch (a pixel-size setting).
- **One pixel grid:** world art pixels are (1/16)·2^k m. k is the smallest value that keeps an art pixel at least the chosen pixel size on screen, and parts, terrain, planets and particles all share it, so pixels of different sizes never sit side by side. The setting is in the Esc menu: Fine (1.5 CSS px, the default), Medium (2) or Chunky (3). It is saved under a new versioned key, `flatspace.settings`.
- **WebGL2 renderer (`js/render-gl.js`)**, behind the same `FS.Renderer` interface:
  - **sprite batcher and sharp-pixel shader (`js/gl.js`):** a 2048² atlas filled on demand. Each art pixel is a flat colour, smoothed over exactly one screen pixel at its edges, at any angle. Sprites fade by Bayer dither, not transparency;
  - **planet meshes:** a full-screen shader per body, limited to its screen area, works out each art pixel's height and depth. It draws ocean (with a foam line), the surface layer (grass with tufts, sand, rock, snow), soil, rock strata, the deep interior seen from afar, the atmosphere rim, and a dithered night side. Heights come from a 4096-sample texture for each body, or, close to the ground, a 1024-sample window around the camera refreshed every frame, worked out in the ground's own frame so nothing jitters far from the planet's centre;
  - **particle buffer:** exhaust, smoke and explosions are pixel puffs coloured from palette ramps. The particle simulation stays in `render.js` and is shared by both renderers;
  - **lighting uniforms:** sun direction for planets; sprites dim in a planet's shadow and towards dusk. This dimming tints the palette colours; B2 replaces it with proper lit ramps;
  - **overlay canvas** for orbit lines, Ap/Pe and encounter markers, the node and labels;
  - **fallback:** without WebGL2 the game uses the Canvas 2D renderer and says so in a notice. `?canvas2d` forces it.
- **Palette (`art/palette.js`):** 53 colours in 10 hue-shifted ramps (metal, orange, gold, green, blue, night, dusk, earth, teal, red). It has a Bayer dither helper and nearest-colour snapping. Shaders step between palette entries: solid for most of the way, dithered only near each change.
- **Sky:** palette bands chosen by altitude, sun angle and sunset. There are 700 pixel stars, a few twinkling, plus a dithered galaxy band; stars and galaxy fade out in daylight.
- **Planets from afar:** each body's own pixel texture turns with it, in flight and on the map. Aster shows islands in a blue sea with a dithered atmosphere rim; Mira is grey and Pell teal.
- **Temporary art:** the prototype's vector parts, parachute canopies and space-centre buildings are baked at the current art-pixel size, cut to fully opaque or clear pixels and snapped to the palette. The space centre is baked in 32 m tiles, only where visible.
- **Gallery (`art.html`):** the palette, and every part plus each tank look turning slowly at 1×, 2× or 4×.
- **Checked:** a recording turning the craft 0.5° a frame at 8 and 16 art pixels per metre. In a finer check (0.05° steps), no screen pixel jumped colour between frames; edges move smoothly. Close up, 84% of the craft's screen pixels are exact palette colours, and the rest are one-pixel edge blends.
- **Tests:** 10 files. The new `tests/test_gl.js` runs the game in Chromium through Playwright (skipped if Playwright isn't installed). It checks the WebGL renderer is used, palette crispness, no colour jumps while turning at two zoom levels, the pixel-size setting, the map, `?canvas2d`, and the gallery. The page test checks the Canvas 2D fallback and its notice.
- **Not done, left for later steps:**
  - the editor still draws with Canvas 2D (B2 moves it to the same sprites);
  - the soft glow at the bottom of the screen that showed where the ground was when it was out of view (B3);
  - particle shapes and timing (B4).

#### B2 · Part sprites and lighting
**Goal:** every existing part redrawn as pixel art and lit by the sun as the rocket turns.

**Must:**
- **Sprite format and lighting:** a colour layer plus a shape layer, lit in the shader (4–5 tone ramps, specular pixel, planet shadow, engine glow).
- **All current parts:** redrawn at 16 px per metre, with rivets, seams, hatches, windows, stripes, foil texture and nozzle heat tint.
- **Stretchable tanks:** 3-slice sprites (top cap, repeating body, bottom cap) in the 1.25 m and 2.5 m widths; skins are palette swaps.
- **Profile generator:** the generator for cylinders, cones and adapters that D5–D7 reuse for the bulk of the catalogue.
- **Zoom-out versions:** ½ and ¼ scale, then a pixel icon.
- **Editor:** tray thumbnails and the build area use the same sprites.
- **Overrides:** a PNG in `art/overrides/` replaces any generated sprite.

**Stretch:** damage and scorch states.

**Done when:** the gallery shows every part rotating under 4 sun angles. **Checkpoint:** you review the gallery and give direction before B3 starts.

#### B3 · The world up close
**Goal:** ground, sea and the launch site look as good as the rockets.

**Must:**
- **Terrain mesh:** textured with pixel-art material tiles (soil and rock strata, cliffs, beaches, snow above 2.5 km, crater rims on moons) that follow the ground's curve.
- **Surface details:** grass tufts, rocks and boulders, scattered by seed.
- **Ocean:** animated waves, a foam line on beaches, sun glint, darker deep water.
- **Depth:** two parallax layers of distant hills; a drifting cloud layer you fly through between 2 and 8 km.
- **Launch site:** pad with flame trench, lattice tower whose arms swing away at launch, assembly building, tracking dish, blinking beacons.
- **Day and night:** sunlit terrain by day; lit windows at night.

**Stretch:** birds, or steam vents on the pad before launch.

**Done when:** screenshots of the launch, flight through clouds, a beach landing, the mountains, and Mira's craters each look finished.

#### B4 · Effects and motion
**Goal:** fire, smoke and explosions that feel alive, with no soft blobs.

**Must:**
- **Particles:** a pixel particle system; exhaust follows a temperature ramp, and smoke fades by dither.
- **Plumes:** layered animated sprites, tight with Mach diamonds in air and wide and faint in vacuum; solid boosters are smokier.
- **Launch steam:** a ground steam cloud rolling out of the flame trench.
- **Explosions:** frame sequences, debris pixels, scorch marks, light screen shake.
- **Reentry:** plasma glow and streaks shaped by speed, plus heat tint on parts.
- **Parachutes:** canopy art built from segments, so the physics in C3 can bend, inflate and swing it.
- **Staging:** separation puffs and sparks.

**Stretch:** heat shimmer above engines.

**Done when:** a recorded launch-to-landing GIF reads clearly and stays consistent at every zoom.

#### B5 · Interface reskin and title screen
**Goal:** the HUD and menus match the art.

**Must:**
- **UI kit:** 9-slice panels, buttons, toggles, sliders and tooltips, all in the palette.
- **Fonts:** pixel fonts at whole-number sizes. Candidates on Google Fonts: Pixelify Sans, Silkscreen, Jersey 10, VT323; picked for legible numbers.
- **Icons:** pixel icons for SAS modes, part categories, staging events and warp.
- **Navball:** redrawn as rotating pixel art.
- **Title screen:** an animated scene (the pad at dawn).
- **Readability:** minimum text sizes and contrast checks.
- **Part pop-ups:** redrawn in the UI kit, with a pixel pointer line, and a compact layout that docks to the screen edge on phones instead of covering the craft.

**Stretch:** a short animated logo.

**Done when:** title, editor, flight, map and dialogs share one visual language and work on a phone.

---

### Phase C — Physics upgrade

See the table in section 1.3 for what changes.

#### C1 · Rigid bodies, collisions, floating origin
**Goal:** replace the hand-written vessel physics with a rigid-body engine, without changing how flight feels.

**Must:**
- **Engine:** add planck.js to `lib/`. Each vessel is a compound body with one shape per part hull. A short first test confirms planck.js fits; if not, write a small solver with the same interface.
- **Terrain collision:** collision shapes generated along the ground under each active vessel, refreshed as it moves.
- **Collisions:** between vessels and debris.
- **Floating origin and moving frame:** the solver works near the active craft, in a frame moving with it, so orbital speeds stay within the engine's limits.
- **Forces:** gravity, thrust, drag and parachutes applied per part at the right point.
- **Ground behaviour:** craft rest, tip over, roll and bounce, replacing the prototype's ground test and the interim contact model from v0.6.2 (`Vessel.groundContact`, `tipsOver`), whose tests must still pass.
- **Unchanged parts:** physics warp and on-rails behaviour work as before.

**Stretch:** sparks and dust on scraping contact (feeds B4's effects).

**Done when:** existing ascent and reentry tests still pass within 1%; a rocket on a slope tips over; debris collides with the craft that dropped it; a craft orbiting at 2 km/s stays stable through 10 minutes of physics time.

#### C2 · Joints, articulated parts and breaking
**Goal:** craft that bend the rules break, and moving parts become real physics objects.

**Must:**
- **Joint loads:** the force and torque at every joint in the part tree, from thrust, drag and acceleration.
- **Joint strength:** set by part size, so overloaded joints break and the craft splits.
- **Impacts:** break parts by impact speed; the craft survives if its command part does.
- **Explosions:** damage neighbouring parts.
- **Joint toolkit:** springs, hinges, sliders, wheel joints and welds, each with limits, motors, stiffness and damping, ready for legs (D1), docking (E6), gear (F6), wheels (F8) and robotics (G3).
- **Articulated vessels:** parts with a hinge, slider, spring or wheel become separate bodies joined to the rest of the craft. Parts that never move stay welded into one body, for speed. Mass, Δv and staging still treat the craft as one vessel.
- **Separation:** decouplers push the two halves apart with an ejection force; separated parts keep their own momentum and spin.
- **Test parts:** a hinged test panel and a sprung test leg, to prove the toolkit before real parts use it.

**Stretch:** a "structural stress" overlay in the editor.

**Done when:**
- a tall, unstable rocket flipped at maximum dynamic pressure breaks at its weakest joint;
- the test leg compresses, bounces and settles under the craft's weight;
- the test panel, left open at high speed in the atmosphere, swings back and snaps off.

#### C3 · Ropes, cables and parachutes
**Goal:** parachutes and ropes that behave like fabric and line, not like a drag number.

**Must:**
- **Rope solver:** ropes made of linked segments (a position-based solver, stable at the game's step size), with:
  - slack, tension, stretch and damping;
  - a breaking strength;
  - collision with the ground;
  - two-way pull: a rope between two craft tugs on both.
- **Attachment:** ropes tie to attach points on parts; either end can be released or cut.
- **Physical parachutes:**
  - **Canopy:** a body of its own, shaped by a short chain of points so it can bend and billow, tied to the parachute part by rigging lines (ropes).
  - **Drag:** acts on the canopy, so the craft hangs beneath it and swings like a pendulum before settling.
  - **Staged opening:** packed → streaming → partly open → fully open, inflating over a few seconds. The opening shock shows on the G-force readout and can break weak joints (C2).
  - **After opening:** canopies drift with the air, collapse and drape over the ground after landing, and can be cut away to fall as debris.
  - **From the part pop-up:** cut the chute, and repack it on EVA (E7); the pop-up shows the chute's state and load.
  - **Several chutes:** they share the load, and a drogue-then-main sequence works.
- **Time warp:** ropes and canopies freeze in their current shape when the craft goes on rails, and carry on from there.
- **Performance:** a budget for active rope segments, shown in the F3 overlay.

**Stretch:** a sky-crane test: a hovering craft lowers a payload on cables and cuts it free.

**Done when:**
- a capsule under its main chute swings, then settles to a steady descent within 10% of the old drag model's landing speed;
- the opening shock shows on the G-force readout;
- a cut canopy drifts away as debris;
- a payload on a 20 m rope hangs, swings and lands without the rope stretching unrealistically.

#### C4 · Atmosphere, aerodynamics and water
**Goal:** flight that rewards good design.

**Must:**
- **Atmosphere:** a temperature profile per body, density from pressure and temperature, speed of sound and Mach number in the HUD.
- **Drag:** per-part drag with shielding (parts behind others or inside bays get less), and Mach drag rise.
- **Lift:** on fins, wings and bodies, with aerodynamic torque from where each force acts, so stability comes from centre of mass versus centre of pressure.
- **Water:** buoyancy and water drag; craft float, tip and sink.

**Stretch:** wind and gusts.

**Done when:** a rocket without fins flips in the lower atmosphere and the same rocket with fins flies straight; drag peaks near Mach 1; a capsule floats after splashdown.

*Already in place from A3:* every part feels a sideways push across it, with fins pushing back like small wings (`FS.partAero`, shared by flight and the editor overlay). C4 replaces that with proper lift curves and stall, and adds Mach effects and shielding.

#### C5 · Orbit precision and prediction
**Goal:** orbits that stay exactly where they should.

**Must:**
- **Integrator:** a symplectic integrator for gravity in physics mode, conserving orbital energy.
- **Clean hand-off:** physics and on-rails switch without drift.
- **Spin:** kept through time warp.
- **Thrust during warp:** an option for low-thrust engines (Persistent Thrust idea).
- **Patch predictor:** root-finding encounter search, up to 5 patches, and KSP-style display modes.
- **Performance pass (section 1.7):** profile a 200-part craft. If physics takes more than about 8 ms a frame, move the physics step into a Web Worker.

**Stretch:** an orbit-decay warning for craft grazing the atmosphere.

**Done when:** a craft switching warp at random over 100 orbits keeps Ap and Pe within 10 m; an ion-engine probe can burn during warp.

---

### Phase D — Complete sandbox

#### D1 · Landing legs and parachutes
**Goal:** landers and safe recovery.

**Must:**
- **Landing legs:** all stock landing legs (`PARTS.md`: Ground) as real hinged struts with spring-damper suspension (C2), folding out under physics, with a gear toggle (G).
- **Parachutes:** all stock parachutes, stack and radial, including drogues, built on the physical canopies from C3; deploy settings (pressure, altitude, opening speed) and canopy sizing (RealChute idea); cut and repack.

**Stretch:** landing guidance marker (vertical speed versus height above ground).

**Done when:** a lander settles on its legs on a slope on Mira and takes off again; a capsule lands under drogue then main chutes.

#### D2 · RCS, control parts, action groups, fuel control
**Goal:** fine control in flight.

**Must:**
- **RCS:** all monopropellant tanks, RCS blocks and the monopropellant engine; translation keys I/J/K/L; RCS toggle (R).
- **Control parts:** all reaction wheels and lights.
- **Action groups:** Gear, Lights, Brakes, Abort, 1–9, assigned in the editor.
- **In-flight part menu:** builds on the part pop-ups from v0.6.1 (which already do thrust limit, gimbal, engine on/off, crossfeed, decouple and chute height). Adds:
  - fuel transfer between tanks (pick a source and a target pop-up);
  - lights, reaction wheels and RCS on/off per part;
  - action group assignment from the pop-up, in the editor and in flight;
  - a short history line ("lit at T+00:12, 34% fuel used").
- **Fuel lines and struts.**

**Stretch:** RCS balance helper in the editor.

**Done when:** a slow approach can be fine-tuned with RCS, the abort group separates the capsule, and fuel transfer works.

#### D3 · Space Center, saves, multiple vessels
**Goal:** a persistent space program.

**Must:**
- **Space Center:** a pixel-art hub with clickable buildings (Assembly, Tracking Station, launch site picker).
- **Saves:** named save slots and autosave, stored in IndexedDB (room for hundreds of craft and save games; small settings stay in localStorage).
- **Persistent vessels:** craft left in flight stay on rails.
- **Tracking Station:** switch to, recover or terminate vessels.
- **Switching:** `[` `]` to switch vessels in flight.
- **Floating parts as vessels:** floating groups set to "Launch with the craft" (v0.6.1) become real vessels you can switch to, with their own staging and a name; those with a command part are controllable.
- **Launch sites:** a second launch site.

**Stretch:** a flag picker for the program.

**Done when:** three craft left in orbit survive a page reload and can each be flown again.

#### D4 · Targets and planning tools
**Goal:** KSP 1.12's planning tools, plus Kerbal Alarm Clock.

**Must:**
- **Targets:** target any body or vessel; target speed mode; target SAS modes; closest-approach markers.
- **Maneuver Tool:** circularize, change Ap/Pe, Hohmann transfer to a moon, return from a moon.
- **Alarm Clock:** alarms for nodes, Ap/Pe, SOI changes and manual times; each one stops warp.
- **Map handles:** drag handles on nodes in the map.
- **Auto-execute nodes:** an "Execute" button on each node. The craft then, without further input:
  1. turns to the burn direction;
  2. time-warps to the burn and drops out of warp in time;
  3. starts at the right moment, half the burn time before the node;
  4. keeps pointing along the remaining Δv as it changes;
  5. throttles down for the last few m/s;
  6. cuts the engine at zero, then moves on to the next node if there is one.
- **Execution details:**
  - it stages automatically if the current stage runs dry mid-burn;
  - it stops with a message if there isn't enough Δv;
  - pressing any flight control hands control back to the player at once.

**Stretch:** an "intercept" node generator.

**Done when:** a round trip Aster → Mira orbit → Aster is flown using only generated nodes, alarms and Execute; each executed burn ends within 0.5 m/s of the planned Δv.

#### D5 · Parts: sizes, coupling and structure
**Goal:** the structural backbone of the catalogue.

**Must:**
- **Verify the manifest first:** check `PARTS.md` against the in-game KSP part list (or the wiki in a browser) and add anything missing.
- **Tank widths:** 0.625, 1.875, 3.75 and 5 m tank art; the conical and external radial/toroidal tanks.
- **Coupling:** all stack decouplers and separators in every size; all radial decouplers; all adapters and adapter tanks; multi-couplers and multi-adapters; engine plates.
- **Structure:** girders, beams, panels, struts, structural tubes; rocket nose cones and fins; launch clamps.
- **Art:** mostly made with the B2 profile generator.
- **Curved faces:** side parts on curved profiles (nose cones, rounded pods) line up with the slope at the exact spot they touch; v0.6.1 uses a straight line from base to top.

**Stretch:** service bays (otherwise F7).

**Done when:** every D5 row in `PARTS.md` is ticked, and a 5 m heavy lifter with side boosters, an engine plate and launch clamps flies.

#### D6 · Parts: engines
**Goal:** every rocket engine.

**Must:**
- **Liquid engines:** every one in `PARTS.md`, with its own sprite, nozzle shape, plume settings and stats.
- **Solids:** all solid boosters, the separation motor and the launch escape tower.
- **Twin-Boar style:** the engine with its own built-in tank.
- **Nuclear engine:** with its heat output, used later by E5.

**Stretch:** engine shrouds that hide or show by staging.

**Done when:** every D6 row is ticked and each engine's Δv, thrust and Isp match its stats in the editor.

#### D7 · Parts: command pods, probes and cabins
**Goal:** every place to sit or think.

**Must:**
- **Command pods:** all capsules, including the reentry pods and lunar-module-style cabin; lander cans.
- **Crew spaces:** cupola, external seat, crew cabins.
- **Probe cores:** all of them, with their torque and control rules.

**Stretch:** pod interior view (a small pixel-art IVA window).

**Done when:** every D7 row is ticked.

#### D8 · Competition mode (physics club)
**Goal:** run a rocket-building competition for a physics club or a class. Everyone builds to the same rules, flies, and the organiser gets checked, ranked results on one screen. No server is needed: rules, entries and results travel as share codes and files, the same way craft files do (A4).

**Must:**
- **Organiser setup:** choose the challenges and rules, then share them as a competition code (one line of text starting `FLATSPACE-COMP-1:`, a file, or a QR code to scan). The rules can set:
  - which parts are allowed (by category or one by one), a part count limit and a mass limit;
  - a budget, with prices the organiser can change (Career's costs come later, in F1);
  - the world: Aster, one of the moons, or a "lab" world with switches for flat ground, no air and adjustable gravity, so flights can be checked against calculations done by hand;
  - a build time limit, the number of attempts, and whether pilots may steer or flights are hands-off (only a staging plan and a simple pitch program set in the hangar).
- **Challenges:** the organiser picks one or more:
  - **highest apogee** on a budget;
  - **predict then fly:** before launch, teams write down their predicted apogee, flight time and top speed, and are scored on how close they get. This rewards doing the physics, not just building the biggest rocket;
  - **egg drop:** a fragile payload part that breaks above a set impact speed or G-force, scored on landing speed;
  - **precision landing:** land closest to a marker downrange;
  - **payload to orbit:** the most payload, or the lowest cost per tonne;
  - **moon shot**, for more advanced groups.
- **Entering:** teams join with the code on their own devices (or take turns on one computer), build before the timer runs out, and fly. An entry is the craft text plus a log of the flight: control inputs and staging, step by step.
- **Checked scores:** the organiser's device re-runs every entry from its craft and flight log, using the same fixed physics steps, so a score can't be typed in or edited. Entries that break the rules (a banned part, over budget, over the mass limit) are flagged with the reason. Browsers can differ in the last digits of some maths functions, so the organiser's re-run is the official result, and the team's own number must agree within a small tolerance.
- **Leaderboard and projector view:**
  - a results table for each challenge, with tie-breaks;
  - a big-screen mode with large text;
  - every entry's flight drawn together on one altitude–time graph and over the planet, then played back as ghosts side by side.
- **Flight data:** graphs of altitude, speed, acceleration, thrust, drag, mass and dynamic pressure over time, with each staging event marked, and CSV export for spreadsheets.
- **Model rocket parts:**
  - small solid motors in the standard impulse classes A to G, with realistic thrust curves and a delay charge that pops the parachute;
  - light body tubes, nose cones and fins at model scale.

  A club can then build the rockets it really launches and compare the simulation with its own flights. These parts get tech nodes and contracts in E11 (section 4.4).
- **Saved competitions:** the organiser can save a competition, reopen it later, and export the results as CSV.

**Stretch:**
- a printable results sheet and certificates;
- a worksheet view that shows the equations behind a flight (the rocket equation, drag, energy) next to the team's own numbers;
- head-to-head knockout rounds, with two ghosts racing on the projector.

**Done when:**
- an organiser makes a competition code with a budget and a banned part;
- three teams on separate browsers build, fly and send in their entries;
- the organiser's re-runs match the teams' scores, and an over-budget entry is flagged;
- a predict-then-fly entry is scored on its error;
- all three flights play together as ghosts in the projector view.

H9's flight recorder builds on the flight log from this step.

---

### Phase E — Solar system and science

#### E1 · The solar system
**Goal:** a sun and planets to travel between.

**Must:**
- **The sun:** at the centre, with Aster orbiting it.
- **Five more planets with moons:** a hot inner planet, a thick-atmosphere planet, a desert planet with two moons, a gas giant with four moons, and an icy dwarf.
- **SOI tree:** deeper nesting (moons of planets of the sun).
- **Sunlight:** the sun direction comes from real positions, driving day/night and shadows.
- **Map and warp:** a map for interplanetary distances; warp up to 1,000,000×.
- **Navigation:** a phase-angle readout.

**Stretch:** an eccentric dwarf planet.

**Done when:** a transfer from Aster finds an encounter with the desert planet and captures into orbit.

#### E2 · Planet art and biomes
**Goal:** every world looks distinct.

**Must:**
- **Look:** each body gets its own palette, terrain tiles and close-up art: dunes, ice, lava flats, crater fields.
- **Gas giant:** banded, with animated storms, and no surface.
- **Rings:** drawn in front of and behind the planet.
- **Atmospheres:** each with its own colour, density and temperature.
- **Biomes:** named longitude bands for every body, shown in the map and HUD.

**Stretch:** auroras on the gas giant.

**Done when:** each body is recognisable from orbit and up close.

#### E3 · Science
**Goal:** experiments that reward exploring.

**Must:**
- **Experiments:** all stock science parts listed for E3 in `PARTS.md`, plus crew reports.
- **Rules:** 6 situations × biomes, with diminishing returns.
- **Return:** transmit for partial value or recover for full value; data stored in capsules.
- **Science lab:** processes stored data over time.
- **Science archive:** a screen listing what has been collected.

**Stretch:** extra DMagic-style experiments.

**Done when:** a flight around Aster and Mira collects separate results per biome and situation.

#### E4 · Tech tree and Science mode
**Goal:** progression.

**Must:**
- **New game:** a screen with Sandbox or Science.
- **Tech tree:** a pixel-art node graph, unlocked with science, covering every part and feature that exists by now (Phases A–E4). Later additions get their own nodes in each phase's "Tech and contracts" step (section 4.4).
- **Data:** tech nodes live in `data/tech.js`, so later steps and packs can add nodes without code changes.
- **Editor:** shows only unlocked parts.
- **Pacing:** the first orbit takes about three flights.

**Stretch:** tree hints showing which experiments pay best.

**Done when:** a Science save progresses from first launch to a Mira landing.

#### E5 · Power and heat
**Goal:** electricity and reentry danger.

**Must:**
- **Power:** electric charge; all batteries, solar panels as hinged bodies (sun angle, shadow, deploy/retract under physics, bending and snapping off at speed in air), RTG and fuel cells.
- **Probes:** probe cores use power and lose control without it.
- **Ion propulsion:** xenon tanks and the ion engine.
- **Heat:** per-part temperature with conduction; all heat shields with ablator, including the inflatable one; all radiators; overheated parts explode.

- **Pop-ups:** a part's pop-up shows its temperature, its limit, and charge or production for power parts.

**Stretch:** heat overlay in flight.

**Done when:** a steep reentry without a shield burns up and the same reentry with a shield survives.

#### E6 · Docking and rendezvous
**Goal:** space stations.

**Must:**
- **Physics bubble:** vessels within about 2 km are simulated together.
- **Docking ports:** all of them, including the construction port, with magnetic capture when aligned and slow (weld joints from C2).
- **Joining:** docking merges two part trees into one vessel; undocking splits them.
- **Target HUD:** relative speed, distance, and an alignment marker on the navball.

**Stretch:** a docking camera view.

**Done when:** a two-part station is assembled in orbit and undocked again.

#### E7 · EVA, crew and inventory
**Goal:** astronauts.

**Must:**
- **Crew roster:** names and pixel portraits; seats in capsules.
- **EVA:** a pixel astronaut who walks, jumps, flies a jetpack with limited fuel, and uses ladders (all ladder parts) and hatches.
- **Surface actions:** plant flags (and the flag part), take EVA reports and surface samples.
- **Inventory:** EVA items (jetpack, chute, repair kit, experiments kit) and all cargo containers.
- **Boarding:** board other vessels; rescue a crew member from orbit.

**Stretch:** helmet-off animation inside atmospheres.

**Done when:** walk on Mira, plant a flag, take a sample, and jetpack back to the lander.

*Later:* H1–H5 grow this astronaut into a full character with interiors to move around in, objects to handle and things to repair. Keep the astronaut as its own physics body with a simple pose system, so H1 can add the rig and ragdoll without a rewrite.

#### E8 · Autopilot and trajectory prediction
**Goal:** MechJeb and Trajectories ideas.

**Must:**
- **Autopilot panel:** unlocked by the avionics hub part, with ascent guidance (target altitude, turn shape), circularize, and a landing autopilot (suicide burn to a target point). The node auto-execution from D4 moves into this panel. In Science and Career modes it becomes an early tech-tree unlock, while staying free in Sandbox.
- **Impact prediction:** drag-aware prediction in the atmosphere.

**Stretch:** a rendezvous autopilot.

**Done when:** orbit to a Mira landing is flown with only autopilot clicks.

*Later:* H6 extends the landing autopilot into booster return (boostback, entry and landing burns) for dropped stages. Keep the guidance code separate from the panel, so it can fly a vessel the player isn't controlling.

#### E9 · Sound, settings, tutorials
**Goal:** polish for new players.

**Must:**
- **Sounds (Web Audio, started from a click):** engines by size and pressure, staging bangs, wind from dynamic pressure, explosions, UI clicks.
- **Music:** an ambient music toggle.
- **Settings:** pixel size, difficulty (reentry heat, crash tolerance, joint strength), key remapping.
- **Tutorials:** three interactive ones (first launch, reaching orbit, flying to Mira).
- **Fireworks launcher part.**
- **Installable and offline:** a web app manifest and service worker, so the game can be installed from the browser and played offline (section 1.7).

**Stretch:** radio chatter (Chatterer idea).

**Done when:** a new player can reach orbit by following the tutorials alone.

#### E10 · Terrain detail (Parallax idea)
**Goal:** ground that looks and feels real up close, the way KSP's Parallax mod does it, in 2D (builds on B3, E2, C1).

**Must:**
- **Realistic landforms:** the terrain generator is rebuilt per body, with:
  - ridges, valleys that look eroded, and scree slopes below cliffs;
  - mesas, canyons and dune fields;
  - crater rims with ejecta and central peaks.
  - It keeps the same shape at every zoom: smooth from orbit, detailed down to 0.25 m up close.
- **Strata:** the ground's cut face shows soil, rock and ice layers by biome, which a side view can show and a 3D game can't.
- **Ground scatter:** rocks, boulders, grass, shrubs, trees and ice spikes, chosen by biome and slope.
  - Large boulders are collidable (C1), so landers and rovers must avoid them.
  - Small scatter sways in the wind and is flattened by engine blast.
- **Parallax depth:** three to five layers of distant terrain (far ranges, middle hills, near ridges), taken from the same terrain further along the surface, with haze between them, each moving at the right speed for its distance.
- **Marks that stay:** footprints, wheel tracks, scorch marks and small blast craters from landing engines.
- **Performance:** terrain built and cached in chunks (in a Web Worker if needed), within the 60 fps budget (section 1.7).

**Stretch:** caves and natural arches at chosen sites, using a 2D density field instead of a height function there.

**Done when:**
- landings on Aster's mountains, Mira's crater rim and a dune field each look detailed at 1 m per pixel;
- a boulder stops a rover;
- the background layers move with visible depth as the camera pans.

#### E11 · Tech and contracts: Phase E additions
**Goal:** everything added after the tech tree was built gets its place in it (section 4.4).

**Must:**
- **Tech nodes:** for every part and feature from E5–E10 (power parts, heat shields, docking ports, EVA items, autopilot modes), in a logical place in the tree, with science costs that fit the curve.
- **In the game:** the editor tooltip and the tech tree show what each node unlocks.
- **Checks:** the automated tests from section 4.4 (every part in exactly one node; every node reachable).
- **Balance:** a new Science save still reaches a Mira landing in about the same number of flights as before.

**Done when:** the checks pass, and a Science playthrough unlocks docking ports and EVA items at sensible points.

---

### Phase F — Career

#### F1 · Funds, costs and Career start
**Must:**
- **Career mode:** a Career option in the new-game screen.
- **Money:** part costs and funds; recovery value by distance from the launch site.
- **Standing:** reputation, and a bailout if funds run out.

**Done when:** a Career save can earn and spend money across several flights.

#### F2 · Contracts
**Must:**
- **Generator:** reach altitude, orbit, flyby, land on, rescue, test a part in a situation, place a satellite, plant a flag; covering every feature that exists by now. Later additions get their own contracts in each phase's "Tech and contracts" step (section 4.4).
- **Data:** contract templates live in `data/contracts.js`, so later steps and packs can add them without code changes.
- **Mission Control:** a screen to accept and decline contracts, with deadlines and rewards.

**Done when:** ten contracts of different types can be completed.

#### F3 · Facilities, crew and strategies
**Must:**
- **Facility upgrades:** part count, mass limit, maneuver nodes, patch count, EVA allowed.
- **Astronaut complex:** hire crew with traits (pilot, engineer, scientist) who earn XP stars and skills.
- **Administration:** strategies.

**Done when:** upgrading a facility visibly unlocks its limits.

#### F4 · CommNet
**Must:**
- **Network:** all antennas (direct and relay, with ranges), ground stations, line-of-sight blocked by planets, signal strength.
- **Consequences:** probes lose control without signal; transmitting science needs a link.
- **Map overlay:** shows the network.

**Stretch:** signal delay option and RemoteTech-style dishes.

**Done when:** a relay network keeps a probe behind Mira under control.

#### F5 · Resources and scanning
**Must:**
- **Ore:** distributed by body and longitude.
- **Scanners:** all stock scanner parts, mapping the surface as you orbit, with SCANsat-style overlays for altitude, biome and ore.
- **Mining chain:** all drills, ore tanks and ISRU converters.
- **Transfer:** fuel transfer between docked vessels.

**Done when:** a lander refuels itself on Pell and flies home.

#### F6 · Spaceplanes: flight and ground handling
**Must:**
- **Build mode:** a horizontal mode in the editor, and a runway.
- **Jets:** all jet engines and the combined jet/rocket engine, with all air intakes and intake air.
- **Landing gear:** all of it, with brakes and steering.
- **Starter wings:** one main wing, one elevon and one tail, to test.
- **Flight controls:** the rotate keys (A/D) also move control surfaces to pitch the plane; trim, airbrakes, and wheel brakes (B).
- **Plane HUD:** airspeed, angle of attack, vertical speed and a stall warning.
- **Centre of lift indicator:** in the editor, shown with the centres of mass, thrust and pressure (A3), plus lift arrows on each wing. A plane balances when the centre of lift sits just behind the centre of mass.
- **Advanced aero option (FAR idea):** extra transonic and stall detail on top of C4.

**Done when:** a simple spaceplane takes off, reaches orbit and lands on the runway; moving its wing back or forth visibly moves the centre of lift in the editor and changes how it flies.

#### F7 · Parts: spaceplanes, fairings and bays
**Must:**
- **Plane parts:** every remaining wing, control surface, airbrake and canard; all plane cockpits, fuselages, tanks, adapters, cabins, the drone core, nacelle and pre-cooler.
- **Bays and fairings:** all cargo bays and the cargo ramp, with hinged doors (C2); all service bays; procedural fairings in every size, whose halves separate and tumble away as bodies.
- **Shielding:** parts inside bays and fairings are shielded (C4).

**Done when:** every F7 row is ticked; a shuttle-style craft delivers a satellite from its cargo bay.

#### F8 · Rovers and surface science
**Must:**
- **Rovers:** all rover wheels (wheel joints from C2) and the rover probe core.
- **Driving:**
  - drive forward and back with motor torque, brakes and cruise control;
  - suspension (C2);
  - grip that depends on slope and local gravity;
  - rovers can wheelie, tip over and right themselves with reaction wheels.
- **Rover HUD:** ground speed, slope, battery and distance driven.
- **Surface features:** outcrops, geysers and meteorites, scanned with all three scanning arms.
- **Deployed science:** the full kit, generating science over time.
- **Anomalies:** hidden monuments.

**Done when:** a rover drives 2 km on Mira and scans three features.

#### F9 · Asteroids and comets
**Must:**
- **Spawning:** asteroids and comets on random orbits, found with the infrared telescope.
- **Capture:** both grabbing claws; redirect and capture.
- **Art:** pixel comet tails.

**Done when:** an asteroid is captured into orbit around Aster.

#### F10 · Planner and hardcore options
**Must:**
- **Porkchop planner:** transfer window planning.
- **Life support option:** supplies per crew-day.
- **Build and research time option:** Kerbal Construction Time idea.
- **Difficulty presets.**

**Done when:** the planner's best window produces an encounter when flown.

#### F11 · Tech and contracts: Phase F additions
**Goal:** Career-phase additions fit the tech tree and have contracts of their own (section 4.4).

**Must:**
- **Tech nodes:** for F3–F10 parts and features (CommNet antennas and relays, scanners and drills, spaceplane and rover parts, the grabbing unit).
- **Contracts:**
  - set up a relay network;
  - scan a body;
  - mine ore and deliver it;
  - fly a plane to a site;
  - drive a rover to an anomaly;
  - capture an asteroid;
  - contracts that need upgraded facilities.
- **Checks:** every part in a node; every major feature in at least one contract template.

**Done when:** the checks pass, and a Career save is offered each new kind of contract at a sensible point.

---

### Phase G — Modded

#### G1 · Packs and mods menu
**Must:**
- **Packs:** parts, planets and missions as data plus sprite sheets, with their own tech nodes and contract templates (G9 fills these in for the G packs).
- **Loading:** from a file or a GitHub URL.
- **Mods menu:** enable, disable and detect conflicts (CKAN idea).
- **Example:** one example planet pack.

**Done when:** the example pack adds a moon and two parts without code changes.

#### G2 · Mission Builder
**Must:**
- **Editor:** a node-based mission editor (start state, triggers, conditions, score).
- **Sharing:** play and share missions.
- **Content:** three history-style missions.

**Done when:** a mission made in the builder can be exported, imported and completed.

#### G3 · Robotics and construction
**Must:**
- **Robotics:** all stock robotics parts (hinges, servos, pistons, rotors, turboshafts, blades, propellers), built on C2 joints, with the keyframe controller.
- **Construction:** EVA engineers attach and detach parts (KIS/KAS ideas).
- **Rope parts:** winches, tethers, tow hooks and fuel pipes on C3 ropes.

**Done when:** a folding-arm rover and a propeller aircraft work, and a rover can tow a cart on a winch cable.

#### G4 · Realism options
**Must:**
- **N-body gravity:** a numerical integrator, with Lagrange points (Principia idea).
- **Realism preset:** 10× scale, limited engine ignitions, ullage, realistic engines.
- **Part failures:** Dang It! idea.
- **Joint flex option.**

**Done when:** a probe can be parked at an Aster–Mira Lagrange point in n-body mode.

#### G5 · Scripting console
**Must:**
- **API:** a sandboxed JavaScript API (kOS idea) to read telemetry and control throttle, steering and staging.
- **Editor:** a script editor with saved scripts.
- **Example:** an ascent script.

**Done when:** the example script flies the sample rocket to orbit.

#### G6 · Near Future pack
**Must:** a pack built with the G1 loader covering the Near Future part families in `PARTS.md`: electric engines, reactors and capacitors, large solar arrays, trusses, extra pods, big launch-vehicle parts.

**Done when:** a reactor-powered electric-propulsion craft reaches the gas giant.

#### G7 · Bases, stations and colonies pack
**Must:** surface base modules, station habitats and centrifuges, colony workshops and logistics, and life-support parts, as one pack.

**Done when:** a crewed base on Mira and a station in orbit run on life support for 30 days.

#### G8 · Classic rockets pack and final parts audit
**Must:**
- **Classic rockets pack:** historical-style rocket and spacecraft families (Bluedog Design Bureau / Tantares ideas, original names).
- **Remaining mod science:** DMagic-style experiments, if not done in E3.
- **Final audit:** every row in `PARTS.md` is ticked.

**Done when:** `PARTS.md` is fully ticked and every listed part appears in the editor.

#### G9 · Tech and contracts: packs
**Goal:** every pack brings its own tech nodes and contracts (section 4.4).

**Must:**
- **Pack format:** packs (G1) carry tech nodes and contract templates, so any pack, including ones made by players, adds both.
- **Nodes and contracts for G2–G8:**
  - robotics;
  - realism options, as contract modifiers;
  - Near Future propulsion;
  - bases and stations (build a base, keep a crew alive for 30 days);
  - classic rockets.
- **Checks:** the section 4.4 checks run for every enabled pack; a pack that adds a part without a node shows a warning in the mods menu.

**Done when:** enabling each pack adds its nodes and contracts, and disabling it removes them cleanly.

---

### Phase H — Beyond KSP

Features that neither KSP nor Spaceflight Simulator has in stock (section 2.8). Each builds on earlier steps, shown in brackets, and H10 gives them all their tech nodes and contracts. Their new parts are listed in `PARTS.md` under "Original parts".

#### H1 · Living astronauts
**Goal:** astronauts with as much character as KSP's, in rotating pixel art (builds on E7).

**Must:**
- **Rig:** each astronaut is built from a few pixel-art pieces (head, body, arms, legs) on a simple skeleton, animated for walking, running, climbing, swimming, floating, sitting and waving.
- **Ragdoll:** when knocked over, hit, or blown off a ladder, the astronaut becomes a ragdoll of joined bodies (C2) that tumbles realistically, then gets back up.
- **Personality:** two traits per astronaut (bravery and silliness, with original names), shown on their face: a grin, panic at high g or in a spin, cheers at milestones, a gulp on a long fall.
- **Roles:** pilot, engineer, scientist, and a new medic. Roles decide who can repair (H4), treat injuries (H4) and run experiments faster (H3).
- **Look:** suit colours, helmet visors that reflect the sky, and a generator for names and portraits.
- **Crew panel:** portraits in the flight HUD, reacting live to what the craft does.

**Stretch:** speech bubbles with pixel gibberish; astronauts wave at each other on EVA.

**Done when:** an astronaut knocked off a ladder on Mira tumbles as a ragdoll and gets back up, while their portrait shows panic and then relief.

#### H2 · Interiors (IVA)
**Goal:** see inside crewed parts and move between them, which neither KSP nor Spaceflight Simulator lets you do (builds on H1, E6, D7).

**Must:**
- **Cutaway view (I):** the outer skin fades and crewed parts show pixel-art interiors: decks, seats, consoles, ladders, handrails, lockers and windows.
- **Interiors from the part tree:** every crewed part defines its rooms and hatches. Joined parts connect through their hatches, and docked vessels through their docking ports, so a whole station becomes one connected interior.
- **Moving around:** under gravity astronauts walk and climb ladders. In free fall they float, push off walls and grab handrails, keeping their momentum, so they can drift and spin.
- **Seats and consoles:** an astronaut in a command seat flies the craft; the rest ride along; swap seats.
- **Airlocks:** cycle an airlock to go out on EVA (E7) and come back in.
- **Light:** sunlight through the windows follows day and night; interior lights switch on in the dark.

**Stretch:** look out of a window at the planet turning below.

**Done when:** an astronaut leaves the capsule seat, floats through a docking port into a docked station, cycles its airlock and goes out on EVA.

#### H3 · Hands-on: objects, tools and cargo
**Goal:** astronauts handle things with their hands, inside and out (builds on H2, C1).

**Must:**
- **Loose objects:** cargo boxes, sample cases, tools and food packs are physics bodies. They float in free fall and fall under gravity.
- **Grab, carry, throw and hand over:** carry with one or both hands; heavy things slow you down; in free fall, throwing pushes you back the other way.
- **Controls on parts:** switches, valves and panels that astronauts operate by hand: open a bay, transfer fuel, start an experiment, deploy a panel. The part menu still works too.
- **Cargo by hand:** move inventory (E7) between modules and vessels, through hatches and on EVA.
- **Lab work:** an experiment runs while an astronaut works at the lab bench; scientists are faster.

**Stretch:** tool tethers, so tools don't drift away on EVA.

**Done when:** an astronaut carries a sample case from a lander, through the station, to the lab, and runs it.

#### H4 · Damage, failures and repairs
**Goal:** things break, and the crew fixes them (builds on H3, C2, E5).

**Must:**
- **Damage model:** a hard impact, overheating or overloading (C2) can damage a part instead of destroying it. Dents, cracked tanks and broken engines show in the pixel art and weaken the part.
- **Hull breaches:** a hole in a crewed module vents air. Loose objects and astronauts are pulled toward it, pressure drops and alarms sound; closing the hatch seals the module off.
- **Leaks:** a damaged tank leaks, with a visible spray that pushes the craft.
- **Random failures (option):** stuck valves, dead reaction wheels, failed ignitions (extends the G4 failures option).
- **Repairs:**
  - inside: a patch kit on a breach, or a swapped console;
  - on EVA: a welding torch, or an engine part replaced from spares;
  - engineers repair faster and can fix more;
  - repairs use spare parts from the inventory.
- **Injuries:** hard landings and high g can hurt astronauts; a medic treats them.

**Stretch:** a fire inside a module, fed by oxygen, put out with an extinguisher or by venting.

**Done when:** a micrometeoroid breaches a station module, the crew seals the hatch, an engineer patches the hole on EVA, and the module repressurises.

#### H5 · Life on board and spin gravity
**Goal:** long missions where the crew's needs matter, and rotating stations, which a side view shows perfectly (builds on H2, G7).

**Must:**
- **Needs:** air, water, food, sleep and morale, in a light version that G7's life-support pack plugs into.
- **Spin gravity:** rotating rings and centrifuge modules. Astronauts walk on the inside of the rim, with "down" and the strength of gravity set by spin rate and radius. Climbing toward the hub makes them lighter, and dropped objects curve sideways (the Coriolis effect).
- **Daily life:** exercise machines, sleep pods and a galley that keep morale up.
- **Crew schedule:** a simple day plan (work, eat, sleep) that keeps running during time warp.

**Stretch:** a greenhouse module whose plants help recycle air.

**Done when:** a spinning ring gives 0.5 g at the rim, an astronaut walks all the way round it, and a crew stays healthy for 30 days with exercise and food.

#### H6 · Self-landing rockets
**Goal:** boosters that fly themselves home and fly again (builds on E8, D1, C4).

**Must:**
- **Parts:** grid fins (fold out to steer at high speed), booster landing legs, deep-throttling engines that relight a limited number of times, cold-gas thrusters.
- **Guidance per stage:**
  - In the editor, give any stage that will be dropped a return mission: back to the launch site, onto a drone ship, or a splashdown.
  - The autopilot flies the boostback, entry and landing burns (the "hoverslam"), extending E8's landing autopilot.
  - The editor shows the fuel the landing needs, held back from the Δv.
- **Background flight:** dropped stages with a return mission keep flying under full physics while you fly the upper stage (2D makes this cheap), and you can switch over to watch them.
- **Landing sites:** landing pads at the launch site, and a drone ship that floats (C4 water) and holds its position.
- **Recovery and reuse:**
  - landed stages can be recovered for their part value (Career) and launched again;
  - every part keeps a flight counter.

**Stretch:** a picture-in-picture view of the booster landing while you fly the upper stage.

**Done when:** a two-stage rocket puts a payload in orbit while its first stage flies back and lands on the pad by itself; the stage is then recovered and launched again.

#### H7 · Launch and recovery infrastructure
**Goal:** the ground systems around the rocket (builds on H6, C2, C3, G7).

**Must:**
- **Launch towers:**
  - buildable towers with umbilicals that top up fuel and power until launch, and a crew access arm;
  - a water deluge system that reduces launch damage.
- **Catch tower:** arms on hinges (C2) that catch a returning booster by its catch points; booster guidance (H6) can target the tower.
- **Your own launch sites:** build pads and towers on any body from base parts (G7), and launch from them.
- **Recovery ships:** ships that catch fairing halves gliding down under parafoils (C3).
- **Abort tests:** a pad abort and an in-flight abort with an escape tower.

**Stretch:** rollout: the rocket rides a crawler from the assembly building to the pad.

**Done when:** a booster is caught by the tower arms, and a fairing half is caught by a recovery ship.

#### H8 · Tethers, sails and mass drivers
**Goal:** ways to move that neither game has in stock (builds on C3, E5, F5).

**Must:**
- **Rotating tethers (rotovators):** a long spinning tether on C3 ropes catches a payload from a suborbital hop and flings it onward. The momentum exchange lowers the tether's own orbit, which it then has to boost back up.
- **Solar sails:** thrust from sunlight that depends on the sail's angle and distance from the sun, steered from the map.
- **Mass driver:** a long electromagnetic launch track on an airless moon (Mira) that fires cargo pods into orbit.
- **Propellant depots:** tankers, fuel transfer between craft, and boil-off of cold fuels over time.

**Stretch:** a space elevator on a small moon.

**Done when:** a rotovator around Mira catches a cargo pod fired from a mass driver and passes it on to an escape trajectory.

#### H9 · Flight recorder, replays and photo mode
**Goal:** relive and share flights (builds on D3, D8, E9).

**Must:**
- **Recorder:** every flight is recorded (each vessel's state at intervals, which is cheap in 2D).
- **Replays:** play back with a timeline: pause, scrub, slow motion, and follow any vessel.
- **Cinematic camera:** free and tracking cameras, smooth zoom paths, and a photo mode that hides the HUD, with filters.
- **Export:** GIF clips of a replay, and replay files to share.
- **Ghosts:** race a translucent ghost of your best attempt (fastest to orbit, least fuel to a Mira landing).

**Stretch:** take over from any moment of a replay as a new flight.

**Done when:** a full flight to Mira is replayed at 10× with the camera following the booster home, and a 10-second clip is exported as a GIF.

#### H10 · Tech and contracts: beyond KSP
**Goal:** the Phase H features fit the tech tree and have contracts of their own (section 4.4).

**Must:**
- **Tech nodes:** for H1–H9 parts and features (interior fittings, repair tools, spin habitats, grid fins and booster legs, towers, tethers, sails, mass drivers), in a logical order: booster legs before booster return, for example.
- **Contracts:**
  - land a booster and fly it again;
  - repair a damaged satellite;
  - rescue a crew from a breached station;
  - run a spin-gravity station for 30 days;
  - catch a booster with the tower;
  - deliver cargo with a rotovator;
  - ghost-race challenges from replays.
- **Science:** new experiments where they fit (crew health studies on long missions, for example).
- **Checks:** the section 4.4 checks pass with Phase H included.

**Done when:** the checks pass, and a Career save can reach and complete each new kind of contract.

---

## 5. Controls

### Flight (prototype)

| Key | Action |
|---|---|
| Space | Next stage |
| Shift / Ctrl | Throttle up / down |
| Z / X | Full throttle / cut throttle |
| A / D or ← / → | Rotate |
| T | SAS on/off |
| M | Map view |
| . / , | Time warp faster / slower |
| / | Stop time warp |
| Tab | Cycle map focus |
| P | Deploy parachutes |
| H | Controls panel |
| Esc | Menu |
| Mouse wheel | Zoom |
| Click on orbit (map) | Add maneuver node |

Touch devices get on-screen buttons for rotate, throttle and stage; A0 adds pinch zoom. Later steps add:

- G (gear, D1);
- I/J/K/L (RCS translation, D2), R (RCS toggle, D2), Backspace (abort, D2);
- `[` `]` (switch vessel, D3).

### Building (from steps A2–A4)

| Input | Action |
|---|---|
| Drag from tray | Add a part |
| Click / tap a tray part | Add it at the lowest free attach point (side parts: on the selected part) |
| Drag a placed part (touch: hold, then drag) | Move it with everything attached below |
| Drop on tray | Delete |
| Delete | Remove the selected part and everything below it |
| Make root button | Make the selected part the root |
| Home / Fit button | Frame the whole craft |
| X | Mirror symmetry on/off |
| Q / E (Shift for 5°) | Rotate the carried part or the selected side part |
| F | Flip |
| Alt-drag (touch: Offset switch, then drag) | Offset along the surface |
| Alt-click (touch: Copy button) | Copy with attached parts; the copy drops on the next click or tap |
| Save sub button | Keep the selected part and everything below it in the Subassemblies tab |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Right-click (touch: tap the selected part) | Part settings |
| Wheel / drag empty space, middle- or right-drag | Zoom / pan |
| Touch: one finger / two fingers | Pan / pan and pinch-zoom |

### Astronauts and interiors (from steps E7 and H1–H5)

| Input | Action |
|---|---|
| A / D | Walk, or push sideways while floating |
| W / S | Climb ladders; float up and down |
| Space | Jump; push off a wall in free fall |
| E | Grab or let go; use a switch, seat, hatch or airlock |
| Q (hold, aim with mouse) | Throw what you're carrying |
| I | Interior cutaway view on/off |
| [ / ] | Switch to the next astronaut or vessel |

## 6. Deploying to GitHub Pages

1. Create a repository and push the contents of this folder (keep `.nojekyll`).
2. Repository → Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. The game is live at `https://<user>.github.io/<repo>/` within a minute or two.

---

## Changelog

- **Prototype**: click-to-stack hangar, flight physics, patched conics, map, maneuver nodes, time warp, three bodies.
- **Plan revision 2**: added drag-and-drop building (1.4), the pixel art direction (1.5), and single-session steps.
- **Plan revision 3**:
  - art direction changed to freely rotating pixel art (pixels turn with the object as crisp squares) on a WebGL renderer;
  - added the physics upgrade (Phase C);
  - added `PARTS.md`, covering every stock part and the popular mod part families;
  - added step A0 to prepare the prototype;
  - 48 steps in total.
- **Plan revision 4**: added auto-execution of maneuver nodes to step D4.
- **Plan revision 5**: "moving parts are simulated, not animated" added to the physics model; new step C3 for ropes, cables and physical parachutes; articulated parts and ejection forces added to C2; aerodynamics is now C4 and orbit precision C5; RealChute added to the mods; 49 steps in total.
- **v0.1.1 (A0, first half)**: tests (`node tests/run.js`), part and body data moved to `data/`, versioned saves (`js/save.js`), version number, F3 developer overlay, original part names (Rumbler booster; plain tank and engine names).
- **Plan revision 6**:
  - section 1.7 explains why the game stays one static site, with no executable needed;
  - added a performance pass (C5), IndexedDB saves (D3) and an installable offline web app (E9);
  - centre of pressure overlay (A3), centre of lift indicator and plane controls (F6), and rover driving (F8) made explicit.
- **Plan revision 9**: new step D8, "Competition mode (physics club)": shared rules and budgets as a competition code, challenges (highest apogee, predict then fly, egg drop, precision landing, payload to orbit), entries re-run from their flight logs to check the scores, leaderboard and projector view with ghosts, flight data graphs with CSV export, and model rocket motors (A–G); 64 steps in total.
- **Plan revision 8**: new step E10, "Terrain detail" (realistic landforms, strata, collidable ground scatter and deep parallax layers, the idea behind the Parallax mod); new section 4.4, which says every new part and feature gets a tech-tree node and contracts of its own, with a "Tech and contracts" step closing each phase (E11, F11, G9, H10) and automated checks; tech nodes and contracts are data that packs can extend; 63 steps in total.
- **Plan revision 7**: new Phase H, "Beyond KSP" (section 2.8): living astronauts with ragdolls (H1), walkable interiors (H2), hands-on objects and tools (H3), damage and repairs (H4), life on board and spin gravity (H5), self-landing rockets (H6), launch and recovery infrastructure (H7), tethers, solar sails and mass drivers (H8), and a flight recorder with replays (H9); 58 steps in total. Original parts added to `PARTS.md`.
- **v0.3.0 (A1)**: part tree; per-engine thrust lines; per-part, angle-dependent drag; ground contact on every part; decoupling anywhere; tree-aware staging and Δv; save format 3; Side Decoupler part and Twin Boosters sample; roadmap graphic in the README.
- **v0.7.0 (B1)**: WebGL2 renderer with one shared art-pixel grid, sharp-pixel sprite shader, atlas and batcher (`js/gl.js`, `js/render-gl.js`); 53-colour palette with dithering (`art/palette.js`); banded, dithered sky with pixel stars and galaxy band; per-pixel planet shader (ocean, surface, soil, strata, atmosphere rim, night side) for flight and map; temporary art baked to palette pixels; pixel puffs for particles; overlay canvas for orbits and labels; Canvas 2D fallback with notice; pixel-size setting (`flatspace.settings`); `art.html` gallery; `tests/test_gl.js`.
- **v0.6.2 fix**: engines that turn a craft sitting on the ground now tip it over once their turning effect beats what its weight can hold (before, a landed craft ignored turning completely unless it had enough thrust to lift off). While it turns on the ground, a simple contact model lets it pivot, roll and bounce, a part hitting the ground too fast breaks the craft, and it comes to rest at whatever angle it ends up. C1 replaces this with full rigid-body contact.
- **v0.6.1 (A4 follow-up)**: side parts line up with sloped faces; floating parts in the hangar (left behind, or launched beside the craft); part pop-ups that open on select, pin, drag and point at their part, in the hangar and in flight; settings and actions mid-flight (thrust limit, gimbal, engine on/off, crossfeed, decouple, chute height and arming); `partToScreen` / `screenToPart` in the renderer; `Vessel.act`. Later parts of this request added to B5, C3, D2, D3, D5 and E5.
- **v0.6.0 (A4)**: stretchable tanks in six widths with handles and 21 presets; one tank density (tank lengths moved to the 0.25 m grid); five tank looks; part settings panel (fuel level, thrust limit, gimbal, crossfeed, parachute height, fires in staging); staging editor with chips, custom staging saved on parts; craft files (download, open, copy and paste as text); `js/staging-editor.js`, `js/part-panel.js`.
- **v0.5.0 (A3)**: tool rail; mirror symmetry with linked twins; rotate and flip; offset with snap; undo/redo (100 steps); Alt-click copy; subassemblies tab; centre of mass, thrust and pressure overlays with warnings; Swept Fin part; sideways force on parts and wing-like fins (`FS.partAero`), brought forward from C4; Hopper sample uses the short tank.
- **v0.4.0 fix**: script and style links carry `?v=<version>`, after a browser served a cached old `editor.js` with the new page and the hangar came up blank.
- **v0.4.0 (A2)**: drag-and-drop hangar: tray with tabs and hover cards, stack and surface snapping, overlap checks, carrying subassemblies, drop on tray to remove, pan and zoom, touch long-press and pinch, live stats while dragging, re-root; `js/build.js`.
- **v0.2.0 (A0 complete)**: simulation split from the page (`sim.js`, `warp.js`, `nodes.js`, `input.js`) with events; renderer interface (`FS.Renderer`); maneuver nodes survive SOI changes and can go on any patch; debris kept on rails; pinch zoom; `?debug` start in orbit.
