// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * scripts/build-app-icon.mjs — generate the platform icon set from the pixel-art master.
 *
 * HANDOFF_2 §8: the pixel-art human Prometheus is the official mark. This turns the
 * 182×206 master into everything the platforms want:
 *   build/icon.png   1024×1024 (electron-builder derives linux + the dev dock icon)
 *   build/icon.icns  macOS, via `iconutil` from a generated .iconset
 *   build/icon.ico   Windows (a PNG-payload ICO — Vista+ reads these natively)
 *
 * Why this is a SCRIPT and not a one-off manual export: the master will change again,
 * and "regenerate the icons" must not be a ritual only one person knows. Run it, commit
 * the three outputs.
 *
 * SCALING RULE (§8: "keep image-rendering crisp when upscaling: scale by integer
 * nearest-neighbour"). Two regimes, because one rule cannot serve both:
 *   - UPSCALE  → integer nearest-neighbour ONLY. A fractional upscale of pixel art
 *     produces uneven pixel widths, which is exactly the mush §8 is guarding against.
 *   - DOWNSCALE → area average (box filter). At 16px there is no integer factor to be
 *     had, and nearest-neighbour minification drops whole rows of the art at random.
 *
 * The FIGURE is centred at ~75% of the canvas on a FULLY TRANSPARENT ground (handoff_3
 * §6, which replaces handoff_2 §8's `#0d0d0d` square). ⌘-Tab, the Dock and Finder all
 * composite the icon over their own backdrop, so a baked-in dark square reads as a tile
 * the figure sits in rather than as the figure itself.
 *
 * Pure Node: PNG decode/encode via zlib (the master is 8-bit RGBA, non-interlaced).
 * No image dependency — this must keep working on a cold clone.
 *
 * Run: node scripts/build-app-icon.mjs [path/to/master.png]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = dirname(HERE);

// The master is VENDORED into the repo on purpose. It used to default to
// `handoff_2/icon.png`, which is an untracked hand-off folder — on a fresh clone the
// generator's input simply would not exist. The artwork is a build input; it lives with
// the build.
const MASTER = resolve(process.argv[2] ?? join(HERE, "assets", "prometheus-master.png"));
const OUT_DIR = join(STUDIO, "apps", "desktop", "build");

/**
 * Fraction of the canvas the FIGURE's height occupies (handoff_3 §6's "~75%").
 *
 * Measured against the figure's alpha bounding box, not the master's canvas. The master
 * carries transparent padding, so filling to the CANVAS height would put the visible
 * figure at ~69% and every tier would inherit that error.
 */
const FILL = 0.75;

/* ── PNG decode (8-bit RGBA, non-interlaced — what the master is) ───────────── */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("not a PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len; // len + type + data + crc
  }
  if (bitDepth !== 8) throw new Error(`expected 8-bit, got ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`expected RGB/RGBA, got colorType ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    unfilter(filter, line, prev, channels);
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 0xff;
    }
    prev = line;
  }
  return { width, height, data: out };
}

/** Reverse one PNG scanline filter in place (spec §9.2). */
function unfilter(type, line, prev, bpp) {
  const n = line.length;
  if (type === 0) return;
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let v = line[i];
    if (type === 1) v += a;
    else if (type === 2) v += b;
    else if (type === 3) v += (a + b) >> 1;
    else if (type === 4) v += paeth(a, b, c);
    else throw new Error(`bad filter ${type}`);
    line[i] = v & 0xff;
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/* ── PNG encode (8-bit RGBA, filter 0 — small images, simplicity wins) ──────── */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ── background keying ─────────────────────────────────────────────────────── */

/**
 * Key out a baked-in dark background — ONLY for a LEGACY master with no alpha of its own.
 *
 * The master was exported with its editor background baked in as OPAQUE near-#1e1e1e
 * (measured: 9.5k px at rgb(30,30,30) plus ±1 dither). Composited as-is it reads as a
 * lighter square floating on §8's #0d0d0d ground, and the in-app 19×21 mark would carry
 * a dark tile instead of sitting on the TopBar.
 *
 * So: key out the near-neutral dark greys. The figure is safe — every one of its colours
 * is either strongly saturated (the blues/yellow/magenta/purple) or a light grey (the
 * helmet, ~#9a9a9a), and this only touches pixels that are BOTH very dark AND neutral.
 */
function alreadyTransparent(img) {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] === 0) return true;
  return false;
}

function keyOutBackground(img) {
  // handoff_3's master already carries a real alpha channel, and keying THAT would be
  // actively destructive: the figure's own outline pixels are near-neutral and very dark,
  // so the rule that removed the background would punch holes through the outline. If the
  // artist gave us alpha, the artist's alpha wins.
  if (alreadyTransparent(img)) return img;
  const data = Buffer.from(img.data);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // very dark (luma-ish < 48) AND near-neutral (channel spread <= 8) ⇒ background.
    if (max <= 48 && max - min <= 8) data[i + 3] = 0;
  }
  return { width: img.width, height: img.height, data };
}

/**
 * Crop to the figure's alpha bounding box.
 *
 * Two things depend on it. FILL is specified against the FIGURE, and "centred" means the
 * figure centred — the master's transparent padding is not symmetric, so centring the
 * whole canvas would leave the figure visibly low in every icon.
 */
function trimToAlpha(img) {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return img; // fully transparent master — nothing to trim, fail soft
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y + y0) * img.width + x0) * 4;
    img.data.copy(data, y * width * 4, from, from + width * 4);
  }
  return { width, height, data };
}

/* ── resampling ────────────────────────────────────────────────────────────── */

/** Integer nearest-neighbour upscale — the only kind that keeps pixel art crisp. */
function upscaleNearest(img, k) {
  const width = img.width * k;
  const height = img.height * k;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = (y / k) | 0;
    for (let x = 0; x < width; x++) {
      const sx = (x / k) | 0;
      const s = (sy * img.width + sx) * 4;
      const d = (y * width + x) * 4;
      data[d] = img.data[s];
      data[d + 1] = img.data[s + 1];
      data[d + 2] = img.data[s + 2];
      data[d + 3] = img.data[s + 3];
    }
  }
  return { width, height, data };
}

/**
 * Area-average downscale (box filter), alpha-weighted so transparent pixels do not
 * drag the colour of their neighbours toward black.
 */
function downscaleArea(img, width, height) {
  const data = Buffer.alloc(width * height * 4);
  const xr = img.width / width;
  const yr = img.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yr);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yr));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xr);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xr));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * img.width + sx) * 4;
          const av = img.data[s + 3] / 255;
          r += img.data[s] * av;
          g += img.data[s + 1] * av;
          b += img.data[s + 2] * av;
          a += img.data[s + 3];
          n++;
        }
      }
      const d = (y * width + x) * 4;
      const aw = a / 255 || 1; // avoid /0 on a fully transparent cell
      data[d] = Math.round(r / aw);
      data[d + 1] = Math.round(g / aw);
      data[d + 2] = Math.round(b / aw);
      data[d + 3] = Math.round(a / n);
    }
  }
  return { width, height, data };
}

/**
 * Centre `art` on an NxN FULLY TRANSPARENT canvas (handoff_3 §6).
 *
 * `Buffer.alloc` zeroes, which IS transparent black — so this is a plain copy onto
 * nothing and the art's own alpha survives verbatim. There is deliberately no blend
 * against a ground colour: that blend is what produced the dark square this handoff
 * removes, and it also destroyed any antialiased edge by forcing alpha to 0xff.
 */
function onTransparent(art, size) {
  const data = Buffer.alloc(size * size * 4);
  const ox = Math.round((size - art.width) / 2);
  const oy = Math.round((size - art.height) / 2);
  for (let y = 0; y < art.height; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= size) continue;
    for (let x = 0; x < art.width; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= size) continue;
      const s = (y * art.width + x) * 4;
      if (art.data[s + 3] === 0) continue;
      art.data.copy(data, (dy * size + dx) * 4, s, s + 4);
    }
  }
  return { width: size, height: size, data };
}

/**
 * The §8 icon at `size`: integer-upscaled where possible, box-downscaled where not.
 *
 * ROUND, not floor. Flooring made the fill fraction lurch between tiers — at 1024 the
 * art filled 56% but at 512 only 37%, because `512 * 0.72 / 206 = 1.79` floored to a 1×
 * identity scale. Rounding instead lands 256/512/1024 on 1×/2×/4×, i.e. the SAME fill at
 * every doubling, while staying a pure integer nearest-neighbour upscale — so the art is
 * both consistent across tiers and crisp, rather than trading one for the other.
 * `Math.min(..., size / master.height)` keeps the art inside the canvas at every size.
 */
function render(master, size) {
  const target = size * FILL;
  const k = Math.min(
    Math.round(target / master.height),
    Math.floor(size / master.height),
    Math.floor(size / master.width),
  );
  const art =
    k >= 1
      ? upscaleNearest(master, k)
      : downscaleArea(
          master,
          Math.max(1, Math.round(master.width * (target / master.height))),
          Math.max(1, Math.round(target)),
        );
  return onTransparent(art, size);
}

/* ── ICO container (PNG payloads — Vista+ reads them natively) ──────────────── */

function encodeIco(entries) {
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach((e, i) => {
    const p = 6 + i * 16;
    dir[p] = e.size >= 256 ? 0 : e.size; // 0 means 256
    dir[p + 1] = e.size >= 256 ? 0 : e.size;
    dir[p + 2] = 0; // palette
    dir[p + 3] = 0; // reserved
    dir.writeUInt16LE(1, p + 4); // colour planes
    dir.writeUInt16LE(32, p + 6); // bpp
    dir.writeUInt32BE(0, p + 8);
    dir.writeUInt32LE(e.png.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += e.png.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.png)]);
}

/* ── main ──────────────────────────────────────────────────────────────────── */

const decoded = keyOutBackground(decodePng(readFileSync(MASTER)));
const master = trimToAlpha(decoded);
console.log(
  `master: ${MASTER} (${decoded.width}×${decoded.height} → figure ${master.width}×${master.height} after alpha trim)`,
);
mkdirSync(OUT_DIR, { recursive: true });

// 1. the 1024² PNG electron-builder derives linux + the dev dock icon from.
const png1024 = encodePng(render(master, 1024));
writeFileSync(join(OUT_DIR, "icon.png"), png1024);
console.log(`wrote build/icon.png (1024×1024, ${png1024.length} bytes)`);

// 2. macOS .icns via iconutil (Apple's own tool — no third-party icns writer).
const ICONSET = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];
const tmp = mkdtempSync(join(tmpdir(), "prom-icon-"));
const iconset = join(tmp, "icon.iconset");
mkdirSync(iconset);
for (const [size, name] of ICONSET) {
  writeFileSync(join(iconset, name), size === 1024 ? png1024 : encodePng(render(master, size)));
}
try {
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(OUT_DIR, "icon.icns")]);
  console.log("wrote build/icon.icns");
} catch (e) {
  // Linux/CI has no iconutil — the existing .icns stays, which is correct: a machine
  // that cannot build the mac icon must not silently ship a broken one.
  console.warn(`skipped icon.icns (iconutil unavailable): ${e instanceof Error ? e.message : e}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 3. Windows .ico — the sizes Explorer actually asks for.
const ico = encodeIco(
  [16, 32, 48, 64, 128, 256].map((size) => ({ size, png: encodePng(render(master, size)) })),
);
writeFileSync(join(OUT_DIR, "icon.ico"), ico);
console.log(`wrote build/icon.ico (${ico.length} bytes)`);

// 4. the in-app mark (§8.2) — the renderer imports THIS, at its natural pixel size, so
//    `image-rendering: pixelated` has real pixels to snap to.
const APP_ASSET = join(STUDIO, "apps", "desktop", "src", "renderer", "assets");
mkdirSync(APP_ASSET, { recursive: true });
writeFileSync(join(APP_ASSET, "prometheus-mark.png"), encodePng(master));
console.log("wrote renderer/assets/prometheus-mark.png (the in-app wordmark mark)");
