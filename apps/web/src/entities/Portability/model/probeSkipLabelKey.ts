/** Причина пропуска. Без перевода показывает свой код, а не пустоту. */
export function probeSkipLabelKey(skip: string): string {
  return `portability.probe.skip.${skip}`;
}
