import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ChildStageGroup } from '../ui/ChildStages.types';

/** Пока идёт ход или фоновая команда, отмечать нечего: работа под отметкой меняется. */
const BUSY: readonly string[] = ['started', 'background'];

/**
 * Приёмка группы в строке хаба (TK-accepted). Доставленная («готово») группа
 * получает «Принять»; любая другая остановившаяся — «Отметить готовой»
 * (владелец 20.10): застрявшую или остановленную человек закрывает сам. Пока
 * звено идёт, кнопки нет. Отмеченная группа отметку показывает всегда — снять
 * её человек вправе в любой момент.
 */
export function acceptanceOf(
  group: SplitPlanView['groups'][number],
  split: SplitPlanView,
  isRunning: boolean,
): Pick<ChildStageGroup, 'acceptance'> {
  const open = !isRunning && !BUSY.includes(group.status) && !split.cancelledAt;
  if (!open && !group.acceptedAt) return {};
  return {
    acceptance: {
      parentChatId: split.parentChatId,
      index: group.index,
      ...(group.status === 'done' ? {} : { markable: true }),
      ...(group.acceptedAt ? { acceptedAt: group.acceptedAt } : {}),
      ...(group.markedDoneAt ? { markedDoneAt: group.markedDoneAt } : {}),
    },
  };
}
