/** Сколько идёт то, что стартовало в `startedAt`, — к моменту `now`. */
export function elapsedMs(startedAt: string | undefined, now: number): number | undefined {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isNaN(start) ? undefined : Math.max(0, now - start);
}
