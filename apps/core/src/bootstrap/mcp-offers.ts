import { SESSION_STEP_KINDS, toolPlanFor } from '@agentdeck/contracts/core/model-tools';
import type {
  McpOfferCli,
  McpOfferServer,
  McpOffersReply,
  McpPickKind,
} from '@agentdeck/contracts/core/panel-api';
import type { McpSourceRead } from '../adapters/adapter.types.ts';
import type { AdapterRegistry } from '../adapters/index.ts';
import { isRemoteMcp } from '../adapters/mcp-carry.ts';
import type { McpOffersPort } from '../api/mcp-offers.ts';
import { homeDir } from '../platform/os-kind.ts';
import { CHAT_KIND } from './session-road/mcp-list.ts';

/**
 * Порт `GET /v1/mcp-offers` (s10 p9): читатель конфига MCP каждого CLI (`adapter.mcpSource`, тот
 * же, что у дороги) над пином процесса ядра — дом и переменные дома CLI того человека, что
 * запустил ядро. Каталог — дом, доверия нет: файлы проекта не читаются (их судит дорога при
 * запуске, с доверием к репозиторию). Виды шага — `toolPlanFor`: только чтения серверы человека
 * не берёт (`mcpListFor` выбросит их с причиной), чат без выбора берёт все предложенные.
 */

export function mcpPickKinds(): McpPickKind[] {
  return SESSION_STEP_KINDS.map((kind) => ({
    kind,
    takesHuman: toolPlanFor(kind)?.builtins === 'all',
    allByDefault: kind === CHAT_KIND,
  }));
}

function cliOffers(cli: string, read: () => McpSourceRead): McpOfferCli {
  try {
    const source = read();
    const servers: McpOfferServer[] = source.servers.map((s) => ({
      id: s.id,
      scope: s.scope,
      file: s.file,
      transport: s.entry ? (isRemoteMcp(s.entry) ? 'remote' : 'stdio') : null,
      ...(s.skipped ? { skipped: s.skipped } : {}),
    }));
    return { cli, servers, unread: source.unread };
  } catch (error) {
    // Читатель решает «нет файла» сам; брошенное — сбой, который назван, а не «серверов нет».
    return {
      cli,
      servers: [],
      unread: [{ file: '?', reason: error instanceof Error ? error.message : String(error) }],
    };
  }
}

export function createMcpOffersPort(
  adapters: AdapterRegistry,
  pin: Record<string, string>,
): McpOffersPort {
  return {
    read(): McpOffersReply {
      const clis: McpOfferCli[] = [];
      const noReader: string[] = [];
      const cwd = homeDir(pin);
      for (const adapter of adapters.all()) {
        const source = adapter.mcpSource?.bind(adapter);
        if (!source) {
          noReader.push(adapter.id);
          continue;
        }
        clis.push(cliOffers(adapter.id, () => source({ pin, cwd })));
      }
      return { kinds: mcpPickKinds(), clis, noReader };
    },
  };
}
