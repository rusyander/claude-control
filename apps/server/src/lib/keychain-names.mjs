import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { brandEnv } from './brand.mjs';

/**
 * Имена записи в связке ключей macOS, под которыми Claude Code держит вход, —
 * по порядку поиска. Своё имя — переменной окружения: Anthropic может
 * переименовать запись, и тогда достаточно подставить его, не трогая код.
 *
 * С `CLAUDE_CONFIG_DIR` Claude Code кладёт доступ под ДРУГОЕ имя: к нему
 * дописаны первые 8 знаков sha256 от значения переменной, приведённого к NFC
 * (сверено с бинарём 2.1.286: `Claude Code-credentials-<hash>`); переменная
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` перебивает её, а пустая — снимает суффикс.
 * Без этого панель с нестандартным каталогом не находила вход вовсе или брала
 * вход каталога по умолчанию. Каталог панели тоже даёт кандидата: песочница и
 * переключатель каталога отдают его Claude той же переменной.
 *
 * Файл без типов: его читает и `tools/doctor.mjs` голым Node.
 */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export function keychainServiceNames(
  configRoot,
  env = process.env,
  defaultRoot = join(homedir(), '.claude'),
) {
  const hashed = (dir) =>
    `${KEYCHAIN_SERVICE}-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`;
  const dirs = [];
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secure !== undefined) {
    if (secure) dirs.push(secure);
  } else {
    if (env.CLAUDE_CONFIG_DIR) dirs.push(env.CLAUDE_CONFIG_DIR);
    if (configRoot !== defaultRoot) dirs.push(configRoot);
  }
  const names = [
    brandEnv('KEYCHAIN_SERVICE'),
    ...dirs.map(hashed),
    KEYCHAIN_SERVICE,
    'Claude Code',
  ];
  return [...new Set(names.filter(Boolean))];
}
