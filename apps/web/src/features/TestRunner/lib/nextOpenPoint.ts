/**
 * Куда вести после отметки: к следующему НЕОТМЕЧЕННОМУ проходу, потом к
 * первому открытому сначала; всё отмечено — остаться на месте.
 *
 * Соседний проход годится только при проходе подряд. Человек, вернувшийся
 * перепройти пятый из семи, после отметки попадал на уже закрытый шестой и
 * листал до места, где остановился, руками.
 */
export function nextOpenPoint(
  points: { id: string }[],
  results: { pointId: string }[],
  from: number,
): number {
  const done = new Set(results.map((item) => item.pointId));
  const ahead = points.findIndex((item, index) => index > from && !done.has(item.id));
  if (ahead >= 0) return ahead;
  const first = points.findIndex((item) => !done.has(item.id));
  return first >= 0 ? first : from;
}
