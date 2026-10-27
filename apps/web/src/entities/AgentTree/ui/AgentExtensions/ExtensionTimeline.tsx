import { useTranslation } from 'react-i18next';
import type { AgentExtensionOutcome, AgentExtensionUse } from '@agentdeck/contracts';
import { Badge, type BadgeTone } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { formatClock } from '@shared/lib/format-clock';
import { formatDuration } from '@shared/lib/format-duration';
import { EXTENSION_KINDS, groupByKind } from '../../model/extensions';
import type { ExtensionTimelineProps } from './AgentExtensions.types';
import styles from './AgentExtensions.module.scss';

const OUTCOME_TONE: Record<AgentExtensionOutcome, BadgeTone> = {
  ok: 'success',
  error: 'danger',
  denied: 'danger',
  context: 'info',
  running: 'warning',
};

/**
 * Хронология одного агента тремя группами — скиллы, MCP, хуки: время, имя,
 * итог и длительность каждого срабатывания. Отдельно от окна, чтобы
 * проверяться без него.
 */
export function ExtensionTimeline({ data, isLoading }: ExtensionTimelineProps) {
  const { t, i18n } = useTranslation();

  // Меньше секунды `formatDuration` округлил бы до «0с» — у хуков это обычное время.
  const took = (ms: number): string =>
    ms < 1000 ? t('agentTree.extensions.ms', { value: ms }) : formatDuration(ms, t);

  const row = (item: AgentExtensionUse, index: number) => (
    <li
      key={`${item.at ?? ''}-${index}`}
      className={styles.item}
      data-extension-item={item.kind}
      data-extension-outcome={item.outcome}
    >
      <span className={styles.itemHead}>
        {item.at && (
          <Typography variant="caption" color="subtle" as="span" className={styles.clock}>
            {formatClock(item.at, i18n.language)}
          </Typography>
        )}
        <Typography variant="body-sm" weight="medium" as="span" className={styles.itemName}>
          {item.name}
        </Typography>
        <Badge tone={OUTCOME_TONE[item.outcome]}>
          {t(`agentTree.extensions.outcome.${item.outcome}`)}
        </Badge>
        {item.durationMs !== undefined && (
          <Typography variant="caption" color="subtle" as="span" className={styles.clock}>
            {took(item.durationMs)}
          </Typography>
        )}
      </span>
      {item.detail && (
        <Typography variant="caption" color="subtle" as="span" className={styles.detail}>
          {item.detail}
        </Typography>
      )}
    </li>
  );

  if (!data) {
    return (
      <Typography
        variant="body-sm"
        color="subtle"
        data-extensions-state={isLoading ? 'loading' : 'missing'}
      >
        {isLoading ? t('agentTree.extensions.loading') : t('agentTree.extensions.missing')}
      </Typography>
    );
  }
  if (data.total === 0) {
    return (
      <Typography variant="body-sm" color="subtle" data-extensions-state="empty">
        {t('agentTree.extensions.none')}
      </Typography>
    );
  }
  const groups = groupByKind(data.items);
  return (
    <>
      {data.partial && (
        <Typography variant="caption" color="subtle" as="p" data-extensions-partial>
          {t('agentTree.extensions.partial')}
        </Typography>
      )}
      {data.total > data.items.length && (
        <Typography variant="caption" color="subtle" as="p" data-extensions-shown>
          {t('agentTree.extensions.shownOf', { shown: data.items.length, total: data.total })}
        </Typography>
      )}
      {EXTENSION_KINDS.map((kind) => (
        <section key={kind} className={styles.group} data-extension-group={kind}>
          <Typography variant="body-sm" weight="medium" as="h3" className={styles.groupTitle}>
            {t(`agentTree.extensions.kinds.${kind}`)} · {groups[kind].length}
          </Typography>
          {groups[kind].length > 0 ? (
            <ul className={styles.items}>{groups[kind].map(row)}</ul>
          ) : (
            <Typography variant="caption" color="subtle" as="p">
              {t('agentTree.extensions.noneKind')}
            </Typography>
          )}
        </section>
      ))}
    </>
  );
}
