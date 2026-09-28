import { useState } from 'react';
import { useProjectRules, useUpdateProjectRules } from '@entities/Project';
import { useDiskDraft } from './useDiskDraft';

/**
 * Черновик файла инструкций проекта — выше вкладок.
 *
 * Черновик живёт у панели проекта, а не у вкладки: уход на «Права» и обратно
 * раньше молча выбрасывал набранное, а пометка «не сохранено» на полосе вкладок
 * не могла бы знать о правке, которой уже нет. Черновик привязан к проекту: у
 * другого проекта он не показывается, и смена проекта его не переносит.
 *
 * Сохранённый черновик снимается, когда диск вернул тот же текст: оставшись, он
 * прятал правку, записанную потом агентом или редактором, и «Сохранить»
 * возвращал старое поверх неё (ревью 28.09 F-91). Правила — `diskDraft.ts`.
 */
export function useInstructionsDraft(projectId: string) {
  const query = useProjectRules(projectId);
  const update = useUpdateProjectRules(projectId);
  // Имя выбирается ТОЛЬКО пока файла нет; выбор уходит вместе с сохранением —
  // панель ничего не переименовывает (П2.7).
  const [chosen, setChosen] = useState<{ projectId: string; name: string } | undefined>(undefined);

  const data = query.data;
  const draft = useDiskDraft(projectId, data?.content);
  const { value, isDirty } = draft;
  const chosenName = chosen?.projectId === projectId ? chosen.name : data?.fileName;

  return {
    data,
    isLoading: query.isLoading,
    isError: query.isError,
    value,
    isDirty,
    changedElsewhere: draft.changedElsewhere,
    version: draft.version,
    chosenName,
    isSaving: update.isPending,
    retry: (): void => void query.refetch(),
    setValue: draft.setValue,
    chooseName: (name: string): void => setChosen({ projectId, name }),
    revert: draft.revert,
    save: (): void => {
      if (!data || value === undefined || !isDirty) return;
      const sent = value;
      update.mutate(
        {
          content: sent,
          // Имя уходит только когда файла ещё нет: иначе сервер увидел бы просьбу
          // переименовать существующий и ответил 409.
          fileName: data.instructionFiles.proposed ? chosenName : undefined,
        },
        { onSuccess: () => draft.saved(sent) },
      );
    },
  };
}

export type InstructionsDraft = ReturnType<typeof useInstructionsDraft>;
