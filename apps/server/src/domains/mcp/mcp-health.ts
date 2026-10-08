import type { McpHealth, McpTransport, McpServer, McpToolsResult } from '@agentdeck/contracts';
import {
  STDIO_CONNECT_CAP,
  DEFAULT_NETWORK_TIMEOUT_MS,
  type EnvLookup,
  openMcpSession,
} from '../mcp-client/mcp-client.ts';
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { serverText } from '../../lib/server-texts/server-texts.ts';

export interface HealthResult {
  health: McpHealth;
  detail?: string;
  toolCount?: number;
  /** Когда проверка проводилась (ISO) — карточка показывает, обзор хранит. */
  checkedAt: string;
}

/**
 * Общий бюджет разговора. Сетевой растягивается под настроенный потолок
 * подключения: иначе большой таймаут упёрся бы в фиксированные 30 с и не
 * подействовал. stdio — под свой потолок запуска процесса: раньше он оставался
 * на тех же 30 с, из которых рукопожатию доставалось 20, и обещанные справкой
 * 45 секунд `npx -y` на первом запуске не получал никогда.
 */
export function sessionBudget(
  transport: McpTransport,
  timeoutMs: number,
  networkTimeoutMs: number,
): number {
  const cap = transport === 'stdio' ? STDIO_CONNECT_CAP : networkTimeoutMs;
  return Math.max(timeoutMs, Math.ceil(cap / 0.67) + 1_000);
}

export function hasOwnAuthorization(server: McpServer): boolean {
  return Object.keys(server.headers).some((key) => key.toLowerCase() === 'authorization');
}

/**
 * Отказ по авторизации: `UnauthorizedError` от SDK иногда прилетает завёрнутым,
 * поэтому идём по цепочке `cause` и в крайнем случае смотрим текст.
 *
 * Два ограничения, без которых догадка врала. Первое: у stdio авторизации нет
 * вовсе (кнопки «Авторизоваться» на карточке такого сервера тоже нет), а его
 * сообщение — это до 600 символов чужого stderr (`describeFailure` в
 * mcp-client.ts). Любая строка вроде «request failed with status 401» из лога
 * самого сервера подменяла настоящую причину советом войти через OAuth.
 * Второе: текст проверяем у КАЖДОГО звена цепочки по отдельности — у исходной
 * ошибки SDK, ещё без приклеенного к ней stderr.
 */
export function isUnauthorized(error: unknown, transport: McpTransport): boolean {
  if (transport === 'stdio') return false;

  // Потолок обхода — на случай ошибки, зациклившей сам себя через cause.
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    if (current instanceof UnauthorizedError) return true;

    const message = current instanceof Error ? current.message : String(current);
    if (/\b401\b|unauthorized/i.test(message)) return true;

    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
}

/**
 * Причина отказа словами для карточки. Отказ по авторизации объясняем прямо —
 * иначе пользователь видит «сервер не ответил на рукопожатие» и не понимает,
 * что делать. Но совет «нажмите Авторизоваться» верен только там, где своего
 * заголовка Authorization нет: если он настроен, 401 значит «токен отвергнут»,
 * и отправлять человека в OAuth — увести его от настоящей причины.
 */
export function failureDetail(error: unknown, server: McpServer): string {
  if (isUnauthorized(error, server.transport)) {
    return hasOwnAuthorization(server)
      ? serverText('mcp-auth-header-rejected')
      : serverText('mcp-oauth-needed');
  }
  const detail = error instanceof Error ? error.message : String(error);
  return detail.slice(0, 400);
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
  envLookup?: EnvLookup,
): Promise<HealthResult> {
  const checkedAt = new Date().toISOString();
  if (!server.isEnabled) return { health: 'disabled', checkedAt };

  try {
    const session = await openMcpSession(
      server,
      sessionBudget(server.transport, timeoutMs, networkTimeoutMs),
      authProvider,
      networkTimeoutMs,
      envLookup,
    );
    try {
      return { health: 'connected', toolCount: (await session.listTools()).length, checkedAt };
    } finally {
      await session.close();
    }
  } catch (error) {
    return { health: 'failed', detail: failureDetail(error, server), checkedAt };
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
  envLookup?: EnvLookup,
): Promise<McpToolsResult> {
  if (!server.isEnabled)
    return {
      tools: [],
      error: 'Сервер выключен — включите его, чтобы увидеть инструменты',
      messageCode: 'mcp-tools-server-disabled',
    };

  try {
    const session = await openMcpSession(
      server,
      sessionBudget(server.transport, timeoutMs, networkTimeoutMs),
      authProvider,
      networkTimeoutMs,
      envLookup,
    );
    try {
      const tools = await session.listTools();
      return { tools: tools.map((tool) => ({ name: tool.name, description: tool.description })) };
    } finally {
      await session.close();
    }
  } catch (error) {
    return { tools: [], error: failureDetail(error, server) };
  }
}
