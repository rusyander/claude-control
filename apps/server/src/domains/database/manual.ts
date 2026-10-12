import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { normalizeProjectPath } from '../../lib/app-store/projects.ts';
import {
  clearStoredKey,
  getStoredKey,
  setStoredKey,
} from '../../lib/provider-keys/provider-keys.ts';
import { readJsonFile, writeJsonFile } from '../../lib/safe-io/safe-io.ts';
import type { ResolvedConnection } from './database.types.ts';
import { isLoopbackHost } from './sources/url.ts';

/**
 * Свои подключения человека — к базе, которую в файлах проекта не найти
 * (общий стенд, база в другом репозитории). Реквизиты без пароля лежат в
 * `db-connections.json` в каталоге данных панели, пароль — зашифрованным в
 * хранилище ключей (`lib/provider-keys`), как ключи провайдеров. Наружу пароль
 * не уходит никогда: ни в ответ API, ни в файл.
 *
 * Отдельный файл, а не `state.json`: снимок состояния уходит в бэкапы и перенос
 * окружения, а адрес чужой базы там не нужен.
 */

const FILE = 'db-connections.json';

interface ManualRecord {
  id: string;
  label: string;
  host: string;
  port: number;
  database: string;
  user: string;
}

type ManualFile = Record<string, ManualRecord[]>;

export interface ManualDraft {
  id?: string;
  label: string;
  host: string;
  port: number;
  database: string;
  user: string;
  /** Пусто или не задан — оставить прежний пароль. */
  password?: string;
}

export class ManualConnectionNotFoundError extends Error {}

const keyOf = (project: string, id: string): string => `db:${project}:${id}`;

function readFile(appData: string): ManualFile {
  try {
    const data = readJsonFile<ManualFile>(join(appData, FILE), {});
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function readPassword(appData: string, project: string, id: string): string | undefined {
  const raw = getStoredKey(appData, keyOf(project, id));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { password?: unknown };
    return typeof parsed.password === 'string' ? parsed.password : undefined;
  } catch {
    return undefined;
  }
}

export function listManualConnections(appData: string, projectPath: string): ResolvedConnection[] {
  const project = normalizeProjectPath(projectPath);
  return (readFile(appData)[project] ?? []).map((record) => {
    const password = readPassword(appData, project, record.id);
    return {
      info: {
        id: `manual:${record.id}`,
        source: 'manual',
        engine: 'postgres',
        label: record.label,
        host: record.host,
        port: record.port,
        database: record.database,
        user: record.user,
        hasPassword: Boolean(password),
        origin: 'manual',
        remote: !isLoopbackHost(record.host),
      },
      ...(password ? { password } : {}),
    };
  });
}

/** Завести или поправить. Возвращает id подключения (`manual:<uuid>`). */
export function saveManualConnection(
  appData: string,
  projectPath: string,
  draft: ManualDraft,
): string {
  const project = normalizeProjectPath(projectPath);
  const file = readFile(appData);
  const list = file[project] ?? [];
  const ownId = draft.id?.replace(/^manual:/, '');
  if (ownId && !list.some((record) => record.id === ownId))
    throw new ManualConnectionNotFoundError();
  const id = ownId ?? randomUUID();
  const record: ManualRecord = {
    id,
    label: draft.label,
    host: draft.host,
    port: draft.port,
    database: draft.database,
    user: draft.user,
  };
  file[project] = ownId ? list.map((item) => (item.id === id ? record : item)) : [...list, record];
  // Сначала пароль, потом реквизиты: упади запись между ними — останется
  // подключение без пароля, а не пароль без подключения.
  if (draft.password)
    setStoredKey(appData, keyOf(project, id), JSON.stringify({ password: draft.password }));
  writeJsonFile(join(appData, FILE), file, { preserveForm: false });
  return `manual:${id}`;
}

export function removeManualConnection(
  appData: string,
  projectPath: string,
  connectionId: string,
): void {
  const project = normalizeProjectPath(projectPath);
  const id = connectionId.replace(/^manual:/, '');
  const file = readFile(appData);
  const list = file[project] ?? [];
  if (!list.some((record) => record.id === id)) throw new ManualConnectionNotFoundError();
  const rest = list.filter((record) => record.id !== id);
  if (rest.length > 0) file[project] = rest;
  else delete file[project];
  writeJsonFile(join(appData, FILE), file, { preserveForm: false });
  clearStoredKey(appData, keyOf(project, id));
}
