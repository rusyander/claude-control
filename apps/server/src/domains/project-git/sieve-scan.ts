import { posix } from 'node:path';
import { isProductCode, isTestPath, touchKinds } from '@agentdeck/contracts/sieves';
import { DLP_BUILTINS } from '../dlp/builtins.mjs';

/**
 * Механика сит по диффу — чистые функции над добавленными и удалёнными строками
 * и списками путей, без git и без модели (`sieve-facts.ts` собирает им вход).
 *
 * Каждая проверка — класс того, что доезжает до dev и prod мимо ревью, и каждая
 * настроена на ТОЧНОСТЬ, а не на охват: ложное срабатывание держит группу и
 * учит людей не верить ситу. Поэтому секрет — только ключ с формой, заданной
 * вендором; отладка — только то, что однозначно отладка; переменная окружения
 * без значения по умолчанию в той же строке; и всё снимается отчётом, который
 * называет файл.
 */

/** Строка, добавленная веткой, с её файлом. */
export interface Addition {
  path: string;
  text: string;
}

/** Ключи с формой, заданной вендором, JWT, пароль в адресе и приватный ключ. */
const SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp(DLP_BUILTINS.secret_key.source),
  new RegExp(DLP_BUILTINS.jwt.source),
  new RegExp(DLP_BUILTINS.credentials_url.source, 'i'),
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
];

/** Лок-файлы: хеши целостности в них похожи на ключи, а ключей там не бывает. */
const LOCK_FILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|pdm\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$/;

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Файлы, где в добавленных строках есть секрет. */
export function secretsIn(additions: readonly Addition[]): string[] {
  return unique(
    additions
      .filter((line) => !LOCK_FILE.test(line.path))
      .filter((line) => SECRET_PATTERNS.some((pattern) => pattern.test(line.text)))
      .map((line) => line.path),
  );
}

const CONFLICT_MARKER = /^(<{7}|>{7})( |$)|^={7}$/;
const FOCUSED_TEST = /\b(?:describe|it|test|context|suite)\.only\s*\(|\b(?:fdescribe|fit)\s*\(/;
const DEBUG_STATEMENT =
  /^\s*debugger\s*;?\s*$|^\s*(?:breakpoint\(\)|import\s+i?pdb\b|i?pdb\.set_trace\(\))|\bbinding\.pry\b/;

/**
 * Файлы с остатками отладки: маркер конфликта где угодно, сфокусированный тест
 * в тестах (молча выключает остальной набор в CI), `debugger`/`breakpoint()` в коде.
 */
export function debugLeftoversIn(additions: readonly Addition[]): string[] {
  return unique(
    additions
      .filter((line) => {
        if (CONFLICT_MARKER.test(line.text)) return true;
        if (isTestPath(line.path)) return FOCUSED_TEST.test(line.text);
        return isProductCode(line.path) && DEBUG_STATEMENT.test(line.text);
      })
      .map((line) => line.path),
  );
}

/** Манифест → лок-файлы, любой из которых годится, и признак строки зависимости. */
const MANIFESTS: readonly { name: string; locks: readonly string[]; dependency: RegExp }[] = [
  {
    name: 'package.json',
    locks: [
      'package-lock.json',
      'npm-shrinkwrap.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      'bun.lock',
    ],
    // Значение — версия или протокол пакета, а не команда скрипта.
    dependency:
      /^\s*"(?:@[\w.-]+\/)?[\w.-]+"\s*:\s*"(?:[~^<>=*]|\d|workspace:|npm:|file:|link:|git|https?:|latest)/,
  },
  {
    name: 'pyproject.toml',
    locks: ['poetry.lock', 'uv.lock', 'pdm.lock'],
    dependency: /(?:==|>=|<=|~=|!=|\^\d|["'][\w.-]+\s*[<>=~!]|^\s*[\w.-]+\s*=\s*["'{])/,
  },
  { name: 'go.mod', locks: ['go.sum'], dependency: /^\s*(?:require\s+)?[\w./-]+\s+v\d/ },
  { name: 'Cargo.toml', locks: ['Cargo.lock'], dependency: /^\s*[\w-]+\s*=\s*["{]/ },
  { name: 'Gemfile', locks: ['Gemfile.lock'], dependency: /^\s*gem\s+["']/ },
  {
    name: 'composer.json',
    locks: ['composer.lock'],
    dependency: /^\s*"[\w.-]+\/[\w.-]+"\s*:\s*"/,
  },
];

/**
 * Манифесты, где ветка поменяла строку зависимости, а лок-файл, который в
 * репозитории есть (рядом или в корне — рабочие области), не тронут. Нет лока в
 * репозитории вовсе — проект его не ведёт, и требовать нечего.
 */
export function lockfileGapsIn(input: {
  changed: readonly string[];
  /** Добавленные и удалённые строки ветки с файлами. */
  lines: readonly Addition[];
  /** Все файлы репозитория (`git ls-files`). */
  tracked: readonly string[];
}): string[] {
  const changed = new Set(input.changed);
  const tracked = new Set(input.tracked);
  const gaps: string[] = [];
  for (const path of input.changed) {
    const manifest = MANIFESTS.find((item) => posix.basename(path) === item.name);
    if (!manifest) continue;
    const touchesDeps = input.lines.some(
      (line) => line.path === path && manifest.dependency.test(line.text),
    );
    if (!touchesDeps) continue;
    const dir = posix.dirname(path);
    const candidates = manifest.locks.flatMap((lock) =>
      [dir === '.' ? lock : `${dir}/${lock}`, lock].filter((file) => tracked.has(file)),
    );
    if (candidates.length > 0 && !candidates.some((file) => changed.has(file))) gaps.push(path);
  }
  return unique(gaps);
}

/**
 * Чтение переменной окружения на разных языках. Группа 1 — имя; то, что стоит
 * сразу после совпадения, решает, есть ли значение по умолчанию.
 */
const ENV_READS: readonly RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /process\.env\[\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /os\.(?:environ\.get|getenv)\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /os\.environ\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g,
  /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /env::var(?:_os)?\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /ENV(?:\.fetch\(|\[)\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /Environment\.GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /\bgetenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /\$_ENV\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g,
];

/** Переменные, которые задаёт сама среда, — объявлять их негде и незачем. */
const AMBIENT = new Set([
  'NODE_ENV',
  'HOME',
  'PATH',
  'PWD',
  'USER',
  'USERNAME',
  'SHELL',
  'TERM',
  'LANG',
  'TMPDIR',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOSTNAME',
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'PORT',
  'DEBUG',
  'TZ',
]);

/** После чтения стоит значение по умолчанию: `??`, `||`, второй аргумент, `unwrap_or`. */
const HAS_DEFAULT = /^\s*(?:\?\?|\|\||,|\)\s*\.(?:unwrap_or|or_else|get_or)|\)\s*or\b)/;

/**
 * Имена переменных окружения, которые код продукта начал читать в добавленных
 * строках без значения по умолчанию. Объявлены ли они — решает вызывающий
 * (`git grep` по конфигурации и докам).
 */
export function envReadsIn(additions: readonly Addition[]): string[] {
  const names = new Set<string>();
  for (const line of additions) {
    if (!isProductCode(line.path)) continue;
    for (const pattern of ENV_READS) {
      for (const match of line.text.matchAll(pattern)) {
        const name = match[1]!;
        if (AMBIENT.has(name)) continue;
        const after = line.text.slice((match.index ?? 0) + match[0].length);
        if (!HAS_DEFAULT.test(after)) names.add(name);
      }
    }
  }
  return [...names].sort();
}

/**
 * Файл, где имя переменной считается объявленным: конфигурация, образец
 * окружения, манифест развёртывания или документация — всё, кроме кода, тестов
 * и ЛОКАЛЬНОГО `.env`: тот сам утечка (`committed-artifacts`), а не объявление,
 * и на сервере его не будет.
 */
export function declaresEnv(path: string): boolean {
  if (LOCAL_ENV.test(path) && !EXAMPLE_ENV.test(path)) return false;
  return !isProductCode(path) && !isTestPath(path);
}

const DESTRUCTIVE =
  /\b(?:DROP\s+(?:TABLE|COLUMN|SCHEMA|DATABASE|VIEW)|TRUNCATE\b|ALTER\s+TABLE\s+\S+\s+(?:RENAME|DROP)|ALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE|DELETE\s+FROM\s+[\w."`]+\s*;)|\b(?:drop_table|remove_column|rename_column|change_column|dropColumn|dropTable|renameColumn|op\.drop_(?:table|column)|op\.alter_column|DeleteModel|RemoveField|RenameField|AlterField)\b/i;

/** Файлы миграций и схем с разрушающими операторами в добавленных строках. */
export function destructiveIn(additions: readonly Addition[]): string[] {
  return unique(
    additions
      .filter((line) => touchKinds([line.path]).has('data') && DESTRUCTIVE.test(line.text))
      .map((line) => line.path),
  );
}

/** Код продукта, изменённый веткой, в которой не изменён ни один тест. */
export function untestedCodeIn(changed: readonly string[]): string[] {
  const code = changed.filter(isProductCode);
  if (code.length === 0 || changed.some(isTestPath)) return [];
  return unique(code);
}

const LOCAL_ENV = /(^|\/)\.env(\.[\w-]+)?$/i;
/** Файлы, которым не место в git по одному имени: окружение и ключи. */
const LOCAL_FILE =
  /(^|\/)\.env(\.[\w-]+)?$|\.(pem|key|p12|pfx|jks|keystore)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i;
const EXAMPLE_ENV = /\.(example|sample|template|dist|defaults?)$/i;
/** С этого размера добавленный файл — почти наверняка выход сборки или дамп. */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Добавленные файлы, которых в git быть не должно: `.env` и ключи по имени,
 * игнорируемые `.gitignore` (добавлены силой), и крупные.
 */
export function artifactsIn(input: {
  added: readonly string[];
  /** Добавленные файлы, которые `.gitignore` исключает. */
  ignored: readonly string[];
  /** Размер добавленного файла в HEAD, байты. */
  sizes: Readonly<Record<string, number>>;
}): string[] {
  const ignored = new Set(input.ignored);
  return unique(
    input.added.filter(
      (path) =>
        (LOCAL_FILE.test(path) && !EXAMPLE_ENV.test(path)) ||
        ignored.has(path) ||
        (input.sizes[path] ?? 0) > LARGE_FILE_BYTES,
    ),
  );
}
