import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  PowerAccepted,
  PowerAction,
  PowerOption,
  PowerRequest,
  PowerStatus,
} from '@agentdeck/contracts';
import { api } from '../../shared/api/client';
import { isConfigured } from '../../shared/api/connection';

/**
 * Питание выбранного компьютера: что система умеет (гибернация, сон) и кнопка.
 * Опрос редкий — режимы меняются, только когда человек их включает в системе;
 * чаще нужен лишь отказ команды, а его видно при открытии раздела.
 */

export function usePower(): UseQueryResult<PowerStatus> {
  return useQuery({
    queryKey: ['power'],
    queryFn: () => api.get<PowerStatus>('/power'),
    staleTime: 30_000,
    enabled: isConfigured(),
  });
}

/** Что предложит кнопка: первый доступный вариант в порядке, заданном панелью. */
export function preferredOption(status: PowerStatus | undefined): PowerOption | undefined {
  return status?.options.find((option) => option.available);
}

export function usePowerAction(): ReturnType<
  typeof useMutation<PowerAccepted, Error, PowerAction>
> {
  const client = useQueryClient();
  return useMutation<PowerAccepted, Error, PowerAction>({
    mutationFn: (action) =>
      api.post<PowerAccepted>('/power', { action, confirm: true } satisfies PowerRequest),
    // Отказ системы приходит после ответа — следующий опрос его покажет.
    onSuccess: (accepted) => {
      setTimeout(
        () => void client.invalidateQueries({ queryKey: ['power'] }),
        accepted.inMs + 3_000,
      );
    },
  });
}
