import { homedir } from 'node:os';
import type { spawn as nodeSpawn } from 'node:child_process';
import { spawnCliProcess } from '../../lib/cli-spawn/cli-spawn.ts';
import { killChildTree } from '../../lib/process-tree/process-tree.ts';

/**
 * Запуск команд плагинов чужого CLI: `qwen extensions …` (MAP 25), `codex
 * plugin …`. Панель НЕ пишет хранилище установленного сама — у обоих CLI оно
 * внутреннее (`extension-store/`, кэш `plugins/cache/`), и форма его не
 * опубликована. Всё, что ставит и удаляет, идёт командами самого CLI, и только
 * теми, что работают без вопроса в терминале.
 *
 * Запуск асинхронный (spawnSync держал бы весь сервер на время установки из
 * git), с потолком времени, и действия идут по одному: две установки разом
 * дрались бы за блокировки хранилища CLI.
 */

/** Потолок списка: CLI стартует несколько секунд. */
export const PLUGIN_LIST_TIMEOUT_MS = 30_000;
/** Потолок действия: установка из git или GitHub качает архив. */
export const PLUGIN_ACTION_TIMEOUT_MS = 180_000;

export interface PluginCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** CLI не запустился вовсе (нет в PATH и т.п.). */
  spawnError?: string;
}

/** Один запуск CLI: аргументы после префикса (`extensions`, `plugin`), потолок времени. */
export type PluginCliRun = (args: string[], timeoutMs: number) => Promise<PluginCliResult>;

export interface PluginCliRunOptions {
  spawnImpl?: typeof nodeSpawn;
  /** Рабочий каталог: домашний — отметка ✓/✗ Qwen считается для него. */
  cwd?: string;
}

/** Настоящий запуск через общий `spawnCliProcess` (без оболочки на Windows). */
export function createPluginCliRun(
  command: string,
  prefix: readonly string[],
  options: PluginCliRunOptions = {},
): PluginCliRun {
  return (args, timeoutMs) =>
    new Promise((resolve) => {
      const spawned = spawnCliProcess(command, [...prefix, ...args], {
        cwd: options.cwd ?? homedir(),
        ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
      });
      if (spawned.error) {
        resolve({
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: spawned.error.message,
        });
        return;
      }
      const child = spawned.child;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const finish = (result: PluginCliResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      // stdin закрыт сразу: вопрос [Y/n] без ответа завершает CLI, а не вешает его.
      child.stdin?.end();
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      const timer = setTimeout(() => {
        timedOut = true;
        killChildTree(child);
      }, timeoutMs);
      child.on('error', (error) =>
        finish({ code: null, stdout, stderr, timedOut, spawnError: error.message }),
      );
      child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
    });
}

/** Очередь действий: следующее начинается, когда предыдущее закончилось. */
let queue: Promise<unknown> = Promise.resolve();

export function serializePluginAction<T>(action: () => Promise<T>): Promise<T> {
  const next = queue.then(action, action);
  queue = next.catch(() => undefined);
  return next;
}

/** Последние непустые строки вывода — то, что CLI сказал об ошибке. */
export function cliTail(result: PluginCliResult, lines = 6): string {
  const text = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  return text.slice(-lines).join('\n');
}

/** Почему запуск не удался — словами CLI, если он что-то сказал. */
export function describeCliFailure(result: PluginCliResult): string {
  if (result.spawnError) return result.spawnError;
  if (result.timedOut) return 'CLI не ответил вовремя и был остановлен.';
  return cliTail(result) || `код выхода ${result.code}`;
}

// --- Qwen: `qwen extensions …` ---------------------------------------------

/**
 * Qwen зовётся только командами без вопроса: `install --consent`,
 * `enable|disable --scope user`, `uninstall`. `update` и `link` спрашивают [Y/n]
 * всегда (флага согласия у них нет) — их панель не зовёт.
 */
export const QWEN_LIST_TIMEOUT_MS = PLUGIN_LIST_TIMEOUT_MS;
export const QWEN_ACTION_TIMEOUT_MS = PLUGIN_ACTION_TIMEOUT_MS;
export type QwenCliResult = PluginCliResult;
export type QwenCliRun = PluginCliRun;
export const serializeQwenAction = serializePluginAction;

export function createQwenCliRun(command: string, options: PluginCliRunOptions = {}): QwenCliRun {
  return createPluginCliRun(command, ['extensions'], options);
}

// --- Codex: `codex plugin …` -----------------------------------------------

export function createCodexPluginRun(
  command: string,
  options: PluginCliRunOptions = {},
): PluginCliRun {
  return createPluginCliRun(command, ['plugin'], options);
}
