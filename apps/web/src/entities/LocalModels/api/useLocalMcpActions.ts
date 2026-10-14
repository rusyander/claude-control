import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { LocalMcpInfo } from '@agentdeck/contracts/local-models';
import { queryKeys } from '@shared/api/query-keys';
import { post } from '../lib/post';
import { put } from '../lib/put';

/**
 * Выбор MCP-серверов проекта и замер цены. Ответ сервера — свежее состояние списка,
 * его кладём в кеш сразу, а подпись шапки чата («что поедет прогону») перечитывается:
 * она живёт под другим ключом.
 */
export function useLocalMcpActions(project: string) {
  const queryClient = useQueryClient();
  const settle = (info: LocalMcpInfo) => {
    queryClient.setQueryData(queryKeys.localMcp(project), info);
    void queryClient.invalidateQueries({ queryKey: ['platforms', 'run-plan'] });
  };
  const pick = useMutation({
    mutationFn: (servers: string[]) => put<LocalMcpInfo>('/local-models/mcp', { project, servers }),
    onSuccess: settle,
  });
  const measure = useMutation({
    mutationFn: (ids?: string[]) =>
      post<LocalMcpInfo>('/local-models/mcp/measure', { project, ...(ids ? { ids } : {}) }),
    onSuccess: settle,
  });
  return { pick, measure };
}
