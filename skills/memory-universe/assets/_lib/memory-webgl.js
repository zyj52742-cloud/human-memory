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
 * frame.groups[gi].curve（可选）：
 *   世界坐标扁平数组（Float32Array 或普通 Array，xyz 三元组，至少 2 点），
 *   表示一条开放的连续曲线。renderer 用 THREE.Line 绘制并替代该组圆环，
 *   每帧只读取、不要求调用方新建数组；曲线无效时自动回退到 u/v/R 圆环。
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
   * 天体类型（对外公开；MemoryWebGL.BODY_TYPES / 实例 getBodyCatalog()）
   * planet 沿用 tex_atlas 的 13 张经典行星贴图，其余 7 类为本地程序贴图。
   * ========================================================================= */
  var BODY_TYPES = [
    { id: "planet", label: "经典行星", description: "原有十三种行星表面，按对话固定分配" },
    { id: "ringed", label: "带环行星", description: "倾斜星环，环带前后与星球本体正确穿插" },
    { id: "ice", label: "冰封星球", description: "冰裂纹、极冠与淡蓝霜面" },
    { id: "lava", label: "熔岩星球", description: "黑岩基底与橙红裂纹，轻自发光" },
    { id: "ocean", label: "海洋星球", description: "深蓝海面、小岛与云系" },
    { id: "star", label: "恒星", description: "暖白橙自发光，光晕克制不糊" },
    { id: "asteroid", label: "小行星", description: "不规则岩质轮廓，和圆球明显不同" },
    { id: "comet", label: "彗星", description: "冰岩核心与背向中心太阳的克制尾迹" }
  ];
  var BODY_TYPE_IDS = Object.create(null);
  var BODY_TYPE_LABEL = Object.create(null);
  (function () {
    for (var i = 0; i < BODY_TYPES.length; i++) {
      BODY_TYPE_IDS[BODY_TYPES[i].id] = true;
      BODY_TYPE_LABEL[BODY_TYPES[i].id] = BODY_TYPES[i].label;
    }
  })();
  /* mixed 主题下 planet 之外的 7 类（顺序固定，保证同 id 稳定） */
  var BODY_TYPE_MIX = ["ringed", "ice", "lava", "ocean", "star", "asteroid", "comet"];
  var PLANET_SHARE = 0.45;

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

  /* =========================================================================
   * 程序化银河（离线 Canvas，一次生成、全场景共享；不发网络请求）
   * 结构：
   *   1. 512x256 低频底图：斜向弯曲银河带 + 两条偏心旋臂 + 暗尘 + 大尺度疏密
   *   2. 2048x1024 上层：星尘细纹、暗尘裂隙、蓝紫亮云、少量暖金亮云、亮星
   *   3. 四周压暗，贴图边缘接近纯黑，天幕裁切/放大时不露边
   * 亮度刻意压低：银河带最亮处也低于星体本体，文字/小行星仍清楚。
   * ========================================================================= */
  function makeGalaxyTexture(THREE) {
    if (typeof document === "undefined") return null;
    var W = 2048, H = 1024;
    var LW = 512, LH = 256;
    var TILT = 0.50;                                   // 与背景星野 rotation.z 对齐（约 28.6°）
    var SLOPE = Math.tan(TILT) * (W / H);              // 纹理坐标中的带宽斜率

    var rnd = texRng(20261102);
    function rndBetween(a, b) { return a + (b - a) * rnd(); }
    function gauss() {
      var u = 0, v = 0;
      while (u === 0) u = rnd();
      while (v === 0) v = rnd();
      return clamp(Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v), -3.2, 3.2);
    }

    // 银河带中心线：斜向 + 缓慢 S 形弯曲（canvas 里向右上抬）
    function bandV(u) {
      var t = u - 0.5;
      return 0.5 - SLOPE * t
        + 0.060 * Math.sin(t * 3.0 + 0.2)
        + 0.022 * Math.sin(t * 7.6 - 1.2)
        + 0.009 * Math.sin(t * 15.2 + 2.1);
    }
    function bandWidth(u) {
      return 0.076
        + 0.024 * Math.sin(u * 6.4 + 1.3)
        + 0.012 * Math.sin(u * 15.0 - 0.4)
        + 0.020 * Math.max(0, Math.sin(u * 2.7 + 0.2));
    }

    function makeNoise(seed) {
      var s = seed || 1;
      function rr() { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }
      var p = new Uint8Array(256), perm = new Uint8Array(512);
      for (var i = 0; i < 256; i++) p[i] = i;
      for (var j = 255; j > 0; j--) { var k = (rr() * (j + 1)) | 0, tt = p[j]; p[j] = p[k]; p[k] = tt; }
      for (var m = 0; m < 512; m++) perm[m] = p[m & 255];
      function fade(t) { return t * t * (3 - 2 * t); }
      function grad(h, x, y) { var g = h & 3; return (g === 0 ? x : g === 1 ? -x : g === 2 ? y : -y); }
      function noise(x, y) {
        var X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
        x -= Math.floor(x); y -= Math.floor(y);
        var u = fade(x), v = fade(y);
        var A = perm[X] + Y, B = perm[X + 1] + Y;
        var n00 = grad(perm[A], x, y), n10 = grad(perm[B], x - 1, y);
        var n01 = grad(perm[A + 1], x, y - 1), n11 = grad(perm[B + 1], x - 1, y - 1);
        var nx0 = n00 + (n10 - n00) * u;
        var nx1 = n01 + (n11 - n01) * u;
        return nx0 + (nx1 - nx0) * v;
      }
      return function (x, y) {
        var v = 0, a = 0.5, f = 1;
        for (var o = 0; o < 4; o++) { v += a * noise(x * f, y * f); f *= 2.07; a *= 0.5; }
        return v * 0.5 + 0.5;
      };
    }
    var nA = makeNoise(7), nB = makeNoise(31), nC = makeNoise(97);

    /* ---- 1. 低频底图 ---- */
    var low = document.createElement("canvas");
    low.width = LW; low.height = LH;
    var lg = low.getContext("2d");
    var img = lg.createImageData(LW, LH), dd = img.data;

    for (var y = 0; y < LH; y++) {
      var v = y / (LH - 1);
      for (var x = 0; x < LW; x++) {
        var u = x / (LW - 1);
        var vc = bandV(u);
        var d = v - vc;
        var aw = bandWidth(u);

        var band = Math.exp(-(d * d) / (2 * aw * aw));
        var halo = Math.exp(-(d * d) / (2 * (aw * 2.5) * (aw * 2.5)));
        var core = Math.exp(-(d * d) / (2 * 0.019 * 0.019));
        var dA = d - 0.115 - 0.028 * Math.sin(u * 5.3);
        var dB = d + 0.165 + 0.032 * Math.sin(u * 4.1 + 2.0);
        var armA = Math.exp(-(dA * dA) / (2 * 0.036 * 0.036));
        var armB = Math.exp(-(dB * dB) / (2 * 0.050 * 0.050));

        var na = nA(u * 6.6 + 11.0, v * 6.6);
        var nb = nB(u * 18.0 + 3.0, v * 18.0);
        var nc = nC(u * 2.9, v * 2.9);

        var fil = Math.pow(clamp(na * 1.45 - 0.22, 0, 1), 1.55);
        var dust = Math.exp(-Math.pow((d + 0.045) / 0.040, 2)) * (0.35 + 0.65 * nb);
        var bright = 0.030
          + halo * 0.150
          + band * (0.20 + 0.72 * fil)
          + core * (0.22 + 0.30 * fil)
          + armA * 0.150 * (0.40 + 0.60 * nb)
          + armB * 0.105 * (0.30 + 0.70 * na);
        bright *= (0.52 + 0.48 * nc);          // 大尺度疏密，不是均匀噪点
        bright *= (1 - 0.48 * dust);           // 暗尘裂隙
        bright += Math.exp(-(d * d) / (2 * 0.42 * 0.42)) * 0.045 * (0.35 + 0.65 * nc);

        // 蓝紫为底，只有噪声峰值的极少区域偏暖金
        var warm = clamp((nc - 0.63) * 2.2, 0, 1) * band;
        var r = 66 * bright + 40 * warm * bright + 3;
        var gg = 70 * bright + 18 * warm * bright + 4;
        var bb = 96 * bright - 16 * warm * bright + 10;

        var i4 = (y * LW + x) * 4;
        dd[i4] = r; dd[i4 + 1] = gg; dd[i4 + 2] = bb; dd[i4 + 3] = 255;
      }
    }
    lg.putImageData(img, 0, 0);

    /* ---- 2. 主画布：低频底图放大 + 全分辨率细节 ---- */
    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    var g = c.getContext("2d");
    g.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in g) g.imageSmoothingQuality = "high";
    g.drawImage(low, 0, 0, W, H);

    function px(u) { return u * W; }
    function py(vv) { return vv * H; }
    function inCanvas(vv) { return vv > 0.015 && vv < 0.985; }

    // 2.1 蓝紫软云：大团柔光 + 沿带拉长的云丝，形成层次而不是均匀亮带
    g.globalCompositeOperation = "lighter";
    for (var ci = 0; ci < 26; ci++) {
      var cu = rndBetween(0.03, 0.97);
      var cv = bandV(cu) + gauss() * 0.055;
      var cr = rndBetween(70, 210) * (0.8 + 0.5 * Math.sin(cu * 9.0));
      var ca = rndBetween(0.022, 0.062);
      var cg = g.createRadialGradient(px(cu), py(cv), 0, px(cu), py(cv), cr);
      cg.addColorStop(0, "rgba(120,138,214," + ca.toFixed(3) + ")");
      cg.addColorStop(0.55, "rgba(86,102,180," + (ca * 0.55).toFixed(3) + ")");
      cg.addColorStop(1, "rgba(40,52,110,0)");
      g.fillStyle = cg;
      g.beginPath(); g.arc(px(cu), py(cv), cr, 0, TAU); g.fill();
    }
    // 拉长的软云丝：只加“云感”，不增加清晰线条
    for (var ei = 0; ei < 18; ei++) {
      var eu = rndBetween(0.04, 0.96);
      var ev = bandV(eu) + gauss() * 0.045;
      var erx = rndBetween(90, 260);
      var ery = Math.max(14, erx * rndBetween(0.16, 0.36));
      var ea = rndBetween(0.010, 0.026);
      g.save();
      g.translate(px(eu), py(ev));
      g.rotate(-TILT + rndBetween(-0.16, 0.16));
      g.scale(erx, ery);
      var elg = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      elg.addColorStop(0, "rgba(112,130,208," + ea.toFixed(3) + ")");
      elg.addColorStop(0.55, "rgba(82,98,172," + (ea * 0.5).toFixed(3) + ")");
      elg.addColorStop(1, "rgba(44,56,112,0)");
      g.fillStyle = elg;
      g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill();
      g.restore();
    }

    // 2.2 极少暖金亮云：只落在带核附近，面积小、亮度低
    for (var wi = 0; wi < 3; wi++) {
      var wu = rndBetween(0.15, 0.85);
      var wv = bandV(wu) + gauss() * 0.020;
      var wr = rndBetween(45, 115);
      var wa = rndBetween(0.018, 0.040);
      var wg = g.createRadialGradient(px(wu), py(wv), 0, px(wu), py(wv), wr);
      wg.addColorStop(0, "rgba(222,186,130," + wa.toFixed(3) + ")");
      wg.addColorStop(0.6, "rgba(180,142,92," + (wa * 0.5).toFixed(3) + ")");
      wg.addColorStop(1, "rgba(120,90,50,0)");
      g.fillStyle = wg;
      g.beginPath(); g.arc(px(wu), py(wv), wr, 0, TAU); g.fill();
    }
    g.globalCompositeOperation = "source-over";

    // 2.3 暗尘：细碎裂隙 + 更大的软暗云，压出层次
    for (var di = 0; di < 30; di++) {
      var du = rndBetween(0.04, 0.96);
      var dv = bandV(du) + gauss() * 0.045;
      var drx = rndBetween(30, 150);
      var dry = drx * rndBetween(0.10, 0.28);
      var drot = -TILT + rndBetween(-0.55, 0.55);
      var da = rndBetween(0.09, 0.26);
      g.save();
      g.translate(px(du), py(dv));
      g.rotate(drot);
      g.scale(drx, Math.max(6, dry));
      var dg = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      dg.addColorStop(0, "rgba(2,3,8," + da.toFixed(3) + ")");
      dg.addColorStop(0.65, "rgba(2,3,8," + (da * 0.6).toFixed(3) + ")");
      dg.addColorStop(1, "rgba(2,3,8,0)");
      g.fillStyle = dg;
      g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill();
      g.restore();
    }
    // 更大的软暗云：压暗整片区域，避免银河带变成一条均匀亮带
    for (var dgi = 0; dgi < 14; dgi++) {
      var gu = rndBetween(0.05, 0.95);
      var gv = bandV(gu) + gauss() * 0.055;
      var grx = rndBetween(100, 300);
      var gry = Math.max(18, grx * rndBetween(0.12, 0.30));
      var grot = -TILT + rndBetween(-0.30, 0.30);
      var ga = rndBetween(0.045, 0.10);
      g.save();
      g.translate(px(gu), py(gv));
      g.rotate(grot);
      g.scale(grx, gry);
      var gg2 = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      gg2.addColorStop(0, "rgba(2,3,8," + ga.toFixed(3) + ")");
      gg2.addColorStop(0.6, "rgba(2,3,8," + (ga * 0.55).toFixed(3) + ")");
      gg2.addColorStop(1, "rgba(2,3,8,0)");
      g.fillStyle = gg2;
      g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill();
      g.restore();
    }

    // 2.4 柔和星尘纤维：平滑贝塞尔 + 低透明度，取代原来的直线段；
    //     宽/细两层叠出云丝感，避免背景出现类似数据关系线的清晰网络。
    g.globalCompositeOperation = "lighter";
    g.lineCap = "round";
    for (var fi = 0; fi < 44; fi++) {
      var fu = rndBetween(0.02, 0.94);
      var fspan = rndBetween(0.05, 0.22);
      var foff = gauss() * rndBetween(0.02, 0.095);
      var fu1 = fu + fspan;
      var fv0 = bandV(fu) + foff;
      var fv1 = bandV(fu1) + foff * rndBetween(0.50, 0.90);
      var c1u = fu + fspan * 0.34, c2u = fu + fspan * 0.67;
      var c1v = bandV(c1u) + foff * 0.90 + gauss() * 0.010;
      var c2v = bandV(c2u) + foff * 0.80 + gauss() * 0.010;
      var falpha = rndBetween(0.008, 0.026);
      var fw = rndBetween(0.7, 1.5);
      g.beginPath();
      g.moveTo(px(fu), py(fv0));
      g.bezierCurveTo(px(c1u), py(c1v), px(c2u), py(c2v), px(fu1), py(fv1));
      g.lineWidth = fw * 3.2;
      g.strokeStyle = "rgba(128,148,222," + (falpha * 0.28).toFixed(4) + ")";
      g.stroke();
      g.lineWidth = fw;
      g.strokeStyle = "rgba(150,170,236," + falpha.toFixed(4) + ")";
      g.stroke();
    }
    g.globalCompositeOperation = "source-over";

    // 2.5 星尘：大部分聚在带里，少量散到带外；保留但整体压暗一档
    var DUST = 2800;
    for (var si = 0; si < DUST; si++) {
      var su = rnd();
      var spread = rnd() < 0.78 ? rndBetween(0.012, 0.075) : rndBetween(0.075, 0.24);
      var sv = bandV(su) + gauss() * spread;
      if (!inCanvas(sv)) continue;
      var mag = Math.pow(rnd(), 2.5);
      var ssize = 0.5 + mag * 1.5;
      var salpha = 0.08 + mag * 0.42;
      var kind = rnd();
      var sr, sg, sb;
      if (kind < 0.75) { sr = 205; sg = 214; sb = 255; }        // 蓝白
      else if (kind < 0.96) { sr = 178; sg = 190; sb = 246; }   // 蓝紫
      else { sr = 255; sg = 226; sb = 188; }                     // 暖金（4%）
      g.fillStyle = "rgba(" + sr + "," + sg + "," + sb + "," + salpha.toFixed(3) + ")";
      g.fillRect(px(su), py(sv), ssize, ssize);
    }

    // 2.6 少量亮星：给银河带几个视觉锚点，但不抢星体
    g.globalCompositeOperation = "lighter";
    for (var bi = 0; bi < 44; bi++) {
      var bu = rnd();
      var bv = bandV(bu) + gauss() * (rnd() < 0.8 ? 0.05 : 0.19);
      if (!inCanvas(bv)) continue;
      var br = rndBetween(2.2, 5.0);
      var ba = rndBetween(0.12, 0.38);
      var bg = g.createRadialGradient(px(bu), py(bv), 0, px(bu), py(bv), br);
      bg.addColorStop(0, "rgba(255,250,240," + ba.toFixed(3) + ")");
      bg.addColorStop(0.35, "rgba(210,220,255," + (ba * 0.45).toFixed(3) + ")");
      bg.addColorStop(1, "rgba(160,180,255,0)");
      g.fillStyle = bg;
      g.beginPath(); g.arc(px(bu), py(bv), br, 0, TAU); g.fill();
    }

    // 2.7 稀疏远景星：只做很淡的点缀，不铺均匀噪点
    for (var qi = 0; qi < 220; qi++) {
      var qu = rnd(), qv = rnd();
      if (Math.abs(qv - bandV(qu)) < 0.16) continue;
      var qa = rndBetween(0.025, 0.10);
      g.fillStyle = "rgba(190,202,255," + qa.toFixed(3) + ")";
      g.fillRect(px(qu), py(qv), 1, 1);
    }
    g.globalCompositeOperation = "source-over";

    // 2.8 收边：四周压暗 + 轻微暗角，贴图边缘接近纯黑
    var vig = g.createRadialGradient(W * 0.5, H * 0.5, H * 0.46, W * 0.5, H * 0.5, H * 0.95);
    vig.addColorStop(0, "rgba(1,2,7,0)");
    vig.addColorStop(0.55, "rgba(1,2,7,0.10)");
    vig.addColorStop(1, "rgba(1,2,7,0.55)");
    g.fillStyle = vig;
    g.fillRect(0, 0, W, H);

    var edge = Math.round(Math.min(W, H) * 0.045), eg;
    eg = g.createLinearGradient(0, 0, edge, 0);
    eg.addColorStop(0, "rgba(1,2,7,1)"); eg.addColorStop(1, "rgba(1,2,7,0)");
    g.fillStyle = eg; g.fillRect(0, 0, edge, H);
    eg = g.createLinearGradient(W, 0, W - edge, 0);
    eg.addColorStop(0, "rgba(1,2,7,1)"); eg.addColorStop(1, "rgba(1,2,7,0)");
    g.fillStyle = eg; g.fillRect(W - edge, 0, edge, H);
    eg = g.createLinearGradient(0, 0, 0, edge);
    eg.addColorStop(0, "rgba(1,2,7,1)"); eg.addColorStop(1, "rgba(1,2,7,0)");
    g.fillStyle = eg; g.fillRect(0, 0, W, edge);
    eg = g.createLinearGradient(0, H, 0, H - edge);
    eg.addColorStop(0, "rgba(1,2,7,1)"); eg.addColorStop(1, "rgba(1,2,7,0)");
    g.fillStyle = eg; g.fillRect(0, H - edge, W, edge);

    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    return tex;
  }

  /* =========================================================================
   * 天体类型程序贴图（本地 Canvas，一次生成、多实例共享；离线不发请求）
   * 分辨率与 tex_atlas 的球体贴图同为 2:1，避免拉伸。
   * ========================================================================= */
  function texRng(seed) {
    var s = seed || 1;
    return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  }

  function newAtlasCanvas() {
    if (typeof document === "undefined") return null;
    var c = document.createElement("canvas");
    c.width = 512; c.height = 256;
    var g = c.getContext("2d");
    if (!g) return null;
    return { c: c, g: g };
  }

  function finishAtlas(THREE, c) {
    if (!c) return null;
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }

  /* 不依赖 ctx.ellipse（老版浏览器可能没有），用 transform + arc 画椭圆 */
  function ellipsePath(g, x, y, rx, ry, rot) {
    g.save();
    g.translate(x, y);
    if (rot) g.rotate(rot);
    g.scale(Math.max(0.0001, rx), Math.max(0.0001, ry));
    g.beginPath();
    g.arc(0, 0, 1, 0, TAU);
    g.restore();
  }

  function paintIce(g, W, H) {
    var r = texRng(1207);
    var lg = g.createLinearGradient(0, 0, 0, H);
    lg.addColorStop(0, "#f4f9ff");
    lg.addColorStop(0.26, "#cfe4f4");
    lg.addColorStop(0.5, "#9cc3e2");
    lg.addColorStop(0.74, "#cfe4f4");
    lg.addColorStop(1, "#f4f9ff");
    g.fillStyle = lg;
    g.fillRect(0, 0, W, H);
    // 霜面斑驳
    for (var i = 0; i < 240; i++) {
      g.globalAlpha = 0.05 + r() * 0.07;
      g.fillStyle = r() < 0.5 ? "#ffffff" : "#8fb8d8";
      ellipsePath(g, r() * W, r() * H, 6 + r() * 34, 4 + r() * 22, r() * TAU);
      g.fill();
    }
    g.globalAlpha = 1;
    // 冰裂：暗缝 + 亮脊
    for (var pass = 0; pass < 2; pass++) {
      g.lineWidth = pass === 0 ? 2.4 : 1.1;
      g.strokeStyle = pass === 0 ? "rgba(58,96,140,0.55)" : "rgba(255,255,255,0.75)";
      g.lineCap = "round";
      for (var k = 0; k < 46; k++) {
        var x0 = r() * W, y0 = r() * H, ang = r() * TAU;
        g.beginPath();
        g.moveTo(x0, y0);
        var steps = 6 + ((r() * 8) | 0);
        for (var s = 0; s < steps; s++) {
          ang += (r() - 0.5) * 1.1;
          x0 += Math.cos(ang) * (8 + r() * 22);
          y0 += Math.sin(ang) * (8 + r() * 22);
          g.lineTo(x0, y0);
        }
        g.stroke();
      }
    }
    // 极冠
    var cap = g.createLinearGradient(0, 0, 0, H * 0.16);
    cap.addColorStop(0, "rgba(255,255,255,0.95)");
    cap.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = cap;
    g.fillRect(0, 0, W, H * 0.16);
    var cap2 = g.createLinearGradient(0, H, 0, H * 0.84);
    cap2.addColorStop(0, "rgba(255,255,255,0.95)");
    cap2.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = cap2;
    g.fillRect(0, H * 0.84, W, H * 0.16);
  }

  function paintLava(g, W, H) {
    var r = texRng(7331);
    g.fillStyle = "#120d0b";
    g.fillRect(0, 0, W, H);
    for (var i = 0; i < 260; i++) {
      g.globalAlpha = 0.10 + r() * 0.16;
      g.fillStyle = r() < 0.7 ? "#2a211b" : "#3a2a20";
      ellipsePath(g, r() * W, r() * H, 8 + r() * 40, 6 + r() * 28, r() * TAU);
      g.fill();
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "lighter";
    var passes = [
      { w: 7.0, c: "rgba(170,42,10,0.30)" },
      { w: 3.0, c: "rgba(255,96,24,0.55)" },
      { w: 1.2, c: "rgba(255,196,96,0.85)" }
    ];
    for (var p = 0; p < passes.length; p++) {
      g.lineWidth = passes[p].w;
      g.strokeStyle = passes[p].c;
      g.lineCap = "round";
      for (var k = 0; k < 58; k++) {
        var x = r() * W, y = r() * H, a = r() * TAU;
        g.beginPath();
        g.moveTo(x, y);
        var steps = 5 + ((r() * 9) | 0);
        for (var s = 0; s < steps; s++) {
          a += (r() - 0.5) * 1.5;
          x += Math.cos(a) * (6 + r() * 20);
          y += Math.sin(a) * (6 + r() * 20);
          g.lineTo(x, y);
        }
        g.stroke();
      }
    }
    g.globalCompositeOperation = "source-over";
    // 熔池（渐变在变换后的局部空间创建，否则会落到画布原点）
    for (var q = 0; q < 26; q++) {
      var x2 = r() * W, y2 = r() * H, rr = 4 + r() * 14;
      g.save();
      g.translate(x2, y2);
      g.scale(rr, rr * 0.8);
      var rg = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      rg.addColorStop(0, "rgba(255,190,110,0.9)");
      rg.addColorStop(0.5, "rgba(255,96,26,0.35)");
      rg.addColorStop(1, "rgba(255,60,0,0)");
      g.fillStyle = rg;
      g.beginPath();
      g.arc(0, 0, 1, 0, TAU);
      g.fill();
      g.restore();
    }
  }

  function paintOcean(g, W, H) {
    var r = texRng(9091);
    var lg = g.createLinearGradient(0, 0, 0, H);
    lg.addColorStop(0, "#0a2a5e");
    lg.addColorStop(0.45, "#0f3d7a");
    lg.addColorStop(0.55, "#0b2f63");
    lg.addColorStop(1, "#071e42");
    g.fillStyle = lg;
    g.fillRect(0, 0, W, H);
    for (var i = 0; i < 90; i++) {
      g.globalAlpha = 0.10 + r() * 0.12;
      g.fillStyle = r() < 0.5 ? "#123f74" : "#071c3c";
      ellipsePath(g, r() * W, r() * H, 10 + r() * 50, 6 + r() * 30, r() * TAU);
      g.fill();
    }
    g.globalAlpha = 1;
    // 小岛
    for (var j = 0; j < 26; j++) {
      var cx = r() * W, cy = H * 0.2 + r() * H * 0.6;
      var baseR = 3 + r() * 9;
      g.fillStyle = "#2f5f3f";
      ellipsePath(g, cx, cy, baseR * (1 + r()), baseR * 0.7, r() * TAU);
      g.fill();
      g.fillStyle = "rgba(120,150,100,0.55)";
      ellipsePath(g, cx, cy, baseR * 0.55, baseR * 0.4, 0);
      g.fill();
    }
    // 云系（低云 + 横向条带）
    for (var k = 0; k < 150; k++) {
      var x = r() * W, y = r() * H;
      var rx = 10 + r() * 46, ry = 4 + r() * 12;
      var cg = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      cg.addColorStop(0, "rgba(255,255,255," + (0.14 + r() * 0.16).toFixed(3) + ")");
      cg.addColorStop(1, "rgba(255,255,255,0)");
      g.save();
      g.translate(x, y);
      g.rotate((r() - 0.5) * 0.6);
      g.scale(rx, ry);
      g.fillStyle = cg;
      g.beginPath();
      g.arc(0, 0, 1, 0, TAU);
      g.fill();
      g.restore();
    }
    for (var s = 0; s < 7; s++) {
      g.globalAlpha = 0.09 + r() * 0.08;
      g.fillStyle = "#ffffff";
      ellipsePath(g, r() * W, H * (0.15 + r() * 0.7), 60 + r() * 120, 3 + r() * 7, 0);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  function paintStar(g, W, H) {
    var r = texRng(4242);
    // 暖金橙底：赤道亮、极区略深，给自发光球一点色温层次
    var lg = g.createLinearGradient(0, 0, 0, H);
    lg.addColorStop(0, "#e29a41");
    lg.addColorStop(0.3, "#ffd083");
    lg.addColorStop(0.5, "#ffe8b6");
    lg.addColorStop(0.7, "#ffd083");
    lg.addColorStop(1, "#e29a41");
    g.fillStyle = lg;
    g.fillRect(0, 0, W, H);
    // 米粒组织：亮米粒 + 暗间隙（别用接近纯白的底，过曝会抹平）
    var tones = ["#fff6df", "#ffcf7a", "#f4a63f", "#ffbe5c", "#ffe9bd"];
    for (var i = 0; i < 760; i++) {
      g.globalAlpha = 0.08 + r() * 0.22;
      g.fillStyle = tones[(r() * tones.length) | 0];
      ellipsePath(g, r() * W, r() * H, 2 + r() * 13, 1.5 + r() * 9, r() * TAU);
      g.fill();
    }
    // 亮斑/光斑
    for (var j = 0; j < 90; j++) {
      g.globalAlpha = 0.12 + r() * 0.22;
      g.fillStyle = "#fffdf2";
      ellipsePath(g, r() * W, r() * H, 1.5 + r() * 5, 1.2 + r() * 4, 0);
      g.fill();
    }
    g.globalAlpha = 1;
    // 太阳斑：半影 + 本影，外加亮环，成组出现在中低纬
    for (var k = 0; k < 14; k++) {
      var cx = r() * W, cy = H * 0.18 + r() * H * 0.64;
      var rad = 2.5 + r() * 6.5;
      g.globalAlpha = 0.42 + r() * 0.20;
      g.fillStyle = "#7d3c14";
      ellipsePath(g, cx + (r() - 0.5) * rad * 1.6, cy + (r() - 0.5) * rad, rad * 1.75, rad * 1.3, r() * TAU);
      g.fill();
      g.globalAlpha = 0.40 + r() * 0.25;
      g.strokeStyle = "rgba(255,240,200,0.75)";
      g.lineWidth = 1 + r() * 1.6;
      ellipsePath(g, cx, cy, rad * 2.2, rad * 1.7, 0);
      g.stroke();
      g.globalAlpha = 0.72 + r() * 0.20;
      g.fillStyle = "#401d08";
      ellipsePath(g, cx, cy, rad, rad * 0.78, r() * TAU);
      g.fill();
    }
    g.globalAlpha = 1;
    // 低纬暗带，避免整块过于均匀
    for (var s = 0; s < 4; s++) {
      g.globalAlpha = 0.05 + r() * 0.06;
      g.fillStyle = "#c9792a";
      ellipsePath(g, r() * W, H * (0.15 + r() * 0.7), 90 + r() * 120, 5 + r() * 9, 0);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  function paintAsteroid(g, W, H) {
    var r = texRng(5150);
    g.fillStyle = "#5d5952";
    g.fillRect(0, 0, W, H);
    for (var i = 0; i < 300; i++) {
      g.globalAlpha = 0.10 + r() * 0.18;
      g.fillStyle = r() < 0.5 ? "#807a70" : "#3b3833";
      ellipsePath(g, r() * W, r() * H, 6 + r() * 30, 4 + r() * 22, r() * TAU);
      g.fill();
    }
    g.globalAlpha = 1;
    // 陨石坑
    for (var k = 0; k < 70; k++) {
      var x = r() * W, y = r() * H, rad = 2 + r() * 9;
      g.fillStyle = "rgba(40,38,35,0.55)";
      ellipsePath(g, x, y, rad, rad * 0.85, 0);
      g.fill();
      g.strokeStyle = "rgba(170,164,152,0.5)";
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(x, y, rad, 0, TAU);
      g.stroke();
    }
    for (var s = 0; s < 900; s++) {
      g.globalAlpha = 0.05 + r() * 0.15;
      g.fillStyle = r() < 0.5 ? "#9a948a" : "#26241f";
      g.fillRect(r() * W, r() * H, 1 + r() * 2, 1 + r() * 2);
    }
    g.globalAlpha = 1;
  }

  function paintComet(g, W, H) {
    var r = texRng(6161);
    g.fillStyle = "#8f9aa6";
    g.fillRect(0, 0, W, H);
    for (var i = 0; i < 280; i++) {
      g.globalAlpha = 0.12 + r() * 0.2;
      g.fillStyle = r() < 0.5 ? "#e7f1fa" : "#4a525c";
      ellipsePath(g, r() * W, r() * H, 5 + r() * 26, 4 + r() * 18, r() * TAU);
      g.fill();
    }
    g.globalAlpha = 1;
    for (var k = 0; k < 70; k++) {
      g.globalAlpha = 0.15 + r() * 0.25;
      g.fillStyle = r() < 0.6 ? "#dfeaf4" : "#2f353c";
      g.fillRect(r() * W, r() * H, 1 + r() * 3, 1 + r() * 3);
    }
    g.globalAlpha = 1;
  }

  /* 带环行星本体：偏中性的琥珀色条带，实例色再叠一层项目色 */
  function paintBanded(g, W, H) {
    var r = texRng(2718);
    var pal = ["#e9dcc0", "#cdbb96", "#f4ebd8", "#bfae8c", "#e2d2b2", "#d8c8a6"];
    for (var y = 0; y < H; y++) {
      var t = y / H;
      var band = 0.5 + 0.5 * Math.sin(t * TAU * 7.3) * Math.sin(t * TAU * 2.1 + 0.7);
      var idx = Math.floor((band * 0.5 + t * 0.5) * (pal.length - 0.001));
      g.fillStyle = pal[idx];
      g.globalAlpha = 0.86 + 0.14 * Math.sin(t * TAU * 11.0);
      g.fillRect(0, y, W, 1);
    }
    g.globalAlpha = 1;
    for (var k = 0; k < 26; k++) {
      g.globalAlpha = 0.06 + r() * 0.12;
      g.fillStyle = r() < 0.5 ? "#9c8a68" : "#fff6e2";
      g.fillRect(0, r() * H, W, 1 + r() * 2.5);
    }
    g.globalAlpha = 1;
  }

  var TYPE_PAINTERS = {
    ringed: paintBanded,
    ice: paintIce,
    lava: paintLava,
    ocean: paintOcean,
    star: paintStar,
    asteroid: paintAsteroid,
    comet: paintComet
  };

  function makeTypedTexture(THREE, painter) {
    var d = newAtlasCanvas();
    if (!d) return null;
    try {
      painter(d.g, d.c.width, d.c.height);
    } catch (e) {
      return null;   // 贴图失败：该类型退化为纯色球，不影响首帧
    }
    return finishAtlas(THREE, d.c);
  }

  /* 彗尾几何：沿 y 分段的朝相机 ribbon（x=±0.5 横向，y=0..1 沿尾方向） */
  function makeTailGeometry(THREE) {
    var SEG = 8;
    var pos = [];
    var idx = [];
    for (var j = 0; j <= SEG; j++) {
      var t = j / SEG;
      pos.push(-0.5, t, 0, 0.5, t, 0);
    }
    for (var k = 0; k < SEG; k++) {
      var a = k * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return geo;
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
    "uniform float uWobble;",
    "varying vec3 vN;",
    "varying vec3 vW;",
    "varying vec2 vUv;",
    "varying vec3 vON;",
    "varying vec3 vCol;",
    "varying float vAlpha;",
    "varying float vRim;",
    "void main() {",
    "  vec3 lp = position;",
    "  if (uWobble > 0.001) {",
    // 小行星：按实例自转角做低频起伏，轮廓明显非圆球（旧类型 uWobble=0 不走这里）
    "    float w1 = sin(position.x * 4.1 + aSpin * 2.3);",
    "    float w2 = sin(position.y * 3.3 + aSpin * 1.7 + 1.3);",
    "    float w3 = sin(position.z * 3.7 + aSpin * 2.9 + 2.1);",
    "    lp += normalize(position + vec3(0.0001)) * (w1 * w2 * w3 * 0.34 * uWobble);",
    "  }",
    "  float cs = cos(aSpin), sn = sin(aSpin);",
    "  vec3 p = vec3(cs * lp.x + sn * lp.z, lp.y, -sn * lp.x + cs * lp.z);",
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
    "uniform float uEmissive;",
    "uniform float uStar;",
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
    // 恒星专用分支：不叠太阳光照，用自发光 + limb darkening + 软肩压缩，避免 clamp 成纯白盘
    "  if (uStar > 0.5) {",
    "    float mu = clamp(dot(N, viewDir), 0.0, 1.0);",
    "    float limb = 0.58 + 0.42 * pow(mu, 0.6);",
    "    vec3 sc = vCol * alb * limb * 1.02;",
    "    sc -= max(sc - 0.90, 0.0) * 0.72;",
    "    gl_FragColor = vec4(pow(clamp(sc, 0.0, 1.0), vec3(0.4545)), clamp(vAlpha, 0.0, 1.0));",
    "    return;",
    "  }",
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
    // 自发光：恒星/熔岩用自身贴图当发光色，普通行星 uEmissive=0 输出与旧版一致
    "  col += vCol * alb * uEmissive;",
    "  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));",   // 线性 → sRGB（ShaderMaterial 不自动转）
    "  gl_FragColor = vec4(col, clamp(vAlpha, 0.0, 1.0));",
    "}"
  ].join("\n");

  /* 星环：XY 平面的 RingGeometry，按实例倾斜；depthTest 让后半环被星球挡掉 */
  var RING_VS = [
    "attribute vec3 aOffset;",
    "attribute float aRadius;",
    "attribute vec2 aTilt;",
    "attribute vec3 aColor;",
    "attribute float aAlpha;",
    "varying float vR;",
    "varying vec3 vCol;",
    "varying float vAlpha;",
    "void main() {",
    "  vec3 p = vec3(position.xy, 0.0) * aRadius;",
    "  float cx = cos(aTilt.x), sx = sin(aTilt.x);",
    "  float cy = cos(aTilt.y), sy = sin(aTilt.y);",
    "  vec3 q = vec3(p.x, p.y * cx, p.y * sx);",
    "  q = vec3(q.x * cy + q.z * sy, q.y, -q.x * sy + q.z * cy);",
    "  vR = length(position.xy);",
    "  vCol = aColor;",
    "  vAlpha = aAlpha;",
    "  gl_Position = projectionMatrix * viewMatrix * vec4(aOffset + q, 1.0);",
    "}"
  ].join("\n");

  var RING_FS = [
    "varying float vR;",
    "varying vec3 vCol;",
    "varying float vAlpha;",
    "void main() {",
    "  float t = clamp((vR - 1.30) / 0.75, 0.0, 1.0);",
    "  float edges = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.90, 1.0, t));",
    "  float bands = 0.55 + 0.45 * sin(t * 46.0 + 1.3) * sin(t * 17.0);",
    "  float gaps = 1.0;",
    "  gaps *= mix(1.0, 0.16, smoothstep(0.28, 0.31, t) * (1.0 - smoothstep(0.34, 0.37, t)));",
    "  gaps *= mix(1.0, 0.20, smoothstep(0.58, 0.60, t) * (1.0 - smoothstep(0.63, 0.66, t)));",
    "  gaps *= mix(1.0, 0.38, smoothstep(0.78, 0.80, t) * (1.0 - smoothstep(0.82, 0.85, t)));",
    "  float a = vAlpha * edges * mix(0.50, 1.0, bands) * gaps;",
    "  if (a < 0.004) discard;",
    "  vec3 c = vCol * (0.50 + 0.50 * bands);",
    "  gl_FragColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(0.4545)), clamp(a, 0.0, 1.0));",
    "}"
  ].join("\n");

  /* 彗尾：相机朝向的软边 ribbon（不是实体锥），横向渐隐、头亮尾淡，可轻微弯曲 */
  var TAIL_VS = [
    "attribute vec3 aOffset;",
    "attribute vec3 aDir;",
    "attribute float aLen;",
    "attribute float aCurve;",
    "attribute vec3 aColor;",
    "attribute float aAlpha;",
    "varying float vT;",
    "varying float vLat;",
    "varying vec3 vCol;",
    "varying float vAlpha;",
    "void main() {",
    "  vec3 dir = normalize(aDir + vec3(0.0, 0.0, 0.0001));",
    "  vec3 zAxis = vec3(0.0, 0.0, 1.0);",
    "  vec3 sideRaw = cross(zAxis, dir);",
    "  float sl = length(sideRaw);",
    "  vec3 side = sl > 0.001 ? sideRaw / sl : vec3(1.0, 0.0, 0.0);",
    "  float t = clamp(position.y, 0.0, 1.0);",
    // 头细尾宽，横向由 shader 做高斯渐隐，不会有硬轮廓
    "  float halfW = aLen * (0.045 + 0.095 * t);",
    "  float bend = aCurve * aLen * sin(t * 2.1);",
    "  vec3 wp = aOffset + dir * (t * aLen) + side * (position.x * 2.0 * halfW + bend);",
    "  vT = t;",
    "  vLat = position.x * 2.0;",
    "  vCol = aColor;",
    "  vAlpha = aAlpha;",
    "  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);",
    "}"
  ].join("\n");

  var TAIL_FS = [
    "varying float vT;",
    "varying float vLat;",
    "varying vec3 vCol;",
    "varying float vAlpha;",
    "void main() {",
    "  float t = clamp(vT, 0.0, 1.0);",
    // 横向高斯渐隐：中心亮、边缘完全透明，消除匕首状硬边
    "  float soft = 1.0 - smoothstep(0.22, 1.0, abs(vLat));",
    "  soft *= soft;",
    // 轴向：头部最亮，尾端平滑淡出
    "  float axial = smoothstep(0.0, 0.05, t) * pow(1.0 - t, 2.1);",
    "  float head = exp(-t * 6.5);",
    "  float a = vAlpha * soft * (axial * 0.85 + head * 0.55);",
    "  if (a < 0.003) discard;",
    // 头部偏白、尾部偏蓝的离子色
    "  vec3 c = mix(vCol, vec3(1.0, 0.98, 0.94), 0.55 * head);",
    "  gl_FragColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(0.4545)), clamp(a, 0.0, 1.0));",
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
    this.VERSION = "1.1.0";

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
    this._typeCache = Object.create(null);
    this._typeCounts = Object.create(null);
    for (var ti = 0; ti < BODY_TYPES.length; ti++) this._typeCounts[BODY_TYPES[ti].id] = 0;
    this._bodyTheme = "mixed";
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
    this._initDecorations();

    this._tmp = {
      pos: new Float32Array(3),
      cpos: new Float32Array(3),
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
  /* 天幕平面到相机的固定距离；比所有星体/轨道都远，但仍在 camera.far 内 */
  var SKY_DIST = 7000;

  MemoryWebGL.prototype._initBackdrop = function () {
    var THREE = this.THREE;
    var fov = this._fov;

    // 背景跟着镜头走：不产生视差，也不会被镜头平移穿到星体前面
    var backdrop = new THREE.Group();
    backdrop.position.set(0, 0, fov);
    this.scene.add(backdrop);
    this._backdrop = backdrop;

    /* 银河天幕：贴在相机正前方的超远平面。尺寸每帧按 fov/zoom 反算，
     * 所以 fov=1250 / 3000、任意缩放下都是同一构图，纹理也不会因整球
     * 等距映射只用到中间几十像素而变糊。 */
    var skyMat = new THREE.MeshBasicMaterial({
      map: this._galaxyTex,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false
    });
    var skyGeo = new THREE.PlaneGeometry(1, 1);
    var sky = new THREE.Mesh(skyGeo, skyMat);
    sky.position.set(0, 0, -SKY_DIST);
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    backdrop.add(sky);
    this._sky = sky;
    this._skyMat = skyMat;
    this._skyGeo = skyGeo;
    this._skyDist = SKY_DIST;
    this._skyAspect = 2;         // 银河纹理 2048x1024
    this._layoutSky();

    // tex_atlas.js 若带真实银河全景（sky 字段）仍可覆盖：全景用等距柱状球面，
    // 避免把 360° 全景误当平面图拉伸；加载成功后隐藏程序化天幕。
    var TEXLIB = global.__ATLAS_TEX__;
    if (TEXLIB && TEXLIB.sky) {
      var self = this;
      var loader = new THREE.TextureLoader();
      var tex = loader.load(TEXLIB.sky, function () {
        if (self._disposed) return;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        var extGeo = new THREE.SphereGeometry(6500, 48, 32);
        var extMat = new THREE.MeshBasicMaterial({
          map: tex,
          side: THREE.BackSide,
          depthTest: false,
          depthWrite: false,
          fog: false,
          toneMapped: false
        });
        var ext = new THREE.Mesh(extGeo, extMat);
        ext.renderOrder = -1000;
        ext.frustumCulled = false;
        self._backdrop.add(ext);
        self._skyExternal = ext;
        if (self._sky) self._sky.visible = false;
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

  /* 让程序化天幕始终以同一构图铺满视口：
   *   投影后屏幕尺寸 = 世界尺寸 * fov / SKY_DIST * zoom，
   *   因此世界尺寸取 (屏幕像素 * SKY_DIST / (fov*zoom)) 即可与 fov/zoom 解耦。
   *   保持 2:1 纹理比例，多出的方向自然裁切，不拉伸。
   */
  MemoryWebGL.prototype._layoutSky = function () {
    var sky = this._sky;
    if (!sky) return;
    var D = this._skyDist || SKY_DIST;
    var fov = this._fov > 1 ? this._fov : 1250;
    var zoom = this._zoom > 0 ? this._zoom : 1;
    var unit = D / (fov * zoom);
    var halfW = (this.W * 0.5) * unit;
    var halfH = (this.H * 0.5) * unit;
    var aspect = this._skyAspect || 2;
    if (halfW < halfH * aspect) halfW = halfH * aspect;
    halfH = halfW / aspect;
    var margin = 1.08;           // 留 8% 余量，避免亚像素/圆整后露出黑边
    sky.scale.set(halfW * 2 * margin, halfH * 2 * margin, 1);
    sky.position.set(0, 0, -D);
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
    this._curves = [];           // 每组的可选旋臂曲线（延迟创建，容量复用）
    this._curveActive = 0;       // 上一帧实际绘制的曲线数
    this._curvePoints = 0;       // 上一帧曲线点数合计
  };

  MemoryWebGL.prototype._makeBodyBucket = function (texture, name, tint, opts) {
    var THREE = this.THREE;
    opts = opts || {};
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture || null },
        uHasMap: { value: opts.hasMap ? 1.0 : 0.0 },
        uEmissive: { value: num(opts.emissive, 0) },
        uStar: { value: opts.star ? 1.0 : 0.0 },
        uWobble: { value: num(opts.wobble, 0) },
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

    /* 7 种程序天体：每种一个共享贴图 + 一个桶（仍走同一套 instancing） */
    this._typeBuckets = Object.create(null);
    var typeOpts = {
      ringed: { emissive: 0.0, wobble: 0 },
      ice: { emissive: 0.04, wobble: 0 },
      lava: { emissive: 0.62, wobble: 0 },
      ocean: { emissive: 0.0, wobble: 0 },
      star: { emissive: 0.95, wobble: 0, star: 1 },
      asteroid: { emissive: 0.0, wobble: 1.0 },
      comet: { emissive: 0.05, wobble: 0 }
    };
    for (var ti = 0; ti < BODY_TYPE_MIX.length; ti++) {
      var tid = BODY_TYPE_MIX[ti];
      var ttex = makeTypedTexture(THREE, TYPE_PAINTERS[tid]);
      if (ttex) this._ownedTextures.push(ttex);
      var opt = typeOpts[tid] || {};
      opt.hasMap = !!ttex;
      var tb = this._makeBodyBucket(ttex, tid, null, opt);
      this._buckets.push(tb);
      this._typeBuckets[tid] = this._buckets.length - 1;
    }
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

  /* 装饰层：星环 + 彗尾，各自一个 instancing draw call，几何/材质只建一次 */
  MemoryWebGL.prototype._initDecorations = function () {
    var THREE = this.THREE;

    var ringGeo = new THREE.RingGeometry(1.30, 2.05, 84, 1);
    this._decoRingGeo = ringGeo;
    var ringInst = new THREE.InstancedBufferGeometry();
    ringInst.index = ringGeo.index;
    ringInst.setAttribute("position", ringGeo.getAttribute("position"));
    ringInst.instanceCount = 0;
    var ringMat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: RING_VS,
      fragmentShader: RING_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false
    });
    var ringMesh = new THREE.Mesh(ringInst, ringMat);
    ringMesh.frustumCulled = false;
    ringMesh.renderOrder = 3;   // 在星体（2）之后：后半环被星球深度正确挡住
    ringMesh.matrixAutoUpdate = false;
    this.scene.add(ringMesh);
    this._ringDeco = {
      geo: ringInst, mesh: ringMesh, material: ringMat, cap: 0, count: 0,
      offset: null, radius: null, tilt: null, color: null, alpha: null,
      aOffset: null, aRadius: null, aTilt: null, aColor: null, aAlpha: null
    };

    var tailGeo = makeTailGeometry(THREE);
    this._decoTailGeo = tailGeo;
    var tailInst = new THREE.InstancedBufferGeometry();
    tailInst.index = tailGeo.index;
    tailInst.setAttribute("position", tailGeo.getAttribute("position"));
    tailInst.instanceCount = 0;
    var tailMat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: TAIL_VS,
      fragmentShader: TAIL_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false
    });
    var tailMesh = new THREE.Mesh(tailInst, tailMat);
    tailMesh.frustumCulled = false;
    tailMesh.renderOrder = 3;
    tailMesh.matrixAutoUpdate = false;
    this.scene.add(tailMesh);
    this._tailDeco = {
      geo: tailInst, mesh: tailMesh, material: tailMat, cap: 0, count: 0,
      offset: null, dir: null, len: null, curve: null, color: null, alpha: null,
      aOffset: null, aDir: null, aLen: null, aCurve: null, aColor: null, aAlpha: null
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

  MemoryWebGL.prototype._ensureDecoCapacity = function (total) {
    var THREE = this.THREE;
    var need = Math.max(8, total | 0) + 6;

    var r = this._ringDeco;
    if (need > r.cap) {
      var rcap = Math.max(need, Math.ceil(r.cap * 1.5), 24);
      r.cap = rcap;
      r.offset = new Float32Array(rcap * 3);
      r.radius = new Float32Array(rcap);
      r.tilt = new Float32Array(rcap * 2);
      r.color = new Float32Array(rcap * 3);
      r.alpha = new Float32Array(rcap);
      r.aOffset = instAttr(THREE, r.offset, 3);
      r.aRadius = instAttr(THREE, r.radius, 1);
      r.aTilt = instAttr(THREE, r.tilt, 2);
      r.aColor = instAttr(THREE, r.color, 3);
      r.aAlpha = instAttr(THREE, r.alpha, 1);
      r.geo.setAttribute("aOffset", r.aOffset);
      r.geo.setAttribute("aRadius", r.aRadius);
      r.geo.setAttribute("aTilt", r.aTilt);
      r.geo.setAttribute("aColor", r.aColor);
      r.geo.setAttribute("aAlpha", r.aAlpha);
    }

    var t = this._tailDeco;
    if (need > t.cap) {
      var tcap = Math.max(need, Math.ceil(t.cap * 1.5), 24);
      t.cap = tcap;
      t.offset = new Float32Array(tcap * 3);
      t.dir = new Float32Array(tcap * 3);
      t.len = new Float32Array(tcap);
      t.curve = new Float32Array(tcap);
      t.color = new Float32Array(tcap * 3);
      t.alpha = new Float32Array(tcap);
      t.aOffset = instAttr(THREE, t.offset, 3);
      t.aDir = instAttr(THREE, t.dir, 3);
      t.aLen = instAttr(THREE, t.len, 1);
      t.aCurve = instAttr(THREE, t.curve, 1);
      t.aColor = instAttr(THREE, t.color, 3);
      t.aAlpha = instAttr(THREE, t.alpha, 1);
      t.geo.setAttribute("aOffset", t.aOffset);
      t.geo.setAttribute("aDir", t.aDir);
      t.geo.setAttribute("aLen", t.aLen);
      t.geo.setAttribute("aCurve", t.aCurve);
      t.geo.setAttribute("aColor", t.aColor);
      t.geo.setAttribute("aAlpha", t.aAlpha);
    }
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

  /* 旋臂曲线：每组一条 THREE.Line（开放折线，不是 LineLoop）。
   * 几何/材质按组数创建一次，之后即使 curve 反复出现/消失也复用；
   * 只有点数超出当前容量才扩容。点坐标每帧直接写入预分配 Float32Array，
   * 不 new 几何、不 setFromPoints、不新建数组。 */
  MemoryWebGL.prototype._ensureCurveCapacity = function (n) {
    var THREE = this.THREE;
    while (this._curves.length < n) {
      var cap = 64;
      var arr = new Float32Array(cap * 3);
      var attr = new THREE.BufferAttribute(arr, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", attr);
      geo.setDrawRange(0, 0);
      var mat = new THREE.LineBasicMaterial({
        color: 0x9fb4ff,
        transparent: true,
        opacity: 0.30,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        fog: false,
        toneMapped: false
      });
      var line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = 3;        // 与圆环同层：被星体深度正确遮挡
      line.matrixAutoUpdate = false;
      line.visible = false;
      this.scene.add(line);
      this._curves.push({
        line: line, geo: geo, material: mat,
        positions: arr, attr: attr, cap: cap, count: 0
      });
    }
  };

  /* 把一个 curve 数组写进对应的 Line；返回 false 表示数据无效，需要回退圆环 */
  MemoryWebGL.prototype._updateCurve = function (c, crv, n, camX, camY, camZ, cX, sX, cY, sY) {
    if (!c || n < 2) return false;
    var THREE = this.THREE;

    if (n > c.cap) {
      // 只在容量不足时扩容（一次多留一些，避免频繁重建）
      var cap = Math.max(n + 32, Math.ceil(c.cap * 2));
      var arr = new Float32Array(cap * 3);
      var attr = new THREE.BufferAttribute(arr, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      c.geo.setAttribute("position", attr);
      c.positions = arr;
      c.attr = attr;
      c.cap = cap;
    }

    var out = this._tmp.cpos;
    var dst = c.positions;
    var valid = true;
    for (var k = 0; k < n; k++) {
      var wx = crv[k * 3] - camX;
      var wy = crv[k * 3 + 1] - camY;
      var wz = crv[k * 3 + 2] - camZ;
      if (!isFinite(wx) || !isFinite(wy) || !isFinite(wz)) { valid = false; break; }
      rotPoint(out, wx, wy, wz, cX, sX, cY, sY);
      dst[k * 3] = out[0];
      dst[k * 3 + 1] = out[1];
      dst[k * 3 + 2] = out[2];
    }
    if (!valid) {
      c.line.visible = false;
      c.count = 0;
      return false;
    }
    c.attr.needsUpdate = true;
    c.geo.setDrawRange(0, n);
    c.count = n;
    c.line.visible = true;
    return true;
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
    this._layoutSky();
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

    /* ---- 内部时钟只用于自转/外部全景慢转，不用 frame.time（单位未约定） ----
     * 程序化银河是相机前的固定天幕，完全不随时间移动：spin=false 时整帧
     * 背景与上一帧一致，也不产生任何新的 RAF/几何/纹理分配。 */
    if (this._skyExternal) {
      this._skyExternal.rotation.y = 0.35 + tsec * 0.006;
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

    /* ---- 轨道 / 可选旋臂曲线 ---- */
    var groups = frame.groups || [];
    this._ensureOrbitCapacity(groups.length);
    this._ensureCurveCapacity(groups.length);
    var sel = state.selected || null;
    var selGi = (sel && isNum(sel.gi)) ? sel.gi : null;
    var groupCount = Math.max(1, groups.length);
    var ringOpacityBase = state.spaceScale>1 ? 0.045 : 0.095, diskOpacityBase = state.spaceScale>1 ? 0 : 0.007;
    var curveOpacityBase = state.spaceScale>1 ? 0.13 : 0.17;
    var curveDim = 0.36;
    var curveActive = 0, curvePoints = 0;
    var gi, m, aVec, bVec, nVec;

    for (gi = 0; gi < groups.length; gi++) {
      var grp = groups[gi];
      var line = this._rings[gi];
      var disk = this._disks[gi];
      var curveLine = this._curves[gi];
      var hasCurve = false;

      if (grp && grp.curve && typeof grp.curve.length === "number") {
        var cn = (grp.curve.length / 3) | 0;
        if (cn >= 2) {
          hasCurve = this._updateCurve(curveLine, grp.curve, cn, camX, camY, camZ, cX, sX, cY, sY);
        }
        if (!hasCurve && curveLine) { curveLine.line.visible = false; curveLine.count = 0; }
      } else if (curveLine) {
        curveLine.line.visible = false;
        curveLine.count = 0;
      }

      if (hasCurve) {
        // 有效 curve：隐藏该组原 circle/disk，只画一条柔和开放折线
        line.visible = false;
        disk.visible = false;
        var hueC = 205 + (gi / groupCount) * 62;
        var selC = (selGi !== null && gi === selGi);
        var dimC = (selGi !== null && gi !== selGi) ? curveDim : 1.0;
        curveLine.material.color.setHSL(hueC / 360, 0.58, selC ? 0.80 : 0.70);
        curveLine.material.opacity = curveOpacityBase * (selC ? 1.5 : 1.0) * dimC;
        curveActive++;
        curvePoints += curveLine.count;
        continue;
      }

      // 无 curve 或 curve 无效：恢复旧的 u/v/R 圆环
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
    for (gi = groups.length; gi < this._curves.length; gi++) {
      this._curves[gi].line.visible = false;
    }
    this._curveActive = curveActive;
    this._curvePoints = curvePoints;

    /* ---- 星体数据准备 ---- */
    var total = nodes.length + 8;
    this._ensureBodyCapacity(total);
    this._ensureHaloCapacity(total);

    for (var bi = 0; bi < this._buckets.length; bi++) this._buckets[bi].count = 0;
    var halo = this._halo;
    halo.count = 0;

    /* 装饰（星环/彗尾）与类型统计 */
    this._ensureDecoCapacity(total);
    var ringDeco = this._ringDeco;
    var tailDeco = this._tailDeco;
    ringDeco.count = 0;
    tailDeco.count = 0;
    var bodyTheme = (state.bodyTheme === "classic") ? "classic" : "mixed";
    this._bodyTheme = bodyTheme;
    for (var tz = 0; tz < BODY_TYPES.length; tz++) this._typeCounts[BODY_TYPES[tz].id] = 0;

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
    var typeBuckets = this._typeBuckets;
    var bodiesMax = nodes.length;

    for (var ni = 0; ni < bodiesMax; ni++) {
      var n = nodes[ni];
      if (!n) continue;

      var kind = n.kind || "main";
      var rNode = num(n.r, 6);
      var rn = clamp((rNode - 5) / 21, 0, 1);

      /* 天体类型：首帧即确定，按 id 稳定，同 id 不随新增节点换皮 */
      var bodyType = this.resolveBodyType(n, bodyTheme);
      n.bodyType = bodyType;
      n.bodyLabel = BODY_TYPE_LABEL[bodyType] || "";
      this._typeCounts[bodyType] = (this._typeCounts[bodyType] || 0) + 1;

      /* 世界半径：由 n.r 稳定映射到 4~11；卫星总览更小 */
      var worldR = 4 + rn * 7;
      if (kind === "sub") worldR = Math.max(3.2, worldR * 0.62);
      else if (kind === "gone") worldR = 3.4;

      /* 桶 / 材质名 */
      var bucketIndex;
      if (kind === "gone") {
        bucketIndex = fallbackIndex;
        n.materialName = ARCHIVED_NAME;
      } else if (bodyType === "planet") {
        if (planetCount > 0) {
          bucketIndex = Math.floor(h01("planet:" + String(n.id)) * planetCount) % planetCount;
          n.materialName = this._buckets[bucketIndex] ? this._buckets[bucketIndex].name : FALLBACK_NAME;
        } else {
          bucketIndex = fallbackIndex;
          n.materialName = FALLBACK_NAME;
        }
      } else {
        var tbIdx = typeBuckets[bodyType];
        if (isNum(tbIdx)) {
          bucketIndex = tbIdx;
          n.materialName = bodyType;
        } else {
          bucketIndex = fallbackIndex;
          n.materialName = FALLBACK_NAME;
        }
      }
      n.glRadius = worldR;
      // 图鉴/布局用的包围半径：星环算进去，点击仍按 n.screenRadius（球心）
      n.bodyBoundRadius = worldR * (bodyType === "ringed" ? 2.10 : 1.0);

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

      /* 自转参数（按 id 稳定；星环倾角、彗尾兜底方向一并缓存，不每帧 new） */
      var nodeKey = (n.id != null) ? n.id : ("anon:" + (isNum(n.gi) ? n.gi : ni) + ":" + rNode);
      var spinInfo = this._spinCache[nodeKey];
      if (!spinInfo) {
        var hk0 = "k:" + nodeKey;
        var spd = 0.10 + h01(hk0 + "spin") * 0.22;
        var dirSign = h01(hk0 + "dir") > 0.5 ? 1 : -1;
        var fa = h01(hk0 + "tail") * TAU;
        spinInfo = {
          speed: spd * dirSign,
          phase: h01(hk0 + "ph") * TAU,
          tiltX: 1.06 + h01(hk0 + "rx") * 0.28,
          tiltY: (h01(hk0 + "ry") - 0.5) * 0.7,
          curve: (h01(hk0 + "bend") - 0.5) * 0.65,
          tailDir: [Math.cos(fa) * 0.6, (h01(hk0 + "ty") - 0.5) * 0.5, Math.sin(fa) * 0.6]
        };
        this._spinCache[nodeKey] = spinInfo;
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

      /* ---- 星环 / 彗尾装饰（只做视觉，不改 n.screenRadius 点击范围） ---- */
      if (kind !== "gone") {
        if (bodyType === "ringed" && ringDeco.count < ringDeco.cap) {
          var rk = ringDeco.count * 3;
          var rj = ringDeco.count * 2;
          ringDeco.offset[rk] = pos[0];
          ringDeco.offset[rk + 1] = pos[1];
          ringDeco.offset[rk + 2] = pos[2];
          ringDeco.radius[ringDeco.count] = worldR;
          ringDeco.tilt[rj] = spinInfo.tiltX;
          ringDeco.tilt[rj + 1] = spinInfo.tiltY;
          var rgc = cs.glow;
          ringDeco.color[rk] = clamp(0.55 + rgc.r * 0.45, 0, 1);
          ringDeco.color[rk + 1] = clamp(0.55 + rgc.g * 0.45, 0, 1);
          ringDeco.color[rk + 2] = clamp(0.55 + rgc.b * 0.45, 0, 1);
          ringDeco.alpha[ringDeco.count] = alpha * 0.55;
          ringDeco.count++;
        }
        if (bodyType === "comet" && tailDeco.count < tailDeco.cap) {
          // 默认背向中心太阳：核心与太阳都在相机空间，直接取投影方向
          var dx = pos[0] - tmp.origin.x;
          var dy = pos[1] - tmp.origin.y;
          var dz = pos[2] - tmp.origin.z;
          var dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dl > 1e-4) { dx /= dl; dy /= dl; dz /= dl; }
          else { dx = spinInfo.tailDir[0]; dy = spinInfo.tailDir[1]; dz = spinInfo.tailDir[2]; }
          var wk = tailDeco.count * 3;
          // 从背光侧表面起（略微压进轮廓），避免核心与尾迹之间出现断裂
          var tailStart = worldR * 0.95;
          tailDeco.offset[wk] = pos[0] + dx * tailStart;
          tailDeco.offset[wk + 1] = pos[1] + dy * tailStart;
          tailDeco.offset[wk + 2] = pos[2] + dz * tailStart;
          tailDeco.dir[wk] = dx;
          tailDeco.dir[wk + 1] = dy;
          tailDeco.dir[wk + 2] = dz;
          tailDeco.len[tailDeco.count] = worldR * 4.7;
          tailDeco.curve[tailDeco.count] = spinInfo.curve;
          // 离子/尘埃尾：冷白偏蓝，头部再由 shader 提亮
          var tbc = cs.body;
          tailDeco.color[wk] = clamp(0.55 + tbc.r * 0.25, 0, 1);
          tailDeco.color[wk + 1] = clamp(0.72 + tbc.g * 0.22, 0, 1);
          tailDeco.color[wk + 2] = clamp(0.92 + tbc.b * 0.08, 0, 1);
          tailDeco.alpha[tailDeco.count] = alpha * 0.68;
          tailDeco.count++;
        }
      }

      /* 光晕（低强度），单独一 draw call；恒星/彗星更克制，避免糊成大光斑 */
      if (halo.count < halo.cap) {
        var hk = halo.count * 3;
        var glowSize = worldR * (4.6 + rn * 0.8) * (kind === "sub" ? 1.15 : 1.0);
        var glowA = kind === "gone" ? 0.05 : (0.09 + rn * 0.08);
        if (bodyType === "star") { glowSize = worldR * 3.2; glowA = 0.10 + rn * 0.03; }
        else if (bodyType === "lava") { glowA *= 0.72; }
        else if (bodyType === "comet") { glowSize = worldR * 3.4; glowA = 0.055; }
        else if (bodyType === "asteroid") { glowA *= 0.55; }
        halo.offset[hk] = pos[0];
        halo.offset[hk + 1] = pos[1];
        halo.offset[hk + 2] = pos[2];
        halo.size[halo.count] = glowSize;
        // 恒星用暖金橙光晕，和自发光表面同色温；其余仍用项目色
        var hcr = cs.glow.r, hcg = cs.glow.g, hcb = cs.glow.b;
        if (bodyType === "star") { hcr = 1.0; hcg = 0.84; hcb = 0.62; }
        halo.color[hk] = hcr;
        halo.color[hk + 1] = hcg;
        halo.color[hk + 2] = hcb;
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

    /* ---- 提交装饰实例（星环 / 彗尾） ---- */
    ringDeco.geo.instanceCount = ringDeco.count;
    ringDeco.mesh.visible = ringDeco.count > 0;
    if (ringDeco.count > 0) {
      ringDeco.aOffset.needsUpdate = true;
      ringDeco.aRadius.needsUpdate = true;
      ringDeco.aTilt.needsUpdate = true;
      ringDeco.aColor.needsUpdate = true;
      ringDeco.aAlpha.needsUpdate = true;
    }
    tailDeco.geo.instanceCount = tailDeco.count;
    tailDeco.mesh.visible = tailDeco.count > 0;
    if (tailDeco.count > 0) {
      tailDeco.aOffset.needsUpdate = true;
      tailDeco.aDir.needsUpdate = true;
      tailDeco.aLen.needsUpdate = true;
      tailDeco.aCurve.needsUpdate = true;
      tailDeco.aColor.needsUpdate = true;
      tailDeco.aAlpha.needsUpdate = true;
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
   * 天体类型解析 / 目录
   * ========================================================================= */

  /* 确定性：同 id 永远同一类型；非法 override 安全回退到 hash 结果。
   * theme: 'mixed'（默认，约 45% planet + 其余 7 类均分）| 'classic'（只有 planet） */
  MemoryWebGL.prototype.resolveBodyType = function (n, theme) {
    if (theme === "classic") return "planet";
    if (n && n.bodyTypeOverride && BODY_TYPE_IDS[n.bodyTypeOverride]) {
      return n.bodyTypeOverride;
    }
    var t = (theme === "classic") ? "classic" : "mixed";
    if (t === "classic") return "planet";
    // 直接用 id 做缓存键：命中时不做字符串拼接，也不每帧分配
    var key = (n && n.id != null) ? n.id : "anon:" + (n ? String(n.kind || "main") + ":" + (isNum(n.gi) ? n.gi : "-") + ":" + (isNum(n.r) ? n.r : "-") : "-");
    var cached = this._typeCache[key];
    if (cached) return cached;
    var h = h01("id:" + key + "|body");
    var type;
    if (h < PLANET_SHARE) {
      type = "planet";
    } else {
      var k = Math.floor((h - PLANET_SHARE) / (1 - PLANET_SHARE) * BODY_TYPE_MIX.length);
      type = BODY_TYPE_MIX[clamp(k, 0, BODY_TYPE_MIX.length - 1)];
    }
    this._typeCache[key] = type;
    return type;
  };

  MemoryWebGL.prototype.getBodyCatalog = function () {
    var out = [];
    for (var i = 0; i < BODY_TYPES.length; i++) {
      var t = BODY_TYPES[i];
      out.push({
        id: t.id,
        label: t.label,
        description: t.description,
        count: this._typeCounts[t.id] || 0
      });
    }
    return out;
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
      var typeCounts = {};
      for (var bti = 0; bti < BODY_TYPES.length; bti++) {
        var bid = BODY_TYPES[bti].id;
        typeCounts[bid] = this._typeCounts[bid] || 0;
      }
      out.bodyTypes = {
        theme: this._bodyTheme,
        counts: typeCounts,
        buckets: this._buckets.length,
        rings: this._ringDeco ? this._ringDeco.count : 0,
        tails: this._tailDeco ? this._tailDeco.count : 0,
        ownedTextures: this._ownedTextures.length
      };
      out.curves = {
        active: this._curveActive || 0,           // 上一帧实际画出的曲线数
        points: this._curvePoints || 0,           // 上一帧曲线点总数
        allocated: this._curves ? this._curves.length : 0,
        geometry: "per-group open THREE.Line"
      };
      out.backdrop = {
        kind: this._skyExternal ? "external-sky" : "procedural-galaxy-quad",
        texture: this._galaxyTex ? "2048x1024" : "none",
        anchored: "camera"
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
    // 装饰层源几何不在场景里，显式释放（实例几何已随 scene.traverse 释放）
    try { if (this._decoRingGeo && this._decoRingGeo.dispose) this._decoRingGeo.dispose(); } catch (e) { /* ignore */ }
    try { if (this._decoTailGeo && this._decoTailGeo.dispose) this._decoTailGeo.dispose(); } catch (e) { /* ignore */ }
    // 旋臂曲线几何/材质：scene.traverse 已释放一遍，这里显式兜底并清空引用
    if (this._curves) {
      for (var cvi = 0; cvi < this._curves.length; cvi++) {
        var cv = this._curves[cvi];
        if (!cv) continue;
        try { if (cv.geo && cv.geo.dispose) cv.geo.dispose(); } catch (e) { /* ignore */ }
        try { if (cv.material && cv.material.dispose) cv.material.dispose(); } catch (e) { /* ignore */ }
      }
    }
    this._buckets = [];
    this._typeBuckets = Object.create(null);
    this._rings = [];
    this._disks = [];
    this._curves = [];
    this._curveActive = 0;
    this._curvePoints = 0;
    this._sunLayers = [];
    this._starPoints = null;
    this._sky = null;
    this._skyMat = null;
    this._skyGeo = null;
    this._skyExternal = null;
    this._ringDeco = null;
    this._tailDeco = null;
    this._decoRingGeo = null;
    this._decoTailGeo = null;
  };

  /* 公开的 8 类天体元数据（与实例 getBodyCatalog() 同结构） */
  MemoryWebGL.BODY_TYPES = BODY_TYPES;

  global.MemoryWebGL = MemoryWebGL;
})(typeof window !== "undefined" ? window : this);
