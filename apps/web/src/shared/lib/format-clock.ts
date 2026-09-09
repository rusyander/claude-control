/**
 * Время суток из ISO-строки: `10:00:04`. Дата не нужна — подсказка бейджа
 * показывает границы шага, а шаг длиннее суток не бывает. Битая строка даёт
 * пустоту, не «Invalid Date».
 */
export function formatClock(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
