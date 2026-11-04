import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatSummary } from '@agentdeck/contracts';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { agentRuns, type ActiveRunView } from '@shared/lib/agent-runs';
import { toast } from '@shared/lib/toast';
import { chatKeys } from '@entities/Chat';
import { chatTreeKeys, useChatTree, usePauseTree, useResumeTree } from '@entities/ChatTree';
import type { ChildPermission, ChildQuestion, ChildStageGroup } from '@features/ChatMessages';
import { collectChildQuestions } from '../lib/childQuestions';
import { collectChildPermissions } from '../lib/childPermissions';
import { collectChildStages } from '../lib/childStages';
import { withTreeAsks } from '../lib/withTreeAsks';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

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
   * Группы разделения с их звеньями: на чём каждая стоит сейчас и чем ведётся.
   * Считается по веткам, а не по чатам — у одной группы разговоров до четырёх.
   */
  stages: ChildStageGroup[];
  /**
   * Дерево разговоров с сервера: сколько идёт и стоит ли всё на паузе. Есть
   * только у разговора с детьми — у остальных спрашивать нечего.
   */
  tree?: ChatTreeView;
  /** Остановить / продолжить всё дерево; пока запрос идёт — `treeBusy`. */
  pauseAll: () => void;
  resumeAll: () => void;
  treeBusy: boolean;
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
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const hub = useMemo(() => {
    const all = chats ?? [];
    const children = parentChatId ? all.filter((chat) => chat.parentId === parentChatId) : [];
    return {
      questions: collectChildQuestions(all, parentChatId, runs),
      permissions: collectChildPermissions(all, parentChatId, runs),
      list: children.map((chat) => ({ id: chat.id, title: chat.title || chat.id })),
    };
  }, [chats, parentChatId, runs]);

  // Ветви открытого разговора важнее прочих фоновых: их вопросы и запросы прав
  // показываются здесь, а приходят они только потоком — потоков же на всех не
  // хватает (`MAX_STREAMS`), и стор раздаёт их по важности.
  const watchedIds = hub.list.map((child) => child.id).join('\n');
  useEffect(() => {
    agentRuns.setWatched(watchedIds ? watchedIds.split('\n') : []);
  }, [watchedIds]);

  // Дерево и его пауза — с сервера: он знает связи и он же глушит автостарты в
  // стоящем дереве. После нажатия прогоны стартуют и гаснут ВНЕ этой вкладки,
  // поэтому стор прогонов пересчитывается тем же путём, что после F5.
  const tree = useChatTree(parentChatId, true);
  // Вопросы и права отцепленных групп — из записи сервера (журнал 30, 36, 62):
  // поток прогона видит только подключённая вкладка, а группу конвейера не
  // смотрит никто, и её вопрос иначе не доходил до хаба вовсе.
  const asks = useMemo(
    () => withTreeAsks(hub, tree.data, parentChatId, chats ?? []),
    [hub, tree.data, parentChatId, chats],
  );
  const pause = usePauseTree();
  const resume = useResumeTree();
  const settle = (): void => {
    void agentRuns.resumeActive();
    void queryClient.invalidateQueries({ queryKey: chatKeys.list });
    void queryClient.invalidateQueries({ queryKey: chatTreeKeys.tree(parentChatId ?? '') });
  };
  const fail = (error: unknown): void => {
    toast.error(
      t('chat.cascade.tree.failed', {
        message: toErrorMessage(error),
      }),
    );
  };

  const pauseAll = (): void => {
    if (!parentChatId || pause.isPending) return;
    pause.mutate(parentChatId, {
      onSuccess: (result) => {
        toast.success(t('chat.cascade.tree.pausedToast', { count: result.stopped }));
        // Процесс жив, номер нечем проверить (F-145): «остановлено» было бы неправдой.
        if (result.unconfirmed > 0) {
          toast.warning(t('chat.cascade.tree.notStoppedToast', { count: result.unconfirmed }));
        }
        settle();
      },
      onError: fail,
    });
  };
  const resumeAll = (): void => {
    if (!parentChatId || resume.isPending) return;
    resume.mutate(parentChatId, {
      onSuccess: (result) => {
        toast.success(
          t('chat.cascade.tree.resumedToast', {
            resumed: result.resumed,
            flushed: result.flushed,
          }),
        );
        settle();
      },
      onError: fail,
    });
  };

  const isPaused = Boolean(tree.data?.paused);
  const stages = useMemo(() => {
    const rows = collectChildStages(chats ?? [], parentChatId, runs);
    return isPaused ? rows.map((group) => ({ ...group, isPaused: true })) : rows;
  }, [chats, parentChatId, runs, isPaused]);

  return {
    ...hub,
    ...asks,
    stages,
    ...(tree.data ? { tree: tree.data } : {}),
    pauseAll,
    resumeAll,
    treeBusy: pause.isPending || resume.isPending,
  };
}
