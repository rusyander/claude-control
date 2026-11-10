import { useTranslation } from 'react-i18next';
import type { Group } from '@agentdeck/contracts';
import type { ScenarioRef } from '@agentdeck/contracts/core/scenario';
import { Button } from '@shared/ui/button';
import { Modal } from '@shared/ui/modal';
import { SkeletonList } from '@shared/ui/skeleton';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useFromPath, useSaveGroupScenario } from '../api/coreGroups';

interface CoreImportDialogProps {
  group: Group;
  onClose: () => void;
  /** Сценарий лёг в библиотеку ядра (или уже лежал тем же) — страница открывает запуск с ним. */
  onSaved: (ref: ScenarioRef) => void;
}

/** Причина отказа ядра одной строкой: его `error`, иначе текст исключения. */
function reasonOf(error: unknown): string {
  const data = (error as { response?: { data?: { error?: unknown } } }).response?.data;
  if (data && typeof data.error === 'string') return data.error;
  return error instanceof Error ? error.message : String(error);
}

/**
 * «В ядро» (этап 10, F1): ядро переводит «Путь» группы своей миграцией `fromPath` и показывает
 * шаги сценария; сохранение — обычная запись библиотеки ядра с судом человека. Отказ перевода
 * назван строками ядра — сценарий без части «Пути» хуже отказа (P100), поэтому сохранить его
 * нельзя.
 */
export function CoreImportDialog({ group, onClose, onSaved }: CoreImportDialogProps) {
  const { t, i18n } = useTranslation();
  const P = 'coreBoard.import';
  const preview = useFromPath(group, i18n.language);
  const save = useSaveGroupScenario();
  const scenario = preview.data?.scenario ?? null;
  const problems = preview.data?.problems ?? [];

  return (
    <Modal
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={t(`${P}.title`, { name: group.name })}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t(`${P}.cancel`)}</Button>
          <Button
            variant="primary"
            disabled={!scenario || save.isPending}
            isLoading={save.isPending}
            onClick={() => scenario && save.mutate(scenario, { onSuccess: onSaved })}
            data-core-import-save
          >
            {t(`${P}.save`)}
          </Button>
        </>
      }
    >
      <Stack gap="var(--spacing-md)" data-core-import>
        <Typography variant="body-sm">{t(`${P}.intro`)}</Typography>
        {preview.isLoading && (
          <Stack gap="var(--spacing-xs)">
            <Typography variant="body-sm" color="subtle">
              {t(`${P}.reading`)}
            </Typography>
            <SkeletonList rows={3} />
          </Stack>
        )}
        {preview.isError && (
          <Typography variant="body-sm" color="danger" data-core-import-failed>
            {`${t(`${P}.failed`)}: ${reasonOf(preview.error)}`}
          </Typography>
        )}
        {problems.length > 0 && (
          <Stack gap="var(--spacing-3xs)" data-core-import-problems>
            <Typography variant="body-sm" color="danger">
              {t(`${P}.problems`)}
            </Typography>
            {problems.map((problem) => (
              <Typography variant="body-sm" as="span" key={problem}>
                {problem}
              </Typography>
            ))}
          </Stack>
        )}
        {scenario && (
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body" weight="medium" as="h3">
              {t(`${P}.stepsHeading`)}
            </Typography>
            {scenario.steps.map((step, index) => (
              <Typography variant="body-sm" as="p" key={step.id} data-core-import-step={step.id}>
                {`${index + 1}. ${step.title}`}
              </Typography>
            ))}
          </Stack>
        )}
        {save.isError && (
          <Typography variant="body-sm" color="danger" data-core-import-save-failed>
            {t(`${P}.saveFailed`, { reason: reasonOf(save.error) })}
          </Typography>
        )}
      </Stack>
    </Modal>
  );
}
