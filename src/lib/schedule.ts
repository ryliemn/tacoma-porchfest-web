// Join normalized porch + band records into the per-porch shape the schedule
// table renders. Porches and bands are stored as two separate files (the porch
// address is the join key); this reassembles each porch's booked sets in start
// order so <ScheduleDay> can lay them into time columns.
//
// The `block` field is a number in the data (matching an SVG map block id like
// <g id="7">); it is stringified here because everything downstream — the
// data-block attribute, the pf:block event, the ?block= URL param — compares
// against SVG element ids, which are always strings.

// A porch may have no `name` key at all (the parser only sets it when the sheet
// gives the porch a venue/stage name), so `name` is optional here.
type RawPorch = { address: string; block: number | null; name?: string | null };
type RawBand = {
    name: string;
    porch: string;
    slots: { startTime: string; endTime: string }[];
};

export type DaySet = {
    time: string;
    name: string;
    durationMinutes: number | null;
    endTime?: string;
};

export type DayPorch = {
    address: string | null;
    venue: string | null;
    cluster: string | null;
    notes: string | null;
    sets: DaySet[];
    block: string | null;
};

// Festival runs 12pm–7pm; fold "12:00".."7:00" onto a sortable minute-of-day
// (12 stays noon, 1–7 read as 13:00–19:00).
const toMinutes = (t: string): number => {
    const [h, m] = t.split(":").map(Number);
    return (h === 12 ? 12 : h + 12) * 60 + m;
};

export function buildDay(porches: RawPorch[], bands: RawBand[]): DayPorch[] {
    const setsByPorch = new Map<string, DaySet[]>();
    for (const band of bands) {
        for (const slot of band.slots) {
            const list = setsByPorch.get(band.porch) ?? [];
            list.push({
                time: slot.startTime,
                name: band.name,
                endTime: slot.endTime,
                durationMinutes: toMinutes(slot.endTime) - toMinutes(slot.startTime),
            });
            setsByPorch.set(band.porch, list);
        }
    }
    return porches.map((p) => ({
        address: p.address,
        venue: p.name ?? null,
        cluster: null,
        notes: null,
        sets: (setsByPorch.get(p.address) ?? []).sort(
            (a, b) => toMinutes(a.time) - toMinutes(b.time),
        ),
        block: p.block == null ? null : String(p.block),
    }));
}
