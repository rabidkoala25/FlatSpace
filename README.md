# Flatspace Program

A 2D rocket-building and spaceflight sandbox in the browser, inspired by Kerbal Space Program. Build a rocket from parts, launch it from the planet Aster, reach orbit, and fly to its moons Mira and Pell using real orbital mechanics (patched conics, maneuver nodes, time warp).

No build step, no dependencies: plain HTML, CSS and JavaScript.

## Play locally

Open `index.html` in a browser. (If your browser blocks local files, run `python3 -m http.server` in this folder and open `http://localhost:8000`.)

## Deploy to GitHub Pages

1. Create a new repository on GitHub and upload everything in this folder (including the empty `.nojekyll` file).
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
4. After a minute the game is live at `https://<your-username>.github.io/<repository-name>/`.

## First flight

1. In the hangar, load **Orbiter I** from the "Load craft…" menu (or build your own) and press **Launch**.
2. Press **Space** to ignite. Hold **D** a little after 1 km to tip east and start your gravity turn; aim for about 45° by 12 km.
3. When the first stage runs dry, press **Space** to drop it and light the upper stage.
4. Cut the engine (**X**) when your apoapsis (in Flight data, or the map with **M**) reaches about 80 km.
5. Coast to apoapsis, point prograde (**Pro** button) and burn until the periapsis is above 70 km. You're in orbit.
6. In the map, click your orbit to add a maneuver node and plan a trip to Mira.

## Controls

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

## Files

See `PLAN.md` for the full design: architecture, physics model, the complete KSP feature map, the mods whose ideas are planned in, and the roadmap.
