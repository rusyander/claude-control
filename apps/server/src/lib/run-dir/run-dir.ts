import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Рабочая папка задачи в каталоге проекта или копии группы (этап 9 плана
 * экономии): тетрадь, память проверок. Лежит в копии и уходит вместе с ней.
 */
export const RUN_DIR = '.agent/run';

/**
 * Завести папку и спрятать её от git ею же самой: `.gitignore` со звёздочкой
 * ловит и себя, поэтому `.git/info/exclude` проекта не трогается, а `git add -A`
 * доставки папку не захватит. Возвращает абсолютный путь папки.
 */
export function ensureRunDir(root: string): string {
  const dir = join(root, RUN_DIR);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return dir;
}
