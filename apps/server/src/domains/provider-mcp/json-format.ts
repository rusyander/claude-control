import type { UniversalMcpServer, UniversalMcpServerDraft } from '@claude-control/contracts';
import { parseProviderJsonObject } from '../../lib/provider-json.ts';
import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { JSON_MODELLED_KEYS } from './constants.ts';
import { backupNameOf } from './target.ts';
import type { ProviderMcpTarget } from './types.ts';
import { isStringRecord, preserveUnmodelled, sortByName, stringList } from './values.ts';

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

export function readJsonMcpServers(text: string): UniversalMcpServer[] {
  const servers = jsonMcpServersOf(parseProviderJsonObject<RawJsonMcpConfig>(text));
  return sortByName(
    Object.entries(servers).map(([name, entry]): UniversalMcpServer => {
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
        args: stringList(raw.args),
        env: isStringRecord(raw.env) ? raw.env : {},
        url: httpAddress,
        headers: isStringRecord(raw.headers) ? raw.headers : {},
      };
    }),
  );
}

/** Собрать запись сервера формата `json` из черновика, сохранив чужие поля прежней. */
function buildJsonMcpRaw(
  draft: UniversalMcpServerDraft,
  httpUrlKey: 'httpUrl' | 'url',
  existing?: RawJsonMcpServer,
): RawJsonMcpServer {
  const raw: RawJsonMcpServer = preserveUnmodelled(existing, JSON_MODELLED_KEYS);
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
  const config: RawJsonMcpConfig = text.trim()
    ? parseProviderJsonObject<RawJsonMcpConfig>(text)
    : {};
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

export function upsertJsonMcpServer(
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

export function deleteJsonMcpServer(
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
