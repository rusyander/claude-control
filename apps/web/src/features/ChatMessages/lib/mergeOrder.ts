import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { GroupMergeOrder } from '../ui/ChildStages.types';

type SplitGroup = SplitPlanView['groups'][number];

/**
 * Очередь слияния MR групп (G3, владелец 05.10.2026): у кнопки MR в хабе —
 * «мержить N-м из M», в подсказке — кого влить раньше.
 *
 * Порядок — топологическая сортировка по отношению «предшественник»: группа
 * ждёт `after` разбора, и её копия отведена от ветки предшественника (`base`
 * равна его ветке), — значит, и вливать её после него. Равные — в порядке
 * плана (`order`, не попавшие в него — по номеру группы): так же раскладывает
 * порядок слияния раздел пересечений веток, и два места хаба не спорят.
 *
 * Номер получает только группа со своим MR, которую можно вливать по
 * порядку: каждый её предшественник либо уже влит, либо сам в очереди.
 * Предшественник без MR (ещё работает, сдался, убран, его MR закрыт без
 * слияния) — номера нет: сказать «мержить вторым», когда первого нечем
 * вливать, — догадка, а не порядок. Круг в зависимостях или ссылка на
 * несуществующую группу — номеров нет ни у кого: порядок из такой записи
 * не выводится. Отменённый план — тоже без номеров.
 */
export function mergeOrderOf(split: SplitPlanView): Map<number, GroupMergeOrder> {
  const none = new Map<number, GroupMergeOrder>();
  if (split.cancelledAt) return none;

  const byIndex = new Map(split.groups.map((group) => [group.index, group]));
  const byBranch = new Map(
    split.groups.filter((group) => group.branch).map((group) => [group.branch, group.index]),
  );
  const predecessors = new Map<number, number[]>();
  for (const group of split.groups) {
    const refs = new Set(group.after);
    const baseOwner = group.base ? byBranch.get(group.base) : undefined;
    if (baseOwner !== undefined && baseOwner !== group.index) refs.add(baseOwner);
    predecessors.set(group.index, [...refs]);
  }

  const sorted = topologicalOrder(split, predecessors);
  if (!sorted) return none;

  // Кто стоит в очереди: свой MR, не влит и не закрыт, и все предшественники
  // (по цепочке) влиты или сами в очереди — их проверяем раньше по порядку.
  const queued: number[] = [];
  const ready = new Set<number>();
  for (const index of sorted) {
    const group = byIndex.get(index) as SplitGroup;
    if (!hasOwnOpenMr(group)) continue;
    const blocked = (predecessors.get(index) ?? []).some(
      (ref) => !ready.has(ref) && byIndex.get(ref)?.mrClosed !== 'merged',
    );
    if (blocked) continue;
    ready.add(index);
    queued.push(index);
  }

  const result = new Map<number, GroupMergeOrder>();
  queued.forEach((index, at) => {
    const earlier = ancestorsOf(index, predecessors);
    result.set(index, {
      position: at + 1,
      total: queued.length,
      before: queued
        .slice(0, at)
        .filter((ref) => earlier.has(ref))
        .map((ref) => byIndex.get(ref)?.title || `#${ref + 1}`),
    });
  });
  return result;
}

/** Свой MR, который ещё предстоит влить: не чужой по ссылке (Т7), не убран, не закрыт. */
function hasOwnOpenMr(group: SplitGroup): boolean {
  return Boolean(group.mr) && !group.review && !group.droppedAt && !group.mrClosed;
}

/**
 * Проходы по плану, как у сервера (`mergeOrderOf` в split-overlap): за проход
 * встаёт каждая группа, чьи предшественники уже стоят, — в порядке плана.
 * Тот же обход, что у раздела пересечений, иначе фишка и раздел называли бы
 * разный порядок. Проход ничего не поставил — в записи круг или ссылка на
 * группу, которой нет (её предшественник не встанет никогда): порядка нет.
 */
function topologicalOrder(
  split: SplitPlanView,
  predecessors: ReadonlyMap<number, number[]>,
): number[] | undefined {
  const known = new Set(split.groups.map((group) => group.index));
  const plan = [...new Set(split.order.filter((index) => known.has(index)))];
  for (const group of split.groups) if (!plan.includes(group.index)) plan.push(group.index);

  const placed = new Set<number>();
  const result: number[] = [];
  while (result.length < plan.length) {
    const before = result.length;
    for (const index of plan) {
      if (placed.has(index)) continue;
      if (!(predecessors.get(index) ?? []).every((ref) => placed.has(ref))) continue;
      placed.add(index);
      result.push(index);
    }
    if (result.length === before) return undefined;
  }
  return result;
}

/** Все предшественники группы по цепочке. */
function ancestorsOf(index: number, predecessors: ReadonlyMap<number, number[]>): Set<number> {
  const seen = new Set<number>();
  const stack = [...(predecessors.get(index) ?? [])];
  while (stack.length) {
    const ref = stack.pop() as number;
    if (seen.has(ref)) continue;
    seen.add(ref);
    stack.push(...(predecessors.get(ref) ?? []));
  }
  return seen;
}

/** Английское порядковое числительное: 1st, 2nd, 3rd, 4th, 11th, 22nd. */
export function englishOrdinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[value % 10] ?? 'th';
  return `${value}${suffix}`;
}
