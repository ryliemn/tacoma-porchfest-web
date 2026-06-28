// Bootstrap parser: turns the raw lineup CSV into structured schedule JSON.
//
// This is a ONE-TIME bootstrap to seed src/data/schedule/<day>.json. After the
// first run, the JSON is the hand-curated source of truth (fix typos, resolve
// TBDs, attach map coords later) — re-running this will OVERWRITE those edits,
// so treat it as a refresh aid, not a live pipeline.
//
// Usage: node scripts/parse-schedule.mjs data/source/lineup-saturday.csv Saturday

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [, , csvPath, dayArg] = process.argv;
if (!csvPath) {
    console.error("usage: node scripts/parse-schedule.mjs <csv> [dayName]");
    process.exit(1);
}
const day = dayArg ?? "Saturday";

// --- minimal RFC-4180-ish CSV parser (handles quotes + escaped "") ---------
function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else inQuotes = false;
            } else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ",") {
            row.push(field);
            field = "";
        } else if (c === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else if (c !== "\r") field += c;
    }
    if (field !== "" || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

// --- helpers ---------------------------------------------------------------
const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();
const isTimeLabel = (s) => /^\d{1,2}:\d{2}$/.test(clean(s));

// "6:30" -> "7:00" (festival 12-hour labels, no AM/PM, range is 12:00..6:30)
function plus30(label) {
    let [h, m] = label.split(":").map(Number);
    m += 30;
    if (m >= 60) {
        m -= 60;
        h = (h % 12) + 1;
    }
    return `${h}:${String(m).padStart(2, "0")}`;
}

// Parse a single schedule cell into a set descriptor (or a marker / null).
function parseCell(rawCell) {
    const raw = clean(rawCell);
    if (raw === "") return null; // empty slot
    if (raw === "?") return null; // TBD placeholder — drop
    if (raw.toUpperCase() === "PARADE") return { parade: true };

    let name = raw;
    let durationMinutes = null;
    // trailing (...) group: numeric -> set duration, otherwise leave for curation
    const m = raw.match(/\(([^)]*)\)\s*$/);
    if (m) {
        const inner = m[1].trim();
        name = raw.slice(0, m.index).trim();
        if (/^\d+$/.test(inner)) durationMinutes = Number(inner);
    }
    name = clean(name);
    if (name === "") return null;
    return { name, durationMinutes, tentative: raw.includes("?"), raw };
}

// --- main ------------------------------------------------------------------
const rows = parseCSV(readFileSync(csvPath, "utf8"));
const header = rows[0];

// Column layout: 0=cluster, 1=address, 2=venue, 3=notes, then time columns.
const timeCols = [];
for (let i = 4; i < header.length; i++) {
    if (isTimeLabel(header[i])) timeCols.push({ index: i, label: clean(header[i]) });
}
const lastTimeIndex = timeCols[timeCols.length - 1].index;

const porches = [];
for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const cluster = clean(row[0]) || null;
    const address = clean(row[1]) || null;
    const venue = clean(row[2]) || null;
    const notes = clean(row[3]) || null;

    // Walk the time columns, building per-slot parsed cells.
    const slots = timeCols.map((c) => {
        const parsed = parseCell(row[c.index]);
        return parsed?.parade ? null : parsed; // PARADE is festival-wide, hardcoded in code
    });

    // Collapse runs of identical, adjacent act names into a single spanning set.
    const sets = [];
    for (let s = 0; s < slots.length; s++) {
        const cur = slots[s];
        if (!cur) continue;
        let end = s;
        while (end + 1 < slots.length && slots[end + 1] && slots[end + 1].name === cur.name) end++;
        const set = {
            time: timeCols[s].label,
            name: cur.name,
            durationMinutes: cur.durationMinutes,
        };
        if (end > s) set.endTime = plus30(timeCols[end].label); // multi-slot span
        if (cur.tentative) set.tentative = true;
        sets.push(set);
        s = end;
    }

    // Anything spilling past the last time column (e.g. a 7:00+ overflow act).
    const extra = [];
    for (let i = lastTimeIndex + 1; i < row.length; i++) {
        const v = clean(row[i]);
        if (v) extra.push(v);
    }

    // Skip blank separator rows.
    if (!address && !venue && sets.length === 0 && extra.length === 0) continue;

    const porch = { address, venue, cluster, notes, sets };
    if (extra.length) porch.extra = extra;
    porches.push(porch);
}

const outDir = "src/data/schedule";
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${day.toLowerCase()}.json`);
writeFileSync(outPath, JSON.stringify(porches, null, 2) + "\n");

const setCount = porches.reduce((n, p) => n + p.sets.length, 0);
const tentative = porches.reduce((n, p) => n + p.sets.filter((s) => s.tentative).length, 0);
console.log(`wrote ${outPath}`);
console.log(`  porches: ${porches.length}`);
console.log(`  sets:    ${setCount} (${tentative} tentative)`);
