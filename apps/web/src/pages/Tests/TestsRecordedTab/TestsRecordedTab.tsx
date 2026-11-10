import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import type { RecordedReplayState } from '@agentdeck/contracts';
import { useRecorded, useStartReplay } from './recordedApi';
import { RecordedCaseRow } from './RecordedCaseRow';
import { RecordedMismatchCard } from './RecordedMismatchCard';
import { RecordWalkModal } from './RecordWalkModal';
import styles from './TestsRecordedTab.module.scss';
import type { TestsRecordedTabProps } from './TestsRecordedTab.types';

/**
 * Вкладка «Сценарии» (этап 12, R3–R4): записанные проходы по стенду.
 *
 * Модель здесь работает дважды за жизнь сценария — когда его записывают и когда он впервые
 * разошёлся со стендом. Всё остальное время «Прогнать все» гоняет спеки обычным прогоном
 * блока, без модели, и встаёт на первом упавшем шаге: дальше гнать нечего, пока человек не
 * решил, сломан продукт или устарел сценарий.
 */
export function TestsRecordedTab({ projectPath, environments, groups }: TestsRecordedTabProps) {
  const { t, i18n } = useTranslation();
  const recorded = useRecorded(projectPath);
  const replay = useStartReplay(projectPath);
  const [environmentId, setEnvironmentId] = useState('');
  const [isRecordOpen, setRecordOpen] = useState(false);

  const cases = recorded.data?.cases ?? [];
  const state = recorded.data?.replay;
  const running = state?.status === 'running' || replay.isPending;

  return (
    <Stack gap="var(--spacing-sm)" data-tests-recorded>
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="heading-sm" as="h2">
              {t('testsRecorded.title')}
            </Typography>
            <Typography variant="body-sm" color="muted">
              {t('testsRecorded.lead')}
            </Typography>
          </Stack>
          <Stack direction="row" gap="var(--spacing-sm)" align="end" wrap>
            <Button
              variant="primary"
              leftIcon={<Icon name="plus" size={18} />}
              onClick={() => setRecordOpen(true)}
              disabled={!projectPath}
            >
              {t('testsRecorded.record')}
            </Button>
            <div className={styles.envField}>
              <SelectField
                label={t('testsRecorded.replayEnvironment')}
                value={environmentId}
                onChange={setEnvironmentId}
                options={[
                  { value: '', label: t('testsRecorded.replayDefault') },
                  ...environments.map((item) => ({ value: item.id, label: item.title })),
                ]}
              />
            </div>
            <Button
              variant="secondary"
              leftIcon={<Icon name="play" size={18} />}
              isLoading={running}
              disabled={running || cases.length === 0}
              onClick={() =>
                replay.mutate({
                  ...(environmentId ? { environmentId } : {}),
                  lang: i18n.language.startsWith('en') ? 'en' : 'ru',
                })
              }
            >
              {t('testsRecorded.replay')}
            </Button>
          </Stack>
          {state && <ReplayLine state={state} />}
          {replay.isError && (
            <Typography variant="body-sm" color="danger" role="alert">
              {toErrorMessage(replay.error)}
            </Typography>
          )}
        </Stack>
      </Card>

      {state?.status === 'mismatch' && (
        <RecordedMismatchCard projectPath={projectPath} replay={state} />
      )}

      {recorded.isLoading && <SkeletonList rows={3} />}
      {recorded.isError && (
        <LoadErrorCard
          title={t('testsRecorded.title')}
          text={toErrorMessage(recorded.error)}
          onRetry={() => void recorded.refetch()}
        />
      )}
      {recorded.isSuccess && cases.length === 0 && (
        <EmptyState
          icon="play"
          title={t('testsRecorded.empty')}
          text={t('testsRecorded.emptyHint')}
        />
      )}
      {cases.length > 0 && (
        <Card padding="none">
          <ul className={styles.list} aria-label={t('testsRecorded.title')}>
            {cases.map((item) => (
              <RecordedCaseRow key={`${item.groupId}:${item.caseId}`} item={item} />
            ))}
          </ul>
        </Card>
      )}

      <RecordWalkModal
        isOpen={isRecordOpen}
        onOpenChange={setRecordOpen}
        projectPath={projectPath}
        environments={environments}
        groups={groups}
      />
    </Stack>
  );
}

/** Строка состояния последнего «Прогнать все» — словами, с тоном по исходу. */
function ReplayLine({ state }: { state: RecordedReplayState }) {
  const { t } = useTranslation();
  const color = {
    running: 'info',
    passed: 'success',
    mismatch: 'warning',
    failed: 'danger',
  } as const;
  return (
    <Typography
      variant="body-sm"
      color={color[state.status]}
      role="status"
      data-testid="recorded-replay-state"
    >
      {t(`testsRecorded.replayState.${state.status}`, {
        total: state.total,
        error: state.error ?? '',
      })}
    </Typography>
  );
}
