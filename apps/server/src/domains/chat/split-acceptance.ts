import type { SplitGroupAccepted } from '@agentdeck/contracts/chat-handoff';
import { coded } from '../../lib/server-text/server-text.ts';
import type { SplitGroupStatus, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { SplitConveyorStore } from './split-conveyor/split-conveyor.ts';

/**
 * Пока у группы идёт ход или фоновая команда, отметить её готовой нельзя:
 * отметку тут же снял бы её же следующий ход, а работа под ней меняется.
 */
const UNMARKABLE: readonly SplitGroupStatus[] = ['started', 'background'];

/**
 * «Принять» доставленную группу и «Снять отметку» (TK-accepted), а также
 * «Отметить готовой» любую остановившуюся группу (владелец 20.10).
 *
 * Приёмку делает человек, вручную: панель по фактам доставки (MR, ревью, живой
 * прогон) отметку не ставит — «всё на месте» ещё не значит «я посмотрел и
 * согласен». Поэтому здесь нет ни одной проверки фактов, только состояние
 * группы. Доставленную (`done`) отметка только принимает. Застрявшую,
 * остановленную или упавшую человек закрывает сам: она становится `done` и
 * сразу принятой, ждавшие её стартуют (`onMarked`), а прежнее состояние
 * хранится в `markedDone` — «Снять отметку» возвращает его как было.
 *
 * Оба направления идемпотентны: повторное «Принять» оставляет первое время
 * приёмки, «Снять отметку» у непринятой группы — не ошибка. Кнопку жмут из
 * двух вкладок, и второй клик не должен ни сдвигать время, ни ругаться.
 */
export function acceptSplitGroup(
  store: Pick<SplitConveyorStore, 'get' | 'set'>,
  input: { parentChatId: string; index: number; accepted: boolean },
  now: () => Date = () => new Date(),
  onMarked?: (record: SplitPlanRecord) => void,
): SplitGroupAccepted {
  const record = store.get(input.parentChatId);
  const group = record?.groups.find((item) => item.index === input.index);
  const refuse = () =>
    coded(
      new Error('Отметить нечего: группы нет или она сейчас работает'),
      'split-accept-not-done',
    );
  if (!record || !group) throw refuse();

  if (!input.accepted) {
    const marked = group.markedDone;
    if (!group.acceptedAt && !marked) return { index: group.index };
    delete group.acceptedAt;
    if (marked) {
      group.status = marked.from;
      for (const key of ['waitingFor', 'error', 'doneAt'] as const) {
        if (marked[key]) group[key] = marked[key] as never;
        else delete group[key];
      }
      delete group.markedDone;
    }
    store.set(record);
    return { index: group.index };
  }

  if (group.acceptedAt) {
    return {
      index: group.index,
      acceptedAt: group.acceptedAt,
      ...(group.markedDone ? { markedDone: true as const } : {}),
    };
  }
  if (UNMARKABLE.includes(group.status)) throw refuse();

  const at = now().toISOString();
  group.acceptedAt = at;
  if (group.status === 'done') {
    store.set(record);
    return { index: group.index, acceptedAt: at };
  }

  group.markedDone = {
    at,
    from: group.status,
    ...(group.waitingFor ? { waitingFor: group.waitingFor } : {}),
    ...(group.error ? { error: group.error } : {}),
    ...(group.doneAt ? { doneAt: group.doneAt } : {}),
  };
  group.status = 'done';
  group.doneAt = at;
  delete group.waitingFor;
  delete group.error;
  // Отложенное продолжение ушло бы закрытой группе новым ходом и сняло бы
  // отметку; перепроверка тоже больше никого не ждёт.
  delete group.parked;
  delete group.recheckRequestedAt;
  delete group.continueQueuedAt;
  store.set(record);
  onMarked?.(record);
  return { index: group.index, acceptedAt: at, markedDone: true };
}
