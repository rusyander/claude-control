import type { PromptGateSettings, PromptGateInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export interface ApplyInput extends PromptGateSettings {
  /** Вернуть свой скрипт поверх правки человека — только по явной кнопке. */
  force?: boolean;
}

export async function applyPromptGate(input: ApplyInput): Promise<PromptGateInfo> {
  const { data } = await apiClient.put<PromptGateInfo>('/prompt-gate', input);
  return data;
}

/**
 * Сохранение и установка — одна мутация, потому что это одна операция сервера:
 * настройка без хука на диске означала бы защиту, которой нет.
 *
 * Обновляем и раздел хуков: гейт живёт в `settings.json` обычным хуком и после
 * установки обязан быть виден там же, где остальные.
 */
export function useApplyPromptGate() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: applyPromptGate,
    onSuccess: (info) => {
      queryClient.setQueryData(queryKeys.promptGate, info);
      void queryClient.invalidateQueries({ queryKey: queryKeys.hooks });
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}
