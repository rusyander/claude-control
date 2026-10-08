/** «5 мин», «2 ч», «3 дн» — без календаря: важна свежесть, а не дата. */
export function ageMinutes(iso: string, now: number): number {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((now - at) / 60_000));
}
