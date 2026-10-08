import type { ProjectTestManualSession } from '@agentdeck/contracts';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { MANUAL_KEY, KEY } from './api.constants';
import { isConflict } from './isConflict';

/**
 * Общая часть ручного прогона: сервер отвечает сессией, и она кладётся в кэш
 * той же ключом, что читает экран, — отметка результата должна проступать
 * сразу, без перезапроса, иначе на медленной сети человек жмёт статус дважды.
 *
 * Список кейсов после отметки тоже устаревает — статус кейса пишется в файл
 * группы, — поэтому он помечается на перезапрос, а не переписывается вслепую.
 */
export function useManualMutation<TVariables>(
  projectPath: string | undefined,
  send: (variables: TVariables) => Promise<{ session?: ProjectTestManualSession }>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => {
      client.setQueryData([MANUAL_KEY, projectPath], data.session);
      void client.invalidateQueries({ queryKey: [KEY, projectPath] });
    },
    onError: (error) => {
      if (!isConflict(error)) return;
      void client.invalidateQueries({ queryKey: [MANUAL_KEY, projectPath] });
      void client.invalidateQueries({ queryKey: [KEY, projectPath] });
    },
  });
}
