import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Переключатель группы гасит и зажигает все её участники сразу, поэтому
 * устаревает не только список групп: правила, скиллы, хуки, MCP-серверы и
 * права меняют состояние вместе с ней.
 */
export function invalidateGroupMembers(queryClient: ReturnType<typeof useQueryClient>): void {
  for (const key of [
    queryKeys.groups,
    queryKeys.rules,
    queryKeys.skills,
    queryKeys.hooks,
    queryKeys.mcp,
    queryKeys.permissions,
    queryKeys.overview,
  ]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}
