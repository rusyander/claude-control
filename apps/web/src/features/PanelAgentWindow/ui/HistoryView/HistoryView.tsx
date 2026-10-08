import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDeletePanelAgentConversation, usePanelAgentConversations } from '@entities/PanelAgent';
import { Button } from '@shared/ui/button';
import { EmptyState } from '@shared/ui/empty-state';
import { Icon } from '@shared/ui/icon';
import { Skeleton } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import type { HistoryViewProps } from './HistoryView.types';
import styles from './HistoryView.module.scss';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

/**
 * Прошлые разговоры из файлов панели; клик продолжает выбранный тем же id.
 * Удаление спрашивает прямо в строке: окно не модальное, и диалог поверх
 * страницы закрыл бы то, ради чего окно не модальное.
 */
export function HistoryView({ onOpen, isBusy, currentId, onDeleted }: HistoryViewProps) {
  const { t, i18n } = useTranslation();
  const { data, isLoading, isError } = usePanelAgentConversations(true);
  const remove = useDeletePanelAgentConversation();
  const [confirming, setConfirming] = useState<string>();
  const [failed, setFailed] = useState<{ id: string; message: string }>();

  if (isLoading) return <Skeleton height={120} />;
  if (isError) {
    return (
      <Typography variant="body-sm" color="danger" role="alert">
        {t('panelAgent.history.loadFailed')}
      </Typography>
    );
  }
  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon="history"
        title={t('panelAgent.history.empty')}
        text={t('panelAgent.history.emptyText')}
      />
    );
  }

  const confirmDelete = (id: string): void => {
    setFailed(undefined);
    remove.mutate(id, {
      onSuccess: () => {
        setConfirming(undefined);
        onDeleted(id);
      },
      onError: (error) => setFailed({ id, message: toErrorMessage(error) }),
    });
  };

  // Удалить открытый разговор во время хода нельзя — сервер ответит 409, а
  // кнопка честнее, чем отказ после клика.
  const isLocked = (id: string): boolean => isBusy && id === currentId;

  return (
    <>
      {isBusy && (
        <Typography variant="body-sm" color="muted" role="status" data-agent-history-busy>
          {t('panelAgent.history.busy')}
        </Typography>
      )}
      <ul className={[styles.list, styles.scroll].join(' ')} data-agent-history>
        {data.map((conversation) => (
          <li key={conversation.id} className={styles.historyEntry}>
            <div className={styles.historyRow}>
              <button
                type="button"
                className={styles.historyItem}
                disabled={isBusy}
                onClick={() => onOpen(conversation.id)}
              >
                <Typography variant="body-sm" weight="medium" truncate>
                  {conversation.title}
                </Typography>
                <Typography variant="caption" color="muted">
                  {new Date(conversation.updatedAt).toLocaleString(i18n.language)} ·{' '}
                  {t('panelAgent.history.messages', { count: conversation.messages })}
                </Typography>
              </button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<Icon name="trash" size={16} />}
                aria-label={t('panelAgent.history.delete', { title: conversation.title })}
                aria-expanded={confirming === conversation.id}
                disabled={isLocked(conversation.id)}
                data-agent-history-delete={conversation.id}
                onClick={() => {
                  setFailed(undefined);
                  setConfirming((id) => (id === conversation.id ? undefined : conversation.id));
                }}
              />
            </div>
            {confirming === conversation.id && (
              <div className={styles.historyConfirm} data-agent-history-confirm>
                <Typography variant="body-sm">{t('panelAgent.history.deleteConfirm')}</Typography>
                <div className={styles.historyConfirmActions}>
                  <Button
                    variant="danger"
                    size="sm"
                    isLoading={remove.isPending}
                    disabled={isLocked(conversation.id)}
                    onClick={() => confirmDelete(conversation.id)}
                  >
                    {t('panelAgent.history.deleteYes')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(undefined)}>
                    {t('panelAgent.history.deleteNo')}
                  </Button>
                </div>
                {failed?.id === conversation.id && (
                  <Typography variant="body-sm" color="danger" role="alert">
                    {t('panelAgent.history.deleteFailed', { message: failed.message })}
                  </Typography>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
