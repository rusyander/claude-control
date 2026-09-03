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
import {
  openMcpSession,
  DEFAULT_NETWORK_TIMEOUT_MS,
  STDIO_CONNECT_CAP,
  type EnvLookup,
} from './mcp-client.ts';
import { hasOAuthTokens, renameOAuth } from './mcp-oauth.ts';

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
  /**
   * Чужие ключи записи (`disabled`, `timeout`, `alwaysAllow` других клиентов и
   * будущих версий Claude Code) — правка переносит их как есть, а не стирает.
   */
  [key: string]: unknown;
}

interface RawMcpConfig {
  mcpServers?: Record<string, RawMcpServer>;
  [key: string]: unknown;
}

/** Секция, куда приложение прячет выключенные серверы. Claude Code её игнорирует. */
const DISABLED_KEY = 'mcpServersDisabled';

/** Ключи записи, которые пишет сама панель; всё остальное в записи — чужое и сохраняется. */
const OWN_KEYS = new Set(['type', 'command', 'args', 'url', 'env', 'headers']);

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
  // Итог прошлой проверки связи — из состояния панели: карточка показывает его
  // сразу, а обзор по нему считает отвечающие и упавшие серверы.
  const lastChecks = store.getMcpHealth();

  const toServer = (name: string, raw: RawMcpServer, isEnabled: boolean): McpServer => {
    const transport = readTransport(raw);
    const last = isEnabled ? lastChecks[name] : undefined;
    return {
      id: name,
      name,
      transport,
      command: raw.command,
      args: raw.args ?? [],
      url: raw.url,
      env: raw.env ?? {},
      headers: raw.headers ?? {},
      health: isEnabled ? (last?.health ?? 'unknown') : 'disabled',
      healthDetail: last?.detail,
      checkedAt: last?.checkedAt,
      toolCount: last?.toolCount,
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

/*
 * Ошибки домена несут `statusCode` и `code`: их читает Fastify, так что любой
 * маршрут, который не перехватил ошибку сам (проектные MCP-серверы в
 * project-routes, перенос конфигурации между провайдерами), всё равно ответит
 * 400/404/409 с причиной, а не 500. Явные поля, а не parameter properties:
 * рантайм сервера читает TypeScript через strip-types, и тот их не поддерживает.
 */

/** Черновик не годится для записи; причина — человеку, маршрут отвечает 400. */
export class InvalidMcpDraftError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_mcp_draft';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidMcpDraftError';
  }
}

/** Сервера с таким именем нет ни среди включённых, ни среди выключенных — 404. */
export class McpServerNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'not_found';
  readonly serverName: string;

  constructor(serverName: string) {
    super(`MCP-сервера «${serverName}» нет в конфигурации.`);
    this.name = 'McpServerNotFoundError';
    this.serverName = serverName;
  }
}

/** Имя MCP-сервера уже занято — маршрут отвечает 409, а не пишет поверх чужой записи. */
export class McpServerExistsError extends Error {
  readonly statusCode = 409;
  readonly code = 'server_exists';
  readonly serverName: string;

  constructor(serverName: string) {
    super(`MCP-сервер «${serverName}» уже есть в конфигурации.`);
    this.name = 'McpServerExistsError';
    this.serverName = serverName;
  }
}

/**
 * Имя сервера — ключ в конфиге и половина права `mcp__<сервер>__<инструмент>`:
 * пробелы и косые черты ломают первое, двойное подчёркивание — второе.
 */
const NAME_PATTERN = /^[^\s/\\]+$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[^\s:]+$/;

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new InvalidMcpDraftError(`Поле ${field} должно быть списком строк.`);
  }
  return value as string[];
}

function stringRecord(value: unknown, field: string, keyPattern: RegExp): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidMcpDraftError(`Поле ${field} должно быть объектом «имя → строка».`);
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!keyPattern.test(key) || typeof item !== 'string') {
      throw new InvalidMcpDraftError(
        `Поле ${field}: имя «${key}» без пробелов и служебных символов, значение — строкой.`,
      );
    }
  }
  return value as Record<string, string>;
}

/**
 * Проверка черновика ДО записи. Тело приходит от формы, от пакетного импорта
 * JSON и от телефона, и до этого всё, что не упало пятисоткой, уезжало в
 * ~/.claude.json как есть: сервер без транспорта, stdio без команды, адрес
 * «not a url». Claude Code такую запись потом молча пропускает — и сервер
 * «не появляется» без единого слова о причине. Заодно нормализует
 * необязательные поля: `args`/`env`/`headers`/`groupIds` дальше читаются без
 * проверок на undefined.
 */
export function assertMcpDraft(
  draft: unknown,
  // `currentName` — имя правимого сервера. Запись, заведённая до правила имён
  // (пробел, `__` — `claude mcp add` их не запрещает), остаётся правимой под
  // своим именем: иначе ей нельзя было бы сменить даже адрес, не переименовав.
  // Новое имя проверяется как обычно.
  options?: { currentName?: string },
): asserts draft is McpServerDraft {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new InvalidMcpDraftError('Тело запроса должно быть объектом с описанием сервера.');
  }
  const body = draft as Record<string, unknown>;

  if (typeof body.name !== 'string' || body.name.trim() === '') {
    throw new InvalidMcpDraftError('Не указано имя MCP-сервера');
  }
  const name = body.name.trim();
  const keepsName = options?.currentName !== undefined && name === options.currentName;
  if (!keepsName && (!NAME_PATTERN.test(name) || name.includes('__'))) {
    throw new InvalidMcpDraftError(
      `Имя «${name}» не годится: без пробелов, косых черт и двойного подчёркивания — ` +
        'по нему строятся права вида mcp__сервер__инструмент.',
    );
  }
  body.name = name;

  const transport = TRANSPORTS.find((item) => item === body.transport);
  if (!transport) {
    throw new InvalidMcpDraftError(`Транспорт должен быть одним из: ${TRANSPORTS.join(', ')}.`);
  }

  if (transport === 'stdio') {
    if (typeof body.command !== 'string' || body.command.trim() === '') {
      throw new InvalidMcpDraftError('Для stdio нужна команда запуска.');
    }
    body.command = body.command.trim();
  } else {
    if (typeof body.url !== 'string' || body.url.trim() === '') {
      throw new InvalidMcpDraftError(`Для ${transport} нужен адрес сервера.`);
    }
    const url = body.url.trim();
    body.url = url;
    // Адрес со ссылкой ${VAR} разбирается только после подстановки — при проверке связи.
    if (!url.includes('${') && !isHttpUrl(url)) {
      throw new InvalidMcpDraftError(`Адрес «${url}» не разбирается как http(s)-URL.`);
    }
  }

  body.args = stringList(body.args, 'args');
  body.env = stringRecord(body.env, 'env', ENV_KEY_PATTERN);
  body.headers = stringRecord(body.headers, 'headers', HEADER_NAME_PATTERN);
  body.groupIds = stringList(body.groupIds, 'groupIds');
}

function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Есть ли сервер с таким именем в любой из двух секций; нет — McpServerNotFoundError. */
export function assertMcpServerExists(mcpConfigPath: string, serverId: string): void {
  const config = readJsonFile<RawMcpConfig>(mcpConfigPath, {});
  const disabled = config[DISABLED_KEY] as Record<string, RawMcpServer> | undefined;
  if (config.mcpServers?.[serverId] === undefined && disabled?.[serverId] === undefined) {
    throw new McpServerNotFoundError(serverId);
  }
}

/**
 * Добавить или изменить сервер (при переименовании `serverId` — прежнее имя).
 *
 * Создание с занятым именем и переименование в занятое — ОТКАЗ
 * (`McpServerExistsError` → 409), как у скиллов и у MCP чужих провайдеров.
 * Правка сервера, которого нет (удалён из другой вкладки) — ОТКАЗ
 * (`McpServerNotFoundError` → 404), а не создание под видом правки.
 * Осознанная замена (перенос конфигурации между провайдерами) передаёт
 * `allowOverwrite` явно и обходит обе проверки.
 */
export function saveMcpServer(
  mcpConfigPath: string,
  serverId: string | null,
  draft: McpServerDraft,
  backupDir?: string,
  // `backupName` — имя копии, когда basename не уникален (`.mcp.json` ПРОЕКТА):
  // иначе копии всех проектов делят одну ротацию (`projectBackupName`).
  options?: { allowOverwrite?: boolean; backupName?: string },
): string | undefined {
  // Проверяем здесь, а не только в маршруте: сюда же ведут проектный .mcp.json и
  // перенос между провайдерами, и все они писали в файл что угодно.
  assertMcpDraft(draft, { currentName: serverId ?? undefined });

  const config = readJsonFile<RawMcpConfig>(mcpConfigPath, {});
  config.mcpServers ??= {};
  const disabled = config[DISABLED_KEY] as Record<string, RawMcpServer> | undefined;

  const previous =
    serverId === null ? undefined : (config.mcpServers[serverId] ?? disabled?.[serverId]);
  if (serverId !== null && previous === undefined && !options?.allowOverwrite) {
    throw new McpServerNotFoundError(serverId);
  }

  // Занятое имя — отказ, а не запись поверх. Запись шла по имени безусловно:
  // «ctx7» из формы молча замещал настроенный «ctx7», а если тёзка лежал в
  // выключенных, имя оказывалось сразу в обеих секциях — список показывал одну
  // карточку, и первое же переключение уничтожало выключенный оригинал.
  // Проверяем ОБЕ секции: выключенный сервер занимает имя так же, как включённый.
  if (serverId !== draft.name && !options?.allowOverwrite) {
    const taken =
      config.mcpServers[draft.name] !== undefined || disabled?.[draft.name] !== undefined;
    if (taken) throw new McpServerExistsError(draft.name);
  }

  // В какую секцию класть результат правки. Кнопка «карандаш» есть и у
  // выключенной карточки, а раньше запись всегда уходила в mcpServers — правка
  // молча включала сервер обратно, и Claude Code снова его грузил. Признак
  // берём так же, как чтение: имя в обеих секциях считается включённым.
  const wasDisabled =
    serverId !== null &&
    disabled?.[serverId] !== undefined &&
    config.mcpServers[serverId] === undefined;

  // Переименование: убираем запись под старым именем из обеих секций. Только из
  // активной — мало: выключенный сервер остался бы вторым, «призрачным».
  if (serverId && serverId !== draft.name) {
    delete config.mcpServers[serverId];
    if (disabled) delete disabled[serverId];
  }

  // Чужие ключи прежней записи переезжают как есть: файл общий, и ключ,
  // которого панель не знает, — не мусор, а чьё-то рабочее поле.
  const raw: RawMcpServer = { type: draft.transport };
  for (const [key, value] of Object.entries(previous ?? {})) {
    if (!OWN_KEYS.has(key)) raw[key] = value;
  }
  if (draft.command) raw.command = draft.command;
  if (draft.args.length > 0) raw.args = draft.args;
  if (draft.url) raw.url = draft.url;
  if (Object.keys(draft.env).length > 0) raw.env = draft.env;
  if (Object.keys(draft.headers).length > 0) raw.headers = draft.headers;

  if (wasDisabled)
    ((config[DISABLED_KEY] as Record<string, RawMcpServer>) ??= {})[draft.name] = raw;
  else config.mcpServers[draft.name] = raw;

  return writeJsonFile(mcpConfigPath, config, { backupDir, backupName: options?.backupName });
}

/**
 * Перенос идентичности сервера при переименовании.
 *
 * Имя MCP-сервера — это его идентификатор, и по нему ключуется не только запись
 * в ~/.claude.json: в state.json по нему висят состав групп, отметка ручного
 * выключения и итог прошлой проверки связи, а в отдельном файле с правами 600 —
 * сохранённый OAuth-вход. Раньше правился только конфиг, поэтому после
 * переименования сервер выпадал из своих групп (группа продолжала гасить
 * несуществующий id), а токен оставался в mcp-oauth.json под мёртвым ключом —
 * пользователь заходил заново.
 *
 * Асинхронность — из-за очереди записи хранилища токенов: перенос обязан встать
 * в ту же цепочку, что и сохранение токена при обновлении.
 */
export async function migrateMcpServerIdentity(
  store: AppStore,
  appData: string | undefined,
  oldId: string,
  newId: string,
): Promise<void> {
  if (!oldId || !newId || oldId === newId) return;

  store.renameEntity('mcp', oldId, newId);
  if (appData !== undefined) await renameOAuth(appData, oldId, newId);
}

/**
 * Включение и выключение — перенос записи между двумя секциями файла.
 * Запись уже в нужной секции — ничего не пишем (повторный клик, гонка двух
 * вкладок); нет ни в одной — McpServerNotFoundError, а не тихий «ok».
 */
export function setMcpServerEnabled(
  mcpConfigPath: string,
  serverId: string,
  isEnabled: boolean,
  backupDir?: string,
  backupName?: string,
): string | undefined {
  const config = readJsonFile<RawMcpConfig>(mcpConfigPath, {});
  config.mcpServers ??= {};
  const disabled = ((config[DISABLED_KEY] as Record<string, RawMcpServer>) ??= {});

  const from = isEnabled ? disabled : config.mcpServers;
  const to = isEnabled ? config.mcpServers : disabled;
  const entry = from[serverId];
  if (!entry) {
    if (to[serverId] !== undefined) return undefined;
    throw new McpServerNotFoundError(serverId);
  }

  delete from[serverId];
  to[serverId] = entry;
  dropEmptyDisabledSection(config);
  return writeJsonFile(mcpConfigPath, config, { backupDir, backupName });
}

/**
 * Пустая секция отключённых — наш ключ в чужом файле. После «выключить → включить»
 * ~/.claude.json должен вернуться к прежнему виду байт в байт, иначе у пользователя
 * в файле, который правит сам Claude Code, остаётся `"mcpServersDisabled": {}`.
 */
function dropEmptyDisabledSection(config: RawMcpConfig): void {
  const disabled = config[DISABLED_KEY] as Record<string, unknown> | undefined;
  if (disabled !== undefined && Object.keys(disabled).length === 0) delete config[DISABLED_KEY];
}

/** Удаление из обеих секций; сервера нет — McpServerNotFoundError, файл не переписывается. */
export function deleteMcpServer(
  mcpConfigPath: string,
  serverId: string,
  backupDir?: string,
  backupName?: string,
): string | undefined {
  const config = readJsonFile<RawMcpConfig>(mcpConfigPath, {});
  const disabled = config[DISABLED_KEY] as Record<string, RawMcpServer> | undefined;
  if (config.mcpServers?.[serverId] === undefined && disabled?.[serverId] === undefined) {
    throw new McpServerNotFoundError(serverId);
  }

  delete config.mcpServers?.[serverId];
  delete disabled?.[serverId];
  dropEmptyDisabledSection(config);
  return writeJsonFile(mcpConfigPath, config, { backupDir, backupName });
}

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
function sessionBudget(
  transport: McpTransport,
  timeoutMs: number,
  networkTimeoutMs: number,
): number {
  const cap = transport === 'stdio' ? STDIO_CONNECT_CAP : networkTimeoutMs;
  return Math.max(timeoutMs, Math.ceil(cap / 0.67) + 1_000);
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
    return { tools: [], error: 'Сервер выключен — включите его, чтобы увидеть инструменты' };

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

/**
 * Причина отказа словами для карточки. Отказ по авторизации объясняем прямо —
 * иначе пользователь видит «сервер не ответил на рукопожатие» и не понимает,
 * что делать. Но совет «нажмите Авторизоваться» верен только там, где своего
 * заголовка Authorization нет: если он настроен, 401 значит «токен отвергнут»,
 * и отправлять человека в OAuth — увести его от настоящей причины.
 */
function failureDetail(error: unknown, server: McpServer): string {
  if (isUnauthorized(error, server.transport)) {
    return hasOwnAuthorization(server)
      ? 'Сервер отверг заголовок Authorization (401) — проверьте токен в заголовках'
      : 'Требуется авторизация OAuth — нажмите «Авторизоваться»';
  }
  const detail = error instanceof Error ? error.message : String(error);
  return detail.slice(0, 400);
}

function hasOwnAuthorization(server: McpServer): boolean {
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
function isUnauthorized(error: unknown, transport: McpTransport): boolean {
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
