import type { ProjectTestsView, ProjectTestDraft } from '@agentdeck/contracts';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { testKeys } from './keys';

/**
 * Общая часть правок черновика: ответ несёт и результат, и новый вид раздела.
 *
 * Вид кладём в кэш, а не инвалидируем: приёмка меняет библиотеку, и список
 * кейсов должен обновиться тем же кадром, что и сам черновик, — иначе человек
 * увидит «принято» и прежний список.
 */
export function useDraftMutation<
  TVariables,
  TResult extends { view: ProjectTestsView; draft: ProjectTestDraft },
>(
  path: string | undefined,
  runId: string | undefined,
  send: (variables: TVariables) => Promise<TResult>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => {
      client.setQueryData(testKeys.view(path), data.view);
      // Черновик — из ответа, не перечитанный: отклонённый и откаченный уезжает
      // в архив, `GET /drafts?runId=` отвечает 404, и окно оставалось на прежнем
      // кадре — «всё принято», снова кнопка отката.
      client.setQueryData(testKeys.draft(path, runId), data.draft);
      void client.invalidateQueries({ queryKey: testKeys.report(path) });
      void client.invalidateQueries({ queryKey: testKeys.runs(path) });
    },
  });
}
