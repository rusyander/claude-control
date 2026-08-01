import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { Artifact } from '@claude-control/contracts';
import { toast } from '@shared/lib/toast';
import { useArtifacts, useDeleteArtifact } from '@entities/Chat';

export interface ChatArtifactsInput {
  chatId?: string;
  /** Открытый предпросмотр: удаление показанного файла закрывает и его. */
  preview?: Artifact;
  setPreview: Dispatch<SetStateAction<Artifact | undefined>>;
}

export interface ChatArtifactsApi {
  artifacts: Artifact[];
  /** Артефакт, по которому спрашиваем подтверждение удаления. */
  artifactToDelete?: Artifact;
  askDelete: (artifact: Artifact) => void;
  cancelDelete: () => void;
  confirmDelete: () => void;
  isDeleting: boolean;
}

/**
 * Файлы, созданные агентом в папке разговора: список, предпросмотр и удаление
 * с подтверждением. Удаление доступно только у чатов песочницы — у проекта
 * сервер возвращает пустой список.
 */
export function useChatArtifacts({
  chatId,
  preview,
  setPreview,
}: ChatArtifactsInput): ChatArtifactsApi {
  const { t } = useTranslation();
  const [artifactToDelete, setArtifactToDelete] = useState<Artifact | undefined>(undefined);
  const artifacts = useArtifacts(chatId);
  const deleteArtifact = useDeleteArtifact(chatId);

  // Удаление артефакта: закрываем его предпросмотр, если открыт, и убираем файл
  // из папки песочницы. Список артефактов перечитывается мутацией.
  const confirmDelete = (): void => {
    const name = artifactToDelete?.name;
    if (!name) return;
    deleteArtifact.mutate(name, {
      onSuccess: () => {
        if (preview?.name === name) setPreview(undefined);
        toast.success(t('chat.artifactDeleted', { name }));
      },
      onSettled: () => setArtifactToDelete(undefined),
    });
  };

  return {
    artifacts: artifacts.data ?? [],
    artifactToDelete,
    askDelete: (artifact: Artifact) => setArtifactToDelete(artifact),
    cancelDelete: () => setArtifactToDelete(undefined),
    confirmDelete,
    isDeleting: deleteArtifact.isPending,
  };
}
