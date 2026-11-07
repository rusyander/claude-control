import type { PlatformGatewayEvent } from '@agentdeck/contracts';

/**
 * Отказ, пахнущий правами, — из книги контуров ядра (этап 10, C3d).
 *
 * Запросы CLI идут через шлюз человека у ядра, и отказ контура 401/403 видит оно: событие
 * контура с этим кодом. Шлюз в панели звал `PlatformWatch.noteRightsRefusal` прямо с пути
 * запроса; теперь путь запроса у ядра, и панель узнаёт об отказе из того же опроса учёта,
 * что ведёт карточку (`CoreContours`, раз в `CONTOURS_POLL_MS`). Отсюда каждое НОВОЕ событие
 * с 401/403 уходит сторожу — его пол и отсев по активному контуру не дают пробе обстреливать
 * чужой журнал.
 *
 * Новое — позже метки: при заводе это «сейчас», затем самое позднее увиденное событие. События,
 * записанные ядром до старта панели, пробу не зовут: при старте панели не ходит никто
 * (ограничение 3 сторожа), а повтор одного и того же снимка не зовёт её второй раз.
 */

/** 401 — ключ отклонён (отозван, истёк); 403 — ключу не дано (снятая с ключа модель). */
const RIGHTS_STATUSES = new Set([401, 403]);

export interface RightsFeedDeps {
  note: (platformId: string) => void;
  now?: () => number;
}

/** Читатель снимков книги контуров: каждый успешный опрос ядра отдаёт сюда её события. */
export function createRightsFeed(
  deps: RightsFeedDeps,
): (events: readonly PlatformGatewayEvent[] | undefined) => void {
  let mark = (deps.now ?? Date.now)();
  return (events) => {
    let newest = mark;
    const refused = new Set<string>();
    for (const event of events ?? []) {
      const at = Date.parse(event.at);
      if (!(at > mark)) continue;
      if (at > newest) newest = at;
      if (RIGHTS_STATUSES.has(event.status)) refused.add(event.platformId);
    }
    mark = newest;
    for (const platformId of refused) deps.note(platformId);
  };
}
