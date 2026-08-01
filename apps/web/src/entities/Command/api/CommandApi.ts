import { useQuery } from '@tanstack/react-query';
import type { CommandsResponse } from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';

/**
 * Команды активного провайдера, прочитанные с диска. Встроенные приходят не
 * отсюда: их каталог ведёт клиент (у CLI нет способа отдать свой список).
 */
export function useCommands() {
  return useQuery({
    queryKey: ['commands'],
    queryFn: async () => {
      const { data } = await apiClient.get<CommandsResponse>('/commands');
      return data;
    },
  });
}
