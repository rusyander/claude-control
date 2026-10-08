import type { DlpRule } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function saveRules(rules: DlpRule[]): Promise<void> {
  await apiClient.put('/dlp/rules', { rules });
}
