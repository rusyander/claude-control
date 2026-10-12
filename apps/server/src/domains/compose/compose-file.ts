import { statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Где у проекта лежит Compose. Ищем там, где его держат на деле: в корне, в
 * `docker/`, `deploy/` и `.docker/`. Имена — только те, что docker compose
 * берёт сам без `-f`: панель запускает его из каталога файла, ровно как
 * разработчик из терминала, — и видит те же контейнеры с тем же именем проекта.
 */

export const COMPOSE_DIRS = ['', 'docker', 'deploy', '.docker'] as const;
export const COMPOSE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
] as const;
/** Override рядом с основным файлом compose применяет сам — показываем его тоже. */
const OVERRIDE_NAMES = [
  'compose.override.yaml',
  'compose.override.yml',
  'docker-compose.override.yaml',
  'docker-compose.override.yml',
] as const;

export interface ComposeLocation {
  /** Каталог файла — из него запускается docker compose. */
  dir: string;
  /** Основной файл, относительно корня проекта, через `/`. */
  file: string;
  /** Основной и override, относительно корня проекта. */
  files: string[];
  /** Полные пути — для отпечатка кэша по времени изменения. */
  absolute: string[];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const rel = (root: string, path: string): string => relative(root, path).replace(/\\/g, '/');

export function findComposeFile(projectDir: string): ComposeLocation | undefined {
  const root = resolve(projectDir);
  for (const sub of COMPOSE_DIRS) {
    const dir = sub ? join(root, sub) : root;
    const main = COMPOSE_NAMES.map((name) => join(dir, name)).find(isFile);
    if (!main) continue;
    const override = OVERRIDE_NAMES.map((name) => join(dir, name)).find(isFile);
    const absolute = override ? [main, override] : [main];
    return {
      dir,
      file: rel(root, main),
      files: absolute.map((path) => rel(root, path)),
      absolute,
    };
  }
  return undefined;
}

/**
 * Отпечаток для кэша `compose config`: файлы compose и `.env` рядом. Меняется
 * любой — разбор повторяется; не меняется — второй процесс docker на каждый
 * опрос окна не нужен.
 */
export function composeFingerprint(location: ComposeLocation): string {
  return [...location.absolute, join(location.dir, '.env')]
    .map((path) => {
      try {
        return `${path}:${statSync(path).mtimeMs}`;
      } catch {
        return `${path}:-`;
      }
    })
    .join('|');
}
