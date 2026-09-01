import { useMutation } from '@tanstack/react-query';
import type { TaskSplitProposal, TaskSplitResult } from '@claude-control/contracts/task-split';
import { apiClient } from '@shared/api/client';

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
}

export function useSplitTasks() {
  return useMutation({
    mutationFn: async (body: SplitTasksBody) => {
      const { data } = await apiClient.post<TaskSplitResult>('/chat/split', body);
      return data;
    },
  });
}

/**
 * Текст просьбы «раздели задачи», который уходит агенту по кнопке. Живёт на
 * сервере вместе с описанием формата: вторая копия инструкции в клиенте
 * разошлась бы с первой на ближайшей же правке блока.
 */
export async function fetchSplitRequestPrompt(): Promise<string> {
  const { data } = await apiClient.get<{ prompt: string }>('/chat/split/request');
  return data.prompt;
}
