import {
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  McpServer,
  McpServerDraft,
  McpHealth,
  McpTransport,
  McpToolsResult,
} from '@claude-control/contracts';
import { readJsonFile, writeJsonFile } from '../lib/safe-io.ts';
import type { AppStore } from '../lib/app-store.ts';
import { openMcpSession, DEFAULT_NETWORK_TIMEOUT_MS } from './mcp-client.ts';
import { hasOAuthTokens } from './mcp-oauth.ts';

/**
 * Регистрация MCP-серверов живёт в ~/.claude.json — рядом с каталогом .claude,
 * а не внутри него. Файл общий: помимо mcpServers там истории проектов и
 * настройки, поэтому читаем и пишем его целиком, меняя только свою секцию.
 */

interface RawMcpServer {
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

interface RawMcpConfig {
  mcpServers?: Record<string, RawMcpServer>;
  [key: string]: unknown;
}

/** Секция, куда приложение прячет выключенные серверы. Claude Code её игнорирует. */
const DISABLED_KEY = 'mcpServersDisabled';

/**
 * Список повторяет mcpTransportSchema из contracts, а не берёт его оттуда:
 * в сервер contracts приходит только как `import type` — реэкспорты идут без
 * расширений, и Node ESM их не резолвит, так что значением схема упала бы в
 * рантайме. Разъехаться списку со схемой не даст тип McpTransport: лишнее
 * значение здесь не соберётся, недостающее поймает проверка на стороне схемы.
 */
const TRANSPORTS: McpTransport[] = ['stdio', 'sse', 'http'];

/**
 * Транспорт приходит из чужого файла, который правят руками и другие
 * программы. Незнакомое значение молча приводить к типу нельзя: раньше в
 * McpServer.transport могло попасть что угодно, и до места, где по нему
 * выбирается способ подключения, ошибка доезжала в виде невнятного отказа.
 * Здесь она превращается в понятную догадку — по наличию url.
 */
function readTransport(raw: RawMcpServer): McpTransport {
  const known = TRANSPORTS.find((transport) => transport === raw.type);
  if (known) return known;

  return raw.url ? 'http' : 'stdio';
}

export function readMcpServers(
  mcpConfigPath: string,
  store: AppStore,
  appData?: string,
): McpServer[] {
  const config = readJsonFile<RawMcpConfig>(mcpConfigPath, {});
  const active = config.mcpServers ?? {};
  const disabled = (config[DISABLED_KEY] as Record<string, RawMcpServer> | undefined) ?? {};

  const toServer = (name: string, raw: RawMcpServer, isEnabled: boolean): McpServer => {
    const transport = readTransport(raw);
    return {
      id: name,
      name,
      transport,
      command: raw.command,
      args: raw.args ?? [],
      url: raw.url,
      env: raw.env ?? {},
      headers: raw.headers ?? {},
      health: isEnabled ? 'unknown' : 'disabled',
      isEnabled,
      groupIds: store.getGroupIdsFor('mcp', name),
      // Кнопку «Авторизоваться» показываем только у сетевых серверов и только
      // когда есть где смотреть токены. appData не передан — значит список
      // строит вызов, которому OAuth-статус не нужен.
      hasOAuth: transport !== 'stdio' && appData !== undefined && hasOAuthTokens(appData, name),
    };
  };

  // Секции эксклюзивны по смыслу (сервер либо включён, либо нет), но файл правят
  // руками — одно имя может оказаться в обеих. Тогда активная запись побеждает:
  // иначе вернулись бы два McpServer с одним id, а `find`/toggle рассчитывают на
  // одну. Детерминированно и без зависимости от стабильности сортировки.
  const activeNames = new Set(Object.keys(active));

  return [
    ...Object.entries(active).map(([name, raw]) => toServer(name, raw, true)),
    ...Object.entries(disabled)
      .filter(([name]) => !activeNames.has(name))
      .map(([name, raw]) => toServer(name, raw, false)),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export function saveMcpServer(
  mcpConfigPath: string,
  serverId: string | null,
  draft: McpServerDraft,
  backupDir?: string,
): string | undefined {
  const config = readJsonFile<RawMcpConfig>(mcpConfigPath, {});
  config.mcpServers ??= {};

  // Переименование: убираем запись под старым именем.
  if (serverId && serverId !== draft.name) delete config.mcpServers[serverId];

  const raw: RawMcpServer = { type: draft.transport };
  if (draft.command) raw.command = draft.command;
  if (draft.args.length > 0) raw.args = draft.args;
  if (draft.url) raw.url = draft.url;
  if (Object.keys(draft.env).length > 0) raw.env = draft.env;
  if (Object.keys(draft.headers).length > 0) raw.headers = draft.headers;

  config.mcpServers[draft.name] = raw;
  return writeJsonFile(mcpConfigPath, config, { backupDir });
}

/** Включение и выключение — перенос записи между двумя секциями файла. */
export function setMcpServerEnabled(
  mcpConfigPath: string,
  serverId: string,
  isEnabled: boolean,
  backupDir?: string,
): string | undefined {
  const config = readJsonFile<RawMcpConfig>(mcpConfigPath, {});
  config.mcpServers ??= {};
  const disabled = ((config[DISABLED_KEY] as Record<string, RawMcpServer>) ??= {});

  const from = isEnabled ? disabled : config.mcpServers;
  const to = isEnabled ? config.mcpServers : disabled;
  const entry = from[serverId];
  if (!entry) return undefined;

  delete from[serverId];
  to[serverId] = entry;
  return writeJsonFile(mcpConfigPath, config, { backupDir });
}

export function deleteMcpServer(
  mcpConfigPath: string,
  serverId: string,
  backupDir?: string,
): string | undefined {
  const config = readJsonFile<RawMcpConfig>(mcpConfigPath, {});
  delete config.mcpServers?.[serverId];
  delete (config[DISABLED_KEY] as Record<string, RawMcpServer> | undefined)?.[serverId];
  return writeJsonFile(mcpConfigPath, config, { backupDir });
}

export interface HealthResult {
  health: McpHealth;
  detail?: string;
  toolCount?: number;
}

/**
 * Проверка живости: подключаемся к серверу и говорим с ним на языке MCP —
 * рукопожатие, затем tools/list. Это честнее, чем проверять наличие файла или
 * стучаться в порт: видно и что сервер поднимается, и сколько инструментов он
 * отдаёт.
 *
 * До этого http и sse проверялись HEAD-запросом, то есть отвечали на вопрос
 * «порт открыт» вместо «это работающий MCP-сервер», и toolCount у них не
 * заполнялся вовсе. Теперь все три транспорта идут одним путём — через общего
 * клиента, который знает про транспорты всё, что нужно.
 */
export async function checkMcpHealth(
  server: McpServer,
  timeoutMs = 30_000,
  authProvider?: OAuthClientProvider,
  networkTimeoutMs: number = DEFAULT_NETWORK_TIMEOUT_MS,
): Promise<HealthResult> {
  if (!server.isEnabled) return { health: 'disabled' };

  try {
    // Общий бюджет для сетевого сервера растягиваем под настроенный потолок
    // подключения: иначе большой таймаут упёрся бы в фиксированные 30с и не
    // подействовал. stdio живёт на своём (процессном) потолке — его не трогаем.
    const totalMs =
      server.transport === 'stdio'
        ? timeoutMs
        : Math.max(timeoutMs, Math.ceil(networkTimeoutMs / 0.67) + 1_000);
    const session = await openMcpSession(server, totalMs, authProvider, networkTimeoutMs);
    try {
      return { health: 'connected', toolCount: (await session.listTools()).length };
    } finally {
      await session.close();
    }
  } catch (error) {
    // Отказ по авторизации объясняем прямо: без этого пользователь видит
    // «сервер не ответил на рукопожатие» и не понимает, что нужно войти.
    if (error instanceof UnauthorizedError || isUnauthorized(error)) {
      return { health: 'failed', detail: 'Требуется авторизация OAuth — нажмите «Авторизоваться»' };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { health: 'failed', detail: detail.slice(0, 400) };
  }
}

/**
 * Список инструментов сервера — имена и описания для помощника отбора прав.
 *
 * Тот же путь, что и у проверки здоровья: рукопожатие и tools/list через общего
 * клиента, тот же бюджет и тот же OAuth-провайдер. Отличие одно — вместо счётчика
 * инструментов возвращаются сами имена, по которым интерфейс заводит права
 * `mcp__<сервер>__<инструмент>`. Неудачу отдаём значением: помощник покажет её
 * тем же блоком, что и список.
 */
export async function listMcpServerTools(
  server: McpServer,
  timeoutMs = 30_000,
  authProvider?: OAuthClientProvider,
  networkTimeoutMs: number = DEFAULT_NETWORK_TIMEOUT_MS,
): Promise<McpToolsResult> {
  if (!server.isEnabled)
    return { tools: [], error: 'Сервер выключен — включите его, чтобы увидеть инструменты' };

  try {
    // Бюджет считаем так же, как в checkMcpHealth: сетевой потолок не должен
    // упереться в фиксированные 30с, stdio живёт на своём процессном потолке.
    const totalMs =
      server.transport === 'stdio'
        ? timeoutMs
        : Math.max(timeoutMs, Math.ceil(networkTimeoutMs / 0.67) + 1_000);
    const session = await openMcpSession(server, totalMs, authProvider, networkTimeoutMs);
    try {
      const tools = await session.listTools();
      return { tools: tools.map((tool) => ({ name: tool.name, description: tool.description })) };
    } finally {
      await session.close();
    }
  } catch (error) {
    if (error instanceof UnauthorizedError || isUnauthorized(error)) {
      return { tools: [], error: 'Требуется авторизация OAuth — нажмите «Авторизоваться»' };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { tools: [], error: detail.slice(0, 400) };
  }
}

/** `UnauthorizedError` от SDK иногда прилетает завёрнутым — ловим и по тексту. */
function isUnauthorized(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|unauthorized/i.test(message);
}
