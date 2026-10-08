import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import type { DiscoveryProgressProps } from './DiscoveryProgress.types';
import styles from './DiscoveryProgress.module.scss';
import { SourceRow } from './SourceRow/SourceRow';
import { splitDiscoveryLog } from '../model/splitDiscoveryLog';
import { formatDateTime } from '../../../shared/lib/formatDateTime';

/**
 * Журнал обнаружения по источникам: каждый проект и общие каталоги каждого
 * провайдера — своя строка с состоянием. Сначала то, что споткнулось или ещё
 * идёт, остальное — свёрнутым хвостом: при двадцати проектах ошибка в середине
 * списка из зелёных строк не находилась. «Без изменений» значит, что опись не
 * менялась и модель не звали: повторный прогон бесплатный.
 */
export function DiscoveryProgress({ view }: DiscoveryProgressProps) {
  const { t, i18n } = useTranslation();
  const [isRestOpen, setIsRestOpen] = useState(false);
  const restId = useId();
  const { attention, rest } = splitDiscoveryLog(view.sources);

  return (
    <Stack gap="var(--spacing-xs)" className={styles.box}>
      <Typography variant="caption" color="subtle">
        {view.lastRunAt
          ? t('groupSources.lastRun', { when: formatDateTime(view.lastRunAt, i18n.language) })
          : t('groupSources.neverRun')}
      </Typography>
      {view.sources.length > 0 && (
        <div aria-label={t('groupSources.progressLabel')} aria-live="polite" role="group">
          {attention.length > 0 && (
            <ul className={styles.list}>
              {attention.map((source) => (
                <SourceRow key={source.source} source={source} />
              ))}
            </ul>
          )}
          {/* «Ошибок нет» — только когда всё прочитано: источник, который ещё
              читается, тоже стоит среди требующих внимания. */}
          {attention.length === 0 && (
            <Typography variant="caption" color="muted" as="p" className={styles.allGood}>
              {t('groupsPage.discovery.allGood')}
            </Typography>
          )}
          {rest.length > 0 && (
            <>
              <button
                type="button"
                className={styles.toggle}
                aria-expanded={isRestOpen}
                aria-controls={restId}
                onClick={() => setIsRestOpen((open) => !open)}
              >
                <Icon name={isRestOpen ? 'chevronDown' : 'chevronRight'} size={16} />
                {isRestOpen
                  ? t('groupsPage.discovery.hideRest')
                  : t('groupsPage.discovery.showRest', { count: rest.length })}
              </button>
              <ul id={restId} className={styles.list} hidden={!isRestOpen}>
                {rest.map((source) => (
                  <SourceRow key={source.source} source={source} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Stack>
  );
}
