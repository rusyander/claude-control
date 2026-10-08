import type { LoweredRunsCount } from '../api/AnalyticsApi.types';
import type { LoweredRunRecord } from '@agentdeck/contracts/model-cascade';
import { apiClient } from '@shared/api/client';

/**
 * Разрез по классу работы — во что обошёлся каждый класс. Числа показываются
 * ЧЕЛОВЕКУ и только ему: таблицу «класс → модель» правит он, а агенту-
 * классификатору цена классов не сообщается никогда (см. `lowered-journal.ts`).
 */
export interface LoweredRunsKind extends LoweredRunsCount {
  /** Пусто — прогоны, которым класса не называли: ручной веер. */
  kind: string;
}

export interface LoweredRunsView {
  runs: LoweredRunRecord[];
  summary: LoweredRunsCount & { byKind: LoweredRunsKind[] };
}

export async function getLoweredRuns(): Promise<LoweredRunsView> {
  const { data } = await apiClient.get<LoweredRunsView>('/chat/lowered-runs');
  return data;
}
