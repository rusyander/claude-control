import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { GroupOverrideView } from '@agentdeck/contracts/group-sources';
import { GROUP_OVERRIDE_FILE, GROUP_OVERRIDE_MARKER } from '@agentdeck/contracts/group-sources';
import {
  projectKey,
  readGroupSources,
  updateGroupSources,
  type OverrideRecord,
} from '../../../lib/app-store/group-sources.ts';
import { GroupRequestError } from '../errors.ts';

/**
 * Переопределение в проекте: ОДИН файл правила `.claude/rules/agentdeck-group.local.md`
 * (CLI грузит правила каталога сам), строка в `.git/info/exclude`, чтобы файл не
 * ушёл в коммит, и — если одного текста мало — запреты `Skill(<id>)` в
 * `settings.local.json` проекта.
 *
 * Главное свойство — ВЫКЛЮЧЕНИЕ ВОЗВРАЩАЕТ ПРОЕКТ БАЙТ В БАЙТ. Поэтому запись
 * хранит не «что добавили», а байты каждого тронутого файла ДО панели и каталоги,
 * которых не было. Файл никто не менял после нас — кладутся прежние байты
 * (или файл удаляется); менял — снимается ровно своё, чужая правка остаётся.
 *
 * У самого файла правила «своё» — блок между меткой и концом блока. Человек
 * дописал что-то ниже — при выключении снимается только блок, а дописанное
 * остаётся файлом человека с шапкой, что панель его больше не ведёт (F-256);
 * новый текст включённого переопределения меняет тоже только блок.
 */

const MARKER_LINE = `<!-- ${GROUP_OVERRIDE_MARKER} -->`;
const END_LINE = `<!-- /${GROUP_OVERRIDE_MARKER} -->`;
/**
 * Шапка файла, оставшегося человеку. По-английски: файл читает модель (CLI
 * грузит правила каталога). Метки в ней нет — включение такой файл не тронет.
 */
const HUMAN_HEADER =
  '<!-- No longer managed by agentdeck: its override block was removed. The rest of this file is yours, and the CLI still loads it. -->';
const EXCLUDE_MARKER = `# ${GROUP_OVERRIDE_MARKER}`;
const BOM = '\uFEFF';
const SETTINGS_LOCAL = '.claude/settings.local.json';

/** Каталоги пути, которых ещё нет, — от внешнего к внутреннему. */
function missingDirs(dir: string, stop: string): string[] {
  const missing: string[] = [];
  for (let current = dir; current !== stop && !existsSync(current); current = dirname(current)) {
    missing.unshift(current);
    if (dirname(current) === current) break;
  }
  return missing;
}

function readBytes(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'latin1') : null;
}

/** Текст файла правила без BOM (Блокнот его ставит, и метка переставала узнаваться). */
function readRuleText(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : null;
}

/** Блок панели в файле правила. */
function panelBlock(text: string): string {
  return `${MARKER_LINE}\n${text.trim()}\n${END_LINE}\n`;
}

/**
 * Хвост человека под блоком панели. Граница — строка конца блока; файл без неё
 * (записан до неё) — по байтам блока из записи. `undefined` — файл не начинается
 * с метки или границу не найти: чьё что, сказать нечем.
 */
function humanTail(text: string, block: string | undefined): string | undefined {
  if (!text.startsWith(MARKER_LINE)) return undefined;
  const lines = text.split('\n');
  const end = lines.findIndex((line) => line.replace(/\r$/, '') === END_LINE);
  if (end >= 0) return lines.slice(end + 1).join('\n');
  if (block !== undefined && text.startsWith(block)) return text.slice(block.length);
  return undefined;
}

/** Байты назад: `null` — файла не было, и его не должно остаться. */
function restoreBytes(file: string, original: string | null): void {
  if (original === null) rmSync(file, { force: true });
  else writeFileSync(file, original, 'latin1');
}

/** Снять пустые каталоги, заведённые панелью, — от внутреннего к внешнему. */
function removeCreatedDirs(dirs: readonly string[]): void {
  for (const dir of [...dirs].reverse()) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // Каталог занят чужим файлом — остаётся: это уже не наш каталог.
    }
  }
}

/**
 * Файл исключений гита проекта. `git rev-parse` знает и копию ветки (там
 * `.git` — файл), и нестандартный каталог; без гита — обычный `.git/info`.
 * Проект не под гитом — исключать нечего.
 */
export function excludeFileOf(root: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    }).trim();
    if (out) return isAbsolute(out) ? out : resolve(root, out);
  } catch {
    // Не репозиторий или гита нет — смотрим сами.
  }
  const dotGit = join(root, '.git');
  return existsSync(dotGit) ? join(dotGit, 'info', 'exclude') : undefined;
}

function excludeBlock(patterns: readonly string[]): string {
  return [EXCLUDE_MARKER, ...patterns.map((pattern) => `/${pattern}`)].join('\n') + '\n';
}

/**
 * Снять из текста исключений ровно свой блок: метку и свои строки СРАЗУ под
 * ней. Такая же строка в другом месте файла — человека (ревью 28.09: своя
 * `/.claude/settings.local.json` уходила вместе с нашей, и файл становился
 * коммитируемым).
 */
function withoutExcludeBlock(text: string, patterns: readonly string[]): string {
  const lines = text.split('\n');
  const bare = (line: string): string => line.replace(/\r$/, '');
  const at = lines.findIndex((line) => bare(line) === EXCLUDE_MARKER);
  if (at < 0) return text;
  const own = new Set(patterns.map((pattern) => `/${pattern}`));
  let end = at + 1;
  while (end < lines.length && own.has(bare(lines[end]!))) {
    own.delete(bare(lines[end]!));
    end += 1;
  }
  return [...lines.slice(0, at), ...lines.slice(end)].join('\n');
}

export interface OverrideInput {
  groupId: string;
  projectPath: string;
  /** Текст правила (без метки): от модели или запасной шаблон. */
  text: string;
  /** Скиллы проекта под запрет `Skill(<id>)`; пусто — только текст. */
  denySkills?: readonly string[];
  now?: string;
}

function viewOf(root: string, record?: OverrideRecord): GroupOverrideView {
  return {
    enabled: record !== undefined,
    file: join(root, GROUP_OVERRIDE_FILE),
    ...(record?.deny ? { deny: record.deny.entries } : {}),
  };
}

export function readOverride(appData: string, projectPath: string): GroupOverrideView {
  return viewOf(projectPath, readGroupSources(appData).overrides[projectKey(projectPath)]);
}

function writeDeny(
  root: string,
  skills: readonly string[],
  created: string[],
): OverrideRecord['deny'] | undefined {
  const file = join(root, SETTINGS_LOCAL);
  const original = readBytes(file);
  let settings: { permissions?: { deny?: unknown } } & Record<string, unknown> = {};
  if (original !== null) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as typeof settings;
    } catch {
      // Битый личный файл проекта панель не переписывает: без запретов, только текст.
      return undefined;
    }
  }
  const deny = Array.isArray(settings.permissions?.deny)
    ? [...(settings.permissions.deny as string[])]
    : [];
  const entries = skills.map((id) => `Skill(${id})`).filter((entry) => !deny.includes(entry));
  if (entries.length === 0) return undefined;
  created.push(...missingDirs(dirname(file), root));
  mkdirSync(dirname(file), { recursive: true });
  const next = {
    ...settings,
    permissions: { ...settings.permissions, deny: [...deny, ...entries] },
  };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  // Записанное запоминается байтами, как и прежнее: сравнение при выключении — побайтное.
  return { file, entries, original, written: readBytes(file) ?? '' };
}

/**
 * Снять свои запреты: файл не правили после нас — прежние байты; правили —
 * только свои строки, остальное не наше (BOM Блокнота снимается, как при
 * включении). `false` — файл больше не JSON, снять нечем.
 */
function removeDeny(deny: NonNullable<OverrideRecord['deny']>): boolean {
  const now = readBytes(deny.file);
  if (now === deny.written) {
    restoreBytes(deny.file, deny.original);
    return true;
  }
  if (now === null) return true;
  try {
    const text = readFileSync(deny.file, 'utf8');
    const bom = text.startsWith(BOM) ? BOM : '';
    const settings = JSON.parse(text.slice(bom.length)) as { permissions?: { deny?: string[] } };
    const own = new Set(deny.entries);
    if (settings.permissions?.deny) {
      settings.permissions.deny = settings.permissions.deny.filter((entry) => !own.has(entry));
    }
    writeFileSync(deny.file, `${bom}${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Запреты, что лежат в файле сейчас; не прочёлся — `undefined`. */
function denyInFile(file: string): string[] | undefined {
  if (!existsSync(file)) return [];
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as {
      permissions?: { deny?: unknown };
    };
    const deny = settings.permissions?.deny;
    return Array.isArray(deny)
      ? deny.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return undefined;
  }
}

/**
 * Сменился ли состав своих запретов: другая глобальная группа включила
 * переопределение или у проектной группы появились скиллы. Запреты, которые
 * человек поставил сам, своими не считаются — их панель не пишет и не снимает.
 */
function denyChanged(
  root: string,
  previous: OverrideRecord['deny'],
  skills: readonly string[],
): boolean {
  const inFile = denyInFile(join(root, SETTINGS_LOCAL));
  if (inFile === undefined) return false;
  const own = new Set(previous?.entries ?? []);
  const human = new Set(inFile.filter((entry) => !own.has(entry)));
  const wanted = skills.map((id) => `Skill(${id})`).filter((entry) => !human.has(entry));
  return wanted.length !== own.size || wanted.some((entry) => !own.has(entry));
}

/** Включить (или обновить текст включённого) переопределения. */
export function enableOverride(appData: string, input: OverrideInput): GroupOverrideView {
  const root = input.projectPath;
  if (!existsSync(root)) {
    throw new GroupRequestError(404, 'project_missing', 'group-project-missing');
  }
  const key = projectKey(root);
  const previous = readGroupSources(appData).overrides[key];
  const file = join(root, GROUP_OVERRIDE_FILE);
  const current = readRuleText(file);
  if (current !== null && !current.startsWith(MARKER_LINE)) {
    throw new GroupRequestError(409, 'override_foreign_file', 'group-override-foreign-file', {
      file: GROUP_OVERRIDE_FILE,
    });
  }

  const createdDirs = previous?.createdDirs ?? missingDirs(dirname(file), root);
  mkdirSync(dirname(file), { recursive: true });
  // Новый текст меняет только блок: дописанное человеком ниже остаётся.
  const block = panelBlock(input.text);
  const tail = current === null ? '' : (humanTail(current, previous?.ruleBlock) ?? '');
  writeFileSync(file, `${block}${tail}`, 'utf8');

  // Исключения ставятся один раз, при первом включении: повтор (новый текст) не
  // должен запоминать «до панели» уже наши же байты. Запреты — тоже, пока их
  // состав тот же; сменился (другая группа, новый скилл проекта) — свои старые
  // снимаются (байты «до панели» возвращаются) и пишутся новые поверх них.
  let deny = previous?.deny;
  const denyDirs: string[] = [];
  const skills = input.denySkills ?? [];
  if (!previous) {
    if (skills.length) deny = writeDeny(root, skills, denyDirs);
  } else if (denyChanged(root, previous.deny, skills)) {
    if (!previous.deny || removeDeny(previous.deny)) {
      deny = skills.length ? writeDeny(root, skills, denyDirs) : undefined;
    }
  }

  let exclude = previous?.exclude;
  if (!previous) {
    const excludeFile = excludeFileOf(root);
    if (excludeFile) {
      const patterns = [GROUP_OVERRIDE_FILE, ...(deny?.original === null ? [SETTINGS_LOCAL] : [])];
      const original = readBytes(excludeFile);
      const base = original ?? '';
      const glue = base === '' || base.endsWith('\n') ? '' : '\n';
      const written = `${base}${glue}${excludeBlock(patterns)}`;
      const dirs = missingDirs(dirname(excludeFile), root);
      mkdirSync(dirname(excludeFile), { recursive: true });
      writeFileSync(excludeFile, written, 'latin1');
      exclude = { file: excludeFile, original, written, createdDirs: dirs };
    }
  }

  const record: OverrideRecord = {
    groupId: input.groupId,
    projectPath: root,
    file,
    ruleBlock: block,
    createdDirs: [...createdDirs, ...denyDirs.filter((dir) => !createdDirs.includes(dir))],
    ...(exclude ? { exclude } : {}),
    ...(deny ? { deny } : {}),
    writtenAt: input.now ?? new Date().toISOString(),
  };
  updateGroupSources(appData, (state) => {
    state.overrides[key] = record;
  });
  return viewOf(root, record);
}

/**
 * Выключить: проект — байт в байт как до включения. `groupId` — чья это
 * просьба: запись другой группы на том же пути не снимается, у просящей группы
 * переопределения здесь просто нет.
 */
export function disableOverride(
  appData: string,
  projectPath: string,
  groupId?: string,
): GroupOverrideView {
  const key = projectKey(projectPath);
  const record = readGroupSources(appData).overrides[key];
  if (!record || (groupId !== undefined && record.groupId !== groupId)) {
    return viewOf(projectPath);
  }

  // Снимается блок панели. Под ним человек что-то дописал — файл остаётся его,
  // с шапкой без метки; нет — файла не было до панели, и его не остаётся.
  const rule = readRuleText(record.file);
  if (rule !== null && rule.startsWith(MARKER_LINE)) {
    const tail = humanTail(rule, record.ruleBlock);
    if (tail === undefined || tail.trim() === '') rmSync(record.file, { force: true });
    else writeFileSync(record.file, `${HUMAN_HEADER}\n${tail.replace(/^(\r?\n)+/, '')}`, 'utf8');
  }

  // Файл больше не JSON: снять запреты нечем. Запись о них остаётся — иначе
  // `Skill(…)` в проекте осталась бы навсегда без способа её снять.
  const denyLeft = record.deny && !removeDeny(record.deny) ? record.deny : undefined;

  if (record.exclude) {
    const now = readBytes(record.exclude.file);
    if (now === record.exclude.written) restoreBytes(record.exclude.file, record.exclude.original);
    else if (now !== null) {
      // Ровно то, что записало включение: `settings.local.json` — только если его не было.
      const patterns = [
        GROUP_OVERRIDE_FILE,
        ...(record.deny?.original === null ? [SETTINGS_LOCAL] : []),
      ];
      writeFileSync(record.exclude.file, withoutExcludeBlock(now, patterns), 'latin1');
    }
    removeCreatedDirs(record.exclude.createdDirs);
  }

  removeCreatedDirs(record.createdDirs);
  updateGroupSources(appData, (state) => {
    if (denyLeft) {
      const { exclude: _done, ...rest } = record;
      state.overrides[key] = { ...rest, createdDirs: [], deny: denyLeft };
    } else delete state.overrides[key];
  });
  return viewOf(projectPath, denyLeft ? readGroupSources(appData).overrides[key] : undefined);
}

/**
 * Запасной текст правила, когда модель не ответила: называет, чему не
 * следовать и что взять взамен. По-английски — это инструкция модели.
 */
export function fallbackOverrideText(input: {
  globalName: string;
  globalSkills: readonly string[];
  projectName: string;
  projectItems: readonly string[];
}): string {
  const lines = [
    `# Follow the global group "${input.globalName}" in this project`,
    '',
    `In this project, do not follow the working order of the project group "${input.projectName}".`,
  ];
  if (input.projectItems.length > 0) {
    lines.push(
      '',
      'Do not use these project items:',
      ...input.projectItems.map((item) => `- ${item}`),
    );
  }
  if (input.globalSkills.length > 0) {
    lines.push('', 'Use these instead:', ...input.globalSkills.map((item) => `- skill ${item}`));
  }
  lines.push(
    '',
    'Facts about this codebase from project rules (paths, commands, conventions) remain valid; only the working order and the replaced skills change.',
  );
  return lines.join('\n');
}
