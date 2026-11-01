import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { LoadErrorCard } from '@shared/ui/load-error';
import { SkeletonList } from '@shared/ui/skeleton';
import { Stack } from '@shared/ui/stack';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { useEditTaskScenario, useScenarioRead } from '../../api/useScenarios';
import { failureOf } from '../../model/refusalOf';
import {
  draftFrom,
  draftProblems,
  isChain,
  refText,
  scenarioOf,
  type EditorDraft,
} from '../../model/scenarioDraft';
import { RefusalNote } from '../RefusalNote/RefusalNote';
import { ScenarioDraftEditor } from '../ScenarioDraftEditor/ScenarioDraftEditor';
import type { TaskDraftProps, TaskScenarioFormProps } from './TaskScenarioForm.types';

/** Исход `edit-scenario` из ответа ядра: откуда, куда и предупреждения о рискованной правке. */
function editOutcome(
  outcome: unknown,
): { from: string; to: string; warnings: string[] } | undefined {
  if (typeof outcome !== 'object' || outcome === null) return undefined;
  const { from, to, warnings } = outcome as { from?: unknown; to?: unknown; warnings?: unknown };
  if (typeof from !== 'string' || typeof to !== 'string') return undefined;
  const list = Array.isArray(warnings)
    ? warnings.filter((w): w is string => typeof w === 'string')
    : [];
  return { from, to, warnings: list };
}

function TaskDraft({ taskId, current, base, library }: TaskDraftProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<EditorDraft>(() => draftFrom(base, library));
  const [applyNow, setApplyNow] = useState(false);
  const edit = useEditTaskScenario();
  const scenario = scenarioOf(draft, library);
  const problems = draftProblems(scenario);
  const outcome = edit.isSuccess ? editOutcome(edit.data.outcome) : undefined;
  const refusal = edit.isError ? failureOf(edit.error) : undefined;

  return (
    <ScenarioDraftEditor
      draft={draft}
      onChange={(next) => {
        setDraft(next);
        if (!edit.isPending) edit.reset();
      }}
      versionRef={refText(scenario)}
      problems={problems}
      isNotChain={!isChain(base.steps)}
      isIdLocked
      isBusy={edit.isPending}
      footer={
        <Stack gap="var(--spacing-xs)" data-task-edit>
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Toggle
              checked={applyNow}
              aria-label={t('coreScenario.task.applyNow')}
              onCheckedChange={setApplyNow}
            />
            <Stack gap="0">
              <Typography variant="body-sm" as="span">
                {t('coreScenario.task.applyNow')}
              </Typography>
              <Typography variant="caption" color="subtle" as="span">
                {t('coreScenario.task.applyNowHint')}
              </Typography>
            </Stack>
          </Stack>
          <div>
            <Button
              variant="primary"
              isLoading={edit.isPending}
              disabled={problems.length > 0 || edit.isPending}
              onClick={() =>
                edit.mutate({ taskId, scenario, baseVersion: current.version, applyNow })
              }
            >
              {t('coreScenario.task.submit')}
            </Button>
          </div>
          {outcome && (
            <Stack gap="var(--spacing-3xs)" role="status" data-task-edit-applied={outcome.to}>
              <Typography variant="body-sm" color="success" as="p">
                {t('coreScenario.task.applied', { from: outcome.from, to: outcome.to })}
              </Typography>
              {outcome.warnings.length > 0 && (
                <Typography variant="caption" color="warning" as="p">
                  {t('coreScenario.task.warnings')}: {outcome.warnings.join('; ')}
                </Typography>
              )}
            </Stack>
          )}
          {refusal && <RefusalNote refusal={refusal} />}
        </Stack>
      }
    />
  );
}

/**
 * Правка сценария идущей задачи (`edit-scenario`, G11): основа — действующая версия задачи
 * (ожидающая правка главнее), новая версия — «последняя в библиотеке + 1». Пресет правится под
 * своим id `<пресет>-own`: ядро не пишет пресетных версий.
 */
export function TaskScenarioForm({ taskId, current, isPending, library }: TaskScenarioFormProps) {
  const { t } = useTranslation();
  const read = useScenarioRead(current, true);
  const ref = refText(current);
  return (
    <Stack gap="var(--spacing-sm)" data-task-scenario={ref}>
      <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
        <Typography variant="body-sm" as="span">
          {t('coreScenario.task.current', { ref })}
        </Typography>
        {isPending && <Badge tone="warning">{t('coreScenario.task.pending')}</Badge>}
      </Stack>
      {read.isLoading && <SkeletonList rows={4} />}
      {read.isError && (
        <LoadErrorCard title={t('coreScenario.readError')} onRetry={() => void read.refetch()} />
      )}
      {read.data && (
        <TaskDraft
          // Ключ — задача, не версия: принятая правка меняет действующую версию, и черновик
          // с ответом ядра не должен исчезнуть в тот же миг; основа следующей правки — новая версия.
          key={taskId}
          taskId={taskId}
          current={current}
          base={read.data.scenario}
          library={library}
        />
      )}
    </Stack>
  );
}
