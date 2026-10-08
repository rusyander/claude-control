import { apiClient } from '@shared/api/client';

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const { data } = await apiClient.post<T>(path, body ?? {});
  return data;
}
