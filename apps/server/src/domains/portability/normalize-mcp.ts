import type { EnvSkip, McpServerItem, McpTransport } from '@agentdeck/contracts/portable-env';
import { envItemId, envSkip, needsNone } from './canon.ts';
import { codedIntent, nested, type CodedIntent } from './intent-codes.ts';
import type { EnvSourceFactory } from './normalize-types.ts';

/**
 * MCP-серверы → канон.
 *
 * Значений переменных здесь нет и быть не может: канон везёт ИМЕНА ключей
 * окружения, а значение доезжает до чужого CLI окружением процесса при запуске
 * (инвариант 5). Заголовки по той же причине едут только именами.
 */

/** Общий вид записи сервера — того, что умеют отдать все адаптеры панели. */
export interface McpServerInput {
  name: string;
  transport: string;
  command?: string | undefined;
  args?: readonly string[];
  url?: string | undefined;
  env?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  sourceFile?: string | undefined;
  /**
   * Поднимает ли его CLI. Выключенный сервер лежит в служебном разделе ТОГО ЖЕ
   * файла, то есть состояние файловое: цель с таким же разделом получит сервер
   * выключенным, а не потеряет его (П2.6). Не задан — считается действующим:
   * читатели, у которых выключателя нет, ничего о нём сказать не могут.
   */
  enabled?: boolean;
}

export interface NormalizedMcp {
  items: McpServerItem[];
  skipped: EnvSkip[];
}

/**
 * Сервер внутри процесса SDK. Формулировка повторяет предупреждение самого CLI
 * («declares type "sdk", which only an SDK host application can register»):
 * такую запись не переносит ни один эмиттер, её уровень — `×` с причиной.
 */
const SDK_REASON =
  'сервер живёт внутри процесса SDK: его регистрирует хост-приложение при старте, а не файл конфигурации';

const KNOWN_TRANSPORTS: readonly string[] = ['stdio', 'http', 'sse', 'sdk'];

/**
 * Привести транспорт к канону. `streamable-http` — задокументированный синоним
 * `http` у самого CLI. Незнакомый транспорт НЕ угадывается: запись уходит в
 * пропуск, потому что записать её у цели было бы записью вслепую.
 */
function transportOf(raw: string): McpTransport | undefined {
  const value = raw.trim().toLowerCase();
  if (value === 'streamable-http') return 'http';
  return KNOWN_TRANSPORTS.includes(value) ? (value as McpTransport) : undefined;
}

/** MCP-серверы провайдера → записи канона плюс названные пропуски. */
export function normalizeMcpServers(
  servers: readonly McpServerInput[],
  source: EnvSourceFactory,
): NormalizedMcp {
  const items: McpServerItem[] = [];
  const skipped: EnvSkip[] = [];

  for (const server of servers) {
    const transport = transportOf(server.transport);
    if (!transport) {
      skipped.push(
        envSkip(
          'mcpServer',
          'unsupported_format',
          `${server.name}: транспорт «${server.transport}» не описан ни у одного CLI`,
          'portability-skip-mcp-transport',
          { name: server.name, transport: String(server.transport) },
        ),
      );
      continue;
    }

    // Запись `sdk` доезжает до канона (человек обязан видеть, что она есть), но
    // несёт транспорт, по которому матрица выдаст `×` с причиной, — а не
    // исчезает молча и не превращается в stdio, как её видит обычный читатель
    // панели.
    if (transport === 'sdk') {
      skipped.push(
        envSkip(
          'mcpServer',
          'unsupported_format',
          `${server.name}: ${SDK_REASON}`,
          'portability-skip-mcp-sdk',
          { name: server.name },
        ),
      );
    }

    const envKeys = [...Object.keys(server.env ?? {}), ...Object.keys(server.headers ?? {})].sort();

    items.push({
      id: envItemId('mcpServer', server.name),
      kind: 'mcpServer',
      source: source('file', server.sourceFile ?? undefined),
      ...intentOf(server, transport),
      trigger: { on: 'always' },
      blocking: 'inapplicable',
      needs: needsNone(
        'MCP-сервер поднимается вместе с CLI и фактов разговора не требует',
        'portability-needs-mcp',
      ),
      // Сервер — это процесс или сеть, и человек обязан это видеть до переноса.
      sideEffects: transport === 'stdio' ? ['runs_process'] : ['network'],
      name: server.name,
      transport,
      command: server.command ?? null,
      args: [...(server.args ?? [])],
      url: server.url ?? null,
      // Только ИМЕНА ключей: значения — секреты, и в канон они не едут.
      envKeys,
      enabled: server.enabled ?? true,
      // `raw` СОБИРАЕТСЯ ЗДЕСЬ и никогда не берётся у вызывающего. Исходный
      // блок конфига содержит значения переменных и заголовков — то есть
      // токены; положить его в канон значило бы вывезти секрет полем, которое
      // существует ради точного возврата записи (инвариант 5).
      raw: JSON.stringify({
        name: server.name,
        transport,
        command: server.command ?? null,
        args: [...(server.args ?? [])],
        url: server.url ?? null,
        envKeys,
      }),
    });
  }

  return { items, skipped };
}

function intentOf(server: McpServerInput, transport: McpTransport): CodedIntent {
  const { name } = server;
  const offRu = server.enabled === false ? ' — выключен' : '';
  const off = offRu ? nested('portability-intent-mcp-off') : '';
  if (transport === 'sdk') {
    return codedIntent(`${name}: ${SDK_REASON}${offRu}`, 'portability-intent-mcp-sdk', {
      name,
      off,
    });
  }
  if (transport === 'stdio') {
    const command = server.command ?? '—';
    return codedIntent(
      `сервер инструментов ${name}: запускается командой ${command}${offRu}`,
      'portability-intent-mcp-stdio',
      { name, command, off },
    );
  }
  const url = server.url ?? '—';
  return codedIntent(`сервер инструментов ${name}: ${url}${offRu}`, 'portability-intent-mcp-url', {
    name,
    url,
    off,
  });
}
