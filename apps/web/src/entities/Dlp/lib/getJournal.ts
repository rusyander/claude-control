import type { DlpJournalEntry } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function getJournal(): Promise<DlpJournalEntry[]> {
  const { data } = await apiClient.get<{ entries: DlpJournalEntry[] }>('/dlp/journal');
  return data.entries;
}
