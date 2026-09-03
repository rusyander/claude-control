import { useMemo } from 'react';
import type { ChatSummary } from '@claude-control/contracts';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import type { ChildPermission, ChildQuestion } from '@features/ChatMessages';
import { collectChildQuestions } from '../lib/childQuestions';
import { collectChildPermissions } from '../lib/childPermissions';

/** Всё, что родительский разговор знает о своих детях, одним объектом. */
export interface ChildHub {
  /** Вопросы детей — показываются и отвечаются прямо в родителе. */
  questions: ChildQuestion[];
  /** Запросы прав детей — там же: на них работа СТОИТ. */
  permissions: ChildPermission[];
  /**
   * Сами дети, именами. Нужны тостам: вопрос ребёнка ОТКРЫТОГО чата не должен
   * звать «сходите в другой проект» — он показан здесь же, а переход завёл бы
   * отдельную вкладку копии, от которой разделение как раз уходит. Про «упал» и
   * «закончил» сказать надо, но именем разговора, а не именем его ветки.
   */
  list: { id: string; title: string }[];
}

/**
 * Родительский чат как пульт над своими детьми.
 *
 * Разделение разводит работу по нескольким агентам, но человек остаётся один, и
 * обходить шесть вкладок ради одного и того же выбора — не работа. Всё, что
 * ждёт человека у детей, собирается здесь и показывается в родителе; своим
 * ключом остаётся `parentId` из списка чатов, а прогон сверяется и по временному
 * `new-…`, и по настоящему `sessionId`.
 */
export function useChildHub(
  chats: ChatSummary[] | undefined,
  parentChatId: string | undefined,
  runs: ActiveRunView[],
): ChildHub {
  return useMemo(() => {
    const all = chats ?? [];
    return {
      questions: collectChildQuestions(all, parentChatId, runs),
      permissions: collectChildPermissions(all, parentChatId, runs),
      list: parentChatId
        ? all
            .filter((chat) => chat.parentId === parentChatId)
            .map((chat) => ({ id: chat.id, title: chat.title || chat.id }))
        : [],
    };
  }, [chats, parentChatId, runs]);
}
