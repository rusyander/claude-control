import { useQuery } from '@tanstack/react-query';
import type { ClaudeLocation } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getLocation(): Promise<ClaudeLocation> {
  const { data } = await apiClient.get<ClaudeLocation>('/location');
  return data;
}

// Хуки: компоненты работают только с ними.

export function useLocation() {
  return useQuery({ queryKey: queryKeys.location, queryFn: getLocation });
}
