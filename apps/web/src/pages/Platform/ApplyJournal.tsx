import { useTranslation } from 'react-i18next';
import type { PlatformApplyTarget } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { TruncatedText } from '@shared/ui/truncated-text';
import { formatAgo } from './lib/formatAgo';
import styles from './PlatformPage.module.scss';

interface ApplyJournalProps {
  targets: PlatformApplyTarget[];
  onRollback: (targetId: string) => void;
  isPending: boolean;
}

/**
 * Журнал применения: что панель записала, когда и чем это отменить.
 *
 * Своей ленты у контура нет намеренно — правки файлов и так лежат в разделе
 * «История» поверх копий, и второй журнал рядом означал бы две правды об одной
 * правке. Здесь стоит СЛЕД применения: он же единственный, по которому откат
 * знает, что было в файле до нас.
 *
 * Откат точечный. Человек, передумавший про один CLI, не обязан отменять
 * заодно и остальные — включают смелее, когда видно, чем выключить.
 */
export function ApplyJournal({ targets, onRollback, isPending }: ApplyJournalProps) {
  const { t, i18n } = useTranslation();
  const applied = targets.filter((target) => target.applied);

  if (applied.length === 0) return null;

  return (
    <details className={styles.journal} open>
      <summary className={styles.summary}>
        <Typography variant="body-sm" weight="medium" as="span">
          {t('platform.journalTitle', { total: applied.length })}
        </Typography>
      </summary>

      <Stack gap="var(--spacing-xs)" marginTop="var(--spacing-xs)">
        {applied.map((target) => (
          <Stack
            key={target.targetId}
            direction="row"
            gap="var(--spacing-xs)"
            align="center"
            justify="between"
            wrap
            className={styles.journalRow}
          >
            <Stack gap="var(--spacing-3xs)" minWidth="12rem" flex={1}>
              <Typography variant="body-sm" as="span">
                {target.appliedAt ? formatAgo(target.appliedAt, i18n.language, t) : '—'} ·{' '}
                {t('platform.journalEntry', { title: target.title })}
              </Typography>
              {target.filePath && (
                <TruncatedText text={target.filePath} variant="caption" color="subtle" />
              )}
              {/* Файл, изменённый человеком ПОСЛЕ нас, откат не тронет: он
                  скажет об этом словом «оставлен», а не молчанием. */}
              {target.drifted && (
                <Typography variant="caption" color="warning">
                  {t('platform.journalDrifted')}
                </Typography>
              )}
            </Stack>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => onRollback(target.targetId)}
              disabled={isPending}
            >
              {t('platform.rollbackOne')}
            </Button>
          </Stack>
        ))}

        <Typography variant="caption" color="muted">
          {t('platform.journalHistoryHint')}
        </Typography>
      </Stack>
    </details>
  );
}
