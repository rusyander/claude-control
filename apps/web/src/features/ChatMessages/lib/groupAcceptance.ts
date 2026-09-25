import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ChildStageGroup } from '../ui/ChildStages.types';

/**
 * Приёмка группы в строке хаба (TK-accepted). Кнопку «Принять» получает
 * группа, которую конвейер закрыл «готово», и только пока её звено не идёт:
 * принимать работу, которая прямо сейчас меняется, нечего. Принятая группа
 * отметку показывает всегда — снять её человек вправе в любой момент.
 */
export function acceptanceOf(
  group: SplitPlanView['groups'][number],
  split: SplitPlanView,
  isRunning: boolean,
): Pick<ChildStageGroup, 'acceptance'> {
  const open = group.status === 'done' && !isRunning;
  if (!open && !group.acceptedAt) return {};
  return {
    acceptance: {
      parentChatId: split.parentChatId,
      index: group.index,
      ...(group.acceptedAt ? { acceptedAt: group.acceptedAt } : {}),
    },
  };
}
