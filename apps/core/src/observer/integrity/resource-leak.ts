import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Predicate } from '../observer.types.ts';

export const RESOURCE_LEAK_SIGNAL = 'resource-leak';

/**
 * Утечка ресурса (06:140, F11): каждая строка `resource.leak` — один сигнал. Строку пишут те, кто
 * снимал ресурс и не смог (аренда маршрута, копия, служба, запись сеанса); наблюдатель только
 * показывает её человеку (`warn` + `show` по каталогу): чинить ресурс — дело владельца, а не шага.
 * Ключ — номер строки: две строки об одном ресурсе — два факта, ни один не теряется.
 */
export const resourceLeak: Predicate<null> = {
  ids: [RESOURCE_LEAK_SIGNAL],
  init: () => null,
  step(state, line) {
    if (line.kind !== 'resource.leak') return { state, verdicts: [] };
    const { rid, reason } = (line as JournalLine<'resource.leak'>).data;
    return {
      state,
      verdicts: [
        {
          fired: true,
          signal: RESOURCE_LEAK_SIGNAL,
          subject: rid,
          detail: reason,
          reasons: [`resource ${rid} was not released: ${reason}`],
          key: `${RESOURCE_LEAK_SIGNAL}:${line.seq}`,
          ...(line.stepId ? { stepId: line.stepId } : {}),
          ...(line.sessionId ? { sessionId: line.sessionId } : {}),
        },
      ],
    };
  },
};
