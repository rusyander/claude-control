import { join } from 'node:path';
import { readJsonFile } from '../../../lib/safe-io/safe-io.ts';

/**
 * Потолок таймаута Bash группы (3.1; переменная CLI, по умолчанию 10 мин). Гейт
 * проекта под нагрузкой шёл дольше: 22 прогона из 26 упёрлись в десять минут, CLI
 * увёл их в фон, и модель опрашивала конец циклами `sleep` — каждый опрос был
 * ходом модели со всем контекстом (замер по стенограммам 16.10). Полчаса — столько
 * же, сколько CLI даёт фоновой задаче.
 *
 * Едет полем `env` файла `--settings`, а не окружением процесса: переменная из
 * settings.json человека перебивает окружение, а настройки флага главнее неё
 * (CLI 2.1.286 живьём, ревью B-F02). Больший потолок, уже действующий, остаётся.
 */
export const BASH_MAX_TIMEOUT_ENV = 'BASH_MAX_TIMEOUT_MS';
const BASH_MAX_TIMEOUT_MS = 30 * 60_000;

/** Потолок группы: больший из действующих и получаса — профиль только поднимает. */
export function bashCeilingMs(current: readonly (string | undefined)[] = []): number {
  const known = current.map(Number).filter((ms) => Number.isFinite(ms) && ms > 0);
  return Math.max(BASH_MAX_TIMEOUT_MS, ...known);
}

/**
 * Потолки, уже действующие для прогона в `cwd`: личные настройки, настройки проекта
 * (общие и локальные) и окружение панели. Битый файл не в счёт: из-за него группа
 * не должна потерять профиль целиком.
 */
export function bashCeilingsAt(
  userSettings: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): (string | undefined)[] {
  const files = [
    userSettings,
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ];
  return files
    .map((file) => {
      try {
        const value = readJsonFile<{ env?: Record<string, unknown> }>(file, {}).env?.[
          BASH_MAX_TIMEOUT_ENV
        ];
        return value === undefined ? undefined : String(value);
      } catch {
        return undefined;
      }
    })
    .concat(env[BASH_MAX_TIMEOUT_ENV]);
}
