import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCodexToml } from '../../lib/codex-toml.ts';
import { readJsonFile, writeJsonFile } from '../../lib/safe-io.ts';
import { serverText } from '../../lib/server-texts.ts';
import { codexHome } from '../../providers/catalog/config-dirs.ts';
import { composedRules } from './compose.ts';
import { describe } from './items.ts';

/**
 * Набор панели в Codex (владелец 06.10.2026): наложение на один запуск, дом
 * Codex (`CODEX_HOME`) не подменяется и не пишется.
 *
 * - Правила — ключом `-c developer_instructions=…`. Ключ ЗАМЕНЯЕТ значение из
 *   `config.toml`, поэтому собственный текст человека (если он есть) идёт
 *   первым, набор — после: режим «Ваши и набор панели», а не «вместо ваших».
 * - Навыки — у `codex app-server` настоящими навыками (`skills/extraRoots/set`
 *   на каталог набора, сверено на codex 0.160: навык виден в `skills/list`,
 *   `config.toml` не меняется). У `codex exec` такого вызова нет — там навыки
 *   идут списком «имя — описание — путь к SKILL.md» в тех же инструкциях.
 * - Пайплайны, субагенты и хуки не переносятся: у Codex нет слоя команд и
 *   субагентов на один запуск, а хук срабатывает только после одобрения в
 *   `/hooks` самого Codex (привязано к хэшу) — панель об этом говорит.
 *
 * До процесса наложение доезжает переменной окружения с путём к файлу: так
 * его несёт та же труба, что и адрес контура, во все места запуска Codex
 * (чат, окно агента, одиночный запуск). Сама переменная из окружения CLI
 * убирается (`withCodexKit`).
 */

export const CODEX_KIT_ENV = 'AGENTDECK_CODEX_KIT';
/** Путь к накладке групп прогона (`domains/groups/codex-layer.ts`). */
export const CODEX_GROUP_ENV = 'AGENTDECK_CODEX_GROUP';

/**
 * Предел длины аргумента. Командная строка Windows — 32 767 символов на ВСЁ;
 * остальное (промпт, модель, путь) должно поместиться рядом.
 */
export const CODEX_KIT_ARG_LIMIT = 24_000;

export interface CodexKitOverlay {
  /** Инструкции для `codex app-server`: навыки туда идут каталогом, не списком. */
  appServer: string;
  /** Инструкции для `codex exec`: со списком навыков. */
  exec: string;
  /** Каталог навыков набора — корень для `skills/extraRoots/set`. */
  skillsDir?: string;
}

export class CodexKitTooLarge extends Error {
  readonly size: number;
  constructor(size: number) {
    super(`codex kit instructions are ${size} chars, limit ${CODEX_KIT_ARG_LIMIT}`);
    this.size = size;
  }
}

/** 24000 → «24 000»: число знаков читается с первого взгляда. */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Текст отказа, когда набор на прогон не собрался. Набор Codex длиннее
 * командной строки — своя причина с пределом и размером: «не собрался» без
 * причины не подсказывает, что выключить. Остальное — общий отказ.
 */
export function kitComposeRefusal(error: unknown): string {
  return error instanceof CodexKitTooLarge
    ? serverText('kit-codex-too-large', {
        size: groupDigits(error.size),
        limit: groupDigits(CODEX_KIT_ARG_LIMIT),
      })
    : serverText('kit-compose-failed');
}

/**
 * Накладка групп прогона: правила и список скиллов — текстом к инструкциям,
 * MCP — готовыми аргументами `-c`, секреты — только именами переменных.
 */
export interface CodexGroupOverlay {
  rules: string;
  /** Список скиллов для `exec`; у `app-server` скиллы идут корнем `skillsDir`. */
  skillIndex: string;
  skillsDir?: string;
  mcpArgs: string[];
  secretNames: string[];
}

function readConfig(home: string | undefined): Record<string, unknown> | undefined {
  if (!home) return undefined;
  const file = join(home, 'config.toml');
  if (!existsSync(file)) return undefined;
  try {
    return parseCodexToml(readFileSync(file, 'utf8'));
  } catch {
    // Конфиг, который не читается, Codex и сам не примет — дописывать к нему нечего.
    return undefined;
  }
}

/** Собственные `developer_instructions` человека из его `config.toml`. */
export function ownDeveloperInstructions(home: string | undefined): string {
  const value = readConfig(home)?.developer_instructions;
  return typeof value === 'string' ? value.trim() : '';
}

export interface CodexSkillLine {
  name: string;
  description: string;
  path: string;
}

/** Строка списка для одного скилла; `shownPath` — где модель его прочтёт. */
export function codexSkillLine(name: string, skillDir: string, shownPath: string): CodexSkillLine {
  return {
    name,
    description: describe(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')),
    path: shownPath,
  };
}

export function codexSkillLines(skillsDir: string): CodexSkillLine[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
    .map((entry) =>
      codexSkillLine(
        entry.name,
        join(skillsDir, entry.name),
        join(skillsDir, entry.name, 'SKILL.md'),
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function codexSkillIndex(
  skills: readonly CodexSkillLine[],
  heading = 'agentdeck kit skills',
): string {
  if (skills.length === 0) return '';
  return [
    `## ${heading}`,
    'When a task matches one of these, read that SKILL.md first and follow it.',
    ...skills.map((skill) => `- ${skill.name} — ${skill.description} (${skill.path})`),
  ].join('\n');
}

const joinParts = (...parts: string[]): string => parts.filter(Boolean).join('\n\n');

/** Длина аргумента `-c developer_instructions=…` для частей текста. */
export function codexInstructionsLength(parts: readonly string[]): number {
  return argLength(joinParts(...parts));
}

/** Длина аргумента `-c developer_instructions=<строка TOML>` для текста. */
function argLength(text: string): number {
  return tomlArg(text).length;
}

function tomlArg(text: string): string {
  // Строка JSON — допустимая базовая строка TOML (те же `\"`, `\\`, `\n`, `\uXXXX`),
  // и в ней нет настоящих переводов строки: cmd-обёртка их не обрежет.
  return `developer_instructions=${JSON.stringify(text)}`;
}

/**
 * Наложение из собранного набора: текст инструкций в двух видах и каталог
 * навыков. Не помещается в командную строку — `CodexKitTooLarge` (прогон
 * получит отказ, а не молча урезанные правила).
 */
export function buildCodexOverlay(input: {
  kitDir: string;
  local: boolean;
  codexHome?: string | undefined;
}): CodexKitOverlay {
  const own = ownDeveloperInstructions(input.codexHome);
  const rules = composedRules(input.kitDir, input.local);
  const skillsDir = join(input.kitDir, 'skills');
  const skills = codexSkillLines(skillsDir);
  const join2 = joinParts;
  const kitRules = rules
    ? `# agentdeck kit rules\n\n${rules.replace(/^# agentdeck kit rules\s*/, '')}`
    : '';
  const appServer = join2(own, kitRules);
  const exec = join2(own, kitRules, codexSkillIndex(skills));
  const longest = Math.max(argLength(appServer), argLength(exec));
  if (longest > CODEX_KIT_ARG_LIMIT) throw new CodexKitTooLarge(longest);
  return { appServer, exec, ...(skills.length > 0 ? { skillsDir } : {}) };
}

export function writeCodexOverlay(file: string, overlay: CodexKitOverlay): string {
  writeJsonFile(file, overlay);
  return file;
}

function readOverlay(file: string): CodexKitOverlay | undefined {
  const value = readJsonFile<Partial<CodexKitOverlay> | undefined>(file, undefined);
  if (!value || typeof value.appServer !== 'string' || typeof value.exec !== 'string') {
    return undefined;
  }
  return {
    appServer: value.appServer,
    exec: value.exec,
    ...(typeof value.skillsDir === 'string' ? { skillsDir: value.skillsDir } : {}),
  };
}

function readGroupOverlay(file: string): CodexGroupOverlay | undefined {
  const value = readJsonFile<Partial<CodexGroupOverlay> | undefined>(file, undefined);
  if (
    !value ||
    typeof value.rules !== 'string' ||
    typeof value.skillIndex !== 'string' ||
    !Array.isArray(value.mcpArgs) ||
    !Array.isArray(value.secretNames)
  ) {
    return undefined;
  }
  return {
    rules: value.rules,
    skillIndex: value.skillIndex,
    ...(typeof value.skillsDir === 'string' ? { skillsDir: value.skillsDir } : {}),
    mcpArgs: value.mcpArgs.filter((arg): arg is string => typeof arg === 'string'),
    secretNames: value.secretNames.filter((name): name is string => typeof name === 'string'),
  };
}

/**
 * Секреты MCP групп живут в окружении Codex, а его команды оболочки по
 * умолчанию наследуют окружение (P8) — модель прочла бы ключ одним `echo`.
 * Ключ `-c` ЗАМЕНЯЕТ список, поэтому исключения человека из `config.toml`
 * идут в него первыми.
 */
function shellExcludeArgs(home: string | undefined, names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const policy = readConfig(home)?.shell_environment_policy;
  const exclude =
    policy && typeof policy === 'object' ? (policy as { exclude?: unknown }).exclude : undefined;
  const own = Array.isArray(exclude)
    ? exclude.filter((item): item is string => typeof item === 'string')
    : [];
  const list = [...new Set([...own, ...names])].map((name) => JSON.stringify(name));
  return ['-c', `shell_environment_policy.exclude=[${list.join(',')}]`];
}

/**
 * Применить наложения к запуску Codex — набор панели и группы прогона — одним
 * `-c developer_instructions=…` сразу после подкоманды (`exec` / `app-server` —
 * опции идут до промпта): текст человека, набор, группы. MCP групп — своими
 * `-c mcp_servers.…`. Переменные с путями убраны из окружения. Нет переменных —
 * запуск как был. Файл наложения пропал между сборкой и запуском — `missing`:
 * вызывающий отказывает, а не идёт молча без того, что человек включил. Всё
 * вместе длиннее предела — `refusal` с причиной, ничего не обрезано.
 */
export function withCodexKit(
  args: readonly string[],
  env: Record<string, string> | undefined,
  surface: 'exec' | 'appServer',
): {
  args: string[];
  env: Record<string, string> | undefined;
  skillRoots: string[];
  missing?: true;
  refusal?: string;
} {
  const kitFile = env?.[CODEX_KIT_ENV];
  const groupFile = env?.[CODEX_GROUP_ENV];
  if (!env || (kitFile === undefined && groupFile === undefined)) {
    return { args: [...args], env, skillRoots: [] };
  }
  const { [CODEX_KIT_ENV]: _kit, [CODEX_GROUP_ENV]: _group, ...rest } = env;
  const kit = kitFile === undefined ? undefined : readOverlay(kitFile);
  const group = groupFile === undefined ? undefined : readGroupOverlay(groupFile);
  if ((kitFile !== undefined && !kit) || (groupFile !== undefined && !group)) {
    return { args: [...args], env: rest, skillRoots: [], missing: true };
  }
  const home = rest.CODEX_HOME || codexHome();
  // Без набора свой текст человека всё равно первый: ключ заменяет значение конфига.
  const base = kit ? kit[surface] : ownDeveloperInstructions(home);
  const groupText = group ? joinParts(group.rules, surface === 'exec' ? group.skillIndex : '') : '';
  const text = joinParts(base, groupText);
  if (argLength(text) > CODEX_KIT_ARG_LIMIT) {
    return {
      args: [...args],
      env: rest,
      skillRoots: [],
      refusal: serverText('group-layer-too-large', { limit: String(CODEX_KIT_ARG_LIMIT) }),
    };
  }
  // Ключ инструкций — только когда наложению есть что добавить: свой текст
  // человека Codex и так прочтёт из конфига.
  const extra = [
    ...((kit && kit[surface]) || groupText ? ['-c', tomlArg(text)] : []),
    ...(group?.mcpArgs ?? []).flatMap((arg) => ['-c', arg]),
    ...shellExcludeArgs(home, group?.secretNames ?? []),
  ];
  const [head, ...tail] = args;
  const skillRoots =
    surface === 'appServer'
      ? [kit?.skillsDir, group?.skillsDir].filter((dir): dir is string => Boolean(dir))
      : [];
  return { args: head ? [head, ...extra, ...tail] : [...args], env: rest, skillRoots };
}
