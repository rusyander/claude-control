import { useTranslation } from 'react-i18next';
import type { PanelActionOutcome, PanelActionRisk } from '@agentdeck/contracts/panel-agent';
import { usePanelAgentJournal } from '@entities/PanelAgent';
import { Badge, type BadgeTone } from '@shared/ui/badge';
import { EmptyState } from '@shared/ui/empty-state';
import { Skeleton } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { actionTitle } from '../model/actionTitle';
import { journalSummary } from '../model/panelText';
import styles from './PanelAgent.module.scss';

const OUTCOME_TONE: Partial<Record<PanelActionOutcome, BadgeTone>> = {
  done: 'success',
  failed: 'danger',
};

const RISK_TONE: Record<PanelActionRisk, BadgeTone> = {
  read: 'neutral',
  change: 'warning',
  danger: 'danger',
};

/**
 * След действий: каждое действие агента — что, с каким итогом и кто решил.
 * Без него действие агента было бы неотличимо от действия человека. Вход
 * действия сюда не приходит вовсе: сервер пишет только сводку.
 */
export function JournalView() {
  const { t, i18n } = useTranslation();
  const { data, isLoading, isError } = usePanelAgentJournal(true);

  if (isLoading) return <Skeleton height={120} />;
  if (isError) {
    return (
      <Typography variant="body-sm" color="danger" role="alert">
        {t('panelAgent.journal.loadFailed')}
      </Typography>
    );
  }
  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon="history"
        title={t('panelAgent.journal.empty')}
        text={t('panelAgent.journal.emptyText')}
      />
    );
  }

  return (
    <ul
      className={[styles.list, styles.scroll].join(' ')}
      aria-label={t('panelAgent.journal.caption')}
      data-agent-journal
    >
      {data.map((entry, index) => (
        <li key={`${entry.at}-${index}`} className={styles.journalRow}>
          <Typography variant="caption" color="muted" as="span">
            {new Date(entry.at).toLocaleString(i18n.language)}
          </Typography>
          <Typography variant="body-sm" weight="semibold" as="span" title={entry.name}>
            {actionTitle(entry.name, t, (key) => i18n.exists(key))}
          </Typography>
          <Badge tone={RISK_TONE[entry.risk]}>{t(`panelAgent.risk.${entry.risk}`)}</Badge>
          <Badge tone={OUTCOME_TONE[entry.outcome] ?? 'neutral'}>
            {t(`panelAgent.outcome.${entry.outcome}`)}
          </Badge>
          <Typography variant="caption" color="subtle" as="span">
            {t(`panelAgent.decidedBy.${entry.decidedBy}`)}
          </Typography>
          <Typography variant="body-sm" as="span">
            {journalSummary(t, entry)}
          </Typography>
          {/* Код причины сервер пишет в след вместе с исходом: без него «ошибка
              маршрута» у одобренного действия читалась бы как поломка панели. */}
          {entry.messageCode && i18n.exists(`panelAgent.messageCode.${entry.messageCode}`) && (
            <Typography
              variant="caption"
              color="danger"
              as="span"
              data-agent-message-code={entry.messageCode}
            >
              {t(`panelAgent.messageCode.${entry.messageCode}`)}
            </Typography>
          )}
        </li>
      ))}
    </ul>
  );
}
