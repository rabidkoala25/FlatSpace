// creates new sprite system

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
            nx
        }
    }
})
