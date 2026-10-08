import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Копия и применение советов пишут файлы в общие каталоги: устаревают не только
 * группы, но и списки скиллов, правил и хуков.
 */
export function invalidateAfterWrite(queryClient: ReturnType<typeof useQueryClient>): void {
  for (const key of [
    queryKeys.groups,
    queryKeys.skills,
    queryKeys.rules,
    queryKeys.hooks,
    queryKeys.overview,
  ]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}
