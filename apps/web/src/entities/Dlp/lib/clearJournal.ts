import { apiClient } from '@shared/api/client';

export async function clearJournal(): Promise<void> {
  await apiClient.delete('/dlp/journal');
}
