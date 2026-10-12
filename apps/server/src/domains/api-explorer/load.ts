import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ApiSpec } from '@agentdeck/contracts';
import { ApiSpecError, isNode } from './api-explorer.types.ts';
import { parseOpenApi } from './openapi.ts';
import { isPostmanCollection, parsePostman } from './postman.ts';

/**
 * Текст контракта → `ApiSpec`, плюс чтение источника: файл проекта, адрес,
 * сохранённая коллекция. Разобранное держится в памяти: файл — пока не
 * изменился, адрес — полминуты (сервис разработчика перезапускают часто).
 */

export const SPEC_CAP_BYTES = 10 * 1024 * 1024;
const URL_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

export function parseSpecText(text: string, sourceId: string): ApiSpec {
  let doc: unknown;
  const trimmed = text.trimStart();
  try {
    doc = trimmed.startsWith('{') || trimmed.startsWith('[') ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new ApiSpecError('unreadable', (error as Error).message.split('\n')[0] ?? '');
  }
  if (!isNode(doc)) throw new ApiSpecError('not-a-spec', 'Не объект');
  if (isPostmanCollection(doc)) return parsePostman(doc, sourceId);
  const openapi = doc.openapi;
  const swagger = doc.swagger;
  if ((typeof openapi === 'string' && openapi.startsWith('3')) || swagger === '2.0')
    return parseOpenApi(doc, sourceId);
  throw new ApiSpecError('not-a-spec', 'Нет поля openapi/swagger и это не коллекция Postman');
}

/** Путь файла-источника внутри проекта; выход за корень — отказ. */
export function specFilePath(root: string, rel: string): string {
  const full = resolve(root, rel);
  const back = relative(root, full);
  if (!back || back.startsWith('..') || isAbsolute(back))
    throw new ApiSpecError('missing', `Файл вне проекта: ${rel}`);
  return full;
}

const fileCache = new Map<string, { mtimeMs: number; spec: ApiSpec }>();
const urlCache = new Map<string, { at: number; spec: ApiSpec }>();

export function loadSpecFile(root: string, rel: string, sourceId: string): ApiSpec {
  const full = specFilePath(root, rel);
  let stats;
  try {
    stats = statSync(full);
  } catch {
    throw new ApiSpecError('missing', `Файла нет: ${rel}`);
  }
  if (stats.size > SPEC_CAP_BYTES) throw new ApiSpecError('too-big', String(stats.size));
  const cached = fileCache.get(full);
  if (cached && cached.mtimeMs === stats.mtimeMs) return { ...cached.spec, sourceId };
  const spec = parseSpecText(readFileSync(full, 'utf8'), sourceId);
  fileCache.set(full, { mtimeMs: stats.mtimeMs, spec });
  return spec;
}

/** Текст по адресу с пределом размера и временем ожидания. */
export async function fetchText(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
  cap = SPEC_CAP_BYTES,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json, application/yaml, text/yaml, */*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    throw new ApiSpecError('fetch', cause ?? (error as Error).name);
  }
  if (!response.ok) throw new ApiSpecError('fetch', `HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap)
    throw new ApiSpecError('too-big', String(declared));
  const text = await response.text();
  if (text.length > cap) throw new ApiSpecError('too-big', String(text.length));
  return text;
}

export async function loadSpecUrl(url: string, sourceId: string, fresh = false): Promise<ApiSpec> {
  const cached = urlCache.get(url);
  if (!fresh && cached && Date.now() - cached.at < URL_TTL_MS) return cached.spec;
  const spec = parseSpecText(await fetchText(url), sourceId);
  // Адрес контракта сам подсказывает сервер, если `servers` в нём нет или он относительный.
  const origin = new URL(url).origin;
  spec.servers =
    spec.servers.length === 0
      ? [origin]
      : spec.servers.map((server) => (server.startsWith('/') ? `${origin}${server}` : server));
  urlCache.set(url, { at: Date.now(), spec });
  return spec;
}

export function loadSpecCollection(dir: string, id: string, sourceId: string): ApiSpec {
  const file = join(dir, `${id}.json`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ApiSpecError('missing', `Коллекции нет: ${id}`);
  }
  return parseSpecText(text, sourceId);
}

/** Для тестов: забыть разобранное. */
export function forgetSpecCache(): void {
  fileCache.clear();
  urlCache.clear();
}
