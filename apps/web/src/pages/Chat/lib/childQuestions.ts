import type { ChatSummary } from '@claude-control/contracts';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import type { ChildQuestion } from '@features/ChatMessages';

/**
 * Вопросы, которыми дочерние разговоры ждут человека.
 *
 * Разделение задач разводит работу по шести агентам, но человек остаётся один, и
 * обходить шесть чатов ради одного и того же выбора — не работа. Поэтому вопрос
 * ребёнка показывается в РОДИТЕЛЬСКОМ разговоре и отвечается прямо оттуда:
 * ответ уходит следующим сообщением в ЕГО чат (в очередь, если он ещё работает),
 * а ход родителя на это не тратится.
 *
 * Берётся вопрос из потока прогона — из вызова `AskUserQuestion`. Другого места
 * нет: в пакетном режиме этот вызов сразу возвращается ошибкой и до брокера прав
 * не доходит вовсе (замерено, см. `QUESTION_PROMPT` на сервере). Значит, канала
 * «агент стоит и ждёт» не существует, и единственный признак вопроса — сам
 * вызов.
 *
 * Показываем ПОСЛЕДНИЙ вопрос каждого ребёнка: за длинный ход их бывает
 * несколько, и все, кроме свежего, человек уже прокрутил в самом чате.
 *
 * Ключ прогона сверяется дважды — по нему самому и по `sessionId`. Разговор,
 * заведённый разделением, живёт под временным `new-…`, пока Claude Code не
 * выдаст настоящий идентификатор сессии, и по одному только `id` половина детей
 * не нашлась бы: в списке агентов вопрос видно, а в родителе — нет.
 */
export function collectChildQuestions(
  chats: ChatSummary[],
  parentChatId: string | undefined,
  runs: ActiveRunView[],
): ChildQuestion[] {
  if (!parentChatId) return [];

  const children = chats.filter((chat) => chat.parentId === parentChatId);
  if (children.length === 0) return [];

  const found: ChildQuestion[] = [];
  for (const run of runs) {
    const child = children.find((chat) => chat.id === run.id || chat.id === run.sessionId);
    if (!child) continue;
    const asked = [...(run.tools ?? [])]
      .reverse()
      .find((tool) => tool.name === 'AskUserQuestion' && tool.input);
    if (!asked) continue;
    found.push({
      chatId: run.id,
      title: child.title || child.id,
      input: asked.input,
      // Занятость ребёнка меняет не доступность выбора, а судьбу ответа: пока
      // он работает, ответ ждёт в его очереди — карточка обязана сказать это
      // прямо, иначе «отправлено» выглядит как «уже читает».
      isRunning: run.status === 'running',
      ...(asked.id ? { toolUseId: asked.id } : {}),
    });
  }
  return found;
}
