import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import { formatDuration } from '@shared/lib/format-duration';
import { elapsedMs, shellView, type ShellView } from '../model/progressView';
import type { ShellRowProps } from './ChatProgressSheet.types';
import styles from './ChatProgressSheet.module.scss';

/** Идёт — жёлтая с пульсом, готово — зелёная, упала или оборвана — красная. */
const SHELL_TONE: Record<ShellView, 'danger' | 'success' | 'warning'> = {
  running: 'warning',
  done: 'success',
  failed: 'danger',
  stopped: 'danger',
  lost: 'danger',
};

export function ShellRow({ shell, isRunning, processAlive, now }: ShellRowProps) {
  const { t } = useTranslation();
  const view = shellView(shell, isRunning, processAlive);
  const elapsed = view === 'running' ? elapsedMs(shell.startedAt, now) : undefined;

  return (
    <li className={styles.agent}>
      <Stack direction="row" align="center" gap="var(--spacing-2xs)">
        <StatusDot tone={SHELL_TONE[view]} pulse={view === 'running'} />
        <code className={styles.shellCommand} title={shell.command}>
          {shell.command}
        </code>
        <Typography variant="caption" color="subtle" as="span" className={styles.shellStatus}>
          {t(`chat.progress.shellStatus.${view}`)}
          {elapsed !== undefined && ` · ${formatDuration(elapsed, t)}`}
        </Typography>
      </Stack>
    </li>
  );
}
