import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiHistoryEntry } from '@agentdeck/contracts';
import { normalizeProjectPath } from '../../lib/app-store/projects.ts';
import {
  clearStoredKey,
  getStoredKey,
  setStoredKey,
} from '../../lib/provider-keys/provider-keys.ts';
import {
  readJsonFile,
  renameWithRetry,
  writeJsonFile,
  writeTextFile,
} from '../../lib/safe-io/safe-io.ts';

/**
 * Что вкладка «API» помнит о проекте: базовый адрес, добавленные адреса
 * контрактов, коллекции Postman и последние 50 запросов. Файл
 * `api-explorer.json` в каталоге данных панели, не `state.json`: снимок
 * состояния уходит в бэкапы и перенос, адреса стендов там не нужны.
 * Значение заголовка авторизации — зашифрованным в хранилище ключей
 * (`api:<проект>`), наружу не уходит: в историю попадает маской.
 */

const FILE = 'api-explorer.json';
const COLLECTIONS = 'api-collections';
const ARCHIVE = 'api-collections-archive';
export const HISTORY_LIMIT = 50;
const HISTORY_BODY_LIMIT = 20_000;

interface ProjectRecord {
  baseUrl?: string;
  urlSources?: string[];
  collections?: { id: string; name: string }[];
  history?: ApiHistoryEntry[];
  authHeader?: string;
}

type StoreFile = Record<string, ProjectRecord>;

const keyOf = (project: string): string => `api:${project}`;

export const collectionsDir = (appData: string): string => join(appData, COLLECTIONS);

function readStore(appData: string): StoreFile {
  try {
    const data = readJsonFile<StoreFile>(join(appData, FILE), {});
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function update(
  appData: string,
  projectPath: string,
  change: (record: ProjectRecord) => void,
): void {
  const project = normalizeProjectPath(projectPath);
  const file = readStore(appData);
  const record = file[project] ?? {};
  change(record);
  file[project] = record;
  writeJsonFile(join(appData, FILE), file, { preserveForm: false });
}

export function readProject(appData: string, projectPath: string): ProjectRecord {
  return readStore(appData)[normalizeProjectPath(projectPath)] ?? {};
}

export function setBaseUrl(appData: string, projectPath: string, baseUrl: string | null): void {
  update(appData, projectPath, (record) => {
    if (baseUrl) record.baseUrl = baseUrl.replace(/\/$/, '');
    else delete record.baseUrl;
  });
}

export function addUrlSource(appData: string, projectPath: string, url: string): void {
  update(appData, projectPath, (record) => {
    const list = record.urlSources ?? [];
    if (!list.includes(url)) record.urlSources = [...list, url];
  });
}

export function removeUrlSource(appData: string, projectPath: string, url: string): boolean {
  let removed = false;
  update(appData, projectPath, (record) => {
    const list = record.urlSources ?? [];
    removed = list.includes(url);
    record.urlSources = list.filter((item) => item !== url);
  });
  return removed;
}

/** Сохранить коллекцию Postman: текст — отдельным файлом, в записи — имя. */
export function addCollection(
  appData: string,
  projectPath: string,
  name: string,
  content: string,
): string {
  const id = randomUUID();
  mkdirSync(collectionsDir(appData), { recursive: true });
  writeTextFile(join(collectionsDir(appData), `${id}.json`), content);
  update(appData, projectPath, (record) => {
    record.collections = [...(record.collections ?? []), { id, name }];
  });
  return id;
}

/** Убрать коллекцию. Файл не стирается, а уезжает в архив рядом — вдруг понадобится. */
export function removeCollection(appData: string, projectPath: string, id: string): boolean {
  let removed = false;
  update(appData, projectPath, (record) => {
    const list = record.collections ?? [];
    removed = list.some((item) => item.id === id);
    record.collections = list.filter((item) => item.id !== id);
  });
  if (removed) {
    try {
      mkdirSync(join(appData, ARCHIVE), { recursive: true });
      renameWithRetry(
        join(collectionsDir(appData), `${id}.json`),
        join(appData, ARCHIVE, `${id}.json`),
      );
    } catch {
      // Файла уже нет — запись убрана, этого достаточно.
    }
  }
  return removed;
}

export interface StoredAuth {
  header: string;
  value: string;
}

export function readAuth(appData: string, projectPath: string): StoredAuth | undefined {
  const project = normalizeProjectPath(projectPath);
  const header = readProject(appData, project).authHeader;
  const value = getStoredKey(appData, keyOf(project));
  return header && value ? { header, value } : undefined;
}

export function setAuth(appData: string, projectPath: string, auth: StoredAuth | null): void {
  const project = normalizeProjectPath(projectPath);
  // Сначала значение, потом имя заголовка: упади запись между ними — останется
  // ключ без заголовка (не применяется), а не заголовок без ключа.
  if (auth) setStoredKey(appData, keyOf(project), auth.value);
  update(appData, project, (record) => {
    if (auth) record.authHeader = auth.header;
    else delete record.authHeader;
  });
  if (!auth) clearStoredKey(appData, keyOf(project));
}

/** `Bearer ••••3f9a` — видно, что сохранено и какое, но не само значение. */
export function maskSecret(value: string): string {
  const scheme = /^(Bearer|Basic|Token|Digest)\s+/i.exec(value);
  const secret = scheme ? value.slice(scheme[0].length) : value;
  const tail = secret.length >= 16 ? secret.slice(-4) : '';
  return `${scheme ? scheme[0] : ''}••••${tail}`;
}

const SECRET_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|api[-_]?key|password|session/i;
const SECRET_QUERY = /token|secret|key|password|passwd|auth|signature|sig$/i;

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let touched = false;
    for (const [name] of parsed.searchParams) {
      if (SECRET_QUERY.test(name)) {
        parsed.searchParams.set(name, '••••');
        touched = true;
      }
    }
    if (parsed.password) {
      parsed.password = '••••';
      touched = true;
    }
    return touched ? parsed.toString() : url;
  } catch {
    return url;
  }
}

/** Запись истории без секретов: заголовки авторизации и такие же параметры адреса — маской. */
export function sanitizeEntry(entry: ApiHistoryEntry): ApiHistoryEntry {
  return {
    ...entry,
    url: maskUrl(entry.url),
    headers: entry.headers.map(([name, value]) => [
      name,
      SECRET_HEADER.test(name) ? maskSecret(value) : value,
    ]),
    ...(entry.body !== undefined ? { body: entry.body.slice(0, HISTORY_BODY_LIMIT) } : {}),
  };
}

export function pushHistory(appData: string, projectPath: string, entry: ApiHistoryEntry): void {
  update(appData, projectPath, (record) => {
    record.history = [sanitizeEntry(entry), ...(record.history ?? [])].slice(0, HISTORY_LIMIT);
  });
}

export function clearHistory(appData: string, projectPath: string): void {
  update(appData, projectPath, (record) => {
    delete record.history;
  });
}
