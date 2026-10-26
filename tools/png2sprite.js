// turns my pixel art into a sprite file

const fileSystem = require('fs');
const path = require('path');
const virtualMachine = require('vm');
const { PNG } = require('pngjs');
const ROOT = path.join(__dirname, '..');

//load palette
global.window = global;
virtualMachine.runInThisContext(fileSystem.readFileSync(path.join(ROOT, 'art/palette.js'), 'utf8'), { filename: 'art/palette.js' });
const Palette = Flatspace.Palette;

//skin markers are magenta and allow for scaling and easy development of part styles that can stretch

const SKIN_MARKERS = { ff80ff: 1, ff00ff: 0, c000c0: -1, '800080': -2};
const colourLookup = new Map();
for (const [rampName, hexList] of Object.entries(Palette.hex)) {
    hexList.forEach((hex, tone) => colourLookup.set(hex.slice(1).toLowerCase(), [rampName, tone]));

}

for (const [hex, toneOffset] of Object.entries(SKIN_MARKERS)) colourLookup.set(hex, ['skin', toneOffset]);

//colours are depicted using characters
const LEGEND_CHARACTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ#$%&*+_=?@^~';

//reads png into rows of characters based on colours
function readRows(pngFile, legend, coloursUsed) {
    const image = PNG.sync.read(fileSystem.readFileSync(pngFile));
    const rgba = image.data;
    const rows = [];
    for (let rowNumber = 0; rowNumber < image.height; rowNumber++) {
        let rowText = '';
        for (let column = 0; column < image.width; column++) {
            const byte = (rowNumber * image.width + column) * 4;
            if (rgba[byte + 3] < 128) { rowText += '.'; continue;} //transparent
            
            const hex = [rgba[byte], rgba[byte + 1], rgba[byte + 2]].map((value) => value.toString(16).padStart(2, '0')).join('');
            const colour = colourLookup.get(hex);
            if (!colour) {
                throw new Error (`${path.basename(pngFile)}: bro you're stupid you used colour #${hex} at pixel (${column}, ${rowNumber}) and its not in the palette`);


            }
            if (!coloursUsed.has(hex)) {
                const character = LEGEND_CHARACTERS[coloursUsed.size];
                coloursUsed.set(hex, character);
                legend[character] = colour;

            }
            rowText += coloursUsed.get(hex);
        }
        rows.push(rowText);
    }
    return rows;
}

// holy moly that was a pyramid


// writes art/sprites/<id>.js
function writeSprite(id, drawing) {
    const outputPath = path.join(ROOT, 'art/sprites', id + '.js');
    const fileText = `// thy will hath been done. edit thy png then run thy code once more. \n` + `Flatspace.SPRITES = Flatspace.SPRITES || {};\n` + `Flatspace.SPRITES['${id}'] = ${JSON.stringify(drawing, null, 2)};\n`;
    fileSystem.mkdirSync(path.dirname(outputPath), { recursive: true});
    fileSystem.writeFileSync(outputPath, fileText);
    console.log('wrote ' + path.relative(ROOT, outputPath));

}

const inputFile = process.argv[2];
if (!inputFile) {
    console.log('use: usage: node tools/png2sprite.js art/png/<name>.png   (or --palette)');
    process.exit(1);

}

if (inputFile === '--palette') {
    for (const [rampName, hexList] of Object.entries(Palette.hex)) console.log(rampName.padEnd(7) + hexList.join(' '));
    console.log('skin   ' + Object.entries(SKIN_MARKERS).sort((first, second) => second[1] - first[1]).map(([hex]) => '#' + hex).join(' ') + '   (tanks only: lighter . . . darker)');
    process.exit(0)

}

try {
    const legend = {'.': null};
    const coloursUsed = new Map();
    const fileName = path.basename(inputFile, '.png');
    const sliceMatch = fileName.match(/^(.*)-(top|body|bottom)$/);

    if (sliceMatch) {
        const id = sliceMatch[1];
        const folder = path.dirname(inputFile);
        const drawing = {legend};
        for (const piece of ['top', 'body', 'bottom']) {
            drawing[piece] = readRows(path.join(folder, `${id}-${piece}.png`), legend, coloursUsed);

        }
        writeSprite(id, drawing);

    } else {
        writeSprite(fileName, {legend, rows: readRows(inputFile, legend, coloursUsed) });

    }

} catch (error) {
    console.log('png2sprite: ' + error.message);
    process.exit(1);

}
