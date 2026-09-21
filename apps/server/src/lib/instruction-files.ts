import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  InstructionFileEntry,
  InstructionFilesNote,
  InstructionFilesView,
} from '@agentdeck/contracts';
// Значения — подпутём: сервер идёт под `--experimental-strip-types` (AGENTS.md).
import { instructionFilesModes } from '@agentdeck/contracts/instructions';
import type { InstructionFilesMode, InstructionFilesSource } from '@agentdeck/contracts';
import { readJsonFile } from './safe-io.ts';
import { coded } from './server-text.ts';

/**
 * Какой файл инструкций читает сам Claude Code (2.1.277+).
 *
 * ОДИН резолвер на обе половины панели — тот же приём, что `portability/project.ts`
 * держит для уровня: разделы «Правила» и «Инструкции», проектные маршруты и
 * импортёр среды спрашивают имя ЗДЕСЬ, и ни один из них не знает его константой.
 *
 * Имя файла перестало быть константой: с ключом `instructionFiles` в настройках
 * CLI читает `CLAUDE.md`, `AGENTS.md`, оба сразу или ни одного. Импортёр обязан
 * брать источник ПО ЭТОМУ ПРАВИЛУ, а не по существованию одного имени, — иначе
 * паспорт среды опишет файл, который CLI не читает, а перенос увезёт не то.
 *
 * Значения и их смысл — дословно из установленной сборки 2.1.278
 * (`.agent/cli-import-map.agent.md`, там же рецепт перепроверки):
 *
 *  - `claude-md` — только `CLAUDE.md`;
 *  - `claude-md-or-agents-md` (умолчание) — где нет своего `CLAUDE.md`, читаются
 *    файлы `AGENTS.md`, ровно там же и так же;
 *  - `claude-md-and-agents-md` — `AGENTS.md` читается РЯДОМ с `CLAUDE.md` (файл,
 *    который `CLAUDE.md` уже импортирует или на который ссылается, второй раз не
 *    грузится);
 *  - `managed-only` — свои файлы инструкций отброшены, остаются управляемые
 *    организацией.
 *
 * Прежний ключ `projectInstructions` CLI ещё читает — «honoured for now», с
 * предупреждением, и его игнорирует, если задан `instructionFiles`. Мы делаем
 * то же самое и помечаем запись устаревшей.
 */

// Перечень режимов и их смысл живут в контрактах: их читает и экран, а не только
// сервер (`InstructionFilesView`). Здесь — правило, а не словарь.
export { instructionFilesModes };
export type { InstructionFilesMode, InstructionFilesSource };

export const DEFAULT_INSTRUCTION_FILES_MODE: InstructionFilesMode = 'claude-md-or-agents-md';

export function isInstructionFilesMode(value: unknown): value is InstructionFilesMode {
  return typeof value === 'string' && (instructionFilesModes as readonly string[]).includes(value);
}

export interface InstructionFilesChoice {
  mode: InstructionFilesMode;
  source: InstructionFilesSource;
  /** Значение ключа, которое не удалось распознать, — чтобы назвать его человеку. */
  unrecognized?: string;
  /** Файл настроек не разобран: режим взят по умолчанию, и это названо вслух. */
  unreadable?: boolean;
}

/**
 * ГДЕ ЛЕЖИТ КЛЮЧ. Не в корне `settings.json`, а в настройках встроенного плагина
 * `agents-md`: `pluginConfigs["agents-md@builtin"].options`. Взято из самой
 * сборки 2.1.278 — плагин читает `t.instructionFiles`/`t.projectInstructions` из
 * своих опций, а CLI пишет о них «in user, --settings or managed settings
 * (project settings are not read)». Верхнеуровневый `instructionFiles` CLI не
 * читает вовсе: он не ругается на него, и панель, взяв его, показывала бы режим,
 * которого нет.
 */
const AGENTS_MD_PLUGIN = 'agents-md@builtin';

interface RawSettings {
  pluginConfigs?: Record<string, { options?: { [key: string]: unknown } } | undefined>;
}

function optionsOf(settings: RawSettings): { [key: string]: unknown } {
  return settings.pluginConfigs?.[AGENTS_MD_PLUGIN]?.options ?? {};
}

/**
 * Прочитать режим из `settings.json`. Нечитаемый файл или незнакомое значение →
 * умолчание CLI плюс названная причина: выдумывать режим нельзя, а падать на
 * этом нельзя тем более — у большинства людей ключа в файле просто нет.
 */
export function readInstructionFilesChoice(settingsPath: string): InstructionFilesChoice {
  let settings: { [key: string]: unknown };
  try {
    settings = optionsOf(readJsonFile<RawSettings>(settingsPath, {}));
  } catch {
    // Обещание «падать на этом нельзя» держалось на честном слове: `readJsonFile`
    // БРОСАЕТ на испорченном JSON, и один пропущенный символ в `settings.json`
    // отвечал человеку пятисоткой на весь паспорт. Режим берётся по умолчанию, а
    // о нечитаемом файле сказано пропуском — fail-closed, а не молчание.
    return { mode: DEFAULT_INSTRUCTION_FILES_MODE, source: 'default', unreadable: true };
  }

  if (settings.instructionFiles !== undefined) {
    if (isInstructionFilesMode(settings.instructionFiles)) {
      return { mode: settings.instructionFiles, source: 'instructionFiles' };
    }
    return {
      mode: DEFAULT_INSTRUCTION_FILES_MODE,
      source: 'default',
      unrecognized: String(settings.instructionFiles),
    };
  }

  // Прежний ключ читается ТОЛЬКО когда нового нет — так же, как у самого CLI
  // («option projectInstructions in settings is not read: instructionFiles … is set»).
  if (settings.projectInstructions !== undefined) {
    if (isInstructionFilesMode(settings.projectInstructions)) {
      return { mode: settings.projectInstructions, source: 'projectInstructions' };
    }
    return {
      mode: DEFAULT_INSTRUCTION_FILES_MODE,
      source: 'projectInstructions',
      unrecognized: String(settings.projectInstructions),
    };
  }

  return { mode: DEFAULT_INSTRUCTION_FILES_MODE, source: 'default' };
}

/**
 * Режим по списку файлов настроек: поиск ОБРЫВАЕТСЯ на первом, который ключ
 * называет. Нечитаемый файл и нераспознанное значение обрывают его тоже — это
 * «ключ назван, но разобрать нечем», и сказать об этом важнее, чем молча уехать
 * на умолчание.
 *
 * Список короткий по существу дела: проектные и локальные файлы настроек CLI для
 * этой опции НЕ ЧИТАЕТ (сообщение самой сборки: «in user, --settings or managed
 * settings (project settings are not read)»), поэтому оба уровня спрашивают один
 * и тот же пользовательский `settings.json`. Управляемые организацией настройки
 * перекрывают и его — панель их сегодня не читает и режим оттуда не покажет.
 */
export function readInstructionFilesChoiceFor(
  settingsPaths: readonly string[],
): InstructionFilesChoice {
  for (const path of settingsPaths) {
    const choice = readInstructionFilesChoice(path);
    if (choice.source !== 'default' || choice.unrecognized !== undefined || choice.unreadable) {
      return choice;
    }
  }
  return { mode: DEFAULT_INSTRUCTION_FILES_MODE, source: 'default' };
}

/**
 * Имена файлов инструкций в порядке поиска внутри корня — дословно списками
 * самой сборки 2.1.278 (`CLAUDE_NAMES` и `AGENTS_NAMES` встроенного плагина).
 * `CLAUDE.local.md` в этом списке не украшение: он СЧИТАЕТСЯ за свой `CLAUDE.md`,
 * то есть его наличие само по себе отменяет чтение `AGENTS.md` рядом.
 */
const CLAUDE_NAMES = ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md'];
const AGENTS_NAMES = ['AGENTS.md', join('.claude', 'AGENTS.md')];

/** Имена, которые CLI ищет вверх от рабочего каталога, — без подкаталога. */
export const INSTRUCTION_BASE_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'] as const;

/** Найденный источник инструкций: путь, имя файла и признак устаревшего ключа. */
export interface InstructionSource {
  filePath: string;
  fileName: string;
  legacy: boolean;
}

/** Почему источник не взят — причина попадает в пропуск паспорта. */
export interface InstructionSkip {
  detail: string;
}

export interface InstructionSources {
  sources: InstructionSource[];
  skips: InstructionSkip[];
}

/**
 * Какие файлы инструкций ДЕЙСТВИТЕЛЬНО читаются в этом корне при этом режиме.
 *
 * Корень задаёт вызывающий: для проекта это каталог проекта, для глобального
 * уровня — каталог конфигурации Claude. Пути перечисляются в том же порядке, в
 * каком их ищет CLI, и файл, которого нет, источником не считается — паспорт
 * описывает среду, а не намерения.
 */
export function resolveInstructionSources(
  root: string,
  choice: InstructionFilesChoice,
): InstructionSources {
  const skips: InstructionSkip[] = [];
  if (choice.unreadable) {
    skips.push({
      detail: `файл настроек не разобран; взят режим по умолчанию ${DEFAULT_INSTRUCTION_FILES_MODE}`,
    });
  }
  if (choice.unrecognized !== undefined) {
    skips.push({
      detail: `значение «${choice.unrecognized}» ключа ${choice.source === 'projectInstructions' ? 'projectInstructions' : 'instructionFiles'} не распознано; взят режим по умолчанию ${DEFAULT_INSTRUCTION_FILES_MODE}`,
    });
  }

  if (choice.mode === 'managed-only') {
    skips.push({
      detail:
        'режим managed-only: собственные файлы инструкций CLI не читает, остаются только управляемые организацией',
    });
    return { sources: [], skips };
  }

  const legacy = choice.source === 'projectInstructions';
  const claudeFiles = existing(root, CLAUDE_NAMES);
  const agentsFiles = existing(root, AGENTS_NAMES);

  if (choice.mode === 'claude-md') {
    if (agentsFiles.length > 0) {
      skips.push({
        detail: `режим claude-md: ${agentsFiles.map((found) => found.name).join(', ')} лежит рядом, но CLI его не читает`,
      });
    }
    return { sources: claudeFiles.map((found) => source(found, legacy)), skips };
  }

  if (choice.mode === 'claude-md-and-agents-md') {
    return {
      sources: [...claudeFiles, ...agentsFiles].map((found) => source(found, legacy)),
      skips,
    };
  }

  // claude-md-or-agents-md: AGENTS.md берётся только там, где своего CLAUDE.md нет.
  if (claudeFiles.length > 0) {
    if (agentsFiles.length > 0) {
      skips.push({
        detail: `режим claude-md-or-agents-md: рядом есть CLAUDE.md, поэтому ${agentsFiles.map((found) => found.name).join(', ')} CLI не читает`,
      });
    }
    return { sources: claudeFiles.map((found) => source(found, legacy)), skips };
  }
  return { sources: agentsFiles.map((found) => source(found, legacy)), skips };
}

/** Найденные файлы вместе с ИМЕНЕМ ПОИСКА — по нему строится имя записи. */
function existing(root: string, names: readonly string[]): { filePath: string; name: string }[] {
  return names
    .map((name) => ({ filePath: join(root, name), name }))
    .filter((found) => existsSync(found.filePath));
}

/**
 * Имя записи — путь ОТ КОРНЯ, а не `basename`.
 *
 * `CLAUDE.md` и `.claude/CLAUDE.md` читаются оба и одним `basename` давали одну
 * и ту же запись канона: по этому имени строится `envItemId`, а по нему идёт
 * идемпотентный upsert (инвариант 10) — один файл молча затирал бы другой у
 * цели. Разделитель всегда `/`: иначе одна и та же среда давала бы разные
 * идентификаторы на Windows и на macOS.
 */
function source(found: { filePath: string; name: string }, legacy: boolean): InstructionSource {
  return { filePath: found.filePath, fileName: found.name.replace(/\\/g, '/'), legacy };
}

/**
 * ЦЕЛЬ ПАНЕЛИ в этом корне: какой файл читать и править, и что сказать о нём
 * человеку.
 *
 * Правило одно на глобальный уровень и на проект (корень задаёт вызывающий):
 *
 *  1. есть файл, который CLI ЧИТАЕТ, — берём первый в порядке чтения самого CLI;
 *  2. читаемого нет, но файл инструкций на диске есть (режим `claude-md` рядом с
 *     `AGENTS.md`, `managed-only`) — берём его, чтобы человек видел и правил своё,
 *     а в заметках сказано, что CLI его сейчас не читает;
 *  3. на диске нет ничего — имя ПРЕДЛАГАЕТСЯ (`proposed`), и по умолчанию это
 *     `AGENTS.md`: то же имя читают `codex`, `kimi` и `opencode`, то есть проект
 *     заводится сразу общим. В режиме `claude-md` предлагается `CLAUDE.md` —
 *     `AGENTS.md` там не прочтут.
 *
 * Панель НИКОГДА не переименовывает существующий файл и не заводит второй: имя
 * из `requested` действует только в случае 3, и любой другой запрос — отказ, а не
 * тихая запись не туда. Оставшийся рядом `CLAUDE.md` молча побеждает `AGENTS.md`
 * у самого CLI, поэтому решение об имени принадлежит человеку.
 */
export interface InstructionTarget {
  filePath: string;
  /** Имя ОТ КОРНЯ (`CLAUDE.md`, `.claude/AGENTS.md`) — оно же идёт на экран. */
  fileName: string;
  /** Файла ещё нет: имя предложено панелью. */
  proposed: boolean;
  view: InstructionFilesView;
}

/** Имя запрошено, но взять его нельзя. Маршрут отвечает 4xx, файл не трогается. */
export class InstructionNameRefusedError extends Error {
  statusCode: number;
  code: string;
  readonly reason: 'unknown_name' | 'file_exists';
  readonly requested: string;
  readonly current: string | undefined;

  constructor(reason: 'unknown_name' | 'file_exists', requested: string, current?: string) {
    super(
      reason === 'unknown_name'
        ? `Имя «${requested}» не из тех, что читает CLI при текущем режиме instructionFiles.`
        : `Файл инструкций уже есть (${current ?? ''}) — панель не переименовывает его и не заводит второй.`,
    );
    this.name = 'InstructionNameRefusedError';
    this.reason = reason;
    this.requested = requested;
    this.current = current;
    // 409, а не 400: запрос правильной формы, но состояние диска его не пускает.
    this.statusCode = reason === 'unknown_name' ? 400 : 409;
    this.code =
      reason === 'unknown_name' ? 'instructions_name_unknown' : 'instructions_file_exists';
    if (reason === 'unknown_name') coded(this, 'instructions-file-name-unknown', { requested });
    else coded(this, 'instructions-file-exists', { current: current ?? '' });
  }
}

export function resolveInstructionTarget(
  root: string,
  choice: InstructionFilesChoice,
  requested?: string,
): InstructionTarget {
  const { sources } = resolveInstructionSources(root, choice);
  const read: InstructionFileEntry[] = sources.map((found) => ({
    fileName: found.fileName,
    filePath: found.filePath,
  }));

  // Всё, что лежит на диске, но при этом режиме не читается, — это и есть
  // «показать оба и назвать, какой читает CLI».
  const onDisk = existing(root, [...CLAUDE_NAMES, ...AGENTS_NAMES]).map((found) => ({
    fileName: found.name.replace(/\\/g, '/'),
    filePath: found.filePath,
  }));
  const isRead = new Set(read.map((entry) => entry.filePath));
  const ignored = onDisk.filter((entry) => !isRead.has(entry.filePath));

  const choices: string[] =
    choice.mode === 'claude-md' ? ['CLAUDE.md'] : ['CLAUDE.md', 'AGENTS.md'];
  const view: InstructionFilesView = {
    mode: choice.mode,
    source: choice.source,
    read,
    ignored,
    choices,
    proposed: false,
    notes: notesOf(choice, ignored),
  };

  const found = read[0] ?? ignored[0];
  if (found) {
    if (requested !== undefined && requested !== found.fileName) {
      throw new InstructionNameRefusedError('file_exists', requested, found.fileName);
    }
    return { filePath: found.filePath, fileName: found.fileName, proposed: false, view };
  }

  if (requested !== undefined && !choices.includes(requested)) {
    throw new InstructionNameRefusedError('unknown_name', requested);
  }
  const fileName = requested ?? (choice.mode === 'claude-md' ? 'CLAUDE.md' : 'AGENTS.md');
  return {
    filePath: join(root, fileName),
    fileName,
    proposed: true,
    view: { ...view, proposed: true },
  };
}

/**
 * Цель пользовательского уровня (`~/.claude` или каталог из настроек панели).
 * Режим берётся из `settings.json` того же каталога — `settings.local.json`
 * рядом CLI для этой опции не читает.
 */
export function userInstructionTarget(root: string, requested?: string): InstructionTarget {
  const choice = readInstructionFilesChoiceFor([join(root, 'settings.json')]);
  return resolveInstructionTarget(root, choice, requested);
}

/**
 * Цель проектного уровня: файл лежит в корне РЕПОЗИТОРИЯ, а режим — всё тот же
 * пользовательский. Своего режима у проекта быть не может: `.claude/settings*`
 * эту опцию не задают, и панель, прочитав её там, обещала бы поведение, которого
 * CLI не покажет. Пути настроек панель не знает — их передаёт вызывающий.
 */
export function projectInstructionTarget(
  root: string,
  userSettingsPath?: string,
  requested?: string,
): InstructionTarget {
  const candidates = userSettingsPath ? [userSettingsPath] : [];
  return resolveInstructionTarget(root, readInstructionFilesChoiceFor(candidates), requested);
}

/** Заметки экрана — кодами: формулировка принадлежит клиенту с его двумя локалями. */
function notesOf(
  choice: InstructionFilesChoice,
  ignored: readonly InstructionFileEntry[],
): InstructionFilesNote[] {
  const notes: InstructionFilesNote[] = [];
  if (choice.unreadable) notes.push({ code: 'unreadable-settings' });
  if (choice.unrecognized !== undefined) {
    notes.push({ code: 'unrecognized', value: choice.unrecognized });
  }
  if (choice.source === 'projectInstructions') notes.push({ code: 'legacy-key' });
  if (choice.mode === 'managed-only') notes.push({ code: 'managed-only' });
  if (ignored.length > 0) {
    notes.push({ code: 'ignored-nearby', files: ignored.map((entry) => entry.fileName) });
  }
  return notes;
}
