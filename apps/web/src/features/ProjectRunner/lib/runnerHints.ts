/** Порт из отказа сервера: он кладёт его в тело ответа рядом с сообщением. */
export function busyPortOf(error: unknown): number | undefined {
  const data = (error as { response?: { data?: { busyPort?: unknown } } })?.response?.data;
  return typeof data?.busyPort === 'number' ? data.busyPort : undefined;
}

/** Подпись «откуда список целей» — догадка честно называется догадкой. */
export function sourceHint(
  source: 'pnpm' | 'npm' | 'scan' | undefined,
  t: (key: string) => string,
): string {
  if (source === 'pnpm') return t('runner.sourcePnpm');
  if (source === 'npm') return t('runner.sourceNpm');
  if (source === 'scan') return t('runner.sourceScan');
  return t('runner.sourceSingle');
}
