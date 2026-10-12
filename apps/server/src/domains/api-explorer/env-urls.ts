import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ApiEnvUrl } from '@agentdeck/contracts';
import { layoutForCwd } from '../project-git/cwd-layout.ts';

/**
 * Адреса стендов из `.env`-файлов проекта: dev-стенд обычно записан там
 * (`DEV_API_URL=https://api.dev.example.com`), а в `servers` контракта — боевой
 * или заглушка. Из файла берутся ТОЛЬКО значения-адреса http(s): ключи с
 * секретами пропускаются целиком, адрес с логином и паролем внутри — тоже,
 * остальные значения файла наружу не уходят.
 *
 * Копия задачи (git worktree) `.env` обычно не несёт: файл вне git и в копию не
 * попадает. Тогда — и после своих — адреса основной копии, с пометкой `main`:
 * чат в копии ходит на тот же стенд, что и оригинал.
 */

const MAX_DEPTH = 2;
const MAX_FILES = 20;
const MAX_SIZE = 64 * 1024;
const MAX_URLS = 40;
const ENV_FILE = /^\.env(\.[\w.-]+)?$/;
const SKIP = new Set([
  'node_modules',
  '.git',
  'vendor',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
]);
const SECRET_KEY = /PASS|SECRET|TOKEN|KEY|CREDENTIAL|AUTH|COOKIE|SESSION|DSN/i;
/** Адрес страницы входа или обратного вызова — не база для запросов. */
const NOT_BASE_KEY = /LOGIN|LOGOUT|CALLBACK|REDIRECT|WEBHOOK/i;
const LINE = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/;

function envFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
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
          walk(full, depth + 1);
      } else if (entry.isFile() && ENV_FILE.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(root, 0);
  return found;
}

/** Значение строки без кавычек и хвостового комментария. */
function unquote(raw: string): string {
  const value = raw.trim();
  const quoted = /^(["'])(.*)\1/.exec(value);
  if (quoted) return quoted[2] ?? '';
  return value.replace(/\s+#.*$/, '');
}

/** Адрес без хвостового `/`; не http(s), с учётными данными или с подстановкой `${…}` — нет. */
function cleanUrl(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value) || value.includes('${')) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function findEnvUrls(root: string): ApiEnvUrl[] {
  const urls: ApiEnvUrl[] = [];
  const seen = new Set<string>();
  collect(root, urls, seen, false);
  const { mainDir } = layoutForCwd(root);
  if (mainDir) collect(mainDir, urls, seen, true);
  return urls;
}

function collect(root: string, urls: ApiEnvUrl[], seen: Set<string>, main: boolean): void {
  for (const file of envFiles(root)) {
    let text: string;
    try {
      if (statSync(file).size > MAX_SIZE) continue;
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(root, file).split(sep).join('/');
    for (const line of text.split(/\r?\n/)) {
      const match = LINE.exec(line);
      if (!match) continue;
      const key = match[1] ?? '';
      if (SECRET_KEY.test(key) || NOT_BASE_KEY.test(key)) continue;
      const url = cleanUrl(unquote(match[2] ?? ''));
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push({ url, file: rel, key, ...(main ? { main: true as const } : {}) });
      if (urls.length >= MAX_URLS) return;
    }
  }
}
