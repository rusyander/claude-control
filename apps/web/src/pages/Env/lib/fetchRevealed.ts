import type { EnvVar } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/**
 * Полное значение секрета — отдельным запросом. Тело читаем сырым текстом:
 * обычный разбор axios пробует JSON.parse на любом теле, и чисто числовой
 * секрет приезжал бы числом, а секрет вида `{"a":1}` — объектом.
 */
export async function fetchRevealed(item: EnvVar): Promise<string> {
  const { data } = await apiClient.get<unknown>('/env/reveal', {
    params: { key: item.key, source: item.source },
    transformResponse: [(raw: unknown) => raw],
  });
  return typeof data === 'string' ? data : String(data);
}
