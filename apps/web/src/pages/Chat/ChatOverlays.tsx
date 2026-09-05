import { useTranslation } from 'react-i18next';
import { FolderPicker } from '@features/FolderPicker';
import { ParallelLaunch } from '@features/ParallelLaunch';
import { ProjectCodeModal } from '@features/ProjectCode';
import { ProjectTestsModal } from '@features/ProjectTests';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import type { ChatOverlaysProps } from './ChatOverlays.types';

/**
 * Окна поверх чата. Собраны вместе не по смыслу, а по месту: каждое живёт
 * поверх страницы, ничего в её разметке не занимает и открывается своим флагом.
 * Держать их в самой странице значило бы держать в ней полсотни строк, которые
 * к её устройству отношения не имеют.
 */
export function ChatOverlays({
  isFolderPickerOpen,
  onFolderPickerOpenChange,
  onPickFolder,
  artifactToDelete,
  onCancelDelete,
  onConfirmDelete,
  isDeleting,
  isProjectContext,
  projectPath,
  activeChatId,
  isCodeOpen,
  onCodeOpenChange,
  isTestsOpen,
  onTestsOpenChange,
  isParallelOpen,
  onParallelOpenChange,
  projects,
  onLaunch,
}: ChatOverlaysProps) {
  const { t } = useTranslation();

  return (
    <>
      <FolderPicker
        isOpen={isFolderPickerOpen}
        onOpenChange={onFolderPickerOpenChange}
        onPick={onPickFolder}
      />

      <ConfirmDialog
        isOpen={Boolean(artifactToDelete)}
        onOpenChange={(open) => !open && onCancelDelete()}
        onConfirm={onConfirmDelete}
        title={t('chat.deleteArtifactTitle')}
        description={t('chat.deleteArtifactConfirm', { name: artifactToDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        isPending={isDeleting}
      />

      {/* Код проекта. Разговор передаём, чтобы дифф показывал правки ИМЕННО
          этого чата; в песочнице кнопки нет — окно живёт только у проекта. */}
      {isProjectContext && projectPath && (
        <ProjectCodeModal
          isOpen={isCodeOpen}
          onOpenChange={onCodeOpenChange}
          projectPath={projectPath}
          chatId={activeChatId}
        />
      )}

      {/* Тест-кейсы живут в самом проекте, поэтому окно знает только его путь:
          к конкретному разговору они не привязаны. */}
      {isProjectContext && projectPath && (
        <ProjectTestsModal
          isOpen={isTestsOpen}
          onOpenChange={onTestsOpenChange}
          projectPath={projectPath}
        />
      )}

      <ParallelLaunch
        isOpen={isParallelOpen}
        onOpenChange={onParallelOpenChange}
        projects={projects}
        onLaunch={onLaunch}
      />
    </>
  );
}
