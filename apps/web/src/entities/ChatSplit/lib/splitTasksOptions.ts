import type { TaskSplitProposal, TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { CascadeAssignment } from '@agentdeck/contracts/model-cascade';
import { apiClient } from '@shared/api/client';
import type { QueryClient } from '@tanstack/react-query';
import { chatTreeKeys } from '@entities/ChatTree';

/**
 * Разделение списка задач по нескольким чатам.
 *
 * Всю работу делает сервер одним запросом: заводит копии репозитория под ветки
 * групп и открывает в них разговоры. Клиенту остаётся открыть вкладки на путях
 * из ответа — цикла «создай копию, потом запусти прогон» здесь нет намеренно,
 * иначе он существовал бы и в панели, и в телефоне, и разошёлся бы.
 */

export interface SplitTasksBody {
  /** Каталог проекта, из которого делят. */
  projectPath: string;
  proposal: TaskSplitProposal;
  /** Запускать агентов сразу или только завести чаты с готовым заданием. */
  startRuns: boolean;
  allowEdits: boolean;
  model?: string;
  effort?: string;
  /** Разговор, из которого выделяют, — корень дерева в списке чатов. */
  parentChatId?: string;
  /**
   * Ручные замены с карточки: номер группы → что человек выбрал ей сам. Едут
   * рядом с предложением, а не внутри него: просьба агента о модели действует
   * только вверх, выбор человека — в обе стороны, и подмешанные друг в друга на
   * сервере они бы не различались.
   */
  assignments?: Record<number, CascadeAssignment>;
}

/**
 * `silentError` выключает общий тост из MutationCache: отказ разбирают оба
 * вызова сами (409 «план ещё идёт» — предложением его отменить), и общий тост
 * встал бы вторым, с сырым текстом сервера (живой прогон 25.09, D2).
 */
export const splitTasksMutation = {
  mutationFn: async (body: SplitTasksBody) => {
    const { data } = await apiClient.post<TaskSplitResult>('/chat/split', body);
    return data;
  },
  meta: { silentError: true },
};

/**
 * Запрос считается идущим, пока дерево не перечитано: по записи плана в дереве
 * заперта кнопка «Разделить», и между ответом 200 и новым деревом она
 * оживала на долю секунды — второе нажатие ловило 409 (живой прогон 26.09, D1).
 * Обещание из `onSuccess` мутация ждёт, и `isPending` держится до конца.
 */
export function splitTasksOptions(queryClient: QueryClient) {
  return {
    ...splitTasksMutation,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatTreeKeys.all }),
  };
}
