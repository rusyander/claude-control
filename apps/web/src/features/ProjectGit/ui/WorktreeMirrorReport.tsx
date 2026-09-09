import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import type { WorktreeMirrorReportProps } from './WorktreeMirrorReport.types';
import styles from './WorktreeMirrorReport.module.scss';

/**
 * Отчёт одного зеркала локального слоя в копию: что перенесено, что пропущено
 * и почему, что из игнорируемого осталось за бортом. Последний список — самое
 * полезное здесь: по нему человек дописывает шаблоны в «Что переносить», а
 * без него копия молча жила бы без `.venv/` и не объясняла, отчего агент в ней
 * ничего не может запустить.
 */
export function WorktreeMirrorReport({ report, onClose }: WorktreeMirrorReportProps) {
  const { t } = useTranslation();
  const empty =
    report.mirrored.length === 0 &&
    report.skipped.length === 0 &&
    report.unlisted.length === 0 &&
    report.kept === 0;

  return (
    <Stack
      gap="var(--spacing-3xs)"
      className={styles.report}
      aria-label={t('git.worktrees.mirrorTitle')}
    >
      <Stack direction="row" align="center" justify="between">
        <Typography variant="caption" weight="medium" as="span">
          {t('git.worktrees.mirrorTitle')}
        </Typography>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('git.worktrees.mirrorHide')}
        </Button>
      </Stack>

      {empty && (
        <Typography variant="caption" color="subtle">
          {t('git.worktrees.mirrorNothing')}
        </Typography>
      )}

      {report.mirrored.length > 0 && (
        <div>
          <Typography variant="caption" color="success" as="span">
            {t('git.worktrees.mirrorMirrored', { count: report.mirrored.length })}
          </Typography>
          <ul className={styles.paths}>
            {report.mirrored.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}

      {report.kept > 0 && (
        <Typography variant="caption" color="subtle">
          {t('git.worktrees.mirrorKept', { count: report.kept })}
        </Typography>
      )}

      {report.skipped.length > 0 && (
        <div>
          <Typography variant="caption" color="warning" as="span">
            {t('git.worktrees.mirrorSkipped', { count: report.skipped.length })}
          </Typography>
          <ul className={styles.paths}>
            {report.skipped.map((item) => (
              <li key={item.path}>
                {item.path} <span className={styles.reason}>— {item.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.unlisted.length > 0 && (
        <div>
          <Typography variant="caption" color="muted" as="span">
            {t('git.worktrees.mirrorUnlisted')}
          </Typography>
          <ul className={styles.paths}>
            {report.unlisted.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <Typography variant="caption" color="subtle">
            {t('git.worktrees.mirrorUnlistedHint')}
          </Typography>
        </div>
      )}
    </Stack>
  );
}
