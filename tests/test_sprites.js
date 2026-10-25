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
 
//das it 


done();