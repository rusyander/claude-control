import { useTranslation } from 'react-i18next';
import { SkeletonList } from '@shared/ui/skeleton';
import {
  useProviderProjectInstructions,
  useUpdateProviderProjectInstructions,
} from '@entities/Project';
import { InstructionsDocument } from '../InstructionsDocument/InstructionsDocument';
import { useDiskDraft } from '../model/useDiskDraft';
import type { ProjectTabProps } from '../ProjectRulesTab.types';

/**
 * Файл инструкций проекта у активного провайдера (AGENTS.md у Codex/OpenCode,
 * GEMINI.md у Gemini) — целиком, как его читает сам CLI в каталоге проекта.
 * Тот же документ, что у Claude: чтение по умолчанию, правка явным «Править»;
 * перед записью сервер делает резервную копию.
 *
 * Панель пересоздаёт вкладку на смену проекта (`key`), поэтому черновик другого
 * проекта сюда не попадает. Черновик — тот же, что у Claude (`useDiskDraft`):
 * сравнение без учёта переносов строк, иначе файл с CRLF навсегда оставался
 * «не сохранён» (ревью 28.09 F-90), и снятие после сохранения.
 */
export function ProviderProjectInstructionsTab({ projectId }: ProjectTabProps) {
  const { t } = useTranslation();
  const { data, isLoading } = useProviderProjectInstructions(projectId, true);
  const update = useUpdateProviderProjectInstructions(projectId);
  const draft = useDiskDraft(projectId, data?.content);

  if (isLoading || !data) {
    return <SkeletonList rows={6} withActions={false} />;
  }

  const value = draft.value ?? data.content;

  return (
    <InstructionsDocument
      fileName={data.fileName}
      filePath={data.filePath}
      exists={data.exists}
      value={value}
      onChange={draft.setValue}
      isDirty={draft.isDirty}
      changedElsewhere={draft.changedElsewhere}
      isSaving={update.isPending}
      onSave={() => update.mutate(value, { onSuccess: () => draft.saved(value) })}
      onRevert={draft.revert}
      version={draft.version}
      restartHint={t('providers.needsRestartFor', { provider: data.providerName })}
    />
  );
}
