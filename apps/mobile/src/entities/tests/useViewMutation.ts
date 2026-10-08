import type { ProjectTestsView } from '@agentdeck/contracts';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { KEY } from './api.constants';
import { isConflict } from './isConflict';

/**
 * Общая часть правок: сервер отвечает уже пересобранным списком, и мы кладём
 * его в кэш вместо инвалидации — иначе между записью и перезапросом экран
 * моргал бы прежним состоянием, а во время прогона терял бы свежие галочки.
 */
export function useViewMutation<TVariables>(
  projectPath: string | undefined,
  send: (variables: TVariables) => Promise<ProjectTestsView>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => client.setQueryData([KEY, projectPath], data),
    onError: (error) => {
      if (isConflict(error)) void client.invalidateQueries({ queryKey: [KEY, projectPath] });
    },
  });
}
