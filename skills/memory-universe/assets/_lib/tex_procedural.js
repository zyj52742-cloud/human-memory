/*
 * tex_procedural.js — 程序化行星材质（记忆星图 · 记忆宇宙技能）
 * ---------------------------------------------------------------------------
 * 用途：提供 13 个世界的程序化行星纹理，不依赖任何外部图片或 base64 贴图。
 * 本文件不包含任何外部图片、不发起网络请求，全部纹理由 canvas 在本地生成。
 *
 * 对外约定：设置 window.__ATLAS_TEX__ = { worlds: [dataURL...], procedural: true }
 * worlds 顺序与 memory-webgl.js 的 PLANET_NAMES 一致：
 *   jupiter, saturn, earth, mars, neptune, moon,
 *   io, europa, ganymede, callisto, mercury, venus, uranus
 *
 * 许可：与 human-memory 项目一致，MIT。
 */
(function (global) {
  "use strict";

  if (typeof document === "undefined") return;

  var W = 256, H = 128;

  /* 确定性 PRNG（同一台机器每次生成结果一致，便于截图复现） */
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* 值噪声 + fBm，返回 [0,1] */
  function makeNoise(seed, grid) {
    var rand = rng(seed);
    var n = grid || 8;
    var g = new Float32Array((n + 1) * (n + 1));
    for (var i = 0; i < g.length; i++) g[i] = rand();
    function at(x, y) {
      x = Math.max(0, Math.min(n, x));
      y = Math.max(0, Math.min(n, y));
      var x0 = Math.floor(x), y0 = Math.floor(y);
      var x1 = Math.min(n, x0 + 1), y1 = Math.min(n, y0 + 1);
      var fx = x - x0, fy = y - y0;
      fx = fx * fx * (3 - 2 * fx);
      fy = fy * fy * (3 - 2 * fy);
      var a = g[y0 * (n + 1) + x0], b = g[y0 * (n + 1) + x1];
      var c = g[y1 * (n + 1) + x0], d = g[y1 * (n + 1) + x1];
      return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
    }
    return function (u, v) {
      var total = 0, amp = 0.5, freq = 1, norm = 0;
      for (var o = 0; o < 4; o++) {
        total += amp * at(u * n * freq, v * n * freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      return total / norm;
    };
  }

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function mix(a, b, t) { return a + (b - a) * t; }

  /* 三色渐变：t=0 -> c0, t=0.5 -> c1, t=1 -> c2 */
  function ramp(c0, c1, c2, t) {
    t = clamp01(t);
    if (t < 0.5) {
      var k = t * 2;
      return [mix(c0[0], c1[0], k), mix(c0[1], c1[1], k), mix(c0[2], c1[2], k)];
    }
    var k2 = (t - 0.5) * 2;
    return [mix(c1[0], c2[0], k2), mix(c1[1], c2[1], k2), mix(c1[2], c2[2], k2)];
  }

  /* 经纬纹理：横向接缝处做一次 mix，避免出现一条竖线 */
  function seam(u) { return 0.5 - 0.5 * Math.cos(u * Math.PI * 2); }

  var NOISE = makeNoise(20261031, 9);
  var NOISE2 = makeNoise(52742, 17);
  var NOISE3 = makeNoise(777, 5);

  function planetTex(name, index) {
    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    var ctx = c.getContext("2d");
    var img = ctx.createImageData(W, H);
    var d = img.data;
    var rand = rng(1000 + index * 97);
    var craters = [];
    var i, x, y, u, v, t, col, n1, n2, n3;

    /* 预先撒陨石坑（岩石行星用） */
    for (i = 0; i < 26; i++) {
      craters.push([rand(), 0.15 + rand() * 0.7, 0.008 + rand() * 0.03, rand()]);
    }

    for (y = 0; y < H; y++) {
      v = y / (H - 1);
      for (x = 0; x < W; x++) {
        u = x / W;
        n1 = NOISE(u, v);
        n2 = NOISE2(u, v);
        n3 = NOISE3(u, v);

        if (name === "jupiter") {
          var band = Math.sin(v * Math.PI * 16 + n1 * 2.2) * 0.5 + 0.5;
          t = band * 0.75 + n2 * 0.25;
          col = ramp([120, 82, 50], [214, 182, 140], [244, 230, 205], t);
        } else if (name === "saturn") {
          var bandS = Math.sin(v * Math.PI * 20 + n1 * 1.6) * 0.5 + 0.5;
          t = bandS * 0.8 + n2 * 0.2;
          col = ramp([150, 120, 72], [222, 199, 146], [246, 235, 205], t);
        } else if (name === "earth") {
          var land = n1 * 0.6 + n2 * 0.4;
          var polar = Math.max(0, (Math.abs(v - 0.5) - 0.40) / 0.10);
          if (land < 0.47) {
            t = clamp01(0.25 + n2 * 0.5);
            col = ramp([10, 38, 92], [22, 78, 150], [46, 118, 186], t);
          } else {
            t = clamp01((land - 0.47) * 2.4 + n3 * 0.3);
            col = ramp([54, 84, 44], [104, 124, 62], [168, 156, 104], t);
          }
          if (polar > 0) {
            col = [mix(col[0], 240, polar), mix(col[1], 246, polar), mix(col[2], 250, polar)];
          }
          /* 云层 */
          var cloud = clamp01((NOISE2(u * 1.7, v * 1.7) - 0.55) * 3.2) * 0.55;
          col = [mix(col[0], 250, cloud), mix(col[1], 250, cloud), mix(col[2], 252, cloud)];
        } else if (name === "mars") {
          t = clamp01(n1 * 0.75 + n2 * 0.25);
          col = ramp([92, 38, 22], [168, 82, 48], [214, 136, 92], t);
          var cap = Math.max(0, (Math.abs(v - 0.5) - 0.43) / 0.07);
          col = [mix(col[0], 238, cap), mix(col[1], 240, cap), mix(col[2], 244, cap)];
        } else if (name === "neptune") {
          t = clamp01(0.35 + n1 * 0.35 + Math.sin(v * Math.PI * 9) * 0.12);
          col = ramp([24, 48, 120], [48, 96, 188], [112, 160, 230], t);
          var storm = Math.exp(-Math.pow((u - 0.66) * 8, 2) - Math.pow((v - 0.62) * 13, 2));
          col = [mix(col[0], 220, storm * 0.5), mix(col[1], 230, storm * 0.5), mix(col[2], 250, storm * 0.5)];
        } else if (name === "moon" || name === "mercury" || name === "callisto" || name === "ganymede") {
          var base = name === "moon" ? [128, 128, 126] : name === "mercury" ? [118, 112, 106] :
                     name === "callisto" ? [92, 84, 76] : [120, 110, 98];
          var hi = name === "ganymede" ? [186, 176, 158] : [176, 174, 168];
          t = clamp01(n1 * 0.65 + n2 * 0.35);
          col = ramp([base[0] * 0.55, base[1] * 0.55, base[2] * 0.55], base, hi, t);
          for (i = 0; i < craters.length; i++) {
            var cr = craters[i];
            var du = Math.abs(u - cr[0]); du = Math.min(du, 1 - du);
            var dv = v - cr[1];
            var dd = Math.sqrt(du * du + dv * dv) / cr[2];
            if (dd < 1.15) {
              var ring = dd < 0.82 ? -0.30 : (dd < 1.0 ? -0.10 : 0.16);
              ring *= (0.7 + cr[3] * 0.6);
              col = [col[0] * (1 + ring), col[1] * (1 + ring), col[2] * (1 + ring)];
            }
          }
        } else if (name === "io") {
          t = clamp01(n1 * 0.6 + n2 * 0.4);
          col = ramp([150, 96, 24], [214, 176, 48], [244, 228, 132], t);
          var spot = clamp01((NOISE2(u * 2.1, v * 2.1) - 0.62) * 4.0);
          col = [mix(col[0], 120, spot * 0.6), mix(col[1], 64, spot * 0.6), mix(col[2], 40, spot * 0.6)];
        } else if (name === "europa") {
          t = clamp01(n1 * 0.7 + n2 * 0.3);
          col = ramp([176, 186, 196], [222, 226, 224], [246, 246, 240], t);
          var crack = Math.abs(NOISE2(u * 3.4, v * 3.4) - 0.5);
          if (crack < 0.035) {
            var k = 1 - crack / 0.035;
            col = [mix(col[0], 120, k * 0.75), mix(col[1], 98, k * 0.75), mix(col[2], 84, k * 0.75)];
          }
        } else if (name === "venus") {
          t = clamp01(n1 * 0.55 + n2 * 0.45);
          col = ramp([170, 132, 72], [222, 196, 132], [246, 232, 196], t);
        } else if (name === "uranus") {
          t = clamp01(0.45 + Math.sin(v * Math.PI * 8) * 0.12 + n1 * 0.2);
          col = ramp([132, 196, 204], [168, 224, 228], [206, 240, 242], t);
        } else {
          t = clamp01(n1);
          col = ramp([90, 90, 96], [140, 140, 148], [190, 190, 198], t);
        }

        var idx = (y * W + x) * 4;
        d[idx] = Math.max(0, Math.min(255, col[0]));
        d[idx + 1] = Math.max(0, Math.min(255, col[1]));
        d[idx + 2] = Math.max(0, Math.min(255, col[2]));
        d[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    /* 横向接缝：左右各 2% 做渐变过渡 */
    var strip = ctx.getImageData(0, 0, 4, H);
    var edge = ctx.getImageData(W - 4, 0, 4, H);
    for (y = 0; y < H; y++) {
      for (x = 0; x < 4; x++) {
        var si = (y * 4 + x) * 4, ei = (y * 4 + (3 - x)) * 4;
        var a = 0.5 + 0.5 * (x / 3);
        for (var ch = 0; ch < 3; ch++) {
          strip.data[si + ch] = strip.data[si + ch] * a + edge.data[ei + ch] * (1 - a);
        }
      }
    }
    ctx.putImageData(strip, 0, 0);

    return c.toDataURL("image/png");
  }

  var NAMES = [
    "jupiter", "saturn", "earth", "mars", "neptune", "moon",
    "io", "europa", "ganymede", "callisto", "mercury", "venus", "uranus"
  ];
  var worlds = [];
  for (var i = 0; i < NAMES.length; i++) {
    try {
      worlds.push(planetTex(NAMES[i], i));
    } catch (e) {
      worlds.push("");
    }
  }

  global.__ATLAS_TEX__ = {
    worlds: worlds,
    procedural: true,
    source: "tex_procedural.js（canvas 本地生成，无外部图片）"
  };
})(typeof window !== "undefined" ? window : this);
