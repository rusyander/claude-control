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
export type ProviderMcpFormat = 'json' | 'toml' | 'opencode-json';

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
    default:
      return readCodexServers(text).servers;
  }
}

/** Добавить или изменить сервер (при переименовании `serverId` — прежнее имя). */
export function upsertProviderMcpServer(
  target: ProviderMcpTarget,
  serverId: string | null,
  draft: UniversalMcpServerDraft,
  backupDir: string | undefined,
): string | undefined {
  switch (target.format) {
    case 'json':
      return upsertJsonMcpServer(target, serverId, draft, backupDir);
    case 'opencode-json':
      return upsertOpencodeServer(target, serverId, draft, backupDir);
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
    default:
      return deleteCodexServer(target, serverId, backupDir);
  }
}

// --- Формат `json`: ключ mcpServers (Gemini settings.json, Cursor mcp.json) ---

interface RawJsonMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  httpUrl?: string;
  headers?: Record<string, string>;
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

function readJsonMcpServers(text: string): UniversalMcpServer[] {
  const servers = parseJsonObject<RawJsonMcpConfig>(text).mcpServers ?? {};
  return Object.entries(servers)
    .map(([name, raw]): UniversalMcpServer => {
      // gemini: httpUrl (стримируемый HTTP) имеет приоритет над url (sse);
      // cursor хранит адрес удалённого сервера в url. В универсальной модели оба
      // сводятся к транспорту http — читаем оба ключа у обоих провайдеров.
      const httpAddress = raw.httpUrl ?? raw.url;
      const transport = httpAddress ? 'http' : 'stdio';
      return {
        name,
        transport,
        command: raw.command,
        args: raw.args ?? [],
        env: raw.env ?? {},
        url: httpAddress,
        headers: raw.headers ?? {},
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Собрать запись сервера формата `json` из черновика (только моделируемые поля). */
function buildJsonMcpRaw(
  draft: UniversalMcpServerDraft,
  httpUrlKey: 'httpUrl' | 'url',
): RawJsonMcpServer {
  const raw: RawJsonMcpServer = {};
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
  config.mcpServers ??= {};
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
      if (serverId && serverId !== draft.name) delete config.mcpServers![serverId];
      config.mcpServers![draft.name] = buildJsonMcpRaw(draft, target.jsonHttpUrlKey);
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

/** Собрать запись сервера codex из черновика (только моделируемые поля). */
function buildCodexRaw(draft: UniversalMcpServerDraft): RawCodexServer {
  const raw: RawCodexServer = {};
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
  if (serverId && serverId !== draft.name) delete raw[serverId];
  raw[draft.name] = buildCodexRaw(draft);
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
