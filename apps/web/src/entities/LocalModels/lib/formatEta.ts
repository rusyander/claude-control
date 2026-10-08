export function formatEta(
  t: (key: string, options: { count: number }) => string,
  sec: number,
): string {
  return sec >= 90
    ? t('localModels.job.minutes', { count: Math.round(sec / 60) })
    : t('localModels.job.seconds', { count: sec });
}
