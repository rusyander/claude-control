import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  ChatTreePaused,
  ChatTreeResumed,
  ChatTreeView,
  SplitGroupAccepted,
  SplitGroupCleaned,
  SplitGroupPaused,
  SplitGroupResumed,
  SplitOverlapView,
  SplitPlanCancelled,
  SplitReviewOutcome,
} from '@agentdeck/contracts/chat-handoff';
import type { TaskSplitResult, TaskSplitReviewDecision } from '@agentdeck/contracts/task-split';
import { apiClient } from '@shared/api/client';
import { treeRefetchMs } from '../lib/treeRefetch';

/**
 * Дерево разговоров одной просьбы и его пауза — сторона клиента.
 *
 * Дерево считает СЕРВЕР: связи «родитель → потомок» живут у него, и он же
 * глушит автостарты в стоящем дереве, когда вкладки нет. Клиенту остаётся
 * спросить и нажать; корень сервер находит по любому разговору дерева сам.
 */

export const chatTreeKeys = {
  all: ['chat-tree'] as const,
  tree: (chatId: string) => ['chat-tree', chatId] as const,
};

export function useChatTree(chatId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: chatTreeKeys.tree(chatId ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ChatTreeView>(
        `/chat/${encodeURIComponent(chatId ?? '')}/tree`,
      );
      return data;
    },
    enabled: Boolean(chatId) && enabled,
    refetchInterval: (query) => treeRefetchMs(query.state.data),
  });
}

export function usePauseTree() {
  return useMutation({
    mutationFn: async (chatId: string) => {
      const { data } = await apiClient.post<ChatTreePaused>(
        `/chat/${encodeURIComponent(chatId)}/tree/pause`,
      );
      return data;
    },
  });
}

export function useResumeTree() {
  return useMutation({
    mutationFn: async (chatId: string) => {
      const { data } = await apiClient.post<ChatTreeResumed>(
        `/chat/${encodeURIComponent(chatId)}/tree/resume`,
      );
      return data;
    },
  });
}

/**
 * Ответ человека на вопрос разбора (Т1). Адресуется РОДИТЕЛЮ, а не чату
 * группы: у стоящей группы чата ещё нет — копия заводится после ответа, и
 * ответ уезжает в её план и в работу заметкой.
 */
export function useAnswerHold() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number; answer: string }) => {
      const { data } = await apiClient.post<TaskSplitResult>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/hold`,
        { index: input.index, answer: input.answer },
      );
      return data;
    },
  });
}

/**
 * «Отпустить» группу, которая ждёт предшественников (Т1).
 *
 * Вторая и последняя дверь к стоящей группе: ответ на вопрос разбора двигает
 * только `held`, а цепочка предшественника может не кончиться никогда — прогон
 * остановили, чат удалили, панель перезапустилась. Адресуется, как и ответ,
 * РОДИТЕЛЮ с номером группы: чата у стоящей группы ещё нет.
 */
export function useReleaseGroup() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number }) => {
      const { data } = await apiClient.post<TaskSplitResult>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/release`,
        { index: input.index },
      );
      return data;
    },
  });
}

/**
 * «Продолжить» оборванные группы (WP1c): без номера — все, с номером — одну.
 * Адресуется РОДИТЕЛЮ: он знает, какие из его групп оборвались.
 */
export function useResumeInterrupted() {
  return useMutation({
    // Отказ показывает вызов своим тостом; общий из MutationCache встал бы
    // вторым, с сырым текстом сервера (живой прогон 26.09, F4).
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index?: number }) => {
      const { data } = await apiClient.post<{ resumed: number[]; refused: number[] }>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/resume`,
        input.index === undefined ? {} : { index: input.index },
      );
      return data;
    },
  });
}

/**
 * Убрать копию закрытой группы (Д19) — по кнопке человека: панель сама не
 * удаляет ничего. Ветка уходит с копией, только если пустая. Адресуется
 * РОДИТЕЛЮ с номером группы — как ответ и «отпустить». Группа прошлого
 * разделения (F5.2) — чатом: её номер от старого плана и занят новой группой.
 */
export const cleanupGroupMutation = {
  mutationFn: async (
    input: { parentChatId: string } & ({ index: number } | { chatId: string }),
  ) => {
    const { data } = await apiClient.post<SplitGroupCleaned>(
      `/chat/split/${encodeURIComponent(input.parentChatId)}/cleanup`,
      'chatId' in input ? { chatId: input.chatId } : { index: input.index },
    );
    return data;
  },
};

export function useCleanupGroup() {
  return useMutation({ ...cleanupGroupMutation, meta: { silentError: true } });
}

/**
 * Пересечения веток разделения (Т6) по кнопке в хабе.
 *
 * Это ЧТЕНИЕ, а не действие, и всё же мутация: считает его сервер запросами к
 * git, длится это секунды, и нажатие должно крутить кнопку, а не молча висеть в
 * кэше. Результат приезжает и сам — вместе с деревом, которое пульт и так
 * опрашивает: ответ здесь нужен только чтобы понять, чем кончилось нажатие.
 */
export function useCheckOverlap() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (parentChatId: string) => {
      const { data } = await apiClient.get<SplitOverlapView>(
        `/chat/split/${encodeURIComponent(parentChatId)}/overlap`,
      );
      return data;
    },
  });
}

/**
 * Решение человека по ревью чужого MR (Т7). Адресуется РОДИТЕЛЮ с ключом
 * группы: «применить ко всем» — это про соседние группы того же дерева, и знает
 * их сервер.
 *
 * Ответ подробный (что записано в MR, что заведено), потому что решение
 * «и отписать, и починить» может сработать наполовину: комментарий отклонён
 * форджем, а правки пошли. Показать это обязана одна реплика.
 */
export function useReviewDecision() {
  return useMutation({
    mutationFn: async (input: {
      parentChatId: string;
      chatId: string;
      decision: TaskSplitReviewDecision;
      all?: boolean;
    }) => {
      const { data } = await apiClient.post<SplitReviewOutcome>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/review-decision`,
        { chatId: input.chatId, decision: input.decision, ...(input.all ? { all: true } : {}) },
      );
      return data;
    },
  });
}

/**
 * «Закоммитить и отправить в MR» (Т7) — вторым кликом после правок.
 *
 * Отдельной ручкой, а не решением: это запись в ЧУЖУЮ ветку. Панель её не
 * делает сама ни при каких настройках, и согласие человека на неё отдельное.
 */
/** «Повторить итог ревью» (Д4): то же сообщение в ту же сессию ревью. */
export function useReviewRetry() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; chatId: string }) => {
      const { data } = await apiClient.post<SplitReviewOutcome>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/review-retry`,
        { chatId: input.chatId },
      );
      return data;
    },
  });
}

export function useReviewPush() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; chatId: string }) => {
      const { data } = await apiClient.post<SplitReviewOutcome>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/review-push`,
        { chatId: input.chatId },
      );
      return data;
    },
  });
}

/**
 * Управление одной группой из хаба (журнал 81, 89). Адресуется РОДИТЕЛЮ с
 * номером группы — как ответ и «отпустить». `force` — согласие человека идти
 * сверх потолка или мимо лимита подписки: без него сервер отвечает 409 с числами.
 */
export function usePauseGroup() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number }) => {
      const { data } = await apiClient.post<SplitGroupPaused>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/pause`,
        { index: input.index },
      );
      return data;
    },
  });
}

export function useResumePausedGroup() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number; force?: boolean }) => {
      const { data } = await apiClient.post<SplitGroupResumed>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/resume-paused`,
        { index: input.index, ...(input.force ? { force: true } : {}) },
      );
      return data;
    },
  });
}

export function useStartGroupNow() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number; force?: boolean }) => {
      const { data } = await apiClient.post<TaskSplitResult>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/start-now`,
        { index: input.index, ...(input.force ? { force: true } : {}) },
      );
      return data;
    },
  });
}

/**
 * «Отменить план» разделения (W3-5): сервер останавливает прогоны групп и
 * закрывает план; чаты и ветки остаются, разделить можно заново.
 */
export function useCancelSplitPlan() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string }) => {
      const { data } = await apiClient.post<SplitPlanCancelled>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/cancel`,
      );
      return data;
    },
  });
}

/**
 * «Принять» доставленную группу и «Снять отметку» (`accepted: false`). Приёмка
 * ручная: отметку ставит только эта кнопка, а не факты доставки. Повтор
 * безопасен — сервер оставляет первое время приёмки.
 */
export function useAcceptGroup() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number; accepted: boolean }) => {
      const { data } = await apiClient.post<SplitGroupAccepted>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/accept`,
        { index: input.index, accepted: input.accepted },
      );
      return data;
    },
  });
}

/** Тело «Завести тикет»: ключ предложения и описание на языке интерфейса. */
export interface FileSplitTicketInput {
  parentChatId: string;
  key: string;
  description: string;
}

/** Запрос «Завести тикет» — отдельно от хука, чтобы проверять его без React. */
export const fileSplitTicketMutation = {
  mutationFn: async (input: FileSplitTicketInput) => {
    const { data } = await apiClient.post<{ key: string; created: boolean }>(
      `/chat/split/${encodeURIComponent(input.parentChatId)}/tickets/file`,
      { key: input.key, description: input.description },
    );
    return data;
  },
};

/**
 * «Завести» предложенный группой тикет в трекере проекта (L277) — после
 * подтверждения человека в строке хаба. Повтор безопасен: сервер отдаёт уже
 * заведённый ключ, вторую задачу не заводит.
 */
export function useFileSplitTicket() {
  // Отказ показывает строка хаба своим тостом — общий молчит.
  return useMutation({ ...fileSplitTicketMutation, meta: { silentError: true } });
}

/**
 * «Убрать» строку «разрешено автоматически» в хабе (аудит 25.09, L51): человек
 * увидел, что группа разрешила себе по строке «с отметкой», — отметки стираются.
 */
export function useDismissAutoNotices() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (input: { parentChatId: string; index: number }) => {
      const { data } = await apiClient.post<{ index: number; dismissed: number }>(
        `/chat/split/${encodeURIComponent(input.parentChatId)}/auto-notices/dismiss`,
        { index: input.index },
      );
      return data;
    },
  });
}
