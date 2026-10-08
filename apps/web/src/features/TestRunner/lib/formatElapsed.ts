/**
 * Секундомер как `мм:сс` — без часов: один проход столько не идёт.
 *
 * Живёт рядом с самим секундомером, а не в разметке: время поинта уходит в
 * результат прогона, и показанное человеку обязано быть тем же числом.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}
