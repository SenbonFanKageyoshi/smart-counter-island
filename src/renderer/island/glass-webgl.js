'use strict';
/* ===== GPU 液态玻璃（模式 data-glass="webgl"） =====
   把原来「整屏截屏 → CPU 位图 → PNG 编码 → IPC → CSS background + SVG 滤镜」换成
   「屏幕视频流（GPU 帧）→ WebGL 纹理 → 片元着色器一次着色」：

     · 主进程不再需要 desktopCapturer（对应地整条截屏/编码/IPC 开销归零）
     · 折射/渗色/镜面高光全部在 GPU 上一次完成（与 SVG 滤镜同一套 SDF 数学）
     · 面积渐变（顶部高光/下部渐暗/两端弧线）仍由 .glass-tint 这层 CSS 负责

   画布与胶囊等大（不再需要 60px 外扩采样余量：着色器可以直接采样画面任意位置），
   画布后备缓冲按屏幕物理像素设置，因此 1 画布像素 = 1 屏幕像素，边缘最锐利。

   失败（无 getDisplayMedia / 无 WebGL / 取流被拒 / 着色器编译失败）时回调
   onFallback，由上层切回 CPU 液态玻璃。
*/
(function () {
  const VS = 'attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }';

  // 与 liquid-glass.js 的 SDF 模型一一对应（圆角矩形距离场 + 向外法线 + 三次衰减折射）
  const FS = [
    'precision mediump float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2  uCanvas;',       // 画布尺寸（设备像素 = 屏幕物理像素）
    'uniform vec2  uScreenOrigin;', // 画布左上角在「显示器物理像素」坐标
    'uniform vec2  uTexOrigin;',    // 纹理（裁剪后的小图）左上角在显示器物理像素坐标
    'uniform vec2  uTexSize;',      // 纹理尺寸（像素）
    'uniform vec2  uHalf;',         // 圆角矩形半宽高（设备像素）
    'uniform vec2  uCenter;',       // 圆角矩形中心（设备像素）
    'uniform float uRadius;',
    'uniform float uBand;',         // 折射带宽
    'uniform float uMaxD;',         // 最大位移
    'uniform float uBleed;',        // 渗色带宽
    'uniform float uBleedOpacity;',
    'uniform float uGlow;',         // 高光带宽
    'uniform float uSpec;',
    'uniform float uTopBoost;',
    'uniform float uBottomShade;',  // 下部渐暗强度
    'float sdRoundRect(vec2 p, vec2 c, vec2 h, float r) {',
    '  vec2 q = abs(p - c) - (h - vec2(r));',
    '  vec2 a = max(q, vec2(0.0));',
    '  return length(a) + min(max(q.x, q.y), 0.0) - r;',
    '}',
    'vec2 outwardNormal(vec2 d, vec2 q) {',
    '  vec2 a = max(q, vec2(0.0));',
    '  vec2 s = vec2(d.x >= 0.0 ? 1.0 : -1.0, d.y >= 0.0 ? 1.0 : -1.0);',
    '  if (a.x > 0.0 && a.y > 0.0) return normalize(a * s);',
    '  if (a.x > 0.0) return vec2(s.x, 0.0);',
    '  if (a.y > 0.0) return vec2(0.0, s.y);',
    '  return q.x > q.y ? vec2(s.x, 0.0) : vec2(0.0, s.y);',
    '}',
    'vec3 sampleScreen(vec2 canvasPos) {',
    '  vec2 phys = uScreenOrigin + canvasPos;', // 画布像素 = 屏幕物理像素（1:1）
    '  return texture2D(uTex, (phys - uTexOrigin) / uTexSize).rgb;',
    '}',
    'void main() {',
    // WebGL 的 y 轴朝上，这里翻成「y 向下」的屏幕坐标系（顶部高光/下部渐暗才对）
    '  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uCanvas;',
    '  float sd = sdRoundRect(p, uCenter, uHalf, uRadius);',
    '  float dist = -sd;',                       // > 0 表示在玻璃内部
    '  float alpha = 1.0 - smoothstep(-1.0, 1.0, sd);', // sd<0 在内部 → 内部不透明、边缘 1px 抗锯齿
    '  vec2 d = p - uCenter;',
    '  vec2 q = abs(d) - (uHalf - vec2(uRadius));',
    // 折射：贴边最强、向中心三次方归零（中心保持与背景 1:1）
    '  vec2 off = vec2(0.0);',
    '  if (dist > 0.0 && dist < uBand) {',
    '    float t = 1.0 - dist / uBand;',
    '    off = -outwardNormal(d, q) * uMaxD * t * t * t;',
    '  }',
    '  vec3 col = sampleScreen(p + off);',
    // 渗色：边缘环带内混入多抽样模糊（贴近真实玻璃边缘的色散/浑浊）
    '  if (dist > 0.0 && dist < uBleed) {',
    '    float k = 1.0 - smoothstep(0.0, uBleed, dist);',
    '    float r = uBleed * 0.7;',
    '    vec3 blur = sampleScreen(p + vec2(r, 0.0)) + sampleScreen(p - vec2(r, 0.0));',
    '    blur += sampleScreen(p + vec2(0.0, r)) + sampleScreen(p - vec2(0.0, r));',
    '    blur += sampleScreen(p + vec2(r, r) * 0.7) + sampleScreen(p - vec2(r, r) * 0.7);',
    '    blur /= 6.0;',
    '    col = mix(col, blur, clamp(k * uBleedOpacity, 0.0, 1.0));',
    '  }',
    // 镜面高光：必须与 CPU 链路（SVG feBlend normal）用同一种混合语义 —— alpha 混合，
    // 而不是相加。相加会把亮背景直接顶到纯白（一圈刺眼的发光白边），
    // alpha 混合则是「按比例掺白」，这才是玻璃表面该有的观感。
    '  if (dist > 0.0 && dist < uGlow) {',
    '    float g = 1.0 - smoothstep(0.0, uGlow, dist);',
    '    float s = g * uSpec;',
    '    if (p.y < uCenter.y) s = min(1.0, s + uTopBoost * g * 0.5);',
    '    col = mix(col, vec3(1.0), clamp(s, 0.0, 1.0));',
    '  }',
    // 下部渐暗（玻璃厚度感）
    '  float band = uCanvas.y * 0.36;',
    '  float by = uCanvas.y - p.y;',
    '  if (by < band) col *= 1.0 - uBottomShade * (1.0 - by / band);',
    '  gl_FragColor = vec4(col * alpha, alpha);',  // 预乘 alpha
    '}',
  ].join('\n');

  const state = {
    active: false,
    ready: false,
    video: null,
    stream: null,
    gl: null,
    program: null,
    tex: null,
    canvas: null,
    quad: null,
    uni: {},
    geom: null,      // 主进程下发的窗口/显示器几何
    fps: 30,         // 目标刷新帧率（GPU 玻璃帧率设置）
    minInterval: 33, // 绘制节流间隔（毫秒）= 1000/fps
    glowK: 1,        // 玻璃高光强度系数
    // 高级设置四项（1 = 默认）：边缘高光 / 底部阴影 / 折射强度 / 折射范围
    tune: { edgeGlow: 1, bottomShade: 1, refract: 1, band: 1 },
    stats: { frames: 0, draws: 0, skips: 0, fps: 0, lastDrawAt: 0, framesSinceReset: 0, lastResetAt: 0, resumes: 0 },
    brightCanvas: null,
    lastBrightnessAt: 0,
    lastBrightness: -1,
    lastFrameAt: 0,
    pauseTimer: null,
    rvfcId: null,
    onFallback: null,
    onBrightness: null,
    error: '',
  };

  function fail(reason) {
    if (!state.active) return;
    state.error = reason;
    stop();
    if (typeof state.onFallback === 'function') state.onFallback(reason);
  }

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader: ' + log);
    }
    return sh;
  }

  function initGl(canvas) {
    const opts = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, desynchronized: true };
    const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) throw new Error('no-webgl');
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const names = ['uTex', 'uCanvas', 'uScreenOrigin', 'uTexOrigin', 'uTexSize', 'uHalf', 'uCenter', 'uRadius', 'uBand', 'uMaxD', 'uBleed', 'uBleedOpacity', 'uGlow', 'uSpec', 'uTopBoost', 'uBottomShade'];
    const uni = {};
    for (const n of names) uni[n] = gl.getUniformLocation(program, n);
    gl.clearColor(0, 0, 0, 0);
    state.gl = gl;
    state.program = program;
    state.quad = quad;
    state.tex = tex;
    state.uni = uni;
  }

  /** 画布尺寸按屏幕物理像素（1 画布像素 = 1 屏幕像素）。
      坐标系：DOM 的 CSS 像素 = 窗口 DIP（Chromium 的 CSS 像素即 DIP），
      乘上显示器 scaleFactor 得到屏幕物理像素。
      一致性检查：正常情况下 innerWidth 应等于窗口 DIP 宽度；不一致说明页面布局
      没跟上窗口尺寸（此时 DOM 量出来的位置不可信）→ 连续多次不一致就回退 CPU 路径。 */
  function resizeCanvas() {
    const pill = document.getElementById('pill');
    if (!pill || !state.canvas) return false;
    const g = state.geom;
    if (!g) return false;
    const r = pill.getBoundingClientRect();
    const scale = g.scale || window.devicePixelRatio || 1;
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const kx = g.win.width / vw;
    const ky = g.win.height / vh;
    state.geomCheck = { kx: +kx.toFixed(3), ky: +ky.toFixed(3), rel: +((Math.abs(kx - ky) / Math.max(kx, ky)).toFixed(3)) };
    if (Math.abs(kx - 1) > 0.02 || Math.abs(ky - 1) > 0.02) {
      state.geomWarn = (state.geomWarn || 0) + 1;
      // 诊断用：SCI_GL_NO_GEOM_CHECK=1 时忽略该检查（远程会话等布局不跟随的环境）
      if (state.geomWarn === 15 && !state.noGeomCheck && typeof state.onFallback === 'function') {
        fail('geom-stale:inner=' + vw + 'x' + vh + ',win=' + g.win.width + 'x' + g.win.height);
        return false;
      }
    } else {
      state.geomWarn = 0;
    }
    const devW = Math.max(2, Math.round(r.width * scale));
    const devH = Math.max(2, Math.round(r.height * scale));
    if (state.canvas.width !== devW || state.canvas.height !== devH) {
      state.canvas.width = devW;
      state.canvas.height = devH;
      state.gl.viewport(0, 0, devW, devH);
    }
    state.rect = {
      w: devW,
      h: devH,
      half: [devW / 2, devH / 2],
      center: [devW / 2, devH / 2],
    };
    const cs = getComputedStyle(pill);
    const radiusCss = Math.min(parseFloat(cs.borderRadius) || 0, Math.min(r.width, r.height) / 2);
    state.rect.radius = Math.max(1, radiusCss * scale);
    // 画布左上角在显示器物理像素坐标（CSS 像素 = DIP）
    state.origin = {
      x: (g.win.x - g.disp.x + r.left) * scale,
      y: (g.win.y - g.disp.y + r.top) * scale,
    };
    // 光学参数按真实高度自适应（与 liquid-glass.js 同一套公式，单位为物理像素）
    const hPhys = r.height * scale;
    const glowK = typeof state.glowK === 'number' ? state.glowK : 1;
    const t = state.tune || {};
    const k = (v) => (typeof v === 'number' && isFinite(v) ? v : 1);
    // 高级设置里的四项（100% = 默认观感）：只缩放本链路（GPU 着色器），不影响 CPU 链路
    const edgeK = k(t.edgeGlow);
    const shadeK = k(t.bottomShade);
    const refractK = k(t.refract);
    const bandK = k(t.band);
    state.opts = {
      band: Math.max(3, Math.min(96, hPhys * 0.2 * bandK)),
      maxD: Math.max(0, Math.min(40, hPhys * 0.07 * refractK)),
      bleed: Math.max(3, Math.min(10, hPhys * 0.15 * Math.min(1, bandK))),
      bleedOpacity: 0.7,
      glow: Math.max(1.5, Math.min(14, hPhys * 0.1 * Math.min(1.5, bandK))),
      // 高光强度系数（0 = 无高光，1 = 默认）：与 CPU 链路同源，只缩放高光层
      spec: 0.72 * glowK * edgeK,
      topBoost: 0.5 * glowK * edgeK,
      bottomShade: 0.2 * shadeK,
    };
    return true;
  }

  /**
   * 把视频里「小岛附近」的那一小块裁出来再上传纹理。
   * 直接上传整帧 1920×1080 每帧要搬 8MB（30fps 就是 240MB/s），是这条链路最大的开销；
   * 只裁胶囊 + 边缘余量后仅约 0.15MB，drawImage 本身是 GPU 侧缩放/拷贝（很快）。
   */
  function uploadFrame() {
    const gl = state.gl;
    const v = state.video;
    const c = state.rect;
    if (!v.videoWidth || !c) return false;
    const scale = (state.geom && state.geom.scale) || 1;
    // 视频帧尺寸 ↔ 显示器物理像素的比例（宽度可能被 Chromium 缩放过）
    const kx = v.videoWidth / Math.max(1, state.geom.disp.w * scale);
    const ky = v.videoHeight / Math.max(1, state.geom.disp.h * scale);
    const margin = Math.ceil(Math.max(state.opts.band, state.opts.bleed, state.opts.glow) + 6);
    const sx = Math.floor(state.origin.x - margin);
    const sy = Math.floor(state.origin.y - margin);
    const sw = Math.ceil(c.w + margin * 2);
    const sh = Math.ceil(c.h + margin * 2);
    // 显示器范围内的有效区域（贴边时会被裁）
    const cx0 = Math.max(0, Math.min(v.videoWidth - 1, Math.floor(sx * kx)));
    const cy0 = Math.max(0, Math.min(v.videoHeight - 1, Math.floor(sy * ky)));
    const cx1 = Math.max(cx0 + 1, Math.min(v.videoWidth, Math.ceil((sx + sw) * kx)));
    const cy1 = Math.max(cy0 + 1, Math.min(v.videoHeight, Math.ceil((sy + sh) * ky)));
    const cw = cx1 - cx0;
    const chh = cy1 - cy0;
    let crop = state.crop;
    if (!crop) {
      crop = document.createElement('canvas');
      state.crop = crop;
    }
    if (crop.width !== cw || crop.height !== chh) {
      crop.width = cw;
      crop.height = chh;
    }
    const ctx = state.cropCtx || (state.cropCtx = crop.getContext('2d', { alpha: false, desynchronized: true }));
    if (!ctx) return false;
    ctx.drawImage(v, cx0, cy0, cw, chh, 0, 0, cw, chh);
    gl.bindTexture(gl.TEXTURE_2D, state.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, crop);
    // 纹理左上角对应的显示器物理像素坐标
    state.texOrigin = { x: cx0 / kx, y: cy0 / ky };
    state.texSize = { w: cw / kx, h: chh / ky };
    state.uploadedBytes = cw * chh * 4;
    return true;
  }

  function draw() {
    const gl = state.gl;
    if (!gl || !state.video || !state.rect || !state.geom) return false;
    const vw = state.video.videoWidth;
    const vh = state.video.videoHeight;
    if (!(vw > 0 && vh > 0)) return false;
    const o = state.opts;
    const t0 = performance.now();
    if (!uploadFrame()) return false;
    const t1 = performance.now();
    gl.uniform1i(state.uni.uTex, 0);
    gl.uniform2f(state.uni.uCanvas, state.rect.w, state.rect.h);
    gl.uniform2f(state.uni.uScreenOrigin, state.origin.x, state.origin.y);
    gl.uniform2f(state.uni.uTexOrigin, state.texOrigin.x, state.texOrigin.y);
    gl.uniform2f(state.uni.uTexSize, state.texSize.w, state.texSize.h);
    gl.uniform2f(state.uni.uHalf, state.rect.half[0], state.rect.half[1]);
    gl.uniform2f(state.uni.uCenter, state.rect.center[0], state.rect.center[1]);
    gl.uniform1f(state.uni.uRadius, state.rect.radius);
    gl.uniform1f(state.uni.uBand, o.band);
    gl.uniform1f(state.uni.uMaxD, o.maxD);
    gl.uniform1f(state.uni.uBleed, o.bleed);
    gl.uniform1f(state.uni.uBleedOpacity, o.bleedOpacity);
    gl.uniform1f(state.uni.uGlow, o.glow);
    gl.uniform1f(state.uni.uSpec, o.spec);
    gl.uniform1f(state.uni.uTopBoost, o.topBoost);
    gl.uniform1f(state.uni.uBottomShade, o.bottomShade);
    gl.viewport(0, 0, state.rect.w, state.rect.h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const t2 = performance.now();
    const st = state.stats;
    st.draws += 1;
    st.lastDrawAt = Date.now();
    // 每帧成本（指数滑动平均）：上传 + 着色。跟手问题基本由这里的耗时与实际帧率决定
    st.uploadMs = st.uploadMs == null ? t1 - t0 : st.uploadMs * 0.9 + (t1 - t0) * 0.1;
    st.drawMs = st.drawMs == null ? t2 - t1 : st.drawMs * 0.9 + (t2 - t1) * 0.1;
    if (st.draws > 1) {
      const gap = t0 - (st.prevDrawAt || t0);
      st.gapMs = st.gapMs == null ? gap : st.gapMs * 0.9 + gap * 0.1;
      if (gap > (st.gapMaxMs || 0)) st.gapMaxMs = gap;
    }
    st.prevDrawAt = t0;
    return true;
  }

  /** 背景亮度：把视频缩到 32×32 再取像素平均（GPU 缩放 + 4KB 回读，代价可忽略） */
  function updateBrightness() {
    const now = Date.now();
    if (now - state.lastBrightnessAt < 400) return;
    state.lastBrightnessAt = now;
    try {
      const v = state.video;
      if (!state.brightCanvas) {
        state.brightCanvas = document.createElement('canvas');
        state.brightCanvas.width = 32;
        state.brightCanvas.height = 32;
      }
      const c = state.brightCanvas;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx || !v.videoWidth) return;
      const g = state.geom;
      // 只取小岛背后那一小块（与窗口等大）
      const sx = Math.max(0, (g.win.x - g.disp.x) * g.scale * (v.videoWidth / (g.disp.w * g.scale)));
      const sy = Math.max(0, (g.win.y - g.disp.y) * g.scale * (v.videoHeight / (g.disp.h * g.scale)));
      const sw = Math.max(1, g.win.width * g.scale * (v.videoWidth / (g.disp.w * g.scale)));
      const sh = Math.max(1, g.win.height * g.scale * (v.videoHeight / (g.disp.h * g.scale)));
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, 16, 16);
      const data = ctx.getImageData(0, 0, 16, 16).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
      }
      const b = sum / (data.length / 4);
      state.lastBrightnessComputed = b;
      if (Math.abs(b - state.lastBrightness) >= 0.012) {
        state.lastBrightness = b;
        if (typeof state.onBrightness === 'function') state.onBrightness(b);
      }
    } catch (e) {
      state.brightnessErr = String(e && e.message ? e.message : e);
      /* 亮度失败不影响玻璃渲染 */
    }
  }

  /** 该不该画（与 CPU 路径的显示条件保持一致：形态 + 动画 + 等新帧） */
  function shouldDraw() {
    if (!state.active) return false;
    const st = document.body.dataset.state;
    const strip = document.body.dataset.strip;
    if (st === 'expanded' || st === 'zoom') return document.body.dataset.anim !== '1';
    if (st === 'strip') return strip === 'glass' && document.body.dataset.anim !== '1';
    return false;
  }

  /**
   * 视频流是「推送式」的：不需要玻璃时（黑底细条 / 通知 / 动画中）让它一直解码
   * 与采集纯属浪费，因此暂停视频；恢复由独立的看门狗定时器负责
   * （暂停后 requestVideoFrameCallback 不再回调，必须另有恢复路径）。
   */
  function watchdog() {
    if (!state.active || !state.video) return;
    const now = Date.now();
    const want = shouldDraw();
    const track = state.stream && state.stream.getVideoTracks ? state.stream.getVideoTracks()[0] : null;
    if (want) {
      state.pausedAt = 0;
      if (state.streamPaused) {
        state.streamPaused = false;
        state.stats.resumes += 1;
        try {
          if (track) track.enabled = true; // 恢复取帧
          state.video.play();
        } catch (e) {
          /* ignore */
        }
      }
      return;
    }
    if (!state.pausedAt) state.pausedAt = now;
    if (now - state.pausedAt > 1200 && !state.streamPaused) {
      state.streamPaused = true;
      try {
        state.video.pause();
        // 只暂停 video 元素，采集服务仍会继续下发帧；轨道禁用后才会真正停下来
        if (track && track.enabled) track.enabled = false;
      } catch (e) {
        /* ignore */
      }
    }
  }

  function onFrame() {
    if (!state.active) return;
    const v = state.video;
    state.stats.frames += 1;
    const now = Date.now();
    // 采集帧到达率（1 秒窗口）：判断「不跟手」到底是采集供不上帧，还是自己画得慢
    if (!state.arrivalResetAt) state.arrivalResetAt = now;
    state.arrivalCount = (state.arrivalCount || 0) + 1;
    if (now - state.arrivalResetAt >= 1000) {
      state.stats.arrivalFps = Math.round((state.arrivalCount * 1000) / (now - state.arrivalResetAt));
      state.arrivalCount = 0;
      state.arrivalResetAt = now;
    }
    // 绘制节流：按「GPU 玻璃帧率」设置（1–60fps）；视频流可能更快，多余的帧直接跳过。
    // 节流必须用高精度时钟：Date.now() 在 Windows 上粒度约 15.6ms，
    // 60fps（17ms）会被量化成 ~31ms 一跳且抖动，看起来就是"不跟手"。
    const tnow = performance.now();
    if (tnow - state.lastFrameAt < state.minInterval) {
      state.stats.skips += 1;
    } else {
      state.lastFrameAt = tnow;
      if (shouldDraw() && draw()) updateBrightness();
    }
    const since = now - state.stats.lastResetAt;
    if (since >= 2000) {
      state.stats.fps = Math.round((state.stats.framesSinceReset * 1000) / since);
      state.stats.framesSinceReset = 0;
      state.stats.lastResetAt = now;
      state.stats.fps = Math.max(state.stats.fps, 0);
    }
    state.stats.framesSinceReset += 1;
    if (typeof v.requestVideoFrameCallback === 'function') {
      state.rvfcId = v.requestVideoFrameCallback(onFrame);
    } else {
      state.rvfcId = setTimeout(onFrame, 33);
    }
  }

  /** 采流并启动渲染循环 */
  async function start(canvas, callbacks) {
    stop();
    state.canvas = canvas;
    state.onFallback = (callbacks && callbacks.onFallback) || null;
    state.onBrightness = (callbacks && callbacks.onBrightness) || null;
    state.noGeomCheck = !!(callbacks && callbacks.noGeomCheck);
    // 目标帧率必须在取流之前设定，才能写进 getDisplayMedia 的约束
    if (callbacks && typeof callbacks.fps === 'number') {
      state.fps = Math.max(1, Math.min(60, Math.round(callbacks.fps)));
      state.minInterval = Math.max(1, Math.round(1000 / state.fps));
    }
    state.geomWarn = 0;
    state.error = '';
    state.active = true;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      fail('no-getDisplayMedia');
      return false;
    }
    try {
      initGl(canvas);
    } catch (e) {
      fail('webgl-init:' + e.message);
      return false;
    }
    let stream;
    try {
      // 帧率由「GPU 玻璃帧率」设置决定（视频流是推送式的，帧率越高采集服务越贵；
      // 上传只裁窗口附近一小块，数据量很小）
      const want = Math.max(1, Math.min(60, state.fps || 30));
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: want, max: Math.min(60, want + 5) } },
        audio: false,
      });
    } catch (e) {
      fail('getDisplayMedia:' + (e && e.name ? e.name : e));
      return false;
    }
    if (!state.active) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    state.stream = stream;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    state.video = video;
    video.srcObject = stream;
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('ended', () => fail('track-ended'));
    }
    try {
      await video.play();
    } catch (e) {
      fail('video-play');
      return false;
    }
    state.stats.lastResetAt = Date.now();
    state.stats.framesSinceReset = 0;
    if (typeof video.requestVideoFrameCallback === 'function') {
      state.rvfcId = video.requestVideoFrameCallback(onFrame);
    } else {
      state.rvfcId = setTimeout(onFrame, 33);
    }
    // 看门狗：负责「不需要玻璃时暂停 / 需要时恢复」（暂停后帧回调不再触发）
    clearInterval(state.watchdogId);
    state.watchdogId = setInterval(watchdog, 300);
    return true;
  }

  function stop() {
    state.active = false;
    state.ready = false;
    clearInterval(state.watchdogId);
    state.watchdogId = null;
    state.streamPaused = false;
    state.pausedAt = 0;
    if (state.rvfcId != null) {
      try {
        if (state.video && typeof state.video.cancelVideoFrameCallback === 'function' && typeof state.rvfcId === 'number') {
          state.video.cancelVideoFrameCallback(state.rvfcId);
        } else {
          clearTimeout(state.rvfcId);
        }
      } catch (e) {
        /* ignore */
      }
      state.rvfcId = null;
    }
    if (state.stream) {
      try {
        state.stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        /* ignore */
      }
    }
    if (state.video) {
      try {
        state.video.srcObject = null;
      } catch (e) {
        /* ignore */
      }
    }
    state.stream = null;
    state.video = null;
    if (state.gl && state.canvas) {
      try {
        const gl = state.gl;
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } catch (e) {
        /* ignore */
      }
    }
  }

  window.GlassWebGL = {
    start,
    stop,
    draw,
    resize: resizeCanvas,
    stats: () => ({
      ...state.stats,
      error: state.error,
      active: state.active,
      videoW: state.video ? state.video.videoWidth : 0,
      videoH: state.video ? state.video.videoHeight : 0,
      geom: state.geomCheck || null,
      origin: state.origin || null,
      backing: state.canvas ? state.canvas.width + 'x' + state.canvas.height : null,
      brightness: state.lastBrightness,
      brightnessComputed: state.lastBrightnessComputed,
      brightnessErr: state.brightnessErr || '',
      streamPaused: !!state.streamPaused,
      resumes: state.stats.resumes || 0,
      uploadedBytes: state.uploadedBytes || 0,
      arrivalFps: state.stats.arrivalFps || 0,
      uploadMs: state.stats.uploadMs != null ? +state.stats.uploadMs.toFixed(2) : null,
      drawMs: state.stats.drawMs != null ? +state.stats.drawMs.toFixed(2) : null,
      gapMs: state.stats.gapMs != null ? +state.stats.gapMs.toFixed(1) : null,
      gapMaxMs: state.stats.gapMaxMs ? +state.stats.gapMaxMs.toFixed(0) : null,
      crop: state.crop ? state.crop.width + 'x' + state.crop.height : null,
      targetFps: state.fps,
      minIntervalMs: state.minInterval,
      appliedFps: state.stats.appliedFps || state.fps,
      tune: Object.assign({}, state.tune),
      opts: Object.assign({}, state.opts),
    }),
    isActive: () => state.active,
    /** 主进程下发的窗口/显示器几何（DIP + 缩放） */
    setGeom(geom) {
      if (!geom) return;
      const moved = !state.geom || state.geom.win.x !== geom.win.x || state.geom.win.y !== geom.win.y || state.geom.win.width !== geom.win.width || state.geom.win.height !== geom.win.height;
      state.geom = geom;
      state.lastBrightnessAt = 0; // 立刻重算一次亮度
      resizeCanvas();
      // 几何变了要立刻用「当前这一帧」重画：否则要等下一个视频帧（最长 1/fps + 采集延迟），
      // 窗口缩放/移动时会明显"不跟手"。这里同时复位节流计时，保证这一帧不被丢。
      if (moved) {
        state.lastFrameAt = 0;
        if (shouldDraw()) draw();
      }
    },
    /** 玻璃高光强度系数（0–2）：重算光学参数并立即重绘 */
    setGlowK(k) {
      const v = Math.max(0, Math.min(2, typeof k === 'number' ? k : 1));
      if (state.glowK === v) return;
      state.glowK = v;
      resizeCanvas();
      if (shouldDraw()) draw();
    },
    glowK: () => (typeof state.glowK === 'number' ? state.glowK : 1),
    /**
     * 高级设置的四项观感微调（1 = 默认；只影响 GPU 着色器）：
     *   edgeGlow    边缘高光强度（<1 更收敛，0 = 无高光）
     *   bottomShade 底部阴影强度（0 = 不压暗）
     *   refract     边缘折射强度（最大位移量）
     *   band        边缘折射范围（折射带宽）
     */
    setTune(tune) {
      if (!tune) return;
      const clamp = (v, def) => Math.max(0, Math.min(3, typeof v === 'number' && isFinite(v) ? v : def));
      const next = {
        edgeGlow: clamp(tune.edgeGlow, state.tune.edgeGlow),
        bottomShade: clamp(tune.bottomShade, state.tune.bottomShade),
        refract: clamp(tune.refract, state.tune.refract),
        band: clamp(tune.band, state.tune.band),
      };
      const changed = Object.keys(next).some((k) => next[k] !== state.tune[k]);
      if (!changed) return;
      state.tune = next;
      resizeCanvas();
      if (shouldDraw()) draw();
    },
    tune: () => Object.assign({}, state.tune),
    /**
     * 设置目标刷新帧率（1–60）。两处同时生效：
     *  1) 绘制节流间隔（多余帧直接跳过，不重复上传纹理）
     *  2) 视频轨道的 frameRate 约束（降低采集服务的开销；失败则只靠节流）
     */
    setFps(fps) {
      const v = Math.max(1, Math.min(60, Math.round(typeof fps === 'number' && fps > 0 ? fps : 30)));
      const changed = state.fps !== v;
      state.fps = v;
      state.minInterval = Math.max(1, Math.round(1000 / v));
      if (!changed) return;
      const track = state.stream && state.stream.getVideoTracks ? state.stream.getVideoTracks()[0] : null;
      if (track && track.applyConstraints) {
        track.applyConstraints({ frameRate: { ideal: v, max: Math.min(60, v + 5) } }).catch(() => {
          state.stats.constraintFail = (state.stats.constraintFail || 0) + 1;
        });
      }
      state.stats.appliedFps = v;
    },
    fps: () => state.fps,
    minInterval: () => state.minInterval,
    redraw() {
      resizeCanvas();
      state.lastFrameAt = 0; // 立刻重画，不受帧率节流限制
      if (shouldDraw()) draw();
    },
  };
})();
