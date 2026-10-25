// Step B1: the WebGL2 renderer, tested in a real browser (Chromium through Playwright).
// Skipped when Playwright or a Chromium build isn't available. To run it on your own
// computer: "npm install playwright" and "npx playwright install chromium".
// Set CHROMIUM=/path/to/chrome to use a particular browser.
const fs = require('fs');
const path = require('path');
const { ROOT, check, done } = require('./lib');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  console.log('  skip WebGL test: Playwright is not installed');
  process.exit(0);
}
const chromiumPath =
  process.env.CHROMIUM ||
  ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((candidatePath) =>
    fs.existsSync(candidatePath),
  );
const url = (page, query = '') => 'file://' + path.join(ROOT, page).replace(/\\/g, '/') + query;

// Inside the page: how much of the craft is drawn in exact palette colours, and the craft's
// pixels, around its centre on screen (device pixels, read back from the WebGL canvas).
function readCraft() {
  const game = FS.game;
  const viewCanvas = document.getElementById('view');
  const copyCanvas = document.createElement('canvas');
  copyCanvas.width = viewCanvas.width;
  copyCanvas.height = viewCanvas.height;
  const graphics = copyCanvas.getContext('2d');
  graphics.drawImage(viewCanvas, 0, 0);
  const pixelRatio = viewCanvas.width / viewCanvas.clientWidth;
  const screenPoint = FS.Renderer.partToScreen(game.cam, game.vessel, game.t, { x: 0, y: 0 });
  const radius = Math.min(160, game.vessel.layout.height * game.cam.s * 0.6) * pixelRatio;
  const startX = Math.max(0, Math.round(screenPoint.x * pixelRatio - radius));
  const startY = Math.max(0, Math.round(screenPoint.y * pixelRatio - radius));
  const width = Math.min(viewCanvas.width - startX, Math.round(radius * 2));
  const height = Math.min(viewCanvas.height - startY, Math.round(radius * 2));
  const pixels = graphics.getImageData(startX, startY, width, height).data;
  const paletteColours = new Set(FS.Palette.all.map((colour) => colour.join(',')));
  const night = new Set(FS.Palette.ramps.night.map((colour) => colour.join(',')));
  let craft = 0;
  let exact = 0;
  const samples = [];
  for (let byte = 0; byte < pixels.length; byte += 4) {
    const colourKey = pixels[byte] + ',' + pixels[byte + 1] + ',' + pixels[byte + 2];
    const isCraft = !night.has(colourKey) && pixels[byte] + pixels[byte + 1] + pixels[byte + 2] > 60;
    samples.push(isCraft ? [pixels[byte], pixels[byte + 1], pixels[byte + 2]] : null);
    if (!isCraft) {
      continue;
    }
    craft++;
    if (paletteColours.has(colourKey)) {
      exact++;
    }
  }
  return { craft, exact: exact / Math.max(1, craft), px: samples };
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: chromiumPath,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
  } catch (error) {
    console.log('  skip WebGL test: no Chromium to run (' + error.message.split('\n')[0] + ')');
    process.exit(0);
  }
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
      errors.push(message.text());
    }
  });

  await page.goto(url('index.html', '?debug'));
  await page.waitForTimeout(1200);
  check(
    await page.evaluate(() => FS.Renderer === FS.RenderGL),
    'with WebGL2 the game draws with the WebGL renderer',
  );
  check(await page.evaluate(() => !document.querySelector('.gl-notice')), 'and shows no fallback notice');

  // crisp: zoomed in, the craft's art pixels are flat palette colours, with blends only at
  // their edges
  await page.evaluate(() => {
    const game = FS.game;
    game.paused = true;
    game.vessel.sas = false;
    game.vessel.omega = 0;
    game.zoom = 5;
  });
  await page.waitForTimeout(150);
  const close = await page.evaluate(readCraft);
  check(
    close.craft > 2000 && close.exact > 0.7,
    `close up, ${(close.exact * 100).toFixed(0)}% of the craft's screen pixels are exact palette colours (nothing blurred)`,
  );

  // no shimmer: turning by 0.05° moves edges smoothly; no screen pixel jumps between colours
  for (const zoom of [1.6, 5]) {
    await page.evaluate((zoomValue) => {
      FS.game.zoom = zoomValue;
    }, zoom);
    await page.waitForTimeout(500); // the camera eases to the new zoom
    const level = await page.evaluate(() => FS.Renderer.stats().level);
    const startAngle = await page.evaluate(() => FS.game.vessel.angle);
    let pops = 0;
    let prev = null;
    let total = 0;
    for (let frame = 0; frame < 8; frame++) {
      await page.evaluate(
        (angle) => {
          FS.game.vessel.angle = angle;
        },
        startAngle + (frame * 0.05 * Math.PI) / 180,
      );
      await page.waitForTimeout(80);
      const now = await page.evaluate(readCraft);
      if (prev) {
        for (let index = 0; index < now.px.length; index++) {
          const current = now.px[index];
          const previous = prev.px[index];
          if (!current || !previous) {
            continue;
          }
          total++;
          if (
            Math.max(
              Math.abs(current[0] - previous[0]),
              Math.abs(current[1] - previous[1]),
              Math.abs(current[2] - previous[2]),
            ) > 60
          ) {
            pops++;
          }
        }
      }
      prev = now;
    }
    check(
      total > 1000 && pops / total < 0.002,
      `turning slowly at ${16 / Math.pow(2, level)} art pixels per metre, ${pops} of ${total} pixels jump colour (no shimmer)`,
    );
  }

  // the pixel-size setting coarsens the grid
  await page.evaluate(() => {
    FS.game.zoom = 1.6;
  });
  await page.waitForTimeout(600);
  const coarseLevel = await page.evaluate(() => {
    FS.RenderGL.setPixelSize(3);
    return new Promise((resolve) => setTimeout(() => resolve(FS.Renderer.stats().level), 200));
  });
  const fineLevel = await page.evaluate(() => {
    FS.RenderGL.setPixelSize(1.5);
    return new Promise((resolve) => setTimeout(() => resolve(FS.Renderer.stats().level), 200));
  });
  check(
    coarseLevel > fineLevel,
    `a bigger pixel size uses fewer art pixels per metre (level ${fineLevel} → ${coarseLevel})`,
  );

  // the map draws the planets
  await page.evaluate(() => {
    FS.game.paused = false;
  });
  await page.keyboard.press('m');
  await page.waitForTimeout(300);
  const map = await page.evaluate(() => {
    const game = FS.game;
    const viewCanvas = document.getElementById('view');
    const copyCanvas = document.createElement('canvas');
    copyCanvas.width = viewCanvas.width;
    copyCanvas.height = viewCanvas.height;
    const graphics = copyCanvas.getContext('2d');
    graphics.drawImage(viewCanvas, 0, 0);
    const asterCentre = FS.bodyAbs(FS.root, game.t);
    const screenPoint = FS.Renderer.worldToScreen(game.mapCam, asterCentre.x, asterCentre.y);
    const pixel = graphics.getImageData(Math.round(screenPoint.x), Math.round(screenPoint.y), 1, 1).data;
    return {
      mapMode: game.mapMode,
      centre: [pixel[0], pixel[1], pixel[2]],
      night: FS.Palette.ramps.night.map((colour) => colour.join(',')),
    };
  });
  check(
    map.mapMode && !map.night.includes(map.centre.join(',')),
    `the map draws Aster (centre pixel ${map.centre.join(',')})`,
  );
  check(
    errors.length === 0,
    'no script errors in the game' + (errors.length ? ': ' + errors.join(' | ') : ''),
  );

  // ?canvas2d forces the simple renderer, with no notice
  await page.goto(url('index.html', '?canvas2d'));
  await page.waitForTimeout(400);
  check(
    await page.evaluate(() => FS.Renderer === FS.Render && !document.querySelector('.gl-notice')),
    '?canvas2d uses the Canvas 2D renderer',
  );

  // the art gallery
  errors.length = 0;
  await page.goto(url('art.html'));
  await page.waitForTimeout(600);
  const gallery = await page.evaluate(() => ({
    swatches: document.querySelectorAll('.ramp span').length,
    n: FS.Palette.all.length,
  }));
  check(
    gallery.swatches === gallery.n && errors.length === 0,
    `the gallery shows all ${gallery.n} palette colours and the sprites without errors`,
  );

  await browser.close();
  done();
})();
