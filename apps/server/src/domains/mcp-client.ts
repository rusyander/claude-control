import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpServer, McpToolDetail, McpTransport } from '@claude-control/contracts';

/**
 * Один разговор с MCP-сервером — на любом из трёх транспортов.
 *
 * Раньше клиент был написан руками (JSON-RPC построчно поверх stdin/stdout) и
 * жил в двух почти одинаковых копиях: в проверке здоровья и в песочнице. Копий
 * было две, а транспорт — один, stdio. Для http и sse оставался HEAD-запрос:
 * он отвечает «порт открыт», но ничего не говорит о том, MCP там вообще или
 * посторонний сервис, и уж тем более не показывает инструменты.
 *
 * Теперь протокол ведёт официальный SDK. Он умеет все три транспорта,
 * согласовывает версию протокола сам и не даст разъехаться со спецификацией,
 * когда та в очередной раз сдвинется. Здесь остаётся только то, что относится
 * к нашему приложению: как превратить запись из конфига в транспорт, сколько
 * ждать и как назвать ошибку словами, понятными на странице.
 */

/**
 * Инструмент MCP-сервера в терминах КЛИЕНТА — это контрактный `McpToolDetail`:
 * имя, описание и схема параметров, по которой песочница рисует форму вызова.
 * Имя оставлено прежним, потому что по нему ходит весь серверный код.
 *
 * Контракт тянется сюда ТОЛЬКО как тип — значение из бочки контрактов сервер
 * импортировать не может (см. `contracts/vocabulary`), но типы стираются.
 */
export type McpTool = McpToolDetail;

export interface McpToolCall {
  ok: boolean;
  /** Ответ инструмента или текст ошибки. */
  content: string;
  isError: boolean;
}

/** Что стало известно о сервере из рукопожатия. */
export interface McpHandshake {
  name?: string;
  version?: string;
}

export interface McpSession {
  handshake: McpHandshake;
  listTools(): Promise<McpTool[]>;
  callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCall>;
  close(): Promise<void>;
}

/**
 * Потолок ожидания рукопожатия — разный, потому что упирается в разное.
 *
 * У stdio в рукопожатие входит запуск процесса, а `npx -y` на первом запуске
 * ещё и тянет пакет из сети: полминуты там обычное дело, и обрывать это —
 * значит объявить рабочий сервер сломанным. У сетевых транспортов наоборот:
 * адрес, не ответивший за десяток секунд, не ответит и за минуту, а держать
 * пользователя перед крутилкой всё это время незачем.
 */
/**
 * Потолок рукопожатия stdio — там в него входит запуск процесса. Экспортирован,
 * потому что общий бюджет разговора считает вызывающий (`domains/mcp.ts`): без
 * этого он оставался на 30 с, из которых рукопожатию доставалось 20, и обещанных
 * справкой 45 секунд `npx -y` на первом запуске не получал никогда.
 */
export const STDIO_CONNECT_CAP = 45_000;

/** Откуда брать значения для ссылок вида ${VAR} в записи сервера. */
export type EnvLookup = Record<string, string | undefined>;

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Подстановка ссылок `${VAR}` и `${VAR:-значение по умолчанию}` — так же, как
 * это делает сам Claude Code с записями .mcp.json. Без неё проверка связи шла к
 * серверу с буквальной строкой `Bearer ${MY_TOKEN}` в заголовке, честно получала
 * 401, а карточка объясняла это как «требуется авторизация OAuth». Неизвестное
 * имя без значения по умолчанию собирается в `missing` — вызывающий назовёт их
 * пользователю все разом, а не по одному за проверку.
 */
export function expandEnvRefs(value: string, lookup: EnvLookup, missing: Set<string>): string {
  return value.replace(ENV_REF, (whole: string, name: string, fallback: string | undefined) => {
    const found = lookup[name];
    if (found !== undefined) return found;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return whole;
  });
}

/** Запись сервера с подставленными ссылками; незаданная переменная — ошибка с её именем. */
export function resolveServerRefs(server: McpServer, lookup: EnvLookup): McpServer {
  const missing = new Set<string>();
  const expand = (value: string): string => expandEnvRefs(value, lookup, missing);
  const expandRecord = (record: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(value)]));

  const resolved: McpServer = {
    ...server,
    command: server.command === undefined ? undefined : expand(server.command),
    args: server.args.map(expand),
    url: server.url === undefined ? undefined : expand(server.url),
    env: expandRecord(server.env),
    headers: expandRecord(server.headers),
  };

  if (missing.size > 0) {
    const names = [...missing]
      .sort()
      .map((name) => '${' + name + '}')
      .join(', ');
    throw new Error(
      `Не заданы переменные ${names}: добавьте их в разделе «Переменные» ` +
        '(settings.json → env или .mcp-secrets.env) либо в окружение, из которого запущена панель',
    );
  }

  return resolved;
}

/**
 * stderr процесса — текст, но в какой кодировке, процесс не сообщает. На Windows
 * консольные программы (node при падении, cmd, python) пишут в кодовой странице
 * консоли — у русской системы это CP866, и чтение как UTF-8 показывало
 * пользователю «������» вместо причины. Сначала строгий UTF-8 (так пишут почти
 * все серверы), не сошлось — ibm866. Декодируем целиком, а не по кускам: граница
 * чанка режет многобайтный символ пополам.
 */
export function decodeStderr(raw: Buffer, platform: NodeJS.Platform = process.platform): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return new TextDecoder(platform === 'win32' ? 'ibm866' : 'utf-8').decode(raw);
  }
}

/** Дефолтный потолок подключения к сетевым серверам, если настройка не передана. */
export const DEFAULT_NETWORK_TIMEOUT_MS = 10_000;

/**
 * Потолок рукопожатия для транспорта. У stdio он зашит (запуск процесса), у
 * сетевых транспортов — настраиваемый: адрес за прокси/туннелем отвечает
 * дольше десятка секунд, а быстрый стенд наоборот незачем ждать так долго.
 */
function connectCap(transport: McpTransport, networkTimeoutMs: number): number {
  return transport === 'stdio' ? STDIO_CONNECT_CAP : networkTimeoutMs;
}

/**
 * Общий бюджет делится на рукопожатие и на сам запрос. Треть бюджета запросу
 * оставляем всегда: рукопожатие, съевшее всё время, оставит пользователя с
 * «сервер не ответил вовремя» вместо списка инструментов — при том, что
 * сервер как раз ответил.
 */
function splitBudget(
  transport: McpTransport,
  totalMs: number,
  networkTimeoutMs: number,
): {
  connectMs: number;
  requestMs: number;
} {
  const connectMs = Math.min(connectCap(transport, networkTimeoutMs), Math.round(totalMs * 0.67));
  return { connectMs, requestMs: Math.max(totalMs - connectMs, 1_000) };
}

/**
 * Поднимает соединение и отдаёт готовую сессию. Закрывать обязательно — за
 * сессией стоит либо живой процесс, либо открытый поток событий.
 *
 * `authProvider` передаётся для серверов с OAuth: SDK сам подставит
 * сохранённый токен и обновит его при истечении. Без токена подключение упадёт
 * `UnauthorizedError` — сервер честно объявляется требующим авторизации.
 */
export async function openMcpSession(
  server: McpServer,
  totalMs: number,
  authProvider?: OAuthClientProvider,
  networkTimeoutMs: number = DEFAULT_NETWORK_TIMEOUT_MS,
  envLookup?: EnvLookup,
): Promise<McpSession> {
  const { connectMs, requestMs } = splitBudget(server.transport, totalMs, networkTimeoutMs);

  // Ссылки ${VAR} подставляются до сборки транспорта. Без lookup запись идёт как
  // есть — так ведут себя вызовы, у которых нет доступа к файлам настроек.
  const target = envLookup ? resolveServerRefs(server, envLookup) : server;
  const { transport, readStderr } = createTransport(target, authProvider);
  const client = new Client({ name: 'claude-control', version: '0.1.0' }, { capabilities: {} });

  try {
    // Свой сторож поверх таймаута SDK: тот считает время ответа на initialize,
    // а у sse ещё до initialize есть подписка на поток событий — сервер может
    // принять соединение и замолчать, и тогда ждать пришлось бы вечно.
    await withDeadline(
      client.connect(transport, { timeout: connectMs }),
      connectMs,
      'Сервер не ответил на рукопожатие вовремя',
    );
  } catch (error) {
    await client.close().catch(() => undefined);
    // Текст пересобираем сами — сообщение SDK ничего не говорит о том, что
    // именно писал в stderr упавший процесс. Исходную ошибку оставляем
    // причиной: в ней стек и код, по которым разбираются в отладке.
    throw new Error(describeFailure(error, readStderr()), { cause: error });
  }

  const info = client.getServerVersion();

  return {
    handshake: { name: info?.name, version: info?.version },

    async listTools() {
      const { tools } = await client.listTools(undefined, { timeout: requestMs });
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },

    async callTool(toolName, args) {
      const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: requestMs,
      });

      const blocks = Array.isArray(result.content) ? result.content : [];
      const text = blocks
        .map((block) => {
          const typed = block as { type?: string; text?: string };
          return typed.type === 'text' ? (typed.text ?? '') : `[${typed.type ?? 'unknown'}]`;
        })
        .join('\n');

      return { ok: !result.isError, content: text, isError: Boolean(result.isError) };
    },

    async close() {
      // Закрытие не должно ломать уже полученный ответ: процесс мог умереть
      // сам, поток — оборваться, а инструменты мы к этому моменту уже отдали.
      await client.close().catch(() => undefined);
    },
  };
}

interface PreparedTransport {
  transport: Transport;
  /** stderr процесса на момент вызова — им объясняем неудачный запуск. */
  readStderr: () => string;
}

/** Сетевой транспорт (http/sse) — оба умеют интерактивный OAuth через `finishAuth`. */
export type NetworkTransport = StreamableHTTPClientTransport | SSEClientTransport;

/**
 * Транспорт для сетевого сервера (http/sse). Единая точка сборки: тем же
 * билдером пользуется интерактивный OAuth (`mcp-oauth.ts`), иначе разбор
 * url/headers/SSE-подписки разъехался бы между проверкой связи и входом, а
 * лечить пришлось бы в двух местах.
 */
export function createNetworkTransport(
  server: McpServer,
  authProvider?: OAuthClientProvider,
): NetworkTransport {
  if (!server.url) throw new Error('Не задан адрес');

  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    throw new Error(`Адрес не разбирается как URL: ${server.url}`);
  }

  const headers = Object.keys(server.headers).length > 0 ? server.headers : undefined;

  return server.transport === 'sse'
    ? new SSEClientTransport(url, {
        authProvider,
        requestInit: { headers },
        // Заголовки нужны и на самой подписке, а не только на POST-ах с
        // сообщениями: авторизованный сервер отдаёт 401 уже на открытии
        // потока, и без этого проверка вечно упиралась бы в «не отвечает».
        eventSourceInit: headers && {
          fetch: (input, init) =>
            fetch(input, { ...init, headers: { ...init?.headers, ...headers } }),
        },
      })
    : new StreamableHTTPClientTransport(url, { authProvider, requestInit: { headers } });
}

function createTransport(server: McpServer, authProvider?: OAuthClientProvider): PreparedTransport {
  if (server.transport === 'stdio') return createStdioTransport(server);

  return { transport: createNetworkTransport(server, authProvider), readStderr: () => '' };
}

function createStdioTransport(server: McpServer): PreparedTransport {
  if (!server.command) throw new Error('Не задана команда запуска');

  // Окружение наследуем целиком: серверы регулярно читают PATH, HOME и токены
  // из общего окружения, а SDK по умолчанию отдаёт им урезанный безопасный
  // набор — с ним половина записей из настоящего конфига не поднимется.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, server.env);

  // Ручной клиент запускался на Windows через оболочку: npx, node и uvx там
  // .cmd-обёртки, а spawn без shell их не находит. SDK решает это иначе —
  // через cross-spawn, который сам ищет команду по PATHEXT и сам экранирует
  // аргументы. Поэтому shellArgs здесь больше не нужен, а заодно ушла и
  // разница в поведении между платформами.
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env,
    // Иначе ошибки запуска утекут в консоль сервера, а пользователю достанется
    // безымянное «процесс завершился» — при том, что причина была написана.
    stderr: 'pipe',
  });

  // Байты копим как есть и декодируем при чтении — см. decodeStderr.
  const chunks: Buffer[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  return { transport, readStderr: () => decodeStderr(Buffer.concat(chunks)) };
}

/** Сообщение об ошибке: своё, если есть, иначе — то, что сказал процесс. */
function describeFailure(error: unknown, stderr: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const details = stderr.trim().slice(0, 600);

  // Соединение, закрытое до ответа, само по себе ничего не объясняет —
  // объяснение почти всегда лежит в stderr упавшего процесса.
  if (!details) return message;
  return `${message}: ${details}`;
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
