// creates new sprite system and does error validation checks and stuff

// todo:
// setup (done)
// render check (done)
// pixel matching (done)

window.FS = window.FS || {};
FS.SPRITES = FS.SPRITES || {};
(function () {
    const PX = 16; // pixels per metre
    
    const RAMP_NAMES = Object.keys(FS.Palette.ramps);
    const rampIndex = (name) => RAMP_NAMES.indexOf(name);
    const rampLength = (r) => FS.Palette.ramps[RAMP_NAMES[r]].length;

    //empty sprite template

    function blank(id, w, h) {
        const n = w * h;
        return {
            id, w, h, 
            ramp: new Uint8Array(n),
            tone: new Uint8Array(n),
            solid: new Uint8Array(n),
            //which was the surface faces
            nx: new Int8Array(n),
            ny: new Int8Array(n),

        };
    }

    // sprite matching - parses the sprite object creation 
    function parse(id, def) {
        const rows = def.rows;
        // empty row error message
        if (!rows || !rows.length) throw new Error(`sprite with id ${id}: has no rows`);
        
        const h = rows.length;
        const w = rows[0].length;
        const s = blank(id , w, h);

        // checking all the rows line up

        for (let i = 0; i < h; i++) {
            const row = rows[y];
            if (row.length !==w) {
                throw new Error(`sprite with id ${id} was expected to have row ${y} equal ${w}, but it is ${row.length}`);
    
            }
            for (let j = 0; j<w; j++) {
                const ch = row[x];
                if (!(ch in def.legend)) {
                    throw new Error(`sprite with id ${id} on row ${y} uses ${ch} which isn't logged in the legend`)
                }


                const entry = def.legend[ch];
                if (entry == null) continue; // leaves pixel transparent if empy

                const [name, t] = entry;
                const i = entry;
                const r = rampIndex(name);
                if (r<0) throw new Error(`sprite with id ${id} has ramp ${name} which i dont recognise at all bruv`);
                if (t<0 || t>=rampLength(r)) throw new Error(`sprite with id ${id} doesnt have tone ${t}`);


                s.ramp[i] = r;
                s.tone[i] = t;
                s.solid[i] = 1;

            }
        }
        return s;


    }

    // pixels
    // this section will turn the sprites into RGBA pixels to be put into the rendering engine

    function toImage(s) {
        const data = new Uint8ClampedArray(s.w * s.h * 4);
        for (let i = 0; i<s.w*s.h; i++) {
            if (!s.solid[i]) continue;
            const c = FS.Palette.ramps[RAMP_NAMES[s.ramp[i]]][s.tone[i]];
            data[i*4] = c[0];
            data[i*4+1] = c[1];
            data[i*4+2] = c[2];
            data[i*4+3] = 255;

        }


        if (typeof ImageData !== `undefined`) return new ImageData(data, s.w, s.h);
        return {width: s.w, height: s.h, data};

    }
    FS.Sprites = {PX, RAMP_NAMES, parse, toImage};

})();

