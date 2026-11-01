import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { decisionKeys } from '../../model/items';
import type { DecisionRowProps } from './DecisionRow.types';
import styles from './DecisionRow.module.scss';

/**
 * Решение ядра строкой (F1): подпись класса и заголовок исхода — из типизированного шаблона языка
 * интерфейса, причины ядра — дословно под «детали» (P32: ядро пишет их английской прозой, перевод
 * исказил бы основание, по которому оно решило). Класс без шаблона назван прямо.
 */
export function DecisionRow({ cls, outcome, reasons }: DecisionRowProps) {
  const { t } = useTranslation();
  const keys = decisionKeys(cls, outcome);
  return (
    <Stack gap="var(--spacing-3xs)" data-decision-class={cls} data-decision-outcome={outcome ?? ''}>
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        {keys && <Badge tone="neutral">{t(keys.label)}</Badge>}
        <Typography variant="body-sm" as="span" data-decision-headline>
          {keys ? t(keys.headline) : t('coreTimeline.timeline.noTemplate', { cls })}
        </Typography>
      </Stack>
      {reasons.length > 0 && (
        <details className={styles.details}>
          <summary>
            <Typography variant="caption" color="muted" as="span">
              {t('coreTimeline.timeline.details')}
            </Typography>
          </summary>
          <ul className={styles.reasons} data-decision-reasons>
            {reasons.map((reason, i) => (
              <li key={i}>
                <Typography variant="caption" as="span" lang="en">
                  {reason}
                </Typography>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Stack>
  );
}
