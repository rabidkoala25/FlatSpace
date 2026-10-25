// creates new sprite system and does error validation checks and stuff

// todo:
// setup (done)
// render check (done)
// pixel matching (done)

window.FS = window.FS || {};
FS.SPRITES = FS.SPRITES || {}; // the drawn sprites from art/sprites/ go here
(function () {
    const PX = 16; // pixels per metre
    
    const RAMP_NAMES = Object.keys(FS.Palette.ramps);
    const rampIndex = (name) => RAMP_NAMES.indexOf(name);
    const rampLength = (r) => FS.Palette.ramps[RAMP_NAMES[r]].length;
    const SKIN = 255;
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
        if (!rows || !rows.length) throw new Error(`sprite with id ${id} has no rows`);
        const h = rows.length;
        const w = rows[0].length;
        const s = blank(id,w,h);

        for (let y=0; y<h; y++) {
            const row = rows[y];
            if (row.length !== w) {
                throw new Error(`sprite with id ${id} was expected to have row ${y} equal ${w}, but it is ${row.length}`);

            }
            for (let x = 0; x<w; x++) {
                const ch = row[x];
                if (!(ch in def.legend)) {
                    throw new Error(`sprite with id ${id} on row ${i} uses ${ch} which isn't logged in the legend`)
                }
                const entry = def.legend[ch];
                if (entry === null) continue;
                const [name, t] = entry;
                const i = y*w+x;
                if (name === 'skin') {
                    if (t<-4 || t > 4) throw new Error (`sprite with id ${id}: skin offset ${t} is outise -4 . . . 4`);
                    s.ramp[i] = SKIN;
                    s.tone[i] = t+4;

                } else {
                    const r = rampIndex(name);
                    if (r<0) throw new Error(`sprite with id ${id}: unknown ramp '${name}'`);
                    if (t<0 || t >= rampLength(r)) throw new Error(`sprite with id ${id}: ramp '${name}' has no tone ${t}`);
                    s.ramp[i] = r;
                    s.tone[i] = t;

                }
                s.solid[i] = 1;
            }
        }
        cylinderShape(s);
        return s;
    }

    function cylinderShape(s) {
        for (let y = 0; y<s.h; y++) {
            let x=0;
            while (x<s.w) {
                if (!s.solid[y*s.w+x]) {x++; continue;}
                const left = x
                while (x<s.w && s.solid[y*s.w+x]) x++;
                const right = x-1;
                const mid = (left+right+1) / 2;
                const half = (right - left +1) / 2;
                for (let k = left; k <= right; k++) {
                    const i = y*s.w+k;
                    s.nx[i] = Math.round(FS.clamp((k+0.5 - mid) / half, -1, 1) * 127);
                    s.ny[i] = 0;

                }
            }
        }
    }

    function profile({id, len, maxHalf, halfWidthAt, ramp, tone}) {
        const w = Math.round(2*maxHalf * PS);
        const h = Math.max(1, Math.round(len * PX));
        const s = blank(id, w, h);
        const r = rampIndex(ramp);
        for (let y=0; y<h; y++){
            const v = (y+0.5) / h;
            const half = halfWidthAt(v) * PX;
            const above = halfWidthAt(Math.max(0, v-1 / h)) *PX;
            const below = halfWidthAt(Math.max(1, v+1 / h)) *PX;
            const grow = (below - above) /2;
            const tilt = gro / Math.sqrt(1+grow*grow);
            for (let x = 0; x<w; x++) {
                const dx = x+0.5 - w/2;
                if (Math.abs(dx) > half) continue;
                const i = y* w + x;
                s.solid[i] = 1;
                s.ramp[o] = r;
                s.tone[i] = tone;
                s.nx[i] = Math.round(FS.clamp(dx/half, -1, 1) *127);
                s.ny[i] = Math.round(tilt * 127);

            }
        }
        return s;
    }

    // -------- Stretchable Tanks -------

    const SKINS = {
        white: ['metal', 6],
        steel: ['metal', 4],
        foam: ['orange', 3],
        gold: ['gold', 3],
    };

    function applySkin(s, skin) {
        for (let y=0; y< s.h; y++) {
            for (let x=0; x<s.w; x++) {
                const i=y*s.w+x;
                if (s.ramp[i] !== SKIN) continue;
                let name, base;
                if (skin === 'roll') {
                    const quarter = Math.floor((x/s.w)*4);
                    [name, base] = quarter % 2 === 0 ? ['metal', 6] : ['metal', 1];

                } else {
                    [name, base] = SKINS[skin] || SKINS.white;
                }
                const r = rampIndex(name);
                s.ramp[i]=r;
                s.tone[i] = FS.clamp(base + (s.tone[i] - 4), 0, rampLength(r) -1);

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
        'tank-0.62': {top: 3, bottom: 3},
        'tank-125' : {top: 4, bottom: 4},
        'tank-188': { top: 5, bottom: 5},
        'tank-250': {top: 6, bottom: 6},
        'tank-375': {top: 8, bottom: 8},
        'tank-500': {top: 10, bottom: 10},
    };

    function tank(w, len, skin) {
        const id = TANK_ART[w];
        const def = id && FS.SPRITES[id];
        if (!def) return null;
        const caps = TANK_CAPS[id];
        const drawn = def.rows;
        const middle = drawn.slice(caps.top, drawn.length - caps.bottom);
        if (!middle.length) throw new Error(`sprite with id ${id}: its caps leave no repeatable middle rows`);
        const wanted = Math.max(1, Math.round(len*PX));
        let top = drawn.slice(0, caps.top);
        let bottom = drawn.slice(drawn.length - caps.bottom);
        if (top.length + bottom.length > wanted) {
            top = top.slice(0, Math.floor(wanted / 2));
            bottom = bottom.slice(bottom.length - matchMedia.cell(wanted / 2));

        }
        const rows = top.slice();
        let k =0;
        while (rows.length < wanted - bottom.length) {
            rows.push(middle[k % middle.length]);
            k++;

        }
        for (const row of bottom) rows.push(row);
        const s = parse(id, {legend: def.legend, rows});
        applySkin(s, skin);
        return s;
    }
    
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

    // Here lies lighting
    // sun actually light stuff now (yipeeee) 
    // the andgle at which this light occurs is calculated using mafematics (:nerd-emoji:)

    function light(s, sx, sy, shade, glow = 0) {
        
        const n = Math.hypot(sx, sy, 0.35);

        const lx = sx / n, ly = sy / n, lz = 0.35 / n;
        const metal = rampIndex('metal');
        const orange = rampIndex('orange');
        const nozzleFrom = Math.floor(s.h * 0.75);
        const ramp = s.ramp.slice();
        const tone = s.tone.slice();

        for (let y=0; y< s.h; y++) {
            for (let x = 0; x < s.w; x++) {
                const i = y* s.w + x;
                if (!s.solid[i]) continue;
                if (glow > 0 && y >= nozzleFrom) {
                    // tip of engine nozzle glows
                    ramp[i] = orange;
                    tone[i] = Math.min(rampLength(orange) - 1, 2+ Math.round(glow *3)); // change for glow brightness
                    continue;
                }

                // surface direction at a given pixel as a 3d unit vector
                const nx = s.nx[i] / 127, ny = s.ny[i] / 127;
                const nz = Math.sqrt(Math.max(0, 1-nx*nx - ny*ny));

                //how much sun this pixel gets
                const lit = shade * Math.max(0, nx * lx + ny * ly + nz * lz);
                const top = rampLength(ramp[i]) -1;
                let t = tone[i] + Math.round(-2 + 3 * lit); //-2 and 3 set the contrast (min max brightness type)
                if (ramp[i] === metal && lit > 0.93) t = top; //0.93 is like the tolerance of the shine
                tone[i] = FS.clamp(t, 0, top);
            }
        }
        return toImage({ e: s.w, h: s.h, solid: s.solid, ramp, tone});
    }

    FS.Sprites = {PX, RAMP_NAMES, SKINS, parse, profile, tank, applySkin, toImage, light };

})();