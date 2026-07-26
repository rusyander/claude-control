import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';
import type {
  AppSettings,
  UniversalMcpServer,
  UniversalMcpServerDraft,
} from '@claude-control/contracts';
import { getActiveProvider } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { providerBackupName, readTextFile, writeTextFile } from '../lib/safe-io.ts';
import { parseProviderJsonObject } from '../lib/provider-json.ts';
import {
  UnrecognizedFormatError,
  parseCodexToml,
  stableToml,
  spliceCodexTableRegion,
} from '../lib/codex-toml.ts';
import {
  readContinueServers,
  writeContinueServers,
  type ContinueRawServer,
} from '../lib/continue-yaml.ts';
import {
  isGooseMcpExtension,
  readGooseExtensions,
  writeGooseExtensions,
  type GooseRawExtension,
} from '../lib/goose-yaml.ts';

// Переэкспорт для существующих потребителей (роуты/тесты импортируют его отсюда).
// Класс один и тот же (из lib) — `instanceof` работает в MCP- и env-разделах.
export { UnrecognizedFormatError };

/**
 * Универсальный раздел MCP-серверов — для провайдеров Gemini и Cursor (JSON,
 * ключ `mcpServers`), Codex (TOML) и OpenCode (JSON, ключ `mcp`, иная форма
 * записи). Claude сюда НЕ попадает: его MCP живёт в ~/.claude.json и
 * обслуживается собственными богатыми роутами (OAuth, tools, health, группы) —
 * тот раздел не трогаем. Роутинг «claude → /api/mcp, прочие → /api/provider-mcp»
 * делает клиент по активному провайдеру.
 *
 * БЕЗОПАСНОСТЬ ПРЕЖДЕ ВСЕГО. Чужой конфиг не разрушаем:
 *  - Gemini/Cursor (`json`): JSON.parse → меняем ТОЛЬКО ключ `mcpServers` (и
 *    только одну запись в нём) → JSON.stringify(2) → бэкап + атомарная запись.
 *    Прочие ключи файла и прочие серверы сохраняются как есть. Нет файла →
 *    создаём с одним `mcpServers`. Адрес http пишется в `httpUrl` (gemini) или
 *    `url` (cursor) — по `jsonHttpUrlKey` провайдера; чтение понимает оба.
 *  - OpenCode (`opencode-json`): то же самое, но ключ `mcp` и другая форма
 *    записи сервера: `{type:'local', command:[cmd,...args], environment}` или
 *    `{type:'remote', url, headers}`. Поле `enabled` и любые НЕизвестные поля
 *    сервера сохраняются при round-trip; прочие ключи файла ($schema, model,
 *    agents, …) не трогаются.
 *  - Codex (`toml`): чтение через smol-toml. ЗАПИСЬ ХИРУРГИЧЕСКАЯ — не через
 *    полный stringify всего файла: находим регион таблиц [mcp_servers...] в
 *    тексте, вырезаем его и вставляем заново сгенерированный блок mcp_servers;
 *    model, approval_policy, комментарии и прочие секции остаются байт-в-байт.
 *
 * FAIL-CLOSED: если файл не парсится, регион mcp_servers неоднозначен (не
 * непрерывен), или итог не репарсится/не совпадает с намерением — НЕ пишем,
 * бросаем `UnrecognizedFormatError` (раздел только для чтения). Никогда не пишем
 * наугад.
 */

interface ProviderMcpSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Формат файла MCP-конфигурации, поддержанный универсальным разделом. */
export type ProviderMcpFormat = 'json' | 'toml' | 'opencode-json' | 'continue-yaml' | 'goose-yaml';

/** Разрешённая цель раздела: провайдер + формат + путь к файлу. */
export interface ProviderMcpTarget {
  provider: ConfigProvider;
  format: ProviderMcpFormat;
  filePath: string;
  cliDetected: boolean;
  /** Формат `json`: ключ адреса http-сервера при ЗАПИСИ (`httpUrl` по умолчанию). */
  jsonHttpUrlKey: 'httpUrl' | 'url';
  /**
   * Имя резервной копии. По умолчанию — `<id>-<basename>` (глобальный файл
   * провайдера). Проектный уровень (COMMON-2) передаёт своё
   * (`<id>-project-<basename>`), чтобы копии проекта не делили ротацию с копиями
   * глобального конфига того же провайдера.
   */
  backupName?: string;
}

/** Имя копии для этой цели: своё, если задано, иначе стандартное `<id>-<basename>`. */
function backupNameOf(target: ProviderMcpTarget): string {
  return target.backupName ?? providerBackupName(target.provider.id, target.filePath);
}

/**
 * Цель универсального MCP-раздела активного провайдера — или `undefined`, если он
 * им не поддержан (маршрут ответит 4xx). Поддержан, только когда `mcp` = `ready`
 * И задан `mcpConfig` (Codex/Gemini/Cursor/OpenCode). Claude сюда не попадает (у
 * него нет `mcpConfig`) — он на своих роутах. Fail-closed.
 */
export function resolveProviderMcpTarget(
  store: ProviderMcpSettingsSource,
): ProviderMcpTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.mcp !== 'ready' || !provider.mcpConfig) return undefined;

  const filePath = provider.mcpConfig.path(store.getSettings().claudeDirOverride);
  return {
    provider,
    format: provider.mcpConfig.format,
    filePath,
    cliDetected: existsSync(dirname(filePath)),
    jsonHttpUrlKey: provider.mcpConfig.jsonHttpUrlKey ?? 'httpUrl',
  };
}

// --- Общий разбор черновика (валидация на стороне сервера) -------------------

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

/**
 * Разобрать и проверить черновик из тела запроса. Схему contracts (zod) в рантайме
 * сервера использовать нельзя (значение из contracts роняет node ESM), поэтому
 * проверяем руками. Некорректный черновик → `undefined` (маршрут ответит 400).
 */
export function parseUniversalDraft(body: unknown): UniversalMcpServerDraft | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return undefined;

  const transport = b.transport === 'http' ? 'http' : b.transport === 'stdio' ? 'stdio' : undefined;
  if (!transport) return undefined;

  const command = typeof b.command === 'string' ? b.command.trim() : undefined;
  const url = typeof b.url === 'string' ? b.url.trim() : undefined;
  if (transport === 'stdio' && !command) return undefined;
  if (transport === 'http' && !url) return undefined;

  const args = Array.isArray(b.args)
    ? b.args.filter((a): a is string => typeof a === 'string')
    : [];
  const env = isStringRecord(b.env) ? b.env : {};
  const headers = isStringRecord(b.headers) ? b.headers : {};

  return { name, transport, command, args, env, url, headers };
}

// --- Диспетчер по формату ----------------------------------------------------

/** Прочитать список серверов. Бросает `UnrecognizedFormatError`, если формат не распознан. */
export function readProviderMcpServers(target: ProviderMcpTarget): UniversalMcpServer[] {
  const text = readTextFile(target.filePath);
  if (!text.trim()) return [];
  switch (target.format) {
    case 'json':
      return readJsonMcpServers(text);
    case 'opencode-json':
      return readOpencodeServers(text);
    case 'continue-yaml':
      return readContinueMcpServers(text);
    case 'goose-yaml':
      return readGooseMcpServers(text);
    default:
      return readCodexServers(text).servers;
  }
}

/** Имя MCP-сервера уже занято — маршрут отвечает 409, а не пишет поверх чужой записи. */
export class McpServerExistsError extends Error {
  readonly serverName: string;

  constructor(serverName: string) {
    super(`MCP-сервер «${serverName}» уже есть в конфигурации.`);
    this.name = 'McpServerExistsError';
    this.serverName = serverName;
  }
}

/**
 * Добавить или изменить сервер (при переименовании `serverId` — прежнее имя).
 *
 * Создание с занятым именем и переименование в занятое имя — ОТКАЗ
 * (`McpServerExistsError` → 409), а не запись поверх: запись шла по имени
 * безусловно, и «github» из формы молча заменял настроенный «github» —
 * пользователь видел «сохранено», а прежняя команда/адрес исчезали. Осознанная
 * замена (перенос между провайдерами, самопроверка, предпросмотр) передаёт
 * `allowOverwrite` явно.
 */
export function upsertProviderMcpServer(
  target: ProviderMcpTarget,
  serverId: string | null,
  draft: UniversalMcpServerDraft,
  backupDir: string | undefined,
  options?: { allowOverwrite?: boolean },
): string | undefined {
  if (serverId !== draft.name && !options?.allowOverwrite) {
    // Список берём из того же файла тем же читателем — форма имени у каждого
    // формата своя (ключ отображения, `name` внутри записи у continue).
    const taken = readProviderMcpServers(target).some((server) => server.name === draft.name);
    if (taken) throw new McpServerExistsError(draft.name);
  }

  switch (target.format) {
    case 'json':
      return upsertJsonMcpServer(target, serverId, draft, backupDir);
    case 'opencode-json':
      return upsertOpencodeServer(target, serverId, draft, backupDir);
    case 'continue-yaml':
      return upsertContinueServer(target, serverId, draft, backupDir);
    case 'goose-yaml':
      return upsertGooseServer(target, serverId, draft, backupDir);
    default:
      return upsertCodexServer(target, serverId, draft, backupDir);
  }
}

/** Удалить сервер по имени. */
export function deleteProviderMcpServer(
  target: ProviderMcpTarget,
  serverId: string,
  backupDir: string | undefined,
): string | undefined {
  switch (target.format) {
    case 'json':
      return deleteJsonMcpServer(target, serverId, backupDir);
    case 'opencode-json':
      return deleteOpencodeServer(target, serverId, backupDir);
    case 'continue-yaml':
      return deleteContinueServer(target, serverId, backupDir);
    case 'goose-yaml':
      return deleteGooseServer(target, serverId, backupDir);
    default:
      return deleteCodexServer(target, serverId, backupDir);
  }
}

// --- Формат `json`: ключ mcpServers (Gemini settings.json, Cursor mcp.json) ---

/**
 * Запись сервера из чужого JSON. Значения намеренно `unknown`: файл написан
 * человеком, а не панелью, — форма (`command`, `args`, `env`, `url`, `httpUrl`,
 * `headers`) здесь лишь ожидание, каждое поле проверяется в рантайме.
 */
interface RawJsonMcpServer {
  [key: string]: unknown;
}

interface RawJsonMcpConfig {
  mcpServers?: Record<string, RawJsonMcpServer>;
  [key: string]: unknown;
}

/**
 * Разобрать JSON-конфиг (settings.json / mcp.json). Общий для всех разделов
 * разбор чужого JSON — `lib/provider-json.ts` (снятие BOM + fail-closed).
 */
const parseJsonObject = parseProviderJsonObject;

/** Ключ `mcpServers` как отображение «имя → запись». Не-объект → fail-closed. */
function jsonMcpServersOf(config: RawJsonMcpConfig): Record<string, unknown> {
  const servers: unknown = config.mcpServers;
  if (servers === undefined) return {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new UnrecognizedFormatError();
  }
  return servers as Record<string, unknown>;
}

/** Запись сервера, если она вообще объект; иначе пусто (чужую форму не гадаем). */
function asRawJsonServer(value: unknown): RawJsonMcpServer {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawJsonMcpServer)
    : {};
}

function readJsonMcpServers(text: string): UniversalMcpServer[] {
  const servers = jsonMcpServersOf(parseJsonObject<RawJsonMcpConfig>(text));
  return Object.entries(servers)
    .map(([name, entry]): UniversalMcpServer => {
      // Типы полей проверяем как остальные читатели файла (codex/continue/goose):
      // рукописный `"args": "-y pkg"` иначе уезжал бы в API строкой под видом
      // string[] и ронял страницу на `args.join(' ')` вместо пометки о формате.
      const raw = asRawJsonServer(entry);
      // gemini: httpUrl (стримируемый HTTP) имеет приоритет над url (sse);
      // cursor хранит адрес удалённого сервера в url. В универсальной модели оба
      // сводятся к транспорту http — читаем оба ключа у обоих провайдеров.
      const httpAddress =
        typeof raw.httpUrl === 'string'
          ? raw.httpUrl
          : typeof raw.url === 'string'
            ? raw.url
            : undefined;
      const transport = httpAddress ? 'http' : 'stdio';
      return {
        name,
        transport,
        command: typeof raw.command === 'string' ? raw.command : undefined,
        args: Array.isArray(raw.args)
          ? raw.args.filter((a): a is string => typeof a === 'string')
          : [],
        env: isStringRecord(raw.env) ? raw.env : {},
        url: httpAddress,
        headers: isStringRecord(raw.headers) ? raw.headers : {},
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Поля записи `json`, которые панель МОДЕЛИРУЕТ и пересобирает при записи. Всё
 * остальное (`cwd`, `enabled`, таймауты, фильтры инструментов — у Kimi они
 * задокументированы) переносится из прежней записи по значению.
 */
const JSON_MODELLED_KEYS = ['command', 'args', 'env', 'url', 'httpUrl', 'headers'];

/** Собрать запись сервера формата `json` из черновика, сохранив чужие поля прежней. */
function buildJsonMcpRaw(
  draft: UniversalMcpServerDraft,
  httpUrlKey: 'httpUrl' | 'url',
  existing?: RawJsonMcpServer,
): RawJsonMcpServer {
  const raw: RawJsonMcpServer = Object.fromEntries(
    Object.entries(existing ?? {}).filter(([key]) => !JSON_MODELLED_KEYS.includes(key)),
  );
  if (draft.transport === 'stdio') {
    if (draft.command) raw.command = draft.command;
    if (draft.args.length > 0) raw.args = draft.args;
    if (Object.keys(draft.env).length > 0) raw.env = draft.env;
  } else {
    // Ключ адреса задаёт провайдер: gemini — httpUrl, cursor — url.
    if (draft.url) raw[httpUrlKey] = draft.url;
    if (Object.keys(draft.headers).length > 0) raw.headers = draft.headers;
  }
  return raw;
}

/**
 * Записать JSON-конфиг, поменяв ТОЛЬКО одну запись в ключе mcpServers. Прочие
 * ключи и прочие серверы сохраняются как есть (JSON.parse → JSON.stringify(2)).
 */
function writeJsonMcpConfig(
  target: ProviderMcpTarget,
  mutate: (config: RawJsonMcpConfig) => void,
  backupDir: string | undefined,
): string | undefined {
  const text = readTextFile(target.filePath);
  const config: RawJsonMcpConfig = text.trim() ? parseJsonObject<RawJsonMcpConfig>(text) : {};
  // Форму `mcpServers` проверяем ДО правки: если там не отображение (строка,
  // массив), вписать в него одну запись значило бы испортить чужой файл →
  // fail-closed. Тот же объект возвращается по ссылке, чужие записи целы.
  config.mcpServers = jsonMcpServersOf(config) as Record<string, RawJsonMcpServer>;
  mutate(config);
  // preserveForm по умолчанию: файл пересобирается целиком из JSON.stringify (LF,
  // без BOM), поэтому его форму — BOM и CRLF пользователя — возвращает safe-io.
  return writeTextFile(target.filePath, `${JSON.stringify(config, null, 2)}\n`, {
    backupDir,
    backupName: backupNameOf(target),
  });
}

function upsertJsonMcpServer(
  target: ProviderMcpTarget,
  serverId: string | null,
  draft: UniversalMcpServerDraft,
  backupDir: string | undefined,
): string | undefined {
  return writeJsonMcpConfig(
    target,
    (config) => {
      // Чужие поля берём у ПРЕЖНЕЙ записи (при переименовании — у неё же);
      // если она не объект, переносить нечего (строку в поля не разбираем).
      const existing = asRawJsonServer(config.mcpServers![serverId ?? draft.name]);
      if (serverId && serverId !== draft.name) delete config.mcpServers![serverId];
      config.mcpServers![draft.name] = buildJsonMcpRaw(draft, target.jsonHttpUrlKey, existing);
    },
    backupDir,
  );
}

function deleteJsonMcpServer(
  target: ProviderMcpTarget,
  serverId: string,
  backupDir: string | undefined,
): string | undefined {
  return writeJsonMcpConfig(
    target,
    (config) => {
      delete config.mcpServers![serverId];
    },
    backupDir,
  );
}

// --- Формат `opencode-json`: ключ mcp в ~/.config/opencode/opencode.json -----

type RawOpencodeServer = Record<string, unknown>;

interface RawOpencodeConfig {
  mcp?: Record<string, RawOpencodeServer>;
  [key: string]: unknown;
}

/**
 * Поля записи сервера, которые панель МОДЕЛИРУЕТ и потому пересобирает при
 * записи. Всё остальное (`enabled` и любые неизвестные/будущие поля) переносится
 * из прежней записи как есть — round-trip ничего не теряет.
 */
const OPENCODE_MODELLED_KEYS = ['type', 'command', 'environment', 'url', 'headers'];

function readOpencodeServers(text: string): UniversalMcpServer[] {
  const servers = parseJsonObject<RawOpencodeConfig>(text).mcp ?? {};
  return Object.entries(servers)
    .map(([name, raw]): UniversalMcpServer => {
      const url = typeof raw.url === 'string' ? raw.url : undefined;
      // Транспорт определяется полем type; если оно нестандартное — опираемся на
      // наличие url (чтение неразрушающее, писать наугад мы всё равно не будем).
      const isRemote = raw.type === 'remote' || (raw.type !== 'local' && url !== undefined);
      // `command` у opencode — МАССИВ: [команда, ...аргументы].
      const commandLine = Array.isArray(raw.command)
        ? raw.command.filter((part): part is string => typeof part === 'string')
        : [];
      return {
        name,
        transport: isRemote ? 'http' : 'stdio',
        command: commandLine[0],
        args: commandLine.slice(1),
        env: isStringRecord(raw.environment) ? raw.environment : {},
        url: isRemote ? url : undefined,
        headers: isStringRecord(raw.headers) ? raw.headers : {},
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Собрать запись сервера opencode из черновика, СОХРАНИВ немоделируемые поля
 * прежней записи (`enabled` и любые неизвестные ключи).
 */
function buildOpencodeRaw(
  draft: UniversalMcpServerDraft,
  existing: RawOpencodeServer | undefined,
): RawOpencodeServer {
  const preserved = Object.fromEntries(
    Object.entries(existing ?? {}).filter(([key]) => !OPENCODE_MODELLED_KEYS.includes(key)),
  );

  const raw: RawOpencodeServer = {};
  if (draft.transport === 'stdio') {
    raw.type = 'local';
    // command — массив: первый элемент команда, остальные аргументы.
    if (draft.command) raw.command = [draft.command, ...draft.args];
    if (Object.keys(draft.env).length > 0) raw.environment = draft.env;
  } else {
    raw.type = 'remote';
    if (draft.url) raw.url = draft.url;
    if (Object.keys(draft.headers).length > 0) raw.headers = draft.headers;
  }
  return { ...raw, ...preserved };
}

/**
 * Записать opencode.json, поменяв ТОЛЬКО одну запись в ключе `mcp`. Прочие ключи
 * файла (`$schema`, model, agents, …) и прочие серверы сохраняются как есть.
 */
function writeOpencodeConfig(
  target: ProviderMcpTarget,
  mutate: (config: RawOpencodeConfig) => void,
  backupDir: string | undefined,
): string | undefined {
  const text = readTextFile(target.filePath);
  const config: RawOpencodeConfig = text.trim() ? parseJsonObject<RawOpencodeConfig>(text) : {};
  config.mcp ??= {};
  mutate(config);
  return writeTextFile(target.filePath, `${JSON.stringify(config, null, 2)}\n`, {
    backupDir,
    backupName: backupNameOf(target),
  });
}

function upsertOpencodeServer(
  target: ProviderMcpTarget,
  serverId: string | null,
  draft: UniversalMcpServerDraft,
  backupDir: string | undefined,
): string | undefined {
  return writeOpencodeConfig(
    target,
    (config) => {
      const servers = config.mcp!;
      // При переименовании немоделируемые поля переносим со СТАРОГО имени.
      const existing = (serverId ? servers[serverId] : undefined) ?? servers[draft.name];
      if (serverId && serverId !== draft.name) delete servers[serverId];
      servers[draft.name] = buildOpencodeRaw(draft, existing);
    },
    backupDir,
  );
}

function deleteOpencodeServer(
  target: ProviderMcpTarget,
  serverId: string,
  backupDir: string | undefined,
): string | undefined {
  return writeOpencodeConfig(
    target,
    (config) => {
      delete config.mcp![serverId];
    },
    backupDir,
  );
}

// --- Codex (TOML: ~/.codex/config.toml, таблицы [mcp_servers.<name>]) --------

type RawCodexServer = Record<string, unknown>;

interface CodexReadResult {
  servers: UniversalMcpServer[];
  /** Сырые записи mcp_servers как их разобрал smol-toml — для сохранения чужих полей. */
  raw: Record<string, RawCodexServer>;
}

/** Разобрать config.toml. Невалидный TOML → fail-closed (read-only). */
function parseCodexRaw(text: string): Record<string, RawCodexServer> {
  const parsed = parseCodexToml(text);
  const servers = parsed.mcp_servers;
  if (servers === undefined) return {};
  if (typeof servers !== 'object' || Array.isArray(servers)) {
    throw new UnrecognizedFormatError();
  }
  return servers as Record<string, RawCodexServer>;
}

function readCodexServers(text: string): CodexReadResult {
  const raw = parseCodexRaw(text);
  const servers = Object.entries(raw)
    .map(([name, entry]): UniversalMcpServer => {
      const url = typeof entry.url === 'string' ? entry.url : undefined;
      const transport = url ? 'http' : 'stdio';
      return {
        name,
        transport,
        command: typeof entry.command === 'string' ? entry.command : undefined,
        args: Array.isArray(entry.args)
          ? entry.args.filter((a): a is string => typeof a === 'string')
          : [],
        env: isStringRecord(entry.env) ? entry.env : {},
        url,
        // codex хранит заголовки http под http_headers.
        headers: isStringRecord(entry.http_headers) ? entry.http_headers : {},
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { servers, raw };
}

/**
 * Поля записи codex, которые панель МОДЕЛИРУЕТ и пересобирает при записи. Всё
 * остальное (`startup_timeout_sec`, `tool_timeout_sec`, `enabled`, `env_vars` и
 * любые будущие ключи) переносится из прежней записи по значению.
 */
const CODEX_MODELLED_KEYS = ['command', 'args', 'env', 'url', 'http_headers'];

/** Собрать запись сервера codex из черновика, сохранив чужие поля прежней. */
function buildCodexRaw(draft: UniversalMcpServerDraft, existing?: RawCodexServer): RawCodexServer {
  const raw: RawCodexServer = Object.fromEntries(
    Object.entries(existing ?? {}).filter(([key]) => !CODEX_MODELLED_KEYS.includes(key)),
  );
  if (draft.transport === 'stdio') {
    if (draft.command) raw.command = draft.command;
    if (draft.args.length > 0) raw.args = draft.args;
    if (Object.keys(draft.env).length > 0) raw.env = draft.env;
  } else {
    // codex: untagged-транспорт определяется наличием url (без ключа transport);
    // для http env запрещён, заголовки идут в http_headers.
    if (draft.url) raw.url = draft.url;
    if (Object.keys(draft.headers).length > 0) raw.http_headers = draft.headers;
  }
  return raw;
}

/**
 * Записать config.toml с новым набором серверов. Хирургически заменяет регион
 * mcp_servers; чужие поля существующих серверов сохраняются (проходят через
 * разобранные raw-записи). После сборки итог репарсится и сверяется с намерением
 * — расхождение → fail-closed (не пишем).
 */
function writeCodexServers(
  target: ProviderMcpTarget,
  raw: Record<string, RawCodexServer>,
  backupDir: string | undefined,
): string | undefined {
  const exists = existsSync(target.filePath);
  const original = exists ? readFileSync(target.filePath, 'utf8') : '';

  // Оригинал обязан парситься — иначе не знаем, где регион (fail-closed).
  if (original.trim()) parseCodexToml(original);

  const hasServers = Object.keys(raw).length > 0;
  const block = hasServers ? stringifyToml({ mcp_servers: raw }) : '';

  let next: string;
  if (!original.trim()) {
    next = hasServers ? `${block.replace(/\n+$/, '')}\n` : '';
  } else {
    next = spliceCodexTableRegion(original, block, 'mcp_servers');
  }

  // Верификация: итог обязан валидно репарситься, а его mcp_servers — точно
  // совпадать с намерением. Иначе surgery что-то испортила → не пишем.
  if (next.trim()) {
    const reparsed = parseCodexToml(next);
    const got = reparsed.mcp_servers ?? {};
    if (stableToml(got) !== stableToml(raw)) throw new UnrecognizedFormatError();
  } else if (hasServers) {
    throw new UnrecognizedFormatError();
  }

  // preserveForm:false — итог собран ИЗ ИСХОДНОГО текста (всё вне региона
  // байт-в-байт, BOM исходника на месте, стиль переводов строк учтён в splice).
  // Общая нормализация здесь как раз нарушила бы байт-в-байт на файле со
  // смешанными окончаниями строк.
  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
    preserveForm: false,
  });
}

function upsertCodexServer(
  target: ProviderMcpTarget,
  serverId: string | null,
  draft: UniversalMcpServerDraft,
  backupDir: string | undefined,
): string | undefined {
  const text = readTextFile(target.filePath);
  const raw = text.trim() ? parseCodexRaw(text) : {};
  // При переименовании немоделируемые поля переносим со СТАРОГО имени.
  const existing = (serverId ? raw[serverId] : undefined) ?? raw[draft.name];
  if (serverId && serverId !== draft.name) delete raw[serverId];
  raw[draft.name] = buildCodexRaw(draft, existing);
  return writeCodexServers(target, raw, backupDir);
}

function deleteCodexServer(
  target: ProviderMcpTarget,
  serverId: string,
  backupDir: string | undefined,
): string | undefined {
  const text = readTextFile(target.filePath);
  const raw = text.trim() ? parseCodexRaw(text) : {};
  delete raw[serverId];
  return writeCodexServers(target, raw, backupDir);
}

// --- Continue (YAML: ~/.continue/config.yaml, СПИСОК `mcpServers`) -----------

/**
 * Поля записи, которые панель МОДЕЛИРУЕТ и пересобирает при записи. Всё
 * остальное (`cwd`, `connectionTimeout`, `apiKey`, любые будущие поля)
 * переносится из прежней записи по значению — round-trip ничего не теряет.
 * `requestOptions` в списке потому, что панель ведёт его подключ `headers`;
 * прочие подключи сохраняются отдельно (см. `buildContinueRaw`).
 */
const CONTINUE_MODELLED_KEYS = ['name', 'type', 'command', 'args', 'env', 'url', 'requestOptions'];

/** Задокументированные удалённые транспорты Continue (у остальных — stdio). */
const CONTINUE_REMOTE_TYPES = ['sse', 'streamable-http'];

/** Заголовки удалённого сервера Continue живут в `requestOptions.headers`. */
function continueHeaders(raw: ContinueRawServer): Record<string, string> {
  const options = raw.requestOptions;
  if (!options || typeof options !== 'object' || Array.isArray(options)) return {};
  const headers = (options as Record<string, unknown>).headers;
  return isStringRecord(headers) ? headers : {};
}

function readContinueMcpServers(text: string): UniversalMcpServer[] {
  return readContinueServers(text)
    .map((raw): UniversalMcpServer => {
      const url = typeof raw.url === 'string' ? raw.url : undefined;
      // Транспорт задаёт `type`; если его нет — опираемся на наличие url
      // (чтение неразрушающее, писать наугад мы всё равно не будем).
      const isRemote =
        (typeof raw.type === 'string' && CONTINUE_REMOTE_TYPES.includes(raw.type)) ||
        (raw.type === undefined && url !== undefined);
      return {
        name: String(raw.name),
        transport: isRemote ? 'http' : 'stdio',
        command: typeof raw.command === 'string' ? raw.command : undefined,
        args: Array.isArray(raw.args)
          ? raw.args.filter((a): a is string => typeof a === 'string')
          : [],
        env: isStringRecord(raw.env) ? raw.env : {},
        url: isRemote ? url : undefined,
        headers: continueHeaders(raw),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Собрать запись Continue из черновика, СОХРАНИВ немоделируемые поля прежней
 * записи и прочие подключи `requestOptions`. Тип удалённого сервера берётся у
 * прежней записи (`sse` пользователя не переписываем на другой), а для новой —
 * `streamable-http`: именно он в документации основной, `sse` помечен устаревающим.
 */
function buildContinueRaw(
  draft: UniversalMcpServerDraft,
  existing: ContinueRawServer | undefined,
): ContinueRawServer {
  const preserved = Object.fromEntries(
    Object.entries(existing ?? {}).filter(([key]) => !CONTINUE_MODELLED_KEYS.includes(key)),
  );

  const raw: ContinueRawServer = { name: draft.name };
  if (draft.transport === 'stdio') {
    raw.type = 'stdio';
    if (draft.command) raw.command = draft.command;
    if (draft.args.length > 0) raw.args = draft.args;
    if (Object.keys(draft.env).length > 0) raw.env = draft.env;
  } else {
    const previousType = typeof existing?.type === 'string' ? existing.type : undefined;
    raw.type =
      previousType && CONTINUE_REMOTE_TYPES.includes(previousType)
        ? previousType
        : 'streamable-http';
    if (draft.url) raw.url = draft.url;

    // Прочие подключи requestOptions (таймауты, прокси, сертификаты) целы.
    const options = existing?.requestOptions;
    const restOptions =
      options && typeof options === 'object' && !Array.isArray(options)
        ? Object.fromEntries(
            Object.entries(options as Record<string, unknown>).filter(([key]) => key !== 'headers'),
          )
        : {};
    const hasHeaders = Object.keys(draft.headers).length > 0;
    if (hasHeaders || Object.keys(restOptions).length > 0) {
      raw.requestOptions = {
        ...restOptions,
        ...(hasHeaders ? { headers: draft.headers } : {}),
      };
    }
  }

  return { ...raw, ...preserved };
}

/**
 * Записать config.yaml, поменяв ТОЛЬКО список `mcpServers`. Прочие ключи файла
 * (models, rules, context, …) и комментарии вне блока сохраняются — правка идёт
 * Document API пакета `yaml` (см. lib/continue-yaml.ts).
 */
function writeContinueConfig(
  target: ProviderMcpTarget,
  mutate: (servers: ContinueRawServer[]) => void,
  backupDir: string | undefined,
): string | undefined {
  const text = readTextFile(target.filePath);
  const servers = text.trim() ? readContinueServers(text) : [];
  mutate(servers);
  return writeTextFile(target.filePath, writeContinueServers(text, servers), {
    backupDir,
    backupName: backupNameOf(target),
  });
}

function upsertContinueServer(
  target: ProviderMcpTarget,
  serverId: string | null,
  draft: UniversalMcpServerDraft,
  backupDir: string | undefined,
): string | undefined {
  return writeContinueConfig(
    target,
    (servers) => {
      // Имя записи лежит ВНУТРИ неё, поэтому и поиск, и переименование — по полю
      // `name`. Порядок записей значим для пользователя: правим на месте.
      const index = servers.findIndex((item) => item.name === (serverId ?? draft.name));
      const existing = index >= 0 ? servers[index] : undefined;
      const next = buildContinueRaw(draft, existing);
      if (index >= 0) servers[index] = next;
      else servers.push(next);
      // Переименование в имя, которое уже занято другой записью: одноимённых в
      // списке быть не должно (иначе запись не адресуема) — прежняя уходит.
      for (let i = servers.length - 1; i >= 0; i -= 1) {
        if (i !== servers.indexOf(next) && servers[i]!.name === draft.name) servers.splice(i, 1);
      }
    },
    backupDir,
  );
}

function deleteContinueServer(
  target: ProviderMcpTarget,
  serverId: string,
  backupDir: string | undefined,
): string | undefined {
  return writeContinueConfig(
    target,
    (servers) => {
      const index = servers.findIndex((item) => item.name === serverId);
      if (index >= 0) servers.splice(index, 1);
    },
    backupDir,
  );
}

// --- Goose (YAML: config.yaml, ОТОБРАЖЕНИЕ `extensions`) ---------------------

/**
 * Поля записи, которые панель МОДЕЛИРУЕТ и пересобирает при записи. Всё
 * остальное (`description`, `bundled`, `timeout`, `cwd`, `env_keys`,
 * `available_tools`, любые будущие) переносится из прежней записи по значению —
 * round-trip ничего не теряет. `enabled` в списке потому, что панель его
 * ВЫСТАВЛЯЕТ у новой записи (иначе Goose расширение не поднимет), но у
 * существующей сохраняет как было.
 */
const GOOSE_MODELLED_KEYS = ['type', 'name', 'cmd', 'args', 'envs', 'uri', 'headers'];

/** Задокументированные удалённые транспорты Goose (у остальных — stdio). */
const GOOSE_REMOTE_TYPES = ['sse', 'streamable_http'];

/**
 * Прочитать расширения-серверы. Встроенные расширения Goose (`builtin` и прочие
 * типы) в раздел НЕ попадают: это не внешние MCP-серверы, а части самого CLI —
 * показывать их как «серверы» значило бы предлагать пользователю их править.
 */
function readGooseMcpServers(text: string): UniversalMcpServer[] {
  const servers: UniversalMcpServer[] = [];
  for (const [name, raw] of readGooseExtensions(text)) {
    if (!isGooseMcpExtension(raw)) continue;
    const isRemote = typeof raw.type === 'string' && GOOSE_REMOTE_TYPES.includes(raw.type);
    servers.push({
      name,
      transport: isRemote ? 'http' : 'stdio',
      command: typeof raw.cmd === 'string' ? raw.cmd : undefined,
      args: Array.isArray(raw.args)
        ? raw.args.filter((a): a is string => typeof a === 'string')
        : [],
      env: isStringRecord(raw.envs) ? raw.envs : {},
      url: isRemote && typeof raw.uri === 'string' ? raw.uri : undefined,
      headers: isRemote && isStringRecord(raw.headers) ? raw.headers : {},
    });
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Собрать запись Goose из черновика, СОХРАНИВ немоделируемые поля прежней. Тип
 * удалённого сервера берётся у прежней записи (`sse` пользователя не
 * переписываем), у новой — `streamable_http`: именно он в документации основной.
 * `enabled: true` пишется только НОВОЙ записи — выключенное расширение Goose не
 * поднимет, а чужой выбор `enabled: false` панель не отменяет.
 */
function buildGooseRaw(
  draft: UniversalMcpServerDraft,
  existing: GooseRawExtension | undefined,
): GooseRawExtension {
  const preserved = Object.fromEntries(
    Object.entries(existing ?? {}).filter(([key]) => !GOOSE_MODELLED_KEYS.includes(key)),
  );
  if (!existing) preserved.enabled = true;

  // Имя записи Goose дублируется полем `name` внутри неё — держим их согласованными.
  const raw: GooseRawExtension = { type: 'stdio', name: draft.name };
  if (draft.transport === 'stdio') {
    if (draft.command) raw.cmd = draft.command;
    if (draft.args.length > 0) raw.args = draft.args;
    if (Object.keys(draft.env).length > 0) raw.envs = draft.env;
  } else {
    const previousType = typeof existing?.type === 'string' ? existing.type : undefined;
    raw.type =
      previousType && GOOSE_REMOTE_TYPES.includes(previousType) ? previousType : 'streamable_http';
    if (draft.url) raw.uri = draft.url;
    if (Object.keys(draft.headers).length > 0) raw.headers = draft.headers;
  }

  return { ...raw, ...preserved };
}

/**
 * Записать config.yaml, поменяв ТОЛЬКО блок `extensions`. Прочие ключи файла
 * (GOOSE_PROVIDER, GOOSE_MODE, модели, …) и комментарии вне блока сохраняются.
 */
function writeGooseConfig(
  target: ProviderMcpTarget,
  mutate: (extensions: Map<string, GooseRawExtension>) => void,
  backupDir: string | undefined,
): string | undefined {
  const text = readTextFile(target.filePath);
  const extensions = text.trim() ? readGooseExtensions(text) : new Map<string, GooseRawExtension>();
  mutate(extensions);
  return writeTextFile(target.filePath, writeGooseExtensions(text, extensions), {
    backupDir,
    backupName: backupNameOf(target),
  });
}

/**
 * Записать поверх ВСТРОЕННОГО расширения (`developer`, `memory`, …) панель не
 * даст: это не внешний сервер, а часть самого Goose, и его форму мы не ведём.
 */
function assertGooseEditable(
  extensions: Map<string, GooseRawExtension>,
  name: string | undefined,
): void {
  if (!name) return;
  const existing = extensions.get(name);
  if (existing && !isGooseMcpExtension(existing)) throw new UnrecognizedFormatError();
}

function upsertGooseServer(
  target: ProviderMcpTarget,
  serverId: string | null,
  draft: UniversalMcpServerDraft,
  backupDir: string | undefined,
): string | undefined {
  return writeGooseConfig(
    target,
    (extensions) => {
      // И прежнее имя (правка/переименование), и новое (не затереть встроенное).
      assertGooseEditable(extensions, serverId ?? undefined);
      assertGooseEditable(extensions, draft.name);

      const previousName = serverId ?? draft.name;
      const existing = extensions.get(previousName);
      const next = buildGooseRaw(draft, existing);

      // Порядок расширений в файле значим для пользователя: при переименовании
      // запись остаётся на своём месте, а не уезжает в конец блока.
      if (existing && previousName !== draft.name) {
        const rebuilt = new Map<string, GooseRawExtension>();
        for (const [key, value] of extensions) {
          if (key === previousName) rebuilt.set(draft.name, next);
          else if (key !== draft.name) rebuilt.set(key, value);
        }
        extensions.clear();
        for (const [key, value] of rebuilt) extensions.set(key, value);
        return;
      }
      extensions.set(draft.name, next);
    },
    backupDir,
  );
}

function deleteGooseServer(
  target: ProviderMcpTarget,
  serverId: string,
  backupDir: string | undefined,
): string | undefined {
  return writeGooseConfig(
    target,
    (extensions) => {
      assertGooseEditable(extensions, serverId);
      extensions.delete(serverId);
    },
    backupDir,
  );
}
