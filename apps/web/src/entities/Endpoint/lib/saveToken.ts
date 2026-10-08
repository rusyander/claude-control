import { apiClient } from '@shared/api/client';

export async function saveToken(input: { profileId: string; token: string }): Promise<void> {
  await apiClient.put(`/endpoints/${encodeURIComponent(input.profileId)}/token`, {
    token: input.token,
  });
}
