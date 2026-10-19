import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { chatTreeKeys, useAcceptGroup } from '@entities/ChatTree';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import type { GroupAcceptanceProps } from '../GroupAcceptance.types';
import styles from './GroupAcceptance.module.scss';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

/** Четыре состояния кнопки: принята, отмечена вручную, можно отметить, можно принять. */
type AcceptMode = 'accepted' | 'marked' | 'markable' | 'open';

function acceptMode(accepted: boolean, marked: boolean, markable: boolean): AcceptMode {
  if (accepted) return marked ? 'marked' : 'accepted';
  return markable ? 'markable' : 'open';
}

const ACCEPT_HINT: Record<AcceptMode, string> = {
  accepted: 'chat.cascade.hub.accept.undoHint',
  marked: 'chat.cascade.hub.accept.markedUndoHint',
  markable: 'chat.cascade.hub.accept.markDoneHint',
  open: 'chat.cascade.hub.accept.hint',
};

const ACCEPT_LABEL: Record<AcceptMode, string> = {
  accepted: 'chat.cascade.hub.accept.undo',
  marked: 'chat.cascade.hub.accept.undo',
  markable: 'chat.cascade.hub.accept.markDone',
  open: 'chat.cascade.hub.accept.action',
};

/** Метка для проверок: открытая — `open`, отмеченная вручную — `marked`. */
const ACCEPT_STATE: Record<AcceptMode, string> = {
  accepted: 'accepted',
  marked: 'marked',
  markable: 'open',
  open: 'open',
};

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

  const marked = Boolean(acceptance.markedDoneAt);
  const mode = acceptMode(accepted, marked, Boolean(acceptance.markable));

  return (
    <div className={styles.holdActions} data-accept-group={ACCEPT_STATE[mode]}>
      <Button
        size="sm"
        variant={accepted ? 'ghost' : 'secondary'}
        isLoading={accept.isPending}
        title={t(ACCEPT_HINT[mode])}
        onClick={toggle}
      >
        {t(ACCEPT_LABEL[mode])}
      </Button>
    </div>
  );
}
