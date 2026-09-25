import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { chatTreeKeys, useAcceptGroup } from '@entities/ChatTree';
import { toErrorMessage } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import type { GroupAcceptanceProps } from './GroupAcceptance.types';
import styles from './ChildStages.module.scss';

/**
 * «Принять» доставленную группу и «Снять отметку» — в строке хаба (TK-accepted).
 *
 * Приёмку делает человек: панель по фактам доставки отметку не ставит, и
 * кнопка — единственный путь к «принято». Отметка живёт на сервере в записи
 * разделения, поэтому её видно из любой вкладки и после перезапуска. Запрос
 * ведёт сама кнопка — как уборка копии: хаб стоит в обеих лентах.
 */
export function GroupAcceptance({ acceptance }: GroupAcceptanceProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accept = useAcceptGroup();
  const accepted = Boolean(acceptance.acceptedAt);

  const toggle = (): void => {
    if (accept.isPending) return;
    accept.mutate(
      { parentChatId: acceptance.parentChatId, index: acceptance.index, accepted: !accepted },
      {
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: chatTreeKeys.all }),
        onError: (error) =>
          toast.error(t('chat.cascade.hub.accept.failed', { message: toErrorMessage(error) })),
      },
    );
  };

  return (
    <div className={styles.holdActions} data-accept-group={accepted ? 'accepted' : 'open'}>
      <Button
        size="sm"
        variant={accepted ? 'ghost' : 'secondary'}
        isLoading={accept.isPending}
        title={t(accepted ? 'chat.cascade.hub.accept.undoHint' : 'chat.cascade.hub.accept.hint')}
        onClick={toggle}
      >
        {t(accepted ? 'chat.cascade.hub.accept.undo' : 'chat.cascade.hub.accept.action')}
      </Button>
    </div>
  );
}
