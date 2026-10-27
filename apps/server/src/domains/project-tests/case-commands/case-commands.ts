import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { readJson, TESTS_DIR, writeJson } from '../files.ts';
import type { CaseCommand, CaseCommands, ExcludeOutcome } from './case-commands.types.ts';

export type { CaseCommand, CaseCommands, ExcludeOutcome } from './case-commands.types.ts';

/**
 * Своя команда кейса у этой копии (F3, g0 27.10).
 *
 * Кейс mod-llmbox на Windows идёт только с `--cmd "set PYTHONPATH=.agent/tmp/pyshim;…"`:
 * группа переписывала строку из блокнота в каждый `run`, `--stale` и `--base` её не знали,
 * и три прогона ушли впустую. Команда задаётся один раз (`tests-cli case-cmd`) и лежит в
 * `.agent/tests/case-commands.json` копии — файле вне git: это рецепт этой машины, не
 * проекта, и в общий репозиторий он не попадает. `run` без `--cmd` берёт её сам; `--base`
 * получает файл вместе с кейсами, `{copy}` раскрывается в исходную копию.
 */

export const CASE_COMMANDS_FILE = 'case-commands.json';
const OWN_PATH = `${TESTS_DIR}/${CASE_COMMANDS_FILE}`;
const MAX_COMMAND = 2000;

export function readCaseCommands(root: string): { commands: CaseCommands; error?: string } {
  const { data, error } = readJson(root, CASE_COMMANDS_FILE);
  if (error) return { commands: {}, error: `${CASE_COMMANDS_FILE}: ${error}` };
  const raw = (data as { commands?: unknown } | undefined)?.commands;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { commands: {} };
  const commands: CaseCommands = {};
  for (const [key, value] of Object.entries(raw)) {
    const item = value as Partial<CaseCommand> | undefined;
    if (typeof item?.cmd !== 'string' || commandIssue(item.cmd) || !key.includes(':')) continue;
    commands[key] = {
      cmd: item.cmd,
      ...(typeof item.format === 'string' && item.format ? { format: item.format } : {}),
      ...(typeof item.at === 'string' ? { at: item.at } : {}),
    };
  }
  return { commands };
}

/** Строка команды годится: одна строка, не пустая, не длиннее предела. */
export function commandIssue(cmd: string): string | undefined {
  if (!cmd.trim()) return 'Команда пустая.';
  if (/[\r\n]/.test(cmd)) return 'Команда — одна строка, без переводов.';
  if (cmd.length > MAX_COMMAND) return `Команда длиннее ${MAX_COMMAND} символов.`;
  return undefined;
}

/**
 * Записать (`command`) или снять (`undefined`) команду кейсов. Файл ложится вне git:
 * не игнорируется — путь дописывается в `info/exclude` репозитория; файл под git —
 * отказ до записи: рецепт машины в общий репозиторий не уходит.
 */
export function saveCaseCommands(
  root: string,
  keys: readonly string[],
  command: CaseCommand | undefined,
): ExcludeOutcome {
  const { commands, error } = readCaseCommands(root);
  // Сломанный файл не перезаписывается: за ним чья-то работа.
  if (error) throw new Error(error);
  if (tracked(root))
    throw new Error(
      `${OWN_PATH} под git — команда этой машины в репозиторий не пишется. ` +
        'Уберите файл из индекса (git rm --cached) и повторите.',
    );
  for (const key of keys) {
    if (command) commands[key] = command;
    else delete commands[key];
  }
  writeJson(root, CASE_COMMANDS_FILE, { version: 1, commands });
  return keepOutOfGit(root);
}

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function tracked(root: string): boolean {
  const listed = git(root, ['ls-files', '--', OWN_PATH]);
  return listed.status === 0 && listed.stdout.trim() !== '';
}

/** Файл вне git: уже игнорируется — ничего; нет — в `info/exclude` (общий у копий). */
function keepOutOfGit(root: string): ExcludeOutcome {
  const prefix = git(root, ['rev-parse', '--show-prefix']);
  if (prefix.status !== 0) return 'not-a-repo';
  if (git(root, ['check-ignore', '-q', '--', OWN_PATH]).status === 0) return 'ignored';
  const raw = git(root, ['rev-parse', '--git-path', 'info/exclude']).stdout.trim();
  if (!raw) return 'not-a-repo';
  const exclude = isAbsolute(raw) ? raw : join(root, raw);
  mkdirSync(dirname(exclude), { recursive: true });
  const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const lead = before && !before.endsWith('\n') ? '\n' : '';
  appendFileSync(exclude, `${lead}/${prefix.stdout.trim()}${OWN_PATH}\n`);
  return 'excluded';
}
