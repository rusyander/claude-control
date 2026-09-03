import type { ChatSummary } from '@claude-control/contracts';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import type { ChildPermission } from '@features/ChatMessages';

/**
 * Запросы прав, которыми дочерние разговоры ждут человека.
 *
 * Та же беда, что и с вопросами (см. `childQuestions.ts`), только хуже: на
 * вопросе агент работает дальше, а на запросе прав он СТОИТ. Разделение разводит
 * работу по шести чатам, и пока разрешение спрашивалось только в самом ребёнке,
 * человек узнавал об остановке, лишь обойдя все вкладки по кругу, — а до тех пор
 * половина агентов просто ждала.
 *
 * Автоподтверждение это не отменяет: оно наследуется от родителя, но безопасные
 * запросы гасит только оно, а всё под правилами `ask`/`deny` и опасное (записи в
 * git, удаление, миграции) спрашивается всё равно.
 *
 * Ключ прогона сверяется дважды — по нему самому и по `sessionId`: разговор,
 * заведённый разделением, живёт под временным `new-…`, пока CLI не выдаст
 * настоящий идентификатор сессии.
 */
export function collectChildPermissions(
  chats: ChatSummary[],
  parentChatId: string | undefined,
  runs: ActiveRunView[],
): ChildPermission[] {
  if (!parentChatId) return [];

  const children = chats.filter((chat) => chat.parentId === parentChatId);
  if (children.length === 0) return [];

  const found: ChildPermission[] = [];
  for (const run of runs) {
    const permissions = run.permissions ?? [];
    if (permissions.length === 0) continue;
    const child = children.find((chat) => chat.id === run.id || chat.id === run.sessionId);
    if (!child) continue;
    found.push({ chatId: run.id, title: child.title || child.id, permissions });
  }
  return found;
}
