import type { GroupWatch } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../../lib/app-store/app-store.types.ts';
import { clip, MINUTE_MS, minutes } from '../rules-util.ts';
import type { RuleHit } from '../watch.types.ts';

/**
 * R43 UNRESUMED — группа стоит на паузе, а человеку решать нечего: ни вопроса, на
 * котором её остановили (`pausedWait`), ни ждущего D-n. Пауза сторожа (F1) — его
 * просьба посмотреть, а не решение остановиться: о ней напоминаем вчетверо раньше
 * (как внешний сторож: 15 мин против часа). Пауза дерева («Остановить всё») статус
 * группы не меняет — это намеренная остановка, о ней правило молчит.
 */
export const WATCH_PAUSE_FACTOR = 4;

export function unresumedPause(
  group: SplitPlanGroupRecord,
  settings: Pick<GroupWatch, 'unresumedMinutes'>,
  now: number,
  humanWaits: boolean,
): RuleHit | undefined {
  if (group.status !== 'paused' || !group.pausedAt) return undefined;
  if (group.pausedWait || humanWaits) return undefined;
  const at = Date.parse(group.pausedAt);
  if (!Number.isFinite(at)) return undefined;
  const byWatch = group.pausedBy === 'watch';
  const limit = (settings.unresumedMinutes * MINUTE_MS) / (byWatch ? WATCH_PAUSE_FACTOR : 1);
  if (now - at < limit) return undefined;
  return {
    rule: 'R43',
    severity: 'info',
    numbers: { pausedMin: minutes(now - at) },
    ...(byWatch && group.pausedRule ? { params: { rule: clip(group.pausedRule, 12) } } : {}),
    since: at,
    textKey: byWatch ? 'groupWatch.rule.R43watch' : 'groupWatch.rule.R43',
  };
}
