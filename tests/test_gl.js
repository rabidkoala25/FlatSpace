// Step B1: the WebGL2 renderer, tested in a real browser (Chromium through Playwright).
// Skipped when Playwright or a Chromium build isn't available. To run it on your own
// computer: "npm install playwright" and "npx playwright install chromium".
// Set CHROMIUM=/path/to/chrome to use a particular browser.
const fs = require('fs');
const path = require('path');
const { ROOT, check, done } = require('./lib');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  console.log('  skip WebGL test: Playwright is not installed');
  process.exit(0);
}
const exe = process.env.CHROMIUM || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const url = (page, q = '') => 'file://' + path.join(ROOT, page).replace(/\\/g, '/') + q;

// Inside the page: how much of the craft is drawn in exact palette colours, and the craft's
// pixels, around its centre on screen (device pixels, read back from the WebGL canvas).
function readCraft() {
  const G = FS.game, cv = document.getElementById('view');
  const c = document.createElement('canvas');
  c.width = cv.width; c.height = cv.height;
  const g = c.getContext('2d');
  g.drawImage(cv, 0, 0);
  const dpr = cv.width / cv.clientWidth;
  const sp = FS.Renderer.partToScreen(G.cam, G.vessel, G.t, { x: 0, y: 0 });
  const r = Math.min(160, G.vessel.layout.height * G.cam.s * 0.6) * dpr;
  const x0 = Math.max(0, Math.round(sp.x * dpr - r)), y0 = Math.max(0, Math.round(sp.y * dpr - r));
  const w = Math.min(cv.width - x0, Math.round(r * 2)), h = Math.min(cv.height - y0, Math.round(r * 2));
  const d = g.getImageData(x0, y0, w, h).data;
  const pal = new Set(FS.Palette.all.map((q) => q.join(',')));
  const night = new Set(FS.Palette.ramps.night.map((q) => q.join(',')));
  let craft = 0, exact = 0;
  const px = [];
  for (let i = 0; i < d.length; i += 4) {
    const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
    const isCraft = !night.has(k) && d[i] + d[i + 1] + d[i + 2] > 60;
    px.push(isCraft ? [d[i], d[i + 1], d[i + 2]] : null);
    if (!isCraft) continue;
    craft++;
    if (pal.has(k)) exact++;
  }
  return { craft, exact: exact / Math.max(1, craft), px };
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  } catch (e) {
    console.log('  skip WebGL test: no Chromium to run (' + e.message.split('\n')[0] + ')');
    process.exit(0);
  }
  const p = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await p.goto(url('index.html', '?debug'));
  await p.waitForTimeout(1200);
  check(await p.evaluate(() => FS.Renderer === FS.RenderGL), 'with WebGL2 the game draws with the WebGL renderer');
  check(await p.evaluate(() => !document.querySelector('.gl-notice')), 'and shows no fallback notice');

  // crisp: zoomed in, the craft's art pixels are flat palette colours, with blends only at
  // their edges
  await p.evaluate(() => { const G = FS.game; G.paused = true; G.vessel.sas = false; G.vessel.omega = 0; G.zoom = 5; });
  await p.waitForTimeout(150);
  const close = await p.evaluate(readCraft);
  check(close.craft > 2000 && close.exact > 0.7, `close up, ${(close.exact * 100).toFixed(0)}% of the craft's screen pixels are exact palette colours (nothing blurred)`);

  // no shimmer: turning by 0.05° moves edges smoothly; no screen pixel jumps between colours
  for (const zoom of [1.6, 5]) {
    await p.evaluate((z) => { FS.game.zoom = z; }, zoom);
    await p.waitForTimeout(500); // the camera eases to the new zoom
    const level = await p.evaluate(() => FS.Renderer.stats().level);
    const a0 = await p.evaluate(() => FS.game.vessel.angle);
    let pops = 0, prev = null, total = 0;
    for (let i = 0; i < 8; i++) {
      await p.evaluate((a) => { FS.game.vessel.angle = a; }, a0 + (i * 0.05 * Math.PI) / 180);
      await p.waitForTimeout(80);
      const now = await p.evaluate(readCraft);
      if (prev) {
        for (let k = 0; k < now.px.length; k++) {
          const a = now.px[k], b = prev.px[k];
          if (!a || !b) continue;
          total++;
          if (Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) > 60) pops++;
        }
      }
      prev = now;
    }
    check(total > 1000 && pops / total < 0.002, `turning slowly at ${16 / Math.pow(2, level)} art pixels per metre, ${pops} of ${total} pixels jump colour (no shimmer)`);
  }

  // the pixel-size setting coarsens the grid
  await p.evaluate(() => { FS.game.zoom = 1.6; });
  await p.waitForTimeout(600);
  const lv = await p.evaluate(() => { FS.RenderGL.setPixelSize(3); return new Promise((res) => setTimeout(() => res(FS.Renderer.stats().level), 200)); });
  const lv0 = await p.evaluate(() => { FS.RenderGL.setPixelSize(1.5); return new Promise((res) => setTimeout(() => res(FS.Renderer.stats().level), 200)); });
  check(lv > lv0, `a bigger pixel size uses fewer art pixels per metre (level ${lv0} → ${lv})`);

  // the map draws the planets
  await p.evaluate(() => { FS.game.paused = false; });
  await p.keyboard.press('m');
  await p.waitForTimeout(300);
  const map = await p.evaluate(() => {
    const G = FS.game, cv = document.getElementById('view');
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
    const g = c.getContext('2d'); g.drawImage(cv, 0, 0);
    const a = FS.bodyAbs(FS.root, G.t);
    const s = FS.Renderer.worldToScreen(G.mapCam, a.x, a.y);
    const d = g.getImageData(Math.round(s.x), Math.round(s.y), 1, 1).data;
    return { mapMode: G.mapMode, centre: [d[0], d[1], d[2]], night: FS.Palette.ramps.night.map((q) => q.join(',')) };
  });
  check(map.mapMode && !map.night.includes(map.centre.join(',')), `the map draws Aster (centre pixel ${map.centre.join(',')})`);
  check(errors.length === 0, 'no script errors in the game' + (errors.length ? ': ' + errors.join(' | ') : ''));

  // ?canvas2d forces the simple renderer, with no notice
  await p.goto(url('index.html', '?canvas2d'));
  await p.waitForTimeout(400);
  check(await p.evaluate(() => FS.Renderer === FS.Render && !document.querySelector('.gl-notice')), '?canvas2d uses the Canvas 2D renderer');

  // the art gallery
  errors.length = 0;
  await p.goto(url('art.html'));
  await p.waitForTimeout(600);
  const gal = await p.evaluate(() => ({ swatches: document.querySelectorAll('.ramp span').length, n: FS.Palette.all.length }));
  check(gal.swatches === gal.n && errors.length === 0, `the gallery shows all ${gal.n} palette colours and the sprites without errors`);

  await browser.close();
  done();
})();
