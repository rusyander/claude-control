import { readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, relative, sep, isAbsolute, dirname } from 'node:path';
import { readTextFile, writeTextFile, backupEntry, removeEntry } from '../lib/safe-io.ts';
import { readScriptDescription } from '../lib/script-description.ts';
import { safeSegment } from './resources/registry.ts';

/**
 * Скрипты в каталоге hooks/. Это обычные файлы, которые запускают хуки, но
 * управлять ими удобнее отдельно от привязок к событиям: один скрипт может
 * вызываться из нескольких хуков, а редактировать его приходится как код.
 */

export interface ScriptFile {
  /** Имя файла с расширением — оно же идентификатор. */
  id: string;
  name: string;
  extension: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Первые строки комментария — краткое описание для списка. */
  description?: string;
  /**
   * Используется ли скрипт: привязан к хуку напрямую или импортируется таким
   * скриптом (транзитивно, по относительным import/require).
   */
  isUsed: boolean;
  /**
   * Тест или фикстура: лежит в `tests/` либо назван `*.test.*` / `*.spec.*`.
   * Такой файл никто не привязывает к хуку по замыслу — в счётчик «не привязано»
   * он не входит, иначе весь набор тестов читался бы как забытые файлы.
   */
  isTest: boolean;
}

/** Расширения, которые страница считает скриптами; `.mts`/`.cts` — тот же strip-types, что и `.ts`. */
export const SCRIPT_EXTENSIONS = new Set([
  '.mjs',
  '.cjs',
  '.js',
  '.ts',
  '.mts',
  '.cts',
  '.sh',
  '.ps1',
  '.py',
]);
/** Файлы, у которых читаем импорты: у shell/python относительных import-строк нет. */
const IMPORTING_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.ts', '.mts', '.cts']);
/** Каталог тестов на любом уровне или имя вида `x.test.mjs` / `x.spec.ts`. */
const TEST_FILE = /(?:^|\/)tests?\/|\.(?:test|spec)\.[^./]+$/;
/**
 * Относительный импорт: `from './x.mjs'`, `import './x.mjs'`, `import('./x.mjs')`, `require('../x.cjs')`.
 * Только `./` и `../`: пакеты и встроенные модули к каталогу hooks/ не относятся.
 */
const IMPORT_SPEC =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

/**
 * Обход hooks/ вглубь: скрипт может лежать в подпапке, а хук ссылаться на него
 * по вложенному пути. Возвращаем относительные пути с прямыми слэшами — они же
 * идентификаторы. Скрытые каталоги и node_modules пропускаем.
 */
function walkScripts(dir: string, base: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      found.push(...walkScripts(full, base));
    } else if (entry.isFile() && SCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      found.push(relative(base, full).split(sep).join('/'));
    }
  }
  return found;
}

/** Что скрипт импортирует из того же каталога — id соседей с прямыми слэшами. */
function localImports(hooksDir: string, rel: string): string[] {
  if (!IMPORTING_EXTENSIONS.has(extname(rel).toLowerCase())) return [];
  let text: string;
  try {
    text = readTextFile(join(hooksDir, rel));
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const match of text.matchAll(IMPORT_SPEC)) {
    const spec = match[1];
    if (!spec) continue;
    const resolved = relative(hooksDir, join(hooksDir, dirname(rel), spec))
      .split(sep)
      .join('/');
    // Импорт за пределы hooks/ — не наш файл, в списке его нет.
    if (!resolved.startsWith('..')) found.push(resolved);
  }
  return found;
}

/**
 * Какие файлы используются. Напрямую — те, на которые ссылается команда хука.
 * Дальше — всё, что используемый скрипт импортирует, и так по цепочке: иначе
 * весь `lib/` с общими модулями читался бы как забытые файлы (на живом каталоге
 * 25 из 42 «неиспользуемых» были именно такими).
 */
function usedScripts(hooksDir: string, rels: string[], usedPaths: string[]): Set<string> {
  // Пути в конфиге пишутся с разными разделителями — нормализуем к прямым слэшам.
  const usedNorm = usedPaths.map((path) => path.replace(/\\/g, '/'));
  const usedNames = new Set(usedNorm.map((path) => path.split('/').pop()));
  const known = new Set(rels);

  const used = new Set(
    rels.filter(
      (rel) =>
        // Совпадение по относительному пути на границе сегмента (или полное),
        // иначе — запасной по имени файла. Без границы `precheck.mjs` ложно
        // «использовал» бы `check.mjs`.
        usedNorm.some((entry) => entry === rel || entry.endsWith(`/${rel}`)) ||
        usedNames.has(rel.split('/').pop() ?? rel),
    ),
  );

  const queue = [...used];
  while (queue.length > 0) {
    const rel = queue.pop() as string;
    for (const dep of localImports(hooksDir, rel)) {
      if (!known.has(dep) || used.has(dep)) continue;
      used.add(dep);
      queue.push(dep);
    }
  }
  return used;
}

export function readScripts(hooksDir: string, usedPaths: string[]): ScriptFile[] {
  if (!existsSync(hooksDir)) return [];

  const rels = walkScripts(hooksDir, hooksDir);
  const used = usedScripts(hooksDir, rels, usedPaths);

  return rels
    .map((rel) => {
      const path = join(hooksDir, rel);
      const stats = statSync(path);
      const fileName = rel.split('/').pop() ?? rel;

      return {
        id: rel,
        // Для вложенного скрипта показываем путь целиком — иначе не отличить
        // одноимённые файлы из разных папок.
        name: rel,
        extension: extname(fileName),
        path,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        description: readScriptDescription(path),
        isUsed: used.has(rel),
        isTest: TEST_FILE.test(rel),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function readScriptContent(hooksDir: string, id: string): string {
  const path = resolveScriptPath(hooksDir, id);

  // Отсутствующий файл — отказ, а не пустая строка. Пустой редактор выглядел бы
  // как «скрипт пустой», и первое же сохранение СОЗДАВАЛО бы файл заново вместо
  // правки того, за которым пришли (список к тому моменту мог устареть).
  if (!existsSync(path)) throw new ScriptNotFoundError(id);

  return readTextFile(path);
}

/**
 * Новый файл. Существующее имя — отказ (409 в маршруте), не перезапись: под
 * ним может лежать чужой, давно правленный скрипт — заготовка «Брифинг при
 * старте» называется как настоящий `session-brief.mjs` и молча затирала его.
 * Правка существующего файла идёт через saveScript по его id.
 */
export function createScript(hooksDir: string, id: string, content: string): void {
  const target = resolveScriptPath(hooksDir, id);
  if (existsSync(target)) throw new ScriptExistsError(id);
  mkdirSync(dirOf(target), { recursive: true });
  writeTextFile(target, content);
}

export function saveScript(
  hooksDir: string,
  id: string,
  content: string,
  backupDir?: string,
): string | undefined {
  const target = resolveScriptPath(hooksDir, id);
  mkdirSync(dirOf(target), { recursive: true });
  return writeTextFile(target, content, { backupDir });
}

/**
 * Удаление скрипта. Как и удаление скилла (см. deleteSkill), снимаем копию до
 * стирания: файл скрипта хука иначе теряется безвозвратно — копия единственный
 * способ отмены. Возвращаем путь резервной копии, чтобы маршрут его отдал.
 */
export function deleteScript(hooksDir: string, id: string, backupDir?: string): string | undefined {
  const path = resolveScriptPath(hooksDir, id);

  // Раньше отсутствие файла тихо возвращало undefined, а маршрут отвечал
  // `{ok:true}` — панель показывала «удалено», хотя не удалила ничего (файл мог
  // остаться на диске из-за другой ошибки, а пользователь считал вопрос
  // закрытым). Отказ честнее: `statusCode` Fastify превращает в 404.
  if (!existsSync(path)) throw new ScriptNotFoundError(id);

  const backupPath = backupDir ? backupEntry(path, backupDir) : undefined;

  // removeEntry, а не rmSync: имя скрипта может быть нелатинским, а рекурсивный
  // rmSync на таком пути в Windows рапортует об успехе, ничего не удалив.
  removeEntry(path);
  return backupPath;
}

/** Каталог файла — чтобы создать вложенные папки перед записью. */
function dirOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf(sep));
  return at > 0 ? path.slice(0, at) : path;
}

/**
 * Скрипта с таким id на диске нет. `statusCode` читает сам Fastify — маршрут
 * отвечает 404 без своей обработки, а панель показывает текст причины.
 */
export class ScriptNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(id: string) {
    super(`Скрипт «${id}» не найден`);
    this.name = 'ScriptNotFoundError';
  }
}

/** Файл с таким именем уже есть — маршрут отвечает 409, файл не тронут. */
export class ScriptExistsError extends Error {
  constructor(id: string) {
    super(`Скрипт «${id}» уже есть. Выберите другое имя или откройте его для правки.`);
    this.name = 'ScriptExistsError';
  }
}

/** Небезопасный идентификатор скрипта — маршрут отвечает 400, НИКОГДА не 404. */
export class UnsafeScriptPathError extends Error {
  constructor(shown: string, reason: string) {
    super(`Небезопасный путь скрипта «${shown}»: ${reason}`);
    this.name = 'UnsafeScriptPathError';
  }
}

/**
 * Идентификатор приходит из запроса и может быть вложенным путём. Раньше каждый
 * сегмент «чистился» до `[a-zA-Z0-9._-]` — и id переставал указывать на файл,
 * которым его выдал readScripts: `my script.mjs` открывался как `myscript.mjs`
 * (редактор показывал пустоту), сохранение создавало ЧУЖОЙ файл, а настоящий
 * хук продолжал работать со старым кодом; `проверка.mjs` схлопывался в `.mjs`.
 * Поэтому имя не переписываем — опасный путь отклоняем целиком, а собранный
 * путь дополнительно проверяем на выход за пределы hooks/.
 */
function resolveScriptPath(hooksDir: string, id: string): string {
  if (id.includes('\0')) throw new UnsafeScriptPathError(id, 'недопустимый символ.');

  // Разделители не схлопываем: пустой сегмент (`sub//a.mjs`) — уже странная
  // форма пути, угадывать за пользователя нечего.
  const segments = id.split(/[\\/]/);
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new UnsafeScriptPathError(id, 'сегменты «.», «..» и пустые запрещены.');
    }
    // Те же правила, что у имён скиллов: символы, запрещённые в Windows,
    // управляющие, хвостовые точка/пробел. Двоеточие в имени доходило до
    // записи и падало 500-й посреди rename, оставляя в папке лишний файл.
    if (safeSegment(segment) === undefined) {
      throw new UnsafeScriptPathError(id, `недопустимые символы в «${segment}».`);
    }
  }

  // Файл без расширения скрипта (или из одного расширения — `.mjs`) записался
  // бы на диск, но в список не попал: пользователь видел «Сохранено» и пустоту.
  const fileName = segments[segments.length - 1] ?? '';
  if (!SCRIPT_EXTENSIONS.has(extname(fileName).toLowerCase())) {
    throw new UnsafeScriptPathError(
      id,
      `имя должно заканчиваться расширением скрипта: ${[...SCRIPT_EXTENSIONS].join(', ')}.`,
    );
  }

  const fullPath = join(hooksDir, ...segments);
  const rel = relative(hooksDir, fullPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new UnsafeScriptPathError(id, 'путь выходит за пределы каталога hooks/.');
  }
  return fullPath;
}
