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
for (const f of ['js/util.js', 'art/palette.js', 'js/sprites.js']) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), {filename: f});

}
// as i'm replacing all the sprites with my own art i should load them too to test it 

const spriteDir = path.join(ROOT, 'art/sprites');
const spriteFiles = fs.existsSync(spriteDir) ? //idk wth this is i thought i could just use regular syntax here but i guess now we're asking questions
fs.readdirSync(spriteDir).filter((f) => f.endsWith('.js')) : [];
for (const f of spriteFiles) {
    vm.runInThisContext(fs.readFileSync(path.join(spriteDir,f), 'utf8'), {filename: 'art/sprites/' + f});

}

const S = FS.Sprites;
const P = FS.Palette;
const same = (a,b) => a.length === b.length && a.every((v,i)=> v === b[i]);
const pixel = (img, x, y) => Array.from(img.data.slice((y*img.width + x) *4, (y*img.width + x) *4 +4));
function throws(fn,text) {
    try {fn(); return false; } catch (e) {return e.message.includes(text); }

}

// that's the setup done, here are all the checks
// Each check outputs either OK or FAIL, followed by a comment on what it is checking for

const tiny = S.parse('tiny', {
    legend: { '.': null, a: ['metal', 0], b: ['gold', 4]}, 
    rows: ['ab', '.a'],
});

check(tiny.w === 2 && tiny.h === 2, '2x2 grid gives a 2x2 sprite');

const img = S.toImage(tiny);

//pixel colour checks
check(same(pixel(img, 1, 0), [...P.ramps.gold[4], 255]), 'pixel (1,0) is gold, tone 4');
check(same(pixel(img, 0, 0), [...P.ramps.metal[0], 255]), 'pixel (0,0) is metal, tone 0');
check(pixel(img, 0, 1)[3] === 0, "'.' pixels are transparent");

//checking to make sure the error's throwing arm works
check(throws(() => S.parse('short', { legend: { a: ['metal', 0] }, rows: ['aa', 'a'] }), 'row 1 equal 2, but it is 1'), 'a short row throws');
check(throws(() => S.parse('odd', { legend: { a: ['metal', 0] }, rows: ['ax'] }), "row 0 uses x which"), 'a character MIA from the legend throws');
check(throws(() => S.parse('dim', { legend: { a: ['gold', 9] }, rows: ['a'] }), "doesnt have tone 9"), 'a tone the ramp does not have (skill issue) throws');
check(throws(() => S.parse('what', { legend: { a: ['plaid', 1] }, rows: ['a'] }), "has ramp plaid which"), 'an unknown (0 IQ?) ramp throws correctly');

//need to validate whether 16 pixels is indeed a meter or if the scientists lied to us
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'data/parts.js'), 'utf8'), {filename: 'data/parts.js' })
for (const d of FS.DATA.parts) {
    const def = FS.SPRITES[d.id];
    if (!def || !def.rows || typeof d.w !== 'number' || d.fin || d.radial) continue;
    const w = Math.round(d.w *16), h = Math.round(d.len * 16);
    check(def.rows.length === h&& def.rows[0].length === w, `art/sprites: ${d.id} is ${w} x ${h} px (${d.w} m x ${d.len} m)`);

}

// every hand drawn sprite parses

for (const [id, def] of Object.entries(FS.SPRITES)) {
    if (def.rows) check(!throws(() => S.parse(id,def), ''), `art/sprites: ${id} parses correctly`);
    else check(def.top && def.body && def.bottom, `art/sprites: ${id} has top, body and bottom rows`);

}

const bar = S.parse('bar', {legend: {'.': null, a: ['metal', 4]}, rows: ['.aaaaaa.']});
check(Math.abs(bar.nx[4]) < 30 && bar.nx[1] < -100 && bar.nx[6] > 100, 'A drawn row is shaped like a cylinder correctly');

const tank1 = S.profile({id: 't', len: 0.5, maxHalf: 0.625, halfWidthAt: () => 0.625, ramp: 'metal', tone: 5});
check(tank1.w === 20 && tank1.h === 8, 'a 1.25 m x 0.5 m cylinder is 20 x 8 px');
let mirrored = true;
for (let x=0; x<tank1.w; x++) if (tank1.nx[x] !== -tank1.nx[tank1.w - 1 -x]) mirrored = false;
check(mirrored, 'its shape layer is symmetric')
const rowWidth = (s,y) => {let n = 0; for (let x = 0; x<S.w; x++) n += S.solid[y*S.w +x]; return n;};
const cone = S.profile({id: 'c', len:1, maxHalf: 1.25, halfWidthAt: (v)=> 0.625 + 0.625 * v, ramp: 'metal', tone: 5});
check(rowWidth(cone,0) < rowWidth(cone, cone.h -1), ' a cone that widens downwards is narrower at the top');
check(cone.ny[Math.floor(cone.h / 2) * cone.w + cone.w/2] >0, "a cone that widens downwards faces slightly up");
check(tank1.ny.every((v) => v === 0), "a cylinder's sides are vertical");




// im so done bro

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

check([0.5, 2, 4, 24].every((len) => S.tank(1.25, len, 'white').h === len*16), 'sample tanks are correck pixel tall');

check(S.tank(1.25, 2, 'white').w === 20, 'a 1.25 m tank has correct width');

check(S.tank(1.25, 0.25, 'white').h === 4, 'a 0.25 tank is still 4px tall');

const white = S.tank(1.25, 2, 'white'), foam = S.tank(1.25, 2, 'foam');
check(same(Array.from(white.solid), Array.from(foam.solid)), 'changing the skin keeps the shape');
check(!same(Array.from(white.ramp), Array.from(foam.ramp)), 'changing the skin changes the colours');
check(white.ramp.every((r) => r !== 255), 'no skin placeholder is left after the skin is applied');
check(S.tank(0.7, 2, 'white') === null, "no width is null so old art is used");

 
//das it 


done();