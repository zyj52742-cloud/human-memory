/*!
 * memory-webgl.js — 记忆星图 · WebGL 渲染层
 * ---------------------------------------------------------------------------
 * 依赖：同目录 three.min.js（THREE r160 UMD）
 * 用法：
 *   var gl = new MemoryWebGL({ canvas: canvasEl });
 *   gl.resize(W, H, DPR);            // W/H 为 CSS 像素
 *   gl.render(frame);                // 由外部 RAF 每帧调用
 *   gl.dispose();                    // 页面销毁时调用
 *   gl.getInfo();                    // 可序列化的运行信息
 *
 * 本模块不注册任何 DOM 事件，也不创建 requestAnimationFrame；交互、RAF、
 * 命中测试全部由调用方（root）负责。
 *
 * 投影与旧 Canvas 版 project3 严格一致：
 *   x  = w0 - camX;  y = w1 - camY;  z = w2 - camZ;
 *   x1 = x*cosY + z*sinY;  z1 = -x*sinY + z*cosY;
 *   y2 = y*cosX - z1*sinX; z2 = y*sinX + z1*cosX;
 *   sx = W/2 + x1*fov/(fov+z2)*zoom;  sy = H/2 + y2*fov/(fov+z2)*zoom;
 * 实现：真实 PerspectiveCamera 位于 (0,0,fov)，垂直 FOV = 2*atan(H/(2*fov))，
 * camera.zoom = state.zoom；物体/轨道的相机空间坐标取 (x1, -y2, -z2)。
 * ---------------------------------------------------------------------------
 */
(function (global) {
  "use strict";

  var TAU = Math.PI * 2;
  var RAD2DEG = 180 / Math.PI;

  /* tex_atlas.js 中 13 张贴图的顺序（与素材生成顺序一致） */
  var PLANET_NAMES = [
    "jupiter", "saturn", "earth", "mars", "neptune", "moon",
    "io", "europa", "ganymede", "callisto", "mercury", "venus", "uranus"
  ];
  var FALLBACK_NAME = "glass";
  var ARCHIVED_NAME = "archived";

  /* =========================================================================
   * 小工具
   * ========================================================================= */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function h01(str) {
    var s = String(str == null ? "" : str);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 100000) / 100000;
  }

  /* 同一 project 颜色复用一组颜色，避免每帧 new Color */
  function buildColorSet(THREE, hue, tint) {
    var base = new THREE.Color(0xcfd8ff);
    try { if (hue != null) base.set(hue); } catch (e) { /* 颜色非法就用默认淡蓝 */ }
    var hsl = { h: 0, s: 0, l: 0 };
    base.getHSL(hsl);
    // 球体固有色提高饱和度（淡彩色直接做球会发灰）；光晕仍用淡彩色
    var rich = new THREE.Color().setHSL((hsl.h + 1) % 1, Math.min(1, hsl.s * 2.1), 0.56);
    var body = new THREE.Color(1, 1, 1).lerp(base, 0.22);
    var glow = base.clone();
    if (tint) { try { glow.set(tint); } catch (e) { /* 用项目色兜底 */ } }
    return { base: base, rich: rich, body: body, glow: glow };
  }

  /* =========================================================================
   * 纹理生成（全部本地，不发网络请求）
   * ========================================================================= */
  function makeDotTexture(THREE) {
    if (typeof document === "undefined") return null;
    var S = 256, c = document.createElement("canvas");
    c.width = c.height = S;
    var g = c.getContext("2d");
    var rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    rg.addColorStop(0, "rgba(255,255,255,1)");
    rg.addColorStop(0.16, "rgba(255,255,255,0.96)");
    rg.addColorStop(0.38, "rgba(255,255,255,0.42)");
    rg.addColorStop(0.66, "rgba(255,255,255,0.08)");
    rg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = rg;
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2, 0, TAU);
    g.fill();
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    return t;
  }

  /* 太阳：平滑到没有环的渐变，多层叠加也不出花瓣边 */
  function makeSunTexture(THREE) {
    if (typeof document === "undefined") return null;
    var S = 256, c = document.createElement("canvas");
    c.width = c.height = S;
    var g = c.getContext("2d");
    var rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    for (var i = 0; i <= 12; i++) {
      var t = i / 12;
      var a = Math.pow(1 - t, 3.0);
      rg.addColorStop(t, "rgba(255,255,255," + a.toFixed(3) + ")");
    }
    g.fillStyle = rg;
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2, 0, TAU);
    g.fill();
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }

  function makeFlareTexture(THREE) {
    if (typeof document === "undefined") return null;
    var S = 256, c = document.createElement("canvas");
    c.width = c.height = S;
    var g = c.getContext("2d");
    g.translate(S / 2, S / 2);
    function ray(len, wid, alpha) {
      var lg = g.createLinearGradient(-len, 0, len, 0);
      lg.addColorStop(0, "rgba(255,255,255,0)");
      lg.addColorStop(0.5, "rgba(255,255,255," + alpha + ")");
      lg.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = lg;
      g.fillRect(-len, -wid / 2, len * 2, wid);
    }
    ray(S * 0.42, 1.2, 0.90);
    g.rotate(Math.PI / 2); ray(S * 0.42, 1.2, 0.90);
    g.rotate(Math.PI / 4); ray(S * 0.30, 0.8, 0.32);
    g.rotate(Math.PI / 2); ray(S * 0.30, 0.8, 0.32);
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    return t;
  }

  /* 程序化银河：只生成一次，不每帧做全屏 CPU 噪声 */
  function makeGalaxyTexture(THREE) {
    if (typeof document === "undefined") return null;
    var W = 1024, H = 512;

    function fbmSetup(seed) {
      var p = new Uint8Array(512), perm = new Uint8Array(256);
      var s0 = seed || 1, rnd = function () { s0 = (s0 * 16807) % 2147483647; return (s0 - 1) / 2147483646; };
      for (var i = 0; i < 256; i++) perm[i] = i;
      for (var j = 255; j > 0; j--) { var k = (rnd() * (j + 1)) | 0, tt = perm[j]; perm[j] = perm[k]; perm[k] = tt; }
      for (var m = 0; m < 512; m++) p[m] = perm[m & 255];
      function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
      function lerp(a, b, t) { return a + (b - a) * t; }
      function grad(h, x, y) { var g = h & 3; return (g === 0 ? x : -x) + (g === 1 ? y : g === 2 ? -y : 0); }
      function noise(x, y) {
        var X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
        x -= Math.floor(x); y -= Math.floor(y);
        var u = fade(x), v = fade(y);
        var A = p[X] + Y, B = p[X + 1] + Y;
        return lerp(
          lerp(grad(p[A], x, y), grad(p[B], x - 1, y), u),
          lerp(grad(p[A + 1], x, y - 1), grad(p[B + 1], x - 1, y - 1), u),
          v
        );
      }
      return function (x, y) {
        var v = 0, a = 0.5, f = 1;
        for (var o = 0; o < 4; o++) { v += a * noise(x * f, y * f); f *= 2.03; a *= 0.5; }
        return v * 0.5 + 0.5;
      };
    }

    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    var g = c.getContext("2d");
    var img = g.createImageData(W, H), d = img.data;
    var nA = fbmSetup(7), nB = fbmSetup(31), nC = fbmSetup(97);

    for (var y = 0; y < H; y++) {
      var ty = y / H;
      for (var x = 0; x < W; x++) {
        var tx = x / W;
        // 一条略弯的斜带，带外压到纯黑
        var bandY = 0.47 + Math.sin(tx * TAU + 0.8) * 0.070 + Math.sin(tx * Math.PI * 5.3) * 0.020;
        var dist = Math.abs(ty - bandY) / 0.235;
        var band = Math.exp(-dist * dist * 2.9);

        var n1 = nA(tx * 7.0, ty * 4.2);
        var n2 = nB(tx * 17.0, ty * 10.0);
        var n3 = nC(tx * 3.2, ty * 2.0);

        var fibril = Math.pow(n1, 2.6) * (0.45 + 0.55 * n2);
        var bright = Math.pow(band, 1.55) * (0.12 + 1.15 * fibril) * (0.55 + 0.75 * n3);
        bright = Math.pow(Math.max(0, bright), 1.15) * 1.70;

        var dust = 1 - 0.90 * Math.exp(-Math.pow((dist - 0.55) * 3.4, 2)) * (0.45 + 0.55 * n2);

        var r = (150 * bright + 62 * bright * n3 + 3) * dust;
        var gg = (146 * bright + 56 * bright * n1 + 4) * dust;
        var b = (170 * bright + 80 * bright * n1 + 7) * dust;

        var i4 = (y * W + x) * 4;
        d[i4] = r; d[i4 + 1] = gg; d[i4 + 2] = b; d[i4 + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    return tex;
  }

  /* =========================================================================
   * Shader
   * ========================================================================= */
  var BODY_VS = [
    "attribute vec3 aOffset;",
    "attribute float aScale;",
    "attribute float aSpin;",
    "attribute vec3 aColor;",
    "attribute float aAlpha;",
    "attribute float aRim;",
    "varying vec3 vN;",
    "varying vec3 vW;",
    "varying vec2 vUv;",
    "varying vec3 vON;",
    "varying vec3 vCol;",
    "varying float vAlpha;",
    "varying float vRim;",
    "void main() {",
    "  float cs = cos(aSpin), sn = sin(aSpin);",
    "  vec3 p = vec3(cs * position.x + sn * position.z, position.y, -sn * position.x + cs * position.z);",
    "  vec3 n = vec3(cs * normal.x + sn * normal.z, normal.y, -sn * normal.x + cs * normal.z);",
    "  vec3 wp = aOffset + p * aScale;",
    "  vN = normalize(n);",
    "  vW = wp;",
    "  vUv = uv;",
    "  vON = normalize(p);",
    "  vCol = aColor;",
    "  vAlpha = aAlpha;",
    "  vRim = aRim;",
    "  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);",
    "}"
  ].join("\n");

  var BODY_FS = [
    "uniform sampler2D uMap;",
    "uniform float uHasMap;",
    "uniform vec3 uSun;",
    "uniform vec3 uCam;",
    "varying vec3 vN;",
    "varying vec3 vW;",
    "varying vec2 vUv;",
    "varying vec3 vON;",
    "varying vec3 vCol;",
    "varying float vAlpha;",
    "varying float vRim;",
    "float hash3(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }",
    "float vnoise(vec3 p) {",
    "  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);",
    "  float n000 = hash3(i);",
    "  float n100 = hash3(i + vec3(1.0, 0.0, 0.0));",
    "  float n010 = hash3(i + vec3(0.0, 1.0, 0.0));",
    "  float n110 = hash3(i + vec3(1.0, 1.0, 0.0));",
    "  float n001 = hash3(i + vec3(0.0, 0.0, 1.0));",
    "  float n101 = hash3(i + vec3(1.0, 0.0, 1.0));",
    "  float n011 = hash3(i + vec3(0.0, 1.0, 1.0));",
    "  float n111 = hash3(i + vec3(1.0, 1.0, 1.0));",
    "  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),",
    "             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);",
    "}",
    "void main() {",
    "  vec3 N = normalize(vN);",
    "  vec3 sunDir = normalize(uSun - vW);",
    "  vec3 viewDir = normalize(uCam - vW);",
    "  vec3 L = normalize(sunDir + viewDir * 0.95);",
    "  float lam = dot(N, L);",
    "  float lit = clamp((lam + 0.15) / 1.15, 0.0, 1.0);",
    "  lit = pow(lit, 1.45);",
    "  float hasMap = step(0.5, uHasMap);",
    "  vec3 alb = vec3(1.0);",
    "  if (uHasMap > 0.5) { alb = texture2D(uMap, vUv).rgb; }",
    "  float amb = mix(0.11, 0.17, hasMap);",
    "  vec3 col = vCol * alb * (amb + 1.40 * lit);",
    "  float pn = vnoise(vON * 3.2) * 0.55 + vnoise(vON * 8.5) * 0.28;",
    "  col *= mix(0.88 + 0.26 * pn, 0.96 + 0.08 * pn, hasMap);",
    "  vec3 H = normalize(L + viewDir);",
    "  float spec = pow(max(dot(N, H), 0.0), 40.0) * mix(0.85, 0.12, hasMap);",
    "  float sheen = pow(max(dot(N, H), 0.0), 5.0) * mix(0.14, 0.05, hasMap);",
    "  col += vec3(1.0, 0.98, 0.95) * (spec + sheen);",
    "  float fres = pow(1.0 - max(dot(N, viewDir), 0.0), 3.2);",
    "  col += vCol * fres * vRim * mix(1.0, 0.60, hasMap) * (0.10 + 0.90 * lit);",
    "  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));",   // 线性 → sRGB（ShaderMaterial 不自动转）
    "  gl_FragColor = vec4(col, clamp(vAlpha, 0.0, 1.0));",
    "}"
  ].join("\n");

  var HALO_VS = [
    "attribute vec3 aOffset;",
    "attribute float aSize;",
    "attribute vec3 aColor;",
    "attribute float aAlpha;",
    "varying vec2 vUv;",
    "varying vec3 vCol;",
    "varying float vAlpha;",
    "void main() {",
    "  vUv = uv;",
    "  vCol = aColor;",
    "  vAlpha = aAlpha;",
    "  vec3 wp = vec3(aOffset.xy + position.xy * aSize, aOffset.z);",
    "  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);",
    "}"
  ].join("\n");

  var HALO_FS = [
    "uniform sampler2D uMap;",
    "varying vec2 vUv;",
    "varying vec3 vCol;",
    "varying float vAlpha;",
    "void main() {",
    "  vec4 t = texture2D(uMap, vUv);",
    "  vec3 c = pow(clamp(vCol * t.rgb, 0.0, 1.0), vec3(0.4545));",
    "  gl_FragColor = vec4(c, t.a * vAlpha);",
    "}"
  ].join("\n");

  var STAR_VS = [
    "attribute float aSize;",
    "attribute vec3 aColor;",
    "attribute float aAlpha;",
    "uniform float uScale;",
    "varying vec3 vCol;",
    "varying float vAlpha;",
    "void main() {",
    "  vCol = aColor;",
    "  vAlpha = aAlpha;",
    "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
    "  gl_PointSize = aSize * uScale / max(0.001, -mv.z);",
    "  gl_Position = projectionMatrix * mv;",
    "}"
  ].join("\n");

  var STAR_FS = [
    "uniform sampler2D uMap;",
    "varying vec3 vCol;",
    "varying float vAlpha;",
    "void main() {",
    "  vec4 t = texture2D(uMap, gl_PointCoord);",
    "  float a = t.a * vAlpha;",
    "  if (a < 0.004) discard;",
    "  gl_FragColor = vec4(vCol, a);",
    "}"
  ].join("\n");

  /* =========================================================================
   * 坐标变换：与 Canvas 版 project3 逐项一致
   *   out = (x1, -y2, -z2)
   * ========================================================================= */
  function rotPoint(out, x, y, z, cX, sX, cY, sY) {
    var x1 = x * cY + z * sY;
    var z1 = -x * sY + z * cY;
    var y2 = y * cX - z1 * sX;
    var z2 = y * sX + z1 * cX;
    out[0] = x1;
    out[1] = -y2;
    out[2] = -z2;
    return z2;
  }

  /* 背景星野（一次生成，恒定不重建） */
  function makeBackdropStars(THREE, dotTex) {
    var DUST = 10000, BRIGHT = 180, N = DUST + BRIGHT;
    var pos = new Float32Array(N * 3);
    var size = new Float32Array(N);
    var col = new Float32Array(N * 3);
    var alpha = new Float32Array(N);

    for (var i = 0; i < DUST; i++) {
      var r = 900 + Math.random() * 1700;
      var th = Math.random() * TAU;
      var py;
      if (Math.random() < 0.46) {
        // 46% 聚集在一条银河带附近
        py = (Math.random() - 0.5) * 0.42 * r;
        var ring = Math.sqrt(Math.max(0, 1 - (py / r) * (py / r)));
        pos[i * 3] = r * ring * Math.cos(th);
        pos[i * 3 + 2] = r * ring * Math.sin(th);
      } else {
        var u = Math.random() * 2 - 1;
        var s = Math.sqrt(Math.max(0, 1 - u * u));
        py = r * u;
        pos[i * 3] = r * s * Math.cos(th);
        pos[i * 3 + 2] = r * s * Math.sin(th);
      }
      pos[i * 3 + 1] = py;

      var mag = Math.pow(Math.random(), 2.4);
      size[i] = 1.5 + mag * 4.2;
      alpha[i] = 0.32 + mag * 0.64;

      var t = 0.14 + mag * 0.72;
      var warm = Math.random();
      var o = i * 3;
      if (warm < 0.80) { col[o] = t * 0.94; col[o + 1] = t * 0.96; col[o + 2] = t; }
      else if (warm < 0.94) { col[o] = t; col[o + 1] = t * 0.96; col[o + 2] = t * 0.90; }
      else { col[o] = t; col[o + 1] = t * 0.84; col[o + 2] = t * 0.70; }
    }

    for (var j = 0; j < BRIGHT; j++) {
      var idx = DUST + j;
      var rr = 1500 + Math.random() * 1800;
      var t2 = Math.random() * TAU;
      var p2 = Math.acos(1 - 2 * Math.random());
      pos[idx * 3] = rr * Math.sin(p2) * Math.cos(t2);
      pos[idx * 3 + 1] = rr * Math.sin(p2) * Math.sin(t2);
      pos[idx * 3 + 2] = rr * Math.cos(p2);
      size[idx] = 4.5 + Math.random() * 4.0;
      alpha[idx] = 0.55 + Math.random() * 0.45;
      var b2 = 0.55 + Math.random() * 0.45;
      col[idx * 3] = b2 * 0.86;
      col[idx * 3 + 1] = b2 * 0.92;
      col[idx * 3 + 2] = b2;
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: dotTex },
        uScale: { value: 1250 }
      },
      vertexShader: STAR_VS,
      fragmentShader: STAR_FS,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false
    });

    var points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = -500;   // 先于星体/轨道绘制，永远在底层
    return points;
  }

  /* =========================================================================
   * MemoryWebGL
   * ========================================================================= */
  function MemoryWebGL(opts) {
    if (!(this instanceof MemoryWebGL)) return new MemoryWebGL(opts);
    opts = opts || {};

    var canvas = opts.canvas;
    if (!canvas) throw new Error("MemoryWebGL: opts.canvas 必传");
    var THREE = global.THREE;
    if (!THREE) throw new Error("MemoryWebGL: 需要先加载 three.min.js（window.THREE）");

    this.THREE = THREE;
    this.canvas = canvas;
    this.VERSION = "1.0.0";

    this.W = Math.max(1, num(opts.W, canvas.clientWidth || 1));
    this.H = Math.max(1, num(opts.H, canvas.clientHeight || 1));
    this.DPR = clamp(num(opts.DPR, global.devicePixelRatio || 1), 0.5, 4);

    this._disposed = false;
    this._clock = 0;
    this._lastNow = 0;
    this._fov = 1250;
    this._zoom = 1;
    this._colorCache = Object.create(null);
    this._spinCache = Object.create(null);
    this._ownedTextures = [];

    /* ---------- renderer ---------- */
    var renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance"
    });
    renderer.setPixelRatio(this.DPR);
    renderer.setSize(this.W, this.H, false);   // 不覆盖调用方的 CSS；DPR 明确交给 drawingBuffer
    renderer.setClearColor(0x04050b, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.autoClear = true;
    this.renderer = renderer;

    /* ---------- scene / camera ---------- */
    this.scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(45, this.W / this.H, 1, 30000);
    camera.position.set(0, 0, this._fov);
    camera.rotation.set(0, 0, 0);
    this.camera = camera;
    this.scene.add(camera);
    this._updateCamera();
    this._sized = true;

    /* ---------- 纹理 ---------- */
    this._dotTex = makeDotTexture(THREE);
    this._sunTex = makeSunTexture(THREE);
    this._flareTex = makeFlareTexture(THREE);
    this._galaxyTex = makeGalaxyTexture(THREE);
    this._ownedTextures.push(this._dotTex, this._sunTex, this._flareTex, this._galaxyTex);

    /* ---------- 背景 ---------- */
    this._initBackdrop();

    /* ---------- 中心太阳（低强度 sprite 辉光） ---------- */
    this._initSun();

    /* ---------- 轨道 ---------- */
    this._initOrbits();

    /* ---------- 星体 / 光晕 ---------- */
    this._initBodies();
    this._initHalos();

    this._tmp = {
      pos: new Float32Array(3),
      sun: new THREE.Vector3(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      n: new THREE.Vector3(),
      origin: new THREE.Vector3(),
      m: new THREE.Matrix4(),
      color: new THREE.Color()
    };
  }

  /* =========================================================================
   * 初始化
   * ========================================================================= */
  MemoryWebGL.prototype._initBackdrop = function () {
    var THREE = this.THREE;
    var fov = this._fov;

    // 背景跟着镜头走：不产生视差，也不会被镜头平移穿到星体前面
    var backdrop = new THREE.Group();
    backdrop.position.set(0, 0, fov);
    this.scene.add(backdrop);
    this._backdrop = backdrop;

    var skyMat = new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false
    });
    skyMat.map = this._galaxyTex;
    skyMat.needsUpdate = true;

    var sky = new THREE.Mesh(new THREE.SphereGeometry(6500, 48, 32), skyMat);
    sky.rotation.z = 0.5;
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    backdrop.add(sky);
    this._sky = sky;
    this._skyMat = skyMat;

    // tex_atlas.js 将来若带真实银河全景（sky 字段）则自动替换程序化银河
    var TEXLIB = global.__ATLAS_TEX__;
    if (TEXLIB && TEXLIB.sky) {
      var self = this;
      var loader = new THREE.TextureLoader();
      var tex = loader.load(TEXLIB.sky, function () {
        if (self._disposed) return;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        skyMat.map = tex;
        skyMat.needsUpdate = true;
      });
      tex.colorSpace = THREE.SRGBColorSpace;
      this._ownedTextures.push(tex);
    }

    var stars = makeBackdropStars(THREE, this._dotTex);
    stars.rotation.z = 0.5;      // 与银河带的倾斜对齐
    backdrop.add(stars);
    this._starPoints = stars;
    this._starMat = stars.material;
  };

  MemoryWebGL.prototype._initSun = function () {
    var THREE = this.THREE;
    var layers = [
      { size: 300, color: 0xffa855, opacity: 0.030 },
      { size: 110, color: 0xffc98a, opacity: 0.075 },
      { size: 46, color: 0xffe4bc, opacity: 0.140 },
      { size: 22, color: 0xfff3dd, opacity: 0.300 },
      { size: 12, color: 0xfff8ec, opacity: 0.480 }
    ];
    this._sunLayers = [];
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      var mat = new THREE.SpriteMaterial({
        map: this._sunTex,
        color: L.color,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        opacity: L.opacity,
        fog: false,
        toneMapped: false
      });
      var sp = new THREE.Sprite(mat);
      sp.scale.set(L.size, L.size, 1);
      sp.renderOrder = 5;
      sp.frustumCulled = false;
      this.scene.add(sp);
      this._sunLayers.push({ sprite: sp, base: L.opacity });
    }

    // 十字星芒 + 横向镜头光斑（都很淡，只是给中心一点天文照片的味道）
    var fm = new THREE.SpriteMaterial({
      map: this._flareTex,
      color: 0xffe9c8,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      opacity: 0.060,
      fog: false,
      toneMapped: false
    });
    var flare = new THREE.Sprite(fm);
    flare.scale.set(46, 46, 1);
    flare.renderOrder = 6;
    flare.frustumCulled = false;
    this.scene.add(flare);
    this._sunLayers.push({ sprite: flare, base: 0.060 });

    var hm = new THREE.SpriteMaterial({
      map: this._dotTex,
      color: 0xfff0dd,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      opacity: 0.085,
      fog: false,
      toneMapped: false
    });
    var halo = new THREE.Sprite(hm);
    halo.scale.set(180, 22, 1);
    halo.renderOrder = 6;
    halo.frustumCulled = false;
    this.scene.add(halo);
    this._sunLayers.push({ sprite: halo, base: 0.085 });
  };

  MemoryWebGL.prototype._initOrbits = function () {
    var THREE = this.THREE;
    var SEG = 192;
    var pts = new Float32Array(SEG * 3);
    for (var i = 0; i < SEG; i++) {
      var a = (i / SEG) * TAU;
      pts[i * 3] = Math.cos(a);
      pts[i * 3 + 1] = Math.sin(a);
      pts[i * 3 + 2] = 0;
    }
    var ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    this._ringGeo = ringGeo;

    this._diskGeo = new THREE.CircleGeometry(1, 96);
    this._rings = [];
    this._disks = [];
  };

  MemoryWebGL.prototype._makeBodyBucket = function (texture, name, tint) {
    var THREE = this.THREE;
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture || null },
        uHasMap: { value: 0.0 },
        uSun: { value: new THREE.Vector3(0, 0, 0) },
        uCam: { value: new THREE.Vector3(0, 0, this._fov) }
      },
      vertexShader: BODY_VS,
      fragmentShader: BODY_FS,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      blending: THREE.NormalBlending
    });

    var geo = new THREE.InstancedBufferGeometry();
    geo.index = this._sphere.index;
    geo.setAttribute("position", this._sphere.getAttribute("position"));
    geo.setAttribute("normal", this._sphere.getAttribute("normal"));
    geo.setAttribute("uv", this._sphere.getAttribute("uv"));
    geo.instanceCount = 0;

    var b = {
      name: name,
      tint: tint,
      material: mat,
      geo: geo,
      cap: 0,
      count: 0,
      offset: null, scale: null, spin: null, color: null, alpha: null, rim: null,
      aOffset: null, aScale: null, aSpin: null, aColor: null, aAlpha: null, aRim: null
    };

    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
    b.mesh = mesh;
    return b;
  };

  MemoryWebGL.prototype._initBodies = function () {
    var THREE = this.THREE;
    this._sphere = new THREE.SphereGeometry(1, 24, 16);
    this._buckets = [];
    this._bodyCap = 0;
    this._planetCount = 0;
    this._planetTextures = [];
    this._planetTints = [];

    var TEXLIB = global.__ATLAS_TEX__;
    var worlds = (TEXLIB && TEXLIB.worlds) ? TEXLIB.worlds : null;
    var tints = (TEXLIB && TEXLIB.tints) ? TEXLIB.tints : null;
    var self = this;
    var loader = new THREE.TextureLoader();

    if (worlds && worlds.length) {
      this._planetCount = worlds.length;
      for (var i = 0; i < worlds.length; i++) {
        (function (idx) {
          var tint = tints && tints[idx] ? tints[idx] : null;
          self._planetTints[idx] = tint;
          var name = PLANET_NAMES[idx] || ("planet-" + (idx + 1));
          var tex = null;
          if (worlds[idx]) {
            tex = loader.load(
              worlds[idx],
              function () {
                if (self._disposed) return;
                tex.colorSpace = THREE.SRGBColorSpace;
                self._planetTextures[idx] = tex;
                var b = self._buckets[idx];
                if (b) {
                  b.material.uniforms.uMap.value = tex;
                  b.material.uniforms.uHasMap.value = 1.0;
                }
              },
              undefined,
              function () { /* 单张贴图失败：保留无贴图的彩色玻璃球 */ }
            );
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = true;
            try { tex.anisotropy = Math.min(4, self.renderer.capabilities.getMaxAnisotropy()); } catch (e) { /* ignore */ }
            self._ownedTextures.push(tex);
          }
          self._buckets.push(self._makeBodyBucket(tex, name, tint));
        })(i);
      }
    }

    this._fallbackIndex = this._buckets.length;
    this._buckets.push(this._makeBodyBucket(null, FALLBACK_NAME, null));
  };

  MemoryWebGL.prototype._initHalos = function () {
    var THREE = this.THREE;
    var plane = new THREE.PlaneGeometry(1, 1);
    var geo = new THREE.InstancedBufferGeometry();
    geo.index = plane.index;
    geo.setAttribute("position", plane.getAttribute("position"));
    geo.setAttribute("uv", plane.getAttribute("uv"));
    geo.instanceCount = 0;

    var mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this._dotTex } },
      vertexShader: HALO_VS,
      fragmentShader: HALO_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false
    });

    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);

    this._halo = {
      geo: geo, mesh: mesh, material: mat,
      cap: 0, count: 0,
      offset: null, size: null, color: null, alpha: null,
      aOffset: null, aSize: null, aColor: null, aAlpha: null
    };
  };

  /* =========================================================================
   * 容量管理（重复 render 只更新数据，不重建几何）
   * ========================================================================= */
  function instAttr(THREE, arr, itemSize) {
    var a = new THREE.InstancedBufferAttribute(arr, itemSize);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  }

  MemoryWebGL.prototype._ensureBodyCapacity = function (total) {
    var need = Math.max(8, total | 0) + 6;
    if (need <= this._bodyCap) return;
    var cap = Math.max(need, Math.ceil(this._bodyCap * 1.5), 32);
    this._bodyCap = cap;
    for (var i = 0; i < this._buckets.length; i++) {
      var b = this._buckets[i];
      b.cap = cap;
      b.offset = new Float32Array(cap * 3);
      b.scale = new Float32Array(cap);
      b.spin = new Float32Array(cap);
      b.color = new Float32Array(cap * 3);
      b.alpha = new Float32Array(cap);
      b.rim = new Float32Array(cap);
      b.aOffset = instAttr(this.THREE, b.offset, 3);
      b.aScale = instAttr(this.THREE, b.scale, 1);
      b.aSpin = instAttr(this.THREE, b.spin, 1);
      b.aColor = instAttr(this.THREE, b.color, 3);
      b.aAlpha = instAttr(this.THREE, b.alpha, 1);
      b.aRim = instAttr(this.THREE, b.rim, 1);
      b.geo.setAttribute("aOffset", b.aOffset);
      b.geo.setAttribute("aScale", b.aScale);
      b.geo.setAttribute("aSpin", b.aSpin);
      b.geo.setAttribute("aColor", b.aColor);
      b.geo.setAttribute("aAlpha", b.aAlpha);
      b.geo.setAttribute("aRim", b.aRim);
    }
  };

  MemoryWebGL.prototype._ensureHaloCapacity = function (total) {
    var need = Math.max(8, total | 0) + 6;
    if (need <= this._halo.cap) return;
    var cap = Math.max(need, Math.ceil(this._halo.cap * 1.5), 32);
    var h = this._halo;
    h.cap = cap;
    h.offset = new Float32Array(cap * 3);
    h.size = new Float32Array(cap);
    h.color = new Float32Array(cap * 3);
    h.alpha = new Float32Array(cap);
    h.aOffset = instAttr(this.THREE, h.offset, 3);
    h.aSize = instAttr(this.THREE, h.size, 1);
    h.aColor = instAttr(this.THREE, h.color, 3);
    h.aAlpha = instAttr(this.THREE, h.alpha, 1);
    h.geo.setAttribute("aOffset", h.aOffset);
    h.geo.setAttribute("aSize", h.aSize);
    h.geo.setAttribute("aColor", h.aColor);
    h.geo.setAttribute("aAlpha", h.aAlpha);
  };

  MemoryWebGL.prototype._ensureOrbitCapacity = function (n) {
    var THREE = this.THREE;
    while (this._rings.length < n) {
      var i = this._rings.length;
      var lineMat = new THREE.LineBasicMaterial({
        color: 0x8ea6ff,
        transparent: true,
        opacity: 0.15,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        fog: false,
        toneMapped: false
      });
      var line = new THREE.LineLoop(this._ringGeo, lineMat);
      line.frustumCulled = false;
      line.renderOrder = 3;
      line.matrixAutoUpdate = false;
      this.scene.add(line);
      this._rings.push(line);

      var diskMat = new THREE.MeshBasicMaterial({
        color: 0x8ea6ff,
        transparent: true,
        opacity: 0.028,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        fog: false,
        toneMapped: false
      });
      var disk = new THREE.Mesh(this._diskGeo, diskMat);
      disk.frustumCulled = false;
      disk.renderOrder = 1;
      disk.matrixAutoUpdate = false;
      this.scene.add(disk);
      this._disks.push(disk);
    }
  };

  /* =========================================================================
   * 尺寸 / 相机
   * ========================================================================= */
  MemoryWebGL.prototype._updateCamera = function () {
    var cam = this.camera;
    if (!cam) return;
    cam.position.set(0, 0, this._fov);
    // 垂直 FOV 精确对应屏幕公式：W/2 + x*fov/(fov+z)*zoom
    cam.fov = 2 * Math.atan(this.H / (2 * this._fov)) * RAD2DEG;
    cam.aspect = this.W / this.H;
    cam.zoom = this._zoom;
    cam.near = 1;
    cam.far = 30000;
    cam.updateProjectionMatrix();
    if (this._backdrop) this._backdrop.position.set(0, 0, this._fov);
  };

  MemoryWebGL.prototype._ensureSize = function (W, H, DPR) {
    if (W === this.W && H === this.H && DPR === this.DPR && this._sized) return;
    this.W = W;
    this.H = H;
    this.DPR = DPR;
    this.renderer.setPixelRatio(DPR);
    this.renderer.setSize(W, H, false);
    this._updateCamera();
    this._sized = true;
  };

  MemoryWebGL.prototype.resize = function (W, H, DPR) {
    if (this._disposed) return;
    this._ensureSize(
      Math.max(1, num(W, this.W)),
      Math.max(1, num(H, this.H)),
      clamp(num(DPR, this.DPR), 0.5, 4)
    );
  };

  /* =========================================================================
   * render(frame)
   * ========================================================================= */
  MemoryWebGL.prototype.render = function (frame) {
    if (this._disposed) return;
    var THREE = this.THREE;

    frame = frame || {};
    var nodes = frame.nodes || [];
    var state = frame.state || {};

    var W = Math.max(1, num(frame.W, this.W));
    var H = Math.max(1, num(frame.H, this.H));
    var DPR = clamp(num(frame.DPR, this.DPR), 0.5, 4);
    this._ensureSize(W, H, DPR);

    var fov = num(state.fov, 1250);
    if (!(fov > 1)) fov = 1250;
    var zoom = clamp(num(state.zoom, 1), 0.02, 30);
    if (fov !== this._fov || zoom !== this._zoom) {
      this._fov = fov;
      this._zoom = zoom;
      this._updateCamera();
    }

    var rotX = num(state.rotX, -1.10);
    var rotY = num(state.rotY, 0.35);
    var camX = num(state.camX, 0);
    var camY = num(state.camY, 0);
    var camZ = num(state.camZ, 0);

    var now = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    var dt = this._lastNow ? clamp((now - this._lastNow) / 1000, 0, 0.1) : 0.016;
    this._lastNow = now;
    this._clock += state.spin === false ? 0 : dt;
    var tsec = this._clock;

    /* ---- 内部时钟只用于自转/银河慢转，不用 frame.time（单位未约定） ---- */
    if (this._sky) {
      this._sky.rotation.y = 0.35 + tsec * 0.006;
    }
    if (this._starMat) {
      // gl_PointSize 用 drawingBuffer 像素：worldSize * fov * DPR * zoom / depth
      this._starMat.uniforms.uScale.value = fov * DPR * zoom;
    }

    var cY = Math.cos(rotY), sY = Math.sin(rotY);
    var cX = Math.cos(rotX), sX = Math.sin(rotX);

    /* 相机空间原点（太阳/轨道中心） */
    var tmp = this._tmp;
    var pos = tmp.pos;
    rotPoint(pos, 0 - camX, 0 - camY, 0 - camZ, cX, sX, cY, sY);
    tmp.origin.set(pos[0], pos[1], pos[2]);

    /* ---- 太阳 ---- */
    var sunFade = state.focusStar ? 0.14 : 1.0;
    for (var si = 0; si < this._sunLayers.length; si++) {
      var SL = this._sunLayers[si];
      SL.sprite.position.set(tmp.origin.x, tmp.origin.y, tmp.origin.z);
      SL.sprite.material.opacity = SL.base * sunFade;
    }

    /* ---- 轨道 ---- */
    var groups = frame.groups || [];
    this._ensureOrbitCapacity(groups.length);
    var sel = state.selected || null;
    var selGi = (sel && isNum(sel.gi)) ? sel.gi : null;
    var groupCount = Math.max(1, groups.length);
    var ringOpacityBase = 0.095, diskOpacityBase = 0.007;
    var gi, m, aVec, bVec, nVec;

    for (gi = 0; gi < groups.length; gi++) {
      var grp = groups[gi];
      var line = this._rings[gi];
      var disk = this._disks[gi];
      if (!grp || !grp.u || !grp.v) {
        line.visible = false;
        disk.visible = false;
        continue;
      }
      var R = num(grp.R, 0);
      // 线性部分 = S*R：分别把 u、v 旋转、镜像，再乘半径
      rotPoint(pos, grp.u[0], grp.u[1], grp.u[2], cX, sX, cY, sY);
      aVec = tmp.a.set(pos[0] * R, pos[1] * R, pos[2] * R);
      rotPoint(pos, grp.v[0], grp.v[1], grp.v[2], cX, sX, cY, sY);
      bVec = tmp.b.set(pos[0] * R, pos[1] * R, pos[2] * R);
      nVec = tmp.n.crossVectors(aVec, bVec);
      if (nVec.lengthSq() < 1e-6) {
        line.visible = false;
        disk.visible = false;
        continue;
      }
      nVec.normalize();

      m = tmp.m.makeBasis(aVec, bVec, nVec);
      m.setPosition(tmp.origin);
      line.matrix.copy(m);
      line.matrixWorldNeedsUpdate = true;
      line.visible = true;
      disk.matrix.copy(m);
      disk.matrixWorldNeedsUpdate = true;
      disk.visible = true;

      var hue = 205 + (gi / groupCount) * 62;
      var dim = (selGi !== null && gi !== selGi) ? 0.34 : 1.0;
      line.material.color.setHSL(hue / 360, 0.62, 0.68);
      line.material.opacity = ringOpacityBase * dim;
      disk.material.color.setHSL(hue / 360, 0.60, 0.62);
      disk.material.opacity = diskOpacityBase * dim;
    }
    for (gi = groups.length; gi < this._rings.length; gi++) {
      this._rings[gi].visible = false;
      this._disks[gi].visible = false;
    }

    /* ---- 星体数据准备 ---- */
    var total = nodes.length + 8;
    this._ensureBodyCapacity(total);
    this._ensureHaloCapacity(total);

    for (var bi = 0; bi < this._buckets.length; bi++) this._buckets[bi].count = 0;
    var halo = this._halo;
    halo.count = 0;

    var showSubs = state.showSubs !== false;
    var hover = state.hover || null;
    var focus = state.focusStar || null;
    var worldOf = (typeof frame.worldOf === "function") ? frame.worldOf : null;
    var isIntroing = (typeof frame.isIntroing === "function") ? frame.isIntroing : null;

    // root 若已经自己按节点算好 renderAlpha（过滤/淡出），就不再叠加"非选中组变淡"，
    // 避免双重变暗；否则本渲染层按 state.selected 处理整组变淡。
    var rootFades = false;
    for (var rf = 0; rf < nodes.length; rf++) {
      var ra = nodes[rf] && nodes[rf].renderAlpha;
      if (isNum(ra) && ra < 0.995) { rootFades = true; break; }
    }

    var buckLen = this._buckets.length;
    var fallbackIndex = this._fallbackIndex;
    var planetCount = this._planetCount;
    var bodiesMax = nodes.length;

    for (var ni = 0; ni < bodiesMax; ni++) {
      var n = nodes[ni];
      if (!n) continue;

      var kind = n.kind || "main";
      var rNode = num(n.r, 6);
      var rn = clamp((rNode - 5) / 21, 0, 1);

      /* 世界半径：由 n.r 稳定映射到 4~11；卫星总览更小 */
      var worldR = 4 + rn * 7;
      if (kind === "sub") worldR = Math.max(3.2, worldR * 0.62);
      else if (kind === "gone") worldR = 3.4;

      /* 桶 / 材质名 */
      var bucketIndex;
      if (kind === "gone") {
        bucketIndex = fallbackIndex;
        n.materialName = ARCHIVED_NAME;
      } else if (planetCount > 0) {
        bucketIndex = ((isNum(n.gi) ? n.gi : 0) % planetCount + planetCount) % planetCount;
        n.materialName = this._buckets[bucketIndex] ? this._buckets[bucketIndex].name : FALLBACK_NAME;
      } else {
        bucketIndex = fallbackIndex;
        n.materialName = FALLBACK_NAME;
      }
      n.glRadius = worldR;

      /* 世界 → 相机空间 */
      var depth = 0, ps = 0;
      var useScreen = (kind === "gone" && isNum(n.px) && isNum(n.py));
      if (useScreen) {
        // 已归档星在旧 UI 里是屏幕底部的一排暗星，按屏幕坐标反推（z2=0）
        var zInv = 1 / (zoom || 1);
        pos[0] = (n.px - W * 0.5) * zInv;
        pos[1] = -(n.py - H * 0.5) * zInv;
        pos[2] = 0;
        depth = fov;
        ps = zoom;
      } else {
        var w = null;
        if (worldOf) {
          try { w = worldOf(n); } catch (e) { w = null; }
        }
        if (!w || !isNum(w[0]) || !isNum(w[1]) || !isNum(w[2])) {
          n.screenRadius = 0;
          continue;
        }
        var z2 = rotPoint(pos, w[0] - camX, w[1] - camY, w[2] - camZ, cX, sX, cY, sY);
        depth = fov + z2;
        ps = depth > 0.001 ? (fov / depth) * zoom : 0;
      }

      n.screenRadius = Math.max(0, worldR * ps);

      if (depth <= 1) continue; // 在相机后面/近裁剪面内：不画、不参与命中

      /* 可见性 / 透明度 */
      var alpha = isNum(n.renderAlpha) ? n.renderAlpha : (isNum(n.alpha) ? n.alpha : 1);
      alpha = clamp(alpha, 0, 1);
      if (n.visible === false) alpha = 0;
      if (alpha > 0 && isIntroing) {
        try { if (isIntroing(n)) alpha = 0; } catch (e) { /* ignore */ }
      }
      if (alpha > 0 && kind === "sub" && !showSubs && n !== sel && n !== hover && n !== focus) alpha = 0;
      if (alpha <= 0.004) continue;

      if (selGi !== null && !rootFades && kind !== "gone" && isNum(n.gi) && n.gi !== selGi) {
        alpha *= 0.34;
      }
      if (n === hover && alpha < 0.95) alpha = Math.min(1, alpha + 0.35);

      /* 颜色（按 hue+tint 缓存） */
      var tint = (kind === "gone") ? null : (this._buckets[bucketIndex] ? this._buckets[bucketIndex].tint : null);
      var hueKey = String(n.hue == null ? "" : n.hue) + "|" + String(tint || "") + (kind === "gone" ? "|gone" : "");
      var cs = this._colorCache[hueKey];
      if (!cs) {
        cs = buildColorSet(THREE, n.hue, tint);
        if (kind === "gone") { try { cs.glow.set("#5c6781"); } catch (e) { /* ignore */ } }
        this._colorCache[hueKey] = cs;
      }

      /* 自转参数（按 id 稳定） */
      var spinInfo = this._spinCache[n.id];
      if (!spinInfo) {
        var spd = 0.10 + h01(n.id + "spin") * 0.22;
        var dirSign = h01(n.id + "dir") > 0.5 ? 1 : -1;
        spinInfo = { speed: spd * dirSign, phase: h01(n.id + "ph") * TAU };
        this._spinCache[n.id] = spinInfo;
      }

      /* 写入球体实例 */
      var b = this._buckets[bucketIndex];
      if (!b || b.count >= b.cap) continue;
      var k = b.count * 3;
      var kk = b.count;
      b.offset[k] = pos[0];
      b.offset[k + 1] = pos[1];
      b.offset[k + 2] = pos[2];
      b.scale[kk] = worldR;
      b.spin[kk] = (tsec * spinInfo.speed + spinInfo.phase) % TAU;
      var bodyCol = (b.material.uniforms.uHasMap.value > 0.5) ? cs.body : cs.rich;
      b.color[k] = bodyCol.r;
      b.color[k + 1] = bodyCol.g;
      b.color[k + 2] = bodyCol.b;
      b.alpha[kk] = alpha;
      b.rim[kk] = 0.18 + rn * 0.22;
      b.count++;

      /* 光晕（低强度），单独一 draw call */
      if (halo.count < halo.cap) {
        var hk = halo.count * 3;
        halo.offset[hk] = pos[0];
        halo.offset[hk + 1] = pos[1];
        halo.offset[hk + 2] = pos[2];
        halo.size[halo.count] = worldR * (4.6 + rn * 0.8) * (kind === "sub" ? 1.15 : 1.0);
        halo.color[hk] = cs.glow.r;
        halo.color[hk + 1] = cs.glow.g;
        halo.color[hk + 2] = cs.glow.b;
        var glowA = kind === "gone" ? 0.05 : (0.09 + rn * 0.08);
        if (n === hover) glowA *= 1.5;
        halo.alpha[halo.count] = glowA * alpha;
        halo.count++;
      }
    }

    /* ---- 提交实例 ---- */
    for (var ci = 0; ci < buckLen; ci++) {
      var cb = this._buckets[ci];
      cb.geo.instanceCount = cb.count;
      cb.mesh.visible = cb.count > 0;
      if (cb.count > 0) {
        cb.aOffset.needsUpdate = true;
        cb.aScale.needsUpdate = true;
        cb.aSpin.needsUpdate = true;
        cb.aColor.needsUpdate = true;
        cb.aAlpha.needsUpdate = true;
        cb.aRim.needsUpdate = true;
      }
    }
    halo.geo.instanceCount = halo.count;
    halo.mesh.visible = halo.count > 0;
    if (halo.count > 0) {
      halo.aOffset.needsUpdate = true;
      halo.aSize.needsUpdate = true;
      halo.aColor.needsUpdate = true;
      halo.aAlpha.needsUpdate = true;
    }

    /* ---- 统一更新光照 uniforms（相机空间太阳位置 = tmp.origin） ---- */
    var sunV = this._tmp.sun.set(tmp.origin.x, tmp.origin.y, tmp.origin.z);
    for (var ui = 0; ui < buckLen; ui++) {
      var ub = this._buckets[ui].material.uniforms;
      ub.uSun.value.copy(sunV);
      ub.uCam.value.set(0, 0, fov);
    }

    /* ---- 真正渲染 ---- */
    this.renderer.render(this.scene, this.camera);
  };

  /* =========================================================================
   * 其他公开 API
   * ========================================================================= */
  MemoryWebGL.prototype.getInfo = function () {
    var out = {
      version: this.VERSION,
      ready: !this._disposed,
      width: this.W,
      height: this.H,
      dpr: this.DPR
    };
    if (this._disposed || !this.renderer) return out;
    try {
      var canvas = this.canvas;
      var gl = this.renderer.getContext();
      var info = this.renderer.info;
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      out.canvas = {
        width: canvas.width,
        height: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight
      };
      out.drawingBuffer = { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
      out.renderer = {
        calls: info.render.calls,
        triangles: info.render.triangles,
        points: info.render.points,
        lines: info.render.lines,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs ? info.programs.length : 0
      };
      out.gl = {
        version: String(gl.getParameter(gl.VERSION)),
        vendor: String(gl.getParameter(gl.VENDOR)),
        renderer: String(gl.getParameter(gl.RENDERER)),
        unmaskedRenderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "",
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE)
      };
      try {
        var attrs = gl.getContextAttributes();
        if (attrs) out.antialias = !!attrs.antialias;
      } catch (e) { /* ignore */ }
    } catch (e) {
      out.error = String(e && e.message ? e.message : e);
    }
    return out;
  };

  MemoryWebGL.prototype.dispose = function () {
    if (this._disposed) return;
    this._disposed = true;

    // 纹理
    var texSet = new Set();
    (this._ownedTextures || []).forEach(function (tex) { if (tex) texSet.add(tex); });
    texSet.forEach(function (tex) { try { tex.dispose(); } catch (e) { /* ignore */ } });
    this._ownedTextures = [];

    // 场景里的几何/材质
    var scene = this.scene;
    if (scene) {
      scene.traverse(function (obj) {
        if (obj.geometry && obj.geometry.dispose) {
          try { obj.geometry.dispose(); } catch (e) { /* ignore */ }
        }
        var mat = obj.material;
        if (mat) {
          var list = Array.isArray(mat) ? mat : [mat];
          for (var i = 0; i < list.length; i++) {
            try { if (list[i].dispose) list[i].dispose(); } catch (e) { /* ignore */ }
          }
        }
      });
    }

    try { this.renderer.dispose(); } catch (e) { /* ignore */ }
    this._buckets = [];
    this._rings = [];
    this._disks = [];
    this._sunLayers = [];
    this._starPoints = null;
    this._sky = null;
  };

  global.MemoryWebGL = MemoryWebGL;
})(typeof window !== "undefined" ? window : this);
