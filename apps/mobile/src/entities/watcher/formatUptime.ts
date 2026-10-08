/** Как в панели: `4с`, `1м 12с`, `1ч 03м` — два разряда, минуты при часах с нулём. */
export function formatUptime(ms: number, units: { h: string; m: string; s: string }): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}${units.s}`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}${units.m} ${String(total % 60).padStart(2, '0')}${units.s}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}${units.h} ${String(minutes % 60).padStart(2, '0')}${units.m}`;
}
