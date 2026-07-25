import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import type { ConfigProvider } from '../../providers/types.ts';
import { providerLocations, type ProviderLocation } from './locations.ts';
import { redactSecrets } from './redact.ts';

/**
 * Сбор файлов провайдера для архива переноса.
 *
 * Правило отбора одно: в архив едет КОНФИГУРАЦИЯ — то, из-за чего модель ведёт
 * себя одинаково на двух машинах (инструкции, правила, скиллы, хуки, MCP,
 * права, настройки). Не едет ничего из трёх категорий:
 *   - секреты (файлы целиком и значения ключей внутри конфигов — см. redact.ts);
 *   - история и кэши (транскрипты диалогов, снимки оболочки, логи) — это не
 *     настройка, а хвост работы на прежней машине, и он весит десятки мегабайт;
 *   - данные самой панели (группы, копии) — они переносятся отдельной кнопкой
 *     снимка настроек, и в них зашиты пути этой машины.
 *
 * Всё, что не попало, перечисляется в манифесте с причиной: пользователь должен
 * видеть, чего в архиве нет, а не догадываться.
 */

/** Больше этого одиночный файл не берём: конфигов такого размера не бывает. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Предел архива до сжатия. Упёрлись — остальное честно перечислено как пропущенное. */
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Каталоги, которые не переносятся никогда. Имя сравнивается на любом уровне
 * вложенности — так `plugins/<repo>/node_modules` отсекается тем же правилом,
 * что и корневой `node_modules`.
 */
const EXCLUDED_DIRS = new Set([
  'projects', // Claude: транскрипты диалогов
  'todos',
  'shell-snapshots',
  'statsig',
  'file-history',
  'history',
  'sessions',
  'logs',
  'ide',
  'downloads',
  'backups', // копии панели
  'claude-control', // данные самой панели: группы, связи, ключи
  // Клоны каталогов плагинов: десятки мегабайт, которые CLI выкачивает сам по
  // `known_marketplaces.json`. Переносим список, а не сами клоны.
  'marketplaces',
  // Окружения и сборки, случайно оказавшиеся в каталоге конфигурации (в живом
  // `~/.claude` находился python-venv на 311 МБ).
  'node_modules',
  'venv',
  '.venv',
  '__pycache__',
  'site-packages',
  'dist',
  'build',
  'target',
  'vendor',
  'coverage',
  '.git',
  '.cache',
  'cache',
  'tmp',
  'temp',
]);

/**
 * Файл-признак виртуального окружения Python. Каталог с ним пропускается целиком
 * как бы он ни назывался: имя `agent-sdk-venv` ни одному списку не угадать.
 */
const VENV_MARKER = 'pyvenv.cfg';

/**
 * Что забирается ПЕРВЫМ, пока не упёрлись в предел архива. Это и есть та самая
 * настройка, ради которой перенос затевался: инструкции, правила, скиллы,
 * хуки, агенты, команды. Всё остальное (кэши плагинов, вспомогательные дампы)
 * попадает следом — и если не влезет, будет честно перечислено как пропущенное.
 */
const PRIORITY_DIRS = new Set([
  'skills',
  'skills-disabled',
  'skills-archived',
  'hooks',
  'agents',
  'commands',
  'output-styles',
  'rules',
  'mcp-servers',
  'tools',
  'memory',
]);

/** Файлы-секреты целиком: в архив не попадают ни при каких условиях. */
const SECRET_BASENAMES = new Set([
  '.credentials.json',
  '.mcp-secrets.env',
  'provider-keys.enc',
  'provider-keys.key',
  'auth.json',
  'secrets.yaml',
  'secrets.yml',
  'credentials.json',
]);

/** Расширения-секреты и мусор, который переносить бессмысленно. */
const SECRET_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx']);
const JUNK_EXTENSIONS = new Set(['.bak', '.tmp', '.lock', '.log']);

/** Форматы, внутри которых ищем секретные ЗНАЧЕНИЯ. Код и тексты не трогаем. */
const REDACTABLE_EXTENSIONS = new Set([
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.conf',
  '.cfg',
  '.properties',
]);

/** Файл переменных окружения: значения не переносим, имена ключей — в чек-лист. */
function isDotenvName(name: string): boolean {
  return name === '.env' || name.startsWith('.env.');
}

/**
 * Единственное исключение из «файл переносится целиком»: `~/.claude.json`.
 * Claude Code держит в нём и MCP-серверы (настройка), и историю запросов с
 * идентификаторами машины (не настройка). Берём только ключи-настройки, а на
 * новой машине вливаем их в существующий файл, а не поверх него.
 */
const PARTIAL_JSON: Record<string, { role: string; keys: string[] }> = {
  claude: { role: 'mcp', keys: ['mcpServers'] },
};

export interface CollectedFile {
  /** Путь внутри архива (`files/loc-0/settings.json`). */
  archivePath: string;
  /** Номер места из `providerLocations` и путь внутри него. */
  locationIndex: number;
  relative: string;
  /** Абсолютный путь на машине-источнике — только для чтения человеком и моделью. */
  sourcePath: string;
  /** Как применять на новой машине. */
  applyMode: 'file' | 'json-merge';
  /** Какие ключи вливать при `json-merge`. */
  mergeKeys?: string[];
  bytes: number;
  sha256: string;
  /** Ключи, значения которых заменены меткой. */
  redactedKeys: string[];
  data: Buffer;
}

export interface SkippedFile {
  sourcePath: string;
  reason: 'secret' | 'too-large' | 'excluded' | 'unreadable' | 'archive-full';
}

export interface ChecklistItem {
  /** Где это было на прежней машине. */
  source: string;
  /** Имена ключей без значений. */
  keys: string[];
  reason: 'redacted' | 'env-file' | 'secret-file';
}

export interface CollectResult {
  locations: ProviderLocation[];
  files: CollectedFile[];
  skipped: SkippedFile[];
  checklist: ChecklistItem[];
  totalBytes: number;
}

/** Собирает всё, что поедет в архив, вместе со списком пропущенного. */
export function collectProviderFiles(provider: ConfigProvider, override?: string): CollectResult {
  const locations = providerLocations(provider, override);
  const result: CollectResult = {
    locations,
    files: [],
    skipped: [],
    checklist: [],
    totalBytes: 0,
  };

  for (const location of locations) {
    if (!existsSync(location.path)) continue;
    if (location.kind === 'file') {
      takeFile(provider, location, basename(location.path), location.path, result);
      continue;
    }

    // Сначала список всех кандидатов, потом отбор ПО ВАЖНОСТИ: настройка —
    // вперёд, всё прочее — следом. Иначе первый же тяжёлый вспомогательный
    // каталог съел бы предел архива, и скиллы с хуками в него не попали бы
    // (в живом `~/.claude` так и вышло на первой же проверке).
    const candidates = collectCandidates(location.path, result);
    candidates.sort(byPriority);
    for (const relative of candidates) {
      takeFile(provider, location, relative, join(location.path, ...relative.split('/')), result);
    }
  }

  return result;
}

/** Пути всех файлов места (относительные), с отсевом исключённых каталогов. */
function collectCandidates(root: string, result: CollectResult): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      result.skipped.push({ sourcePath: dir, reason: 'unreadable' });
      return;
    }

    // Виртуальное окружение узнаётся по файлу-признаку, а не по имени папки.
    if (entries.some((entry) => entry.isFile() && entry.name === VENV_MARKER)) {
      result.skipped.push({ sourcePath: dir, reason: 'excluded' });
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Симлинк на новой машине указывал бы в пустоту, а вести по нему обход —
        // приглашение выйти за пределы каталога. Пропускаем и говорим об этом.
        result.skipped.push({ sourcePath: full, reason: 'excluded' });
        continue;
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
          result.skipped.push({ sourcePath: full, reason: 'excluded' });
          continue;
        }
        walk(full);
        continue;
      }
      if (entry.isFile()) found.push(toArchiveRelative(root, full));
    }
  };

  walk(root);
  return found;
}

/**
 * Порядок отбора: файлы в корне конфигурации (settings.json, CLAUDE.md) →
 * каталоги настройки (скиллы, хуки, агенты) → всё остальное. Внутри группы —
 * по алфавиту, чтобы архив собирался одинаково от запуска к запуску.
 */
function byPriority(a: string, b: string): number {
  return priorityOf(a) - priorityOf(b) || a.localeCompare(b);
}

function priorityOf(relative: string): number {
  if (!relative.includes('/')) return 0;
  return PRIORITY_DIRS.has(relative.slice(0, relative.indexOf('/')).toLowerCase()) ? 1 : 2;
}

/** Путь внутри места, всегда через прямой слэш (архив един для всех ОС). */
function toArchiveRelative(root: string, path: string): string {
  return relative(root, path).split(/[\\/]/).join('/');
}

function takeFile(
  provider: ConfigProvider,
  location: ProviderLocation,
  relativePath: string,
  sourcePath: string,
  result: CollectResult,
): void {
  const name = basename(sourcePath).toLowerCase();
  const extension = extname(name);

  if (SECRET_BASENAMES.has(name) || SECRET_EXTENSIONS.has(extension)) {
    result.skipped.push({ sourcePath, reason: 'secret' });
    result.checklist.push({ source: sourcePath, keys: [], reason: 'secret-file' });
    return;
  }
  if (JUNK_EXTENSIONS.has(extension)) {
    result.skipped.push({ sourcePath, reason: 'excluded' });
    return;
  }

  let size: number;
  try {
    size = statSync(sourcePath).size;
  } catch {
    result.skipped.push({ sourcePath, reason: 'unreadable' });
    return;
  }
  if (size > MAX_FILE_BYTES) {
    result.skipped.push({ sourcePath, reason: 'too-large' });
    return;
  }
  if (result.totalBytes + size > MAX_TOTAL_BYTES) {
    result.skipped.push({ sourcePath, reason: 'archive-full' });
    return;
  }

  let raw: Buffer;
  try {
    raw = readFileSync(sourcePath);
  } catch {
    result.skipped.push({ sourcePath, reason: 'unreadable' });
    return;
  }

  // Файл переменных окружения: сами значения — секреты, поэтому в архив он не
  // едет, а его ключи становятся пунктами чек-листа.
  if (isDotenvName(name)) {
    const keys = dotenvKeys(raw.toString('utf8'));
    result.skipped.push({ sourcePath, reason: 'secret' });
    if (keys.length > 0) result.checklist.push({ source: sourcePath, keys, reason: 'env-file' });
    return;
  }

  const partial = PARTIAL_JSON[provider.id];
  const isPartial =
    partial !== undefined && location.role === partial.role && extension === '.json';

  let data = raw;
  let redactedKeys: string[] = [];
  if (isPartial) {
    const reduced = keepJsonKeys(raw.toString('utf8'), partial.keys);
    if (!reduced) {
      result.skipped.push({ sourcePath, reason: 'unreadable' });
      return;
    }
    const cleaned = redactSecrets(name, reduced);
    data = Buffer.from(cleaned.text, 'utf8');
    redactedKeys = cleaned.keys;
  } else if (REDACTABLE_EXTENSIONS.has(extension)) {
    const cleaned = redactSecrets(name, raw.toString('utf8'));
    // Заменять было нечего — везём ИСХОДНЫЕ байты. Пересборка ради ничего
    // меняла бы форматирование и переводы строк, и на новой машине такой файл
    // выглядел бы отличающимся, хотя отличий по сути нет.
    if (cleaned.keys.length > 0) {
      data = Buffer.from(cleaned.text, 'utf8');
      redactedKeys = cleaned.keys;
    }
  }

  if (redactedKeys.length > 0) {
    result.checklist.push({ source: sourcePath, keys: redactedKeys, reason: 'redacted' });
  }

  result.files.push({
    archivePath: `files/loc-${location.index}/${relativePath}`,
    locationIndex: location.index,
    relative: relativePath,
    sourcePath,
    applyMode: isPartial ? 'json-merge' : 'file',
    ...(isPartial ? { mergeKeys: partial.keys } : {}),
    bytes: data.length,
    sha256: sha256(data),
    redactedKeys,
    data,
  });
  result.totalBytes += data.length;
}

/** Имена переменных из dotenv-файла. Значения не читаем и никуда не кладём. */
function dotenvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) keys.push(match[1]);
  }
  return [...new Set(keys)];
}

/** Оставляет в JSON только перечисленные ключи верхнего уровня. */
function keepJsonKeys(text: string, keys: string[]): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const source = parsed as Record<string, unknown>;
  const reduced: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) reduced[key] = source[key];
  }
  return `${JSON.stringify(reduced, null, 2)}\n`;
}

/** Отпечаток содержимого — по нему импорт отличает «то же самое» от «другое». */
export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
