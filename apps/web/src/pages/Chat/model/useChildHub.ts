import { useEffect, useMemo } from 'react';
import type { ChatSummary } from '@claude-control/contracts';
import { agentRuns, type ActiveRunView } from '@shared/lib/agent-runs';
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
  /**
   * Ветки уже заведённых детей. По ним карточка разделения понимает, что
   * предложение отработано, и убирает кнопку: иначе она остаётся живой до
   * следующей реплики агента, и второе нажатие заводит те же копии ещё раз.
   */
  branches: string[];
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
  const hub = useMemo(() => {
    const all = chats ?? [];
    const children = parentChatId ? all.filter((chat) => chat.parentId === parentChatId) : [];
    return {
      questions: collectChildQuestions(all, parentChatId, runs),
      permissions: collectChildPermissions(all, parentChatId, runs),
      list: children.map((chat) => ({ id: chat.id, title: chat.title || chat.id })),
      branches: children.map((chat) => chat.branch ?? '').filter(Boolean),
    };
  }, [chats, parentChatId, runs]);

  // Ветви открытого разговора важнее прочих фоновых: их вопросы и запросы прав
  // показываются здесь, а приходят они только потоком — потоков же на всех не
  // хватает (`MAX_STREAMS`), и стор раздаёт их по важности.
  const watchedIds = hub.list.map((child) => child.id).join('\n');
  useEffect(() => {
    agentRuns.setWatched(watchedIds ? watchedIds.split('\n') : []);
  }, [watchedIds]);

  return hub;
}
