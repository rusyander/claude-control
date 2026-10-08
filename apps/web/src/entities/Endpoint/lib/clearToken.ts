import { apiClient } from '@shared/api/client';

export async function clearToken(profileId: string): Promise<void> {
  await apiClient.delete(`/endpoints/${encodeURIComponent(profileId)}/token`);
}
