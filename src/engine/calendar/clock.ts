// R02 time display: day count plus the traditional double hour (时辰).
// Proper era calendars (年号, 农历, 节气) arrive in R03.

const SHICHEN = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];

export function shichen(hour: number): string {
  return SHICHEN[Math.floor((((hour + 1) % 24) + 24) % 24 / 2)];
}

export function clockParts(startHour: number, elapsedMinutes: number): { day: number; hour: number; minute: number; shichen: string } {
  const total = startHour * 60 + elapsedMinutes;
  const day = Math.floor(total / 1440) + 1;
  const inDay = total % 1440;
  const hour = Math.floor(inDay / 60);
  return { day, hour, minute: inDay % 60, shichen: shichen(hour) };
}

/** "第 3 日 · 酉时" */
export function formatClock(startHour: number, elapsedMinutes: number): string {
  const c = clockParts(startHour, elapsedMinutes);
  return `第 ${c.day} 日 · ${c.shichen}时`;
}
