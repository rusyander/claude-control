import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { useWorktreeBootstrapLog } from '@entities/ProjectGit';
import type { WorktreeBootstrapCardProps } from './WorktreeBootstrapCard.types';
import styles from './WorktreeBootstrapCard.module.scss';

/**
 * Бутстрап копии на её карточке: значок состояния, команда, лог и повтор.
 *
 * Значок читается без раскрытия — «ставится», «зависимости есть», «установка не
 * удалась»; лог раскрывается по кнопке, потому что установка пишет сотни строк,
 * а поповер git узкий. Хвост приходит вместе со списком копий, полный лог —
 * отдельным запросом и только когда его попросили.
 */
const TONE = { running: 'info', ok: 'success', failed: 'danger' } as const;

export function WorktreeBootstrapCard({
  path,
  worktree,
  disabled,
  onRerun,
}: WorktreeBootstrapCardProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const state = worktree.bootstrap;
  const log = useWorktreeBootstrapLog(path, worktree.path, open && full);

  if (!state) return null;
  const running = state.status === 'running';
  const text = full && log.data ? log.data.log : state.logTail;

  return (
    <Stack
      gap="var(--spacing-3xs)"
      className={styles.card}
      aria-label={t('git.worktrees.bootstrapTitle')}
    >
      <Stack direction="row" align="center" gap="var(--spacing-3xs)" wrap>
        <Badge tone={TONE[state.status]}>{t(`git.worktrees.bootstrap.${state.status}`)}</Badge>
        {state.status === 'failed' && (
          <Typography variant="caption" color="subtle" as="span">
            {state.timedOut
              ? t('git.worktrees.bootstrapTimedOut')
              : t('git.worktrees.bootstrapExit', { code: state.exitCode ?? '?' })}
          </Typography>
        )}
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? t('git.worktrees.bootstrapHideLog') : t('git.worktrees.bootstrapLog')}
        </Button>
        {!running && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onRerun}>
            {t('git.worktrees.bootstrapRerun')}
          </Button>
        )}
      </Stack>

      {open && (
        <div className={styles.log}>
          <div className={styles.command}>$ {state.command}</div>
          {state.reverted && state.reverted.length > 0 && (
            <Typography variant="caption" color="subtle" as="div">
              {t('git.worktrees.bootstrapReverted', { files: state.reverted.join(', ') })}
            </Typography>
          )}
          <pre className={styles.pre}>{text || t('git.worktrees.bootstrapEmptyLog')}</pre>
          {!full && (
            <Button variant="ghost" size="sm" onClick={() => setFull(true)}>
              {t('git.worktrees.bootstrapFullLog')}
            </Button>
          )}
        </div>
      )}
    </Stack>
  );
}
