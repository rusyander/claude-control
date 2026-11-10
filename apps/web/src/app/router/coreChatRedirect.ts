import { redirect } from '@tanstack/react-router';
import { apiClient } from '@shared/api/client';

/**
 * Старый адрес `/core/chat` (W3-17a): чат через ядро свёрнут в `/chat`, ход любого CLI идёт там.
 * Сохранённая ссылка не ломается: `project` переходит как есть (вкладка проекта), `cli` и
 * `resume` снимаются — CLI нового чата теперь активный провайдер, прежний разговор продолжается
 * на месте. `id` здесь — задача ядра: открывается разговор, который она ведёт по книге чата;
 * задачи, которой книга не помнит, — просто `/chat`.
 *
 * Без `project` в адресе вкладку называет сервер — проект, в чьём списке стоит разговор (этап 12):
 * чат перехвата живёт в копии единицы, и на домашней вкладке (только песочница) он был открыт, а
 * в списке — «Показано 0 из 0».
 */
export interface CoreChatSearch {
  project?: string;
  id?: string;
}

/** Ответ сервера о разговоре задачи: id по книге и вкладка его проекта. */
export interface CoreTaskChat {
  chatId: string | null;
  project?: string;
}

/** Куда ведёт старый адрес: разговор задачи (если книга его знает) и проект — без прочего. */
export function coreChatTarget(
  search: CoreChatSearch,
  chat: CoreTaskChat | null | undefined,
): { to: '/chat'; search: CoreChatSearch } {
  const project = search.project ?? (chat?.chatId ? chat.project : undefined);
  return {
    to: '/chat',
    search: {
      ...(chat?.chatId ? { id: chat.chatId } : {}),
      ...(project ? { project } : {}),
    },
  };
}

/** Разговор задачи ядра по книге чата; сбой запроса — `null`, переход всё равно идёт в `/chat`. */
async function chatOfTask(taskId: string): Promise<CoreTaskChat | null> {
  try {
    const { data } = await apiClient.get<CoreTaskChat>(
      `/chat/core-task/${encodeURIComponent(taskId)}`,
    );
    return data;
  } catch {
    return null;
  }
}

/** `beforeLoad` маршрута `/core/chat`: страницы больше нет, только переход. */
export async function redirectCoreChat({ search }: { search: CoreChatSearch }): Promise<never> {
  const chat = search.id ? await chatOfTask(search.id) : null;
  throw redirect({ ...coreChatTarget(search, chat), replace: true } as never);
}
