// Generates flat PNG app icons (192/512 + apple-touch 180) with zero deps.
// Draws a bold "D" glyph on a dark square, encodes PNG by hand via node:zlib.
import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

const BG = [13, 17, 23]; // #0d1117
const FG = [63, 185, 80]; // #3fb950

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, pixelAt) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelAt(x, y);
      const o = row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// "D" glyph geometry (fractions of icon size), matches public/icons/icon.svg:
// stem rectangle + right half-annulus bowl.
const CY = 0.5;
const R = 0.26; // bowl outer radius
const T = 0.13; // stroke thickness
const RI = R - T; // bowl inner radius
const CX = 0.435; // bowl center x (stem occupies [CX - T, CX])

function inGlyph(fx, fy) {
  // stem
  if (fx >= CX - T && fx <= CX && fy >= CY - R && fy <= CY + R) return true;
  // bowl (half annulus, x >= CX)
  if (fx >= CX) {
    const d = Math.hypot(fx - CX, fy - CY);
    if (d >= RI && d <= R) return true;
  }
  return false;
}

function makeIcon(size) {
  const SS = 4; // 4x4 supersampling for anti-aliasing
  return encodePng(size, (x, y) => {
    let hit = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const fx = (x + (sx + 0.5) / SS) / size;
        const fy = (y + (sy + 0.5) / SS) / size;
        if (inGlyph(fx, fy)) hit++;
      }
    }
    const a = hit / (SS * SS);
    return [
      Math.round(BG[0] + (FG[0] - BG[0]) * a),
      Math.round(BG[1] + (FG[1] - BG[1]) * a),
      Math.round(BG[2] + (FG[2] - BG[2]) * a),
    ];
  });
}

for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
]) {
  const buf = makeIcon(size);
  writeFileSync(join(outDir, name), buf);
  console.log(`wrote ${name} (${size}x${size}, ${buf.length} bytes)`);
}
