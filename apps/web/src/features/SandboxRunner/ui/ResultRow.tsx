import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { toneOf } from '../lib/decisionTone';
import type { ResultRowProps } from './ResultRow.types';
import styles from './SandboxModal.module.scss';

export function ResultRow({ result, title }: ResultRowProps) {
  const { t } = useTranslation();

  const className = {
    block: styles.resultBlock,
    ask: styles.resultAsk,
    pass: styles.resultPass,
    // Несостоявшийся прогон нельзя показывать как «пропустил»: иначе
    // незапустившийся страж выглядит как страж, который решил не вмешиваться.
    error: styles.resultError,
  }[result.decision];

  return (
    <div className={`${styles.result} ${className}`}>
      <Stack gap="var(--spacing-3xs)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-xs)" wrap>
          <Typography variant="body-sm" weight="medium" as="span">
            {title}
          </Typography>

          <Stack direction="row" align="center" gap="var(--spacing-3xs)">
            <Badge tone={toneOf(result.decision)}>{t(`sandbox.decision.${result.decision}`)}</Badge>
            <Typography variant="caption" color="subtle" as="span">
              {result.durationMs} мс
            </Typography>
          </Stack>
        </Stack>

        {result.reason && (
          <Typography variant="caption" color="muted">
            {result.reason}
          </Typography>
        )}

        {result.addedContext && <div className={styles.output}>{result.addedContext}</div>}

        {result.stderr && <div className={styles.output}>{result.stderr}</div>}

        {result.timedOut && (
          <Typography variant="caption" color="danger">
            {t('sandbox.timedOut')}
          </Typography>
        )}
      </Stack>
    </div>
  );
}
