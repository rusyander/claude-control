/**
 * Куда уходит фокус со стрелки: соседняя вкладка, с края — на другой край
 * (список короткий, упираться в него нечем). Home/End — первая и последняя.
 * Незнакомая клавиша — `undefined`: событие не наше, его не гасим.
 */
export function nextPageTab<T extends string>(
  ids: readonly T[],
  active: T,
  key: string,
): T | undefined {
  if (ids.length === 0) return undefined;
  const index = Math.max(0, ids.indexOf(active));
  const at = (offset: number): T | undefined => ids[(index + offset + ids.length) % ids.length];
  if (key === 'ArrowRight' || key === 'ArrowDown') return at(1);
  if (key === 'ArrowLeft' || key === 'ArrowUp') return at(-1);
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  return undefined;
}
