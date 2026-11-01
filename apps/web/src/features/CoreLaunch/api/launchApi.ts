import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigView, SetConfigReply } from '@agentdeck/contracts/core/config';
import type { EstimateFields, EstimateReply } from '@agentdeck/contracts/core/estimate';
import { coreGet, corePost, fetchNonce, newUuidv7, pageLoadId } from '@entities/CoreTask';
import { queryKeys } from '@shared/api/query-keys';
import { withCliPath } from '../model/cliOverride';
import type { ScenarioListing } from '../model/launch.types';

/** Сценарии для выбора на экране запуска: пресеты ядра и библиотека. */
export function useScenarioListing() {
  return useQuery({
    queryKey: queryKeys.core.scenarios,
    queryFn: () => coreGet<ScenarioListing>('/scenarios'),
    retry: false,
  });
}

/** Действующая настройка ядра с отпечатком — основа записи пути CLI. */
export function useCoreConfig() {
  return useQuery({
    queryKey: queryKeys.core.config,
    queryFn: () => coreGet<ConfigView>('/config'),
    retry: false,
  });
}

/**
 * Оценка = создание задачи (G5): число страницы у ядра, затем тело с ключом повтора `cmdId`.
 * Тот же `cmdId` ядро узнаёт и отвечает 200 той же задачей без второго суда полномочий.
 */
export async function postEstimate(cmdId: string, fields: EstimateFields): Promise<EstimateReply> {
  const page = pageLoadId();
  const nonce = await fetchNonce(page);
  return corePost<EstimateReply>('/estimate', { cmdId, fields, proof: { nonce, page } });
}

export interface SaveCliPathInput {
  view: ConfigView;
  adapter: string;
  path: string;
}

/** Запись пути CLI в настройку ядра (`set-config`); после — настройка перечитывается. */
export function useSaveCliPath() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ view, adapter, path }: SaveCliPathInput) => {
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      const { doc, baseDigest } = withCliPath(view, adapter, path);
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
