import { useTranslation } from 'react-i18next';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { InstructionFilesCard } from '@shared/ui/instruction-files';
import { InstructionsDocument } from '../InstructionsDocument/InstructionsDocument';
import type { ProjectRulesTabProps } from '../ProjectRulesTab.types';

/**
 * Вкладка «Инструкции»: файл инструкций проекта целиком, как его читает сам
 * Claude в каталоге проекта. Перед записью сервер делает резервную копию.
 *
 * ИМЯ файла — не константа (П2.7): проект без своего `CLAUDE.md` живёт на
 * `AGENTS.md`, и раскладку показывает карточка файлов рядом с документом. Панель
 * ничего не переименовывает и второго файла не заводит.
 */
export function ProjectRulesTab({ draft }: ProjectRulesTabProps) {
  const { t } = useTranslation();
  const { data, value } = draft;

  if (draft.isError && data === undefined) return <LoadErrorCard onRetry={draft.retry} />;
  if (draft.isLoading || data === undefined || value === undefined) {
    return <SkeletonList rows={6} withActions={false} />;
  }

  return (
    <InstructionsDocument
      fileName={data.fileName}
      filePath={data.filePath}
      exists={!data.instructionFiles.proposed}
      value={value}
      onChange={draft.setValue}
      isDirty={draft.isDirty}
      changedElsewhere={draft.changedElsewhere}
      isSaving={draft.isSaving}
      onSave={draft.save}
      onRevert={draft.revert}
      version={draft.version}
      restartHint={t('common.needsRestart')}
      aside={
        <InstructionFilesCard
          view={data.instructionFiles}
          chosenName={draft.chosenName}
          onChooseName={draft.chooseName}
        />
      }
    />
  );
}
