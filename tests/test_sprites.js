// The purpose of this code right here is to test that the sprite system is working
//
// i explain this system more in the little sprite test markdown file over there <-
//
// yeh just tests the subsystem
//
//


//this reads the sprites and turns them into pixels

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {ROOT, check, done} = require('./lib');

// all sprites.js needs are util.js and palette.js

global.window = global;
for (const fileName of ['js/util.js', 'art/palette.js', 'js/sprites.js']) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, fileName), 'utf8'), {filename: fileName});

}
// as i'm replacing all the sprites with my own art i should load them too to test it

const spriteFolder = path.join(ROOT, 'art/sprites');
const spriteFiles = fs.existsSync(spriteFolder) ? //idk wth this is i thought i could just use regular syntax here but i guess now we're asking questions
fs.readdirSync(spriteFolder).filter((fileName) => fileName.endsWith('.js')) : [];
for (const fileName of spriteFiles) {
    vm.runInThisContext(fs.readFileSync(path.join(spriteFolder, fileName), 'utf8'), {filename: 'art/sprites/' + fileName});

}

const Sprites = FS.Sprites;
const Palette = FS.Palette;
const same = (listA, listB) => listA.length === listB.length && listA.every((value, index) => value === listB[index]);
const pixelColour = (image, column, row) => Array.from(image.data.slice((row * image.width + column) * 4, (row * image.width + column) * 4 + 4));
function throws(run, expectedText) {
    try {run(); return false; } catch (error) {return error.message.includes(expectedText); }

}

// that's the setup done, here are all the checks
// Each check outputs either OK or FAIL, followed by a comment on what it is checking for

const tiny = Sprites.parse('tiny', {
    legend: { '.': null, a: ['metal', 0], b: ['gold', 4]},
    rows: ['ab', '.a'],
});

check(tiny.width === 2 && tiny.height === 2, '2x2 grid gives a 2x2 sprite');

const tinyImage = Sprites.toImage(tiny);

//pixel colour checks
check(same(pixelColour(tinyImage, 1, 0), [...Palette.ramps.gold[4], 255]), 'pixel (1,0) is gold, tone 4');
check(same(pixelColour(tinyImage, 0, 0), [...Palette.ramps.metal[0], 255]), 'pixel (0,0) is metal, tone 0');
check(pixelColour(tinyImage, 0, 1)[3] === 0, "'.' pixels are transparent");

//checking to make sure the error's throwing arm works
check(throws(() => Sprites.parse('short', { legend: { a: ['metal', 0] }, rows: ['aa', 'a'] }), 'row 1 equal 2, but it is 1'), 'a short row throws');
check(throws(() => Sprites.parse('odd', { legend: { a: ['metal', 0] }, rows: ['ax'] }), "row 0 uses x which"), 'a character MIA from the legend throws');
check(throws(() => Sprites.parse('dim', { legend: { a: ['gold', 9] }, rows: ['a'] }), "has no tone 9"), 'a tone the ramp does not have (skill issue) throws');
check(throws(() => Sprites.parse('what', { legend: { a: ['plaid', 1] }, rows: ['a'] }), "unknown ramp 'plaid'"), 'an unknown (0 IQ?) ramp throws correctly');

//need to validate whether 16 pixels is indeed a meter or if the scientists lied to us
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'data/parts.js'), 'utf8'), {filename: 'data/parts.js' })
for (const part of FS.DATA.parts) {
    const drawing = FS.SPRITES[part.id];
    if (!drawing || !drawing.rows || typeof part.w !== 'number' || part.fin || part.radial) continue;
    const widthPixels = Math.round(part.w * 16), heightPixels = Math.round(part.len * 16);
    check(drawing.rows.length === heightPixels && drawing.rows[0].length === widthPixels, `art/sprites: ${part.id} is ${widthPixels} x ${heightPixels} px (${part.w} m x ${part.len} m)`);

}

// every hand drawn sprite parses

for (const [id, drawing] of Object.entries(FS.SPRITES)) {
    if (drawing.rows) check(!throws(() => Sprites.parse(id, drawing), ''), `art/sprites: ${id} parses correctly`);
    else check(drawing.top && drawing.body && drawing.bottom, `art/sprites: ${id} has top, body and bottom rows`);

}

const bar = Sprites.parse('bar', {legend: {'.': null, a: ['metal', 4]}, rows: ['.aaaaaa.']});
check(Math.abs(bar.normalAcross[4]) < 30 && bar.normalAcross[1] < -100 && bar.normalAcross[6] > 100, 'A drawn row is shaped like a cylinder correctly');

const shortTank = Sprites.profile({id: 't', length: 0.5, widestHalfWidth: 0.625, halfWidthAt: () => 0.625, rampName: 'metal', tone: 5});
check(shortTank.width === 20 && shortTank.height === 8, 'a 1.25 m x 0.5 m cylinder is 20 x 8 px');
let mirrored = true;
for (let column = 0; column < shortTank.width; column++) if (shortTank.normalAcross[column] !== -shortTank.normalAcross[shortTank.width - 1 - column]) mirrored = false;
check(mirrored, 'its shape layer is symmetric')
const solidInRow = (sprite, rowNumber) => {let count = 0; for (let column = 0; column < sprite.width; column++) count += sprite.solid[rowNumber * sprite.width + column]; return count;};
const cone = Sprites.profile({id: 'c', length: 1, widestHalfWidth: 1.25, halfWidthAt: (howFarDown) => 0.625 + 0.625 * howFarDown, rampName: 'metal', tone: 5});
check(solidInRow(cone, 0) < solidInRow(cone, cone.height - 1), ' a cone that widens downwards is narrower at the top');
check(cone.normalAlong[Math.floor(cone.height / 2) * cone.width + cone.width / 2] > 0, "a cone that widens downwards faces slightly up");
check(shortTank.normalAlong.every((value) => value === 0), "a cylinder's sides are vertical");




// im so done bro
// --------- tank tests

FS.SPRITES['tank-125'] = FS.SPRITES['tank-125'] || {
    legend: {'.': null, K: ['metal', 1], S: ['skin', 0], s: ['skin', -1]},
    rows: [
        'KKKKKKKKKKKKKKKKKKKK',
        'ssssssssssssssssssss',
        'ssssssssssssssssssss',
        'ssssssssssssssssssss',
        'SSSSSSSSSSSSSSSSSSSS',
        'SSSSSSSSSSSSSSSSSSSS',
        'SSSSSSSSSSSSSSSSSSSS', // TEST TANK
        'ssssssssssssssssssss',
        'ssssssssssssssssssss',
        'ssssssssssssssssssss',
        'ssssssssssssssssssss',
        'KKKKKKKKKKKKKKKKKKKK',
    ],
};

check([0.5, 2, 4, 24].every((length) => Sprites.tank(1.25, length, 'white').height === length * 16), 'sample tanks are correck pixel tall');

check(Sprites.tank(1.25, 2, 'white').width === 20, 'a 1.25 m tank has correct width');

check(Sprites.tank(1.25, 0.25, 'white').height === 4, 'a 0.25 tank is still 4px tall');

const whiteTank = Sprites.tank(1.25, 2, 'white'), foamTank = Sprites.tank(1.25, 2, 'foam');
check(same(Array.from(whiteTank.solid), Array.from(foamTank.solid)), 'changing the skin keeps the shape');
check(!same(Array.from(whiteTank.ramp), Array.from(foamTank.ramp)), 'changing the skin changes the colours');
check(whiteTank.ramp.every((rampNum) => rampNum !== 255), 'no skin placeholder is left after the skin is applied');
check(Sprites.tank(0.7, 2, 'white') === null, "no width is null so old art is used");



// ------ lighting tests


const cylinder = Sprites.profile({ id: 'cyl', length: 0.25, widestHalfWidth: 0.625, halfWidthAt: () => 0.625, rampName: 'metal', tone: 4});

//which metal tone a pixel is
const metalToneAt = (image, column, row) => Palette.ramps.metal.findIndex((colour) => colour[0] === pixelColour(image, column, row)[0] && colour[1] === pixelColour(image, column, row)[1] && colour[2] === pixelColour(image, column, row)[2]);

const sunFromRight = Sprites.light(cylinder, 1, 0, 1);
check(metalToneAt(sunFromRight, cylinder.width - 2, 1) > metalToneAt(sunFromRight, 1, 1), 'with the sun on the right the right side is brighter');
const sunFromNose = Sprites.light(cylinder, 0, 1, 1);

let symmetric = true;
for (let column = 0; column < cylinder.width; column++) if (metalToneAt(sunFromNose, column, 1) !== metalToneAt(sunFromNose, cylinder.width - 1 - column, 1)) symmetric = false;
check(symmetric, ' with sun at nose the lights are symmetric')

const inShadow = Sprites.light(cylinder, 1, 0, 0);
let allDark = true;
for (let column = 0; column < cylinder.width; column++) if (metalToneAt(inShadow, column, 1) !== 2) allDark = false;
check(allDark, "in a planet's shadow all pixels are darker")

const goldBar = Sprites.profile({ id: 'g', length: 0.25, widestHalfWidth: 0.625, halfWidthAt: () => 0.625, rampName: 'gold', tone: 2});
const goldLit = Sprites.light(goldBar, 0, 0.0001, 1);
let goldTop = false;
for (let column = 0; column < goldBar.width; column++) if (same(pixelColour(goldLit, column, 1).slice(0, 3), Palette.ramps.gold[4])) goldTop = true;
check(!goldTop, 'shiny highlight only visible on shiny surface (ie. metal)');

const engine = Sprites.profile({ id: 'e', length: 1, widestHalfWidth: 0.625, halfWidthAt: () => 0.625, rampName: 'metal', tone: 2}); // nozzles are drawn dark
const firing = Sprites.light(engine, 0, 1, 1, 1);
const isOrange = (colour) => Palette.ramps.orange.some((orange) => same(orange, colour));
check(isOrange(pixelColour(firing, 10, 14).slice(0, 3)), "a burning engine's nozzle glows orange");
check(!isOrange(pixelColour(firing, 0, 14).slice(0, 3)), 'the outline of the nozzle stays dark');
check(!isOrange(pixelColour(firing, 10, 2).slice(0, 3)), 'the rest of the engine doesnt glow');

// zoom tests

// 4x4 metal test
const square = Sprites.parse('square', {legend: {'.': null, o: ['metal', 1], m: ['metal', 4]}, rows: [
    'oooo',
    'ommo',
    'ommo',
    'oooo'
]});
const halfSquare = Sprites.halve(square);

check(halfSquare.width === 2 && halfSquare.height ===2, 'halving 4x4 gives 2x2');
check(halfSquare.solid.every((solid) => solid === 1), 'a solid is solid');
check(halfSquare.tone.every((tone) => tone === 1), 'outline stays dark after halving');

//odd block rounging testing

//das it


done();
