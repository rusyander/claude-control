import {
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Skill, SkillDraft } from '@claude-control/contracts';
import { readTextFile, writeTextFile } from '../lib/safe-io.ts';
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

const DISABLED_DIR_NAME = 'skills-disabled';

export function readSkills(skillsDir: string, store: AppStore): Skill[] {
  const skills: Skill[] = [];
  const disabledDir = join(skillsDir, '..', DISABLED_DIR_NAME);

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

export function saveSkill(
  skillsDir: string,
  skillId: string | null,
  draft: SkillDraft,
  backupDir?: string,
): string | undefined {
  const id = skillId ?? slugifyName(draft.name);
  const skillDir = join(skillsDir, id);
  mkdirSync(skillDir, { recursive: true });

  const frontmatter = [
    '---',
    `name: ${draft.name}`,
    `description: ${draft.description}`,
    '---',
  ].join('\n');

  // Пустой скилл бесполезен: без инструкций Claude нечего исполнять.
  // Поэтому вместо пустого файла кладём каркас с подсказками по разделам.
  const body = draft.body.trim() || buildSkillTemplate(draft.name);
  const content = `${frontmatter}\n\n${body}\n`;

  return writeTextFile(join(skillDir, 'SKILL.md'), content, { backupDir });
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
  const disabledDir = join(skillsDir, '..', DISABLED_DIR_NAME);
  const from = isEnabled ? join(disabledDir, skillId) : join(skillsDir, skillId);
  const to = isEnabled ? join(skillsDir, skillId) : join(disabledDir, skillId);

  if (!existsSync(from)) return;
  mkdirSync(join(to, '..'), { recursive: true });
  renameSync(from, to);
}

export function deleteSkill(skillsDir: string, skillId: string): void {
  for (const dir of [join(skillsDir, skillId), join(skillsDir, '..', DISABLED_DIR_NAME, skillId)]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
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

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Содержимое вложенного файла скилла. Путь приходит из запроса, поэтому он
 * проверяется: за пределы папки скилла выйти нельзя, а двоичные файлы и
 * слишком большие тексты не отдаются — читать их в браузере нечем.
 */
export function readSkillFile(skillsDir: string, skillId: string, file: string): string {
  const skillDir = join(skillsDir, skillId.replace(/[^a-zA-Z0-9._-]/g, ''));
  const target = resolve(skillDir, file);

  if (!target.startsWith(resolve(skillDir))) return '';
  if (!existsSync(target)) return '';
  if (statSync(target).size > 512 * 1024) return '// Файл слишком большой для просмотра';

  return readFileSync(target, 'utf8');
}

/** Безопасный путь внутри папки скилла: наружу выйти нельзя. */
function resolveInsideSkill(skillsDir: string, skillId: string, file: string): string | undefined {
  const skillDir = resolve(join(skillsDir, skillId.replace(/[^a-zA-Z0-9._-]/g, '')));
  const target = resolve(skillDir, file);

  // Сравниваем с разделителем на конце, иначе `skills/foo-evil` пройдёт
  // проверку на префикс `skills/foo`.
  return target === skillDir || target.startsWith(`${skillDir}${sep}`) ? target : undefined;
}

/** Запись файла скилла — создаёт недостающие папки по пути. */
export function writeSkillFile(
  skillsDir: string,
  skillId: string,
  file: string,
  content: string,
  backupDir?: string,
): void {
  const target = resolveInsideSkill(skillsDir, skillId, file);
  if (!target) throw new Error('Путь выходит за пределы скилла');

  mkdirSync(dirname(target), { recursive: true });
  writeTextFile(target, content, { backupDir });
}

/** Удаление файла или папки целиком. */
export function deleteSkillFile(skillsDir: string, skillId: string, file: string): void {
  const target = resolveInsideSkill(skillsDir, skillId, file);
  if (!target || !existsSync(target)) return;

  rmSync(target, { recursive: true, force: true });
}

/** Переименование или перенос внутри скилла. */
export function moveSkillFile(skillsDir: string, skillId: string, from: string, to: string): void {
  const source = resolveInsideSkill(skillsDir, skillId, from);
  const target = resolveInsideSkill(skillsDir, skillId, to);
  if (!source || !target || !existsSync(source)) throw new Error('Неверный путь');

  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
}
