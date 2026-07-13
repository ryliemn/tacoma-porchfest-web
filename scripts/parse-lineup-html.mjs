// Lineup HTML -> normalized porch/band JSON.
//
// Parses a Google-Sheets "Save as HTML" export of the festival lineup into two
// normalized files:
//   src/data/schedule/<day>-porch.json  — one row per porch (address = PK)
//   src/data/schedule/<day>-band.json   — one row per band (name = PK), FK -> porch
//
// The sheet encodes set duration as cell colspan (each grid column = 30 min), so
// start/end times are derived mechanically rather than guessed. Merged cells
// (rowspan/colspan) are respected by reconstructing the true grid.
//
// This is a REFRESH AID, not a live pipeline: after the first run the JSON is
// hand-curated (block ids get placed on the map later), and re-running OVERWRITES
// those edits. Day-specific data fixes live in OVERRIDES below so each run is
// reproducible.
//
// Sunday's sheet has a different layout (column labels, address quirks, note
// cells) and gets its own script: parse-sunday-lineup.mjs.
//
// Usage: node scripts/parse-lineup-html.mjs "<lineup.html>" Saturday

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [, , htmlPath, dayArg] = process.argv;
if (!htmlPath) {
    console.error('usage: node scripts/parse-lineup-html.mjs "<lineup.html>" [Day]');
    process.exit(1);
}
const day = (dayArg ?? "Saturday").toLowerCase();

// --- per-day manual fixes ----------------------------------------------------
// Corrections that can't be inferred from the grid (annotations embedded in a
// band name, a placement that contradicts an in-cell time note, etc.). Keyed by
// the RAW band-cell text. Empty for a day = no manual fixes needed.
const OVERRIDES = {
    saturday: {
        // raw cell text -> canonical band name
        rename: {
            "Lungduster (@3:00PM)": "Lungduster",
            "Kuwaisiana (duo)": "Kuwaisiana",
            // "(3:00PM)" cell + a plain cell on the same porch = one continuous
            // set; rename folds both under one name for the slotOverride below.
            "Jay Mabin and Friends (3:00PM)": "Jay Mabin and Friends",
        },
        // raw cell texts to discard entirely (folded into another band's slots)
        drop: ["A Gathering of Poets (3:30)"],
        // canonical name -> explicit slot list, replacing whatever the grid produced
        slotOverride: {
            Lungduster: [["3:00", "4:00"]],
            "A Gathering of Poets": [
                ["3:30", "4:00"],
                ["4:30", "5:00"],
                ["5:30", "6:00"],
            ],
            // annotation says 3:00PM; plays one continuous set through 5:30.
            "Jay Mabin and Friends": [["3:00", "5:30"]],
        },
    },
};
const overrides = OVERRIDES[day] ?? { rename: {}, drop: [], slotOverride: {} };
const renameMap = overrides.rename ?? {};
const dropSet = new Set(overrides.drop ?? []);
const slotOverride = overrides.slotOverride ?? {};

const SLOT_MINUTES = 30;

// --- tiny HTML helpers -------------------------------------------------------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
        if (body[0] === "#") {
            const cp =
                body[1] === "x" || body[1] === "X"
                    ? parseInt(body.slice(2), 16)
                    : parseInt(body.slice(1), 10);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
        }
        return ENTITIES[body] ?? m;
    });
}
function cellText(inner) {
    return decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
        .replace(/\s+/g, " ")
        .trim();
}
const attr = (attrs, name) => {
    const m = attrs.match(new RegExp(`${name}\\s*=\\s*"(\\d+)"`, "i"));
    return m ? Number(m[1]) : 1;
};

// --- reconstruct the span-aware grid -----------------------------------------
// occ[`${r},${c}`] = { anchor: true, text } for a cell's top-left corner, or
// { anchor: false } for a position covered by a colspan/rowspan. Missing = empty.
const html = readFileSync(htmlPath, "utf8");
const rowChunks = html.split(/<tr\b[^>]*>/i).slice(1);
const occ = new Map();
let maxCols = 0;
const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
rowChunks.forEach((chunk, r) => {
    let c = 0;
    let m;
    cellRe.lastIndex = 0;
    while ((m = cellRe.exec(chunk))) {
        const attrs = m[2];
        const text = cellText(m[3]);
        const cs = attr(attrs, "colspan");
        const rs = attr(attrs, "rowspan");
        while (occ.has(`${r},${c}`)) c++;
        for (let dr = 0; dr < rs; dr++) {
            for (let dc = 0; dc < cs; dc++) {
                occ.set(
                    `${r + dr},${c + dc}`,
                    dr === 0 && dc === 0 ? { anchor: true, text } : { anchor: false },
                );
            }
        }
        maxCols = Math.max(maxCols, c + cs);
        c += cs;
    }
});
const nRows = rowChunks.length;
const anchorText = (r, c) => {
    const e = occ.get(`${r},${c}`);
    return e && e.anchor ? e.text : "";
};
const isContinuation = (r, c) => {
    const e = occ.get(`${r},${c}`);
    return !!(e && !e.anchor);
};

// --- locate the header row + columns -----------------------------------------
const isTimeLabel = (s) => /^\d{1,2}:\d{2}$/.test(s);
let headerRow = -1;
for (let r = 0; r < nRows; r++) {
    const vals = [];
    for (let c = 0; c < maxCols; c++) vals.push(anchorText(r, c));
    if (vals.includes("Address") && vals.includes("12:00")) {
        headerRow = r;
        break;
    }
}
if (headerRow < 0) throw new Error("could not find header row (Address + 12:00)");

let addrCol = -1;
let locInfoCol = -1;
const colTime = new Map(); // grid column -> time label
for (let c = 0; c < maxCols; c++) {
    const v = anchorText(headerRow, c);
    if (v === "Address" && addrCol < 0)
        addrCol = c; // colspan=2 -> address number + street
    else if (v === "Location Info") locInfoCol = c;
    else if (isTimeLabel(v)) colTime.set(c, v);
}
const timeCols = [...colTime.keys()].sort((a, b) => a - b);

// --- time math (12h festival labels, no AM/PM; 12:00 == noon) ----------------
const toMinutes = (label) => {
    const [h, m] = label.split(":").map(Number);
    return (h === 12 ? 0 : h * 60) + m;
};
const toLabel = (total) => {
    let h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, "0")}`;
};

// --- extract porches + raw slots ---------------------------------------------
const porchOrder = new Map(); // address -> [location-info names]
const raw = []; // { name, porch, start, end }
for (let r = headerRow + 1; r < nRows; r++) {
    const a0 = anchorText(r, addrCol);
    const a1 = anchorText(r, addrCol + 1);
    if (!a0 && !a1) continue;
    if (a0.includes("DO NOT SHARE") || a0.toUpperCase().includes("PORCHES")) continue;
    const address = `${a0} ${a1}`.trim();
    const loc = anchorText(r, locInfoCol);
    if (!porchOrder.has(address)) porchOrder.set(address, []);
    if (loc && !porchOrder.get(address).includes(loc)) porchOrder.get(address).push(loc);

    let i = 0;
    while (i < timeCols.length) {
        const gc = timeCols[i];
        const val = anchorText(r, gc);
        if (val) {
            let run = 1;
            while (i + run < timeCols.length && isContinuation(r, timeCols[i + run])) run++;
            if (val.toUpperCase() !== "PARADE") {
                const start = colTime.get(gc);
                raw.push({
                    name: val,
                    porch: address,
                    start,
                    end: toLabel(toMinutes(start) + run * SLOT_MINUTES),
                });
            }
            i += run;
        } else i++;
    }
}

// --- apply overrides, group by band name, merge contiguous slots -------------
const kept = raw
    .filter((e) => !dropSet.has(e.name))
    .map((e) => ({ ...e, name: renameMap[e.name] ?? e.name }));

function mergeContiguous(slots) {
    const sorted = [...slots].sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]));
    const out = [];
    for (const s of sorted) {
        const last = out[out.length - 1];
        if (last && toMinutes(last[1]) === toMinutes(s[0])) last[1] = s[1];
        else out.push([...s]);
    }
    return out;
}

const byName = new Map();
for (const e of kept) {
    if (!byName.has(e.name)) byName.set(e.name, { name: e.name, porch: e.porch, slots: [] });
    const b = byName.get(e.name);
    if (b.porch !== e.porch)
        throw new Error(`band "${e.name}" appears on multiple porches: ${b.porch} / ${e.porch}`);
    b.slots.push([e.start, e.end]);
}

const bands = [...byName.values()].map((b) => {
    const slots = slotOverride[b.name] ?? mergeContiguous(b.slots);
    return {
        name: b.name,
        porch: b.porch,
        slots: slots.map(([startTime, endTime]) => ({ startTime, endTime })),
    };
});

// --- porches (dedupe by address; combine themed names) -----------------------
const porches = [...porchOrder.entries()].map(([address, names]) => {
    const porch = { address, block: null };
    if (names.length) porch.name = names.join(" / ");
    return porch;
});

// --- write + report ----------------------------------------------------------
const outDir = "src/data/schedule";
mkdirSync(outDir, { recursive: true });
const porchPath = join(outDir, `${day}-porch.json`);
const bandPath = join(outDir, `${day}-band.json`);
writeFileSync(porchPath, JSON.stringify(porches, null, 2) + "\n");
writeFileSync(bandPath, JSON.stringify(bands, null, 2) + "\n");

const addrs = new Set(porches.map((p) => p.address));
const danglingFk = bands.filter((b) => !addrs.has(b.porch)).map((b) => b.name);
const multiSlot = bands.filter((b) => b.slots.length > 1);
console.log(`wrote ${porchPath} (${porches.length} porches)`);
console.log(`wrote ${bandPath} (${bands.length} bands)`);
if (addrs.size !== porches.length) console.log(`  WARNING: duplicate porch addresses`);
if (danglingFk.length)
    console.log(`  WARNING: bands with unknown porch FK: ${danglingFk.join(", ")}`);
if (multiSlot.length) console.log(`  multi-slot bands: ${multiSlot.map((b) => b.name).join(", ")}`);
