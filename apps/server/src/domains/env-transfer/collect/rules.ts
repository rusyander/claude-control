/**
 * Правила отбора: что не переносится никогда, что берётся первым и где искать
 * секретные значения. Одни данные, никакого ввода-вывода.
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
export const EXCLUDED_DIRS = new Set([
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
export const VENV_MARKER = 'pyvenv.cfg';

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
export const SECRET_BASENAMES = new Set([
  '.credentials.json',
  '.mcp-secrets.env',
  'provider-keys.enc',
  'provider-keys.key',
  'auth.json',
  'secrets.yaml',
  'secrets.yml',
  'credentials.json',
  // Словари правил защиты данных: в них лежат ровно те фамилии, телефоны и
  // адреса, ради которых правила и заведены. Уехать в архив переноса они не
  // должны ни при каких условиях — это была бы утечка через средство защиты.
  'dlp-rules.json',
  'dlp-journal.jsonl',
]);

/** Расширения-секреты и мусор, который переносить бессмысленно. */
export const SECRET_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx']);
export const JUNK_EXTENSIONS = new Set(['.bak', '.tmp', '.lock', '.log']);

/** Форматы, внутри которых ищем секретные ЗНАЧЕНИЯ. Код и тексты не трогаем. */
export const REDACTABLE_EXTENSIONS = new Set([
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
export function isDotenvName(name: string): boolean {
  return name === '.env' || name.startsWith('.env.');
}

/**
 * Единственное исключение из «файл переносится целиком»: `~/.claude.json`.
 * Claude Code держит в нём и MCP-серверы (настройка), и историю запросов с
 * идентификаторами машины (не настройка). Берём только ключи-настройки, а на
 * новой машине вливаем их в существующий файл, а не поверх него.
 */
export const PARTIAL_JSON: Record<string, { role: string; keys: string[] }> = {
  claude: { role: 'mcp', keys: ['mcpServers'] },
};

/**
 * Порядок отбора: файлы в корне конфигурации (settings.json, CLAUDE.md) →
 * каталоги настройки (скиллы, хуки, агенты) → всё остальное. Внутри группы —
 * по алфавиту, чтобы архив собирался одинаково от запуска к запуску.
 */
export function byPriority(a: string, b: string): number {
  return priorityOf(a) - priorityOf(b) || a.localeCompare(b);
}

function priorityOf(relative: string): number {
  if (!relative.includes('/')) return 0;
  return PRIORITY_DIRS.has(relative.slice(0, relative.indexOf('/')).toLowerCase()) ? 1 : 2;
}
