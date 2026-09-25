import type { SplitGroupAccepted } from '@agentdeck/contracts/chat-handoff';
import { coded } from '../../lib/server-text.ts';
import type { SplitConveyorStore } from './split-conveyor.ts';

/**
 * «Принять» доставленную группу разделения и «Снять отметку» (TK-accepted).
 *
 * Приёмку делает человек, вручную: панель по фактам доставки (MR, ревью, живой
 * прогон) отметку не ставит — «всё на месте» ещё не значит «я посмотрел и
 * согласен». Поэтому здесь нет ни одной проверки фактов, только состояние
 * группы: принять можно то, что конвейер закрыл `done`.
 *
 * Оба направления идемпотентны: повторное «Принять» оставляет первое время
 * приёмки, «Снять отметку» у непринятой группы — не ошибка. Кнопку жмут из
 * двух вкладок, и второй клик не должен ни сдвигать время, ни ругаться.
 */
export function acceptSplitGroup(
  store: Pick<SplitConveyorStore, 'get' | 'set'>,
  input: { parentChatId: string; index: number; accepted: boolean },
  now: () => Date = () => new Date(),
): SplitGroupAccepted {
  const record = store.get(input.parentChatId);
  const group = record?.groups.find((item) => item.index === input.index);
  const refuse = () =>
    coded(
      new Error('Принять нечего: группы нет или она ещё не доставлена'),
      'split-accept-not-done',
    );
  if (!record || !group) throw refuse();

  if (!input.accepted) {
    if (group.acceptedAt) {
      delete group.acceptedAt;
      store.set(record);
    }
    return { index: group.index };
  }

  if (group.status !== 'done') throw refuse();
  if (!group.acceptedAt) {
    group.acceptedAt = now().toISOString();
    store.set(record);
  }
  return { index: group.index, acceptedAt: group.acceptedAt };
}
