import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { useWorktreeBootstrapLog } from '@entities/ProjectGit';
import type { WorktreeBootstrapCardProps } from './WorktreeBootstrapCard.types';
import styles from './WorktreeBootstrapCard.module.scss';
import { RUNTIME_NAME, TONE } from './WorktreeBootstrapCard.constants';

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

      {/* Первая настоящая ошибка — на виду: хвост лога в два экрана предупреждений её прятал. */}
      {state.status === 'failed' && state.firstError && (
        <Typography variant="caption" color="subtle" as="div" data-bootstrap-first-error>
          {t('git.worktrees.bootstrapFirstError', { line: state.firstError })}
        </Typography>
      )}
      {/* Версии рантайма, которые просит проект, и на чём шла подготовка. */}
      {state.runtimes?.map((note) => (
        <Typography
          key={`${note.tool}:${note.where}`}
          variant="caption"
          color="subtle"
          as="div"
          title={note.detail}
          data-bootstrap-runtime={note.status}
        >
          {t(`git.worktrees.bootstrapRuntime.${note.status}`, {
            tool: RUNTIME_NAME[note.tool],
            where: note.where ? ` (${note.where})` : '',
            wanted: note.wanted,
            source: note.source,
            used: note.used ?? '?',
            found: note.found ?? '?',
          })}
        </Typography>
      ))}

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
