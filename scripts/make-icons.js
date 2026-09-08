'use strict';

// Renders the app icons. No image library: the glyph is described with signed
// distance fields, supersampled for smooth edges, and written out as PNG with
// zlib. Run after changing the mark:
//
//   node scripts/make-icons.js
//
// The results are committed, so a normal build never has to run this.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'public');

// Matches --accent / --surface in public/app.css.
const GREEN = [31, 111, 74];
const WHITE = [255, 255, 255];

/* ------------------------------------------------------------ distance math */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Distance to a rounded rectangle centred on the origin. */
function sdRoundedRect(x, y, halfW, halfH, radius) {
  const dx = Math.abs(x) - halfW + radius;
  const dy = Math.abs(y) - halfH + radius;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Distance to a circular ring of the given radius and stroke width. */
function sdRing(x, y, cx, cy, radius, stroke) {
  return Math.abs(Math.hypot(x - cx, y - cy) - radius) - stroke / 2;
}

/**
 * The "$" mark, in a coordinate space running -1..1 on both axes.
 * Returns true when the point is inside the glyph.
 *
 * The S is two rings with one quadrant of each cut away: the upper bowl opens
 * toward the bottom right, the lower bowl toward the top left. A vertical bar
 * runs through both, slightly past them, the way a dollar sign does.
 */
function insideGlyph(x, y, scale) {
  const sx = x / scale;
  const sy = y / scale;

  const R = 0.34;
  const STROKE = 0.20;

  const upper = sdRing(sx, sy, 0, -R, R, STROKE) < 0 && !(sx > 0 && sy > -R);
  const lower = sdRing(sx, sy, 0, R, R, STROKE) < 0 && !(sx < 0 && sy < R);
  const bar = sdRoundedRect(sx, sy, STROKE / 2, 0.92, STROKE / 2) < 0;

  return upper || lower || bar;
}

/* -------------------------------------------------------------- rasterising */

/**
 * @param {number} size      pixel width and height
 * @param {boolean} maskable full bleed for Android's mask, vs rounded corners
 */
function render(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4;                       // supersampling factor per axis
  // Maskable and apple-touch icons must be full-bleed squares: the platform
  // applies its own mask, and any rounding here shows up as clipped corners.
  const corner = maskable ? 0 : 0.42;
  // A maskable icon must keep its content inside the middle 80%.
  const glyphScale = maskable ? 0.62 : 0.80;

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let bgHits = 0;
      let fgHits = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Map the subsample to -1..1.
          const u = ((pxi + (sx + 0.5) / SS) / size) * 2 - 1;
          const v = ((py + (sy + 0.5) / SS) / size) * 2 - 1;

          if (sdRoundedRect(u, v, 1, 1, corner) < 0) bgHits++;
          if (insideGlyph(u, v, glyphScale)) fgHits++;
        }
      }

      const total = SS * SS;
      const bgA = bgHits / total;
      const fgA = fgHits / total;

      // Composite the white glyph over the green plate, then the plate over
      // transparency.
      const r = GREEN[0] * (1 - fgA) + WHITE[0] * fgA;
      const g = GREEN[1] * (1 - fgA) + WHITE[1] * fgA;
      const b = GREEN[2] * (1 - fgA) + WHITE[2] * fgA;

      const o = (py * size + pxi) * 4;
      px[o] = Math.round(clamp(r, 0, 255));
      px[o + 1] = Math.round(clamp(g, 0, 255));
      px[o + 2] = Math.round(clamp(b, 0, 255));
      px[o + 3] = Math.round(clamp(bgA, 0, 1) * 255);
    }
  }
  return px;
}

/* ------------------------------------------------------------------ encoding */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  // Each scanline is prefixed with its filter type; 0 means "none".
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------------- main */

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
  ['favicon-32.png', 32, false],
];

for (const [name, size, maskable] of targets) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, encodePng(size, render(size, maskable)));
  console.log(`${name.padEnd(24)} ${size}x${size}  ${fs.statSync(file).size} bytes`);
}
