// gl.js — the WebGL2 groundwork shared by the game renderer and the art gallery:
// shader programs, a texture atlas for baked sprites, and a sprite batcher whose shader
// draws every art pixel as a crisp square at any angle.
//
// Sharp pixels. Textures are sampled with linear filtering, but the shader moves each
// sample to the middle of its art pixel except within one screen pixel of a pixel edge.
// So the inside of every art pixel is one flat colour, and its edges are smoothed over
// exactly one screen pixel, whatever the angle or sub-pixel position. That is what keeps
// a slowly turning rocket from shimmering, without blurring it.
//
// Colours are premultiplied by alpha throughout.
window.FS = window.FS || {};
(function () {
  const GLK = (FS.GL = {});

  GLK.supported = () => {
    try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; }
  };

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s) + '\n' + src.split('\n').slice(0, 3).join(' '));
    return s;
  }
  // A program with its uniform locations looked up by name (prog.u.uName).
  GLK.program = (gl, vs, fs, attribs) => {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    attribs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  };

  // GLSL pieces shared by several shaders.
  GLK.GLSL_BAYER = `
    float bayer4(vec2 cell) {
      ivec2 i = ivec2(mod(floor(cell), 4.0));
      int k = i.y * 4 + i.x;
      int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
      return (float(m[k]) + 0.5) / 16.0;
    }
    // Between two palette steps: solid for most of the way, dithered only near the change,
    // so gradients read as bands with a dithered seam rather than as noise.
    bool stepUp(float fr, vec2 cell) {
      return clamp((fr - 0.5) / 0.32 + 0.5, 0.0, 1.0) > bayer4(cell);
    }`;

  // ---------- Sprites ----------
  const SPRITE_VS = `#version 300 es
    layout(location = 0) in vec2 aPos;   // device pixels
    layout(location = 1) in vec2 aUV;    // atlas texels
    layout(location = 2) in vec4 aTint;  // rgb multiply, a = how much is drawn (dithered)
    uniform vec2 uView;
    out vec2 vUV;
    out vec4 vTint;
    void main() {
      vec2 c = aPos / uView * 2.0 - 1.0;
      gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
      vUV = aUV;
      vTint = aTint;
    }`;
  const SPRITE_FS = `#version 300 es
    precision highp float;
    uniform sampler2D uTex;
    uniform vec2 uAtlas;
    in vec2 vUV;
    in vec4 vTint;
    out vec4 o;
    ${GLK.GLSL_BAYER}
    void main() {
      vec2 px = vUV;
      // size of one screen pixel in texels, along each texture axis
      vec2 d = vec2(length(vec2(dFdx(px.x), dFdy(px.x))), length(vec2(dFdx(px.y), dFdy(px.y))));
      vec2 seam = floor(px + 0.5);
      px = seam + clamp((px - seam) / max(d, vec2(1e-4)), -0.5, 0.5);
      vec4 c = texture(uTex, px / uAtlas);
      // fading out by dither pattern on the art-pixel grid, not by transparency
      if (vTint.a < 0.999 && vTint.a <= bayer4(vUV)) discard;
      if (c.a < 0.004) discard;
      o = vec4(c.rgb * vTint.rgb, c.a);
    }`;

  // Texture atlas: a shelf packer over one big texture. Sprites are baked on demand and
  // cached by key; when the atlas is full it is cleared and refilled with what's in use.
  class Atlas {
    constructor(gl, size, onReset) {
      this.gl = gl;
      this.size = size;
      this.onReset = onReset;
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.clear();
      this.resets = 0;
    }
    clear() {
      const gl = this.gl;
      this.map = new Map();
      this.x = 0; this.y = 0; this.rowH = 0;
      // wipe to transparent, so padding around every sprite is clean
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      const blank = new Uint8Array(this.size * 64 * 4);
      for (let y = 0; y < this.size; y += 64) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, this.size, 64, gl.RGBA, gl.UNSIGNED_BYTE, blank);
    }
    get(key) { return this.map.get(key); }
    // Add a canvas (or ImageData) under key; returns {x, y, w, h} in texels, or null if it
    // can never fit. 2 texels of clear padding go around every sprite.
    add(key, img) {
      const gl = this.gl, pad = 2;
      const w = img.width, h = img.height;
      if (w + pad * 2 > this.size || h + pad * 2 > this.size) return null;
      if (this.x + w + pad * 2 > this.size) { this.x = 0; this.y += this.rowH; this.rowH = 0; }
      if (this.y + h + pad * 2 > this.size) {
        this.resets++;
        if (this.onReset) this.onReset();
        this.clear();
      }
      const e = { x: this.x + pad, y: this.y + pad, w, h };
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, e.x, e.y, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      this.x += w + pad * 2;
      this.rowH = Math.max(this.rowH, h + pad * 2);
      this.map.set(key, e);
      return e;
    }
    used() { return (this.y + this.rowH) / this.size; }
  }

  // Sprite batcher: textured quads in device pixels, flushed in as few draws as possible.
  class Sprites {
    constructor(gl, atlasSize = 2048) {
      this.gl = gl;
      this.prog = GLK.program(gl, SPRITE_VS, SPRITE_FS, ['aPos', 'aUV', 'aTint']);
      this.atlas = new Atlas(gl, atlasSize, () => this.flush());
      this.max = 8192; // quads per draw
      this.data = new Float32Array(this.max * 4 * 8);
      this.n = 0;
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
      const stride = 8 * 4;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
      const idx = new Uint16Array(this.max * 6);
      for (let i = 0, v = 0; i < idx.length; i += 6, v += 4) idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i);
      this.ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.draws = 0;
      // a solid 4×4 white block, for lines and solid pixels
      const c = document.createElement('canvas');
      c.width = c.height = 4;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 4, 4);
      this.whiteCanvas = c;
    }
    begin(Wd, Hd) { this.Wd = Wd; this.Hd = Hd; this.n = 0; }
    white() { return this.atlas.get('white') || this.atlas.add('white', this.whiteCanvas); }
    // One quad: corners p0..p3 (device px, going round), the sprite entry e and an optional
    // sub-rectangle u0,v0,u1,v1 in texels relative to it; tint [r,g,b,a].
    quad(p0, p1, p2, p3, e, tint, u0 = 0, v0 = 0, u1 = e.w, v1 = e.h) {
      if (this.n >= this.max) this.flush();
      const d = this.data;
      let o = this.n * 32;
      const r = tint ? tint[0] : 1, g = tint ? tint[1] : 1, b = tint ? tint[2] : 1, a = tint ? tint[3] : 1;
      const put = (p, u, v) => { d[o++] = p.x; d[o++] = p.y; d[o++] = e.x + u; d[o++] = e.y + v; d[o++] = r; d[o++] = g; d[o++] = b; d[o++] = a; };
      put(p0, u0, v0); put(p1, u1, v0); put(p2, u1, v1); put(p3, u0, v1);
      this.n++;
    }
    // A sprite of e.w × e.h texels drawn so each texel is `size` device px, centred on
    // (cx, cy) in device px, turned by angle (radians, clockwise on screen), with the
    // sprite's own pixel (ox, oy) at the centre. flipX mirrors it.
    sprite(e, cx, cy, size, angle, ox, oy, tint, flipX) {
      const c = Math.cos(angle) * size, s = Math.sin(angle) * size;
      const at = (u, v) => { const x = u - ox, y = v - oy; return { x: cx + x * c - y * s, y: cy + x * s + y * c }; };
      if (flipX) this.quad(at(0, 0), at(e.w, 0), at(e.w, e.h), at(0, e.h), e, tint, e.w, 0, 0, e.h);
      else this.quad(at(0, 0), at(e.w, 0), at(e.w, e.h), at(0, e.h), e, tint);
    }
    flush() {
      if (!this.n) return;
      const gl = this.gl;
      gl.useProgram(this.prog.p);
      gl.uniform2f(this.prog.u.uView, this.Wd, this.Hd);
      gl.uniform2f(this.prog.u.uAtlas, this.atlas.size, this.atlas.size);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas.tex);
      gl.uniform1i(this.prog.u.uTex, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.n * 32);
      gl.drawElements(gl.TRIANGLES, this.n * 6, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
      this.draws++;
      this.n = 0;
    }
  }
  GLK.Sprites = Sprites;

  // A full-screen pass: a fragment shader run over every pixel (sky, planets).
  const FULL_VS = `#version 300 es
    const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }`;
  GLK.fullscreen = (gl, fs) => {
    const prog = GLK.program(gl, FULL_VS, fs, []);
    const vao = gl.createVertexArray();
    prog.draw = () => {
      gl.useProgram(prog.p);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    };
    return prog;
  };

  // Upload a palette ramp (list of [r,g,b] 0–255) as a vec3 uniform array, padded to n.
  GLK.rampUniform = (gl, loc, ramp, n = 8) => {
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const c = ramp[Math.min(i, ramp.length - 1)];
      a[i * 3] = c[0] / 255; a[i * 3 + 1] = c[1] / 255; a[i * 3 + 2] = c[2] / 255;
    }
    gl.uniform3fv(loc, a);
  };

  // ---------- Baking: vector drawings → palette pixel art ----------
  // Draw with fn(ctx) on a canvas of w × h pixels, then snap it to the palette and to fully
  // opaque / fully clear pixels. Returns the canvas.
  GLK.bake = (w, h, fn, alphaCut) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    const g = c.getContext('2d');
    fn(g);
    const img = g.getImageData(0, 0, c.width, c.height);
    FS.Palette.snapImage(img, alphaCut);
    g.putImageData(img, 0, 0);
    return c;
  };
})();
