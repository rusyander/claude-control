import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/**
 * Проверка настроек в изоляции. Сервер собирает временную конфигурацию
 * Claude Code, куда попадает только проверяемое, поэтому прогон ничего
 * не задевает в настоящих настройках.
 */

export type SandboxKind = 'rule' | 'skill' | 'hook' | 'script' | 'mcp' | 'group';

export interface EventFixture {
  id: string;
  event: string;
  title: string;
  description: string;
  expectsBlock: boolean;
  payload: Record<string, unknown>;
}

export function useEventFixtures() {
  return useQuery({
    queryKey: ['sandbox', 'fixtures'],
    queryFn: async () => {
      const { data } = await apiClient.get<EventFixture[]>('/sandbox/fixtures');
      return data;
    },
    staleTime: Infinity,
  });
}
