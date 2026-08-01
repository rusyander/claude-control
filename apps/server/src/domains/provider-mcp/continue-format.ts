import type { UniversalMcpServer, UniversalMcpServerDraft } from '@claude-control/contracts';
import {
  readContinueServers,
  writeContinueServers,
  type ContinueRawServer,
} from '../../lib/continue-yaml.ts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { CONTINUE_MODELLED_KEYS, CONTINUE_REMOTE_TYPES } from './constants.ts';
import { backupNameOf, blockBackupNameOf } from './target.ts';
import type { ProviderMcpTarget } from './types.ts';
import { isStringRecord, preserveUnmodelled, sortByName, stringList } from './values.ts';

// --- Continue (YAML: ~/.continue/config.yaml, СПИСОК `mcpServers`) -----------

/** Заголовки удалённого сервера Continue живут в `requestOptions.headers`. */
function continueHeaders(raw: ContinueRawServer): Record<string, string> {
  const options = raw.requestOptions;
  if (!options || typeof options !== 'object' || Array.isArray(options)) return {};
  const headers = (options as Record<string, unknown>).headers;
  return isStringRecord(headers) ? headers : {};
}

/**
 * Записи Continue → универсальная модель. Вынесено из чтения файла: ровно те же
 * записи приходят из файлов-блоков (`blocks.ts`), и разбирать их вторым,
 * отдельным кодом значило бы завести второе поведение на один формат.
 */
export function mapContinueServers(raw: ContinueRawServer[]): UniversalMcpServer[] {
  return sortByName(
    raw.map((raw): UniversalMcpServer => {
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
        args: stringList(raw.args),
        env: isStringRecord(raw.env) ? raw.env : {},
        url: isRemote ? url : undefined,
        headers: continueHeaders(raw),
      };
    }),
  );
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
  const preserved = preserveUnmodelled(existing, CONTINUE_MODELLED_KEYS);

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
 * Правка списка `mcpServers` одного файла Continue: основного конфига или
 * файла-блока — форма списка у них одна. Прочие ключи файла (models, rules,
 * context, шапка блока) и комментарии вне списка сохраняются: правка идёт
 * Document API пакета `yaml` (см. lib/continue-yaml.ts).
 */
function writeContinueFile(
  filePath: string,
  backupName: string,
  mutate: (servers: ContinueRawServer[]) => void,
  backupDir: string | undefined,
): string | undefined {
  const text = readTextFile(filePath);
  const servers = text.trim() ? readContinueServers(text) : [];
  mutate(servers);
  return writeTextFile(filePath, writeContinueServers(text, servers), { backupDir, backupName });
}

/** Записать основной config.yaml, поменяв ТОЛЬКО список `mcpServers`. */
function writeContinueConfig(
  target: ProviderMcpTarget,
  mutate: (servers: ContinueRawServer[]) => void,
  backupDir: string | undefined,
): string | undefined {
  return writeContinueFile(target.filePath, backupNameOf(target), mutate, backupDir);
}

/**
 * Правка одного файла-блока: меняется ТОЛЬКО его список `mcpServers`, шапка
 * блока (`name` / `version` / `schema`) и комментарии вне списка целы.
 *
 * Опустевший блок не удаляем: файл написан человеком (или самим Continue), и
 * снести его молча — потеря, которую нечем откатить в интерфейсе. Ключ
 * `mcpServers` при этом уходит, остаётся шапка — вернуть в неё сервер можно
 * руками, а панель такой файл покажет пустым.
 */
export function writeContinueBlock(
  target: ProviderMcpTarget,
  blockPath: string,
  mutate: (servers: ContinueRawServer[]) => void,
  backupDir: string | undefined,
): string | undefined {
  return writeContinueFile(blockPath, blockBackupNameOf(target, blockPath), mutate, backupDir);
}

/**
 * Вписать запись в список Continue — на месте. Один и тот же список приходит из
 * `config.yaml` и из файла-блока, форма у них одна.
 */
export function upsertContinueEntry(
  servers: ContinueRawServer[],
  serverId: string | null,
  draft: UniversalMcpServerDraft,
): void {
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
}

/** Убрать запись из списка Continue — на месте. Нет такой → список не меняется. */
export function removeContinueEntry(servers: ContinueRawServer[], serverId: string): void {
  const index = servers.findIndex((item) => item.name === serverId);
  if (index >= 0) servers.splice(index, 1);
}

export function upsertContinueServer(
  target: ProviderMcpTarget,
  serverId: string | null,
  draft: UniversalMcpServerDraft,
  backupDir: string | undefined,
): string | undefined {
  return writeContinueConfig(
    target,
    (servers) => upsertContinueEntry(servers, serverId, draft),
    backupDir,
  );
}

export function deleteContinueServer(
  target: ProviderMcpTarget,
  serverId: string,
  backupDir: string | undefined,
): string | undefined {
  return writeContinueConfig(
    target,
    (servers) => removeContinueEntry(servers, serverId),
    backupDir,
  );
}
