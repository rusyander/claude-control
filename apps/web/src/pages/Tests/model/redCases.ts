import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { isRed } from './isRed';

/**
 * Кейсы прогона, которые надо перепрогнать: провалы и блокировки.
 *
 * Блокировка тут наравне с провалом: и то и другое означает «результата нет».
 * Кейс попадает в список один раз, сколько бы точек у него ни было, — иначе
 * «перепрогнать провалившиеся» запустило бы один и тот же кейс дважды.
 */
export function redCases(record: ProjectTestRunRecord | undefined): string[] {
  const ids = (record?.results ?? [])
    .filter((item) => isRed(item.status))
    .map((item) => item.caseId);
  return [...new Set(ids)];
}
