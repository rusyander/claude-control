import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { composedRules } from './compose.ts';
import { describe } from './items.ts';

/**
 * Набор панели в Codex. Разговор Codex — задача ядра (этап 10, G6): правила и
 * список навыков набора едут ТЕКСТОМ после брифа ядра в `developerInstructions`
 * переходника (`codexKitAppend`, зовёт `KitService.runExtras`); дом Codex сеанса
 * ядра свой, `config.toml` человека не пишется. Прежнее наложение на запуск
 * `codex exec` / `app-server` панели (файл в `AGENTDECK_CODEX_KIT` и
 * `withCodexKit`) снято 02.11.2026 вместе с этими запусками.
 *
 * Хуки, пайплайны и субагенты не переносятся: у Codex нет слоя команд и
 * субагентов на один запуск, а хук срабатывает только после одобрения в
 * `/hooks` самого Codex (привязано к хэшу).
 */

/** Набор не помещается в поле инструкций: размер и предел — для отказа человеку. */
export class CodexKitTooLarge extends Error {
  readonly size: number;
  readonly limit: number;
  constructor(size: number, limit: number) {
    super(`codex kit text is ${size} chars, the core session takes ${limit}`);
    this.size = size;
    this.limit = limit;
  }
}

/** 24000 → «24 000»: число знаков читается с первого взгляда. */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Текст отказа, когда набор на прогон не собрался. Набор Codex длиннее
 * поля инструкций сеанса — своя причина с пределом и размером: «не собрался» без
 * причины не подсказывает, что выключить. Остальное — общий отказ.
 */
export function kitComposeRefusal(error: unknown): string {
  return error instanceof CodexKitTooLarge
    ? serverText('kit-codex-too-large', {
        size: groupDigits(error.size),
        limit: groupDigits(error.limit),
      })
    : serverText('kit-compose-failed');
}

export interface CodexSkillLine {
  name: string;
  description: string;
  path: string;
}

/** Строка списка для одного скилла; `shownPath` — где модель его прочтёт. */
function codexSkillLine(name: string, skillDir: string, shownPath: string): CodexSkillLine {
  return {
    name,
    description: describe(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')),
    path: shownPath,
  };
}

function codexSkillLines(skillsDir: string): CodexSkillLine[] {
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

/**
 * Предел описания в списке навыков. Список едет в той же командной строке, что и правила,
 * а предел у неё общий: ночной прогон локальной модели добавил правило памяти задачи, и
 * без обрезки самых длинных описаний набор переставал помещаться. Полное описание лежит в
 * самом SKILL.md, который модель обязана прочесть, когда задача подходит.
 */
export const CODEX_SKILL_DESCRIPTION_MAX = 240;

function clipDescription(text: string): string {
  if (text.length <= CODEX_SKILL_DESCRIPTION_MAX) return text;
  const cut = text.slice(0, CODEX_SKILL_DESCRIPTION_MAX - 1);
  const word = cut.lastIndexOf(' ');
  return `${(word > CODEX_SKILL_DESCRIPTION_MAX / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

/**
 * Путь один раз в заголовке, когда у каждого навыка он `<root>/<имя>/SKILL.md`. Путь в строке —
 * около 100 знаков из ~260 (в JSON обратная косая удваивается): при 47 навыках набор съел запас
 * в 2000 знаков до предела командной строки (27.10.2026), и каждый новый навык стоил бы ещё 100.
 * Шаблон идёт с примером, чтобы слабая локальная модель не собирала путь наугад.
 */
function sharedRoot(
  skills: readonly CodexSkillLine[],
  root: string | undefined,
): string | undefined {
  if (!root) return undefined;
  return skills.every((skill) => skill.path === join(root, skill.name, 'SKILL.md'))
    ? root
    : undefined;
}

const rootedPath = (root: string, example: CodexSkillLine): string =>
  `${join(root, '<name>', 'SKILL.md')} (e.g. ${example.path})`;

export function codexSkillIndex(
  skills: readonly CodexSkillLine[],
  heading = 'agentdeck kit skills',
  /** Резать длинные описания: только локальному прогону, где место в строке на счету; обычный набор — как был. */
  clip = false,
  /** Каталог навыков: путь пишется один раз в заголовке (`sharedRoot`); без него — в каждой строке. */
  root?: string,
): string {
  if (skills.length === 0) return '';
  const shared = sharedRoot(skills, root);
  const describeSkill = (skill: CodexSkillLine) =>
    `- ${skill.name} — ${clip ? clipDescription(skill.description) : skill.description}`;
  return [
    `## ${heading}`,
    shared
      ? `When a task matches one of these, read its SKILL.md first and follow it: ${rootedPath(shared, skills[0] as CodexSkillLine)}.`
      : 'When a task matches one of these, read that SKILL.md first and follow it.',
    ...skills.map((skill) =>
      shared ? describeSkill(skill) : `${describeSkill(skill)} (${skill.path})`,
    ),
  ].join('\n');
}

/** Последняя ступень списка: только имена и пути — когда подходит, модель читает описание в самом SKILL.md. */
export function codexSkillNames(
  skills: readonly CodexSkillLine[],
  heading = 'agentdeck kit skills',
  root?: string,
): string {
  if (skills.length === 0) return '';
  const shared = sharedRoot(skills, root);
  return [
    `## ${heading}`,
    shared
      ? `Names only (the full list did not fit). Before a task, open the SKILL.md of the name that fits it and follow it: ${rootedPath(shared, skills[0] as CodexSkillLine)}.`
      : 'Names only (the full list did not fit). Before a task, open the SKILL.md whose name fits it and follow it.',
    ...skills.map((skill) => (shared ? `- ${skill.name}` : `- ${skill.name} (${skill.path})`)),
  ].join('\n');
}

const joinParts = (...parts: string[]): string => parts.filter(Boolean).join('\n\n');

/**
 * Набор для сеанса Codex через ядро (этап 10, G6): правила и список навыков ТЕКСТОМ — ядро кладёт
 * его после своего брифа в `developerInstructions` переходника. Дом Codex сеанса ядра свой, текст
 * человека из его `config.toml` туда не идёт, поэтому здесь только набор. Список навыков ужимается
 * ступенями: с описаниями, с ужатыми описаниями, одни имена; правила не режутся — не помещаются,
 * отказ `CodexKitTooLarge` с размером и пределом (текст человеку — `kitComposeRefusal`).
 */
export function codexKitAppend(input: { kitDir: string; local: boolean; max: number }): string {
  const rules = composedRules(input.kitDir, input.local);
  const kitRules = rules
    ? `# agentdeck kit rules\n\n${rules.replace(/^# agentdeck kit rules\s*/, '')}`
    : '';
  const skillsDir = join(input.kitDir, 'skills');
  const skills = codexSkillLines(skillsDir);
  const tiers = [
    codexSkillIndex(skills, undefined, input.local, skillsDir),
    codexSkillIndex(skills, undefined, true, skillsDir),
    codexSkillNames(skills, undefined, skillsDir),
  ].map((index) => joinParts(kitRules, index));
  const fit = tiers.find((text) => text.length <= input.max);
  if (fit === undefined) {
    throw new CodexKitTooLarge((tiers.at(-1) as string).length, input.max);
  }
  return fit;
}
