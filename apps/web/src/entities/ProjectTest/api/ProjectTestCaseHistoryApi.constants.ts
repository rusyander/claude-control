import { testKeys } from './keys';

/**
 * История результатов кейса по прогонам и отметки «нестабилен».
 *
 * Ключи — под общим корнем тестов, так что сброс всего поддерева задевает и
 * их. Отметки ещё и привязаны к `stamp` — подписи последнего прогона агента:
 * прогон кончился, подпись сменилась, и строки библиотеки перечитывают вердикт,
 * не дожидаясь перезагрузки страницы. История кейса привязана к той же подписи:
 * без неё открытая «История» показывала прежние итоги до переоткрытия окна
 * (ревью z3 C01). Ручной проход подписи не меняет — его команды сбрасывают обе
 * ветки проекта сами (`testKeys.flaky/caseHistory`).
 */
export const caseHistoryKeys = {
  history: (path: string | undefined, groupId: string, caseId: string, stamp: string) => [
    ...testKeys.caseHistory(path),
    groupId,
    caseId,
    stamp,
  ],
  flaky: (path: string | undefined, stamp: string) => [...testKeys.flaky(path), stamp],
};
