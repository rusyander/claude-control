import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { currentOs, type OsKind } from './os-kind.ts';
import { ensureTokenFile, readToken, type TokenFileOutcome } from './token-file.ts';

/**
 * Сторона ядра у прокладки захвата (`capture-preload.cjs`, 03 §Process capture, G22): путь к
 * файлу прокладки, имена её переменных и файл доступа захвата в доме ядра (G5). Прокладка — CJS
 * без зависимостей и импортов ядра (она исполняется в чужих процессах node), поэтому имена здесь
 * повторены, а тест сверяет их с экспортом самой прокладки — расхождение краснит, а не молчит.
 */

export const CAPTURE_SHIM = fileURLToPath(new URL('./capture-preload.cjs', import.meta.url));

export const CAPTURE_WRAP_FLAG = '--agentdeck-capture-wrap';

/** Файл доступа захвата: открывает только `/v1/session/capture*`, задача — псевдозадача (04:41). */
export const CAPTURE_TOKEN_FILE = 'capture-token';

export const CAPTURE_VARS = {
  lease: 'AGENTDECK_CHECK_LEASE',
  asked: 'AGENTDECK_CAPTURE_ASKED',
  url: 'AGENTDECK_CORE_URL',
  access: 'AGENTDECK_SESSION_TOKEN',
  procs: 'AGENTDECK_CORE_PROCS',
  home: 'AGENTDECK_CAPTURE_HOME',
  envNames: 'AGENTDECK_CAPTURE_ENV',
  waitMs: 'AGENTDECK_CAPTURE_WAIT_MS',
} as const;

/** Имена, чьё значение прокладка всегда кладёт в хеш окружения (`ENV_NAMES` прокладки). */
export const CAPTURE_ENV_NAMES: readonly string[] = ['NODE_ENV', 'CI', 'TZ'];

/**
 * Главные скрипты бегунов (`RUNNERS` прокладки) и имя, которым тот же бегун зовётся в скрипте
 * пакета (`"test": "vitest run"`): по нему argv уровня node узнаётся как скрипт реестра (A2-F01).
 */
export const CAPTURE_RUNNERS: readonly { re: RegExp; bin: string }[] = [
  { re: /\/node_modules\/vitest\/vitest\.mjs$/, bin: 'vitest' },
  { re: /\/node_modules\/(jest|jest-cli)\/bin\/jest\.js$/, bin: 'jest' },
  { re: /\/node_modules\/typescript\/(bin\/tsc|lib\/tsc\.js)$/, bin: 'tsc' },
  { re: /\/node_modules\/eslint\/bin\/eslint\.js$/, bin: 'eslint' },
  { re: /\/node_modules\/prettier\/(bin\/prettier\.cjs|bin-prettier\.js)$/, bin: 'prettier' },
  { re: /\/node_modules\/(@playwright\/test|playwright)\/cli\.js$/, bin: 'playwright' },
];

export function captureTokenPath(coreHome: string): string {
  return join(coreHome, CAPTURE_TOKEN_FILE);
}

/** Создать (или прочитать уже созданный) доступ захвата: тот же `wx` и режим 0600, что у токена ядра. */
export function ensureCaptureToken(coreHome: string, os: OsKind = currentOs()): TokenFileOutcome {
  return ensureTokenFile(captureTokenPath(coreHome), os);
}

export function readCaptureToken(coreHome: string): Fact<string> {
  return readToken(captureTokenPath(coreHome));
}
