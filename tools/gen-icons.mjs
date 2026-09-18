/**
 * 生成扩展图标（零依赖：Node 内置 zlib 手写 PNG）。
 *
 * 图案：清华紫圆角方块 + 三条白色“列表”横杠 + 右上角一个红色小圆点（代表临近截止）。
 * 用法：node tools/gen-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'icons');

/* ------------------------------- PNG 编码 ------------------------------- */

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
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** rgba: Uint8Array，长度 size*size*4 */
function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------------- 绘制 ---------------------------------- */

const PURPLE_TOP = [0x7d, 0x1a, 0x8c];
const PURPLE_BOTTOM = [0x66, 0x08, 0x74];
const WHITE = [0xff, 0xff, 0xff];
const RED = [0xd3, 0x2f, 0x2f];

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 圆角矩形的有符号距离场（负值在内部） */
function roundedRectSdf(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function drawIcon(size) {
  const SS = 4; // 4x 超采样，边缘更干净
  const rgba = new Uint8Array(size * size * 4);
  const S = size * SS;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0; let g = 0; let b = 0; let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * SS / SS * 1;
          const y = (py + (sy + 0.5) / SS);
          const fx = px + (sx + 0.5) / SS;
          const fy = py + (sy + 0.5) / SS;

          // 背板
          const pad = Math.max(0.6, S * 0.045) / SS;
          const bg = roundedRectSdf(fx, fy, size / 2, size / 2, size / 2 - pad, size / 2 - pad, size * 0.22);
          let cr = 0; let cg = 0; let cb = 0; let ca = 0;
          if (bg <= 0) {
            const t = fy / size;
            const base = mix(PURPLE_TOP, PURPLE_BOTTOM, t);
            cr = base[0]; cg = base[1]; cb = base[2]; ca = 1;
          }

          if (ca > 0) {
            // 三条白色横杠（列表感）
            const barH = Math.max(0.9, size * 0.085) / 1;
            const barR = barH / 2;
            const left = size * 0.22;
            const widths = [0.56, 0.56, 0.36];
            const ys = [0.33, 0.5, 0.67];
            for (let i = 0; i < 3; i++) {
              const cy = size * ys[i];
              const w = size * widths[i];
              const d = roundedRectSdf(fx, fy, left + w / 2, cy, w / 2, barH / 2, barR);
              if (d <= 0) { cr = WHITE[0]; cg = WHITE[1]; cb = WHITE[2]; }
            }
            // 右上角红点（临近截止）
            const dot = Math.max(1, size * 0.13);
            const dx = fx - (size * 0.795);
            const dy = fy - (size * 0.215);
            if (dx * dx + dy * dy <= (dot / 2) * (dot / 2)) { cr = RED[0]; cg = RED[1]; cb = RED[2]; }
          }

          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }

      const n = SS * SS;
      const alpha = a / n;
      const i = (py * size + px) * 4;
      if (alpha > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
      }
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = drawIcon(size);
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
