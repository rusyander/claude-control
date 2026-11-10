import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Group, LegacyGroupRunsReply } from '@agentdeck/contracts';
import type {
  FromPathReply,
  SaveScenarioBody,
  ScenarioSaveReply,
  ScenariosReply,
} from '@agentdeck/contracts/core/panel-api';
import type { Scenario, ScenarioRef } from '@agentdeck/contracts/core/scenario';
import { coreGet, corePost, fetchNonce, newUuidv7, pageLoadId } from '@entities/CoreTask';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { fromPathBody, placeInLibrary } from '../model/coreImport';

/** Прежние запуски групп — только чтение (этап 10, F1): ядро их не подхватывает. */
export function useLegacyRuns() {
  return useQuery({
    queryKey: queryKeys.groupLegacyRuns,
    queryFn: async () => (await apiClient.get<LegacyGroupRunsReply>('/groups/legacy-runs')).data,
  });
}

/**
 * Перевод «Пути» группы у ядра. 422 — не сбой запроса, а ответ: ядро назвало, что не переводится
 * (сценарий без части пути хуже отказа, P100), и окно показывает эти строки человеку.
 */
export function useFromPath(group: Group, lang: string) {
  return useQuery({
    queryKey: ['core', 'from-path', group.id, group.path, group.scenario?.steps, group.flow, lang],
    queryFn: async (): Promise<FromPathReply> => {
      try {
        return await corePost<FromPathReply>('/scenarios/from-path', fromPathBody(group, lang));
      } catch (error) {
        const response = (error as { response?: { status?: number; data?: FromPathReply } })
          .response;
        if (response?.status === 422 && response.data) return response.data;
        throw error;
      }
    },
    retry: false,
    gcTime: 0,
  });
}

/**
 * Сохранить перевод в библиотеку ядра (суд `save-scenario`, F6). Список читается свежим перед
 * записью: тот же сценарий уже лежит — берётся его версия без записи, иначе следующая версия.
 */
export function useSaveGroupScenario() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (scenario: Scenario): Promise<ScenarioRef> => {
      const listing = await coreGet<ScenariosReply>('/scenarios');
      const place = placeInLibrary(scenario, listing.library);
      if (!place.save) return place.ref;
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      const body: SaveScenarioBody = {
        cmdId: newUuidv7(),
        scenario: place.save,
        proof: { nonce, page },
      };
      return (await corePost<ScenarioSaveReply>('/scenarios', body)).ref;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.core.scenarios }),
  });
}
