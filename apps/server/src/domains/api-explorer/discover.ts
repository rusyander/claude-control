import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ApiRunningService } from '@agentdeck/contracts';
import { fetchText, parseSpecText } from './load.ts';

/**
 * Где в проекте лежит контракт. Файлы — до четвёртого уровня, мимо
 * зависимостей и сборок: по имени (`openapi.yaml`, `swagger.json`,
 * `*.postman_collection.json`) или по началу содержимого в каталогах вида
 * `api/`, `docs/`. Работающий сервис из «Dev-сервера» опрашивается по
 * известным адресам — так находится контракт, который отдаёт сам код
 * (springdoc, FastAPI, swag).
 */

const MAX_DEPTH = 4;
const MAX_FILES = 30;
const MAX_SIZE = 10 * 1024 * 1024;
const SKIP = new Set([
  'node_modules',
  '.git',
  'vendor',
  'dist',
  'build',
  'target',
  'out',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.gradle',
  '.idea',
  '.vscode',
  'coverage',
  '.agent',
  '.claude',
  '.cache',
  '.turbo',
  'bin',
  'obj',
]);
const SPEC_EXT = /\.(json|ya?ml)$/i;
const BY_NAME =
  /(^|[._-])(openapi|swagger|api[-_]?docs?|api[-_]?spec)([._-]|$)|\.postman_collection\.json$/i;
const SPEC_DIRS = /^(api|apis|docs?|specs?|openapi|swagger|contracts?|schemas?)$/i;
const HEAD_SNIFF =
  /["']?(openapi|swagger)["']?\s*:\s*["']?(3\.|2\.0)|getpostman\.com\/json\/collection/;

/** Известные адреса контракта у фреймворков: springdoc, FastAPI, swag, Express. */
export const WELL_KNOWN_PATHS = [
  '/openapi.json',
  '/v3/api-docs',
  '/swagger/doc.json',
  '/swagger.json',
  '/api-docs',
];

function head(file: string): string {
  const buffer = Buffer.alloc(4096);
  const fd = openSync(file, 'r');
  try {
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Пути файлов контракта от корня проекта, с прямыми слэшами. */
export function findSpecFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number, inSpecDir: boolean): void => {
    if (found.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP.has(entry.name) && !entry.name.startsWith('.'))
          walk(full, depth + 1, inSpecDir || SPEC_DIRS.test(entry.name));
        continue;
      }
      if (!entry.isFile() || !SPEC_EXT.test(entry.name)) continue;
      const named = BY_NAME.test(entry.name);
      if (!named && !inSpecDir) continue;
      try {
        if (statSync(full).size > MAX_SIZE) continue;
        if (!HEAD_SNIFF.test(head(full))) continue;
      } catch {
        continue;
      }
      found.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root, 0, false);
  return found;
}

const probeCache = new Map<string, { at: number; url?: string }>();
const PROBE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 1500;

/**
 * Адрес контракта у работающего сервиса или `undefined`. Ответ запоминается на
 * минуту: вкладку открывают часто, а сервис, который не отдаёт контракт, так и
 * не начнёт.
 */
export async function probeService(baseUrl: string, fresh = false): Promise<string | undefined> {
  const cached = probeCache.get(baseUrl);
  if (!fresh && cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.url;
  const base = baseUrl.replace(/\/$/, '');
  const hits = await Promise.all(
    WELL_KNOWN_PATHS.map(async (path) => {
      try {
        const text = await fetchText(`${base}${path}`, PROBE_TIMEOUT_MS);
        parseSpecText(text, 'probe');
        return `${base}${path}`;
      } catch {
        return undefined;
      }
    }),
  );
  const url = hits.find(Boolean);
  probeCache.set(baseUrl, { at: Date.now(), ...(url ? { url } : {}) });
  return url;
}

export async function probeServices(
  services: ApiRunningService[],
  fresh = false,
): Promise<string[]> {
  const urls = await Promise.all(services.map((service) => probeService(service.url, fresh)));
  return [...new Set(urls.filter((url): url is string => Boolean(url)))];
}

/** Для тестов. */
export function forgetProbeCache(): void {
  probeCache.clear();
}
