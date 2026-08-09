import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import type { ProjectTestCaseDialogProps } from './ProjectTestCaseDialog.types';

/**
 * Правка кейса руками.
 *
 * Шаги вводятся строками в обычном поле, а не списком с кнопками «добавить
 * шаг»: человек пишет их подряд, и любая форма, требующая клика между строками,
 * превращает описание из пяти шагов в пять кликов. Разбор по переводам строк
 * делает сервер тем же кодом, что и для файла агента.
 */
export function ProjectTestCaseDialog({
  isOpen,
  onOpenChange,
  testCase,
  onSave,
}: ProjectTestCaseDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [area, setArea] = useState('');
  const [steps, setSteps] = useState('');
  const [expected, setExpected] = useState('');
  const [isSaving, setSaving] = useState(false);

  // Поля наполняются при ОТКРЫТИИ: пока окно закрыто, в нём остаётся прошлый
  // кейс, и подставлять новый в закрытое окно незачем.
  useEffect(() => {
    if (!isOpen) return;
    setTitle(testCase?.title ?? '');
    setPurpose(testCase?.purpose ?? '');
    setArea(testCase?.area ?? '');
    setSteps((testCase?.steps ?? []).join('\n'));
    setExpected(testCase?.expected ?? '');
  }, [isOpen, testCase]);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await onSave({
        id: testCase?.id,
        title,
        purpose,
        area,
        steps: steps.split('\n'),
        expected,
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={testCase ? t('projectTests.editCase') : t('projectTests.newCase')}
      size="lg"
      footer={
        <Stack direction="row" gap="var(--spacing-xs)" justify="end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            isLoading={isSaving}
            disabled={title.trim().length === 0}
          >
            {t('projectTests.save')}
          </Button>
        </Stack>
      }
    >
      <Stack gap="var(--spacing-sm)">
        <TextField
          label={t('projectTests.caseTitle')}
          value={title}
          onChange={setTitle}
          autoFocus
        />
        <TextField label={t('projectTests.casePurpose')} value={purpose} onChange={setPurpose} />
        <TextField label={t('projectTests.caseArea')} value={area} onChange={setArea} />
        <TextField
          label={t('projectTests.caseSteps')}
          hint={t('projectTests.caseStepsHint')}
          value={steps}
          onChange={setSteps}
          multiline
          rows={6}
        />
        <TextField
          label={t('projectTests.caseExpected')}
          value={expected}
          onChange={setExpected}
          multiline
          rows={2}
        />
      </Stack>
    </Modal>
  );
}
