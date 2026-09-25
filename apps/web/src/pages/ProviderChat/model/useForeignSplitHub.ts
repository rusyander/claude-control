import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { TaskSplitProposal } from '@agentdeck/contracts/task-split';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { toErrorMessage } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import { providerChatKeys } from '@entities/ProviderChat';
import { useSplitTasks } from '@entities/ChatSplit';
import {
  chatTreeKeys,
  offerPlanCancel,
  splitLocked,
  useAnswerHold,
  useChatTree,
  useCheckOverlap,
  usePauseTree,
  useResumeTree,
} from '@entities/ChatTree';
import { useResumeInterruptedGroups } from '@features/ChatMessages';
import type { ProviderChatMessagesProps } from '../ProviderChatMessages.types';
import { collectForeignStages } from '../lib/foreignStages';
import { useForeignRelease } from './useForeignRelease';
import { useForeignReviews } from './useForeignReviews';

/** Что хаб разделения отдаёт ленте чужого чата — ровно её пропсы. */
export type ForeignSplitHubProps = Pick<
  ProviderChatMessagesProps,
  | 'isSplitPending'
  | 'stages'
  | 'tree'
  | 'onPauseAll'
  | 'onResumeAll'
  | 'treeBusy'
  | 'onAnswerHold'
  | 'holdBusy'
  | 'onRelease'
  | 'releaseBusy'
  | 'onResumeInterrupted'
  | 'resumeInterruptedBusy'
  | 'onCheckOverlap'
  | 'overlapBusy'
  | 'reviews'
  | 'onReviewDecide'
  | 'onReviewPush'
  | 'onReviewRetry'
  | 'reviewBusy'
>;

export interface ForeignSplitHub {
  /** «Разделить» — тот же серверный маршрут, что и у Claude. */
  splitTasks: (proposal: TaskSplitProposal, options: { startRuns: boolean }) => void;
  /** Пропсы хаба для ленты: дерево, стадии групп и все его кнопки. */
  hub: ForeignSplitHubProps;
}

/**
 * Разделение и хаб групп в чате чужого провайдера (W3-5, вынесено из страницы
 * без смены поведения: страница упёрлась в предел длины). Страница собирает
 * ленту, а переписку с сервером про дерево ведёт этот хук.
 */
export function useForeignSplitHub(input: {
  providerId?: string;
  activeChatId?: string;
  workdir?: string;
}): ForeignSplitHub {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { activeChatId } = input;

  /**
   * Разделение задач по чатам. Копии репозитория и сами разговоры заводит тот же
   * серверный маршрут, что и у Claude, — вид чата решает активный провайдер, а
   * не клиент. Здесь остаётся освежить список: новые разговоры уже созданы.
   */
  const split = useSplitTasks();
  const splitTasks = (proposal: TaskSplitProposal, options: { startRuns: boolean }): void => {
    const projectPath = input.workdir;
    if (!projectPath) return;
    split.mutate(
      {
        projectPath,
        proposal,
        startRuns: options.startRuns,
        allowEdits: true,
        // Родитель обязателен: без него связей не будет, а с ними — ни дерева,
        // ни хаба, ни стадий. Ключ панель именует сама (`codex:c1a2…`).
        ...(activeChatId ? { parentChatId: activeChatId } : {}),
      },
      {
        onSuccess: (result) => {
          void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });
          if (result.chats.length > 0) {
            toast.success(t('chat.split.done', { count: result.chats.length }));
          }
          for (const failure of result.failures) {
            toast.error(t('chat.split.failed', { title: failure.title, message: failure.message }));
          }
        },
        onError: (error) => {
          // План этого чата ещё идёт — не тупик, а предложение его отменить.
          if (offerPlanCancel(error, t)) return;
          toast.error(t('chat.split.failedAll', { message: error.message }));
        },
      },
    );
  };

  /**
   * Дерево этого разговора: дети разделения, их звенья и состояние. Ключ
   * именованный — связь чужого чата не находится по «голому» идентификатору.
   *
   * Спрашивается у любого открытого разговора, а не только у известного
   * родителя: узнать про детей заранее неоткуда — своих связей список чужих
   * разговоров не несёт, — а ответ пустому дереву стоит одного чтения состояния
   * и ничего не рисует.
   */
  const treeKey =
    input.providerId && activeChatId ? foreignChatKey(input.providerId, activeChatId) : undefined;
  const tree = useChatTree(treeKey, Boolean(treeKey));
  /**
   * Хаб — только у КОРНЯ дерева. Дерево поднимается от любого ключа ВВЕРХ, до
   * разговора без связи, поэтому у ребёнка приезжает дерево его родителя — то
   * же самое, что у родителя. Без этой проверки лента группы показывала бы
   * пульт всего разделения, включая соседей, которых человек здесь не решает.
   */
  const isRoot = Boolean(treeKey) && tree.data?.root === treeKey;
  const stages = isRoot ? collectForeignStages(tree.data) : [];

  /**
   * «Остановить всё» и «Продолжить всё» (Т5). Дерево одно на любого провайдера,
   * и кнопки те же — гасят идущие прогоны групп и держат очередь автостартов на
   * сервере. Продолжение у чужого CLI не «с того же места»: сессии нет, поэтому
   * задание уходит заново, и на карточке это сказано словами.
   */
  const pause = usePauseTree();
  const resume = useResumeTree();
  const settleTree = (): void => {
    void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });
    void queryClient.invalidateQueries({ queryKey: chatTreeKeys.tree(treeKey ?? '') });
  };
  const treeFailed = (error: unknown): void => {
    toast.error(t('chat.cascade.tree.failed', { message: toErrorMessage(error) }));
  };
  // «Отпустить» ждущую группу (Т3) — своим модулем рядом с карточками ревью.
  const release = useForeignRelease({
    ...(treeKey ? { treeKey } : {}),
    settle: settleTree,
  });
  // «Продолжить» оборванные группы (WP1c) — тот же хук, что у Claude.
  const interrupted = useResumeInterruptedGroups({ parentChatId: treeKey, settle: settleTree });
  // Ревью MR по ссылке (Т6): правило «родителю все, группе своё» одно на оба чата.
  const reviews = useForeignReviews({
    ...(tree.data ? { tree: tree.data } : {}),
    ...(treeKey ? { treeKey } : {}),
    isRoot,
    settle: settleTree,
  });

  const pauseAll = (): void => {
    if (!treeKey || pause.isPending) return;
    pause.mutate(treeKey, {
      onSuccess: (result) => {
        toast.success(t('chat.cascade.tree.pausedToast', { count: result.stopped }));
        settleTree();
      },
      onError: treeFailed,
    });
  };
  /**
   * Ответ человека на вопрос разбора (Т3). Адресуется РОДИТЕЛЮ именованным
   * ключом и номером группы: у стоящей группы чата ещё нет — копия заводится
   * после ответа, и ответ уезжает в её план и в работу заметкой.
   */
  const hold = useAnswerHold();
  const answerHold = (index: number, answer: string): void => {
    if (!treeKey || hold.isPending) return;
    hold.mutate(
      { parentChatId: treeKey, index, answer },
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
          settleTree();
        },
        onError: (error) =>
          toast.error(t('chat.cascade.hub.holdFailed', { message: toErrorMessage(error) })),
      },
    );
  };

  /**
   * Сверка веток групп (Т4). Считает её сервер запросами к git по концу цепочки
   * каждой группы, а кнопка — способ пересчитать раньше: работа могла лечь, а
   * человек уже смотрит. Ответ приезжает и сам, деревом, поэтому здесь нужен
   * только исход нажатия: пусто — сказать об этом, иначе кнопка выглядит
   * ничего не сделавшей.
   */
  const overlap = useCheckOverlap();
  const checkOverlap = (): void => {
    if (!treeKey || overlap.isPending) return;
    overlap.mutate(treeKey, {
      onSuccess: (view) => {
        if (view.files.length === 0) toast.success(t('chat.cascade.overlap.clean'));
        void queryClient.invalidateQueries({ queryKey: chatTreeKeys.tree(treeKey) });
      },
      onError: (error) =>
        toast.error(t('chat.cascade.overlap.failed', { message: toErrorMessage(error) })),
    });
  };

  const resumeAll = (): void => {
    if (!treeKey || resume.isPending) return;
    resume.mutate(treeKey, {
      onSuccess: (result) => {
        toast.success(
          t('chat.cascade.tree.resumedToastForeign', {
            resumed: result.resumed,
            flushed: result.flushed,
          }),
        );
        settleTree();
      },
      onError: treeFailed,
    });
  };

  return {
    splitTasks,
    hub: {
      // Идущее разделение держит кнопку так же, как идущий запрос (находка 12).
      isSplitPending: splitLocked(split.isPending, tree.data, treeKey),
      stages,
      ...(tree.data ? { tree: tree.data } : {}),
      onPauseAll: pauseAll,
      onResumeAll: resumeAll,
      treeBusy: pause.isPending || resume.isPending,
      onAnswerHold: answerHold,
      holdBusy: hold.isPending,
      onRelease: release.release,
      releaseBusy: release.busy,
      onResumeInterrupted: interrupted.resume,
      resumeInterruptedBusy: interrupted.busy,
      onCheckOverlap: checkOverlap,
      overlapBusy: overlap.isPending,
      reviews: reviews.items,
      onReviewDecide: reviews.decide,
      onReviewPush: reviews.push,
      onReviewRetry: reviews.retry,
      reviewBusy: reviews.busy,
    },
  };
}
