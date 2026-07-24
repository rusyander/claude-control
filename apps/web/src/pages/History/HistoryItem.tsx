import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { formatDateTime } from '@shared/lib/format';
import type { HistoryItemProps } from './HistoryItem.types';
import { DiffView } from './DiffView';
import styles from './HistoryPage.module.scss';

/**
 * Запись ленты изменений: файл, время, против чего дифф и сводка ±строк. Клик по
 * шапке раскрывает полный дифф, который подгружается лениво.
 *
 * У файла активного провайдера рядом с именем стоит бейдж с его названием: копия
 * такого файла лежит под именем `<id>-<basename>`, и без пометки правку
 * `AGENTS.md` было бы не отличить от чужой.
 */
export function HistoryItem({ entry }: HistoryItemProps) {
  const { t, i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const hasChanges = entry.added > 0 || entry.removed > 0;

  return (
    <Card padding="none">
      <button
        type="button"
        className={styles.itemHeader}
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
      >
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap minWidth={0}>
            <Icon name={isOpen ? 'chevronLeft' : 'chevronRight'} size={24} />
            <Badge tone="neutral">{entry.file}</Badge>
            {entry.providerName && (
              <Badge tone="info">
                {t('history.providerFile', { provider: entry.providerName })}
              </Badge>
            )}
            <Typography variant="body-sm" color="muted" as="span">
              {formatDateTime(entry.at, i18n.language)}
            </Typography>
            <Typography variant="caption" color="subtle" as="span">
              {t(`history.base_${entry.label}`)}
            </Typography>
          </Stack>

          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            {hasChanges ? (
              <>
                {entry.added > 0 && (
                  <Typography variant="mono" color="success" as="span">
                    +{entry.added}
                  </Typography>
                )}
                {entry.removed > 0 && (
                  <Typography variant="mono" color="danger" as="span">
                    -{entry.removed}
                  </Typography>
                )}
              </>
            ) : (
              <Typography variant="caption" color="subtle" as="span">
                {t('history.noChanges')}
              </Typography>
            )}
          </Stack>
        </Stack>
      </button>

      {isOpen && (
        <div className={styles.itemBody}>
          <DiffView name={entry.name} />
        </div>
      )}
    </Card>
  );
}
