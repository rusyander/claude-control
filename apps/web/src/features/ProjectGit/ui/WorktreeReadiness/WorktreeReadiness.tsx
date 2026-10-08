import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import type { WorktreeReadinessProps } from './WorktreeReadiness.types';
import styles from './WorktreeReadiness.module.scss';
import { GAP_KEY, ACCESS_KEY } from './WorktreeReadiness.constants';

export function WorktreeReadiness({ state, disabled, onRepair }: WorktreeReadinessProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="2px" className={styles.card} aria-label={t('git.worktrees.copyStateTitle')}>
      <Stack direction="row" align="center" gap="var(--spacing-3xs)" wrap>
        <Badge tone={state.ready ? 'success' : 'danger'}>
          {t(state.ready ? 'git.worktrees.copyReady' : 'git.worktrees.copyNotReady')}
        </Badge>
        <Typography
          variant="caption"
          color={state.access === 'missing' ? 'warning' : 'subtle'}
          as="span"
        >
          {t(ACCESS_KEY[state.access])}
        </Typography>
      </Stack>

      {state.ready ? (
        <Typography variant="caption" color="subtle">
          {t('git.worktrees.copyReadyHint')}
        </Typography>
      ) : (
        <>
          <ul className={styles.gaps}>
            {state.gaps.map((gap) => (
              <li key={`${gap.kind}:${gap.path}`}>{t(GAP_KEY[gap.kind], { path: gap.path })}</li>
            ))}
          </ul>
          <Typography variant="caption" color="subtle">
            {t('git.worktrees.copyNotReadyHint')}
          </Typography>
          <Stack direction="row">
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              leftIcon={<Icon name="refresh" size={16} />}
              onClick={onRepair}
            >
              {t('git.worktrees.copyRepair')}
            </Button>
          </Stack>
        </>
      )}
    </Stack>
  );
}
