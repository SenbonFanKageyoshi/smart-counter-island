'use strict';
/* 生成应用图标：build/icon.png、build/icon.ico、src/assets/icon.png、src/assets/tray.ico
   纯 Node 实现（像素绘制 + PNG 编码 + ICO 封装），无需任何图像库。 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- ICO 封装（PNG-in-ICO，Vista+ 支持） ---------------- */

function encodeICO(pngs) {
  // pngs: [{size, png}]
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = 6 + count * 16;
  const entries = [];
  const blobs = [];
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette
    e[3] = 0;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

/* ---------------- 像素绘制 ---------------- */

const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = clamp01(t);
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
}

/** 绘制一个 size×size 的圆角玻璃时钟图标（RGBA Buffer） */
function renderIcon(size) {
  const SS = 3; // 超采样抗锯齿
  const N = size * SS;
  const buf = Buffer.alloc(N * N * 4);

  const half = size / 2;
  const rad = size * 0.21; // 圆角半径
  const border = size * 0.035 + 1;
  const faceR = half * 0.56;
  const cx = half;
  const cy = half;

  // 时针 10 点方向，分针 2 点方向（经典 10:10）
  const hourAng = (-150 * Math.PI) / 180;
  const minAng = (-30 * Math.PI) / 180;
  const hourLen = faceR * 0.46;
  const minLen = faceR * 0.66;
  const hourTh = Math.max(2, size * 0.045);
  const minTh = Math.max(1.6, size * 0.032);
  const hx2 = cx + hourLen * Math.cos(hourAng);
  const hy2 = cy + hourLen * Math.sin(hourAng);
  const mx2 = cx + minLen * Math.cos(minAng);
  const my2 = cy + minLen * Math.sin(minAng);

  for (let y = 0; y < N; y++) {
    const py = y / SS;
    for (let x = 0; x < N; x++) {
      const px = x / SS;
      let r = 0, g = 0, b = 0, a = 0;

      // 圆角矩形 SDF
      const qx = Math.abs(px - cx) - (half - 1 - rad);
      const qy = Math.abs(py - cy) - (half - 1 - rad);
      const dOuter = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;

      if (dOuter <= 0.5) {
        const t = py / size;
        r = lerp(212, 100, t);
        g = lerp(227, 138, t);
        b = lerp(255, 214, t);
        // 顶部高光
        const hl = clamp01(1 - py / (size * 0.55)) * 0.25 * clamp01(1 - Math.abs(px - size * 0.32) / (size * 0.55));
        r += 255 * hl; g += 255 * hl; b += 255 * hl;
        // 描边
        const dBorder = dOuter + border;
        if (dBorder > 0) {
          const bl = clamp01(dBorder / 1.2);
          r = lerp(r, 255, bl * 0.9);
          g = lerp(g, 255, bl * 0.9);
          b = lerp(b, 255, bl * 0.9);
        }
        a = 255;
      }

      // 表盘
      const fc = Math.hypot(px - cx, py - cy);
      if (a > 0 && fc <= faceR + 0.5) {
        r = 255; g = 255; b = 255;
      }
      // 时针
      const dh = distToSegment(px, py, cx, cy, hx2, hy2);
      if (dh <= hourTh / 2) {
        const cov = clamp01((hourTh / 2 - dh) / 0.6);
        r = lerp(r, 24, cov); g = lerp(g, 48, cov); b = lerp(b, 110, cov);
      }
      // 分针
      const dm = distToSegment(px, py, cx, cy, mx2, my2);
      if (dm <= minTh / 2) {
        const cov = clamp01((minTh / 2 - dm) / 0.6);
        r = lerp(r, 24, cov); g = lerp(g, 48, cov); b = lerp(b, 110, cov);
      }
      // 中心圆点
      if (fc <= Math.max(2, size * 0.05)) {
        r = 24; g = 48; b = 110;
      }

      const i = (y * N + x) * 4;
      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(a);
    }
  }

  // 盒式降采样到 size
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/* ---------------- 输出 ---------------- */

function main() {
  const buildDir = path.join(ROOT, 'build');
  const assetsDir = path.join(ROOT, 'src', 'assets');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((s) => ({ size: s, png: encodePNG(s, s, renderIcon(s)) }));

  const icon256 = pngs.find((p) => p.size === 256).png;
  fs.writeFileSync(path.join(buildDir, 'icon.png'), icon256);
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), icon256);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeICO(pngs));
  fs.writeFileSync(path.join(assetsDir, 'tray.ico'), encodeICO(pngs.filter((p) => p.size <= 48)));

  console.log('图标已生成:');
  console.log('  build/icon.png (256x256)');
  console.log('  build/icon.ico (16-256)');
  console.log('  src/assets/icon.png');
  console.log('  src/assets/tray.ico (16-48)');
}

main();
