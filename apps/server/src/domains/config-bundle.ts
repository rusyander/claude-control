import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import type { ClaudePaths } from '@claude-control/contracts';
import {
  readTextFile,
  writeTextFile,
  readJsonFile,
  writeJsonFile,
  backupEntry,
} from '../lib/safe-io.ts';

/**
 * Бандл конфигурации — правила + скиллы + хуки одним JSON-файлом, чтобы
 * перенести настройку на другую машину или поделиться ей. Это НЕ снимок
 * state.json (группы/сценарии/отметки панели): бандл собирает реальную
 * конфигурацию Claude Code — текст CLAUDE.md, папки скиллов с файлами и записи
 * хуков из settings.json.
 *
 * Применение бандла меняет живые файлы, поэтому:
 *   - каждая запись идёт под резервную копию (backupDir);
 *   - правила по умолчанию НЕ затираются, а дописываются (режим выбирается);
 *   - существующий скилл без флага не перезаписывается;
 *   - путь файла скилла проверяется на выход за пределы своей папки (`..`,
 *     абсолютные пути) — иначе подсунутый бандл записал бы файл куда угодно.
 */

/** Версия формата бандла. Растёт при несовместимых изменениях структуры. */
export const BUNDLE_FORMAT_VERSION = 1;

/** Как поступить с правилами (CLAUDE.md) при импорте. */
export type RulesImportMode = 'append' | 'replace' | 'skip';

/** Расширения, которые храним как base64: текстом их не показать и не собрать обратно. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.wasm',
]);

export interface BundleSkillFile {
  /** Путь от корня папки скилла, всегда через прямой слэш. */
  path: string;
  /** Содержимое: текст (utf8) или base64 для двоичных файлов. */
  content: string;
  encoding: 'utf8' | 'base64';
}

export interface BundleSkill {
  /** Имя папки скилла — оно же идентификатор. */
  name: string;
  files: BundleSkillFile[];
}

export interface BundleHook {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

export interface ConfigBundle {
  formatVersion: number;
  /** Когда собран. Берётся из запроса/часов ОС, а не выдумывается доменом. */
  exportedAt: string;
  /** Весь текст CLAUDE.md как есть. */
  rules: { claudeMd: string };
  skills: BundleSkill[];
  hooks: BundleHook[];
}

export interface ImportBundleOptions {
  /** Что делать с правилами. По умолчанию — дописать (не затирать). */
  rulesMode?: RulesImportMode;
  /** Перезаписывать ли существующие папки скиллов. По умолчанию — нет. */
  overwriteSkills?: boolean;
}

export interface ImportBundleSummary {
  rulesMode: RulesImportMode;
  rulesApplied: boolean;
  skillsCreated: string[];
  skillsSkipped: string[];
  hooksAdded: number;
  hooksSkipped: number;
  /** Пути к резервным копиям всех затронутых файлов/папок. */
  backupPaths: string[];
}

// --- Сборка ---

/**
 * Собирает бандл из живой конфигурации. `exportedAt` приходит извне (запрос или
 * часы ОС) — домен не выдумывает дату сам, чтобы сборку можно было воспроизвести
 * в тесте с фиксированным значением.
 */
export function buildConfigBundle(paths: ClaudePaths, exportedAt: string): ConfigBundle {
  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    exportedAt,
    rules: { claudeMd: readTextFile(paths.claudeMd) },
    skills: collectSkills(paths.skills),
    hooks: collectHooks(paths.settings),
  };
}

/** Каждая папка верхнего уровня в skills/ — отдельный скилл со своими файлами. */
function collectSkills(skillsDir: string): BundleSkill[] {
  if (!existsSync(skillsDir)) return [];

  const skills: BundleSkill[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const skillDir = join(skillsDir, entry.name);
    if (!isDirectory(skillDir, entry.isDirectory())) continue;

    const files = walkFiles(skillDir).map((relative) => readBundleFile(skillDir, relative));
    skills.push({ name: entry.name, files });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function readBundleFile(skillDir: string, relative: string): BundleSkillFile {
  const abs = join(skillDir, ...relative.split('/'));
  if (isBinaryPath(relative)) {
    return { path: relative, content: readFileSync(abs).toString('base64'), encoding: 'base64' };
  }
  return { path: relative, content: readFileSync(abs, 'utf8'), encoding: 'utf8' };
}

interface RawHookCommand {
  command: string;
  timeout?: number;
}
interface RawMatcherGroup {
  matcher?: string;
  hooks: RawHookCommand[];
}
interface RawSettings {
  hooks?: Record<string, RawMatcherGroup[]>;
  [key: string]: unknown;
}

/** Разворачивает вложенные хуки settings.json (событие → matcher → команды) в плоский список. */
function collectHooks(settingsPath: string): BundleHook[] {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const result: BundleHook[] = [];

  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const command of group.hooks ?? []) {
        const hook: BundleHook = { event, command: command.command };
        if (group.matcher !== undefined) hook.matcher = group.matcher;
        if (command.timeout !== undefined) hook.timeout = command.timeout;
        result.push(hook);
      }
    }
  }

  return result;
}

// --- Разбор и проверка ---

/**
 * Проверяет структуру бандла вручную и возвращает типизированное значение.
 *
 * Ручная проверка, а не zod: contracts тянется в сервер только как тип (его
 * баррель роняет рантайм, см. settings-validation.ts). Бандл приходит с чужой
 * машины — доверять ему нельзя, поэтому проверяем каждое поле до записи.
 */
export function parseConfigBundle(raw: unknown): ConfigBundle {
  if (!isRecord(raw)) throw bundleError('Бандл должен быть объектом.');

  if (typeof raw.formatVersion !== 'number') {
    throw bundleError('В бандле нет числового поля formatVersion.');
  }
  if (raw.formatVersion > BUNDLE_FORMAT_VERSION) {
    throw bundleError(
      `Версия формата бандла (${raw.formatVersion}) новее поддерживаемой (${BUNDLE_FORMAT_VERSION}).`,
    );
  }

  const rules = raw.rules;
  if (!isRecord(rules) || typeof rules.claudeMd !== 'string') {
    throw bundleError('Поле rules.claudeMd должно быть строкой.');
  }

  if (!Array.isArray(raw.skills)) throw bundleError('Поле skills должно быть массивом.');
  const skills = raw.skills.map(parseSkill);

  if (!Array.isArray(raw.hooks)) throw bundleError('Поле hooks должно быть массивом.');
  const hooks = raw.hooks.map(parseHook);

  return {
    formatVersion: raw.formatVersion,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    rules: { claudeMd: rules.claudeMd },
    skills,
    hooks,
  };
}

function parseSkill(value: unknown, index: number): BundleSkill {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) {
    throw bundleError(`Скилл #${index + 1}: отсутствует имя.`);
  }
  if (!Array.isArray(value.files)) {
    throw bundleError(`Скилл «${value.name}»: поле files должно быть массивом.`);
  }

  const files = value.files.map((file, fileIndex): BundleSkillFile => {
    if (
      !isRecord(file) ||
      typeof file.path !== 'string' ||
      typeof file.content !== 'string' ||
      (file.encoding !== 'utf8' && file.encoding !== 'base64')
    ) {
      throw bundleError(`Скилл «${value.name}»: файл #${fileIndex + 1} имеет неверную структуру.`);
    }
    return { path: file.path, content: file.content, encoding: file.encoding };
  });

  return { name: value.name, files };
}

function parseHook(value: unknown, index: number): BundleHook {
  if (!isRecord(value) || typeof value.event !== 'string' || typeof value.command !== 'string') {
    throw bundleError(`Хук #${index + 1}: обязательны строковые event и command.`);
  }
  const hook: BundleHook = { event: value.event, command: value.command };
  if (typeof value.matcher === 'string') hook.matcher = value.matcher;
  if (typeof value.timeout === 'number') hook.timeout = value.timeout;
  return hook;
}

// --- Применение ---

/**
 * Применяет бандл к живой конфигурации. Сначала — сплошная проверка путей всех
 * файлов скиллов (traversal отвергается ДО любой записи, чтобы частично
 * применённый бандл не оставил файлов за пределами skills/), затем правила,
 * скиллы и хуки. Каждая запись — под резервную копию.
 */
export function applyConfigBundle(
  paths: ClaudePaths,
  bundle: ConfigBundle,
  options: ImportBundleOptions = {},
  backupDir?: string,
): ImportBundleSummary {
  // Проверка безопасности до записей: имя каждого скилла и путь каждого файла
  // должны оставаться строго внутри своей папки в skills/.
  for (const skill of bundle.skills) {
    const skillDir = safeSkillDir(paths.skills, skill.name);
    for (const file of skill.files) safeFilePath(skillDir, file.path);
  }

  const rulesMode: RulesImportMode = options.rulesMode ?? 'append';
  const backupPaths: string[] = [];
  const record = (path: string | undefined): void => {
    if (path) backupPaths.push(path);
  };

  const rulesApplied = applyRules(paths.claudeMd, bundle, rulesMode, backupDir, record);

  const skillsCreated: string[] = [];
  const skillsSkipped: string[] = [];
  for (const skill of bundle.skills) {
    const skillDir = safeSkillDir(paths.skills, skill.name);
    // Существующий скилл без флага не трогаем: молча затереть чужую папку нельзя.
    if (existsSync(skillDir) && !options.overwriteSkills) {
      skillsSkipped.push(skill.name);
      continue;
    }
    if (existsSync(skillDir) && backupDir) {
      record(backupEntry(skillDir, backupDir, `skills-${skill.name}`));
    }
    for (const file of skill.files) writeSkillFile(skillDir, file, backupDir, record);
    skillsCreated.push(skill.name);
  }

  const { added, skipped, backupPath } = applyHooks(paths.settings, bundle.hooks, backupDir);
  record(backupPath);

  return {
    rulesMode,
    rulesApplied,
    skillsCreated,
    skillsSkipped,
    hooksAdded: added,
    hooksSkipped: skipped,
    backupPaths,
  };
}

function applyRules(
  claudeMdPath: string,
  bundle: ConfigBundle,
  mode: RulesImportMode,
  backupDir: string | undefined,
  record: (path: string | undefined) => void,
): boolean {
  const incoming = bundle.rules.claudeMd;
  if (mode === 'skip' || !incoming.trim()) return false;

  if (mode === 'replace') {
    record(writeTextFile(claudeMdPath, incoming, { backupDir }));
    return true;
  }

  // append: дописываем блок в конец, не трогая существующий текст.
  const existing = readTextFile(claudeMdPath);
  const marker = `<!-- Импортировано из бандла конфигурации${
    bundle.exportedAt ? ` (${bundle.exportedAt})` : ''
  } -->`;
  const combined = existing.trim()
    ? `${existing.trimEnd()}\n\n${marker}\n\n${incoming.trim()}\n`
    : `${incoming.trim()}\n`;
  record(writeTextFile(claudeMdPath, combined, { backupDir }));
  return true;
}

function writeSkillFile(
  skillDir: string,
  file: BundleSkillFile,
  backupDir: string | undefined,
  record: (path: string | undefined) => void,
): void {
  const target = safeFilePath(skillDir, file.path);

  if (file.encoding === 'base64') {
    if (backupDir)
      record(backupEntry(target, backupDir, `skillfile-${file.path.replace(/\//g, '-')}`));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(file.content, 'base64'));
    return;
  }

  record(writeTextFile(target, file.content, { backupDir }));
}

/**
 * Дописывает хуки бандла в settings.json, сливая их с уже существующими по той
 * же схеме, что и Claude Code (событие → matcher-группа → команды). Полный дубль
 * (та же команда в той же группе) не добавляется повторно.
 */
function applyHooks(
  settingsPath: string,
  hooks: BundleHook[],
  backupDir?: string,
): { added: number; skipped: number; backupPath: string | undefined } {
  if (hooks.length === 0) return { added: 0, skipped: 0, backupPath: undefined };

  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const grouped: Record<string, RawMatcherGroup[]> = settings.hooks ?? {};
  let added = 0;
  let skipped = 0;

  for (const hook of hooks) {
    const groups = (grouped[hook.event] ??= []);
    let group = groups.find((item) => item.matcher === hook.matcher);
    if (!group) {
      group = hook.matcher !== undefined ? { matcher: hook.matcher, hooks: [] } : { hooks: [] };
      groups.push(group);
    }

    if (group.hooks.some((command) => command.command === hook.command)) {
      skipped += 1;
      continue;
    }

    const command: RawHookCommand & { type: string } = { type: 'command', command: hook.command };
    if (hook.timeout !== undefined) command.timeout = hook.timeout;
    group.hooks.push(command);
    added += 1;
  }

  settings.hooks = grouped;
  const backupPath = writeJsonFile(settingsPath, settings, { backupDir });
  return { added, skipped, backupPath };
}

// --- Безопасность путей ---

/**
 * Папка скилла внутри skills/. Имя приходит из бандла и становится именем папки:
 * пустое, со слэшами или «..» вывело бы за пределы skills/ — отвергаем. Кириллицу
 * не режем: имена скиллов бывают нелатинскими, а traversal ловится по слэшам и точкам.
 */
function safeSkillDir(skillsDir: string, name: string): string {
  const trimmed = name.trim();
  if (
    !trimmed ||
    /[/\\]/.test(trimmed) ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('\0')
  ) {
    throw bundleError(`Небезопасное имя скилла: «${name}».`);
  }
  return join(skillsDir, trimmed);
}

/**
 * Абсолютный путь файла внутри папки скилла. Путь из бандла не должен уводить
 * наружу: абсолютные пути, `..` и выход за пределы папки отвергаются. Проверка
 * двойная — по строке и по резольву, — потому что цена ошибки высока.
 */
function safeFilePath(skillDir: string, relative: string): string {
  const trimmed = relative.trim();
  if (!trimmed || trimmed.includes('\0')) {
    throw bundleError('Пустой путь файла скилла в бандле.');
  }

  const normalized = trimmed.replace(/\\/g, '/');
  // Абсолютные пути (`/x`, `C:/x`) и любой сегмент `..` — уход за пределы папки.
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw bundleError(`Абсолютный путь файла скилла запрещён: «${relative}».`);
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw bundleError(`Путь файла скилла выходит за пределы папки: «${relative}».`);
  }

  const base = resolve(skillDir);
  const target = resolve(base, normalized);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw bundleError(`Путь файла скилла выходит за пределы папки: «${relative}».`);
  }
  return target;
}

// --- Мелочи ---

function bundleError(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_bundle' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDirectory(path: string, isDirent: boolean): boolean {
  if (isDirent) return true;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isBinaryPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function walkFiles(dir: string, prefix = ''): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...walkFiles(join(dir, entry.name), relative));
    else result.push(relative);
  }
  return result;
}
