import type { Analytics } from '@agentdeck/contracts';

/**
 * JSON-выгрузка снимка аналитики.
 *
 * Из выгрузки исключаются `runningAgents` — это живые процессы машины на момент
 * снимка, а не исторический расход. Отчёту «о расходе» они не нужны, а файл,
 * который уходит в чужие руки, не должен нести сведения о текущих процессах.
 */
export function buildJson(data: Analytics): string {
  const exportable: Partial<Analytics> = { ...data };
  delete exportable.runningAgents;
  return JSON.stringify(exportable, null, 2);
}
