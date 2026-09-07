import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectTestDefectDraft,
  ProjectTestManualResultInput,
  ProjectTestManualSession,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Ручной прогон: человек проходит кейсы сам, панель записывает.
 *
 * Сессия живёт на сервере, а не в памяти вкладки: закрытая вкладка, F5 и
 * переход на телефон не должны терять уже отмеченные проходы. Поэтому каждый
 * результат уходит запросом сразу, а ответом приходит вся сессия целиком —
 * восстанавливать её из локального состояния было бы нечем.
 */

export function useManualSession(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.manual(path),
    queryFn: async () => {
      const { data } = await apiClient.get<{ session?: ProjectTestManualSession }>(
        '/project-tests/manual',
        { params: { path } },
      );
      return data.session ?? null;
    },
    enabled: Boolean(path) && isEnabled,
  });
}

/** Общая часть команд ручного прогона: ответ — сессия (или её отсутствие). */
function useSessionMutation<TVariables>(
  path: string | undefined,
  send: (variables: TVariables) => Promise<ProjectTestManualSession | null>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (session) => {
      client.setQueryData(testKeys.manual(path), session);
      // Статусы кейсов и история меняются тем же результатом — обе ветки устарели.
      void client.invalidateQueries({ queryKey: testKeys.view(path) });
      void client.invalidateQueries({ queryKey: testKeys.runs(path) });
      void client.invalidateQueries({ queryKey: testKeys.report(path) });
    },
  });
}

export interface StartManualPayload {
  planId?: string;
  groupId?: string;
  caseIds?: string[];
  environmentId?: string;
}

export function useStartManualRun(path: string | undefined) {
  return useSessionMutation(path, async (payload: StartManualPayload) => {
    const { data } = await apiClient.post<{ session: ProjectTestManualSession }>(
      '/project-tests/manual/start',
      { path, ...payload },
    );
    return data.session;
  });
}

export function useSaveManualResult(path: string | undefined) {
  return useSessionMutation(path, async (payload: ProjectTestManualResultInput) => {
    const { data } = await apiClient.post<{ session: ProjectTestManualSession }>(
      '/project-tests/manual/result',
      { path, ...payload },
    );
    return data.session;
  });
}

export function useFinishManualRun(path: string | undefined) {
  return useSessionMutation(path, async (payload: { runId: string; isCancelled?: boolean }) => {
    const { data } = await apiClient.post<{ session?: ProjectTestManualSession }>(
      `/project-tests/manual/${payload.isCancelled ? 'cancel' : 'finish'}`,
      { path, runId: payload.runId },
    );
    return data.session ?? null;
  });
}

/**
 * Вложение к кейсу: файл уезжает base64 внутри обычного JSON.
 *
 * Multipart здесь не нужен и вреден: доказательство — это скриншот на пару
 * сотен килобайт, а отдельный разбор форм на сервере пришлось бы держать ради
 * одного маршрута. Ответ — путь файла от корня проекта, его и кладут в кейс.
 */
export function useUploadTestAttachment(path: string | undefined) {
  return useMutation({
    mutationFn: async (payload: { caseId: string; name: string; contentBase64: string }) => {
      const { data } = await apiClient.post<{ file: string }>('/project-tests/attachment', {
        path,
        ...payload,
      });
      return data.file;
    },
  });
}

/** Черновик дефекта по провалу: заголовок и тело собирает сервер из кейса. */
export function useTestDefectDraft(path: string | undefined) {
  return useMutation({
    mutationFn: async (payload: { groupId: string; caseId: string; runId?: string }) => {
      const { data } = await apiClient.post<{ draft: ProjectTestDefectDraft }>(
        '/project-tests/defect',
        { path, ...payload },
      );
      return data.draft;
    },
  });
}

export function useCreateTestDefect(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      groupId: string;
      caseId: string;
      /**
       * Куда заводить. Строка, а не закрытый список: целей у сервера стало
       * больше, чем `gh`/`glab` (Jira, фордж по токену), и держать их перечень
       * на фронте значит обновлять его вслед за сервером в двух местах. Что
       * доступно на самом деле, говорит `draft.targets`.
       */
      target: string;
      title: string;
      body: string;
    }) => {
      const { data } = await apiClient.post<{ url: string }>('/project-tests/defect/create', {
        path,
        ...payload,
      });
      return data.url;
    },
    // Ссылка на заведённый дефект дописывается в кейс — список после этого другой.
    onSuccess: () => void client.invalidateQueries({ queryKey: testKeys.view(path) }),
  });
}
