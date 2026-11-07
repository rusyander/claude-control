import { redirect } from '@tanstack/react-router';
import { apiClient } from '@shared/api/client';

/**
 * Старый адрес `/core/chat` (W3-17a): чат через ядро свёрнут в `/chat`, ход любого CLI идёт там.
 * Сохранённая ссылка не ломается: `project` переходит как есть (вкладка проекта), `cli` и
 * `resume` снимаются — CLI нового чата теперь активный провайдер, прежний разговор продолжается
 * на месте. `id` здесь — задача ядра: открывается разговор, который она ведёт по книге чата;
 * задачи, которой книга не помнит, — просто `/chat`.
 */
export interface CoreChatSearch {
  project?: string;
  id?: string;
}

/** Куда ведёт старый адрес: разговор задачи (если книга его знает) и проект — без прочего. */
export function coreChatTarget(
  search: CoreChatSearch,
  chatId: string | null | undefined,
): { to: '/chat'; search: CoreChatSearch } {
  return {
    to: '/chat',
    search: {
      ...(chatId ? { id: chatId } : {}),
      ...(search.project ? { project: search.project } : {}),
    },
  };
}

/** Разговор задачи ядра по книге чата; сбой запроса — `null`, переход всё равно идёт в `/chat`. */
async function chatOfTask(taskId: string): Promise<string | null> {
  try {
    const { data } = await apiClient.get<{ chatId: string | null }>(
      `/chat/core-task/${encodeURIComponent(taskId)}`,
    );
    return data.chatId;
  } catch {
    return null;
  }
}

/** `beforeLoad` маршрута `/core/chat`: страницы больше нет, только переход. */
export async function redirectCoreChat({ search }: { search: CoreChatSearch }): Promise<never> {
  const chatId = search.id ? await chatOfTask(search.id) : null;
  throw redirect({ ...coreChatTarget(search, chatId), replace: true } as never);
}
