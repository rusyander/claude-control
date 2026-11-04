import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ConfigView, SetConfigReply } from '@agentdeck/contracts/core/config';
import type { EstimateFields, EstimateReply } from '@agentdeck/contracts/core/estimate';
import { coreGet, corePost, fetchNonce, newUuidv7, pageLoadId } from '@entities/CoreTask';
import { queryKeys } from '@shared/api/query-keys';
import { toLanguage } from '@shared/config/i18n';
import { withCliPath } from '../model/cliOverride';
import type { ScenarioListing } from '../model/launch.types';
import type { ReviewLinkFields } from '../model/reviewLinkDraft';

/**
 * Сценарии для выбора на экране запуска: пресеты ядра и библиотека. Заголовки пресетов ядро
 * называет на языке панели (`?lang=`); ключ запроса несёт язык — смена языка читает заново.
 */
export function useScenarioListing() {
  const { i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  return useQuery({
    queryKey: [...queryKeys.core.scenarios, lang],
    queryFn: () => coreGet<ScenarioListing>('/scenarios', undefined, { lang }),
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

/**
 * Ревью MR по ссылке (этап 10, F8): то же доказательство, что у оценки, и тот же ответ — задача
 * `review-link@1`; ключ повтора `cmdId` держится, пока ответа нет.
 */
export async function postReviewLink(
  cmdId: string,
  fields: ReviewLinkFields,
): Promise<EstimateReply> {
  const page = pageLoadId();
  const nonce = await fetchNonce(page);
  return corePost<EstimateReply>('/review-link', { cmdId, fields, proof: { nonce, page } });
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
