import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderPicker } from '@features/FolderPicker';
import { ParallelLaunch } from '@features/ParallelLaunch';
import { ProjectTestsModal } from '@features/ProjectTests';
import { ProjectEnvironmentModal } from '@features/ProjectEnvironment';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import type { ChatOverlaysProps, ProjectWindow } from './ChatOverlays.types';

// Редактор кода — это CodeMirror, ~400 КБ поверх чата. Нужен только тем, кто
// открыл окно «Код проекта», поэтому чанк едет при первом открытии, а не с
// первой отрисовкой чата.
const ProjectCodeModal = lazy(() =>
  import('@features/ProjectCode').then((m) => ({ default: m.ProjectCodeModal })),
);

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
  projectWindow,
  onProjectWindowChange,
  onAskAgent,
  environmentFocusOnClose,
  isParallelOpen,
  onParallelOpenChange,
  parallelCeiling,
  projects,
  onLaunch,
}: ChatOverlaysProps) {
  const { t } = useTranslation();
  const isCodeOpen = projectWindow === 'code';
  const isEnvironmentOpen = projectWindow === 'environment';
  /** Закрытие окна сбрасывает выбор; открытие идёт кнопками шапки. */
  const toggle = (window: ProjectWindow) => (open: boolean) =>
    onProjectWindowChange(open ? window : undefined);
  // Окно монтируется при первом открытии и дальше живёт как раньше: закрытие
  // не сбрасывает его состояние, а до первого клика чанк не качается.
  const [codeMounted, setCodeMounted] = useState(isCodeOpen);
  if (isCodeOpen && !codeMounted) setCodeMounted(true);

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
      {isProjectContext && projectPath && codeMounted && (
        <Suspense fallback={null}>
          <ProjectCodeModal
            isOpen={isCodeOpen}
            onOpenChange={toggle('code')}
            projectPath={projectPath}
            chatId={activeChatId}
          />
        </Suspense>
      )}

      {/* Тест-кейсы живут в самом проекте, поэтому окно знает только его путь:
          к конкретному разговору они не привязаны. */}
      {isProjectContext && projectPath && (
        <ProjectTestsModal
          isOpen={projectWindow === 'tests'}
          onOpenChange={toggle('tests')}
          projectPath={projectPath}
        />
      )}

      {/* Окружение — тоже свойство проекта, а не разговора. Монтируется только
          открытым: закрытое окно не должно опрашивать docker. */}
      {isProjectContext && projectPath && isEnvironmentOpen && (
        <ProjectEnvironmentModal
          isOpen={isEnvironmentOpen}
          onOpenChange={toggle('environment')}
          projectPath={projectPath}
          onAskAgent={onAskAgent}
          focusOnClose={environmentFocusOnClose}
        />
      )}

      <ParallelLaunch
        isOpen={isParallelOpen}
        onOpenChange={onParallelOpenChange}
        projects={projects}
        {...(parallelCeiling ? { ceiling: parallelCeiling } : {})}
        onLaunch={onLaunch}
      />
    </>
  );
}
