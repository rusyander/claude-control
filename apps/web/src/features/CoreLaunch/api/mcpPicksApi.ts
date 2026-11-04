import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigView, SetConfigReply } from '@agentdeck/contracts/core/config';
import type { McpOffersReply, McpPickKind } from '@agentdeck/contracts/core/panel-api';
import { coreGet, corePost, fetchNonce, newUuidv7, pageLoadId } from '@entities/CoreTask';
import { queryKeys } from '@shared/api/query-keys';
import { withPicks, type PicksDraft } from '../model/mcpPicks';

/** Серверы MCP человека по CLI ядра (`GET /v1/mcp-offers`): ядро читает их на каждом запросе. */
export function useMcpOffers() {
  return useQuery({
    queryKey: queryKeys.core.mcpOffers,
    queryFn: () => coreGet<McpOffersReply>('/mcp-offers'),
    retry: false,
  });
}

export interface SavePicksInput {
  view: ConfigView;
  draft: PicksDraft;
  kinds: readonly McpPickKind[];
}

/** Запись выбора в настройку ядра (`set-config`, строгий суд); после — настройка перечитывается. */
export function useSavePicks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ view, draft, kinds }: SavePicksInput) => {
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      const { doc, baseDigest } = withPicks(view, draft, kinds);
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
