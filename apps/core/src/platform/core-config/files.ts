import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { CoreHomeLayout } from '../core-home.ts';

/**
 * Три файла настройки ядра рядом друг с другом (00:58, G6): `config.json` — документ;
 * `config.last.json` — копия последней записи ядра (действует, пока файл правлен мимо API);
 * `config.state.json` — отпечаток последней записи, запись в полёте и ключи повтора. Пути
 * выводятся из `config.json`: читатели получают только его путь (`layout.config`).
 */

export interface ConfigFiles {
  config: string;
  last: string;
  state: string;
}

export function configFilesOf(where: Pick<CoreHomeLayout, 'config'>): ConfigFiles {
  const config = resolve(where.config);
  const dir = dirname(config);
  return { config, last: join(dir, 'config.last.json'), state: join(dir, 'config.state.json') };
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Отпечаток «настройки нет»: от него правит человек, пока ядро не записало ни одной. */
export const NO_CONFIG_DIGEST = sha256Hex('');

/** Отпечаток удалённого мимо API файла в `drift.fileDigest` — не sha256 никакого текста. */
export const ABSENT_FILE = 'absent';

/** JSON с ключами по порядку — сравнение разделов не зависит от порядка ключей в файле. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      // Ключи объекта различны — равенства не бывает.
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
