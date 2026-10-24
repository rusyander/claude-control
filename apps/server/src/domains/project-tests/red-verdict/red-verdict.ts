/**
 * Красное кейса по двум последним записям — общей (исполненный прогон или
 * запись словом, `attested`) и последней ИСПОЛНЕННОЙ. Одно правило для конца хода
 * (`turn-gate`) и для доставки группы (`chat/tests-gate`), чтобы на одном входе
 * они не расходились (RF-EF-03):
 *
 * - исполненный красный не снимается поздней записью словом (F-22): `record
 *   …=blocked` или `=passed` после упавшей команды красное не прячет;
 * - красная запись словом — красное, даже если раньше команда была зелёной: агент
 *   сам сказал «упало», и прятать это за старым зелёным нельзя;
 * - зелёное слово без исполненного прогона красным не становится — о «нет
 *   исполненного прогона» говорят свои пробелы ворот.
 *
 * Возвращается запись, по которой судить причину красного: исполненная, если
 * красная она, — у неё настоящая заметка о сбое; иначе красное слово.
 */
export const RED_STATUSES: readonly string[] = ['failed', 'blocked'];

export function isRedStatus(status: string | undefined): boolean {
  return status !== undefined && RED_STATUSES.includes(status);
}

export function redOf<T extends { status: string }>(
  latest: T | undefined,
  executed: T | undefined,
): T | undefined {
  if (executed && isRedStatus(executed.status)) return executed;
  if (latest && isRedStatus(latest.status)) return latest;
  return undefined;
}
