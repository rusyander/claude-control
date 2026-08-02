import type { CommandResult } from '@claude-control/contracts';
import { safePluginId } from '../../lib/cli-args.ts';
import { defaultCliCommand } from '../../providers/cli.ts';
import { runClaude } from './cli.ts';
import { forgetInstalledPlugins } from './read.ts';

/**
 * Операции над плагинами и маркетплейсами — всё через штатный CLI Claude Code.
 * Ставить и включать плагин руками нельзя: состояние разъедется с тем, что
 * видит сам Claude Code.
 */

async function runPluginCommand(command: string, args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await runClaude(command, ['plugin', ...args]);
    // Набор установленного только что изменился нашими же руками — держать
    // кэш для поиска бессмысленно, иначе панель показывала бы своё прошлое.
    forgetInstalledPlugins();
    return { ok: true, output: (stdout || stderr).trim(), needsRestart: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const output = (error as { stdout?: string; stderr?: string }).stderr ?? detail;
    return { ok: false, output: output.trim(), needsRestart: false };
  }
}

/**
 * Источник маркетплейса — репозиторий, URL или путь. Значение уходит в команду,
 * а на Windows команда идёт через оболочку, поэтому метасимволы и пробел сюда не
 * пускаем: разрешены только буквы, цифры и безопасные знаки адреса/пути.
 */
const MARKETPLACE_SOURCE = /^[A-Za-z0-9._~:/@\\-]{1,300}$/;

/** Добавить маркетплейс: `claude plugin marketplace add <источник>`. */
export function addMarketplace(
  source: string,
  command: string = defaultCliCommand(),
): Promise<CommandResult> {
  if (!MARKETPLACE_SOURCE.test(source)) {
    return Promise.resolve({
      ok: false,
      output: `Недопустимый источник: ${source}`,
      needsRestart: false,
    });
  }
  return runPluginCommand(command, ['marketplace', 'add', source]);
}

/** Убрать маркетплейс по имени: `claude plugin marketplace remove <имя>`. */
export function removeMarketplace(
  name: string,
  command: string = defaultCliCommand(),
): Promise<CommandResult> {
  if (!MARKETPLACE_SOURCE.test(name)) {
    return Promise.resolve({ ok: false, output: `Недопустимое имя: ${name}`, needsRestart: false });
  }
  return runPluginCommand(command, ['marketplace', 'remove', name]);
}

/**
 * Идентификатор приходит из запроса, а на Windows команда уходит в оболочку —
 * поэтому он сверяется с допустимым видом до запуска. Отказ возвращается
 * обычным ответом: страница плагинов покажет его как результат операции.
 */
function runPluginAction(command: string, action: string, id: string): Promise<CommandResult> {
  let checked: string;
  try {
    checked = safePluginId(id);
  } catch (error) {
    return Promise.resolve({
      ok: false,
      output: error instanceof Error ? error.message : String(error),
      needsRestart: false,
    });
  }

  return runPluginCommand(command, [action, checked]);
}

export const installPlugin = (
  id: string,
  command: string = defaultCliCommand(),
): Promise<CommandResult> => runPluginAction(command, 'install', id);

export const uninstallPlugin = (
  id: string,
  command: string = defaultCliCommand(),
): Promise<CommandResult> => runPluginAction(command, 'uninstall', id);

export const enablePlugin = (
  id: string,
  command: string = defaultCliCommand(),
): Promise<CommandResult> => runPluginAction(command, 'enable', id);

export const disablePlugin = (
  id: string,
  command: string = defaultCliCommand(),
): Promise<CommandResult> => runPluginAction(command, 'disable', id);

export const updatePlugin = (
  id: string,
  command: string = defaultCliCommand(),
): Promise<CommandResult> => runPluginAction(command, 'update', id);
