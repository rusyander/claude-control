import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatSummary } from '@agentdeck/contracts';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import type { TaskSplitReviewDecision } from '@agentdeck/contracts/task-split';
import { agentRuns, type ActiveRunView } from '@shared/lib/agent-runs';
import { toast } from '@shared/lib/toast';
import { chatKeys } from '@entities/Chat';
import {
  chatTreeKeys,
  useAnswerHold,
  useChatTree,
  useCheckOverlap,
  usePauseTree,
  useResumeTree,
  useReviewDecision,
  useReviewPush,
} from '@entities/ChatTree';
import {
  collectReviews,
  reviewTreeOf,
  type ChildPermission,
  type ChildQuestion,
  type ChildStageGroup,
  type ReviewDecisionItem,
} from '@features/ChatMessages';
import { collectChildQuestions } from '../lib/childQuestions';
import { collectChildPermissions } from '../lib/childPermissions';
import { collectChildStages } from '../lib/childStages';

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
  /**
   * Группы разделения с их звеньями: на чём каждая стоит сейчас и чем ведётся.
   * Считается по веткам, а не по чатам — у одной группы разговоров до четырёх.
   * С конвейером уровней (Т1) сюда входят и группы, у которых чата ещё нет.
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
  /** Ответ на вопрос разбора группе с этим номером; пока идёт — `holdBusy`. */
  answerHold: (index: number, answer: string) => void;
  holdBusy: boolean;
  /**
   * Пересчитать пересечения веток (Т6). Панель считает их и сама — по концу
   * цепочки любой группы, — но человек вправе спросить, не дожидаясь ничьего
   * конца: агент мог насорить в чужом файле в середине работы.
   */
  checkOverlap: () => void;
  overlapBusy: boolean;
  /**
   * Ревью чужих MR по ссылке (Т7), которые панель довела до списка замечаний.
   *
   * В родительском разговоре это все группы дерева, в чате самой группы — она
   * одна: карточка одна и та же, а решать по ней человек может там, где ему
   * удобнее. Источник у обоих мест один — связь чата с сервера.
   */
  reviews: ReviewDecisionItem[];
  /** Решение по карточке; `all` — то же решение остальным ждущим группам дерева. */
  reviewDecide: (chatId: string, decision: TaskSplitReviewDecision, all: boolean) => void;
  /** «Закоммитить и отправить в MR» — отдельным кликом после правок. */
  reviewPush: (chatId: string) => void;
  reviewBusy: boolean;
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
  /**
   * Чей ребёнок сам открытый разговор (Т7). Нужен ровно для одного: карточка
   * решения по ревью показывается и В САМОЙ группе, а её состояние живёт в
   * дереве родителя — своего у ребёнка нет.
   */
  ownParentChatId?: string,
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

  // Дерево и его пауза — с сервера: он знает связи и он же глушит автостарты в
  // стоящем дереве. После нажатия прогоны стартуют и гаснут ВНЕ этой вкладки,
  // поэтому стор прогонов пересчитывается тем же путём, что после F5.
  const tree = useChatTree(parentChatId, hub.list.length > 0);
  const pause = usePauseTree();
  const resume = useResumeTree();
  const hold = useAnswerHold();
  const overlap = useCheckOverlap();
  const settle = (): void => {
    void agentRuns.resumeActive();
    void queryClient.invalidateQueries({ queryKey: chatKeys.list });
    void queryClient.invalidateQueries({ queryKey: chatTreeKeys.tree(parentChatId ?? '') });
  };
  const fail = (error: unknown): void => {
    toast.error(
      t('chat.cascade.tree.failed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const pauseAll = (): void => {
    if (!parentChatId || pause.isPending) return;
    pause.mutate(parentChatId, {
      onSuccess: (result) => {
        toast.success(t('chat.cascade.tree.pausedToast', { count: result.stopped }));
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

  // Ответ на вопрос разбора уходит РОДИТЕЛЮ с номером группы: чата у стоящей
  // группы ещё нет. Стартовала сразу или ждёт предшественников — говорит ответ.
  const answerHold = (index: number, answer: string): void => {
    if (!parentChatId || hold.isPending) return;
    hold.mutate(
      { parentChatId, index, answer },
      {
        onSuccess: (result) => {
          const started = result.chats.find((chat) => chat.started);
          toast.success(
            started
              ? t('chat.cascade.hub.holdStarted', { title: started.title })
              : t('chat.cascade.hub.holdQueued'),
          );
          for (const failure of result.failures) {
            toast.error(t('chat.split.failed', { title: failure.title, message: failure.message }));
          }
          settle();
        },
        onError: (error) =>
          toast.error(
            t('chat.cascade.hub.holdFailed', {
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
      },
    );
  };

  // Сверка веток: результат приезжает деревом, поэтому после ответа его и
  // перезапрашиваем. Тост нужен только на «пусто» — там показывать нечего, и
  // без него нажатие выглядело бы как ничего не сделавшее.
  const checkOverlap = (): void => {
    if (!parentChatId || overlap.isPending) return;
    overlap.mutate(parentChatId, {
      onSuccess: (view) => {
        if (view.files.length === 0) toast.success(t('chat.cascade.overlap.clean'));
        void queryClient.invalidateQueries({ queryKey: chatTreeKeys.tree(parentChatId) });
      },
      onError: (error) =>
        toast.error(
          t('chat.cascade.overlap.failed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
    });
  };

  // Дерево РОДИТЕЛЯ открытого разговора (Т7): в нём лежит состояние ревью самой
  // группы. Ключ тот же, что у пульта родителя, — открытые рядом вкладки берут
  // один ответ, а не два.
  const ownTree = useChatTree(ownParentChatId, Boolean(ownParentChatId));
  const reviews = useMemo(
    () =>
      collectReviews({
        ...(tree.data ? { own: tree.data } : {}),
        ...(ownTree.data ? { parent: ownTree.data } : {}),
        ...(parentChatId ? { chatId: parentChatId } : {}),
      }),
    [tree.data, ownTree.data, parentChatId],
  );

  const decision = useReviewDecision();
  const push = useReviewPush();
  const treeOf = (chatId: string): string =>
    reviewTreeOf(reviews, chatId, [ownParentChatId, parentChatId]);

  const reviewDecide = (chatId: string, verdict: TaskSplitReviewDecision, all: boolean): void => {
    if (decision.isPending) return;
    decision.mutate(
      { parentChatId: treeOf(chatId), chatId, decision: verdict, ...(all ? { all: true } : {}) },
      {
        onSuccess: (outcome) => {
          const posted = outcome.applied.filter((one) => one.posted).length;
          const failed = outcome.applied.find((one) => one.postError);
          // Про комментарии говорим, только когда они были: «в MR: 0» после
          // «починить» обещает действие, которого никто не просил.
          toast.success(
            posted > 0
              ? t('chat.review.doneToast', { count: outcome.applied.length, posted })
              : t('chat.review.donePlain', { count: outcome.applied.length }),
          );
          // Отказ форджа отдельной репликой: правки пошли, а комментарий нет —
          // это половина исхода, и молчать о ней нельзя.
          if (failed?.postError) {
            toast.error(t('chat.review.postFailed', { message: failed.postError }));
          }
          settle();
        },
        onError: (error) =>
          toast.error(
            t('chat.review.failed', {
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
      },
    );
  };

  const reviewPush = (chatId: string): void => {
    if (push.isPending) return;
    push.mutate(
      { parentChatId: treeOf(chatId), chatId },
      {
        onSuccess: () => {
          toast.success(t('chat.review.pushToast'));
          settle();
        },
        onError: (error) =>
          toast.error(
            t('chat.review.failed', {
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
      },
    );
  };

  // Сводка групп считается с видом конвейера: без него группы, у которых чата
  // ещё нет, в сводке отсутствовали бы вовсе.
  const isPaused = Boolean(tree.data?.paused);
  const split = tree.data?.split;
  const stages = useMemo(() => {
    const rows = collectChildStages(chats ?? [], parentChatId, runs, split);
    return isPaused ? rows.map((group) => ({ ...group, isPaused: true })) : rows;
  }, [chats, parentChatId, runs, split, isPaused]);

  return {
    ...hub,
    stages,
    ...(tree.data ? { tree: tree.data } : {}),
    pauseAll,
    resumeAll,
    treeBusy: pause.isPending || resume.isPending,
    answerHold,
    holdBusy: hold.isPending,
    checkOverlap,
    overlapBusy: overlap.isPending,
    reviews,
    reviewDecide,
    reviewPush,
    reviewBusy: decision.isPending || push.isPending,
  };
}
