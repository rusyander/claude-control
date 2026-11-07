import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { LearnedResetBody, LearnedResetReply } from '@agentdeck/contracts/core/commands';
import type { ConfigView, SetConfigReply } from '@agentdeck/contracts/core/config';
import type { IntakeSource } from '@agentdeck/contracts/core/intake';
import type { LeadSettingsPatch } from '@agentdeck/contracts/core/lead';
import { corePost, fetchNonce, newUuidv7, pageLoadId } from '@entities/CoreTask';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { withLead, type LeadScope } from '../model/leadSettings';

export interface SaveLeadInput {
  view: ConfigView;
  scope: LeadScope;
  patch: LeadSettingsPatch;
}

/** Запись правки уровня ведения (`set-config`, строгий суд, отпечаток); после — перечитать. */
export function useSaveLead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ view, scope, patch }: SaveLeadInput) => {
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      const { doc, baseDigest } = withLead(view, scope, patch);
      return corePost<SetConfigReply>('/config', {
        cmdId: newUuidv7(),
        doc,
        baseDigest,
        proof: { nonce, page },
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.core.config }),
  });
}

/**
 * Сброс ключа обучения (P140): только человек — число страницы, как у записи настройки. Подъём,
 * заработанный ключом, снимается целиком; ядро отвечает строкой ключа в своей таблице.
 */
export function useLearnedReset() {
  return useMutation({
    mutationFn: async (key: LearnedResetBody['key']) => {
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      const body: LearnedResetBody = { cmdId: newUuidv7(), key, proof: { nonce, page } };
      return corePost<LearnedResetReply>('/learned/reset', body);
    },
  });
}

/**
 * Снимок задачи трекера (P133): читает панель своим доступом к Jira, ядро получает готовый
 * источник. Только чтение — ни трекер, ни настройка не меняются.
 */
export async function readTrackerSnapshot(key: string): Promise<IntakeSource> {
  const { data } = await apiClient.get<IntakeSource>('/core-intake/tracker-snapshot', {
    params: { key },
  });
  return data;
}
