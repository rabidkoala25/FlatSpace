// creates new sprite system and does error validation checks and stuff

// todo:
// setup (done)
// render check (done)
// pixel matching (done)

window.Flatspace = window.Flatspace || {};
Flatspace.SPRITES = Flatspace.SPRITES || {}; // the drawn sprites from art/sprites/ go here
(function () {
    const PIXELS_PER_METRE = 16; // pixels per metre

    const RAMP_NAMES = Object.keys(Flatspace.Palette.ramps);
    const rampNumber = (rampName) => RAMP_NAMES.indexOf(rampName);
    const toneCount = (rampIndex) => Flatspace.Palette.ramps[RAMP_NAMES[rampIndex]].length;
    const SKIN_RAMP = 255; // a pixel whose colour comes from the tank's skin later
    //empty sprite template

    function blankSprite(id, width, height) {
        const pixelCount = width * height;
        return {
            id, width, height,
            ramp: new Uint8Array(pixelCount),
            tone: new Uint8Array(pixelCount),
            solid: new Uint8Array(pixelCount),
            //which was the surface faces
            normalAcross: new Int8Array(pixelCount),
            normalAlong: new Int8Array(pixelCount),

        };
    }

    // sprite matching - parses the sprite object creation
    function parse(id, drawing) {
        const rows = drawing.rows;
        if (!rows || !rows.length) throw new Error(`sprite with id ${id} has no rows`);
        const height = rows.length;
        const width = rows[0].length;
        const sprite = blankSprite(id, width, height);

        for (let rowNumber = 0; rowNumber < height; rowNumber++) {
            const rowText = rows[rowNumber];
            if (rowText.length !== width) {
                throw new Error(`sprite with id ${id} was expected to have row ${rowNumber} equal ${width}, but it is ${rowText.length}`);

            }
            for (let column = 0; column < width; column++) {
                const character = rowText[column];
                if (!(character in drawing.legend)) {
                    throw new Error(`sprite with id ${id} on row ${rowNumber} uses ${character} which isn't logged in the legend`)
                }
                const colour = drawing.legend[character];
                if (colour === null) continue;
                const [rampName, toneNumber] = colour;
                const pixel = rowNumber * width + column;
                if (rampName === 'skin') {
                    if (toneNumber < -4 || toneNumber > 4) throw new Error (`sprite with id ${id}: skin offset ${toneNumber} is outise -4 . . . 4`);
                    sprite.ramp[pixel] = SKIN_RAMP;
                    sprite.tone[pixel] = toneNumber + 4;

                } else {
                    const rampIndex = rampNumber(rampName);
                    if (rampIndex < 0) throw new Error(`sprite with id ${id}: unknown ramp '${rampName}'`);
                    if (toneNumber < 0 || toneNumber >= toneCount(rampIndex)) throw new Error(`sprite with id ${id}: ramp '${rampName}' has no tone ${toneNumber}`);
                    sprite.ramp[pixel] = rampIndex;
                    sprite.tone[pixel] = toneNumber;

                }
                sprite.solid[pixel] = 1;
            }
        }
        cylinderShape(sprite);
        return sprite;
    }

    function cylinderShape(sprite) {
        for (let rowNumber = 0; rowNumber < sprite.height; rowNumber++) {
            let column = 0;
            while (column < sprite.width) {
                if (!sprite.solid[rowNumber * sprite.width + column]) {column++; continue;}
                const runStart = column;
                while (column < sprite.width && sprite.solid[rowNumber * sprite.width + column]) column++;
                const runEnd = column - 1;
                const runCentre = (runStart + runEnd + 1) / 2;
                const runHalfWidth = (runEnd - runStart + 1) / 2;
                for (let runColumn = runStart; runColumn <= runEnd; runColumn++) {
                    const pixel = rowNumber * sprite.width + runColumn;
                    sprite.normalAcross[pixel] = Math.round(Flatspace.clamp((runColumn + 0.5 - runCentre) / runHalfWidth, -1, 1) * 127);
                    sprite.normalAlong[pixel] = 0;

                }
            }
        }
    }

    function profile({id, length, widestHalfWidth, halfWidthAt, rampName, tone}) {
        const width = Math.round(2 * widestHalfWidth * PIXELS_PER_METRE);
        const height = Math.max(1, Math.round(length * PIXELS_PER_METRE));
        const sprite = blankSprite(id, width, height);
        const rampIndex = rampNumber(rampName);
        for (let rowNumber = 0; rowNumber < height; rowNumber++){
            const howFarDown = (rowNumber + 0.5) / height; // 0 at the top, 1 at the bottom
            const halfWidthPixels = halfWidthAt(howFarDown) * PIXELS_PER_METRE;
            const halfWidthAbove = halfWidthAt(Math.max(0, howFarDown - 1 / height)) * PIXELS_PER_METRE;
            const halfWidthBelow = halfWidthAt(Math.min(1, howFarDown + 1 / height)) * PIXELS_PER_METRE;
            const widening = (halfWidthBelow - halfWidthAbove) / 2;
            const tilt = widening / Math.sqrt(1 + widening * widening);
            for (let column = 0; column < width; column++) {
                const distanceFromMiddle = column + 0.5 - width / 2;
                if (Math.abs(distanceFromMiddle) > halfWidthPixels) continue;
                const pixel = rowNumber * width + column;
                sprite.solid[pixel] = 1;
                sprite.ramp[pixel] = rampIndex;
                sprite.tone[pixel] = tone;
                sprite.normalAcross[pixel] = Math.round(Flatspace.clamp(distanceFromMiddle / halfWidthPixels, -1, 1) * 127);
                sprite.normalAlong[pixel] = Math.round(tilt * 127);

            }
        }
        return sprite;
    }

    // -------- Stretchable Tanks -------

    const SKINS = {
        white: ['metal', 6],
        steel: ['metal', 4],
        foam: ['orange', 3],
        gold: ['gold', 3],
    };

    function applySkin(sprite, skinName) {
        for (let rowNumber = 0; rowNumber < sprite.height; rowNumber++) {
            for (let column = 0; column < sprite.width; column++) {
                const pixel = rowNumber * sprite.width + column;
                if (sprite.ramp[pixel] !== SKIN_RAMP) continue;
                let rampName, baseTone;
                if (skinName === 'roll') {
                    const stripe = Math.floor((column / sprite.width) * 4);
                    [rampName, baseTone] = stripe % 2 === 0 ? ['metal', 6] : ['metal', 1];

                } else {
                    [rampName, baseTone] = SKINS[skinName] || SKINS.white;
                }
                const rampIndex = rampNumber(rampName);
                sprite.ramp[pixel] = rampIndex;
                sprite.tone[pixel] = Flatspace.clamp(baseTone + (sprite.tone[pixel] - 4), 0, toneCount(rampIndex) - 1);

            }
        }
    }

    //Tanks are procedural as they need to stretch. their design is defined by a width i draw

    const TANK_ART = {
        0.625: 'tank-062',
        1.25: 'tank-125',
        1.875: 'tank-188',
        2.5: 'tank-250',
        3.75: 'tank-375',
        5: 'tank-500',

    };

    const TANK_CAPS = {
        'tank-062': {top: 3, bottom: 3},
        'tank-125' : {top: 4, bottom: 4},
        'tank-188': { top: 5, bottom: 5},
        'tank-250': {top: 6, bottom: 6},
        'tank-375': {top: 8, bottom: 8},
        'tank-500': {top: 10, bottom: 10},
    };

    function tank(width, length, skinName) {
        const id = TANK_ART[width];
        const drawing = id && Flatspace.SPRITES[id];
        if (!drawing) return null;
        const caps = TANK_CAPS[id];
        const drawnRows = drawing.rows;
        const middleRows = drawnRows.slice(caps.top, drawnRows.length - caps.bottom);
        if (!middleRows.length) throw new Error(`sprite with id ${id}: its caps leave no repeatable middle rows`);
        const rowsNeeded = Math.max(1, Math.round(length * PIXELS_PER_METRE));
        let topCap = drawnRows.slice(0, caps.top);
        let bottomCap = drawnRows.slice(drawnRows.length - caps.bottom);
        if (topCap.length + bottomCap.length > rowsNeeded) {
            topCap = topCap.slice(0, Math.floor(rowsNeeded / 2));
            bottomCap = bottomCap.slice(bottomCap.length - Math.ceil(rowsNeeded / 2));

        }
        const tankRows = topCap.slice();
        let middleRow = 0;
        while (tankRows.length < rowsNeeded - bottomCap.length) {
            tankRows.push(middleRows[middleRow % middleRows.length]);
            middleRow++;

        }
        for (const rowText of bottomCap) tankRows.push(rowText);
        const sprite = parse(id, {legend: drawing.legend, rows: tankRows});
        applySkin(sprite, skinName);
        return sprite;
    }

    function toImage(sprite) {
        const rgba = new Uint8ClampedArray(sprite.width * sprite.height * 4);
        for (let pixel = 0; pixel < sprite.width * sprite.height; pixel++) {
            if (!sprite.solid[pixel]) continue;
            const colour = Flatspace.Palette.ramps[RAMP_NAMES[sprite.ramp[pixel]]][sprite.tone[pixel]];
            rgba[pixel * 4] = colour[0];
            rgba[pixel * 4 + 1] = colour[1];
            rgba[pixel * 4 + 2] = colour[2];
            rgba[pixel * 4 + 3] = 255;

        }


        if (typeof ImageData !== `undefined`) return new ImageData(rgba, sprite.width, sprite.height);
        return {width: sprite.width, height: sprite.height, data: rgba};

    }

    // Here lies lighting
    // sun actually light stuff now (yipeeee)
    // the andgle at which this light occurs is calculated using mafematics (:nerd-emoji:)

    function light(sprite, sunAcross, sunAlong, sunlit, glow = 0) {

        const tilt = 0.35; // how far the sun leans towards you
        const sunLength = Math.hypot(sunAcross, sunAlong, tilt);

        const sun3DAcross = sunAcross / sunLength, sun3DAlong = sunAlong / sunLength, sun3DOut = tilt / sunLength;
        const metalRamp = rampNumber('metal');
        const orangeRamp = rampNumber('orange');
        const nozzleStartRow = Math.floor(sprite.height * 0.8); // the bottom fifth of an engine is its nozzle
        const litRamp = sprite.ramp.slice();
        const litTone = sprite.tone.slice();
        // a pixel on the edge of the sprite (next to a see-through pixel) is part of its outline
        const isSolid = (column, rowNumber) => column >= 0 && rowNumber >= 0 && column < sprite.width && rowNumber < sprite.height && sprite.solid[rowNumber * sprite.width + column] === 1;
        const isOutline = (column, rowNumber) => !(isSolid(column - 1, rowNumber) && isSolid(column + 1, rowNumber) && isSolid(column, rowNumber - 1) && isSolid(column, rowNumber + 1));

        for (let rowNumber = 0; rowNumber < sprite.height; rowNumber++) {
            for (let column = 0; column < sprite.width; column++) {
                const pixel = rowNumber * sprite.width + column;
                if (!sprite.solid[pixel]) continue;
                if (glow > 0 && rowNumber >= nozzleStartRow && sprite.tone[pixel] <= 3 && !isOutline(column, rowNumber)) {
                    // the nozzle (the dark pixels low on the engine) glows, hottest at the exit;
                    // the outline stays dark so the shape still shows
                    const heat = (rowNumber - nozzleStartRow + 1) / (sprite.height - nozzleStartRow); // just above 0 at the top of the nozzle, 1 at the exit
                    litRamp[pixel] = orangeRamp;
                    litTone[pixel] = Flatspace.clamp(1 + Math.round(heat * glow * 4), 0, toneCount(orangeRamp) - 1); // 1 and 4 set how dim and how bright it gets
                    continue;
                }

                // surface direction at a given pixel as a 3d unit vector
                const normalAcross = sprite.normalAcross[pixel] / 127, normalAlong = sprite.normalAlong[pixel] / 127;
                const normalOut = Math.sqrt(Math.max(0, 1 - normalAcross * normalAcross - normalAlong * normalAlong));

                //how much sun this pixel gets
                const facing = normalAcross * sun3DAcross + normalAlong * sun3DAlong + normalOut * sun3DOut;
                const brightness = sunlit * Math.max(0, facing);
                const brightestTone = toneCount(litRamp[pixel]) - 1;
                let newTone = litTone[pixel] + Math.round(-2 + 2 * brightness); //-2 and 3 set the contrast (min max brightness type)
                if (litRamp[pixel] === metalRamp && brightness > 0.93) newTone = brightestTone; //0.93 is like the tolerance of the shine
                litTone[pixel] = Flatspace.clamp(newTone, 0, brightestTone);
            }
        }
        return toImage({ width: sprite.width, height: sprite.height, solid: sprite.solid, ramp: litRamp, tone: litTone});
    }

    // -------- zoomed out sprites
    // basically halves the sprite at different levels of zoom
    // 4x4 -> 2x2 -> 1x1 etc

    function halve(sprite) {
        const width = Math.ceil(sprite.width / 2);
        const height = Math.ceil(sprite.height / 2);
        const half = blankSprite(sprite.id + '-half', width, height);
        const outlineRamp = new Int16Array(width * height).fill(-1);
        const outlineTone = new Uint8Array( width * height);

        const isSolid = (column, row) => column >= 0 && row >= 0 && column < sprite.width && row < sprite.height && sprite.solid[row * sprite.width + column] === 1;
        const isOutline = (column, row) => isSolid(column, row) && !(isSolid(column - 1, row) && isSolid(column + 1, row) && isSolid(column, row - 1) && isSolid(column, row + 1));
// we implement a democracy among our pixels, letting them vote for who's the most popular
        for (let row = 0; row < height; row++) {
            for (let column = 0; column < width; column++) {
                const votes = new Map();
                let pixelsInBlock = 0, solidPixels = 0, acrossTotal = 0, alongTotal = 0;
                const halfPixel = row * width + column;

                for (const [stepAcross, stepDown] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                    const sourceColumn = column * 2 + stepAcross;
                    const sourceRow = row * 2 + stepDown;
                    if (sourceColumn >= sprite.width || sourceRow >= sprite.height) continue;
                    pixelsInBlock++;
                    if (!isSolid(sourceColumn, sourceRow)) continue;

                    const pixel = sourceRow * sprite.width + sourceColumn;
                    solidPixels++;

                    const colour = sprite.ramp[pixel] *256 + sprite.tone[pixel];
                    votes.set(colour, (votes.get(colour) || 0) +1);

                    acrossTotal += sprite.normalAcross[pixel];
                    alongTotal += sprite.normalAlong[pixel];

                    const darkerOutline = outlineRamp[halfPixel] < 0 || sprite.tone[pixel] < outlineTone[halfPixel];

                    if (isOutline(sourceColumn, sourceRow) && darkerOutline) {
                        outlineRamp[halfPixel] = sprite.ramp[pixel];
                        outlineTone[halfPixel] = sprite.tone[pixel];

                    }
                }
                if (solidPixels * 2 < pixelsInBlock) continue;

                let bestColour = -1, bestVotes = 0;
                for (const [colour, count] of votes) {
                    if (count > bestVotes || (count === bestVotes && colour%256 <bestColour%256)) {
                        bestColour = colour;
                        bestVotes = count; 
                    }
                }

                half.solid[halfPixel] = 1;
                half.ramp[halfPixel] = Math.floor(bestColour/256);
                half.tone[halfPixel] = bestColour % 256;
                half.normalAcross[halfPixel] = Math.round(acrossTotal/solidPixels);
                half.normalAlong[halfPixel] = Math.round(alongTotal / solidPixels);


            }
        }

        for (let row = 0; row < height; row++) {
            for (let column = 0; column < width; column++) {
                const halfPixel = row * width + column;
                if (!half.solid[halfPixel] || outlineRamp[halfPixel] < 0) continue;
                
                const solidAt = (otherColumn, otherRow) => otherColumn >= 0 && otherRow >= 0&&otherColumn<width && otherRow < height && half.solid[otherRow*width + otherColumn] === 1;
                const onEdge = !(solidAt(column - 1, row) && solidAt(column + 1, row) && solidAt(column, row -1) && solidAt(column, row +1));

                if (onEdge) {
                    half.ramp[halfPixel] = outlineRamp[halfPixel];
                    half.tone[halfPixel] = outlineTone[halfPixel];
                }
            }
        }
        return half
    }

    

    Flatspace.Sprites = {PIXELS_PER_METRE, RAMP_NAMES, SKINS, parse, profile, tank, applySkin, toImage, light, halve };

})();
