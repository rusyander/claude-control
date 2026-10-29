import { PERMIT_TOOL } from '@agentdeck/contracts/core/model-tools';
import { CORE_VARS } from '../adapters/launcher/env.ts';
import type { CoreClient } from './core-client.ts';
import type { McpHandlers, McpToolDef } from './stdio-server.ts';

/**
 * Два моста сессии (03 §Model tools, 06 §Session permissions). Оба — тонкие: список, вызов и
 * ответ CLI о праве ДЕЛАЕТ ядро; мост только носит JSON. Модель, позвавшая мост в обход CLI,
 * получает ровно то же, что CLI: ядро судит по токену и журналу, а не по тому, кто звонит.
 */

/**
 * Путь `<core home>/procs.json` для моста: по нему мост находит перезапущенное ядро на новом
 * порту. Нет — мост знает только адрес из запуска.
 */
export const CORE_PROCS_VAR = 'AGENTDECK_CORE_PROCS';

export interface BridgeEnv {
  url: string;
  token: string;
  procs?: string;
}

/** Окружение сессии, выставленное запуском (`adapters/launcher/env.ts`). Нет — мост не стартует. */
export function bridgeEnv(env: NodeJS.ProcessEnv): BridgeEnv | { missing: string[] } {
  const url = env[CORE_VARS.coreUrl];
  const token = env[CORE_VARS.access];
  const procs = env[CORE_PROCS_VAR];
  const missing = [...(url ? [] : [CORE_VARS.coreUrl]), ...(token ? [] : [CORE_VARS.access])];
  return url && token ? { url, token, ...(procs ? { procs } : {}) } : { missing };
}

function failure(outcome: Awaited<ReturnType<CoreClient['get']>>): string {
  if (outcome.kind === 'unreachable') return `core unreachable: ${outcome.reason}`;
  const body = outcome.body as { code?: unknown; error?: unknown } | null;
  return `core refused (${outcome.status}): ${String(body?.code ?? '')} ${String(body?.error ?? '')}`.trim();
}

export function agentdeckHandlers(client: CoreClient): McpHandlers {
  return {
    async list() {
      const got = await client.get('/v1/session/tools');
      if (got.kind !== 'reply' || got.status !== 200) return { error: failure(got) };
      const tools = (got.body as { tools?: unknown } | null)?.tools;
      // 200 без списка — сбой ядра, названный клиенту, а не `undefined` дальше (core-s2 F-74).
      if (!Array.isArray(tools)) return { error: 'core answered 200 without a tool list' };
      return tools as McpToolDef[];
    },
    async call(name, args) {
      const got = await client.post(`/v1/session/tools/${encodeURIComponent(name)}`, {
        input: args,
      });
      if (got.kind !== 'reply' || got.status !== 200) return { text: failure(got), isError: true };
      const reply = got.body as { ok?: boolean };
      return { text: JSON.stringify(got.body), isError: reply.ok !== true };
    },
  };
}

/** Вход инструмента права: форма вопроса CLI; разбирает её кодек переходника в ядре. */
const PERMIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    tool_name: { type: 'string' },
    input: { type: 'object' },
    tool_use_id: { type: 'string' },
  },
};

export function permitHandlers(client: CoreClient): McpHandlers {
  return {
    list: () =>
      Promise.resolve([
        {
          name: PERMIT_TOOL,
          description: 'Answers the CLI permission prompt for a pending tool call.',
          inputSchema: PERMIT_INPUT_SCHEMA,
        },
      ]),
    async call(name, args) {
      // Отказ закрыт: любой сбой — ошибка вызова, и CLI инструмент не исполнит.
      if (name !== PERMIT_TOOL) return { text: `unknown tool ${name}`, isError: true };
      // Вопрос без последствий: оборванный смертью ядра несётся новому ядру (01 §Sessions at
      // core death) — иначе CLI получил бы отказ, и сессия довела бы шаг без инструмента.
      const got = await client.post('/v1/session/permit', { raw: args }, { idempotent: true });
      if (got.kind !== 'reply' || got.status !== 200) return { text: failure(got), isError: true };
      return { text: JSON.stringify((got.body as { reply: unknown }).reply), isError: false };
    },
  };
}
