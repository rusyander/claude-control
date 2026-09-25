import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { TaskSplitProposal, TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { CascadeAssignment } from '@agentdeck/contracts/model-cascade';
import { chatTreeKeys } from '@entities/ChatTree';
import { apiClient } from '@shared/api/client';
import { normalizeProjectPath } from '@shared/lib/workspace';

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

export function useSplitTasks() {
  return useMutation(splitTasksOptions(useQueryClient()));
}

/**
 * Текст просьбы «раздели задачи», который уходит агенту по кнопке. Живёт на
 * сервере вместе с описанием формата: вторая копия инструкции в клиенте
 * разошлась бы с первой на ближайшей же правке блока.
 *
 * Проект, модель и глубину сервер спрашивает не из любопытства: по ним он решает,
 * действует ли здесь подбор модели, и называет агенту НАСТОЯЩИЙ потолок этого
 * разговора. Без них к просьбе не приложится строка о классах работы — кнопка
 * молча работала бы иначе, чем инициатива.
 */
export async function fetchSplitRequestPrompt(context: {
  path?: string;
  model?: string;
  effort?: string;
}): Promise<string> {
  const { data } = await apiClient.get<{ prompt: string }>('/chat/split/request', {
    params: context,
  });
  return data.prompt;
}

/**
 * Отказ от разделения. Реплика агенту уходит отдельно и живёт один ход, а эта
 * отметка гасит инициативу разговора совсем: иначе следующий же прогон предложил
 * бы то же самое. Сбой глотаем — отказ и без записи сработал репликой.
 */
export async function declineSplit(chatId: string): Promise<void> {
  await apiClient.post('/chat/split/decline', { chatId }).catch(() => undefined);
}

/**
 * Правило «подбирать модель под задачу»: панель сама ставит группе модель по
 * роду её работы, а работе ниже потолка поднимает планку сдачи.
 *
 * Положение помнится на ПРОЕКТ, а не на разговор: решение относится к
 * репозиторию и цене ошибки в нём. Умолчание — включено, поэтому пока ответ не
 * пришёл, интерфейс показывает включённый тумблер, а не «выключено».
 */
const cascadeKey = (path: string | undefined): readonly unknown[] => [
  'chat-cascade',
  path ? normalizeProjectPath(path) : '',
];

export function useCascadeRule(path: string | undefined) {
  return useQuery({
    queryKey: cascadeKey(path),
    queryFn: async () => {
      const { data } = await apiClient.get<{ enabled: boolean; project: string }>('/chat/cascade', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
  });
}

export function useSetCascadeRule(path: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data } = await apiClient.put<{ enabled: boolean; project: string }>('/chat/cascade', {
        path,
        enabled,
      });
      return data;
    },
    // Ответ и есть новое состояние: лишний запрос следом здесь не нужен, а вот
    // соседние вкладки того же проекта должны увидеть смену — их ключ другой,
    // поэтому гасим всё семейство.
    onSuccess: (data) => {
      queryClient.setQueryData(cascadeKey(path), data);
      void queryClient.invalidateQueries({ queryKey: ['chat-cascade'] });
    },
  });
}
