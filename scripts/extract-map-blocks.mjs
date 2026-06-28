// EXPERIMENT: parse ImageMagick connected-components output into block rects.
//
// Recovers tappable block bounding boxes from the raster map by color-segmenting
// the blue + pale-yellow city blocks. Axis-aligned boxes are approximate (the art
// is slightly skewed) — this is a feasibility probe, not a final overlay. An SVG
// source asset would give exact per-block shapes for free.
//
// Usage: node scripts/extract-map-blocks.mjs <cc.txt> > src/data/schedule/saturday-map-blocks.json

import { readFileSync } from "node:fs";

const IMG_W = 1809;
const IMG_H = 980;

const ccPath = process.argv[2];
const lines = readFileSync(ccPath, "utf8").split("\n");

const re =
    /^\s*\d+:\s+(\d+)x(\d+)\+(\d+)\+(\d+)\s+[\d.]+,[\d.]+\s+(\d+)\s+srgb\((\d+),(\d+),(\d+)\)/;

const blocks = [];
for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const [, w, h, x, y, area, r, g, b] = m.map(Number);

    // Block regions are pure white in the mask; skip the leaked light-blue
    // fragments north of 6th Ave (≈ 209,237,248).
    if (!(r === 255 && g === 255 && b === 255)) continue;
    if (area < 2500) continue;

    // Exclude the Day-1 legend circle (tall blob hugging the left edge).
    if (x < 5 && h > 400) continue;

    blocks.push({ x, y, w, h });
}

// Stable order: top-to-bottom, then left-to-right.
blocks.sort((a, b) => a.y - b.y || a.x - b.x);
blocks.forEach((blk, i) => (blk.id = `b${i + 1}`));

process.stdout.write(JSON.stringify({ width: IMG_W, height: IMG_H, blocks }, null, 2) + "\n");
