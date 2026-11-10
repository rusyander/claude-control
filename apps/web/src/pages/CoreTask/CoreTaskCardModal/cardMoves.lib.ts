import { keyedRefusalOf, type KeyedRefusal, type RefusalRule } from '@entities/CoreTask';

/**
 * Отказ хода карточки для человека: проза `moves.ts` `applyMove` английская по контракту (какой ход,
 * из какого состояния), поэтому на экран идёт строка `coreBoard.moves.refusals.*`, а проза —
 * подсказкой. Ход `merge` говорит свой раздел (`relatedMerge.lib.ts`), смену пресета — выбор
 * сценария (`entryPreset.lib.ts`).
 */
const MOVE_REFUSAL_RULES: readonly RefusalRule[] = [
  [
    /^move (\S+) is not allowed from (\S+)/,
    'notAllowed',
    (m) => ({ move: m[1] ?? '', state: m[2] ?? '' }),
  ],
  [/^a started task moves by its journal/, 'startedTask', () => ({})],
  [/^a task card has no board moves/, 'taskCard', () => ({})],
  [/^"before" orders only the queue or the inbox/, 'beforeOnly', () => ({})],
  [/^entry \S+ is not in the \S+ column/, 'anchorGone', () => ({})],
  [/^no board entry /, 'gone', () => ({})],
];

export function moveRefusalOf(error: unknown): KeyedRefusal {
  return keyedRefusalOf(error, MOVE_REFUSAL_RULES);
}
