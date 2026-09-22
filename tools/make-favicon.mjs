/**
 * 生成站点图标（浏览器标签页 / 收藏夹 / 搜索结果左侧的小图标）。
 *
 *   输出：favicon.ico  （16 / 32 / 48 三档，32bpp BGRA + AND mask，兼容性最广）
 *         favicon.svg  （矢量，现代浏览器优先用它，缩放不糊）
 *
 * 图案：等轴测立方体 —— 呼应站点主题「一张展开图折成立体盒」。
 * 配色沿用站内刀模标注口径：主尺寸橙 #de7a00（顶/左/右三面做明度分层）。
 *
 * 用法：node tools/make-favicon.mjs
 *
 * ⚠️ 站点部署在 /diecut/ 子路径下，浏览器**只会自动请求域名根** /favicon.ico，
 *    那个位置不归我们管。所以两个 HTML 里必须显式写 <link rel="icon">，
 *    否则文件放着也不会生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- 几何（画布 384×384，等比缩到任意尺寸） ---------------- */
const SS = 384;
const SIZES = [48, 32, 16];

const P = {
  a: [192, 36],    // 顶面·上顶点
  b: [324, 102],   // 顶面·右顶点
  c: [192, 234],   // 顶面·下顶点（= 三条棱的公共交点）
  d: [60, 102],    // 顶面·左顶点
  c2: [192, 348],  // 前面·下顶点
  d2: [60, 216],
  b2: [324, 216],
};

const COL = {
  top: [0xf5, 0xa7, 0x42],   // 亮橙
  left: [0xde, 0x7a, 0x00],  // 主尺寸橙
  right: [0xa8, 0x5c, 0x00], // 暗橙
  edge: [0x40, 0x24, 0x00],  // 近黑棕描边
};

const FACES = [
  { pts: [P.a, P.b, P.c, P.d], rgb: COL.top },     // 顶面
  { pts: [P.d, P.c, P.c2, P.d2], rgb: COL.left },   // 左前面
  { pts: [P.b, P.c, P.c2, P.b2], rgb: COL.right },  // 右前面
];

const EDGES = [
  [P.a, P.b], [P.b, P.c], [P.c, P.d], [P.d, P.a],   // 顶面四边
  [P.d, P.d2], [P.c, P.c2], [P.b, P.b2],            // 三条立棱
  [P.d2, P.c2], [P.c2, P.b2],                       // 底部两条
];
const EDGE_W = 9;   // 384 空间的描边宽度

/* ---------------- 位图渲染 ---------------- */
const buf = new Float64Array(SS * SS * 4);   // RGBA（非预乘），未覆盖处 alpha=0

/** 填充凸多边形（扫描线，2× 超采样坐标已足够 —— 后面还有整倍降采样做抗锯齿） */
function fillPoly(pts, rgb) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(SS - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] <= cy && b[1] > cy) || (b[1] <= cy && a[1] > cy)) {
        xs.push(a[0] + (cy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.round(xs[k]));
      const xb = Math.min(SS - 1, Math.round(xs[k + 1]) - 1);
      for (let x = xa; x <= xb; x++) {
        const o = (y * SS + x) * 4;
        buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]; buf[o + 3] = 1;
      }
    }
  }
}

/** 给一条边描色（按到线段的距离取圆形笔头） */
function strokeSeg(p, q, rgb, w) {
  const r = w / 2;
  const x0 = Math.max(0, Math.floor(Math.min(p[0], q[0]) - r));
  const x1 = Math.min(SS - 1, Math.ceil(Math.max(p[0], q[0]) + r));
  const y0 = Math.max(0, Math.floor(Math.min(p[1], q[1]) - r));
  const y1 = Math.min(SS - 1, Math.ceil(Math.max(p[1], q[1]) + r));
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const len2 = dx * dx + dy * dy || 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - p[0], py = y + 0.5 - p[1];
      let t = (px * dx + py * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ox = px - t * dx, oy = py - t * dy;
      if (ox * ox + oy * oy <= r * r) {
        const o = (y * SS + x) * 4;
        buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]; buf[o + 3] = 1;
      }
    }
  }
}

FACES.forEach((f) => fillPoly(f.pts, f.rgb));
EDGES.forEach(([p, q]) => strokeSeg(p, q, COL.edge, EDGE_W));

/* ---------------- 整倍降采样（384 → size，得到平滑边缘） ---------------- */
function downsample(size) {
  const out = Buffer.alloc(size * size * 4);
  const f = SS / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < f; sy++) {
        for (let sx = 0; sx < f; sx++) {
          const o = (((y * f + sy) | 0) * SS + ((x * f + sx) | 0)) * 4;
          const al = buf[o + 3];
          r += buf[o] * al; g += buf[o + 1] * al; b += buf[o + 2] * al; a += al;
        }
      }
      const cnt = f * f, o = (y * size + x) * 4;
      const A = a / cnt;
      if (a > 0) {
        // buf 里已经是 0~255 的整数，r/a 即加权平均色（不要再乘 255）
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(A * 255);
    }
  }
  return out;
}

/* ---------------- 打包 ICO ---------------- */
function toIco(images) {
  const HEAD = 6, ENTRY = 16;
  let offset = HEAD + ENTRY * images.length;
  const entries = [], blobs = [];
  for (const { size, rgba } of images) {
    const rowBytes = size * 4;
    const maskRow = Math.ceil(size / 32) * 4;      // 1bpp AND mask，4 字节对齐
    const maskBytes = maskRow * size;

    const dib = Buffer.alloc(40 + rowBytes * size + maskBytes);
    dib.writeUInt32LE(40, 0);                      // biSize
    dib.writeInt32LE(size, 4);                     // biWidth
    dib.writeInt32LE(size * 2, 8);                 // biHeight = 像素 + mask 高度
    dib.writeUInt16LE(1, 12);                      // biPlanes
    dib.writeUInt16LE(32, 14);                     // biBitCount
    dib.writeUInt32LE(0, 16);                      // biCompression = BI_RGB

    // 像素自下而上，BGRA
    for (let y = 0; y < size; y++) {
      const src = (size - 1 - y) * rowBytes;
      for (let x = 0; x < size; x++) {
        const s = src + x * 4, d = 40 + y * rowBytes + x * 4;
        dib[d] = rgba[s + 2]; dib[d + 1] = rgba[s + 1]; dib[d + 2] = rgba[s]; dib[d + 3] = rgba[s + 3];
      }
    }
    // AND mask 全 0（透明度由 alpha 通道决定）
    entries.push({ size, bytes: dib.length, offset });
    blobs.push(dib);
    offset += dib.length;
  }

  const out = Buffer.alloc(offset);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);                         // type = icon
  out.writeUInt16LE(images.length, 4);
  entries.forEach((e, i) => {
    const o = HEAD + i * ENTRY;
    out.writeUInt8(e.size >= 256 ? 0 : e.size, o);
    out.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    out.writeUInt8(0, o + 2);                      // 调色板数
    out.writeUInt8(0, o + 3);
    out.writeUInt16LE(1, o + 4);
    out.writeUInt16LE(32, o + 6);
    out.writeUInt32LE(e.bytes, o + 8);
    out.writeUInt32LE(e.offset, o + 12);
  });
  blobs.forEach((b, i) => b.copy(out, entries[i].offset));
  return out;
}

/* ---------------- SVG（与位图同一套坐标） ---------------- */
function toSvg() {
  const poly = (pts, fill) =>
    `  <polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="${fill}"/>`;
  const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  const lines = EDGES.map(([p, q]) =>
    `  <line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}"/>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 384" width="384" height="384">
  <title>通用包装盒型库</title>
${poly(FACES[0].pts, hex(FACES[0].rgb))}
${poly(FACES[1].pts, hex(FACES[1].rgb))}
${poly(FACES[2].pts, hex(FACES[2].rgb))}
  <g stroke="${hex(COL.edge)}" stroke-width="${EDGE_W}" stroke-linecap="round" stroke-linejoin="round" fill="none">
${lines}
  </g>
</svg>
`;
}

/* ---------------- 输出 ---------------- */
const images = SIZES.map((size) => ({ size, rgba: downsample(size) }));
const ico = toIco(images);
fs.writeFileSync(path.join(ROOT, 'favicon.ico'), ico);
fs.writeFileSync(path.join(ROOT, 'favicon.svg'), toSvg());

console.log(`favicon.ico  ${ico.length} B  尺寸 ${SIZES.join('/')}  (${images.length} 帧)`);
console.log(`favicon.svg  ${fs.statSync(path.join(ROOT, 'favicon.svg')).size} B`);
