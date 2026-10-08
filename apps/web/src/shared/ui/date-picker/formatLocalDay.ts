/** Обратное преобразование: местные сутки → `YYYY-MM-DD` без сдвига в UTC. */
export function formatLocalDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
