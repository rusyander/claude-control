import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { ShotCommand } from '@agentdeck/contracts/task-split';

/**
 * Готовая команда снимков проекта (3.5 плана экономии): скрипт `package.json`
 * в корне или в папке первого уровня (e2e-кит). Группа получает её строкой
 * задания и не пишет свой скрипт со входом и подбором селекторов.
 *
 * Путь — абсолютный, к основному checkout проекта: кит снимков бывает вне git
 * (у e2e-кита в .gitignore вся папка) и в копию группы не попадает, а сохранённая
 * сессия входа всегда лежит только там.
 *
 * `shots` не в списке: так называется гейт снимков справки, а не съёмка.
 */
const SCRIPT_NAMES = ['qa:shot', 'shot', 'screenshot'];

function scriptsOf(dir: string): Record<string, unknown> | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    return pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : undefined;
  } catch {
    return undefined;
  }
}

/** Менеджер пакетов папки — по lock-файлу в ней или в корне. */
function managerOf(root: string, dir: string): string {
  const has = (file: string) => existsSync(join(dir, file)) || existsSync(join(root, file));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  return 'npm';
}

function subdirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
}

export function shotCommandOf(root: string): ShotCommand | undefined {
  for (const rel of ['', ...subdirs(root)]) {
    const dir = join(root, rel);
    const scripts = scriptsOf(dir);
    const name = SCRIPT_NAMES.find((candidate) => typeof scripts?.[candidate] === 'string');
    if (!scripts || !name) continue;
    const file = /^node\s+(\S+\.[cm]?js)\b/.exec(String(scripts[name]))?.[1];
    // Прямые косые: строку запускает Bash группы, и на Windows тоже.
    const home = dir.replace(/\\/g, '/').replace(/\/$/, '');
    // Внутри двойных кавычек Bash раскрывает `$`, `` ` `` и `"`: папка с ними
    // (POSIX разрешает) рвала бы строку или выполняла бы своё (ревью B1-F17).
    const quoted = home.replace(/["$`]/g, '\\$&');
    return {
      run: `cd "${quoted}" && ${managerOf(root, dir)} run ${name} --`,
      usage: posix.join(home, file ?? 'package.json'),
    };
  }
  return undefined;
}
