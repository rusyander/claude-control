import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { CORE_TASKS_ROUTE } from '@shared/config/routes';
import type { RecordedMismatch } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import { useRecordedVerdict, useRecordWalk, useWalkRows } from './recordedApi';
import styles from './TestsRecordedTab.module.scss';
import type { RecordedMismatchCardProps } from './TestsRecordedTab.types';

/**
 * Первое расхождение «Прогнать все»: какой сценарий, на каком шаге, и ровно одна задача прохода,
 * которую оно открыло. Решает человек — модель здесь ничего не решает: «Дефект продукта»
 * оставляет сценарий как есть (он поймал поломку), «Сценарий устарел» открывает перезапись
 * того же кейса из строк нового прохода, когда тот кончится.
 */
export function RecordedMismatchCard({ projectPath, replay }: RecordedMismatchCardProps) {
  const { t } = useTranslation();
  const verdict = useRecordedVerdict(projectPath);
  const mismatch = replay.mismatch;
  if (!mismatch) return null;
  const decided = mismatch.verdict;
  return (
    <Card padding="md" className={styles.mismatch}>
      <section aria-labelledby="recorded-mismatch-title" data-testid="recorded-mismatch">
        <Stack gap="var(--spacing-xs)">
          <Typography id="recorded-mismatch-title" variant="heading-sm" as="h3">
            {t('testsRecorded.mismatch.title', { title: mismatch.title })}
          </Typography>
          <Typography variant="body" weight="medium">
            {mismatch.step
              ? t('testsRecorded.mismatch.step', { n: mismatch.step.n, step: mismatch.step.title })
              : t('testsRecorded.mismatch.noStep')}
          </Typography>
          {mismatch.message && (
            <Typography variant="mono" color="muted">
              {mismatch.message}
            </Typography>
          )}
          {mismatch.taskId ? (
            <Link
              to={CORE_TASKS_ROUTE}
              search={{ id: mismatch.taskId } as never}
              className={styles.taskLink}
            >
              {t('testsRecorded.mismatch.task')}
            </Link>
          ) : (
            mismatch.walkError && (
              <Typography variant="body-sm" color="danger" role="alert">
                {t('testsRecorded.mismatch.walkError', { error: mismatch.walkError })}
              </Typography>
            )
          )}
          {decided ? (
            <Typography variant="body-sm" color="muted" role="status">
              {t(
                decided === 'defect'
                  ? 'testsRecorded.mismatch.defectDone'
                  : 'testsRecorded.mismatch.staleDone',
              )}
            </Typography>
          ) : (
            <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
              <Typography variant="body-sm">{t('testsRecorded.mismatch.question')}</Typography>
              <Button
                variant="danger"
                size="sm"
                onClick={() => verdict.mutate('defect')}
                disabled={verdict.isPending}
              >
                {t('testsRecorded.mismatch.defect')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => verdict.mutate('stale')}
                disabled={verdict.isPending}
              >
                {t('testsRecorded.mismatch.stale')}
              </Button>
            </Stack>
          )}
          {verdict.isError && (
            <Typography variant="body-sm" color="danger" role="alert">
              {toErrorMessage(verdict.error)}
            </Typography>
          )}
          {decided === 'stale' && mismatch.taskId && (
            <Rerecord projectPath={projectPath} mismatch={mismatch} taskId={mismatch.taskId} />
          )}
        </Stack>
      </section>
    </Card>
  );
}

/** Перезапись устаревшего сценария строками прохода, открытого расхождением. */
function Rerecord({
  projectPath,
  mismatch,
  taskId,
}: {
  projectPath: string | undefined;
  mismatch: RecordedMismatch;
  taskId: string;
}) {
  const { t } = useTranslation();
  const walk = useWalkRows(taskId);
  const record = useRecordWalk(projectPath);
  const rows = walk.data;
  const ended = rows?.ended === true;
  if (record.data) {
    return (
      <Typography variant="body-sm" color="success" role="status">
        {t('testsRecorded.mismatch.rerecorded', { file: record.data.file })}
      </Typography>
    );
  }
  return (
    <Stack gap="var(--spacing-2xs)">
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        <Button
          variant="primary"
          size="sm"
          disabled={!ended || record.isPending}
          isLoading={record.isPending}
          onClick={() =>
            rows &&
            record.mutate({
              groupId: mismatch.groupId,
              caseId: mismatch.caseId,
              title: mismatch.title,
              taskId,
              steps: rows.steps,
              gaps: rows.gaps,
            })
          }
        >
          {t('testsRecorded.mismatch.rerecord')}
        </Button>
        {!ended && (
          <Typography variant="caption" color="subtle">
            {t('testsRecorded.mismatch.rerecordWait')}
          </Typography>
        )}
      </Stack>
      {(record.isError || walk.isError) && (
        <Typography variant="body-sm" color="danger" role="alert">
          {toErrorMessage(record.error ?? walk.error)}
        </Typography>
      )}
    </Stack>
  );
}
