import type { McpServer, McpServerDraft } from '@claude-control/contracts';
import { createEntityApi } from '@shared/api/create-entity-api';
import { queryKeys } from '@shared/api/query-keys';

export const mcpServerApi = createEntityApi<McpServer, McpServerDraft>({
  resource: 'mcp',
  listKey: queryKeys.mcp,
  kind: 'mcp',
});
