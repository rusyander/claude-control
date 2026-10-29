import { join } from 'node:path';
import { homeDir } from '../../platform/os-kind.ts';
import { isAbsolutePath } from '../../platform/paths.ts';
import type { ReadLayer } from '../adapter.types.ts';

/**
 * Каталог настроек Qwen Code и то, что модель в нём читает (F-87, 0.24.3 `Storage`): дом —
 * `QWEN_HOME` (`~` раскрывается от дома, относительный — от cwd процесса CLI), иначе `~/.qwen`.
 * Читаются каталоги навыков, агентов, команд, правил и расширений; учётные данные — OAuth
 * (`oauth_creds.json`, `mcp-oauth-tokens.json`, `google_accounts.json`), `.env` и `settings.json`
 * (ключ `security.auth.apiKey`, `env`). Имена живут здесь (P108).
 */

const HOME_VAR = 'QWEN_HOME';
const DIR = '.qwen';
const LAYER_DIRS = ['skills', 'agents', 'commands', 'rules', 'extensions'] as const;
const CREDENTIALS = [
  'oauth_creds.json',
  'mcp-oauth-tokens.json',
  'google_accounts.json',
  '.env',
  'settings.json',
] as const;

/** Дом Qwen с этим окружением; `absolute: false` — относительный, CLI достроит его от своего cwd. */
export function qwenHome(pin: Record<string, string>): { path: string; absolute: boolean } {
  const set = pin[HOME_VAR];
  if (!set) return { path: join(homeDir(pin), DIR), absolute: true };
  const tilde = set === '~' || set.startsWith('~/') || set.startsWith('~\\');
  const path = tilde ? join(homeDir(pin), set.slice(2)) : set;
  return { path, absolute: isAbsolutePath(path) };
}

/**
 * Относительный дом не достраивается здесь: каталог из него сборщик области отклонит (виден
 * человеку), учётный файл — закроет дорогу путей судьи целиком (fail-closed).
 */
export function qwenReadLayer(pin: Record<string, string>): ReadLayer {
  const home = qwenHome(pin).path;
  return {
    dirs: LAYER_DIRS.map((name) => join(home, name)),
    credentials: CREDENTIALS.map((name) => join(home, name)),
    // OAuth-токены CLI обновляет сам по ходу сессии — это не эффект шага.
    volatile: ['oauth_creds.json', 'mcp-oauth-tokens.json'].map((name) => join(home, name)),
  };
}
