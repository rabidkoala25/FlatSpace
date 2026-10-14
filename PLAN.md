# Flatspace Program — Design Plan

A 2D spaceflight and rocket-building sandbox, inspired by Kerbal Space Program (KSP), that runs entirely in the browser and deploys as a static site on GitHub Pages.

This document has four parts:

1. How the program works (architecture and the physics model)
2. Every KSP feature, and how it maps to 2D
3. The most popular KSP mods, and which of their ideas to build in
4. A phased roadmap, starting with the prototype that ships with this plan

All names (planets, parts, crew) are original. The game borrows mechanics, not KSP's names or art.

---

## 1. How the program works

### 1.1 Platform

| Concern | Choice | Why |
|---|---|---|
| Hosting | GitHub Pages, static files only | Free, no server, push-to-deploy |
| Language | Plain JavaScript (ES2020), no build step | Open `index.html` and it runs; easy for anyone to read and mod |
| Rendering | HTML5 Canvas 2D | Fast enough for vector-style rockets, planets, particles; no WebGL needed until phase 4 |
| UI | HTML/CSS overlay on top of the canvas | Buttons, panels and text stay crisp and accessible |
| Saves | `localStorage` (craft + save games), JSON export/import | Works offline; files can be shared |
| Code layout | One global namespace `FS`, one file per system | Loaded with plain `<script>` tags in order |

### 1.2 Code structure

```
index.html          page shell, HUD markup, script tags
css/style.css       all styling (HUD, editor, panels)
js/util.js          vectors, formatting, small helpers
js/bodies.js        planets & moons: orbits, rotation, terrain, atmosphere
js/orbit.js         Kepler orbits, propagation, patched conics, encounters
js/parts.js         part catalogue, part drawing, staging and Δv maths
js/vessel.js        a flying craft: forces, fuel, staging, landing, crashing
js/render.js        flight view, map view, particles
js/editor.js        the Vehicle Assembly hangar
js/hud.js           flight instruments: attitude dial, readouts, stage list
js/main.js          game loop, input, time warp, maneuver nodes, scenes
```

Planned additions in later phases: `science.js`, `career.js`, `comms.js`, `resources.js`, `kerbals.js` (crew), `aero.js`, `thermal.js`, `autopilot.js`, `missions.js`, `mods.js`.

### 1.3 Physics model

**Units.** Everything is SI: metres, seconds, kilograms, newtons.

**Gravity: patched conics (like stock KSP).** Every craft is inside exactly one body's sphere of influence (SOI) and feels only that body's gravity. The SOI radius is `a · (μ_body / μ_parent)^(2/5)`. When the craft crosses an SOI boundary, its position and velocity are re-expressed relative to the new body. Moons move on fixed circular "rails".

**Two integrators.**
- *Physics mode* (thrusting, in atmosphere, near the ground, or time warp ≤ 4×): forces are integrated with semi-implicit Euler at a fixed 20 ms step. Forces: gravity, engine thrust, aerodynamic drag, parachute drag; torques from reaction wheels, engine gimbal, fins and the SAS controller.
- *On-rails mode* (coasting in vacuum, time warp up to 100,000×): the craft's state is converted to Kepler elements and propagated analytically (Kepler's equation, solved with Newton's method, for ellipses and hyperbolas). This is exact and costs almost nothing, so very high warp is stable.

**Orbit prediction.** From the current state the game builds up to three conic "patches": it samples the current orbit, checks each moon's position at the same moment, and finds the first SOI entry (encounter) or exit (escape) by bisection. The map draws each patch, plus Ap/Pe, encounter, escape and impact markers.

**Atmosphere.** Exponential pressure profile `p(h) = p₀·e^(−h/H)`, rescaled to reach exactly zero at the atmosphere's top. The atmosphere rotates with the planet, so drag uses air-relative velocity. Drag force is `½ ρ v² · ΣCdA` over all parts.

**Engines.** Each engine has vacuum and sea-level thrust and specific impulse. Mass flow is fixed by vacuum values; thrust at pressure *p* is `ṁ · Isp(p) · g₀`, so engines lose thrust low in the atmosphere, as in KSP. Liquid engines throttle and can be shut down; solid boosters burn at full power until empty.

**Staging.** The stack is split into segments at each decoupler. Pressing Stage fires the next event: ignite the bottom segment, then decouple it and ignite the next, and so on, with parachutes last. Dropped segments become debris that keeps flying and can crash.

**Δv maths (used by the editor and the in-flight readout).** Each stage is solved analytically: all burning groups (the liquid engines sharing a segment's tanks, and each solid booster) are burned in phases until each runs dry, adding `Isp_eff · g₀ · ln(m₀/m₁)` per phase.

**Landing and crashing.** The lowest point of the craft is tested against the terrain height under it. Touchdown below the part's crash tolerance and roughly upright = landed; faster or tilted = destroyed, with an explosion. Oceans allow splashdown.

**Terrain.** Each body's surface is a periodic fractal noise function of longitude, with craters on moons, flattened around the launch site. It's computed on the fly at whatever detail the zoom level needs, so there are no tiles to store.

### 1.4 Rendering

- **Flight view.** The camera follows the craft and rotates so "local up" points up the screen, the same feel as KSP's flight camera. Sky colour fades from blue to black with altitude; stars fade in; the planet's limb, atmosphere glow and moons in the sky are all drawn; terrain is drawn as a polygon strip around the craft.
- **Map view.** Top-down inertial view of the whole system with orbits, SOI rings and the craft's predicted path. Zoom and pan; focus any body.
- **Precision.** All drawing is done relative to the camera position (subtracting in double precision before the canvas sees the numbers), so there's no jitter at 12,000 km from the planet.
- **Effects.** Particle exhaust (flame, smoke in air, wide plume in vacuum), explosions, reentry glow, parachute canopies, staging debris.

---

## 2. Every KSP feature, mapped to 2D

Legend: **P** = in the prototype now · **1–4** = roadmap phase · **✗** = left out on purpose (needs a third dimension).

### 2.1 Building

| KSP feature | 2D version | Phase |
|---|---|---|
| Vehicle Assembly Building (rockets) | Side-on hangar; parts snap into a vertical stack | **P** |
| Part catalogue by category | Command, Fuel, Engines, Structural, Utility, Aero, Science, Power, Comms, Ground | **P** (first 5) / 1–2 |
| Stack attachment | Top/bottom nodes | **P** |
| Radial attachment + symmetry | Side-mounted parts on the left/right faces, mirrored (2× symmetry is the only symmetry that exists in 2D) | 1 |
| Side boosters (radial decouplers) | Mirrored boosters with radial decouplers | 1 |
| Adapters, multiple diameters (0.625 / 1.25 / 2.5 / 3.75 m) | Tapered adapters | **P** (1.25↔2.5) / 1 |
| Spaceplane Hangar + runway | Horizontal build mode; wings, landing gear, jet engines | 3 |
| Stage editor (reorder, add stages) | Drag stage groups; per-part "include in staging" toggle | 1 |
| Δv per stage, TWR, burn time readout (stock since 1.6) | Right-hand panel in the editor | **P** |
| Centre of mass / thrust / lift markers | Overlay markers | 1 |
| Craft save / load / share | localStorage + JSON file export/import | **P** (local) / 1 (files) |
| Subassemblies, undo/redo | Saved stack fragments; history | 2 |
| Part tweakables (fuel level, thrust limit, gimbal lock) | Click a part for a settings panel | 1 |
| Construction mode (move parts in flight, Breaking Ground/1.11) | EVA engineer can attach/detach parts | 4 |

### 2.2 Flight

| KSP feature | 2D version | Phase |
|---|---|---|
| Throttle, staging, engine ignition & flameout | Same | **P** |
| Liquid, solid, monopropellant, xenon (ion) fuels | Separate resources and tank types | **P** (liquid, solid) / 1 (mono, xenon) |
| Reaction wheels, gimbal, fins | Torque sources about the one rotation axis | **P** |
| RCS thrusters | Translation (forward/back/left/right) and rotation | 1 |
| SAS modes: stability, prograde, retrograde, normal, anti-normal, radial in/out, target, anti-target, maneuver | In 2D, normal/anti-normal don't exist; all others kept | **P** (stability, pro, retro, radial ±, maneuver) / 1 (target) |
| Navball | **Attitude dial**: a 2D navball showing horizon, heading, and the prograde/retrograde/radial/maneuver markers | **P** |
| Surface / orbit / target speed modes | Auto-switch by altitude, click to toggle | **P** (auto) / 1 |
| Aerodynamics: drag, lift, stability | Drag + fin stability now; full lift model later | **P** / 2 |
| Reentry heating & part temperature | Per-part temperature, heat shields with ablator | 2 |
| Parachutes (semi-deploy, full deploy, cut) | Same | **P** |
| Landing legs, wheels, rovers | Legs with suspension; wheeled rovers driving along the terrain line | 1 (legs) / 3 (rovers) |
| Splashdown in oceans | Same | **P** |
| Action groups (Gear, Lights, Brakes, Abort, 1–0) | Keyboard groups | 1 |
| Time warp, physics warp, warp limits by altitude | Same | **P** |
| Debris and multiple vessels; switching vessels | Vessel list; `[` `]` to switch | **P** (debris) / 1 |
| Tracking Station | Map-only scene listing all vessels | 1 |
| Docking ports and docking | Ports on stack ends; dock by matching position and velocity in 2D (much easier than 3D) | 2 |
| Rendezvous: target, closest approach markers | Same, along the line of the orbit | 2 |
| EVA (jetpack, plant flag, ladder, walk) | Crew member as a small physics body with a jetpack | 2 |
| Kerbal Inventory / cargo parts (1.11) | Crew inventory slots; cargo bays | 3 |
| Fuel transfer, crossfeed, fuel lines | Click-to-transfer; crossfeed toggles | 2 |
| Engine plates, fairings, cargo bays | Procedural fairings | 2 |
| Grabbing unit (Klaw), asteroids & comets | Asteroids on hyperbolic/eccentric orbits; grab and redirect | 3 |
| Robotics: hinges, pistons, rotors, KAL controller (Breaking Ground) | 2D hinges and pistons with a keyframe controller | 4 |
| Propellers / rotor flight (Breaking Ground) | Rotor thrust model | 4 |

### 2.3 Orbital mechanics and planning

| KSP feature | 2D version | Phase |
|---|---|---|
| Patched conics with SOI changes | Same | **P** |
| Ap/Pe, time to Ap/Pe, period | Same | **P** |
| Encounters and multi-patch prediction | Up to 3 patches | **P** |
| Maneuver nodes (prograde/radial; normal in 3D) | Prograde + radial handles only, since a 2D orbit has no plane to change | **P** |
| Maneuver Mode (1.12: node editing with exact inputs) | Node panel with ±1/10/100 buttons and time shifting | **P** |
| Maneuver Tool app: Hohmann transfer, circularize, change Ap/Pe (1.12) | One-click node generators | 1 |
| Alarm Clock app (1.12) | Alarms for nodes, SOI changes, Ap/Pe | 1 |
| Inclination, ascending/descending nodes | ✗ — an orbit can only be clockwise or counter-clockwise (retrograde orbits are still possible) | ✗ |
| Gravity assists | Work naturally with patched conics | **P** (moons) / 2 (planets) |
| Interplanetary transfers, phase angles, transfer windows | Sun-centred system with planets | 2 |

### 2.4 Solar system

| KSP feature | 2D version | Phase |
|---|---|---|
| Home planet with rotation, oceans, atmosphere | **Aster**: 600 km radius, 70 km atmosphere, 6-hour day, oceans | **P** |
| Large nearby moon | **Mira**: 200 km, cratered, airless | **P** |
| Small distant moon | **Pell**: 60 km, low gravity, flat plains | **P** |
| Star and multiple planets (Moho, Eve, Duna, Jool, Eeloo analogues) | A sun with 6 planets and their moons, all original, each with a twist (thick atmosphere, gas giant, rings, ice) | 2 |
| Biomes | Longitude bands per body (Highlands, Lowlands, Craters, Poles become "Dark Side", etc.) | 2 |
| Easter eggs / anomalies | Hidden monuments on terrain | 3 |
| Surface features (Breaking Ground: craters, rocks, cryovolcanoes) | Scannable features on the terrain line | 3 |

### 2.5 Game modes and progression

| KSP feature | 2D version | Phase |
|---|---|---|
| Sandbox (everything unlocked, nothing costs) | Same | **P** |
| Science mode (experiments unlock the tech tree) | Same | 2 |
| Career mode (funds, reputation, contracts, facilities) | Same | 3 |
| Science: experiments × situations × biomes; transmit vs recover; diminishing returns | Situations kept: Landed, Splashed, Flying Low, Flying High, Space Low, Space High | 2 |
| Deployed science (Breaking Ground) | Ground stations generate science over time | 3 |
| Tech tree | Node graph unlocking part groups | 2 |
| Contracts | Generated goals: reach altitude, orbit X, land on Y, rescue, test part, satellite to orbit | 3 |
| Funds & part costs, vessel recovery value | Same, refund by distance from the launch site | 3 |
| Reputation, strategies (Administration) | Same | 3 |
| Facility upgrades (part count, mass limits, patched conic depth, maneuver nodes unlocked) | Same | 3 |
| Crew: hiring, pilot/engineer/scientist traits, XP stars | Same | 3 |
| Milestones / "world firsts" | Toasts for first space, orbit, encounter, landing, return | **P** |
| Mission Builder (Making History) | JSON-driven missions with triggers and win/lose conditions, shareable | 4 |
| History pack missions (Making History) | Scripted historical-style missions | 4 |
| Alternative launch sites (Making History) | Several pads around Aster | 2 |
| Difficulty settings (re-entry heat, crash tolerance, CommNet on/off) | Settings panel | 2 |
| Tutorials and training scenarios | Interactive tutorials | 2 |

### 2.6 Communications and resources

| KSP feature | 2D version | Phase |
|---|---|---|
| CommNet: antennas, relays, ground stations, line-of-sight, signal strength | Line-of-sight checks are simpler in 2D (a planet occludes a segment) | 3 |
| Probe control requires connection | Same | 3 |
| Electric charge, batteries, solar panels (sun angle, occlusion) | Same | 2 |
| Ore, surface scanner, drills, ISRU converters | Ore concentration per longitude; drill → ore tank → converter → fuel | 3 |

### 2.7 Presentation

| KSP feature | 2D version | Phase |
|---|---|---|
| Space Center hub scene | Clickable buildings: Assembly, Tracking Station, R&D, Mission Control, Astronaut Complex | 1 |
| Day/night lighting from the sun | Terminator shading on bodies, dark sky at night | 2 |
| Engine plumes, explosions, smoke | Particle systems | **P** |
| Sound (engines, staging, music) | Web Audio, started from a click | 2 |
| Flight log after a flight | Mission summary on recovery | **P** |

---

## 3. Popular mods and what to build in

The community's most-recommended mods (from KSP forum and Reddit mod surveys, PC Gamer's list, and CKAN usage) fall into clear groups. The plan is to build their ideas in as optional features or difficulty settings, so the 2D game has a "modded" depth from day one.

| Mod | What it does in KSP | 2D version in Flatspace | Phase |
|---|---|---|---|
| **Kerbal Engineer Redux** | Detailed flight & build readouts (Δv, TWR, orbit data) | The "Flight Data" panel and editor stats | **P** |
| **MechJeb 2** | Autopilots: ascent guidance, landing, maneuver planner, executor | Autopilot module: smart SAS, auto-circularize, execute node, ascent profile, suicide-burn landing | 2 |
| **Kerbal Alarm Clock** | Alarms that stop warp | Alarm list with auto-stop | 1 |
| **Trajectories** | Predicted path including drag; landing spot | Drag-aware trajectory integration in the atmosphere, impact marker | 2 |
| **Transfer Window Planner** | Porkchop plots for transfer windows | Porkchop plot (2D has no inclination, so it's simpler) | 3 |
| **Scatterer / EVE / Parallax / Astronomer's Visual Pack** | Atmospheric scattering, clouds, oceans, terrain detail | Sunset sky gradients, animated cloud bands, ocean glints, rim lighting | 2 |
| **RealPlume / Waterfall** | Realistic exhaust that widens in vacuum | Pressure-dependent plume shape and Mach diamonds | **P** (pressure-dependent) / 2 |
| **Ferram Aerospace Research (FAR)** | Realistic aerodynamics: lift, area ruling, Mach effects | "Advanced aero" option: per-part lift, transonic drag rise, stability from CoP vs CoM | 3 |
| **Kerbal Joint Reinforcement** | Stiffer joints, less "noodle rockets" | 2D stacks are rigid in the prototype; an optional flex model later | 4 |
| **KIS / KAS (Inventory & Attachment Systems)** | Carry parts on EVA, winches and pipes | Inventory + tether/winch | 4 |
| **Kerbal Construction Time / RP-1 build times** | Rockets take time to build; tech research takes time | Career option | 3 |
| **SCANsat** | Orbital mapping of terrain, biomes, resources | Scan the terrain line as you orbit; reveals biomes and ore | 3 |
| **TAC Life Support / Kerbalism / USI-LS** | Food, water, oxygen, radiation, failures | Life-support option with supplies per crew-day | 3 |
| **RemoteTech** | Signal delay and dish targeting | Hard mode for CommNet with signal delay | 4 |
| **Principia** | N-body gravity, Lagrange points | "N-body" option: all bodies attract the craft at once, with a numerical integrator | 4 |
| **Real Solar System + Realism Overhaul + RP-1** | Earth-scale system, real engines (limited ignitions, ullage), long career | A "Realism" preset: 10× scale system, limited engine restarts, ullage, real-world-like engines | 4 |
| **Near Future / USI / Kerbal Planetary Base Systems** | More parts: nuclear, electric, bases, colonies | Parts packs loaded as JSON | 3–4 |
| **Outer Planets Mod / Galaxies Unbound** | More planets, more stars | Planet packs loaded as JSON | 4 |
| **Dang It! / Kerbalism failures** | Random part failures | Reliability option | 4 |
| **DMagic Orbital Science** | More science experiments | Science pack | 3 |
| **Chatterer, Collision FX, PlanetShine** | Radio chatter, crash sparks, reflected light | Small polish features | 3 |
| **kOS** | Programmable autopilot scripts | A small scripting console (sandboxed JS) | 4 |
| **CKAN** | Mod manager | Built-in "Packs" menu: parts/planets/missions as JSON files from a URL or upload | 4 |

### Modding support (the CKAN idea, built in)

Parts, bodies and missions are plain data (JSON). Phase 4 adds a loader so a "pack" can be dropped in or loaded from a GitHub URL, with a manifest listing what it adds.

---

## 4. Roadmap

### Prototype (this release)

- Vehicle Assembly hangar with 16 parts in 5 categories, stack building, live Δv/TWR/burn-time per stage, save/load, three sample craft.
- Flight: throttle, staging, solid and liquid engines, reaction wheels, engine gimbal, fins, drag, parachutes, debris.
- SAS: stability, prograde, retrograde, radial in/out, maneuver.
- Aster (rotating planet, ocean, atmosphere) with moons Mira and Pell.
- Patched conics: SOI transitions, encounters, escapes, impacts, up to 3 predicted patches.
- Map view with zoom, pan, focus switching.
- Maneuver nodes with a node editor, burn timer, "warp to node", and dial marker.
- Time warp up to 100,000× with altitude limits; physics warp to 4×.
- Landing, splashdown, crashing with explosions, recovery with a flight summary.
- Milestones for first space, orbit, encounters, landings and return.
- Touch controls for phones and tablets.

### Phase 1: "Complete sandbox"

Radial attachment with mirror symmetry and side boosters; RCS and monopropellant; landing legs; stage editor; part tweakables; Space Center hub; Tracking Station and vessel switching; action groups; target selection; Maneuver Tool (circularize, Hohmann) and Alarm Clock; JSON craft export/import; centre-of-mass markers.

### Phase 2: "Science and a solar system"

Sun and six planets with moons; biomes; science experiments, transmit/recover, tech tree (Science mode); electric charge and solar power; reentry heating and heat shields; docking and rendezvous; EVA with jetpack and flags; drag-aware trajectory prediction; autopilot (MechJeb-style: ascent, circularize, node executor, landing); visual upgrade (sunset scattering, clouds, lighting); sound; tutorials; difficulty settings.

### Phase 3: "Career"

Funds, reputation, contracts, facilities and upgrades, crew with traits; CommNet; ore and ISRU; SCANsat-style mapping; life support option; spaceplanes and runways; rovers; asteroids and comets; porkchop planner; build time option; part packs.

### Phase 4: "Modded"

Mission Builder and shareable missions; robotics; n-body gravity option; realism preset; part failures; scripting console; pack loader.

---

## 5. Controls (prototype)

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
| Mouse wheel | Zoom |
| Click on orbit (map) | Add maneuver node |

Touch devices get on-screen buttons for rotate, throttle and stage.

## 6. Deploying to GitHub Pages

1. Create a repository and push the contents of this folder (keep `.nojekyll`).
2. Repository → Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. The game is live at `https://<user>.github.io/<repo>/` within a minute or two.
