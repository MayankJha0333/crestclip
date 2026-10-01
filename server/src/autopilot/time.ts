/**
 * Time-slot math for Autopilot. People pick times like "13:00" in THEIR time zone;
 * a slot key ("2026-10-02T13:00") names one posting time on one day, in that zone.
 */

export interface Slot {
  key: string; // local date + time, e.g. "2026-10-02T13:00"
  at: number; // epoch ms
  date: string; // "2026-10-02"
  time: string; // "13:00"
}

const pad = (n: number) => String(n).padStart(2, '0');

export function isValidZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock parts of `ms` in time zone `tz`. */
export function localParts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, hh: o.hour % 24, mm: o.minute, ss: o.second };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (e.g. +5:30 → 19800000). */
function offsetAt(ms: number, tz: string) {
  const p = localParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
}

/** Local wall-clock time in `tz` → epoch ms (handles daylight-saving changes). */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let at = guess - offsetAt(guess, tz);
  const again = guess - offsetAt(at, tz);
  if (again !== at) at = again;
  return at;
}

export const slotKey = (date: string, time: string) => `${date}T${time}`;

/** Every posting time from `fromMs` for `days` days (today included), soonest first. */
export function upcomingSlots(times: string[], tz: string, fromMs: number, days: number): Slot[] {
  const out: Slot[] = [];
  const start = localParts(fromMs, tz);
  for (let i = 0; i < days; i++) {
    // walk calendar days in the zone (noon avoids DST edge cases)
    const noon = zonedToUtc(start.y, start.m, start.d, 12, 0, tz) + i * 86400_000;
    const day = localParts(noon, tz);
    const date = `${day.y}-${pad(day.m)}-${pad(day.d)}`;
    for (const t of times) {
      const [hh, mm] = t.split(':').map(Number);
      const at = zonedToUtc(day.y, day.m, day.d, hh, mm, tz);
      if (at > fromMs) out.push({ key: slotKey(date, t), at, date, time: t });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** "2026-10-02T13:00" in tz → epoch ms */
export function slotTime(key: string, tz: string) {
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
}
