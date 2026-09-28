import type { McpTransport } from '@agentdeck/contracts';
import type { AssistantSpec } from '@shared/lib/assistant-fields';

/** Каждое поле MCP-сервера; транспорт — только из тех, что знает панель. */
export function mcpAssistantSpec(transports: readonly McpTransport[]) {
  return {
    name: { type: 'text', hint: 'Server name in the config' },
    transport: {
      type: 'choice',
      hint: 'Transport',
      options: transports.map((value) => ({ value })),
    },
    command: { type: 'text', hint: 'Launch command for stdio, e.g. npx' },
    args: { type: 'text', hint: 'Command arguments for stdio, space-separated' },
    url: { type: 'text', hint: 'URL for sse and http' },
    envText: { type: 'text', hint: 'Environment variables, one per line as KEY=VALUE' },
    headersText: {
      type: 'text',
      hint: 'HTTP headers for sse and http, one per line as Name=value',
    },
  } satisfies AssistantSpec;
}
