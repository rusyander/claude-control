import type { ChildStageGroup } from '../ui/ChildStages.types';
import { countedGroups } from './countedGroups';
import { keepWarmGained } from './tokenLedgerText';

/** Итог подогрева кэша по всему разделению — для сводки хаба. */
export interface KeepWarmTotal {
  /** Сумма `saved` подведённых ожиданий, в токенах по цене входа; бывает отрицательной. */
  saved: number;
  tone: 'saved' | 'lost';
  /** Сколько групп дали подведённый итог. */
  groups: number;
}

/**
 * Сколько сберёг подогрев кэша по всем группам (владелец 22.10.2026: экономию
 * хочется видеть числом, а не собирать глазами по карточкам). Складываются
 * только подведённые ожидания (`settled`) — у остальных исход неизвестен, и
 * прежний счёт без итога сбережением не считается (как на карточке). Других
 * замеров экономии у групп нет, и сводка их не придумывает. Нет ни одного
 * подведённого ожидания — итога нет.
 */
export function keepWarmTotal(groups: ChildStageGroup[]): KeepWarmTotal | undefined {
  let saved = 0;
  let realized = 0;
  let settled = 0;
  for (const group of countedGroups(groups)) {
    const keepWarm = group.tokens?.ledger.keepWarm;
    if (!keepWarm || (keepWarm.settled ?? 0) <= 0) continue;
    settled += 1;
    saved += keepWarm.saved ?? 0;
    realized += keepWarm.realized ?? 0;
  }
  if (settled === 0) return undefined;
  return { saved, groups: settled, tone: keepWarmGained(saved, realized) ? 'saved' : 'lost' };
}
