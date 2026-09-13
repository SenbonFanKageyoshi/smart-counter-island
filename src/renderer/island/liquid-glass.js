'use strict';
/* ===== 液态玻璃滤镜（升级「真实模糊」模式） =====
   物理模型（参照真实玻璃片的厚度与曲面边缘）：
     · 中心区域完全平整 —— 透过它看背景无任何扭曲、无模糊，保持原始清晰度
     · 沿边缘（两端半圆 + 上下直边最外侧）存在一条狭窄折射带：背景图像向
       外侧发生光学偏移（类似凸透镜边缘弯曲），文字图案被拉伸偏离
     · 折射强度从边缘向中心迅速衰减，形成平滑过渡带
   管线：
     1. feDisplacementMap：只对边缘窄带做向中心收缩采样（= 边缘内容被拉伸
        放大），中心位移为 0（清晰）
     2. 边缘渗色（bleed）：小半径模糊背景裁到边缘环带，低透明度叠回 —— 边缘
        玻璃感（中心掩码透明，不影响中心清晰度）
     3. 镜面高光（spec）：边缘内侧一圈白高光，顶部略强 —— 实体/立体感
   滤镜资源（折射位移图/渗色掩码/高光图）只与窗口几何有关 → 窗口尺寸变化时
   重建；截屏刷新只更新背景图。异常环境返回 false，调用方回退 CSS blur。
*/
(function () {
  // 圆角矩形 SDF：内部 < 0
  function sdRoundRect(x, y, cx, cy, hw, hh, r) {
    const qx = Math.abs(x - cx) - (hw - r);
    const qy = Math.abs(y - cy) - (hh - r);
    const ax = Math.max(qx, 0);
    const ay = Math.max(qy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
  }
  function smoothstep(t) {
    return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  }
  function clamp255(v) {
    return Math.max(0, Math.min(255, v));
  }

  /**
   * SDF 向外法线：返回该点指向玻璃外侧的单位向量。
   * 半圆角区用 (ax, ay) 归一化后恢复象限符号；上下直边 (0, ±1)、
   * 左右直边 (±1, 0)；圆角与直边之间的过渡区按主导分量取轴。
   * 用「局部法线」而非「中心径向」——直边与弧线衔接处的折射方向才正确
   * （径向在直边两端是斜的，会让折射方向扭曲）。
   */
  function sdOutwardNormal(px, py, qx, qy, ax, ay) {
    const sx = px >= 0 ? 1 : -1;
    const sy = py >= 0 ? 1 : -1;
    if (ax > 0 && ay > 0) {
      const len = Math.hypot(ax, ay) || 1;
      return [sx * (ax / len), sy * (ay / len)];
    }
    if (ax > 0) return [sx, 0];
    if (ay > 0) return [0, sy];
    return qx > qy ? [sx, 0] : [0, sy]; // 中心直边过渡区
  }

  /**
   * 折射位移图：R/G 通道编码 x/y 位移（128 = 无位移）。
   * 物理模型（真实玻璃片的厚度 + 曲面边缘）：
     · 中心区域位移 = 0 —— 光线直线传播，透过玻璃看到的画面与原画面 1:1，
       无任何扭曲
     · 沿边缘的窄折射带：按 SDF 向外法线方向做**反向采样偏移**（内容被向外
       推、形成凸透镜边缘的拉伸弯曲感）
     · 强度三次衰减 t = (1 - dist/BAND)³ —— 边缘最强、向中心迅速平滑归零
   * 过渡带宽与最大位移按玻璃高度自适应（BAND≈34%高、MAXD≈7%高），对应真实
     玻璃的厚度比例；SCALE ≥ 4×MAXD 保证位移通道编码不溢出。
   */
  function makeRefractionMap(w, h, rect, o) {
    // 位移图按设备像素比生成：背景图是物理像素 1:1，若位移场只有 CSS 像素
    // 分辨率，放大后量化误差会呈现"马赛克"块状。提高位移场分辨率后，
    // feDisplacementMap 采样更平滑。
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(w * dpr));
    c.height = Math.max(2, Math.round(h * dpr));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(c.width, c.height);
    const data = img.data;
    // 空间量（中心、半径、过渡带宽）用设备像素；位移量（maxD）保持 CSS px，
    // 因为 feDisplacementMap 的 scale 以 CSS px 为单位。
    const cx = (rect.x + rect.w / 2) * dpr;
    const cy = (rect.y + rect.h / 2) * dpr;
    const hw = Math.max(1, (rect.w / 2) * dpr);
    const hh = Math.max(1, (rect.h / 2) * dpr);
    const r = Math.max(0.5, rect.r * dpr);
    // 折射带宽度/最大位移按玻璃高度自适应。下限必须足够小：细条（灵动岛）
    // 高度只有 26px 上下，若沿用 6px 的下限，整条细条都会被折射带覆盖并推开，
    // 看起来像"糊成一团"。
    const band = Math.max(3, Math.min(64, o.refractWidth || Math.round(rect.h * 0.2))) * dpr;
    const maxD = Math.max(2, Math.min(18, o.maxRefract || Math.round(rect.h * 0.07)));
    const scale = Math.max(24, Math.round(maxD * 4));
    const amp = 255 / scale;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        let vx = 128;
        let vy = 128;
        const px = x + 0.5 - cx;
        const py = y + 0.5 - cy;
        const qx = Math.abs(px) - (hw - r);
        const qy = Math.abs(py) - (hh - r);
        const ax = Math.max(qx, 0);
        const ay = Math.max(qy, 0);
        const sd = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r; // 内 < 0
        if (sd < 0) {
          const dist = -sd; // 到最近边缘的距离
          if (dist < band) {
            const s = 1 - dist / band; // 边缘 1 → 内边界 0
            const t = s * s * s; // 三次衰减：中心极快归零，中心保持 1:1
            if (t > 0.002) {
              const nrm = sdOutwardNormal(px, py, qx, qy, ax, ay);
              const amount = maxD * t;
              // 采样取法线反方向 → 内容向外侧推出（凸透镜边缘外推）
              const ox = -nrm[0] * amount;
              const oy = -nrm[1] * amount;
              vx = clamp255(128 + ox * amp);
              vy = clamp255(128 + oy * amp);
            }
          }
        }
        data[i] = vx;
        data[i + 1] = vy;
        data[i + 2] = 128;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  /**
   * 边缘渗色掩码：沿玻璃边缘内侧的环带，白=渗色最强、向内渐隐到透明。
   * 只影响边缘（中心掩码透明），不影响中心清晰度。
   */
  function makeBleedMap(w, h, rect, o) {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(w * dpr));
    c.height = Math.max(2, Math.round(h * dpr));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(c.width, c.height);
    const data = img.data;
    const cx = (rect.x + rect.w / 2) * dpr;
    const cy = (rect.y + rect.h / 2) * dpr;
    const hw = (rect.w / 2) * dpr;
    const hh = (rect.h / 2) * dpr;
    const r = Math.max(0.5, rect.r * dpr);
    const bleedW = Math.max(3, Math.min(10, o.bleedWidth || Math.round(rect.h * 0.15))) * dpr;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        let a = 0;
        const sd = sdRoundRect(x, y, cx, cy, hw, hh, r);
        if (sd < 0 && sd > -bleedW) {
          a = 1 - smoothstep(-sd / bleedW); // 贴边最强
        }
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = Math.round(clamp255(a * 255));
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  /**
   * 镜面高光图：沿玻璃边缘内侧一圈白色高光（顶部略强，模拟顶光源）。
   */
  function makeSpecularMap(w, h, rect, o) {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(w * dpr));
    c.height = Math.max(2, Math.round(h * dpr));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(c.width, c.height);
    const data = img.data;
    const cx = (rect.x + rect.w / 2) * dpr;
    const cy = (rect.y + rect.h / 2) * dpr;
    const hw = (rect.w / 2) * dpr;
    const hh = (rect.h / 2) * dpr;
    const r = Math.max(0.5, rect.r * dpr);
    // 高光带宽度同样按高度自适应：固定 6px 在 26px 高的细条上会糊掉整条边缘
    const glow = Math.max(1.5, Math.min(8, o.glow || rect.h * 0.1)) * dpr;
    // 高光强度系数（0 = 完全无高光，1 = 默认）：只缩放高光层，折射/渗色基色不变
    const glowK = typeof o.glowK === 'number' ? Math.max(0, Math.min(2, o.glowK)) : 1;
    const specOpacity = o.specOpacity * glowK;
    const topBoost = o.topBoost * glowK;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        let a = 0;
        const sd = sdRoundRect(x, y, cx, cy, hw, hh, r);
        if (sd < 0 && sd > -glow) {
          const t = 1 - smoothstep(-sd / glow); // 贴边最亮
          a = t * specOpacity;
          if (y < cy) a = Math.min(1, a + topBoost * (1 + sd / glow) * 0.5); // 上半缘增强
        }
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = Math.round(clamp255(a * 255));
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  /**
   * 组装/更新液态玻璃滤镜并应用到 #glass。
   * @param {string} filterId SVG <filter> id
   * @param {object} rect pill 显示区在 #glass 局部坐标的圆角矩形 {x,y,w,h,r}
   * @param {object} opts 可选参数覆盖
   * @returns {boolean} 是否成功
   */
  function apply(filterId, rect, opts) {
    const o = Object.assign(
      {
        // 折射：0 = 按玻璃高度自适应用（BAND≈20%高、MAXD≈7%高）
        refractWidth: 0, maxRefract: 0,
        // 渗色/高光：0 = 按玻璃高度自适应（细条这类很小的玻璃必须收窄，
        // 否则整条边缘都被渗色和高光糊住）
        bleedWidth: 0, bleedBlur: 0, bleedOpacity: 0.7,
        // glowK：高光强度系数（0 = 无高光，1 = 默认），由「玻璃高光强度」设置驱动
        glow: 0, specOpacity: 0.72, topBoost: 0.5, glowK: 1,
      },
      opts || {}
    );
    const gEl = document.getElementById('glass');
    if (!gEl || !window.SVGElement || !window.CanvasRenderingContext2D) return false;
    const b = gEl.getBoundingClientRect();
    const w = Math.round(b.width);
    const h = Math.round(b.height);
    if (!(w > 2 && h > 2 && w < 4000 && h < 4000)) return false;

    const disp = makeRefractionMap(w, h, rect, o);
    const bleed = makeBleedMap(w, h, rect, o);
    const spec = makeSpecularMap(w, h, rect, o);
    if (!disp || !bleed || !spec) return false;

    // feDisplacementMap 的 scale 必须与位移图编码时的 SCALE 完全一致，
    // 否则位移量会被二次缩放（折射强度错误），故按同一公式重算。
    const maxD = Math.max(2, Math.min(18, o.maxRefract || Math.round(rect.h * 0.07)));
    const scale = Math.max(24, Math.round(maxD * 4));
    // 渗色模糊半径同样按高度自适应（细条上 12px 的模糊会糊掉整条边缘）
    const bleedBlur = Math.max(4, Math.min(12, o.bleedBlur || Math.round(rect.h * 0.18)));

    // filter 结构变更（含 refract scale）或首次：整体重建
    let svg = document.getElementById('lg-svg');
    const needRebuild =
      !svg ||
      !document.getElementById('lg-bleed') ||
      svg.getAttribute('data-scale') !== String(scale) ||
      svg.getAttribute('data-w') !== String(w) ||
      svg.getAttribute('data-h') !== String(h);
    if (needRebuild) {
      if (svg && svg.parentNode) svg.parentNode.removeChild(svg);
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('id', 'lg-svg');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.setAttribute('data-scale', String(scale));
      svg.setAttribute('data-w', String(w));
      svg.setAttribute('data-h', String(h));
      svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
      document.body.appendChild(svg);
      // filter 显式限定 region = 玻璃元素盒：SVG filter 默认 region 比对象大 10%，
      // 输出会溢出 #glass 盒外 → pill 圆角外露方形边。
      svg.innerHTML =
        `<defs><filter id="${filterId}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
        // 资源图：折射位移 / 渗色掩码 / 镜面高光（像素坐标对齐元素）
        `<feImage id="lg-disp" href="" result="disp" preserveAspectRatio="none" x="0" y="0" width="${w}" height="${h}"/>` +
        `<feImage id="lg-bleed" href="" result="bleedMask" preserveAspectRatio="none" x="0" y="0" width="${w}" height="${h}"/>` +
        `<feImage id="lg-spec" href="" result="spec" preserveAspectRatio="none" x="0" y="0" width="${w}" height="${h}"/>` +
        // ① 边缘折射：中心零位移（1:1 清晰），边缘带按 SDF 法线向外推
        `<feDisplacementMap in="SourceGraphic" in2="disp" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="refracted"/>` +
        // ② 边缘渗色：小半径模糊背景 → 裁到边缘环带 → 降透明度 → 叠回
        `<feGaussianBlur in="SourceGraphic" stdDeviation="${bleedBlur}" result="bleedSrc"/>` +
        `<feComposite in="bleedSrc" in2="bleedMask" operator="in" result="bleedEdge"/>` +
        `<feComponentTransfer in="bleedEdge" result="bleedFaded"><feFuncA type="linear" slope="${o.bleedOpacity}"/></feComponentTransfer>` +
        `<feBlend in="refracted" in2="bleedFaded" mode="normal" result="withBleed"/>` +
        // ③ 镜面高光
        `<feBlend in="withBleed" in2="spec" mode="normal"/>` +
        `</filter></defs>`;
    }
    const setImg = (id, href) => {
      const el = document.getElementById(id);
      if (el) {
        el.setAttribute('href', href);
        el.setAttribute('width', w);
        el.setAttribute('height', h);
      }
    };
    setImg('lg-disp', disp);
    setImg('lg-bleed', bleed);
    setImg('lg-spec', spec);
    gEl.style.filter = `url(#${filterId})`;
    return true;
  }

  window.LiquidGlass = { apply, FILTER_ID: 'lg-filter' };
})();
