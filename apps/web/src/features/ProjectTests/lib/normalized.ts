/** Значение действия с подставленным умолчанием списка: пустой select — не выбор. */
export function normalized(kind: string, value: string): string {
  if (value) return value.trim();
  if (kind === 'priority') return 'medium';
  if (kind === 'readiness') return 'ready';
  if (kind === 'automation') return 'manual';
  return '';
}
