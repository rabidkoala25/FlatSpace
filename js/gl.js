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
  const glKit = (FS.GL = {});

  glKit.supported = () => {
    try {
      return !!document.createElement('canvas').getContext('webgl2');
    } catch (error) {
      return false;
    }
  };

  function compile(webgl, type, src) {
    const shader = webgl.createShader(type);
    webgl.shaderSource(shader, src);
    webgl.compileShader(shader);
    if (!webgl.getShaderParameter(shader, webgl.COMPILE_STATUS)) {
      throw new Error(
        'Shader: ' + webgl.getShaderInfoLog(shader) + '\n' + src.split('\n').slice(0, 3).join(' '),
      );
    }
    return shader;
  }
  // A program with its uniform locations looked up by name (prog.u.uName).
  glKit.program = (webgl, vertexSource, fragmentSource, attribs) => {
    const program = webgl.createProgram();
    webgl.attachShader(program, compile(webgl, webgl.VERTEX_SHADER, vertexSource));
    webgl.attachShader(program, compile(webgl, webgl.FRAGMENT_SHADER, fragmentSource));
    attribs.forEach((attributeName, attributeIndex) =>
      webgl.bindAttribLocation(program, attributeIndex, attributeName),
    );
    webgl.linkProgram(program);
    if (!webgl.getProgramParameter(program, webgl.LINK_STATUS)) {
      throw new Error('Link: ' + webgl.getProgramInfoLog(program));
    }
    const uniforms = {};
    const uniformCount = webgl.getProgramParameter(program, webgl.ACTIVE_UNIFORMS);
    for (let uniformIndex = 0; uniformIndex < uniformCount; uniformIndex++) {
      const info = webgl.getActiveUniform(program, uniformIndex);
      const name = info.name.replace(/\[0\]$/, '');
      uniforms[name] = webgl.getUniformLocation(program, info.name);
    }
    return { p: program, u: uniforms };
  };

  // GLSL pieces shared by several shaders.
  glKit.GLSL_BAYER = `
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
    ${glKit.GLSL_BAYER}
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
    constructor(webgl, size, onReset) {
      this.gl = webgl;
      this.size = size;
      this.onReset = onReset;
      this.tex = webgl.createTexture();
      webgl.bindTexture(webgl.TEXTURE_2D, this.tex);
      webgl.texImage2D(
        webgl.TEXTURE_2D,
        0,
        webgl.RGBA8,
        size,
        size,
        0,
        webgl.RGBA,
        webgl.UNSIGNED_BYTE,
        null,
      );
      webgl.texParameteri(webgl.TEXTURE_2D, webgl.TEXTURE_MIN_FILTER, webgl.LINEAR);
      webgl.texParameteri(webgl.TEXTURE_2D, webgl.TEXTURE_MAG_FILTER, webgl.LINEAR);
      webgl.texParameteri(webgl.TEXTURE_2D, webgl.TEXTURE_WRAP_S, webgl.CLAMP_TO_EDGE);
      webgl.texParameteri(webgl.TEXTURE_2D, webgl.TEXTURE_WRAP_T, webgl.CLAMP_TO_EDGE);
      this.clear();
      this.resets = 0;
    }
    clear() {
      const webgl = this.gl;
      this.map = new Map();
      this.x = 0;
      this.y = 0;
      this.rowH = 0;
      // wipe to transparent, so padding around every sprite is clean
      webgl.bindTexture(webgl.TEXTURE_2D, this.tex);
      const blank = new Uint8Array(this.size * 64 * 4);
      for (let rowY = 0; rowY < this.size; rowY += 64) {
        webgl.texSubImage2D(
          webgl.TEXTURE_2D,
          0,
          0,
          rowY,
          this.size,
          64,
          webgl.RGBA,
          webgl.UNSIGNED_BYTE,
          blank,
        );
      }
    }
    get(key) {
      return this.map.get(key);
    }
    // Add a canvas (or ImageData) under key; returns {x, y, w, h} in texels, or null if it
    // can never fit. 2 texels of clear padding go around every sprite.
    add(key, image) {
      const webgl = this.gl;
      const padding = 2;
      const width = image.width;
      const height = image.height;
      if (width + padding * 2 > this.size || height + padding * 2 > this.size) {
        return null;
      }
      if (this.x + width + padding * 2 > this.size) {
        this.x = 0;
        this.y += this.rowH;
        this.rowH = 0;
      }
      if (this.y + height + padding * 2 > this.size) {
        this.resets++;
        if (this.onReset) {
          this.onReset();
        }
        this.clear();
      }
      const entry = { x: this.x + padding, y: this.y + padding, w: width, h: height };
      webgl.bindTexture(webgl.TEXTURE_2D, this.tex);
      webgl.pixelStorei(webgl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      webgl.texSubImage2D(webgl.TEXTURE_2D, 0, entry.x, entry.y, webgl.RGBA, webgl.UNSIGNED_BYTE, image);
      webgl.pixelStorei(webgl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      this.x += width + padding * 2;
      this.rowH = Math.max(this.rowH, height + padding * 2);
      this.map.set(key, entry);
      return entry;
    }
    used() {
      return (this.y + this.rowH) / this.size;
    }
  }

  // Sprite batcher: textured quads in device pixels, flushed in as few draws as possible.
  class Sprites {
    constructor(webgl, atlasSize = 2048) {
      this.gl = webgl;
      this.prog = glKit.program(webgl, SPRITE_VS, SPRITE_FS, ['aPos', 'aUV', 'aTint']);
      this.atlas = new Atlas(webgl, atlasSize, () => this.flush());
      this.max = 8192; // quads per draw
      this.data = new Float32Array(this.max * 4 * 8);
      this.n = 0;
      this.vao = webgl.createVertexArray();
      webgl.bindVertexArray(this.vao);
      this.vbo = webgl.createBuffer();
      webgl.bindBuffer(webgl.ARRAY_BUFFER, this.vbo);
      webgl.bufferData(webgl.ARRAY_BUFFER, this.data.byteLength, webgl.DYNAMIC_DRAW);
      const stride = 8 * 4;
      webgl.enableVertexAttribArray(0);
      webgl.vertexAttribPointer(0, 2, webgl.FLOAT, false, stride, 0);
      webgl.enableVertexAttribArray(1);
      webgl.vertexAttribPointer(1, 2, webgl.FLOAT, false, stride, 8);
      webgl.enableVertexAttribArray(2);
      webgl.vertexAttribPointer(2, 4, webgl.FLOAT, false, stride, 16);
      const indices = new Uint16Array(this.max * 6);
      for (let index = 0, vertex = 0; index < indices.length; index += 6, vertex += 4) {
        indices.set([vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3], index);
      }
      this.ibo = webgl.createBuffer();
      webgl.bindBuffer(webgl.ELEMENT_ARRAY_BUFFER, this.ibo);
      webgl.bufferData(webgl.ELEMENT_ARRAY_BUFFER, indices, webgl.STATIC_DRAW);
      webgl.bindVertexArray(null);
      this.draws = 0;
      // a solid 4×4 white block, for lines and solid pixels
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 4;
      const graphics = canvas.getContext('2d');
      graphics.fillStyle = '#fff';
      graphics.fillRect(0, 0, 4, 4);
      this.whiteCanvas = canvas;
    }
    begin(drawWidth, drawHeight) {
      this.Wd = drawWidth;
      this.Hd = drawHeight;
      this.n = 0;
    }
    white() {
      return this.atlas.get('white') || this.atlas.add('white', this.whiteCanvas);
    }
    // One quad: corners p0..p3 (device px, going round), the sprite entry e and an optional
    // sub-rectangle u0,v0,u1,v1 in texels relative to it; tint [r,g,b,a].
    quad(
      corner0,
      corner1,
      corner2,
      corner3,
      entry,
      tint,
      startU = 0,
      startV = 0,
      endU = entry.w,
      endV = entry.h,
    ) {
      if (this.n >= this.max) {
        this.flush();
      }
      const vertexData = this.data;
      let offset = this.n * 32;
      const red = tint ? tint[0] : 1;
      const green = tint ? tint[1] : 1;
      const blue = tint ? tint[2] : 1;
      const alpha = tint ? tint[3] : 1;
      const putVertex = (corner, textureU, textureV) => {
        vertexData[offset++] = corner.x;
        vertexData[offset++] = corner.y;
        vertexData[offset++] = entry.x + textureU;
        vertexData[offset++] = entry.y + textureV;
        vertexData[offset++] = red;
        vertexData[offset++] = green;
        vertexData[offset++] = blue;
        vertexData[offset++] = alpha;
      };
      putVertex(corner0, startU, startV);
      putVertex(corner1, endU, startV);
      putVertex(corner2, endU, endV);
      putVertex(corner3, startU, endV);
      this.n++;
    }
    // A sprite of e.w × e.h texels drawn so each texel is `size` device px, centred on
    // (cx, cy) in device px, turned by angle (radians, clockwise on screen), with the
    // sprite's own pixel (ox, oy) at the centre. flipX mirrors it.
    sprite(entry, centreX, centreY, size, angle, originX, originY, tint, flipX) {
      const cosScaled = Math.cos(angle) * size;
      const sinScaled = Math.sin(angle) * size;
      const cornerAt = (textureU, textureV) => {
        const localX = textureU - originX;
        const localY = textureV - originY;
        return {
          x: centreX + localX * cosScaled - localY * sinScaled,
          y: centreY + localX * sinScaled + localY * cosScaled,
        };
      };
      if (flipX) {
        this.quad(
          cornerAt(0, 0),
          cornerAt(entry.w, 0),
          cornerAt(entry.w, entry.h),
          cornerAt(0, entry.h),
          entry,
          tint,
          entry.w,
          0,
          0,
          entry.h,
        );
      } else {
        this.quad(
          cornerAt(0, 0),
          cornerAt(entry.w, 0),
          cornerAt(entry.w, entry.h),
          cornerAt(0, entry.h),
          entry,
          tint,
        );
      }
    }
    flush() {
      if (!this.n) {
        return;
      }
      const webgl = this.gl;
      webgl.useProgram(this.prog.p);
      webgl.uniform2f(this.prog.u.uView, this.Wd, this.Hd);
      webgl.uniform2f(this.prog.u.uAtlas, this.atlas.size, this.atlas.size);
      webgl.activeTexture(webgl.TEXTURE0);
      webgl.bindTexture(webgl.TEXTURE_2D, this.atlas.tex);
      webgl.uniform1i(this.prog.u.uTex, 0);
      webgl.enable(webgl.BLEND);
      webgl.blendFunc(webgl.ONE, webgl.ONE_MINUS_SRC_ALPHA);
      webgl.bindVertexArray(this.vao);
      webgl.bindBuffer(webgl.ARRAY_BUFFER, this.vbo);
      webgl.bufferSubData(webgl.ARRAY_BUFFER, 0, this.data, 0, this.n * 32);
      webgl.drawElements(webgl.TRIANGLES, this.n * 6, webgl.UNSIGNED_SHORT, 0);
      webgl.bindVertexArray(null);
      this.draws++;
      this.n = 0;
    }
  }
  glKit.Sprites = Sprites;

  // A full-screen pass: a fragment shader run over every pixel (sky, planets).
  const FULL_VS = `#version 300 es
    const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }`;
  glKit.fullscreen = (webgl, fragmentSource) => {
    const prog = glKit.program(webgl, FULL_VS, fragmentSource, []);
    const vertexArray = webgl.createVertexArray();
    prog.draw = () => {
      webgl.useProgram(prog.p);
      webgl.bindVertexArray(vertexArray);
      webgl.drawArrays(webgl.TRIANGLES, 0, 3);
      webgl.bindVertexArray(null);
    };
    return prog;
  };

  // Upload a palette ramp (list of [r,g,b] 0–255) as a vec3 uniform array, padded to n.
  glKit.rampUniform = (webgl, location, ramp, count = 8) => {
    const values = new Float32Array(count * 3);
    for (let index = 0; index < count; index++) {
      const colour = ramp[Math.min(index, ramp.length - 1)];
      values[index * 3] = colour[0] / 255;
      values[index * 3 + 1] = colour[1] / 255;
      values[index * 3 + 2] = colour[2] / 255;
    }
    webgl.uniform3fv(location, values);
  };

  // ---------- Baking: vector drawings → palette pixel art ----------
  // Draw with fn(ctx) on a canvas of w × h pixels, then snap it to the palette and to fully
  // opaque / fully clear pixels. Returns the canvas.
  glKit.bake = (width, height, draw, alphaCut) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const graphics = canvas.getContext('2d');
    draw(graphics);
    const image = graphics.getImageData(0, 0, canvas.width, canvas.height);
    FS.Palette.snapImage(image, alphaCut);
    graphics.putImageData(image, 0, 0);
    return canvas;
  };
})();
