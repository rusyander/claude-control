import { apiClient } from '@shared/api/client';

export async function clearCredentials(): Promise<void> {
  await apiClient.delete('/credentials');
}
