import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { brandEnvName, legacyEnvName } from './brand.mjs';

/**
 * Системный браузер на движке Chromium — единственное, чем панель умеет печатать
 * PDF.
 *
 * Ищется ФАЙЛ на диске, а не «поддерживается ли печать»: наличие браузера —
 * факт файловой системы, и проверить его можно ровно так же, как панель
 * проверяет `claude` в PATH. Ничего не запускается: запуск браузера ради ответа
 * «а PDF получится?» стоил бы секунды на каждый показ меню.
 *
 * Playwright, которым панель снимает кадры, здесь НЕ годится: он живёт в
 * `devDependencies` инструментов, а печать — работа рабочего сервера, который
 * человек ставит без разработческих зависимостей.
 */

/** Переменная для машины, где браузер лежит не там, где принято. */
const ENV_KEYS = [brandEnvName('BROWSER'), legacyEnvName('BROWSER'), 'CHROME_PATH'] as const;

/** Windows: Edge стоит всегда, Chrome — часто; порядок от самого вероятного. */
const WINDOWS = [
  ['ProgramFiles(x86)', 'Microsoft/Edge/Application/msedge.exe'],
  ['ProgramFiles', 'Microsoft/Edge/Application/msedge.exe'],
  ['ProgramFiles', 'Google/Chrome/Application/chrome.exe'],
  ['ProgramFiles(x86)', 'Google/Chrome/Application/chrome.exe'],
  ['LOCALAPPDATA', 'Google/Chrome/Application/chrome.exe'],
  ['LOCALAPPDATA', 'Microsoft/Edge/Application/msedge.exe'],
  ['ProgramFiles', 'Chromium/Application/chrome.exe'],
] as const;

const MACOS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
] as const;

/** Linux: имена бинарей, которые ищутся по PATH — путей установки там много. */
const LINUX = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
] as const;

/**
 * Путь к браузеру или `undefined`. Ничего не кэшируется: браузер могли поставить
 * при работающей панели, и тогда кнопка PDF обязана ожить сама, а не после
 * перезапуска.
 */
export function findSystemBrowser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of ENV_KEYS) {
    const value = env[key]?.trim();
    if (value && existsSync(value)) return value;
  }

  if (process.platform === 'win32') {
    for (const [root, tail] of WINDOWS) {
      const base = env[root];
      if (!base) continue;
      const full = join(base, tail);
      if (existsSync(full)) return full;
    }
    return undefined;
  }

  if (process.platform === 'darwin') {
    return MACOS.find((path) => existsSync(path));
  }

  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const name of LINUX) {
    for (const dir of dirs) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}
