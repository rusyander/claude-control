import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { toErrorMessage } from '@shared/api/client';
import { useCaseDraft } from '../model/useCaseDraft';
import { TestCaseSteps } from './TestCaseSteps';
import { TestCaseParams } from './TestCaseParams';
import { TestCaseLinks } from './TestCaseLinks';
import type { TestCaseEditorProps } from './TestCaseEditor.types';
import styles from './ProjectTests.module.scss';

/**
 * Полная карточка кейса.
 *
 * Тип переключает состав формы: у чек-листа нет ни предусловия, ни ожидания, ни
 * постусловия — он и заводится ради того, чтобы этих полей не заполнять. Скрытые
 * поля не просто прячутся, а не уезжают в файл (см. `toInput`): иначе чек-лист,
 * побывавший кейсом, тащил бы за собой их остатки.
 *
 * Свои поля проекта (`schema.json`) рисуются здесь же и рядом с остальными, а не
 * отдельной вкладкой «дополнительно»: для проекта, который их завёл, они не
 * менее обязательны, чем зона или важность.
 */
export function TestCaseEditor({
  isOpen,
  onOpenChange,
  testCase,
  sharedSteps,
  schema,
  sections,
  onSave,
}: TestCaseEditorProps) {
  const { t } = useTranslation();
  const { draft, patch, toInput } = useCaseDraft(testCase, isOpen);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const isChecklist = draft.type === 'checklist';

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      await onSave(toInput());
      onOpenChange(false);
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const options = (values: readonly string[], prefix: string) =>
    values.map((value) => ({ value, label: t(`${prefix}.${value}`) }));

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={testCase ? t('projectTests.editCase') : t('projectTests.newCase')}
      description={testCase ? testCase.id : t('tests.editor.newHint')}
      size="xl"
      footer={
        <Stack direction="row" gap="var(--spacing-xs)" justify="end" align="center">
          {error && (
            <Typography variant="caption" color="danger" as="span">
              {error}
            </Typography>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            isLoading={isSaving}
            disabled={draft.title.trim().length === 0}
          >
            {t('projectTests.save')}
          </Button>
        </Stack>
      }
    >
      <Stack gap="var(--spacing-sm)">
        {/* Результат последнего прогона — первым, до полей описания: кейс
            открывают чаще всего именно потому, что он покраснел, и «что там
            увидели» нужнее, чем его формулировка. Поле не правится руками:
            его пишет прогон, а не человек. */}
        {testCase?.note && (
          <TextField
            label={t('tests.editor.lastResult')}
            hint={t('tests.editor.lastResultHint')}
            value={testCase.note}
            onChange={() => undefined}
            multiline
            rows={2}
            readOnly
          />
        )}

        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          <SelectField
            label={t('tests.editor.type')}
            value={draft.type}
            onChange={(value) => patch({ type: value as typeof draft.type })}
            options={options(['case', 'checklist'], 'tests.kind')}
          />
          <SelectField
            label={t('tests.library.priority')}
            value={draft.priority}
            onChange={(value) => patch({ priority: value as typeof draft.priority })}
            options={options(['blocker', 'high', 'medium', 'low'], 'tests.priority')}
          />
          <SelectField
            label={t('tests.library.readiness')}
            value={draft.readiness}
            onChange={(value) => patch({ readiness: value as typeof draft.readiness })}
            options={options(['draft', 'ready', 'obsolete'], 'tests.readiness')}
          />
          <div className={styles.narrowField}>
            <TextField
              label={t('tests.editor.duration')}
              hint={t('tests.editor.durationHint')}
              value={draft.duration}
              onChange={(value) => patch({ duration: value.replace(/\D/g, '') })}
            />
          </div>
        </Stack>

        <TextField
          label={t('projectTests.caseTitle')}
          value={draft.title}
          onChange={(value) => patch({ title: value })}
          autoFocus
        />
        <TextField
          label={t('projectTests.casePurpose')}
          hint={t('tests.editor.purposeHint')}
          value={draft.purpose}
          onChange={(value) => patch({ purpose: value })}
        />

        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          <div className={styles.halfField}>
            <TextField
              label={t('projectTests.caseArea')}
              value={draft.area}
              onChange={(value) => patch({ area: value })}
            />
          </div>
          <div className={styles.halfField}>
            <TextField
              label={t('tests.editor.section')}
              hint={sections.slice(0, 3).join(' · ') || t('tests.editor.sectionHint')}
              value={draft.section}
              onChange={(value) => patch({ section: value })}
            />
          </div>
        </Stack>

        {!isChecklist && (
          <TextField
            label={t('tests.editor.precondition')}
            value={draft.precondition}
            onChange={(value) => patch({ precondition: value })}
            multiline
            rows={2}
          />
        )}

        <TestCaseSteps
          steps={draft.steps}
          onChange={(steps) => patch({ steps })}
          sharedSteps={sharedSteps}
          withExpected={!isChecklist}
        />

        {!isChecklist && (
          <>
            <TextField
              label={t('projectTests.caseExpected')}
              value={draft.expected}
              onChange={(value) => patch({ expected: value })}
              multiline
              rows={2}
            />
            <TextField
              label={t('tests.editor.postcondition')}
              value={draft.postcondition}
              onChange={(value) => patch({ postcondition: value })}
              multiline
              rows={2}
            />
            <TextField
              label={t('tests.editor.oracle')}
              hint={t('tests.editor.oracleHint')}
              value={draft.oracle}
              onChange={(value) => patch({ oracle: value })}
            />
          </>
        )}

        <TextField
          label={t('tests.editor.tags')}
          hint={t('tests.editor.tagsHint')}
          value={draft.tags}
          onChange={(value) => patch({ tags: value })}
        />

        <TestCaseLinks links={draft.links} onChange={(links) => patch({ links })} />

        {schema.attributes.length > 0 && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('tests.editor.attributes')}
            </Typography>
            <Stack direction="row" gap="var(--spacing-xs)" wrap>
              {schema.attributes.map((attribute) => (
                <div key={attribute.key} className={styles.halfField}>
                  {attribute.type === 'select' ? (
                    <SelectField
                      label={attribute.title}
                      value={draft.attributes[attribute.key] ?? ''}
                      onChange={(value) =>
                        patch({ attributes: { ...draft.attributes, [attribute.key]: value } })
                      }
                      options={[
                        { value: '', label: t('tests.library.any') },
                        ...(attribute.options ?? []).map((option) => ({
                          value: option,
                          label: option,
                        })),
                      ]}
                    />
                  ) : (
                    <TextField
                      label={attribute.title}
                      value={draft.attributes[attribute.key] ?? ''}
                      onChange={(value) =>
                        patch({ attributes: { ...draft.attributes, [attribute.key]: value } })
                      }
                    />
                  )}
                </div>
              ))}
            </Stack>
          </Stack>
        )}

        <TestCaseParams
          parameters={draft.parameters}
          onChange={(parameters) => patch({ parameters })}
        />

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('tests.editor.automation')}
          </Typography>
          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            <SelectField
              label={t('tests.library.automation')}
              value={draft.automationStatus}
              onChange={(value) =>
                patch({ automationStatus: value as typeof draft.automationStatus })
              }
              options={options(['manual', 'toAutomate', 'automated'], 'tests.automation')}
            />
            <div className={styles.halfField}>
              <TextField
                label={t('tests.editor.automationFile')}
                value={draft.automationFile}
                onChange={(value) => patch({ automationFile: value })}
                isMono
              />
            </div>
            <div className={styles.halfField}>
              <TextField
                label={t('tests.editor.automationTestName')}
                value={draft.automationTestName}
                onChange={(value) => patch({ automationTestName: value })}
                isMono
              />
            </div>
          </Stack>
        </Stack>

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('tests.editor.attachments')}
          </Typography>
          {draft.attachments.length === 0 && (
            <Typography variant="caption" color="subtle">
              {t('tests.editor.attachmentsEmpty')}
            </Typography>
          )}
          <Stack direction="row" gap="var(--spacing-2xs)" wrap>
            {draft.attachments.map((file) => (
              <Badge key={file} tone="neutral">
                {file}
              </Badge>
            ))}
          </Stack>
        </Stack>

        <Stack direction="row" gap="var(--spacing-2xs)" align="center">
          <Toggle
            checked={draft.archived}
            onCheckedChange={(checked) => patch({ archived: checked })}
            aria-label={t('tests.editor.archived')}
            size="sm"
          />
          <Typography variant="caption" color="subtle" as="span">
            {t('tests.editor.archivedHint')}
          </Typography>
        </Stack>
      </Stack>
    </Modal>
  );
}
