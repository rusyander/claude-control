import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskSplitReviewDecision } from '@agentdeck/contracts/task-split';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { useReviewDecision, useReviewPush } from '@entities/ChatTree';
import { collectReviews, reviewTreeOf, type ReviewDecisionItem } from '@features/ChatMessages';
import { toast } from '@shared/lib/toast';

/**
 * Карточки решения по ревью MR у чужого провайдера (Т6).
 *
 * Правило то же, что у Claude: родителю — все ревью дерева (иначе ради шести
 * одинаковых решений придётся обойти шесть разговоров), самой группе — только её
 * собственное. Состояние у обеих одно — узел дерева, то есть связь чата на
 * сервере, поэтому своей памяти здесь нет вовсе.
 */
export interface ForeignReviews {
  items: ReviewDecisionItem[];
  decide: (chatId: string, verdict: TaskSplitReviewDecision, all: boolean) => void;
  push: (chatId: string) => void;
  busy: boolean;
}

export function useForeignReviews(input: {
  tree?: ChatTreeView;
  /** Именованный ключ открытого разговора; пусто — дерево не спрашивали. */
  treeKey?: string;
  /** Открыт КОРЕНЬ дерева: тогда решения соседей тоже его. */
  isRoot: boolean;
  /** Обновить список и дерево после ответа сервера. */
  settle: () => void;
}): ForeignReviews {
  const { tree, treeKey, isRoot, settle } = input;
  const { t } = useTranslation();

  const own = isRoot ? tree : undefined;
  const parent = isRoot ? undefined : tree;
  const items = useMemo(
    () =>
      collectReviews({
        ...(own ? { own } : {}),
        ...(parent ? { parent } : {}),
        ...(treeKey ? { chatId: treeKey } : {}),
      }),
    [own, parent, treeKey],
  );

  const decision = useReviewDecision();
  const pushRun = useReviewPush();
  const treeOf = (chatId: string): string => reviewTreeOf(items, chatId, [tree?.root, treeKey]);
  const failed = (error: unknown): void => {
    toast.error(
      t('chat.review.failed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const decide = (chatId: string, verdict: TaskSplitReviewDecision, all: boolean): void => {
    if (decision.isPending) return;
    decision.mutate(
      {
        parentChatId: treeOf(chatId),
        chatId,
        decision: verdict,
        ...(all ? { all: true } : {}),
      },
      {
        onSuccess: (outcome) => {
          const posted = outcome.applied.filter((one) => one.posted).length;
          const failedPost = outcome.applied.find((one) => one.postError);
          toast.success(
            posted > 0
              ? t('chat.review.doneToast', { count: outcome.applied.length, posted })
              : t('chat.review.donePlain', { count: outcome.applied.length }),
          );
          // Отказ форджа отдельной репликой: правки пошли, а комментарий нет —
          // это половина исхода, и молчать о ней нельзя.
          if (failedPost?.postError) {
            toast.error(t('chat.review.postFailed', { message: failedPost.postError }));
          }
          settle();
        },
        onError: failed,
      },
    );
  };

  const push = (chatId: string): void => {
    if (pushRun.isPending) return;
    pushRun.mutate(
      { parentChatId: treeOf(chatId), chatId },
      {
        onSuccess: () => {
          toast.success(t('chat.review.pushToast'));
          settle();
        },
        onError: failed,
      },
    );
  };

  return { items, decide, push, busy: decision.isPending || pushRun.isPending };
}
