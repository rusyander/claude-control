import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectTestDraft,
  ProjectTestDraftApplyResult,
  ProjectTestDraftRollbackResult,
  ProjectTestsView,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Черновики генерации: что прогон предложил добавить в библиотеку.
 *
 * Список черновиков строкой едет вместе с общим видом раздела — им и живёт
 * плашка «предложения ждут». А ЦЕЛИКОМ черновик запрашивается только при
 * открытии окна приёмки: он весит столько же, сколько предложенные кейсы, и
 * тащить его в каждый опрос вида было бы платой ни за что.
 */

interface DraftsResponse {
  drafts: ProjectTestDraft[];
  autoAccept: boolean;
}

/** Один черновик целиком — его показывает окно приёмки. */
export function useTestDraft(path: string | undefined, runId: string | undefined) {
  return useQuery({
    queryKey: testKeys.draft(path, runId),
    queryFn: async () => {
      const { data } = await apiClient.get<DraftsResponse>('/project-tests/drafts', {
        params: { path, runId },
      });
      return data.drafts[0];
    },
    enabled: Boolean(path) && Boolean(runId),
  });
}

/**
 * Общая часть правок черновика: ответ несёт и результат, и новый вид раздела.
 *
 * Вид кладём в кэш, а не инвалидируем: приёмка меняет библиотеку, и список
 * кейсов должен обновиться тем же кадром, что и сам черновик, — иначе человек
 * увидит «принято» и прежний список.
 */
function useDraftMutation<TVariables, TResult extends { view: ProjectTestsView }>(
  path: string | undefined,
  runId: string | undefined,
  send: (variables: TVariables) => Promise<TResult>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => {
      client.setQueryData(testKeys.view(path), data.view);
      void client.invalidateQueries({ queryKey: testKeys.draft(path, runId) });
      void client.invalidateQueries({ queryKey: testKeys.report(path) });
      void client.invalidateQueries({ queryKey: testKeys.runs(path) });
    },
  });
}

/** Применить черновик целиком или отмеченные кейсы. */
export function useApplyTestDraft(path: string | undefined, runId: string | undefined) {
  return useDraftMutation(path, runId, async (payload: { caseIds?: string[]; auto?: boolean }) => {
    const { data } = await apiClient.post<ProjectTestDraftApplyResult & { view: ProjectTestsView }>(
      '/project-tests/draft/apply',
      { path, runId, ...payload },
    );
    return data;
  });
}

/** Отклонить черновик: он уезжает в архив, библиотека не меняется. */
export function useRejectTestDraft(path: string | undefined, runId: string | undefined) {
  return useDraftMutation(path, runId, async () => {
    const { data } = await apiClient.post<{ draft: ProjectTestDraft; view: ProjectTestsView }>(
      '/project-tests/draft/reject',
      { path, runId },
    );
    return data;
  });
}

/** Отменить приёмку: добавленное убрать, изменённое вернуть из снимка. */
export function useRollbackTestDraft(path: string | undefined, runId: string | undefined) {
  return useDraftMutation(path, runId, async () => {
    const { data } = await apiClient.post<
      ProjectTestDraftRollbackResult & { view: ProjectTestsView }
    >('/project-tests/draft/rollback', { path, runId });
    return data;
  });
}

/**
 * Галочка «принимать сразу» — одно положение на проект.
 *
 * Стоит и в форме запуска, и в окне приёмки намеренно: первые предложения
 * человек смотрит глазами, а дальше включает приём, не дожидаясь следующего
 * прогона. Двух разных настроек для одного решения быть не должно.
 */
export function useSetTestDraftAuto(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data } = await apiClient.post<{ autoAccept: boolean; view: ProjectTestsView }>(
        '/project-tests/draft/auto',
        { path, enabled },
      );
      return data;
    },
    onSuccess: (data) => {
      client.setQueryData(testKeys.view(path), data.view);
    },
  });
}
