// BEST-EFFORT (proof of concept): assign each porch to its nearest map block.
//
// Geocodes each address to an approximate pixel on map-south.jpg using a hand-read
// street grid, then snaps to the nearest block centroid. Writes a `block` field onto
// each porch in saturday.json. Imperfect by design — hand-edit the JSON to fix any
// misassignments. Also emits a debug MVG (dots over the map) for a visual sanity check.
//
// Usage: node scripts/assign-blocks.mjs [--write]

import { readFileSync, writeFileSync } from "node:fs";

const PORCHES = "src/data/schedule/saturday.json";
const BLOCKS = "src/data/schedule/saturday-map-blocks.json";

// --- hand-read calibration (image pixels, map-south.jpg is 1809x980) --------
// N-S streets: x of the street line, west -> east.
const streetX = {
    "S Cedar St": 355,
    "S Junett St": 440,
    "S Pine St": 540,
    "S Anderson St": 660,
    "S Oakes St": 775,
    "S Fife St": 890,
    "S Prospect St": 1010,
    "S Steele St": 1130,
    "S Trafton St": 1300,
    "S State St": 1410,
    "S Ferry St": 1540,
    "S Sprague Ave": 1700,
};
// E-W avenues: y of the avenue line, north (6th) -> south (12th).
const avenueY = { 6: 45, 7: 150, 8: 235, 9: 395, 10: 555, 11: 695, 12: 820, 13: 900 };

const SNAP_MAX = 150; // px: beyond this, treat as off-map / unassigned

const norm = (s) =>
    s
        .replace(/Prospet/, "Prospect")
        .replace(/\s+/g, " ")
        .trim();

// Parse an address -> approximate {x, y} on the map, or null if unplaceable.
function geocode(address) {
    const m = norm(address).match(/^(\d+)\s+(.+)$/);
    if (!m) return null;
    const num = Number(m[1]);
    const street = m[2];

    // Avenue addresses (porch sits on an E-W street): y from the avenue, x guessed
    // from the house number (higher number ~ further west). Mostly off-map anyway.
    const ave = street.match(/^(?:6th Ave|S (\d+)(?:st|nd|rd|th) St)$/);
    if (ave) {
        const aveNum = street.startsWith("6th") ? 6 : Number(ave[1]);
        const y = avenueY[aveNum];
        if (y == null) return null;
        // rough: 2200 -> east (x~1650), 2900 -> west (x~450)
        const x = 1650 + ((num - 2200) / 700) * (450 - 1650);
        return { x, y, ave: true };
    }

    // N-S street address: x from the street, y interpolated between avenues.
    const x = streetX[street];
    if (x == null) return null;
    const hundred = Math.floor(num / 100);
    const y0 = avenueY[hundred];
    const y1 = avenueY[hundred + 1];
    if (y0 == null || y1 == null) return null;
    const frac = (num % 100) / 100;
    return { x, y: y0 + frac * (y1 - y0), ave: false };
}

const porches = JSON.parse(readFileSync(PORCHES, "utf8"));
const { blocks } = JSON.parse(readFileSync(BLOCKS, "utf8"));
const centroid = (b) => ({ id: b.id, cx: b.x + b.w / 2, cy: b.y + b.h / 2 });
const cents = blocks.map(centroid);

const dots = [];
let assigned = 0;
for (const p of porches) {
    p.block = null;
    if (!p.address) continue;
    const pt = geocode(p.address);
    if (!pt) {
        dots.push({ x: 30, y: 30, label: "?", off: true, addr: p.address });
        continue;
    }
    let best = null;
    let bestD = Infinity;
    for (const c of cents) {
        const d = Math.hypot(pt.x - c.cx, pt.y - c.cy);
        if (d < bestD) {
            bestD = d;
            best = c;
        }
    }
    const ok = best && bestD <= SNAP_MAX;
    if (ok) {
        p.block = best.id;
        assigned++;
    }
    dots.push({ x: pt.x, y: pt.y, label: p.block ?? "x", off: !ok, addr: p.address });
}

// --- debug MVG: porch dots (green=assigned, red=off) + block centroids -------
const FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";
const mvg = [`font "${FONT}"`, "font-size 13", "stroke-width 1"];
for (const c of cents) {
    mvg.push(
        "fill rgba(0,0,255,0.25)",
        "stroke none",
        `circle ${c.cx},${c.cy} ${c.cx + 5},${c.cy}`,
    );
}
for (const d of dots) {
    const color = d.off ? "rgba(220,0,0,0.95)" : "rgba(0,150,0,0.95)";
    mvg.push(`fill ${color}`, "stroke black", `circle ${d.x},${d.y} ${d.x + 6},${d.y}`);
}
const SP = process.env.SP || ".";
writeFileSync(`${SP}/dots.mvg`, mvg.join("\n") + "\n");

console.log(`assigned ${assigned}/${porches.filter((p) => p.address).length} addressed porches`);
const perBlock = {};
for (const p of porches) if (p.block) perBlock[p.block] = (perBlock[p.block] || 0) + 1;
console.log("blocks used:", Object.keys(perBlock).length);

if (process.argv.includes("--write")) {
    writeFileSync(PORCHES, JSON.stringify(porches, null, 2) + "\n");
    console.log(`wrote block assignments into ${PORCHES}`);
} else {
    console.log("(dry run — pass --write to persist block field)");
}
