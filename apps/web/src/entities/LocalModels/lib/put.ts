import { apiClient } from '@shared/api/client';

export async function put<T>(path: string, body: unknown): Promise<T> {
  const { data } = await apiClient.put<T>(path, body);
  return data;
}
