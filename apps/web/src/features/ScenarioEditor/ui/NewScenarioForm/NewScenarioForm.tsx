import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useSaveScenario } from '../../api/useScenarios';
import { failureOf } from '../../model/refusalOf';
import {
  draftFrom,
  draftProblems,
  isChain,
  newStep,
  refText,
  scenarioOf,
  type EditorDraft,
} from '../../model/scenarioDraft';
import { RefusalNote } from '../RefusalNote/RefusalNote';
import { ScenarioDraftEditor } from '../ScenarioDraftEditor/ScenarioDraftEditor';
import type { NewScenarioFormProps } from './NewScenarioForm.types';

/**
 * Новый сценарий в библиотеку ядра: с нуля (один шаг «Работа») или на основе пресета/версии.
 * Запись однократна (F6): ядро пишет версию «последняя + 1» и отказывает перезаписи; строгое
 * действие — ядро судит, что запрос от человека (`save-scenario`), и отказ показывается его
 * словами рядом с кнопкой.
 */
export function NewScenarioForm({ library, base }: NewScenarioFormProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<EditorDraft>(() =>
    base
      ? draftFrom(base, library)
      : {
          id: '',
          title: t('coreScenario.editor.blankTitle'),
          steps: [newStep('work', t('coreScenario.editor.blankStep'), [])],
        },
  );
  const save = useSaveScenario();
  const scenario = scenarioOf(draft, library);
  const problems = draftProblems(scenario);
  const refusal = save.isError ? failureOf(save.error) : undefined;

  return (
    <ScenarioDraftEditor
      draft={draft}
      onChange={(next) => {
        setDraft(next);
        // Ответ ядра был о прежнем черновике: после правки он вводил бы в заблуждение.
        if (!save.isPending) save.reset();
      }}
      versionRef={refText(scenario)}
      problems={problems}
      isNotChain={Boolean(base && !isChain(base.steps))}
      isBusy={save.isPending}
      footer={
        <Stack gap="var(--spacing-xs)" data-scenario-save>
          <div>
            <Button
              variant="primary"
              isLoading={save.isPending}
              disabled={problems.length > 0 || save.isPending}
              onClick={() => save.mutate(scenario)}
            >
              {save.isPending ? t('coreScenario.editor.saving') : t('coreScenario.editor.save')}
            </Button>
          </div>
          {save.isSuccess && (
            <Typography
              variant="body-sm"
              color="success"
              as="p"
              role="status"
              data-scenario-saved={refText(save.data.ref)}
            >
              {t('coreScenario.editor.saved', { ref: refText(save.data.ref) })}
            </Typography>
          )}
          {refusal && <RefusalNote refusal={refusal} />}
        </Stack>
      }
    />
  );
}
