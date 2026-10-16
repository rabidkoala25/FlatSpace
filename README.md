# Flatspace Program

A 2D rocket-building and spaceflight sandbox in the browser, inspired by Kerbal Space Program. Build a rocket from parts, launch it from the planet Aster, reach orbit, and fly to its moons Mira and Pell using real orbital mechanics (patched conics, maneuver nodes, time warp).

No build step, no dependencies: plain HTML, CSS and JavaScript.

## Roadmap

![Flatspace Program roadmap: steps done, next and planned](docs/roadmap.svg)

The game is built in 49 steps after the prototype, each one work session. `PLAN.md` describes every step; `PARTS.md` tracks every part. The graphic is redrawn from the status table in `PLAN.md` with `node tools/roadmap.js`.

## Play locally

Open `index.html` in a browser. (If your browser blocks local files, run `python3 -m http.server` in this folder and open `http://localhost:8000`.)

Add `?debug` to the address (for example `http://localhost:8000/?debug`) to start a flight already in a 100 km orbit.

## Deploy to GitHub Pages

1. Create a new repository on GitHub and upload everything in this folder (including the empty `.nojekyll` file).
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
4. After a minute the game is live at `https://<your-username>.github.io/<repository-name>/`.

## First flight

1. In the hangar, load **Orbiter I** from the "Load craft…" menu (or build your own by dragging parts from the tray) and press **Launch**.
2. Press **Space** to ignite. Hold **D** a little after 1 km to tip east and start your gravity turn; aim for about 45° by 12 km.
3. When the first stage runs dry, press **Space** to drop it and light the upper stage.
4. Cut the engine (**X**) when your apoapsis (in Flight data, or the map with **M**) reaches about 80 km.
5. Coast to apoapsis, point prograde (**Pro** button) and burn until the periapsis is above 70 km. You're in orbit.
6. In the map, click your orbit to add a maneuver node and plan a trip to Mira.

## Building

Drag parts from the tray on the left into the build area. A part snaps end to end with another (the attach points light up), or onto the side of a tank. Red means it can't go there.

| Input | Action |
|---|---|
| Drag from the tray | Add a part |
| Click or tap a tray part | Add it at the lowest free attach point |
| Drag a placed part (touch: hold, then drag) | Move it with everything below it |
| Drop on the tray, or Delete | Remove |
| Wheel, or drag empty space | Zoom, pan |
| Two fingers | Pan and pinch-zoom |
| Home, or Fit | Frame the whole craft |
| Make root | Make the selected part the root |

## Flight controls

| Key | Action |
|---|---|
| Space | Next stage |
| Shift / Ctrl | Throttle up / down |
| Z / X | Full / cut throttle |
| A / D or ← / → | Rotate |
| T | SAS on/off |
| M | Map view |
| . / , | Faster / slower time warp |
| / | Stop time warp |
| P | Deploy parachutes |
| Tab | Change map focus |
| H | Controls panel |
| Esc | Menu (revert, back to hangar) |

## Tests

Run `node tests/run.js` (or `npm test`). The physics, orbit and save tests need only Node. The page test also needs jsdom: run `npm install` once to get it; without it, that test is skipped.

## Files

See `PLAN.md` for the full design: architecture, physics model, building system, art direction, the complete KSP feature map, the mods whose ideas are planned in, and the step-by-step roadmap. `PARTS.md` lists every stock KSP part and its planned Flatspace equivalent.
