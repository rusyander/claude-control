import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { stepTone } from '@entities/ProviderCheck';
import type { CheckStepRowProps } from './CheckStepRow.types';
import styles from './ProviderCheckCard.module.scss';

/** Одна строка чек-листа: что проверяли, чем кончилось и почему. */
export function CheckStepRow({ step }: CheckStepRowProps) {
  const { t } = useTranslation();

  return (
    <Stack direction="row" align="start" gap="var(--spacing-xs)" className={styles.row} wrap>
      <Badge tone={stepTone(step.status)}>{t(`providerCheck.status.${step.status}`)}</Badge>
      <Stack gap="var(--spacing-3xs)" className={styles.text}>
        <Typography variant="body-sm" as="span">
          {t(`providerCheck.step.${step.id}`)}
        </Typography>
        <Typography variant="caption" color="subtle" as="span">
          {step.detail}
        </Typography>
        {step.filePath && <span className={styles.path}>{step.filePath}</span>}
      </Stack>
    </Stack>
  );
}
