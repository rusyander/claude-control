import type { UniversalMcpServer, UniversalMcpServerDraft } from '@claude-control/contracts';
import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import {
  isGooseMcpExtension,
  readGooseExtensions,
  writeGooseExtensions,
  type GooseRawExtension,
} from '../../lib/goose-yaml.ts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { GOOSE_MODELLED_KEYS, GOOSE_REMOTE_TYPES } from './constants.ts';
import { backupNameOf } from './target.ts';
import type { ProviderMcpTarget } from './types.ts';
import { isStringRecord, preserveUnmodelled, sortByName, stringList } from './values.ts';

// --- Goose (YAML: config.yaml, ОТОБРАЖЕНИЕ `extensions`) ---------------------

/**
 * Прочитать расширения-серверы. Встроенные расширения Goose (`builtin` и прочие
 * типы) в раздел НЕ попадают: это не внешние MCP-серверы, а части самого CLI —
 * показывать их как «серверы» значило бы предлагать пользователю их править.
 */
export function readGooseMcpServers(text: string): UniversalMcpServer[] {
  const servers: UniversalMcpServer[] = [];
  for (const [name, raw] of readGooseExtensions(text)) {
    if (!isGooseMcpExtension(raw)) continue;
    const isRemote = typeof raw.type === 'string' && GOOSE_REMOTE_TYPES.includes(raw.type);
    servers.push({
      name,
      transport: isRemote ? 'http' : 'stdio',
      command: typeof raw.cmd === 'string' ? raw.cmd : undefined,
      args: stringList(raw.args),
      env: isStringRecord(raw.envs) ? raw.envs : {},
      url: isRemote && typeof raw.uri === 'string' ? raw.uri : undefined,
      headers: isRemote && isStringRecord(raw.headers) ? raw.headers : {},
    });
  }
  return sortByName(servers);
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
  const preserved = preserveUnmodelled(existing, GOOSE_MODELLED_KEYS);
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

export function upsertGooseServer(
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

export function deleteGooseServer(
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
