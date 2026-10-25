// turns my pixel art into a sprite file

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PNG } = require('pngjs');
const ROOT = path.join(__dirname, '..');

//load palette
global.window = global;
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'art/palette.js'), 'utf8'), { filename: 'art/palette.js' });
const P = FS.Palette;

//skin markers are magenta and allow for scaling and easy development of part styles that can stretch

const SKIN_MARKERS = { ff80ff: 1, ff00ff: 0, c000c0: -1, '800080': -2};
const lookup = new Map();
for (const [name, list] of Object.entries(P.hex)) {
    list.forEach((hex, tone) => lookup.set(hex.slice(1).toLowerCase(), [name, tone]));

}

for (const [hex, offset] of Object.entries(SKIN_MARKERS)) lookup.set(hex, ['skin', offset]);

//colours are depicted using characters
const CHARS  = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ#$%&*+_=?@^~';

//reads png into rows of characters based on colours
function readRows(file, legend, used) {
    const png = PNG.sync.read(fs.readFileSync(file));
    const d = png.data;
    const rows = [];
    for (let y=0; y<png.height; y++) {
        let row = '';
        for (let x=0; x<png.width; x++) {
            const i = (y*png.width +x) *4;
            if (d[i+3]<128) { row += '.'; continue;} //transparent
            
            const hex = [d[i], d[i+1], d[i+2]].map((v) => v.toString(16).padStart(2, '0')).join('');
            const entry = lookup.get(hex);
            if (!entry) {
                throw new Error (`${path.basename(file)}: bro you're stupid you used colour #${hex} at pixel (${x}, ${y}) and its not in the palette`);


            }
            if (!used.has(hex)) {
                const ch = CHARS[used.size];
                used.set(hex, ch);
                legend[ch] = entry;

            }
            row += used.get(hex);
        }
        rows.push(row);
    }
    return rows;
}

// holy moly that was a pyramid


// writes art/sprites/<id>.js
function write(id, sprite) {
    const out = path.join(ROOT, 'art/sprites', id + '.js');
    const text = `// thy will hath been done. edit thy png then run thy code once more. \n` + `FS.SPRITES = FS.SPRITES || {};\n` + `FS.SPRITES['${id}'] = ${JSON.stringify(sprite, null, 2)};\n`;
    fs.mkdirSync(path.dirname(out), { recursive: true});
    fs.writeFileSync(out, text);
    console.log('wrote ' + path.relative(ROOT, out));

}

const arg = process.argv[2];
if (!arg) {
    console.log('use: usage: node tools/png2sprite.js art/png/<name>.png   (or --palette)');
    process.exit(1);

}

if (arg === '--palette') {
    for (const [name, list] of Object.entries(P.hex)) console.log(name.padEnd(7) + list.join(' '));
    console.log('skin   ' + Object.keys(SKIN_MARKERS).map((h)=> '#' + h).join('') + '   (tanks only: lighter . . . darker)');
    process.exit(0)

}

try {
    const legend = {'.': null};
    const used = new Map();
    const base = path.basename(arg, '.png');
    const slice = base.match(/^(.*)-(top|body|bottom)$/);

    if (slice) {
        const id = slice[1];
        const dir = path.dirname(arg);
        const sprite = {legend};
        for (const part of ['top', 'body', 'bottom']) {
            sprite[part] = readRows(path.join(dir, `${id}-${part}.png`), legend, used);

        }
        write(id, sprite);

    } else {
        write(base, {legend, rows: readRows(arg, legend, used) });

    }

} catch (e) {
    console.log('png2sprite: ' + e.message);
    process.exit(1);

}
