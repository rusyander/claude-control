import { readdirSync, statSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Skill, SkillDraft } from '@claude-control/contracts';
import {
  readTextFile,
  writeTextFile,
  backupEntry,
  removeEntry,
  copyRecursive,
} from '../lib/safe-io.ts';
import { slugify } from '../lib/slug.ts';
import type { AppStore } from '../lib/app-store.ts';

/**
 * Скилл — папка с файлом SKILL.md, у которого в начале YAML-frontmatter
 * с полями name и description. Именно description Claude использует, чтобы
 * решить, когда применять скилл, поэтому в интерфейсе оно на видном месте.
 *
 * Выключение реализовано переносом папки в `skills-disabled/`: Claude
 * сканирует только `skills/`, так что перенос — самый честный способ
 * скрыть скилл, не удаляя его.
 */

/** Каталог выключенных скиллов рядом с skills/. Знает и откат копий (backups.ts). */
export const SKILLS_DISABLED_DIR = 'skills-disabled';

export function readSkills(skillsDir: string, store: AppStore): Skill[] {
  const skills: Skill[] = [];
  const disabledDir = join(skillsDir, '..', SKILLS_DISABLED_DIR);

  for (const [dir, isEnabled] of [
    [skillsDir, true],
    [disabledDir, false],
  ] as const) {
    if (!existsSync(dir)) continue;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Скилл может быть симлинком или junction на папку в другом месте —
      // так подключают общие наборы скиллов. Для таких записей isDirectory()
      // возвращает false, поэтому проверяем цель ссылки отдельно.
      if (!isDirectoryEntry(join(dir, entry.name), entry.isDirectory())) continue;
      const skill = readSkill(join(dir, entry.name), entry.name, isEnabled, store);
      if (skill) skills.push(skill);
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function readSkill(
  skillDir: string,
  id: string,
  isEnabled: boolean,
  store: AppStore,
): Skill | null {
  const skillFile = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFile)) return null;

  const raw = readTextFile(skillFile);
  const { frontmatter, body } = splitFrontmatter(raw);
  const stats = statSync(skillFile);

  return {
    id,
    name: typeof frontmatter.name === 'string' ? frontmatter.name : id,
    description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
    body,
    files: listFiles(skillDir).filter((file) => file !== 'SKILL.md'),
    sizeBytes: directorySize(skillDir),
    modifiedAt: stats.mtime.toISOString(),
    groupIds: store.getGroupIdsFor('skill', id),
    isEnabled,
  };
}

/** Имя нового скилла уже занято — маршрут отвечает 409, а не пишет поверх. */
export class SkillExistsError extends Error {
  readonly skillId: string;

  constructor(skillId: string) {
    super(`Скилл «${skillId}» уже существует и сейчас выключен`);
    this.name = 'SkillExistsError';
    this.skillId = skillId;
  }
}

export function saveSkill(
  skillsDir: string,
  skillId: string | null,
  draft: SkillDraft,
  backupDir?: string,
): string | undefined {
  const id = skillId ?? slugifyName(draft.name);

  // Выключенный скилл физически лежит в skills-disabled/. Запись правки в
  // skills/ создала бы вторую, включённую копию: панель по-прежнему считает
  // скилл выключенным, а Claude его уже видит. Поэтому пишем туда, где скилл
  // лежит сейчас, — правка не меняет состояние включённости.
  const disabledDir = join(skillsDir, '..', SKILLS_DISABLED_DIR);
  const livesDisabled = !existsSync(join(skillsDir, id)) && existsSync(join(disabledDir, id));

  // СОЗДАНИЕ с занятым слагом — отказ, а не запись поверх: иначе новый черновик
  // затёр бы чужой скилл. Занят он выключенным (лежит в skills-disabled/, и
  // «созданный» скилл оказался бы сразу выключенным) или включённым — разницы
  // нет, теряется чужая работа. Слаги совпадают чаще, чем кажется: имена
  // режутся до 60 символов, так что «…руководство по стилю, часть первая» и
  // «…часть вторая» дают один и тот же id.
  if (skillId === null && (livesDisabled || existsSync(join(skillsDir, id))))
    throw new SkillExistsError(id);

  const base = livesDisabled ? disabledDir : skillsDir;
  const skillDir = join(base, id);
  mkdirSync(skillDir, { recursive: true });

  const skillFile = join(skillDir, 'SKILL.md');

  // Шапку пересобираем поверх лежащей на диске: allowed-tools, model, license
  // форма не знает, а молча их стереть — потеря данных в живом ~/.claude.
  // Сериализуем тем же yaml, которым разбираем: значение с двоеточием,
  // кавычками или переводом строки он закавычит сам. Собранная руками строка
  // такие значения ломала, и Claude Code переставал читать name/description.
  const existing = existsSync(skillFile)
    ? splitFrontmatter(readTextFile(skillFile)).frontmatter
    : {};
  const header: Record<string, unknown> = { name: draft.name, description: draft.description };
  for (const [key, value] of Object.entries(existing)) {
    if (key !== 'name' && key !== 'description') header[key] = value;
  }

  // lineWidth: 0 — иначе длинное описание сложится в несколько строк, и
  // запасной построчный разбор шапки увидит от него только первую.
  const frontmatter = `---\n${stringifyYaml(header, { lineWidth: 0 })}---`;

  // Пустой скилл бесполезен: без инструкций Claude нечего исполнять.
  // Поэтому вместо пустого файла кладём каркас с подсказками по разделам.
  const body = draft.body.trim() || buildSkillTemplate(draft.name);
  const content = `${frontmatter}\n\n${body}\n`;

  return writeTextFile(skillFile, content, { backupDir });
}

/** Каркас нового скилла: структура, которую потом остаётся наполнить. */
function buildSkillTemplate(name: string): string {
  return `# ${name}

## Когда применять

Опишите ситуацию, в которой этот скилл нужен. Поле description в шапке решает,
подключит ли Claude скилл вообще, а этот раздел уточняет границы применения.

## Что делать

1. Первый шаг.
2. Второй шаг.
3. Что считать результатом.

## Чего не делать

Явные запреты и типичные ошибки — их полезно перечислить отдельно.

## Как проверить результат

Команда, тест или признак, по которому видно, что работа сделана правильно.`;
}

/** Включение и выключение — перенос папки между skills/ и skills-disabled/. */
export function setSkillEnabled(skillsDir: string, skillId: string, isEnabled: boolean): void {
  const disabledDir = join(skillsDir, '..', SKILLS_DISABLED_DIR);
  const from = isEnabled ? join(disabledDir, skillId) : join(skillsDir, skillId);
  const to = isEnabled ? join(skillsDir, skillId) : join(disabledDir, skillId);

  if (!existsSync(from)) return;
  mkdirSync(join(to, '..'), { recursive: true });
  renameSync(from, to);
}

/**
 * Ошибка переименования с машиночитаемым кодом — маршрут по нему выбирает
 * статус ответа (404 против 400), а текст показывается пользователю как есть.
 */
function skillError(code: 'invalid_name' | 'not_found' | 'name_taken', message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Одна ли это папка на диске. Windows не различает регистр и слэши в пути. */
function pathsEqual(a: string, b: string): boolean {
  const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32'
    ? normalize(a).toLowerCase() === normalize(b).toLowerCase()
    : normalize(a) === normalize(b);
}

/**
 * Переименование скилла = переименование его папки + перенос отметок в state.json.
 *
 * Имя папки и есть идентификатор скилла, поэтому меняется именно папка. На
 * Windows прямой renameSync не годится в двух случаях: смена только регистра
 * («Foo» → «foo») — файловая система считает такие пути одним, — и кириллица
 * в имени. Поэтому переносим через промежуточную папку с ASCII-именем
 * поштучными операциями (copyRecursive/removeEntry), теми же, что надёжно
 * работают в safe-io. Выключенный скилл лежит в skills-disabled/ — там его и
 * переименовываем, оставляя выключенным.
 */
export function renameSkill(
  skillsDir: string,
  oldId: string,
  newIdRaw: string,
  store: AppStore,
  backupDir?: string,
): string | undefined {
  const newId = newIdRaw.trim();

  // Имя станет именем папки: пустое, со слэшами или «..» перепишет чужую папку
  // или выведет за пределы skills/ — отвергаем до любых файловых операций.
  if (!newId || /[/\\]/.test(newId) || newId === '.' || newId === '..' || newId.includes('\0')) {
    throw skillError('invalid_name', 'Недопустимое имя скилла.');
  }

  const disabledDir = join(skillsDir, '..', SKILLS_DISABLED_DIR);
  const base = existsSync(join(skillsDir, oldId))
    ? skillsDir
    : existsSync(join(disabledDir, oldId))
      ? disabledDir
      : undefined;
  if (!base) throw skillError('not_found', 'Скилл не найден.');

  const source = join(base, oldId);
  const target = join(base, newId);

  // Смена только регистра: source и target на Windows — одна папка, existsSync
  // вернёт true. Это не «занято», а ровно наш случай, поэтому проверяем отдельно.
  if (newId === oldId) return undefined; // точное совпадение — переименовывать нечего

  const caseOnly = pathsEqual(source, target);
  if (!caseOnly && existsSync(target)) {
    throw skillError('name_taken', 'Скилл с таким именем уже есть.');
  }

  const backupPath = backupDir
    ? backupEntry(source, backupDir, `${basename(base)}-${oldId}`)
    : undefined;

  // Промежуточная папка снимает и проблему регистра (source и target — одна
  // папка), и кириллицы (перенос идёт поштучно, а не рекурсивным cpSync).
  const staging = join(base, `.rename-${process.pid}-${Date.now()}`);
  copyRecursive(source, staging);
  removeEntry(source);
  copyRecursive(staging, target);
  removeEntry(staging);

  // Отметки в state.json (выключение, гашение группой, состав групп) завязаны
  // на старый id — переносим их на новый, иначе они осиротеют.
  store.renameEntity('skill', oldId, newId);

  return backupPath;
}

/**
 * Удаление скилла стирает папку целиком, и отменить это нечем — поэтому копия
 * снимается до `rmSync`. Скилл может лежать в обеих папках сразу (руками
 * положили и туда, и туда), и копии тогда различаются именем корня.
 */
export function deleteSkill(
  skillsDir: string,
  skillId: string,
  backupDir?: string,
): string | undefined {
  let backupPath: string | undefined;

  for (const dir of [
    join(skillsDir, skillId),
    join(skillsDir, '..', SKILLS_DISABLED_DIR, skillId),
  ]) {
    if (!existsSync(dir)) continue;

    const made = backupDir
      ? backupEntry(dir, backupDir, `${basename(dirname(dir))}-${skillId}`)
      : undefined;
    backupPath ??= made;

    // removeEntry, а не rmSync: у скилла может быть нелатинское имя, а
    // рекурсивный rmSync на такой папке рапортует об успехе, ничего не удалив.
    removeEntry(dir);
  }

  return backupPath;
}

/** Разделяет YAML-frontmatter и тело markdown. */
function splitFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };

  const header = match[1] ?? '';

  try {
    const parsed = parseYaml(header) as Record<string, unknown> | null;
    return { frontmatter: parsed ?? {}, body: match[2] ?? '' };
  } catch {
    // Строгий YAML падает на описаниях с двоеточием внутри значения
    // («аудит фронта: axe-core»), хотя сам Claude Code такие файлы читает.
    // Поэтому разбираем шапку построчно — терпимо, как это делает Claude.
    return { frontmatter: parseLooseFrontmatter(header), body: match[2] ?? '' };
  }
}

/**
 * Запасной разбор шапки: ключ до первого двоеточия, значение — весь остаток
 * строки. Кавычки по краям снимаются. Вложенные структуры не поддерживаются,
 * но в SKILL.md их и не бывает: там только name и description.
 */
function parseLooseFrontmatter(header: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const line of header.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!key || key.startsWith('#')) continue;

    if (value.length >= 2 && /^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    result[key] = value;
  }

  return result;
}

/**
 * Директория ли это с учётом симлинков. statSync идёт по ссылке, поэтому
 * junction на папку отвечает true — в отличие от Dirent.isDirectory().
 */
function isDirectoryEntry(path: string, isDirent: boolean): boolean {
  if (isDirent) return true;
  try {
    return statSync(path).isDirectory();
  } catch {
    // Битая ссылка — пропускаем запись, а не роняем весь список скиллов.
    return false;
  }
}

function listFiles(dir: string, prefix = ''): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...listFiles(join(dir, entry.name), relative));
    else result.push(relative);
  }
  return result;
}

function directorySize(dir: string): number {
  return listFiles(dir).reduce((total, file) => total + statSync(join(dir, file)).size, 0);
}

/**
 * Имя папки скилла из имени, введённого человеком.
 *
 * Слаг общий с правилами (`lib/slug.ts`), потому что здесь он не украшение, а
 * путь на диске: до транслитерации русское имя («Проверка кода») давало пустую
 * строку, `join(skillsDir, '')` указывал на САМ каталог skills/, и панель
 * писала `skills/SKILL.md` — скилл не появлялся в списке, а следующее такое же
 * имя молча затирало этот файл.
 *
 * Из имени вообще без букв и цифр (иероглифы, только эмодзи) слага не выйдет —
 * тогда отказываем с внятным текстом, а не пишем непонятно куда. `statusCode`
 * читает Fastify: маршрут отвечает 400, а не 500.
 */
function slugifyName(name: string): string {
  const id = slugify(name);
  if (id) return id;

  throw Object.assign(
    new Error(
      'Из имени не получается имя папки. Добавьте в название латиницу, кириллицу или цифры.',
    ),
    { statusCode: 400, code: 'invalid_name' },
  );
}
