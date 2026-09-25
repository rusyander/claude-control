import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { splitPlanRunning } from '@agentdeck/contracts/chat-handoff';
import { chatTreeKeys, useCancelSplitPlan } from '@entities/ChatTree';
import { toErrorMessage } from '@shared/api/client';
import { agentRuns } from '@shared/lib/agent-runs';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import type { PlanCancelProps } from './PlanCancel.types';
import styles from './PlanCancel.module.scss';

/**
 * «Отменить план» разделения в шапке хаба (W3-5, владелец 25.09.2026).
 *
 * Без неё идущий план держал «Разделить» запертой до конца последней группы, и
 * передумавшему человеку оставалось гасить группы по одной. Подтверждение — в
 * той же строке, а не окном: действие не удаляет ни чатов, ни веток, но гасит
 * сразу все прогоны, и случайный клик стоил бы работы всех групп.
 *
 * Кнопка есть, только пока план идёт и не отменён: закрытый план отменять
 * нечего. На неё же ведёт предложение из отказа 409 «разделение уже идёт»
 * (`data-plan-cancel`).
 */
export function PlanCancel({ split }: PlanCancelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const cancel = useCancelSplitPlan();
  const [asking, setAsking] = useState(false);

  if (split.cancelledAt || !splitPlanRunning(split.groups)) return null;

  const confirm = (): void => {
    if (cancel.isPending) return;
    cancel.mutate(
      { parentChatId: split.parentChatId },
      {
        onSuccess: (result) => {
          setAsking(false);
          // Дописанное в очередь групп не уйдёт в закрытый план новым ходом.
          agentRuns.haltQueued(result.chatIds);
          toast.success(
            t('chat.cascade.hub.cancelPlan.done', {
              cancelled: result.cancelled,
              stopped: result.stopped,
            }),
          );
          void queryClient.invalidateQueries({ queryKey: chatTreeKeys.all });
        },
        onError: (error) =>
          toast.error(t('chat.cascade.hub.cancelPlan.failed', { message: toErrorMessage(error) })),
      },
    );
  };

  if (!asking) {
    return (
      <Button
        size="sm"
        variant="ghost"
        title={t('chat.cascade.hub.cancelPlan.hint')}
        data-plan-cancel
        onClick={() => setAsking(true)}
      >
        {t('chat.cascade.hub.cancelPlan.action')}
      </Button>
    );
  }

  return (
    <span className={styles.confirm} data-plan-cancel-confirm>
      <Typography variant="caption" as="span">
        {t('chat.cascade.hub.cancelPlan.confirm')}
      </Typography>
      <Button size="sm" variant="danger" isLoading={cancel.isPending} onClick={confirm}>
        {t('chat.cascade.hub.cancelPlan.yes')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={cancel.isPending}
        onClick={() => setAsking(false)}
      >
        {t('chat.cascade.hub.cancelPlan.no')}
      </Button>
    </span>
  );
}
