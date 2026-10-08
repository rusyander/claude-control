import { apiClient } from '@shared/api/client';

export async function saveCredentials(raw: string): Promise<void> {
  await apiClient.post('/credentials', { value: raw });
}
