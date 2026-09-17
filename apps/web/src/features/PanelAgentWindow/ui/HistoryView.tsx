import { useTranslation } from 'react-i18next';
import { usePanelAgentConversations } from '@entities/PanelAgent';
import { EmptyState } from '@shared/ui/empty-state';
import { Skeleton } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import type { HistoryViewProps } from './HistoryView.types';
import styles from './PanelAgent.module.scss';

/** Прошлые разговоры из файлов панели; клик продолжает выбранный тем же id. */
export function HistoryView({ onOpen }: HistoryViewProps) {
  const { t, i18n } = useTranslation();
  const { data, isLoading, isError } = usePanelAgentConversations(true);

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

  return (
    <ul className={[styles.list, styles.scroll].join(' ')} data-agent-history>
      {data.map((conversation) => (
        <li key={conversation.id}>
          <button
            type="button"
            className={styles.historyItem}
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
        </li>
      ))}
    </ul>
  );
}
