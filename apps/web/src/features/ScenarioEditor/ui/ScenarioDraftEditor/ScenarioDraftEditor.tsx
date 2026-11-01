import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import {
  insertStepAfter,
  moveStep,
  newStep,
  removeStepAt,
  replaceStepAt,
} from '../../model/scenarioDraft';
import { StepForm } from '../StepForm/StepForm';
import { StepList } from '../StepList/StepList';
import type { ScenarioDraftEditorProps } from './ScenarioDraftEditor.types';
import styles from './ScenarioDraftEditor.module.scss';

/**
 * Черновик сценария: id и название, шаги списком (вставка, перенос, удаление с подтверждением)
 * и форма выбранного шага. Версию человек не вводит — строка «Сохранится как id@v» показывает,
 * под какой версией ядро запишет черновик. Список «Пока не сохранить» — суд той же схемы, что у
 * ядра; кнопка записи — у вызывающего (`footer`): библиотека и правка задачи пишут по-разному.
 */
export function ScenarioDraftEditor({
  draft,
  onChange,
  versionRef,
  problems,
  isNotChain,
  isIdLocked = false,
  isBusy,
  footer,
}: ScenarioDraftEditorProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(0);
  // Поколение формы: вставка, перенос и удаление могут поставить на то же место другой шаг —
  // форма с прежним ключом показала бы тексты полей ушедшего шага.
  const [epoch, setEpoch] = useState(0);
  const [removing, setRemoving] = useState<number | undefined>(undefined);
  const steps = draft.steps;
  const current = Math.min(selected, steps.length - 1);
  const step = steps[current];
  const removingStep = removing === undefined ? undefined : steps[removing];

  const setSteps = (next: typeof steps, open: number): void => {
    onChange({ ...draft, steps: next });
    setSelected(Math.max(0, open));
    setEpoch((n) => n + 1);
  };
  const insert = (afterIndex: number): void => {
    const added = newStep(
      'work',
      t('coreScenario.editor.newStepTitle'),
      steps.map((s) => s.id),
    );
    setSteps(insertStepAfter(steps, afterIndex, added), afterIndex + 1);
  };
  const move = (from: number, afterIndex: number): void => {
    const next = moveStep(steps, from, afterIndex);
    // Открытой остаётся форма того же шага, где бы он ни встал после переноса.
    const openId = steps[current]?.id;
    setSteps(
      next,
      next.findIndex((s) => s.id === openId),
    );
  };
  const remove = (index: number): void => {
    // Убран шаг выше открытого — открытый сдвинулся на строку вверх; нижний не трогает выбор.
    setSteps(removeStepAt(steps, index), index < current ? current - 1 : current);
    setRemoving(undefined);
  };

  return (
    <Stack gap="var(--spacing-md)" data-scenario-editor>
      <div className={styles.head}>
        <TextField
          label={t('coreScenario.editor.title')}
          value={draft.title}
          onChange={(title) => onChange({ ...draft, title })}
        />
        <TextField
          label={t('coreScenario.editor.id')}
          hint={t('coreScenario.editor.idHint')}
          value={draft.id}
          isMono
          readOnly={isIdLocked}
          onChange={(id) => onChange({ ...draft, id: id.trim() })}
        />
      </div>
      <Typography variant="body-sm" color="subtle" as="p" data-scenario-version={versionRef}>
        {t('coreScenario.editor.version', { ref: versionRef })}
      </Typography>
      {isNotChain && (
        <Typography variant="caption" color="warning" as="p" role="note">
          {t('coreScenario.editor.notChain')}
        </Typography>
      )}

      <div className={styles.columns}>
        <div className={styles.list}>
          <StepList
            steps={steps}
            selected={current}
            isBusy={isBusy}
            onSelect={setSelected}
            onInsert={insert}
            onMove={move}
            onRemove={setRemoving}
          />
        </div>
        <div className={styles.form}>
          {step ? (
            <StepForm
              // Форма пересоздаётся на другом шаге: тексты полей берутся у него заново.
              key={`${epoch}:${current}`}
              step={step}
              number={current + 1}
              // Правка поля — без нового поколения: форма живёт, фокус остаётся в поле.
              onChange={(next) =>
                onChange({ ...draft, steps: replaceStepAt(steps, current, next) })
              }
            />
          ) : (
            <Typography variant="body-sm" color="subtle" as="p">
              {t('coreScenario.editor.stepNone')}
            </Typography>
          )}
        </div>
      </div>

      <section className={styles.problems} aria-live="polite" data-draft-problems={problems.length}>
        {problems.length > 0 ? (
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" weight="semibold" color="warning" as="span">
              {t('coreScenario.editor.problems')}
            </Typography>
            <ul className={styles.problemList}>
              {problems.map((problem) => (
                <li key={`${problem.path}:${problem.message}`}>
                  <Typography variant="caption" as="span">
                    {problem.path ? `${problem.path}: ` : ''}
                    {problem.message}
                  </Typography>
                </li>
              ))}
            </ul>
          </Stack>
        ) : (
          <Typography variant="caption" color="subtle" as="span">
            {t('coreScenario.editor.noProblems')}
          </Typography>
        )}
      </section>
      {footer}

      <ConfirmDialog
        isOpen={removingStep !== undefined}
        onOpenChange={(isOpen) => !isOpen && setRemoving(undefined)}
        onConfirm={() => removing !== undefined && remove(removing)}
        title={t('coreScenario.editor.removeTitle')}
        description={t('coreScenario.editor.removeText', {
          title: removingStep?.title || removingStep?.id || '',
        })}
        confirmLabel={t('coreScenario.editor.removeConfirm')}
      />
    </Stack>
  );
}
