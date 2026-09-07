import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { formatDateTime } from '@shared/lib/format';
import { useTestHistory } from '@entities/ProjectTest';
import type { TestHistoryModalProps } from './TestHistoryModal.types';
import styles from './ProjectTests.module.scss';

/**
 * История файла группы — прямо из git проекта.
 *
 * Своего версионирования у кейсов нет намеренно: они лежат в репозитории, и на
 * вопрос «кто и когда это менял» git отвечает точнее любой встроенной ленты,
 * заодно давая ревью и откат. Панель только показывает то, что git уже знает, и
 * ничего в него не пишет.
 *
 * Проект без git и ещё не закоммиченный файл — это пустая история, а не ошибка:
 * кейсы могут вести и в каталоге, который никто не версионирует.
 */
export function TestHistoryModal({
  isOpen,
  onOpenChange,
  projectPath,
  groupId,
}: TestHistoryModalProps) {
  const { t, i18n } = useTranslation();
  const { data: entries, isLoading } = useTestHistory(projectPath, groupId, isOpen);

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('projectTests.history.title', { group: groupId })}
      size="md"
    >
      {isLoading && <SkeletonList rows={4} />}

      {!isLoading && (entries?.length ?? 0) === 0 && (
        <EmptyState
          icon="history"
          title={t('projectTests.history.empty')}
          text={t('projectTests.history.emptyHint')}
        />
      )}

      {!isLoading && (entries?.length ?? 0) > 0 && (
        <Stack gap="var(--spacing-xs)">
          {entries?.map((entry) => (
            <Stack key={entry.hash} gap="var(--spacing-3xs)" className={styles.historyRow}>
              <Typography variant="body" weight="medium" as="span">
                {entry.subject}
              </Typography>
              <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
                <Typography variant="mono" color="subtle" as="span">
                  {entry.hash}
                </Typography>
                <Typography variant="caption" color="muted" as="span">
                  {entry.author} · {formatDateTime(entry.date, i18n.language)}
                </Typography>
                {/* Объём правки: по нему видно «поправили строку» против
                    «переписали набор» — без открытия самого коммита. */}
                {entry.added !== undefined && (
                  <Badge tone="neutral">{`+${entry.added} / −${entry.removed ?? 0}`}</Badge>
                )}
              </Stack>
            </Stack>
          ))}
        </Stack>
      )}
    </Modal>
  );
}
