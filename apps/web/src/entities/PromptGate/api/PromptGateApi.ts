import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PromptGateInfo, PromptGateSettings } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

interface ApplyInput extends PromptGateSettings {
  /** Вернуть свой скрипт поверх правки человека — только по явной кнопке. */
  force?: boolean;
}

async function getPromptGate(): Promise<PromptGateInfo> {
  const { data } = await apiClient.get<PromptGateInfo>('/prompt-gate');
  return data;
}

async function applyPromptGate(input: ApplyInput): Promise<PromptGateInfo> {
  const { data } = await apiClient.put<PromptGateInfo>('/prompt-gate', input);
  return data;
}

/** Настройки гейта и то, что на самом деле лежит в каталоге хуков. */
export function usePromptGate() {
  return useQuery({ queryKey: queryKeys.promptGate, queryFn: getPromptGate });
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
    mutationFn: applyPromptGate,
    onSuccess: (info) => {
      queryClient.setQueryData(queryKeys.promptGate, info);
      void queryClient.invalidateQueries({ queryKey: queryKeys.hooks });
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}
