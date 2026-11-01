import { fileURLToPath } from 'node:url';
import { CORE_MCP_SERVER, PERMIT_MCP_SERVER } from '@agentdeck/contracts/core/model-tools';
import type { McpServerEntry } from '../adapters/adapter.types.ts';
import { agentdeckHandlers, bridgeEnv, permitHandlers } from './bridges.ts';
import { coreCheck, coreSince, newestCore } from './core-discovery.ts';
import { createCoreClient, type CoreClient } from './core-client.ts';
import { runHookProcess } from './hook.ts';
import type { McpHandlers } from './stdio-server.ts';
import { serveStdio } from './stdio-server.ts';

/**
 * Процессы сессии: `node --experimental-strip-types run.ts agentdeck|permit|hook|container|
 * recorder|state` (`recorder` — запись хука в `observe`, `state` — `agentdeck state`). Мосты MCP
 * `agentdeck` и `agentdeck-permit` кладёт в `mcpServers` шага дорога сессии ядра
 * (`bootstrap/session-road`), не запускатель: он только поднимает CLI с тем, что ему дали.
 * `hook` — хук ядра PreToolUse (`hook.ts`), его команду дорога отдаёт переходнику в `coreHook`.
 * Окружение — переменные ядра сессии.
 */

export const MCP_RUN = fileURLToPath(new URL('./run.ts', import.meta.url));

/** Записи `mcpServers` шага для дороги сессии: какой node и с какими флагами — решает она. */
export function coreMcpServers(nodeArgv: readonly string[]): Record<string, McpServerEntry> {
  const [command = process.execPath, ...flags] = nodeArgv;
  return {
    [CORE_MCP_SERVER]: { command, args: [...flags, MCP_RUN, 'agentdeck'] },
    [PERMIT_MCP_SERVER]: { command, args: [...flags, MCP_RUN, 'permit'] },
  };
}

/** Режим `run.ts` хука ядра. */
export const HOOK_MODE = 'hook';
/** Режим `run.ts` обёртки движка контейнеров сессии (`container <движок> <id> <argv> …`). */
export const CONTAINER_MODE = 'container';
/** Режим `run.ts` записи хука человека в `observe` (этап 7). */
export const RECORDER_MODE = 'recorder';
/** Режим `run.ts` команды `agentdeck state` (этап 7). */
export const STATE_MODE = 'state';

const BRIDGES: Record<string, { name: string; handlers(client: CoreClient): McpHandlers }> = {
  agentdeck: { name: CORE_MCP_SERVER, handlers: agentdeckHandlers },
  permit: { name: PERMIT_MCP_SERVER, handlers: permitHandlers },
};

// Поиск перезапущенного ядра с проверкой, что это само ядро этого дома (core-s2 F-19).
export { coreSince, newestCore } from './core-discovery.ts';

/** Пульс прогресса: 20 с — с запасом под срок бездействия MCP, урезанный человеком до минуты. */
const PROGRESS_MS = 20_000;

export async function runBridge(which: string | undefined): Promise<number> {
  if (which === HOOK_MODE) return runHookProcess();
  if (which === CONTAINER_MODE) {
    // Лениво: мосты MCP не грузят обёртку, обёртка — мосты не стартует.
    const { runContainerWrapper } = await import('./container-wrap.ts');
    return runContainerWrapper(process.argv.slice(3));
  }
  // Лениво, как обёртка: запись хука и `agentdeck state` не грузят мосты MCP.
  if (which === RECORDER_MODE) {
    const { runRecorder } = await import('./recorder.ts');
    return runRecorder(process.argv.slice(3));
  }
  if (which === STATE_MODE) {
    const { runStateCli } = await import('./state-cli.ts');
    return runStateCli(process.argv.slice(3));
  }
  const bridge = which ? BRIDGES[which] : undefined;
  if (!bridge) {
    process.stderr.write(`agentdeck mcp: unknown bridge ${String(which)}\n`);
    return 2;
  }
  const env = bridgeEnv(process.env);
  if ('missing' in env) {
    process.stderr.write(`agentdeck mcp: missing ${env.missing.join(', ')}\n`);
    return 2;
  }
  const procs = env.procs;
  const check = coreCheck();
  const client = createCoreClient({
    url: env.url,
    token: env.token,
    retryForMs: 60_000,
    stepMs: 500,
    timeoutMs: 120_000,
    ...(procs
      ? {
          rediscover: (current: string) => newestCore(procs, current, check),
          newCore: (since: number) => coreSince(procs, since, check),
        }
      : {}),
  });
  await serveStdio({
    name: bridge.name,
    version: '1.0.0',
    handlers: bridge.handlers(client),
    input: process.stdin,
    write: (line) => void process.stdout.write(line),
    progressMs: PROGRESS_MS,
  });
  return 0;
}
