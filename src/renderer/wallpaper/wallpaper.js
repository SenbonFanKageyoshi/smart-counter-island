'use strict';
/* 壁纸生成页：在隐藏窗口里按要求把壁纸画到 Canvas，回传 base64 PNG。
   （不在主进程里画图，是为了能直接复用 CSS/Canvas 的排版能力，且不引入任何依赖） */
(function () {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');

  function fitBox(img, w, h, mode) {
    const ir = img.width / img.height;
    const cr = w / h;
    let dw;
    let dh;
    const cover = mode !== 'contain';
    if (cover ? ir > cr : ir <= cr) {
      dh = h;
      dw = h * ir;
    } else {
      dw = w;
      dh = w / ir;
    }
    if (!cover) {
      // 完整显示：可能窄于/矮于画布，靠居中留边（留边处由底色填充）
      if (dw > w) {
        dh = (dh * w) / dw;
        dw = w;
      }
      if (dh > h) {
        dw = (dw * h) / dh;
        dh = h;
      }
    }
    return { dx: (w - dw) / 2, dy: (h - dh) / 2, dw, dh };
  }

  /** 按画布宽度断行（中文按字断、英文按词断），最多 maxLines 行，超出加省略号 */
  function wrapText(text, maxWidth, maxLines) {
    const lines = [];
    for (const para of String(text).split(/\r?\n/)) {
      let line = '';
      const tokens = para.match(/[\u4e00-\u9fff。，、；：！？（）“”‘’]|[A-Za-z0-9'’\-]+|\s+|./g) || [];
      for (const tk of tokens) {
        const test = line + tk;
        if (ctx.measureText(test).width > maxWidth && line) {
          lines.push(line.trimEnd());
          line = tk.trimStart();
        } else {
          line = test;
        }
      }
      lines.push(line.trimEnd());
    }
    if (lines.length > maxLines) {
      const cut = lines.slice(0, maxLines);
      let last = cut[maxLines - 1];
      while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
      cut[maxLines - 1] = last + '…';
      return cut;
    }
    return lines;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  async function render(job) {
    const w = Math.max(320, Math.round(job.width || 1920));
    const h = Math.max(240, Math.round(job.height || 1080));
    canvas.width = w;
    canvas.height = h;
    const s = Math.max(0.4, Math.min(2.5, (job.scale || 100) / 100));

    /* ① 背景：用户提供的图片优先（上面只加文字），没有图片时用内置渐变兜底 */
    let hasImage = false;
    if (job.bgType === 'image' && job.bgImage) {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('bg-load-failed'));
        im.src = job.bgImage;
      });
      // 留边填充用的底色（contain 模式）
      ctx.fillStyle = '#0b0f16';
      ctx.fillRect(0, 0, w, h);
      const f = fitBox(img, w, h, job.fit);
      ctx.drawImage(img, f.dx, f.dy, f.dw, f.dh);
      hasImage = true;
    } else {
      const cols = Array.isArray(job.bgColor) && job.bgColor.length >= 3 ? job.bgColor : ['#141e30', '#243b55', '#3a6186'];
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, cols[0]);
      g.addColorStop(0.55, cols[1]);
      g.addColorStop(1, cols[2]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // 淡淡的斜向光带，避免纯渐变的"塑料感"
      const g2 = ctx.createLinearGradient(0, h, w, 0);
      g2.addColorStop(0, 'rgba(255,255,255,0.06)');
      g2.addColorStop(0.5, 'rgba(255,255,255,0.015)');
      g2.addColorStop(1, 'rgba(255,255,255,0.05)');
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, w, h);
    }
    // 图片背景：整体压暗一点点（只影响观感，保证文字可读；渐变背景已足够深）
    if (hasImage) {
      ctx.fillStyle = `rgba(0,0,0,${typeof job.dim === 'number' ? job.dim : 0.32})`;
      ctx.fillRect(0, 0, w, h);
    }
    // 四周暗角
    const vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, `rgba(0,0,0,${hasImage ? 0.35 : 0.45})`);
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);

    /* ② 布局：先按画布宽度把语录断行量好，再决定文字块的锚点
       （多行语录要参与定位，否则容易顶出画面） */
    const base = Math.round(Math.min(w, h) * 0.075 * s); // 主字号随分辨率自适应
    const pad = Math.round(Math.min(w, h) * 0.08);
    ctx.font = `800 ${base}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`;
    const quoteLines = job.quote ? wrapText(String(job.quote), w * 0.86, 3) : [];
    const qLh = base * 1.28;
    const qBlockH = quoteLines.length ? qLh * quoteLines.length : 0;
    let cx = w / 2;
    let align = 'center';
    if (job.position === 'bottom-left') {
      cx = pad;
      align = 'left';
    } else if (job.position === 'bottom-right') {
      cx = w - pad;
      align = 'right';
    }
    let quoteY;
    if (job.position === 'top-center') {
      quoteY = pad + qBlockH / 2;
    } else if (job.position === 'center') {
      quoteY = h / 2;
    } else {
      // 底部：整块贴住下边距
      quoteY = h - pad - qBlockH / 2;
    }
    ctx.textAlign = align === 'center' ? 'center' : align;
    ctx.textBaseline = 'middle';
    /** 语录块第一行的 baseline y */
    const firstLineY = quoteY - (qBlockH - qLh) / 2;

    /* ③ 励志语（主视觉）：自动换行 + 可选底衬，保证在任何图片上都读得清 */
    const quote = String(job.quote || '');
    if (quote) {
      ctx.save();
      const qSize = base;
      ctx.font = `800 ${qSize}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`;
      const lines = quoteLines;
      const lh = qSize * 1.28;
      const blockH = lh * lines.length;
      const firstY = firstLineY;
      // 底衬（scrim）：文字区域后方一层柔和暗色，图片再花也能读
      if (job.scrim !== false && hasImage) {
        const widest = Math.max.apply(null, lines.map((l) => ctx.measureText(l).width));
        const padX = qSize * 0.8;
        const padY = qSize * 0.55;
        const bw = Math.min(w - pad * 1.2, widest + padX * 2);
        const bx = align === 'center' ? (w - bw) / 2 : align === 'left' ? cx - padX : cx - bw + padX;
        const by = firstY - qLh * 0.5 - padY;
        const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
        grad.addColorStop(0, 'rgba(0,0,0,0.42)');
        grad.addColorStop(1, 'rgba(0,0,0,0.10)');
        ctx.fillStyle = grad;
        roundRect(bx, by, bw, blockH + padY * 2, qSize * 0.32);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = Math.max(1, qSize * 0.02);
        ctx.stroke();
      }
      ctx.font = `800 ${qSize}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`;
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = qSize * 0.35;
      ctx.shadowOffsetY = qSize * 0.05;
      ctx.fillStyle = '#ffffff';
      lines.forEach((ln, i) => ctx.fillText(ln, cx, firstY + i * lh));
      // 语录下方一条细装饰线
      const widest = Math.max.apply(null, lines.map((l) => ctx.measureText(l).width));
      const lineW = Math.min(widest * 0.5, qSize * 6);
      const lineY = firstY + (lines.length - 1) * lh + qSize * 0.95;
      const lineX = align === 'center' ? cx - lineW / 2 : align === 'left' ? cx : cx - lineW;
      const lg = ctx.createLinearGradient(lineX, 0, lineX + lineW, 0);
      lg.addColorStop(0, 'rgba(255,255,255,0.6)');
      lg.addColorStop(1, 'rgba(255,255,255,0.05)');
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = lg;
      ctx.fillRect(lineX, lineY, lineW, Math.max(1, qSize * 0.05));
      ctx.restore();
    }

    /* ⑤ 落款（学校/班级，可选） */
    if (job.school) {
      ctx.save();
      ctx.font = `600 ${Math.round(base * 0.5)}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.62)';
      ctx.textAlign = 'right';
      ctx.fillText(job.school, w - pad, h - pad * 0.6);
      ctx.restore();
    }
    if (job.subline) {
      ctx.save();
      ctx.font = `500 ${Math.round(base * 0.42)}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.textAlign = 'left';
      ctx.fillText(job.subline, pad, h - pad * 0.6);
      ctx.restore();
    }

    // 回传 base64 PNG（ArrayBuffer 过 IPC 不如字符串可靠）
    return canvas.toDataURL('image/png').split(',')[1];
  }

  window.Wallpaper = { render };
})();
