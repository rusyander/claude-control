import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommandOutcome } from '@agentdeck/contracts/core/commands';
import type {
  SaveScenarioBody,
  ScenarioReply,
  ScenarioSaveReply,
  ScenariosReply,
} from '@agentdeck/contracts/core/panel-api';
import type { Scenario, ScenarioRef } from '@agentdeck/contracts/core/scenario';
import {
  coreGet,
  corePost,
  fetchNonce,
  newUuidv7,
  pageLoadId,
  useCoreCommand,
} from '@entities/CoreTask';
import { queryKeys } from '@shared/api/query-keys';
import { toLanguage, type Language } from '@shared/config/i18n';
import { useTranslation } from 'react-i18next';
import { refText } from '../model/scenarioDraft';

/** Язык панели для заголовков пресетов: ядро называет их на нём (`?lang=`), ключ его несёт. */
function useCoreLang(): Language {
  const { i18n } = useTranslation();
  return toLanguage(i18n.language);
}

export function useScenarioList() {
  const lang = useCoreLang();
  return useQuery({
    queryKey: [...queryKeys.core.scenarios, lang],
    queryFn: () => coreGet<ScenariosReply>('/scenarios', undefined, { lang }),
    retry: false,
  });
}

/**
 * Один сценарий по ссылке. `keepPrevious` — пока читается новая версия, виден прежний ответ:
 * правка задачи не теряет черновик и ответ ядра в миг, когда действующая версия сменилась.
 */
export function useScenarioRead(ref: ScenarioRef | undefined, keepPrevious = false) {
  const text = ref ? refText(ref) : '';
  const lang = useCoreLang();
  return useQuery({
    queryKey: [...queryKeys.core.scenario(text), lang],
    queryFn: () => coreGet<ScenarioReply>('/scenarios/:ref', { ref: text }, { lang }),
    enabled: Boolean(ref),
    retry: false,
    ...(keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });
}

/**
 * Новый сценарий в библиотеку (`POST /v1/scenarios`, F6): число страницы у ядра, затем тело с
 * доказательством. Повтор нажатия — новый `cmdId` и новое число: однократность записи держит
 * ядро (409 «версия занята»), не клиент.
 */
export function useSaveScenario() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (scenario: Scenario): Promise<ScenarioSaveReply> => {
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      const body: SaveScenarioBody = { cmdId: newUuidv7(), scenario, proof: { nonce, page } };
      return corePost<ScenarioSaveReply>('/scenarios', body);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.core.scenarios }),
  });
}

export interface EditScenarioDraft {
  taskId: string;
  scenario: Scenario;
  baseVersion: number;
  applyNow: boolean;
}

/** Правка сценария идущей задачи — команда `edit-scenario` (ядро пишет новую версию само). */
export function useEditTaskScenario() {
  const queryClient = useQueryClient();
  const command = useCoreCommand();
  return useMutation({
    mutationFn: ({ taskId, scenario, baseVersion, applyNow }: EditScenarioDraft) =>
      command.mutateAsync({
        kind: 'edit-scenario',
        taskId,
        fields: { scenario, baseVersion, applyNow },
      }) as Promise<CommandOutcome>,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.core.scenarios }),
  });
}
