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
window.Flatspace = window.Flatspace || {};
(function () {
  const glKit = (Flatspace.WebGL = {});

  glKit.supported = () => {
    try {
      return !!document.createElement('canvas').getContext('webgl2');
    } catch (error) {
      return false;
    }
  };

  function compile(webgl, type, source) {
    const shader = webgl.createShader(type);
    webgl.shaderSource(shader, source);
    webgl.compileShader(shader);
    if (!webgl.getShaderParameter(shader, webgl.COMPILE_STATUS)) {
      throw new Error(
        'Shader: ' + webgl.getShaderInfoLog(shader) + '\n' + source.split('\n').slice(0, 3).join(' '),
      );
    }
    return shader;
  }
  // A program with its uniform locations looked up by name (program.uniforms.name).
  glKit.program = (webgl, vertexSource, fragmentSource, attributes) => {
    const program = webgl.createProgram();
    webgl.attachShader(program, compile(webgl, webgl.VERTEX_SHADER, vertexSource));
    webgl.attachShader(program, compile(webgl, webgl.FRAGMENT_SHADER, fragmentSource));
    attributes.forEach((attributeName, attributeIndex) =>
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
    return { program, uniforms };
  };

  // GLSL pieces shared by several shaders.
  glKit.GLSL_BAYER = `
    float bayer4(vec2 cell) {
      ivec2 cellInGrid = ivec2(mod(floor(cell), 4.0));
      int orderIndex = cellInGrid.y * 4 + cellInGrid.x;
      int bayerOrder[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
      return (float(bayerOrder[orderIndex]) + 0.5) / 16.0;
    }
    // Between two palette steps: solid for most of the way, dithered only near the change,
    // so gradients read as bands with a dithered seam rather than as noise.
    bool stepUp(float fraction, vec2 cell) {
      return clamp((fraction - 0.5) / 0.32 + 0.5, 0.0, 1.0) > bayer4(cell);
    }`;

  // ---------- Sprites ----------
  const SPRITE_VS = `#version 300 es
    layout(location = 0) in vec2 vertexPosition;   // device pixels
    layout(location = 1) in vec2 vertexAtlasPoint;    // atlas texels
    layout(location = 2) in vec4 vertexTint;  // rgb multiply, a = how much is drawn (dithered)
    uniform vec2 viewSize;
    out vec2 atlasPoint;
    out vec4 spriteTint;
    void main() {
      vec2 clipPosition = vertexPosition / viewSize * 2.0 - 1.0;
      gl_Position = vec4(clipPosition.x, -clipPosition.y, 0.0, 1.0);
      atlasPoint = vertexAtlasPoint;
      spriteTint = vertexTint;
    }`;
  const SPRITE_FS = `#version 300 es
    precision highp float;
    uniform sampler2D atlasTexture;
    uniform vec2 atlasSize;
    in vec2 atlasPoint;
    in vec4 spriteTint;
    out vec4 fragmentColour;
    ${glKit.GLSL_BAYER}
    void main() {
      vec2 texel = atlasPoint;
      // size of one screen pixel in texels, along each texture axis
      vec2 screenPixelSize = vec2(length(vec2(dFdx(texel.x), dFdy(texel.x))), length(vec2(dFdx(texel.y), dFdy(texel.y))));
      vec2 seam = floor(texel + 0.5);
      texel = seam + clamp((texel - seam) / max(screenPixelSize, vec2(1e-4)), -0.5, 0.5);
      vec4 colour = texture(atlasTexture, texel / atlasSize);
      // fading out by dither pattern on the art-pixel grid, not by transparency
      if (spriteTint.a < 0.999 && spriteTint.a <= bayer4(atlasPoint)) discard;
      if (colour.a < 0.004) discard;
      fragmentColour = vec4(colour.rgb * spriteTint.rgb, colour.a);
    }`;

  // Texture atlas: a shelf packer over one big texture. Sprites are baked on demand and
  // cached by key; when the atlas is full it is cleared and refilled with what's in use.
  class Atlas {
    constructor(webgl, size, onReset) {
      this.webgl = webgl;
      this.size = size;
      this.onReset = onReset;
      this.texture = webgl.createTexture();
      webgl.bindTexture(webgl.TEXTURE_2D, this.texture);
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
      const webgl = this.webgl;
      this.map = new Map();
      this.x = 0;
      this.y = 0;
      this.rowHeight = 0;
      // wipe to transparent, so padding around every sprite is clean
      webgl.bindTexture(webgl.TEXTURE_2D, this.texture);
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
    // Add a canvas (or ImageData) under key; returns {x, y, width, height} in texels, or null if it
    // can never fit. 2 texels of clear padding go around every sprite.
    add(key, image) {
      const webgl = this.webgl;
      const padding = 2;
      const width = image.width;
      const height = image.height;
      if (width + padding * 2 > this.size || height + padding * 2 > this.size) {
        return null;
      }
      if (this.x + width + padding * 2 > this.size) {
        this.x = 0;
        this.y += this.rowHeight;
        this.rowHeight = 0;
      }
      if (this.y + height + padding * 2 > this.size) {
        this.resets++;
        if (this.onReset) {
          this.onReset();
        }
        this.clear();
      }
      const entry = { x: this.x + padding, y: this.y + padding, width, height };
      webgl.bindTexture(webgl.TEXTURE_2D, this.texture);
      webgl.pixelStorei(webgl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      webgl.texSubImage2D(webgl.TEXTURE_2D, 0, entry.x, entry.y, webgl.RGBA, webgl.UNSIGNED_BYTE, image);
      webgl.pixelStorei(webgl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      this.x += width + padding * 2;
      this.rowHeight = Math.max(this.rowHeight, height + padding * 2);
      this.map.set(key, entry);
      return entry;
    }
    used() {
      return (this.y + this.rowHeight) / this.size;
    }
  }

  // Sprite batcher: textured quads in device pixels, flushed in as few draws as possible.
  class Sprites {
    constructor(webgl, atlasSize = 2048) {
      this.webgl = webgl;
      this.program = glKit.program(webgl, SPRITE_VS, SPRITE_FS, [
        'vertexPosition',
        'vertexAtlasPoint',
        'vertexTint',
      ]);
      this.atlas = new Atlas(webgl, atlasSize, () => this.flush());
      this.max = 8192; // quads per draw
      this.data = new Float32Array(this.max * 4 * 8);
      this.spriteCount = 0;
      this.vertexArray = webgl.createVertexArray();
      webgl.bindVertexArray(this.vertexArray);
      this.vertexBuffer = webgl.createBuffer();
      webgl.bindBuffer(webgl.ARRAY_BUFFER, this.vertexBuffer);
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
      this.indexBuffer = webgl.createBuffer();
      webgl.bindBuffer(webgl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
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
      this.drawWidth = drawWidth;
      this.drawHeight = drawHeight;
      this.spriteCount = 0;
    }
    white() {
      return this.atlas.get('white') || this.atlas.add('white', this.whiteCanvas);
    }
    // One quad: four corners (device px, going round), the sprite entry and an optional
    // part of it (start and end texture points, in texels); tint [red, green, blue, alpha].
    drawQuad(
      corner0,
      corner1,
      corner2,
      corner3,
      entry,
      tint,
      startU = 0,
      startV = 0,
      endU = entry.width,
      endV = entry.height,
    ) {
      if (this.spriteCount >= this.max) {
        this.flush();
      }
      const vertexData = this.data;
      let offset = this.spriteCount * 32;
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
      this.spriteCount++;
    }
    // A sprite of entry.width × entry.height texels drawn so each texel is `size` device px, centred on
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
        this.drawQuad(
          cornerAt(0, 0),
          cornerAt(entry.width, 0),
          cornerAt(entry.width, entry.height),
          cornerAt(0, entry.height),
          entry,
          tint,
          entry.width,
          0,
          0,
          entry.height,
        );
      } else {
        this.drawQuad(
          cornerAt(0, 0),
          cornerAt(entry.width, 0),
          cornerAt(entry.width, entry.height),
          cornerAt(0, entry.height),
          entry,
          tint,
        );
      }
    }
    flush() {
      if (!this.spriteCount) {
        return;
      }
      const webgl = this.webgl;
      webgl.useProgram(this.program.program);
      webgl.uniform2f(this.program.uniforms.viewSize, this.drawWidth, this.drawHeight);
      webgl.uniform2f(this.program.uniforms.atlasSize, this.atlas.size, this.atlas.size);
      webgl.activeTexture(webgl.TEXTURE0);
      webgl.bindTexture(webgl.TEXTURE_2D, this.atlas.texture);
      webgl.uniform1i(this.program.uniforms.atlasTexture, 0);
      webgl.enable(webgl.BLEND);
      webgl.blendFunc(webgl.ONE, webgl.ONE_MINUS_SRC_ALPHA);
      webgl.bindVertexArray(this.vertexArray);
      webgl.bindBuffer(webgl.ARRAY_BUFFER, this.vertexBuffer);
      webgl.bufferSubData(webgl.ARRAY_BUFFER, 0, this.data, 0, this.spriteCount * 32);
      webgl.drawElements(webgl.TRIANGLES, this.spriteCount * 6, webgl.UNSIGNED_SHORT, 0);
      webgl.bindVertexArray(null);
      this.draws++;
      this.spriteCount = 0;
    }
  }
  glKit.Sprites = Sprites;

  // A full-screen pass: a fragment shader run over every pixel (sky, planets).
  const FULL_VS = `#version 300 es
    const vec2 CORNERS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    void main() { gl_Position = vec4(CORNERS[gl_VertexID], 0.0, 1.0); }`;
  glKit.fullscreen = (webgl, fragmentSource) => {
    const program = glKit.program(webgl, FULL_VS, fragmentSource, []);
    const vertexArray = webgl.createVertexArray();
    program.draw = () => {
      webgl.useProgram(program.program);
      webgl.bindVertexArray(vertexArray);
      webgl.drawArrays(webgl.TRIANGLES, 0, 3);
      webgl.bindVertexArray(null);
    };
    return program;
  };

  // Upload a palette ramp (list of [red, green, blue], 0–255) as a vec3 uniform array, padded to count.
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
  // Draw with draw(context) on a canvas of width × height pixels, then snap it to the palette and to fully
  // opaque / fully clear pixels. Returns the canvas.
  glKit.bake = (width, height, draw, alphaCut) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const graphics = canvas.getContext('2d');
    draw(graphics);
    const image = graphics.getImageData(0, 0, canvas.width, canvas.height);
    Flatspace.Palette.snapImage(image, alphaCut);
    graphics.putImageData(image, 0, 0);
    return canvas;
  };
})();
