import type { ChildStageGroup } from '../ui/ChildStages.types';
import { isTriageRow } from './hubSummary';
import { isMrSettled } from './isMrSettled';
import { isFinishedGroup } from './hubOrder';
import { hubBucket } from './hubBucket';

/**
 * Порядок карточек хаба. Сверху — то, где ещё что-то происходит или ждёт
 * человека, вниз уходит то, с чем всё (владелец 05.10, 06.10 и 09.10.2026):
 *
 * 1. в работе — идёт, стоит, ждёт ответа, на паузе, оборвано, в очереди;
 * 2. доставлено и ждёт приёмки человеком;
 * 3. принято человеком, но MR ещё не влит — ждёт слияния;
 * 4. закрыто: MR влит или закрыт, план отменён, копия убрана.
 *
 * Принятая отдельно от доставленной (09.10): в одной части они стояли
 * вперемешку по плану, и «Принять» не меняло на экране ничего — непонятно было,
 * что уже принято. Внутри каждой части — порядок плана: карточки не прыгают
 * между перерисовками. Строка разбора — общая на всё разделение, она первая,
 * чем бы ни кончилась.
 */
export function orderHubGroups(groups: readonly ChildStageGroup[]): ChildStageGroup[] {
  const triage = groups.filter(isTriageRow);
  const rest = groups.filter((group) => !isTriageRow(group));
  const tiers: ChildStageGroup[][] = [[], [], [], []];
  for (const group of rest) tiers[tierOf(group)]!.push(group);
  return [...triage, ...tiers.flat()];
}

function tierOf(group: ChildStageGroup): number {
  if (!isFinishedGroup(group)) return 0;
  if (isMrSettled(group) || group.copy?.cleaned) return 3;
  const bucket = hubBucket(group);
  if (bucket === 'cancelled') return 3;
  return bucket === 'accepted' ? 2 : 1;
}
