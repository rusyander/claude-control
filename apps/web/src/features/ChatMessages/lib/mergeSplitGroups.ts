import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ChildStageGroup } from '../ui/ChildStages.types';

/**
 * Склейка строк хаба с записью конвейера уровней: порядок старта плюс группы,
 * у которых чата ЕЩЁ НЕТ.
 *
 * Живёт в фиче, а не рядом с одной из страниц, потому что лент переписки в
 * панели две — своя у Claude и своя у чужого CLI, — и группу без чата надо
 * показать в обеих: пока разбор считает, пока группа ждёт предшественников,
 * пока она ждёт ОТВЕТА ЧЕЛОВЕКА. Последнее особенно: отвечают на вопрос разбора
 * прямо здесь, и строки, которой нет, не существует и вопроса.
 *
 * Отличаются страницы только источником готовых строк — список чатов и реестр
 * прогонов у Claude, дерево у чужого CLI, — и потому сюда приходит уже готовая
 * карта «ключ группы → строка». Ключ — ветка, иначе название группы: звенья
 * одной группы живут в одной копии и в одной ветке.
 */
export function mergeSplitGroups(
  byKey: Map<string, ChildStageGroup>,
  split: SplitPlanView,
): ChildStageGroup[] {
  // Порядок конвейера: разбор, потом группы как он их выстроил, потом всё, что
  // в конвейере не значится (чаты старше него или заведённые руками).
  const ordered: ChildStageGroup[] = [];
  const taken = new Set<string>();
  const take = (key: string | undefined): void => {
    if (!key || taken.has(key)) return;
    const row = byKey.get(key);
    if (!row) return;
    taken.add(key);
    ordered.push(row);
  };

  take([...byKey.entries()].find(([, row]) => row.stages.includes('triage'))?.[0]);
  const order = [
    ...split.order,
    ...split.groups.map((group) => group.index).filter((index) => !split.order.includes(index)),
  ];
  for (const index of order) {
    const group = split.groups.find((item) => item.index === index);
    if (!group) continue;
    const found = findRow(byKey, group.branch || group.title, group.chatId);
    if (found) {
      taken.add(found.key);
      ordered.push({
        ...found.row,
        title: group.title || found.row.title,
        ...(group.base ? { base: group.base } : {}),
      });
      continue;
    }
    ordered.push(pendingRow(group, split));
  }
  for (const [key] of byKey) take(key);
  return ordered;
}

/** Строка группы конвейера среди строк по чатам: по ключу ветки, иначе по чату. */
function findRow(
  byKey: Map<string, ChildStageGroup>,
  key: string,
  chatId: string | undefined,
): { key: string; row: ChildStageGroup } | undefined {
  const direct = byKey.get(key);
  if (direct) return { key, row: direct };
  if (!chatId) return undefined;
  for (const [known, row] of byKey) if (row.chatId === chatId) return { key: known, row };
  return undefined;
}

/**
 * Строка группы без чата: конвейер её ещё не завёл. Что именно она ждёт —
 * единственное, что тут можно показать, и единственное, что человеку нужно:
 * «ждёт ответа» — это про него.
 */
function pendingRow(group: SplitPlanView['groups'][number], split: SplitPlanView): ChildStageGroup {
  const titleOf = (index: number): string =>
    split.groups.find((item) => item.index === index)?.title ?? `#${index + 1}`;
  // Ждущее состояние конвейера — как есть; всё остальное («pending», а также
  // «started»/«done» у группы, чей чат до списка ещё не доехал) читается как
  // «ждёт итога разбора»: строке нужно сказать, почему группы не видно.
  const known = ['held', 'waiting', 'failed'] as const;
  const pending: ChildStageGroup['pending'] =
    known.find((status) => status === group.status) ?? 'pending';
  return {
    chatId: '',
    title: group.title,
    ...(group.branch ? { branch: group.branch } : {}),
    stages: [],
    isRunning: false,
    pending,
    // Номер группы в конвейере: им адресуются обе двери к стоящей группе —
    // ответ на вопрос разбора и «отпустить», не дожидаясь предшественников.
    groupIndex: group.index,
    ...(group.after.length > 0 ? { waitsFor: group.after.map(titleOf) } : {}),
    ...(group.hold ? { hold: { index: group.index, question: group.hold } } : {}),
    ...(group.holdAnswer ? { holdAnswered: true } : {}),
    ...(group.base ? { base: group.base } : {}),
    ...(group.error ? { error: group.error } : {}),
  };
}
